import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSaturated,
  nearMisses,
  buildSynthPrompt,
  parseScenarioBlocks,
  isDiscriminating,
  expandFrontier,
  type CandidateScenario,
  type SynthesizeFn,
} from "../src/frontier.js";
import type { Program } from "../src/program.js";
import type { ScoreFn } from "../src/optimize.js";
import type { ScenarioResult, TrialResult } from "../src/types.js";

function result(name: string, passes: number, k: number): ScenarioResult {
  const trials: TrialResult[] = Array.from({ length: k }, (_, i) => ({
    index: i,
    assertions: [],
    passed: i < passes,
    costUsd: 0.01,
    durationMs: 1,
  }));
  return { name, trials, passRate: passes / k, stable: passes === k, medianCostUsd: 0.01, gatePassed: true, gateReason: "" };
}

const program: Program = {
  objective: "Catch more real issues.",
  constraints: "",
  mutableSurface: { allow: [".claude/**"], deny: [] },
  fitness: {
    suite: "train",
    objective: "pass_rate",
    tie_breaker: "median_cost",
    k_screen: 2,
    k_confirm: 6,
    significance: 0.95,
    accept: { no_regression_vs_best: true, min_objective_gain: 0.05, holdout_no_regression: false, safety_must_be_stable: false, cost_tolerance: 0.5 },
  },
};

const validCandidate = (name: string): CandidateScenario => ({
  name,
  filename: `synth-${name}.scenario.yaml`,
  yaml: `name: ${name}\nprompt: do a hard thing\nassert:\n  - response_contains: x\n`,
});

describe("isSaturated / nearMisses", () => {
  it("flags a saturated suite and selects well-handled scenarios", () => {
    expect(isSaturated([result("a", 6, 6), result("b", 6, 6)], 0.95)).toBe(true);
    expect(isSaturated([result("a", 3, 6)], 0.95)).toBe(false);
    expect(isSaturated([], 0.95)).toBe(false);
    const nm = nearMisses([result("a", 6, 6), result("b", 1, 6)], 0.5);
    expect(nm.map((r) => r.name)).toEqual(["a"]);
  });
});

describe("synth prompt + parse", () => {
  it("builds a prompt that asks for harder fenced-yaml scenarios", () => {
    const p = buildSynthPrompt(program, "- a: 100% pass", 3);
    expect(p).toMatch(/3 NEW, HARDER/);
    expect(p).toMatch(/Catch more real issues/);
    expect(p).toMatch(/```yaml/);
    expect(p).toMatch(/- a: 100% pass/);
  });

  it("parses fenced yaml blocks and derives filenames", () => {
    const text = "Here:\n```yaml\nname: hard-login\nprompt: x\n```\nand\n```yaml\nname: edge-case\nprompt: y\n```";
    const blocks = parseScenarioBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ name: "hard-login", filename: "synth-hard-login.scenario.yaml" });
    expect(blocks[1]!.name).toBe("edge-case");
  });
});

describe("isDiscriminating", () => {
  // good config passes everything; weak config fails everything
  const score: ScoreFn = async ({ configDir, k }) =>
    [result("c", configDir === "GOOD" ? k : 0, k)];

  it("admits a scenario that passes on good and fails on weak", async () => {
    expect(await isDiscriminating(validCandidate("a"), "GOOD", "WEAK", score, 6)).toBe(true);
  });

  it("rejects a scenario that passes on both (no signal)", async () => {
    const passBoth: ScoreFn = async ({ k }) => [result("c", k, k)];
    expect(await isDiscriminating(validCandidate("a"), "GOOD", "WEAK", passBoth, 6)).toBe(false);
  });

  it("rejects a malformed scenario", async () => {
    const bad: CandidateScenario = { name: "bad", filename: "synth-bad.scenario.yaml", yaml: "name: bad\n" };
    expect(await isDiscriminating(bad, "GOOD", "WEAK", score, 6)).toBe(false);
  });
});

describe("expandFrontier", () => {
  it("admits discriminating scenarios, honors the holdout split, and discards the rest", async () => {
    const good = await mkdtemp(path.join(tmpdir(), "good-")); // empty config -> no deterministic scenarios
    const weak = await mkdtemp(path.join(tmpdir(), "weak-"));
    await writeFile(path.join(weak, "CLAUDE.md"), "# weak\n");
    const trainDir = await mkdtemp(path.join(tmpdir(), "train-"));
    const holdoutDir = await mkdtemp(path.join(tmpdir(), "holdout-"));

    // good (== `good` path) passes; anything else (the weak dir) fails
    const score: ScoreFn = async ({ configDir, k }) => [result("c", configDir === good ? k : 0, k)];
    const synth: SynthesizeFn = async () => [
      validCandidate("a"),
      validCandidate("b"),
      { name: "bad", filename: "synth-bad.scenario.yaml", yaml: "name: bad\n" }, // malformed -> rejected
    ];

    const res = await expandFrontier({
      configDir: good,
      program,
      trainDir,
      holdoutDir,
      score,
      synthesize: synth,
      currentResults: [result("x", 6, 6)],
      n: 3,
      holdoutFraction: 0.5,
      weakConfigDir: weak,
    });

    expect(res.rejected).toBe(1); // the malformed one
    expect(res.admittedTrain + res.admittedHoldout).toBe(2);
    expect(res.admittedHoldout).toBe(1); // 0.5 fraction over 2 admitted
    expect(res.admittedTrain).toBe(1);
    const trainFiles = await readdir(trainDir);
    const holdoutFiles = await readdir(holdoutDir);
    expect(trainFiles.length + holdoutFiles.length).toBe(2);
  });
});
