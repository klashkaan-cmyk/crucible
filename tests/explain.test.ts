import { describe, expect, it } from "vitest";
import { buildExplainPrompt } from "../src/explain.js";
import type { Transcript } from "../src/transcript.js";
import type { Scenario } from "../src/scenario.js";

const transcript: Transcript = {
  version: 1,
  scenario: "security-reviewer-fires",
  trial: 0,
  costUsd: 0.0321,
  numTurns: 6,
  finalResult: "Added the login endpoint.",
  steps: [
    { type: "tool", name: "Edit", summary: "src/auth.ts" },
    { type: "tool", name: "Bash", summary: "npm test" },
  ],
};

describe("buildExplainPrompt", () => {
  it("includes scenario, stats, steps, and final message", () => {
    const p = buildExplainPrompt({ transcript });
    expect(p).toContain("security-reviewer-fires (trial 0)");
    expect(p).toContain("6 turns, $0.0321");
    expect(p).toContain("- tool: Edit (src/auth.ts)");
    expect(p).toContain("Added the login endpoint.");
    expect(p).toContain("CAUSE:");
    expect(p).toContain("FIX:");
  });

  it("includes the scenario intent when provided", () => {
    const scenario = { prompt: "Add a POST /login endpoint." } as Scenario;
    const p = buildExplainPrompt({ transcript, scenario });
    expect(p).toContain("INTENT (prompt given to the agent): Add a POST /login endpoint.");
  });

  it("lists failed checks when provided", () => {
    const p = buildExplainPrompt({
      transcript,
      failures: ["subagent_invoked:security-reviewer: never fired"],
    });
    expect(p).toContain("FAILED CHECKS:");
    expect(p).toContain("- subagent_invoked:security-reviewer: never fired");
  });

  it("handles a run with no steps", () => {
    const p = buildExplainPrompt({ transcript: { ...transcript, steps: [] } });
    expect(p).toContain("(the agent took no tool/subagent actions)");
  });

  it("handles an empty final message", () => {
    const p = buildExplainPrompt({ transcript: { ...transcript, finalResult: "" } });
    expect(p).toContain("(empty)");
  });
});
