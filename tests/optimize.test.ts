import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadProgram, type Program } from "../src/program.js";
import {
  optimize,
  objectiveOf,
  significantGain,
  type EditorFn,
  type ScoreFn,
  type OptimizeOptions,
} from "../src/optimize.js";
import type { ScenarioResult, TrialResult } from "../src/types.js";

const exec = promisify(execFile);

// --- fixtures ---------------------------------------------------------------

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-opt-test-"));
  await exec("git", ["-C", dir, "init", "-q"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "CLAUDE.md"), "base");
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

const PROGRAM_MD = `## Objective
improve it
## Mutable surface
allow:
  - .claude/**
## Fitness
suite: train
holdout: holdout
safety: safety
k_screen: 3
k_confirm: 12
significance: 0.95
accept:
  min_objective_gain: 0.05
`;

async function loadProg(body = PROGRAM_MD): Promise<Program> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-prog-"));
  const file = path.join(dir, "PROGRAM.md");
  await writeFile(file, body);
  return loadProgram(file);
}

function result(name: string, passes: number, k: number, cost = 0.01): ScenarioResult {
  const trials: TrialResult[] = Array.from({ length: k }, (_, i) => ({
    index: i,
    assertions: [],
    passed: i < passes,
    costUsd: cost,
    durationMs: 1,
  }));
  return {
    name,
    trials,
    passRate: passes / k,
    stable: passes === k,
    medianCostUsd: cost,
    gatePassed: true,
    gateReason: "",
  };
}

/** A scorer driven by a plan: (scenarioDir, k, iter) -> results. */
function scorer(plan: (dir: string, k: number, iter: number) => ScenarioResult[]): ScoreFn {
  return async ({ scenarioDir, k, iter }) => plan(scenarioDir, k, iter);
}

const editInScope: EditorFn = async (wt, ctx) => {
  await writeFile(path.join(wt.configDir, "note.md"), `change ${ctx.iter}`);
  return { message: `edit ${ctx.iter}`, costUsd: 0 };
};
const editNoop: EditorFn = async () => ({ message: "noop", costUsd: 0 });
const editOutOfScope: EditorFn = async (wt) => {
  await writeFile(path.join(wt.root, "outside.txt"), "x");
  return { message: "escaped", costUsd: 0 };
};

function baseOpts(
  dir: string,
  program: Program,
  editor: EditorFn,
  score: ScoreFn,
  over: Partial<OptimizeOptions> = {},
): OptimizeOptions {
  return {
    configDir: path.join(dir, ".claude"),
    program,
    budgetUsd: 1000,
    maxIters: 1,
    plateauIters: 50,
    branch: "optimize/test",
    editor,
    score,
    ...over,
  };
}

// --- pure gate helpers ------------------------------------------------------

describe("optimize gate helpers", () => {
  it("objectiveOf is the mean pass rate", () => {
    expect(objectiveOf([result("a", 6, 12), result("b", 12, 12)])).toBeCloseTo(0.75);
    expect(objectiveOf([])).toBe(0);
  });

  it("significantGain reflects the z-test", () => {
    expect(significantGain([result("a", 11, 12)], [result("a", 2, 12)], 0.95)).toBe(true);
    expect(significantGain([result("a", 4, 5)], [result("a", 3, 5)], 0.95)).toBe(false);
  });
});

// --- the loop ---------------------------------------------------------------

describe("optimize loop", () => {
  it("accepts a significant gain, commits it, and writes the ledger", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const ledgerPath = path.join(await mkdtemp(path.join(tmpdir(), "led-")), "l.jsonl");
    const score = scorer((d, k, iter) => {
      if (d === "safety") return [result("sec", k, k)]; // stable
      if (d === "holdout") return [result("h", 6, k)]; // flat
      return [result("s", iter === 0 ? 6 : 11, k)]; // train jumps after baseline
    });
    const summary = await optimize(baseOpts(dir, program, editInScope, score, { ledgerPath }));

    expect(summary.accepted).toBe(1);
    expect(summary.commits).toHaveLength(1);
    expect(summary.commits[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(summary.finalObjective).toBeGreaterThan(summary.baselineObjective);

    // the commit really landed on the branch
    const { stdout } = await exec("git", ["-C", dir, "rev-list", "--count", "optimize/test"]);
    expect(Number(stdout.trim())).toBe(2); // init + 1 accepted candidate

    const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(ledger[0]!).verdict.kind).toBe("accept");
  });

  it("rejects a no-op edit without scoring", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    let scored = 0;
    const score = scorer((d, k, iter) => {
      if (iter > 0) scored++; // any scoring beyond the baseline
      return [result("x", 6, k)];
    });
    const summary = await optimize(baseOpts(dir, program, editNoop, score));
    expect(summary.accepted).toBe(0);
    expect(summary.rejected["no-op"]).toBe(1);
    expect(scored).toBe(0);
  });

  it("rejects an out-of-scope edit", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((_d, k) => [result("x", 12, k)]);
    const summary = await optimize(baseOpts(dir, program, editOutOfScope, score));
    expect(summary.rejected["out-of-scope-edit"]).toBe(1);
    expect(summary.records[0]!.verdict).toMatchObject({ reason: "out-of-scope-edit", detail: "outside.txt" });
  });

  it("rejects a safety regression regardless of objective gain", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((d, k, iter) => {
      if (d === "safety") return [result("sec", iter === 0 ? k : 10, k)]; // breaks after baseline
      if (d === "holdout") return [result("h", 6, k)];
      return [result("s", iter === 0 ? 6 : 11, k)]; // train would otherwise be a strong accept
    });
    const summary = await optimize(baseOpts(dir, program, editInScope, score));
    expect(summary.accepted).toBe(0);
    expect(summary.rejected["safety-regression"]).toBe(1);
  });

  it("rejects a holdout regression (generalization gap)", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((d, k, iter) => {
      if (d === "safety") return [result("sec", k, k)];
      if (d === "holdout") return [result("h", iter === 0 ? 6 : 3, k)]; // holdout drops
      return [result("s", iter === 0 ? 6 : 11, k)]; // train climbs
    });
    const summary = await optimize(baseOpts(dir, program, editInScope, score));
    expect(summary.accepted).toBe(0);
    expect(summary.rejected["holdout-regression"]).toBe(1);
  });

  it("rejects a gain that is not statistically significant", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((d, k, iter) => {
      if (d === "safety") return [result("sec", k, k)];
      if (d === "holdout") return [result("h", 6, k)];
      return [result("s", iter === 0 ? 6 : 7, k)]; // 6/12 -> 7/12: real but noisy
    });
    const summary = await optimize(baseOpts(dir, program, editInScope, score));
    expect(summary.accepted).toBe(0);
    expect(summary.rejected["insufficient-gain"]).toBe(1);
  });

  it("halts when the budget is exhausted", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((_d, k) => [result("s", 12, k)]); // 12 trials * 0.01 each
    const summary = await optimize(
      baseOpts(dir, program, editInScope, score, { budgetUsd: 0.05, maxIters: 5 }),
    );
    expect(summary.accepted).toBe(0);
    expect(summary.iters).toBe(0); // baseline alone exceeds the budget
    expect(summary.costUsd).toBeGreaterThanOrEqual(0.05);
  });

  it("stops after the plateau limit of consecutive rejects", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((_d, k) => [result("s", 6, k)]);
    const summary = await optimize(
      baseOpts(dir, program, editNoop, score, { maxIters: 10, plateauIters: 3 }),
    );
    expect(summary.accepted).toBe(0);
    expect(summary.rejected["no-op"]).toBe(3);
    expect(summary.records).toHaveLength(3);
  });
});
