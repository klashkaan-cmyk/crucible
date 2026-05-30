import { describe, expect, it } from "vitest";
import {
  diffSteps,
  stepKey,
  summarizeDiff,
  transcriptFileName,
  type Transcript,
} from "../src/transcript.js";
import type { Invocation } from "../src/types.js";

const tool = (name: string, summary?: string): Invocation =>
  summary ? { type: "tool", name, summary } : { type: "tool", name };

const transcript = (steps: Invocation[], over: Partial<Transcript> = {}): Transcript => ({
  version: 1,
  scenario: "s",
  trial: 0,
  costUsd: 0.1,
  numTurns: 3,
  finalResult: "done",
  steps,
  ...over,
});

describe("stepKey", () => {
  it("includes type, name, and summary", () => {
    expect(stepKey(tool("Bash", "npm test"))).toBe("tool:Bash:npm test");
    expect(stepKey(tool("Read"))).toBe("tool:Read:");
  });
});

describe("diffSteps", () => {
  it("marks identical lists as all same", () => {
    const a = [tool("Read"), tool("Bash", "npm test")];
    const rows = diffSteps(a, a);
    expect(rows.every((r) => r.marker === "same")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("detects an added step", () => {
    const rows = diffSteps([tool("Read")], [tool("Read"), tool("Write", "a.ts")]);
    expect(rows.map((r) => r.marker)).toEqual(["same", "add"]);
    expect(rows[1]?.b?.name).toBe("Write");
  });

  it("detects a removed step", () => {
    const rows = diffSteps([tool("Read"), tool("Bash", "rm x")], [tool("Read")]);
    expect(rows.map((r) => r.marker)).toEqual(["same", "del"]);
    expect(rows[1]?.a?.summary).toBe("rm x");
  });

  it("aligns around a changed middle step", () => {
    const a = [tool("Read"), tool("Bash", "old"), tool("Write")];
    const b = [tool("Read"), tool("Bash", "new"), tool("Write")];
    const markers = diffSteps(a, b).map((r) => r.marker);
    expect(markers).toContain("del");
    expect(markers).toContain("add");
    expect(markers.filter((m) => m === "same")).toHaveLength(2);
  });
});

describe("summarizeDiff", () => {
  it("counts changes and metric deltas", () => {
    const a = transcript([tool("Read")], { costUsd: 0.1, numTurns: 2 });
    const b = transcript([tool("Read"), tool("Write")], { costUsd: 0.25, numTurns: 4 });
    const s = summarizeDiff(a, b, diffSteps(a.steps, b.steps));
    expect(s.added).toBe(1);
    expect(s.unchanged).toBe(1);
    expect(s.turnDelta).toBe(2);
    expect(s.costDelta).toBeCloseTo(0.15);
  });
});

describe("transcriptFileName", () => {
  it("slugifies the scenario name", () => {
    expect(transcriptFileName("auth: login flow", 2)).toBe("auth-login-flow.trial2.json");
  });
});
