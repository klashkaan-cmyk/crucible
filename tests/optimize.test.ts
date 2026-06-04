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
  optimizeMarkdown,
  withRetry,
  classifyInfra,
  InfraError,
  type EditorFn,
  type ScoreFn,
  type ScoreRequest,
  type OptimizeOptions,
  type OptimizeSummary,
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

/** A scored result whose trials carry an infra runError (auth / rate-limit). */
function infraResult(name: string, k: number, msg: string): ScenarioResult {
  const trials: TrialResult[] = Array.from({ length: k }, (_, i) => ({
    index: i,
    assertions: [],
    passed: false,
    costUsd: 0,
    durationMs: 0,
    runError: msg,
  }));
  return { name, trials, passRate: 0, stable: false, medianCostUsd: 0, gatePassed: false, gateReason: "" };
}

const REQ: ScoreRequest = { configDir: "x", scenarioDir: "train", k: 3, kind: "confirm", iter: 1 };

async function branchCommitCount(repo: string, branch: string): Promise<number> {
  const { stdout } = await exec("git", ["-C", repo, "rev-list", "--count", branch]);
  return Number(stdout.trim());
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
const editBadSettings: EditorFn = async (wt) => {
  await writeFile(path.join(wt.configDir, "settings.json"), "{ this is not valid json");
  return { message: "broke settings", costUsd: 0 };
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

  it("rejects a candidate that fails lint, before scoring", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    let scoredCandidate = 0;
    const score = scorer((_d, k, iter) => {
      if (iter > 0) scoredCandidate++;
      return [result("s", 12, k)];
    });
    const summary = await optimize(baseOpts(dir, program, editBadSettings, score));
    expect(summary.accepted).toBe(0);
    expect(summary.rejected["lint-error"]).toBe(1);
    expect(scoredCandidate).toBe(0);
  });

  it("treats infra failures as run-error and does not burn the plateau", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((d, k, iter) => {
      if (d !== "train" || iter === 0) return [result(d, 6, k)]; // clean baseline
      return [infraResult("s", k, "API rate limit exceeded (429)")];
    });
    const summary = await optimize(
      baseOpts(dir, program, editInScope, score, { maxIters: 4, plateauIters: 2 }),
    );
    expect(summary.accepted).toBe(0);
    // 4 iterations ran despite plateauIters=2 -> infra never advanced the plateau
    expect(summary.rejected["run-error"]).toBe(4);
    expect(summary.records).toHaveLength(4);
  });

  it("resume preserves the existing branch lineage", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const accept = scorer((d, k, iter) => {
      if (d === "safety") return [result("sec", k, k)];
      if (d === "holdout") return [result("h", 6, k)];
      return [result("s", iter === 0 ? 6 : 11, k)];
    });
    const run1 = await optimize(baseOpts(dir, program, editInScope, accept));
    expect(run1.accepted).toBe(1);
    const count1 = await branchCommitCount(dir, "optimize/test");
    expect(count1).toBe(2);

    // resume with a no-op editor: no new accepts, but the branch must survive
    const run2 = await optimize(baseOpts(dir, program, editNoop, accept, { resume: true }));
    expect(run2.accepted).toBe(0);
    expect(await branchCommitCount(dir, "optimize/test")).toBe(2);
  });

  it("re-measures the best after the configured interval", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    let trainCalls = 0;
    const score = scorer((d, k, iter) => {
      if (d === "train") trainCalls++;
      if (d === "safety") return [result("sec", k, k)];
      if (d === "holdout") return [result("h", 6, k)];
      return [result("s", iter === 0 ? 6 : 11, k)];
    });
    const summary = await optimize(baseOpts(dir, program, editInScope, score, { remeasureEvery: 1 }));
    expect(summary.accepted).toBe(1);
    // baseline + screen + confirm + one re-measure of the accepted tip
    expect(trainCalls).toBe(4);
    expect(summary.finalObjective).toBeGreaterThan(summary.baselineObjective);
  });

  it("dry-run reports would-accepts but never commits", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const score = scorer((d, k, iter) => {
      if (d === "safety") return [result("sec", k, k)];
      if (d === "holdout") return [result("h", 6, k)];
      return [result("s", iter === 0 ? 6 : 11, k)];
    });
    const summary = await optimize(baseOpts(dir, program, editInScope, score, { dryRun: true }));
    expect(summary.accepted).toBe(1); // would-accept
    expect(summary.commits).toHaveLength(0); // but nothing committed
    expect(await branchCommitCount(dir, "optimize/test")).toBe(1); // branch untouched
  });
});

describe("optimizeMarkdown", () => {
  it("renders the objective delta and a never-merge note", () => {
    const summary = {
      branch: "optimize/x",
      iters: 3,
      accepted: 1,
      rejected: { "no-op": 2 } as OptimizeSummary["rejected"],
      baselineObjective: 0.5,
      finalObjective: 0.8,
      costUsd: 1.2345,
      commits: ["abc123"],
      records: [],
    } as OptimizeSummary;
    const md = optimizeMarkdown(summary);
    expect(md).toMatch(/optimize\/x/);
    expect(md).toMatch(/0\.500 → 0\.800 \(\+0\.300\)/);
    expect(md).toMatch(/never merges/);
    expect(md).toMatch(/no-op: 2/);
  });
});

describe("withRetry", () => {
  it("passes clean results straight through without sleeping", async () => {
    let slept = 0;
    const score = withRetry(async () => [result("s", 3, 3)], { sleep: async () => { slept++; } });
    const out = await score(REQ);
    expect(out).toHaveLength(1);
    expect(slept).toBe(0);
  });

  it("backs off exponentially on rate-limit then succeeds", async () => {
    const waits: number[] = [];
    let n = 0;
    const flaky: ScoreFn = async () =>
      n++ < 2 ? [infraResult("s", 3, "rate limit 429")] : [result("s", 3, 3)];
    const score = withRetry(flaky, { sleep: async (ms) => { waits.push(ms); }, baseBackoffMs: 10 });
    const out = await score(REQ);
    expect(out[0]!.passRate).toBe(1);
    expect(waits).toEqual([10, 20]);
  });

  it("pauses and re-polls on auth failure", async () => {
    const waits: number[] = [];
    let n = 0;
    const flaky: ScoreFn = async () =>
      n++ < 3 ? [infraResult("s", 3, "not authenticated, please run /login")] : [result("s", 3, 3)];
    const score = withRetry(flaky, { sleep: async (ms) => { waits.push(ms); }, authWaitMs: 100 });
    await score(REQ);
    expect(waits).toEqual([100, 100, 100]);
  });

  it("throws InfraError when retries are exhausted", async () => {
    const score = withRetry(async () => [infraResult("s", 3, "rate limit")], {
      sleep: async () => {},
      maxRateRetries: 2,
    });
    const err = await score(REQ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).kind).toBe("rate-limit");
  });

  it("aborts via signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const score = withRetry(async () => [result("s", 3, 3)], { signal: ac.signal, sleep: async () => {} });
    await expect(score(REQ)).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("classifyInfra", () => {
  it("flags auth over rate-limit, and clears clean runs", () => {
    expect(classifyInfra([infraResult("a", 2, "invalid api key")])).toBe("auth");
    expect(classifyInfra([infraResult("a", 2, "overloaded")])).toBe("rate-limit");
    expect(classifyInfra([result("a", 2, 2)])).toBeNull();
  });
});
