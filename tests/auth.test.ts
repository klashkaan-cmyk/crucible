import { describe, expect, it } from "vitest";
import { authFailureHint } from "../src/runner.js";
import type { HeadlessResult } from "../src/types.js";

function headless(over: Partial<HeadlessResult> = {}): HeadlessResult {
  return {
    result: "",
    isError: false,
    numTurns: 0,
    durationMs: 0,
    totalCostUsd: 0,
    sessionId: "s",
    ...over,
  };
}

describe("authFailureHint", () => {
  it("returns null for a normal successful run", () => {
    expect(authFailureHint(headless({ result: "PONG", isError: false }))).toBeNull();
  });

  it("returns null for an ordinary error that is not an auth failure", () => {
    expect(authFailureHint(headless({ result: "something broke", isError: true }))).toBeNull();
  });

  it("detects 'Not logged in'", () => {
    const hint = authFailureHint(headless({ result: "Not logged in · Please run /login", isError: true }));
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(hint).toMatch(/credentials/);
  });

  it("detects an invalid API key", () => {
    expect(authFailureHint(headless({ result: "Invalid API key", isError: true }))).toBeTruthy();
  });

  it("interpolates the underlying message (no literal template placeholder)", () => {
    const hint = authFailureHint(headless({ result: "Not logged in", isError: true }))!;
    expect(hint).toContain("Not logged in");
    expect(hint).not.toContain("${");
  });
});
