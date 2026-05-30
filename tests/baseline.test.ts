import { describe, expect, it } from "vitest";
import { diffAgainstBaseline, toBaseline, type Baseline } from "../src/baseline.js";
import type { ScenarioResult, TrialResult } from "../src/types.js";

const result = (
  name: string,
  passRate: number,
  stable: boolean,
  medianCostUsd: number,
): ScenarioResult => ({
  name,
  trials: [] as TrialResult[],
  passRate,
  stable,
  medianCostUsd,
  gatePassed: true,
  gateReason: "ok",
});

const baseline = (scenarios: Baseline["scenarios"]): Baseline => ({ version: 1, scenarios });

describe("toBaseline", () => {
  it("snapshots the comparable fields", () => {
    const b = toBaseline([result("a", 1, true, 0.2)], { configRef: "abc123" });
    expect(b.version).toBe(1);
    expect(b.configRef).toBe("abc123");
    expect(b.scenarios[0]).toEqual({ name: "a", passRate: 1, stable: true, medianCostUsd: 0.2 });
  });
});

describe("diffAgainstBaseline", () => {
  it("finds no regression when results match", () => {
    const base = baseline([{ name: "a", passRate: 1, stable: true, medianCostUsd: 0.2 }]);
    expect(diffAgainstBaseline([result("a", 1, true, 0.2)], base)).toEqual([]);
  });

  it("flags a pass-rate drop beyond the threshold", () => {
    const base = baseline([{ name: "a", passRate: 1, stable: true, medianCostUsd: 0.2 }]);
    const regs = diffAgainstBaseline([result("a", 0.5, false, 0.2)], base);
    expect(regs.map((r) => r.kind)).toContain("pass-rate-drop");
  });

  it("flags a stable scenario becoming flaky", () => {
    const base = baseline([{ name: "a", passRate: 1, stable: true, medianCostUsd: 0.2 }]);
    const regs = diffAgainstBaseline([result("a", 0.95, false, 0.2)], base);
    expect(regs.map((r) => r.kind)).toContain("became-flaky");
  });

  it("flags a cost increase above the floor", () => {
    const base = baseline([{ name: "a", passRate: 1, stable: true, medianCostUsd: 0.2 }]);
    const regs = diffAgainstBaseline([result("a", 1, true, 0.5)], base);
    expect(regs.map((r) => r.kind)).toContain("cost-increase");
  });

  it("ignores tiny cost noise below the floor", () => {
    const base = baseline([{ name: "a", passRate: 1, stable: true, medianCostUsd: 0.001 }]);
    expect(diffAgainstBaseline([result("a", 1, true, 0.009)], base)).toEqual([]);
  });

  it("flags a baseline scenario missing from the run", () => {
    const base = baseline([{ name: "gone", passRate: 1, stable: true, medianCostUsd: 0.1 }]);
    const regs = diffAgainstBaseline([], base);
    expect(regs[0]?.kind).toBe("missing");
  });
});
