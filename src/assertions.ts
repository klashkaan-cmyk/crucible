/**
 * Deterministic assertion engine. Each assertion inspects the trial's working
 * copy and/or its captured invocations and returns a pass/fail. These checks
 * are cheap and reliable; they are the hard gates. (LLM-judge assertions are a
 * separate, softer signal planned for v0.2.)
 */

import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runJudge } from "./judge.js";
import { findSecret } from "./secrets.js";
import type { AssertionSpecT } from "./scenario.js";
import type { AssertionResult, TrialRun } from "./types.js";

const exec = promisify(execFile);

export interface AssertionOptions {
  readonly claudeBin?: string;
  readonly judgeModel?: string;
}

export async function evaluateAssertions(
  specs: ReadonlyArray<AssertionSpecT>,
  run: TrialRun,
  opts: AssertionOptions = {},
): Promise<AssertionResult[]> {
  return Promise.all(specs.map((s) => evaluateOne(s, run, opts)));
}

async function evaluateOne(
  spec: AssertionSpecT,
  run: TrialRun,
  opts: AssertionOptions,
): Promise<AssertionResult> {
  if (spec.file_exists !== undefined) return checkFileExists(spec.file_exists, run.workdir);
  if (spec.file_matches !== undefined) return checkFileMatches(spec.file_matches, run.workdir);
  if (spec.response_contains !== undefined) return checkResponseContains(spec.response_contains, run);
  if (spec.response_matches !== undefined) return checkResponseMatches(spec.response_matches, run);
  if (spec.latency_under !== undefined) return checkLatencyUnder(spec.latency_under, run);
  if (spec.turns_under !== undefined) return checkTurnsUnder(spec.turns_under, run);
  if (spec.subagent_invoked !== undefined) return checkInvoked("subagent", spec.subagent_invoked, run);
  if (spec.tool_invoked !== undefined) return checkInvoked("tool", spec.tool_invoked, run);
  if (spec.command_not_run !== undefined) return checkCommandNotRun(spec.command_not_run, run);
  if (spec.command_succeeds !== undefined) return checkCommandSucceeds(spec.command_succeeds, run.workdir);
  if (spec.cost_under !== undefined) return checkCostUnder(spec.cost_under, run);
  if (spec.judge !== undefined) return checkJudge(spec.judge, spec.min_score, run, opts);
  if (spec.file_absent !== undefined) return checkFileAbsent(spec.file_absent, run.workdir);
  if (spec.no_secrets) return checkNoSecrets(run.workdir);
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

function checkResponseContains(needle: string, run: TrialRun): AssertionResult {
  const kind = `response_contains:${needle.slice(0, 40)}`;
  return run.headless.result.includes(needle)
    ? { kind, status: "pass", message: `response contains '${needle}'` }
    : { kind, status: "fail", message: `response does not contain '${needle}'` };
}

function checkResponseMatches(pattern: string, run: TrialRun): AssertionResult {
  const kind = `response_matches:${pattern.slice(0, 40)}`;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { kind, status: "error", message: `invalid regex: ${(err as Error).message.slice(0, 80)}` };
  }
  return re.test(run.headless.result)
    ? { kind, status: "pass", message: `response matches /${pattern}/` }
    : { kind, status: "fail", message: `response does not match /${pattern}/` };
}

function checkLatencyUnder(ceilingMs: number, run: TrialRun): AssertionResult {
  const kind = `latency_under:${ceilingMs}`;
  const ms = run.headless.durationMs;
  return ms <= ceilingMs
    ? { kind, status: "pass", message: `${ms}ms <= ${ceilingMs}ms` }
    : { kind, status: "fail", message: `${ms}ms > ${ceilingMs}ms` };
}

function checkTurnsUnder(ceiling: number, run: TrialRun): AssertionResult {
  const kind = `turns_under:${ceiling}`;
  const turns = run.headless.numTurns;
  return turns <= ceiling
    ? { kind, status: "pass", message: `${turns} turns <= ${ceiling}` }
    : { kind, status: "fail", message: `${turns} turns > ${ceiling}` };
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
  const hit = run.invocations.some(
    (i) => i.type === "tool" && (re.test(i.name) || (i.summary !== undefined && re.test(i.summary))),
  );
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

/**
 * LLM-judge. Soft signal by default: with no `min_score`, the verdict is
 * reported but always passes, so it can never fail a gate on its own. With
 * `min_score` set, the author has explicitly opted into gating on the score.
 */
async function checkJudge(
  rubric: string,
  minScore: number | undefined,
  run: TrialRun,
  opts: AssertionOptions,
): Promise<AssertionResult> {
  const kind = `judge:${rubric.slice(0, 40)}`;
  let score = 0;
  let reason = "";
  try {
    const verdict = await runJudge(rubric, run, { claudeBin: opts.claudeBin, model: opts.judgeModel });
    score = verdict.score;
    reason = verdict.reason;
  } catch (err) {
    reason = (err as Error).message.slice(0, 120);
  }

  if (minScore === undefined) {
    const note = score ? `score ${score}/5${reason ? ` - ${reason}` : ""}` : `unscored (${reason})`;
    return { kind, status: "pass", message: `(soft) ${note}` };
  }
  if (!score) {
    return { kind, status: "fail", message: `judge could not score (${reason}); required >= ${minScore}` };
  }
  return score >= minScore
    ? { kind, status: "pass", message: `score ${score}/5 >= ${minScore}${reason ? ` - ${reason}` : ""}` }
    : { kind, status: "fail", message: `score ${score}/5 < ${minScore}${reason ? ` - ${reason}` : ""}` };
}

async function checkFileAbsent(rel: string, workdir: string): Promise<AssertionResult> {
  const kind = `file_absent:${rel}`;
  try {
    await access(path.join(workdir, rel));
    return { kind, status: "fail", message: `${rel} should not exist but does` };
  } catch {
    return { kind, status: "pass", message: `${rel} is absent` };
  }
}

const SECRET_SKIP_DIRS = new Set(["node_modules", ".git", ".crucible"]);
const SECRET_MAX_FILE = 200_000;

async function checkNoSecrets(workdir: string): Promise<AssertionResult> {
  const kind = "no_secrets";
  const hit = await scanForSecret(workdir, workdir);
  return hit
    ? { kind, status: "fail", message: `possible ${hit.name} in ${hit.rel}` }
    : { kind, status: "pass", message: "no hardcoded secrets detected" };
}

async function scanForSecret(
  dir: string,
  root: string,
): Promise<{ name: string; rel: string } | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SECRET_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".crucible")) continue;
      const found = await scanForSecret(path.join(dir, entry.name), root);
      if (found) return found;
      continue;
    }
    const full = path.join(dir, entry.name);
    try {
      const info = await stat(full);
      if (info.size > SECRET_MAX_FILE) continue;
      const buf = await readFile(full);
      if (buf.includes(0)) continue;
      const content = buf.toString("utf8");
      const found = findSecret(content);
      if (found) return { name: found.name, rel: path.relative(root, full) };
    } catch {
      // unreadable -> skip
    }
  }
  return null;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}
