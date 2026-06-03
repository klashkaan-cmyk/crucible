/**
 * `crucible optimize` core loop.
 *
 * An autonomous, variance-aware, safety-gated hill-climb over a config mutation
 * surface. Each iteration: reset the worktree, let the editor mutate it, check
 * the edit is in-scope, score cheaply (k_screen), and only pay the expensive
 * confirm (k_confirm) for promising candidates. A candidate is KEPT (committed
 * onto the run branch) only when it regresses no scenario vs the current best,
 * breaks no safety scenario, beats the objective past an effect-size floor AND a
 * significance test, and does not regress a holdout the editor never saw.
 *
 * The editor and scorer are injected so the whole loop -- gate, two-stage k,
 * commit/revert, ledger, budget -- is testable offline. `runSuiteScorer` binds
 * the production scorer to `runSuite`; the real editor + CLI land in a later step.
 *
 * See docs/optimize-spec.md.
 */

import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveConfigRepo } from "./bisect.js";
import {
  diffAgainstBaseline,
  toBaseline,
  type Baseline,
} from "./baseline.js";
import { median, significant } from "./stats.js";
import {
  discoverScenarios,
  runSuite,
  type SuiteOptions,
} from "./suite.js";
import {
  gitChangedFiles,
  openWorktree,
  resetWorktree,
  withinAllowlist,
  type Worktree,
} from "./worktree.js";
import type { Program } from "./program.js";
import type { ScenarioResult } from "./types.js";

const exec = promisify(execFile);
const EPS = 1e-9;

// --- injected seams ---------------------------------------------------------

export interface EditorContext {
  readonly program: Program;
  readonly iter: number;
  /** The current best's train scoring -- the source of the failures digest. */
  readonly lastSuite: ReadonlyArray<ScenarioResult>;
}

export interface EditorResult {
  /** The agent's rationale / final text. */
  readonly message: string;
  readonly costUsd: number;
}

/** Mutates files inside `wt.configDir`. The loop verifies the diff afterward. */
export type EditorFn = (wt: Worktree, ctx: EditorContext) => Promise<EditorResult>;

export type ScoreKind = "screen" | "confirm";

export interface ScoreRequest {
  readonly configDir: string;
  readonly scenarioDir: string;
  readonly k: number;
  readonly kind: ScoreKind;
  readonly iter: number;
}

export type ScoreFn = (req: ScoreRequest) => Promise<ScenarioResult[]>;

/** Production scorer: discover scenarios in a dir and run them at k trials. */
export function runSuiteScorer(
  base: Omit<SuiteOptions, "configDir" | "scenarioDir" | "trialsOverride"> = {},
): ScoreFn {
  return async ({ configDir, scenarioDir, k }) => {
    const files = await discoverScenarios(scenarioDir);
    return runSuite(files, { ...base, configDir, scenarioDir, trialsOverride: k });
  };
}

// --- options / results ------------------------------------------------------

export interface OptimizeOptions {
  readonly configDir: string;
  readonly program: Program;
  /** Hard ceiling on summed real cost (editor + all trial runs). */
  readonly budgetUsd: number;
  readonly maxIters: number;
  /** Stop after this many consecutive rejected candidates. */
  readonly plateauIters: number;
  /** Branch the worktree is checked out on; accepted candidates commit here. */
  readonly branch: string;
  readonly editor: EditorFn;
  readonly score: ScoreFn;
  /** When set, every IterationRecord is appended here as JSONL. */
  readonly ledgerPath?: string;
  readonly signal?: AbortSignal;
}

export type RejectReason =
  | "no-op"
  | "out-of-scope-edit"
  | "lint-error"
  | "safety-regression"
  | "suite-regression"
  | "insufficient-gain"
  | "holdout-regression"
  | "run-error";

const ALL_REJECT_REASONS: ReadonlyArray<RejectReason> = [
  "no-op",
  "out-of-scope-edit",
  "lint-error",
  "safety-regression",
  "suite-regression",
  "insufficient-gain",
  "holdout-regression",
  "run-error",
];

export type Verdict =
  | { readonly kind: "accept"; readonly objective: number; readonly gain: number }
  | { readonly kind: "reject"; readonly reason: RejectReason; readonly detail: string };

export interface IterationRecord {
  readonly iter: number;
  readonly verdict: Verdict;
  readonly changedFiles: ReadonlyArray<string>;
  readonly editorMessage: string;
  readonly costUsd: number;
  readonly cumCostUsd: number;
  readonly commit?: string;
}

export interface OptimizeSummary {
  readonly branch: string;
  readonly iters: number;
  readonly accepted: number;
  readonly rejected: Readonly<Record<RejectReason, number>>;
  readonly baselineObjective: number;
  readonly finalObjective: number;
  readonly costUsd: number;
  readonly commits: ReadonlyArray<string>;
  readonly records: ReadonlyArray<IterationRecord>;
}

/** The current best config's scored state, against which candidates are judged. */
interface Best {
  readonly objective: number;
  readonly cost: number;
  readonly baseline: Baseline;
  readonly holdoutBaseline?: Baseline;
  readonly trainResults: ReadonlyArray<ScenarioResult>;
}

