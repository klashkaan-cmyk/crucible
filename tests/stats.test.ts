import { describe, expect, it } from "vitest";
import { aggregate, median } from "../src/stats.js";
import type { Scenario } from "../src/scenario.js";
import type { TrialResult } from "../src/types.js";

const scenario = (gate: Scenario["gate"]): Scenario => ({
  name: "t",
  prompt: "p",
  trials: 3,
  max_turns: 30,
  assert: [{ file_exists: "x" }],
  gate,
});

const trial = (passed: boolean, costUsd = 0.1): TrialResult => ({
  index: 0,
  assertions: [],
  passed,
  costUsd,
  durationMs: 1000,
});

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("aggregate", () => {
  it("computes pass rate and stability", () => {
    const r = aggregate(scenario({ min_pass_rate: 0.5 }), [trial(true), trial(false), trial(true)]);
    expect(r.passRate).toBeCloseTo(2 / 3);
    expect(r.stable).toBe(false);
    expect(r.gatePassed).toBe(true);
  });

  it("fails the gate below min pass rate", () => {
    const r = aggregate(scenario({ min_pass_rate: 1 }), [trial(true), trial(false)]);
    expect(r.gatePassed).toBe(false);
    expect(r.gateReason).toMatch(/pass rate/);
  });

  it("fails the gate over cost budget", () => {
    const r = aggregate(scenario({ min_pass_rate: 0, max_cost_usd: 0.05 }), [trial(true, 0.2)]);
    expect(r.gatePassed).toBe(false);
    expect(r.gateReason).toMatch(/cost/);
  });
});
