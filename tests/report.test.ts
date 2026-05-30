import { describe, expect, it } from "vitest";
import { markdownSummary, resultsToJson } from "../src/report.js";
import type { ScenarioResult } from "../src/types.js";

const r = (name: string, gatePassed: boolean, passRate = 1): ScenarioResult => ({
  name,
  trials: [],
  passRate,
  stable: passRate === 1,
  medianCostUsd: 0.12,
  gatePassed,
  gateReason: gatePassed ? "ok" : "pass rate too low",
});

describe("resultsToJson", () => {
  it("summarizes gates, cost, and scenarios", () => {
    const j = resultsToJson([r("a", true), r("b", false, 0.5)]);
    expect(j.gatesFailed).toBe(1);
    expect(j.scenarios).toHaveLength(2);
    expect(j.totalMedianCostUsd).toBeCloseTo(0.24);
    expect(j.regressions).toEqual([]);
  });

  it("includes regressions when provided", () => {
    const j = resultsToJson([r("a", true)], [{ name: "a", kind: "cost-increase", detail: "up" }]);
    expect(j.regressions[0]).toEqual({ name: "a", kind: "cost-increase", detail: "up" });
  });
});

describe("markdownSummary", () => {
  it("renders a table with a pass/fail header", () => {
    const md = markdownSummary([r("a", true)]);
    expect(md).toContain("All gates passed");
    expect(md).toContain("| Scenario |");
    expect(md).toContain("a");
  });

  it("notes failures and regressions", () => {
    const md = markdownSummary([r("b", false, 0.4)], [{ name: "b", kind: "became-flaky", detail: "x" }]);
    expect(md).toContain("1 gate(s) failed");
    expect(md).toContain("became-flaky");
  });
});
