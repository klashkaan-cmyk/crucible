import { describe, expect, it } from "vitest";
import { badgeEndpoint } from "../src/badge.js";
import type { ScenarioResult } from "../src/types.js";

function result(name: string, gatePassed: boolean): ScenarioResult {
  return {
    name,
    trials: [],
    passRate: gatePassed ? 1 : 0,
    stable: gatePassed,
    medianCostUsd: 0.01,
    gatePassed,
    gateReason: gatePassed ? "ok" : "failed",
  } as ScenarioResult;
}

describe("badgeEndpoint", () => {
  it("is green when all gates pass", () => {
    const b = badgeEndpoint([result("a", true), result("b", true)]);
    expect(b).toMatchObject({ schemaVersion: 1, label: "crucible", message: "2/2 passing", color: "brightgreen" });
  });

  it("is red when any gate fails", () => {
    const b = badgeEndpoint([result("a", true), result("b", false)]);
    expect(b.message).toBe("1/2 passing");
    expect(b.color).toBe("red");
  });

  it("handles an empty suite", () => {
    const b = badgeEndpoint([]);
    expect(b.message).toBe("no scenarios");
    expect(b.color).toBe("lightgrey");
  });

  it("honors a custom label", () => {
    expect(badgeEndpoint([result("a", true)], "agent eval").label).toBe("agent eval");
  });
});
