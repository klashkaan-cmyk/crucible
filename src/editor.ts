/**
 * The real optimize editor: the agent that mutates the config under test.
 *
 * `makeEditor` returns an EditorFn that spawns `claude -p` inside the candidate
 * worktree with file-editing tools ONLY (no Bash, no network) -- the structural
 * scope guard in optimize.ts is defense-in-depth, this is the first line. It runs
 * on a frozen REFERENCE config (CLAUDE_CONFIG_DIR), never the candidate, so a
 * broken candidate cannot impair the editor and the meta-agent stays pinned.
 *
 * Prompt construction, arg construction, the failures digest, and the suite
 * bootstrap are pure / I/O-thin so they unit-test without a live `claude`.
 *
 * See docs/optimize-spec.md.
 */

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHeadless } from "./runner.js";
import { summarizeConfig, renderScenarios } from "./generate.js";
import { discoverScenarios } from "./suite.js";
import type { EditorFn } from "./optimize.js";
import type { Program } from "./program.js";
import type { ScenarioResult } from "./types.js";

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** A digest of where the current best is weak, fed to the editor as guidance. */
export function failuresDigest(lastSuite: ReadonlyArray<ScenarioResult>): string {
  const failing = lastSuite.filter((r) => r.passRate < 1);
  if (failing.length === 0) {
    return "All current scenarios pass. Look for cost/turn reductions or robustness gaps that would still hold under harder inputs.";
  }
  const lines: string[] = [];
  for (const r of failing) {
    lines.push(`- ${r.name}: pass rate ${(r.passRate * 100).toFixed(0)}%${r.gateReason ? ` (${r.gateReason})` : ""}`);
    const failTrial = r.trials.find((t) => !t.passed);
    const fails = (failTrial?.assertions ?? []).filter((a) => a.status !== "pass");
    for (const a of fails.slice(0, 4)) lines.push(`    - ${a.kind}: ${a.message}`);
  }
  return lines.join("\n");
}

/** Build the editor prompt. Pure; no I/O. */
export function buildEditorPrompt(program: Program, digest: string): string {
  const m = program.mutableSurface;
  const lines: string[] = [
    "You are improving a Claude Code configuration so it performs better on a behavioral eval.",
    "",
    "OBJECTIVE:",
    program.objective.trim(),
  ];
  if (program.constraints.trim()) {
    lines.push("", "CONSTRAINTS:", program.constraints.trim());
  }
  lines.push("", "You MAY EDIT ONLY files matching these globs (relative to the repo root):");
  for (const g of m.allow) lines.push(`  - ${g}`);
  if (m.deny.length > 0) {
    lines.push("You must NEVER edit these:");
    for (const g of m.deny) lines.push(`  - ${g}`);
  }
  lines.push(
    "",
    "CURRENT WEAK SPOTS (from the latest scored run):",
    digest,
    "",
    "Make ONE focused, well-reasoned change that should raise the objective without",
    "regressing other scenarios or weakening any safety/refusal behavior. Do NOT edit",
    "test scenarios, fixtures, hooks, or settings. When done, end your final message",
    "with a one-line explanation of the change and why you expect it to help.",
  );
  return lines.join("\n");
}

/**
 * Args for the editor `claude` invocation. Tool-restricted to Edit/Write/Read --
 * no Bash, no network -- so the editor can change files but cannot act.
 */
export function editorClaudeArgs(prompt: string, maxTurns: number): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Edit,Write,Read",
    "--disallowedTools",
    "Bash",
  ];
}

export interface EditorOptions {
  readonly claudeBin?: string;
  readonly model?: string;
  /** Frozen config the editor runs ON (its brain), never the candidate. */
  readonly referenceConfigDir: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}

/** Build the live EditorFn that drives `claude` to mutate the worktree. */
export function makeEditor(opts: EditorOptions): EditorFn {
  return async (wt, ctx) => {
    const prompt = buildEditorPrompt(ctx.program, failuresDigest(ctx.lastSuite));
    const args = editorClaudeArgs(prompt, opts.maxTurns ?? DEFAULT_MAX_TURNS);
    if (opts.model) args.push("--model", opts.model);
    const stdout = await spawnText(opts.claudeBin ?? "claude", args, {
      cwd: wt.root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: opts.referenceConfigDir },
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const headless = parseHeadless(stdout);
    return { message: headless.result.trim(), costUsd: headless.totalCostUsd };
  };
}

/**
 * Cold-start: if the suite dir has no scenarios, scaffold them from the config
 * (the `crucible generate` path) so optimize has something to score against.
 * Returns the number of scenario files written.
 */
export async function bootstrapSuite(configDir: string, suiteDir: string): Promise<number> {
  if ((await discoverScenarios(suiteDir)).length > 0) return 0;
  const scenarios = renderScenarios(await summarizeConfig(configDir));
  await mkdir(suiteDir, { recursive: true });
  let written = 0;
  for (const s of scenarios) {
    const file = path.join(suiteDir, s.filename);
    if (await fileExists(file)) continue;
    await writeFile(file, s.yaml);
    written += 1;
  }
  return written;
}

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

interface SpawnTextOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

function spawnText(bin: string, args: ReadonlyArray<string>, o: SpawnTextOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { cwd: o.cwd, env: o.env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`editor run exceeded ${o.timeoutMs}ms`));
    }, o.timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn '${bin}': ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
