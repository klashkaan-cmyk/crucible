/**
 * Deterministic assertion engine. Each assertion inspects the trial's working
 * copy and/or its captured invocations and returns a pass/fail. These checks
 * are cheap and reliable; they are the hard gates. (LLM-judge assertions are a
 * separate, softer signal planned for v0.2.)
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AssertionSpecT } from "./scenario.js";
import type { AssertionResult, TrialRun } from "./types.js";

const exec = promisify(execFile);

export async function evaluateAssertions(
  specs: ReadonlyArray<AssertionSpecT>,
  run: TrialRun,
): Promise<AssertionResult[]> {
  return Promise.all(specs.map((s) => evaluateOne(s, run)));
}

async function evaluateOne(
  spec: AssertionSpecT,
  run: TrialRun,
): Promise<AssertionResult> {
  if (spec.file_exists !== undefined) return checkFileExists(spec.file_exists, run.workdir);
  if (spec.file_matches !== undefined) return checkFileMatches(spec.file_matches, run.workdir);
  if (spec.subagent_invoked !== undefined) return checkInvoked("subagent", spec.subagent_invoked, run);
  if (spec.tool_invoked !== undefined) return checkInvoked("tool", spec.tool_invoked, run);
  if (spec.command_not_run !== undefined) return checkCommandNotRun(spec.command_not_run, run);
  if (spec.command_succeeds !== undefined) return checkCommandSucceeds(spec.command_succeeds, run.workdir);
  if (spec.cost_under !== undefined) return checkCostUnder(spec.cost_under, run);
  return { kind: "unknown", status: "error", message: "no recognized assertion key" };
}

async function checkFileExists(rel: string, workdir: string): Promise<AssertionResult> {
  const kind = `file_exists:${rel}`;
  try {
    await access(path.join(workdir, rel));
    return { kind, status: "pass", message: `${rel} exists` };
  } catch {
    return { kind, status: "fail", message: `${rel} was not created` };
  }
}

async function checkFileMatches(spec: string, workdir: string): Promise<AssertionResult> {
  const kind = `file_matches:${spec}`;
  const idx = spec.indexOf("::");
  if (idx === -1) {
    return { kind, status: "error", message: "expected 'path::regex'" };
  }
  const rel = spec.slice(0, idx);
  const pattern = spec.slice(idx + 2);
  try {
    const content = await readFile(path.join(workdir, rel), "utf8");
    const ok = new RegExp(pattern).test(content);
    return ok
      ? { kind, status: "pass", message: `${rel} matches /${pattern}/` }
      : { kind, status: "fail", message: `${rel} does not match /${pattern}/` };
  } catch {
    return { kind, status: "fail", message: `${rel} unreadable` };
  }
}

function checkInvoked(
  type: "tool" | "subagent",
  name: string,
  run: TrialRun,
): AssertionResult {
  const kind = `${type}_invoked:${name}`;
  const hit = run.invocations.some((i) => i.type === type && i.name === name);
  return hit
    ? { kind, status: "pass", message: `${type} '${name}' fired` }
    : { kind, status: "fail", message: `${type} '${name}' never fired` };
}

/** Heuristic: scan captured tool invocations for a forbidden command pattern. */
function checkCommandNotRun(pattern: string, run: TrialRun): AssertionResult {
  const kind = `command_not_run:${pattern}`;
  const re = globToRegExp(pattern);
  const hit = run.invocations.some((i) => i.type === "tool" && re.test(i.name));
  return hit
    ? { kind, status: "fail", message: `forbidden command matching '${pattern}' was used` }
    : { kind, status: "pass", message: `no command matched '${pattern}'` };
}

async function checkCommandSucceeds(cmd: string, workdir: string): Promise<AssertionResult> {
  const kind = `command_succeeds:${cmd}`;
  try {
    await exec("sh", ["-c", cmd], { cwd: workdir, timeout: 120_000 });
    return { kind, status: "pass", message: `'${cmd}' exited 0` };
  } catch (err) {
    return { kind, status: "fail", message: `'${cmd}' failed: ${(err as Error).message.slice(0, 120)}` };
  }
}

function checkCostUnder(ceiling: number, run: TrialRun): AssertionResult {
  const kind = `cost_under:${ceiling}`;
  const cost = run.headless.totalCostUsd;
  return cost <= ceiling
    ? { kind, status: "pass", message: `cost $${cost.toFixed(4)} <= $${ceiling}` }
    : { kind, status: "fail", message: `cost $${cost.toFixed(4)} > $${ceiling}` };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}