// --- pure gate helpers ------------------------------------------------------

/** Objective = mean pass_rate over the suite (the v1 scalar objective). */
export function objectiveOf(results: ReadonlyArray<ScenarioResult>): number {
  if (results.length === 0) return 0;
  return results.reduce((s, r) => s + r.passRate, 0) / results.length;
}

function medianCostOf(results: ReadonlyArray<ScenarioResult>): number {
  return median(results.map((r) => r.medianCostUsd));
}

/** Sum of every trial's real cost across the scored scenarios. */
function sumRealCost(results: ReadonlyArray<ScenarioResult>): number {
  let total = 0;
  for (const r of results) for (const t of r.trials) total += t.costUsd;
  return total;
}

/** Pool per-scenario trial outcomes into (successes, trials) for the z-test. */
function pool(results: ReadonlyArray<ScenarioResult>): { successes: number; trials: number } {
  let successes = 0;
  let trials = 0;
  for (const r of results) {
    for (const t of r.trials) {
      trials++;
      if (t.passed) successes++;
    }
  }
  return { successes, trials };
}

/** Is the candidate's pooled pass rate significantly above the best's? */
export function significantGain(
  candidate: ReadonlyArray<ScenarioResult>,
  best: ReadonlyArray<ScenarioResult>,
  level: number,
): boolean {
  const a = pool(best);
  const b = pool(candidate);
  return significant(a.successes, a.trials, b.successes, b.trials, level);
}

/** Cheap screen: only worth paying for confirm if it is at least as good as best. */
function promising(screen: ReadonlyArray<ScenarioResult>, best: Best): boolean {
  return objectiveOf(screen) >= best.objective;
}

/** The vector accept-gate. Pure given the confirm-level scores + the best. */
export function decide(
  cand: ReadonlyArray<ScenarioResult>,
  safety: ReadonlyArray<ScenarioResult>,
  best: Best,
  program: Program,
): Verdict {
  const a = program.fitness.accept;
  const reject = (reason: RejectReason, detail: string): Verdict => ({ kind: "reject", reason, detail });

  // 1. Safety is a hard constraint -- never traded for objective.
  if (a.safety_must_be_stable) {
    const broke = safety.find((s) => !s.stable);
    if (broke) return reject("safety-regression", broke.name);
  }

  // 2. No per-scenario regression vs the current best (tightened to passRateDrop 0).
  if (a.no_regression_vs_best) {
    const regs = diffAgainstBaseline(cand, best.baseline, {
      passRateDrop: 0,
      costIncrease: a.cost_tolerance,
    });
    if (regs.length > 0) return reject("suite-regression", regs[0]!.detail);
  }

  // 3. Objective must clear the effect-size floor AND a significance test.
  const objective = objectiveOf(cand);
  const gain = objective - best.objective;
  const sig = significantGain(cand, best.trainResults, program.fitness.significance);
  if (gain < a.min_objective_gain || !sig) {
    // Equal-objective acceptance only if strictly cheaper (tie-breaker).
    if (gain >= 0 && medianCostOf(cand) < best.cost - EPS) {
      return { kind: "accept", objective, gain: 0 };
    }
    return reject("insufficient-gain", `gain +${gain.toFixed(3)}${sig ? "" : " (not significant)"}`);
  }
  return { kind: "accept", objective, gain };
}

// --- the loop ---------------------------------------------------------------

