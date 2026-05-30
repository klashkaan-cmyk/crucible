import { describe, expect, it } from "vitest";
import { parseHeadless } from "../src/runner.js";

describe("parseHeadless", () => {
  it("parses the claude json envelope", () => {
    const r = parseHeadless(
      JSON.stringify({
        result: "done",
        is_error: false,
        num_turns: 4,
        duration_ms: 1234,
        total_cost_usd: 0.0321,
        session_id: "abc",
      }),
    );
    expect(r.result).toBe("done");
    expect(r.numTurns).toBe(4);
    expect(r.totalCostUsd).toBeCloseTo(0.0321);
    expect(r.isError).toBe(false);
  });

  it("tolerates missing fields", () => {
    const r = parseHeadless(JSON.stringify({ result: "x" }));
    expect(r.totalCostUsd).toBe(0);
    expect(r.numTurns).toBe(0);
  });
});
