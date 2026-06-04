import { describe, expect, it } from "vitest";
import { buildIdeatorPrompt, parseHypotheses, renderSummary } from "../src/ideator.js";
import type { Program } from "../src/program.js";
import type { Hypothesis } from "../src/research.js";

const program: Program = {
  objective: "Catch more real issues without raising cost.",
  constraints: "Do not weaken refusals.",
  mutableSurface: { allow: [".claude/**"], deny: [] },
  fitness: {
    suite: "train",
    objective: "pass_rate",
    tie_breaker: "median_cost",
    k_screen: 3,
    k_confirm: 12,
    significance: 0.95,
    accept: {
      no_regression_vs_best: true,
      min_objective_gain: 0.05,
      holdout_no_regression: false,
      safety_must_be_stable: false,
      cost_tolerance: 0.5,
    },
  },
  research: {
    beam_width: 3,
    ideas_per_round: 6,
    max_rounds: 40,
    expand_every: 5,
    saturation: 0.95,
    diversity_floor: 0.15,
    exploration: "Favor tightening descriptions over adding tools.",
  },
};

describe("renderSummary", () => {
  it("lists subagents and skills compactly", () => {
    const text = renderSummary({
      subagents: [{ name: "security-reviewer", desc: "" }],
      skills: [],
      hasClaudeMd: true,
    });
    expect(text).toMatch(/security-reviewer/);
    expect(text).toMatch(/Skills: \(none\)/);
    expect(text).toMatch(/CLAUDE\.md: present/);
  });
});

describe("buildIdeatorPrompt", () => {
  it("includes objective, exploration, weak spots, and a do-not-repeat backlog", () => {
    const backlog: Hypothesis[] = [
      { id: "a", parentBeam: 0, rationale: "added a caching layer", status: "failed" },
    ];
    const prompt = buildIdeatorPrompt({
      program,
      configText: "Subagents: x",
      failures: "login: pass rate 40%",
      backlog,
      n: 3,
    });
    expect(prompt).toMatch(/Propose 3 DISTINCT/);
    expect(prompt).toMatch(/Catch more real issues/);
    expect(prompt).toMatch(/Favor tightening descriptions/);
    expect(prompt).toMatch(/login: pass rate 40%/);
    expect(prompt).toMatch(/do NOT repeat/);
    expect(prompt).toMatch(/added a caching layer/);
    expect(prompt).toMatch(/start.*with 'IDEA:'/);
  });
});

describe("parseHypotheses", () => {
  it("parses IDEA lines, ignores noise, and tags the parent beam", () => {
    const text = "Here are ideas:\nIDEA: tighten the trigger\nrandom\nIDEA: add a checklist item\n";
    const hyps = parseHypotheses(text, 2, "r1-b2");
    expect(hyps).toHaveLength(2);
    expect(hyps[0]).toMatchObject({ rationale: "tighten the trigger", parentBeam: 2, status: "proposed" });
    expect(hyps[1]!.rationale).toBe("add a checklist item");
    expect(hyps[0]!.id).toBe("r1-b2-0");
  });
});
