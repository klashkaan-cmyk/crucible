/**
 * Suite orchestration. Discovers scenario files, runs each scenario's trials,
 * evaluates assertions, and aggregates results. Trials within a scenario run
 * sequentially by default to keep token spend predictable; concurrency is a
 * deliberate opt-in (`--concurrency`) because parallel headless agents multiply
 * cost fast.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { evaluateAssertions } from "./assertions.js";
import { loadScenario, type Scenario } from "./scenario.js";
import { runTrial } from "./runner.js";
import { aggregate } from "./stats.js";
import type { ScenarioResult, TrialResult } from "./types.js";

export interface SuiteOptions {
  readonly configDir: string;
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
    const assertions = await evaluateAssertions(scenario.assert, run);
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
