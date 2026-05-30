/**
 * Suite orchestration. Discovers scenario files, runs each scenario's trials,
 * evaluates assertions, and aggregates results. Trials within a scenario run
 * sequentially by default to keep token spend predictable; concurrency is a
 * deliberate opt-in (`--concurrency`) because parallel headless agents multiply
 * cost fast.
 */

import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
import { evaluateAssertions } from "./assertions.js";
import { loadScenario, type Scenario } from "./scenario.js";
import { runTrial } from "./runner.js";
import { aggregate } from "./stats.js";
import { fromRun, saveTranscript } from "./transcript.js";
import type { ScenarioResult, TrialResult } from "./types.js";

export interface SuiteOptions {
  readonly configDir: string;
  readonly judgeModel?: string;
  readonly saveTranscriptsDir?: string;
  readonly concurrency?: number;
  readonly scenarioDir: string;
  readonly claudeBin?: string;
  readonly keepWorkdirs?: boolean;
}

export async function runScenarioFile(
  file: string,
  opts: SuiteOptions,
): Promise<ScenarioResult> {
  const scenario = await loadScenario(file);
  const fixtureDir = scenario.fixture
    ? path.resolve(path.dirname(file), scenario.fixture)
    : undefined;

  const indices = Array.from({ length: scenario.trials }, (_, i) => i);
  const limit = Math.max(1, opts.concurrency ?? 1);
  const trials = await pool(indices, limit, (i) => runOneTrial(i, scenario, fixtureDir, opts));
  trials.sort((a, b) => a.index - b.index);
  return aggregate(scenario, trials);
}

async function runOneTrial(
  index: number,
  scenario: Scenario,
  fixtureDir: string | undefined,
  opts: SuiteOptions,
): Promise<TrialResult> {
  try {
    const run = await runTrial({
      configDir: opts.configDir,
      fixtureDir,
      prompt: scenario.prompt,
      maxTurns: scenario.max_turns,
      claudeBin: opts.claudeBin,
    });
    const assertions = await evaluateAssertions(scenario.assert, run, {
      claudeBin: opts.claudeBin,
      judgeModel: opts.judgeModel,
    });
    const passed = assertions.every((a) => a.status === "pass") && !run.headless.isError;
    if (opts.saveTranscriptsDir) {
      await saveTranscript(opts.saveTranscriptsDir, fromRun(scenario.name, index, run));
    }
    if (!opts.keepWorkdirs) await rm(run.workdir, { recursive: true, force: true });
    return {
      index,
      assertions,
      passed,
      costUsd: run.headless.totalCostUsd,
      durationMs: run.headless.durationMs,
    };
  } catch (err) {
    return {
      index,
      assertions: [],
      passed: false,
      costUsd: 0,
      durationMs: 0,
      runError: (err as Error).message,
    };
  }
}

/** Discover *.scenario.yaml files in a directory (sorted, stable order). */
export async function discoverScenarios(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".scenario.yaml") || e.endsWith(".scenario.yml"))
    .map((e) => path.join(dir, e))
    .sort();
}

/** Run every scenario in a directory, returning aggregated results. */
export async function runSuite(
  files: ReadonlyArray<string>,
  opts: SuiteOptions,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const file of files) {
    results.push(await runScenarioFile(file, opts));
  }
  return results;
}

/** Best-effort short git SHA of the repo containing the config dir. */
export async function configFingerprint(configDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", configDir, "rev-parse", "--short", "HEAD"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Run `fn` over items with at most `size` in flight; preserves no order. */
async function pool<T, R>(items: ReadonlyArray<T>, size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results.push(await fn(items[idx]!));
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return results;
}
