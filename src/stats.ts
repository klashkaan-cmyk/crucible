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

/**
 * One-sided two-proportion z-test: is candidate B's success rate significantly
 * HIGHER than baseline A's, at the given confidence `level` (default 0.95)?
 *
 * This is the statistical core of the optimize accept-gate. A fixed pass-rate
 * threshold at small k cannot tell a real improvement from binomial noise --
 * 4/5 vs 3/5 looks like a win but is well inside the variance. Pool the per-
 * scenario trial outcomes into (successes, trials) for each side and require the
 * gain to be significant before accepting a candidate.
 *
 * Returns false when there is no data, when B is not strictly above A, or when
 * the gain is indistinguishable from noise.
 */
export function significant(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number,
  level = 0.95,
): boolean {
  if (trialsA <= 0 || trialsB <= 0) return false;
  const pA = successesA / trialsA;
  const pB = successesB / trialsB;
  if (pB <= pA) return false; // one-sided: B must be higher to be a real gain
  const pooled = (successesA + successesB) / (trialsA + trialsB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return false; // no variance (both all-pass or all-fail) -> no signal
  const z = (pB - pA) / se;
  const pValue = 1 - normalCdf(z);
  return pValue < 1 - level;
}

/** Standard normal CDF via erf. */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** erf approximation (Abramowitz & Stegun 7.1.26), |error| <= 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