export async function optimize(opts: OptimizeOptions): Promise<OptimizeSummary> {
  const repo = await resolveConfigRepo(opts.configDir);
  const wt = await openWorktree(repo, opts.branch);
  const fit = opts.program.fitness;
  const records: IterationRecord[] = [];
  const rejected = initRejectCounts();
  const commits: string[] = [];
  let cum = 0;
  let plateau = 0;
  let accepted = 0;
  let iters = 0;

  try {
    const baseline = await scoreBaseline(wt, opts);
    let best = baseline.best;
    cum += baseline.costUsd;

    for (let iter = 1; iter <= opts.maxIters; iter++) {
      if (opts.signal?.aborted) break;
      if (cum >= opts.budgetUsd) break;
      if (plateau >= opts.plateauIters) break;
      iters = iter;
      await resetWorktree(wt);

      // 1. MUTATE
      const edit = await opts.editor(wt, { program: opts.program, iter, lastSuite: best.trainResults });
      let iterCost = edit.costUsd;
      cum += edit.costUsd;

      // The diff is the scope-guard surface AND what each record reports changed.
      const scope = await gitChangedFiles(wt);

      const record = async (verdict: Verdict, commit?: string): Promise<void> => {
        const rec: IterationRecord = {
          iter,
          verdict,
          changedFiles: scope,
          editorMessage: edit.message,
          costUsd: iterCost,
          cumCostUsd: cum,
          ...(commit ? { commit } : {}),
        };
        records.push(rec);
        if (verdict.kind === "reject") {
          rejected[verdict.reason] += 1;
          plateau += 1;
        }
        await writeLedger(opts.ledgerPath, rec);
      };

      // 2. SCOPE GUARD (free) -- reject before spending a single trial.
      if (scope.length === 0) {
        await record({ kind: "reject", reason: "no-op", detail: "editor changed nothing" });
        continue;
      }
      if (!withinAllowlist(scope, opts.program.mutableSurface)) {
        const offending = scope.find((f) => !withinAllowlist([f], opts.program.mutableSurface)) ?? scope[0]!;
        await record({ kind: "reject", reason: "out-of-scope-edit", detail: offending });
        continue;
      }

      // 3. SCREEN cheap.
      const screen = await opts.score({
        configDir: wt.configDir, scenarioDir: fit.suite, k: fit.k_screen, kind: "screen", iter,
      });
      iterCost += sumRealCost(screen);
      cum += sumRealCost(screen);
      if (!promising(screen, best)) {
        await record({ kind: "reject", reason: "insufficient-gain", detail: "below best on cheap screen" });
        continue;
      }

      // 3b. CONFIRM expensive (train + safety).
      const cand = await opts.score({
        configDir: wt.configDir, scenarioDir: fit.suite, k: fit.k_confirm, kind: "confirm", iter,
      });
      const safety = fit.safety
        ? await opts.score({ configDir: wt.configDir, scenarioDir: fit.safety, k: fit.k_confirm, kind: "confirm", iter })
        : [];
      const confirmCost = sumRealCost(cand) + sumRealCost(safety);
      iterCost += confirmCost;
      cum += confirmCost;

      // 4. ACCEPT GATE.
      const verdict = decide(cand, safety, best, opts.program);
      if (verdict.kind === "reject") {
        await record(verdict);
        continue;
      }

      // 5. HOLDOUT -- only candidates that passed train pay for it.
      let holdout: ScenarioResult[] | undefined;
      if (fit.holdout) {
        holdout = await opts.score({
          configDir: wt.configDir, scenarioDir: fit.holdout, k: fit.k_confirm, kind: "confirm", iter,
        });
        const hCost = sumRealCost(holdout);
        iterCost += hCost;
        cum += hCost;
        if (fit.accept.holdout_no_regression && best.holdoutBaseline) {
          const hr = diffAgainstBaseline(holdout, best.holdoutBaseline, {
            passRateDrop: 0,
            costIncrease: fit.accept.cost_tolerance,
          });
          if (hr.length > 0) {
            await record({ kind: "reject", reason: "holdout-regression", detail: hr[0]!.detail });
            continue;
          }
        }
      }

      // 6. KEEP -- commit onto the branch, advance best, reset the plateau.
      const commit = await commitWorktree(wt, `optimize: iter ${iter} (+${verdict.gain.toFixed(3)})`);
      commits.push(commit);
      best = {
        objective: verdict.objective,
        cost: medianCostOf(cand),
        baseline: toBaseline(cand),
        holdoutBaseline: holdout ? toBaseline(holdout) : best.holdoutBaseline,
        trainResults: cand,
      };
      accepted += 1;
      plateau = 0;
      await record(verdict, commit);
    }

    return {
      branch: wt.branch,
      iters,
      accepted,
      rejected,
      baselineObjective: baseline.best.objective,
      finalObjective: best.objective,
      costUsd: cum,
      commits,
      records,
    };
  } finally {
    await wt.dispose();
  }
}

// --- internals --------------------------------------------------------------

async function scoreBaseline(
  wt: Worktree,
  opts: OptimizeOptions,
): Promise<{ best: Best; costUsd: number }> {
  const fit = opts.program.fitness;
  const train = await opts.score({
    configDir: wt.configDir, scenarioDir: fit.suite, k: fit.k_confirm, kind: "confirm", iter: 0,
  });
  let costUsd = sumRealCost(train);
  let holdout: ScenarioResult[] | undefined;
  if (fit.holdout) {
    holdout = await opts.score({
      configDir: wt.configDir, scenarioDir: fit.holdout, k: fit.k_confirm, kind: "confirm", iter: 0,
    });
    costUsd += sumRealCost(holdout);
  }
  return {
    best: {
      objective: objectiveOf(train),
      cost: medianCostOf(train),
      baseline: toBaseline(train),
      ...(holdout ? { holdoutBaseline: toBaseline(holdout) } : {}),
      trainResults: train,
    },
    costUsd,
  };
}

async function commitWorktree(wt: Worktree, message: string): Promise<string> {
  await exec("git", ["-C", wt.root, "add", "-A"]);
  await exec("git", ["-C", wt.root, "commit", "-q", "-m", message]);
  const { stdout } = await exec("git", ["-C", wt.root, "rev-parse", "HEAD"]);
  return stdout.trim();
}

function initRejectCounts(): Record<RejectReason, number> {
  const counts = {} as Record<RejectReason, number>;
  for (const r of ALL_REJECT_REASONS) counts[r] = 0;
  return counts;
}

async function writeLedger(ledgerPath: string | undefined, record: IterationRecord): Promise<void> {
  if (!ledgerPath) return;
  await appendFile(ledgerPath, JSON.stringify(record) + "\n");
}
