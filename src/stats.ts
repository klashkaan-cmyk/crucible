/**
 * Trial aggregation. Claude Code has no seed/temperature knob in headless mode,
 * so a single run is a noisy sample. Crucible runs each scenario k times and
 * reports both pass@k (any trial passed) and pass^k (every trial passed). The
 * gate uses pass-rate so flaky-but-mostly-good configs can still ship under an
 * explicit threshold.
 */

import type { Scenario } from "./scenario.js";
import type { ScenarioResult, TrialResult } from "./types.js";

export function aggregate(
  scenario: Scenario,
  trials: ReadonlyArray<TrialResult>,
): ScenarioResult {
  const passed = trials.filter((t) => t.passed).length;
  const passRate = trials.length === 0 ? 0 : passed / trials.length;
  const stable = trials.length > 0 && passed === trials.length;
  const medianCostUsd = median(trials.map((t) => t.costUsd));

  const { gatePassed, gateReason } = evaluateGate(scenario, passRate, medianCostUsd);

  return {
    name: scenario.name,
    trials,
    passRate,
    stable,
    medianCostUsd,
    gatePassed,
    gateReason,
  };
}

function evaluateGate(
  scenario: Scenario,
  passRate: number,
  medianCostUsd: number,
): { gatePassed: boolean; gateReason: string } {
  const { min_pass_rate, max_cost_usd } = scenario.gate;
  if (passRate < min_pass_rate) {
    return {
      gatePassed: false,
      gateReason: `pass rate ${(passRate * 100).toFixed(0)}% < required ${(min_pass_rate * 100).toFixed(0)}%`,
    };
  }
  if (max_cost_usd !== undefined && medianCostUsd > max_cost_usd) {
    return {
      gatePassed: false,
      gateReason: `median cost $${medianCostUsd.toFixed(4)} > budget $${max_cost_usd}`,
    };
  }
  return { gatePassed: true, gateReason: "gate satisfied" };
}

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}
