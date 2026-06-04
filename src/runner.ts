/**
 * Headless runner. Executes one trial of a scenario by:
 *   1. materializing an isolated working copy of the fixture,
 *   2. pointing Claude Code at the config-under-test (CLAUDE_CONFIG_DIR) plus a
 *      capture-settings file that records tool/subagent invocations,
 *   3. invoking `claude -p --output-format json` non-interactively,
 *   4. parsing the result envelope and the capture log.
 *
 * No part of this mutates the user's real ~/.claude or the source fixture.
 */

import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureLogPath,
  readInvocations,
  writeCaptureSettings,
} from "./hooks.js";
import type { HeadlessResult, TrialRun } from "./types.js";

export interface RunOptions {
  /** Path to the .claude config dir under test. */
  readonly configDir: string;
  /** Absolute path to the fixture dir to copy into an isolated workdir. */
  readonly fixtureDir?: string;
  readonly prompt: string;
  readonly maxTurns: number;
  /** Path to the `claude` binary; overridable for tests. */
  readonly claudeBin?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runTrial(opts: RunOptions): Promise<TrialRun> {
  const workdir = await mkdtemp(path.join(tmpdir(), "crucible-"));
  try {
    if (opts.fixtureDir) {
      await cp(opts.fixtureDir, workdir, { recursive: true });
    }
    const settingsPath = path.join(workdir, ".crucible-settings.json");
    const logPath = captureLogPath(workdir);
    await writeCaptureSettings(settingsPath, logPath);

    const headless = await invokeClaude(opts, workdir, settingsPath, logPath);
    const invocations = await readInvocations(logPath);
    return { headless, invocations, workdir };
  } catch (err) {
    await rm(workdir, { recursive: true, force: true });
    throw err;
  }
}

function invokeClaude(
  opts: RunOptions,
  workdir: string,
  settingsPath: string,
  logPath: string,
): Promise<HeadlessResult> {
  const bin = opts.claudeBin ?? "claude";
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(opts.maxTurns),
    "--settings",
    settingsPath,
    "--permission-mode",
    "acceptEdits",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workdir,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: opts.configDir,
        CRUCIBLE_LOG: logPath,
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude run exceeded ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn '${bin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(parseHeadless(stdout));
      } catch (err) {
        reject(
          new Error(
            `could not parse claude output (exit ${code}): ${(err as Error).message}\n${stderr.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

/** Parse the `--output-format json` envelope, tolerant of field naming. */
export function parseHeadless(stdout: string): HeadlessResult {
  const obj = JSON.parse(stdout) as Record<string, unknown>;
  return {
    result: String(obj.result ?? ""),
    isError: Boolean(obj.is_error ?? false),
    numTurns: Number(obj.num_turns ?? 0),
    durationMs: Number(obj.duration_ms ?? 0),
    totalCostUsd: Number(obj.total_cost_usd ?? 0),
    sessionId: String(obj.session_id ?? ""),
  };
}

/**
 * Detect the most common first-run footgun: `claude` ran but was not
 * authenticated, so every trial "fails" with an opaque message. This usually
 * means CLAUDE_CONFIG_DIR (the config dir under test) has no credentials -- the
 * isolated config Crucible points `claude` at is also where `claude` reads its
 * login. Returns an actionable hint, or null if this is a normal run.
 */
export function authFailureHint(headless: HeadlessResult): string | null {
  if (!headless.isError) return null;
  if (!/not logged in|please run \/login|invalid api key|authentication/i.test(headless.result)) {
    return null;
  }
  return (
    `claude is not authenticated for this config (${headless.result.trim()}). ` +
    `Crucible points claude at the --config dir via CLAUDE_CONFIG_DIR, which is also ` +
    `where claude reads its login. Fix: copy your ~/.claude/.credentials.json into the ` +
    `config dir, run \`claude /login\` against it, or set ANTHROPIC_API_KEY.`
  );
}

export interface HeadlessTextOptions {
  readonly prompt: string;
  readonly claudeBin?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /** Pin the meta-agent (judge / ideator) to a frozen reference config. */
  readonly configDir?: string;
}

/**
 * Run a one-shot, tool-free headless query and return the model's text. Used by
 * the LLM judge: a self-contained prompt in, a verdict out. Runs in a temp cwd
 * so it cannot read the trial workdir except via what we put in the prompt.
 */
export async function runHeadlessText(opts: HeadlessTextOptions): Promise<string> {
  return (await runHeadlessJson(opts)).text;
}

/**
 * Like runHeadlessText but also returns the run's real cost, so callers (the
 * judge) can fold a meta-agent call into the trial's cost accounting.
 */
export async function runHeadlessJson(
  opts: HeadlessTextOptions,
): Promise<{ text: string; costUsd: number }> {
  const workdir = await mkdtemp(path.join(tmpdir(), "crucible-judge-"));
  const bin = opts.claudeBin ?? "claude";
  const args = ["-p", opts.prompt, "--output-format", "json", "--max-turns", String(opts.maxTurns ?? 1)];
  if (opts.model) args.push("--model", opts.model);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: workdir,
        env: { ...process.env, ...(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {}) },
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`judge run exceeded ${opts.timeoutMs ?? 120_000}ms`));
      }, opts.timeoutMs ?? 120_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn '${bin}': ${e.message}`));
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const headless = parseHeadless(stdout);
    return { text: headless.result, costUsd: headless.totalCostUsd };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
