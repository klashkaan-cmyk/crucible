import { describe, expect, it } from "vitest";
import { aggregate, median, significant } from "../src/stats.js";
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

describe("significant", () => {
  it("rejects 3/5-vs-4/5 as noise", () => {
    expect(significant(3, 5, 4, 5)).toBe(false);
  });

  it("accepts a clearly separated gain", () => {
    expect(significant(2, 12, 11, 12)).toBe(true);
    expect(significant(0, 5, 5, 5)).toBe(true);
  });

  it("returns false when B is not strictly above A", () => {
    expect(significant(4, 5, 3, 5)).toBe(false); // A higher
    expect(significant(3, 5, 3, 5)).toBe(false); // equal
    expect(significant(5, 5, 5, 5)).toBe(false); // both all-pass, no variance
  });

  it("returns false with no data", () => {
    expect(significant(0, 0, 1, 0)).toBe(false);
  });

  it("honors the confidence level", () => {
    // 6/12 -> 11/12 is significant at 95% but not at 99%
    expect(significant(6, 12, 11, 12, 0.95)).toBe(true);
    expect(significant(6, 12, 11, 12, 0.99)).toBe(false);
  });
});
