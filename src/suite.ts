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
import type { ScenarioResult, TrialResult } from "./types.js";

export interface SuiteOptions {
  readonly configDir: string;
  readonly judgeModel?: string;
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

  const trials: TrialResult[] = [];
  for (let i = 0; i < scenario.trials; i++) {
    trials.push(await runOneTrial(i, scenario, fixtureDir, opts));
  }
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
