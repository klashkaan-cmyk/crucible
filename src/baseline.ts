/**
 * Baselines + regression diffing -- the core of "regression CI". A baseline is
 * a snapshot of how each scenario behaved (pass rate, stability, median cost)
 * for a known-good config. A later run is compared against it so a change that
 * makes the agent quietly *worse* -- without any single scenario newly failing
 * its own gate -- is still caught.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ScenarioResult } from "./types.js";

export interface BaselineEntry {
  readonly name: string;
  readonly passRate: number;
  readonly stable: boolean;
  readonly medianCostUsd: number;
}

export interface Baseline {
  readonly version: 1;
  readonly createdAt?: string;
  /** Optional fingerprint of the config the baseline was captured against. */
  readonly configRef?: string;
  readonly scenarios: ReadonlyArray<BaselineEntry>;
}

export interface RegressionOptions {
  /** A drop in pass rate larger than this (absolute, 0..1) is a regression. */
  readonly passRateDrop: number;
  /** A median-cost increase larger than this fraction is a regression. */
  readonly costIncrease: number;
}

export const DEFAULT_REGRESSION_OPTIONS: RegressionOptions = {
  passRateDrop: 0.1,
  costIncrease: 0.5,
};

export type RegressionKind =
  | "pass-rate-drop"
  | "became-flaky"
  | "cost-increase"
  | "missing";

export interface Regression {
  readonly name: string;
  readonly kind: RegressionKind;
  readonly detail: string;
}

export function toBaseline(
  results: ReadonlyArray<ScenarioResult>,
  meta: { createdAt?: string; configRef?: string } = {},
): Baseline {
  return {
    version: 1,
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    ...(meta.configRef ? { configRef: meta.configRef } : {}),
    scenarios: results.map((r) => ({
      name: r.name,
      passRate: r.passRate,
      stable: r.stable,
      medianCostUsd: r.medianCostUsd,
    })),
  };
}

export async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  await writeFile(path, JSON.stringify(baseline, null, 2) + "\n");
}

export async function loadBaseline(path: string): Promise<Baseline> {
  const raw = await readFile(path, "utf8");
  const obj = JSON.parse(raw) as Baseline;
  if (obj.version !== 1 || !Array.isArray(obj.scenarios)) {
    throw new Error(`Invalid baseline file: ${path}`);
  }
  return obj;
}

/** Compare current results to a baseline and return only genuine regressions. */
export function diffAgainstBaseline(
  results: ReadonlyArray<ScenarioResult>,
  baseline: Baseline,
  opts: RegressionOptions = DEFAULT_REGRESSION_OPTIONS,
): Regression[] {
  const byName = new Map(results.map((r) => [r.name, r]));
  const regressions: Regression[] = [];

  for (const base of baseline.scenarios) {
    const cur = byName.get(base.name);
    if (!cur) {
      regressions.push({
        name: base.name,
        kind: "missing",
        detail: "scenario in baseline is absent from this run (removed or renamed)",
      });
      continue;
    }
    if (base.passRate - cur.passRate > opts.passRateDrop) {
      regressions.push({
        name: base.name,
        kind: "pass-rate-drop",
        detail: `pass rate ${pct(base.passRate)} -> ${pct(cur.passRate)}`,
      });
    }
    if (base.stable && !cur.stable) {
      regressions.push({
        name: base.name,
        kind: "became-flaky",
        detail: `was stable, now ${pct(cur.passRate)} pass rate`,
      });
    }
    if (costRegressed(base.medianCostUsd, cur.medianCostUsd, opts.costIncrease)) {
      regressions.push({
        name: base.name,
        kind: "cost-increase",
        detail: `median cost $${base.medianCostUsd.toFixed(4)} -> $${cur.medianCostUsd.toFixed(4)}`,
      });
    }
  }
  return regressions;
}

/** Ignore cost noise below a small floor; otherwise flag a relative jump. */
function costRegressed(baseCost: number, curCost: number, threshold: number): boolean {
  const FLOOR = 0.01;
  if (curCost <= FLOOR || baseCost <= 0) return false;
  return (curCost - baseCost) / baseCost > threshold;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
