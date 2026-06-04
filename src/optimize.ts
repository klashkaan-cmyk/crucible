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

import { appendFile } from "node:fs/promises";
import path from "node:path";
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
  commitWorktree,
  withinAllowlist,
  type Worktree,
} from "./worktree.js";
import { lintConfig, countByLevel } from "./lint.js";
import type { Program } from "./program.js";
import type { ScenarioResult } from "./types.js";

const EPS = 1e-9;

// --- injected seams ---------------------------------------------------------

export interface EditorContext {
  readonly program: Program;
  readonly iter: number;
  /** The current best's train scoring -- the source of the failures digest. */
  readonly lastSuite: ReadonlyArray<ScenarioResult>;
  /** A research hypothesis to apply, when driven by the research Ideator. */
  readonly hypothesis?: string;
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

// --- infra-error handling (auth / rate-limit) -------------------------------

export type InfraKind = "auth" | "rate-limit" | "aborted";

export class InfraError extends Error {
  readonly kind: InfraKind;
  constructor(kind: InfraKind, message: string) {
    super(message);
    this.name = "InfraError";
    this.kind = kind;
  }
}

const AUTH_RE = /not authenticated|not logged in|please run \/login|invalid api key|authentication/i;
const RATE_RE = /rate.?limit|\b429\b|overloaded|too many requests|usage limit/i;

/**
 * Classify a scored result as an infrastructure failure (not a candidate fault)
 * by inspecting trial runErrors. Auth takes priority over rate-limit. Returns
 * null for a normal run. Conservative on rate-limit -- only an explicit runError
 * is inspected, never a normal assertion failure -- to avoid the false-positive
 * rate-limit-detector trap.
 */
export function classifyInfra(results: ReadonlyArray<ScenarioResult>): InfraKind | null {
  let rate = false;
  for (const r of results) {
    for (const t of r.trials) {
      if (!t.runError) continue;
      if (AUTH_RE.test(t.runError)) return "auth";
      if (RATE_RE.test(t.runError)) rate = true;
    }
  }
  return rate ? "rate-limit" : null;
}

function ensureNoInfra(results: ReadonlyArray<ScenarioResult>): void {
  const infra = classifyInfra(results);
  if (infra) throw new InfraError(infra, `${infra} failure detected in scoring`);
}

export interface RetryOptions {
  /** Max exponential-backoff retries for rate-limit (default 5). */
  readonly maxRateRetries?: number;
  /** Max pause-and-poll cycles for auth (default 20). */
  readonly maxAuthWaits?: number;
  /** Base backoff for rate-limit, doubled each attempt (default 1000ms). */
  readonly baseBackoffMs?: number;
  /** Pause between auth polls -- a token refresh / re-login window (default 30s). */
  readonly authWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onWait?: (kind: InfraKind, attempt: number, waitMs: number) => void;
  readonly signal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a scorer so transient infra failures never reach the accept-gate: an auth
 * failure pauses and re-polls (a token can refresh or be re-logged-in mid-run --
 * see the CEO 401 auth-loop), a rate-limit backs off exponentially. Throws
 * InfraError only when retries are exhausted or aborted, so an infra blip is
 * never mistaken for a failed candidate and never burns the plateau counter.
 */
export function withRetry(score: ScoreFn, retry: RetryOptions = {}): ScoreFn {
  const maxRate = retry.maxRateRetries ?? 5;
  const maxAuth = retry.maxAuthWaits ?? 20;
  const baseBackoff = retry.baseBackoffMs ?? 1000;
  const authWait = retry.authWaitMs ?? 30_000;
  const sleep = retry.sleep ?? defaultSleep;
  return async (req) => {
    let rateAttempt = 0;
    let authAttempt = 0;
    for (;;) {
      if (retry.signal?.aborted) throw new InfraError("aborted", "aborted before scoring");
      const results = await score(req);
      const infra = classifyInfra(results);
      if (!infra) return results;
      if (infra === "auth") {
        if (authAttempt >= maxAuth) throw new InfraError("auth", "auth failure persisted after polling");
        retry.onWait?.("auth", authAttempt, authWait);
        await sleep(authWait);
        authAttempt += 1;
      } else {
        if (rateAttempt >= maxRate) throw new InfraError("rate-limit", "rate limit persisted after backoff");
        const waitMs = baseBackoff * 2 ** rateAttempt;
        retry.onWait?.("rate-limit", rateAttempt, waitMs);
        await sleep(waitMs);
        rateAttempt += 1;
      }
    }
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
  /**
   * Re-score the current best every N accepted candidates so the bar does not
   * drift on a single noisy baseline snapshot. Off when unset.
   */
  readonly remeasureEvery?: number;
  /**
   * Resume a prior run: check out the existing branch at its tip instead of
   * resetting it, so the accepted-candidate lineage and the ledger continue.
   */
  readonly resume?: boolean;
  /**
   * Evaluate and report would-accepts but never commit or advance the best, so
   * history is untouched. Each candidate is judged against the same baseline.
   */
  readonly dryRun?: boolean;
  /**
   * Absolute path to a `.credentials.json` to seed into each scoring worktree so
   * headless claude can authenticate there. Needed when the config under test is
   * a git repo whose credentials are (correctly) untracked. Ignored when claude
   * authenticates via ANTHROPIC_API_KEY instead.
   */
  readonly credentialsPath?: string;
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
export interface Best {
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

export interface CandidateEvaluation {
  readonly verdict: Verdict;
  readonly changedFiles: ReadonlyArray<string>;
  readonly editorMessage: string;
  /** Editor + all trial cost spent evaluating this candidate. */
  readonly costUsd: number;
  /** Confirm-level train scores; present once a candidate reaches confirm. */
  readonly train?: ReadonlyArray<ScenarioResult>;
  readonly holdout?: ReadonlyArray<ScenarioResult>;
  /** Set when the verdict is run-error, so the caller can stop on 'aborted'. */
  readonly infraKind?: InfraKind;
}

export interface EvaluateContext {
  readonly wt: Worktree;
  readonly best: Best;
  readonly program: Program;
  readonly editor: EditorFn;
  readonly score: ScoreFn;
  readonly iter: number;
  /** A research hypothesis passed through to the editor, when present. */
  readonly hypothesis?: string;
}

/**
 * Evaluate ONE candidate: reset the worktree, let the editor mutate it, guard the
 * scope + lint, screen cheaply, confirm (train + safety), gate, and check the
 * holdout -- returning a verdict and the scores WITHOUT committing. The keep
 * decision is the caller's policy (optimize keeps greedily; research's beam keeps
 * a population). Infra failures are caught and returned as a run-error verdict so
 * the caller never mistakes them for a candidate fault.
 */
export async function evaluateCandidate(ctx: EvaluateContext): Promise<CandidateEvaluation> {
  const { wt, best, program, editor, score, iter } = ctx;
  const fit = program.fitness;
  const reject = (reason: RejectReason, detail: string): Verdict => ({ kind: "reject", reason, detail });

  await resetWorktree(wt);
  const edit = await editor(wt, {
    program,
    iter,
    lastSuite: best.trainResults,
    ...(ctx.hypothesis ? { hypothesis: ctx.hypothesis } : {}),
  });
  let cost = edit.costUsd;
  const scope = await gitChangedFiles(wt);
  const base = { changedFiles: scope, editorMessage: edit.message };

  if (scope.length === 0) {
    return { verdict: reject("no-op", "editor changed nothing"), costUsd: cost, ...base };
  }
  if (!withinAllowlist(scope, program.mutableSurface)) {
    const offending = scope.find((f) => !withinAllowlist([f], program.mutableSurface)) ?? scope[0]!;
    return { verdict: reject("out-of-scope-edit", offending), costUsd: cost, ...base };
  }
  const lint = await lintConfig(wt.configDir);
  if (countByLevel(lint).error > 0) {
    const firstError = lint.find((f) => f.level === "error");
    return { verdict: reject("lint-error", firstError?.message ?? "lint error"), costUsd: cost, ...base };
  }

  try {
    const screen = await score({ configDir: wt.configDir, scenarioDir: fit.suite, k: fit.k_screen, kind: "screen", iter });
    ensureNoInfra(screen);
    cost += sumRealCost(screen);
    if (!promising(screen, best)) {
      return { verdict: reject("insufficient-gain", "below best on cheap screen"), costUsd: cost, ...base };
    }

    const cand = await score({ configDir: wt.configDir, scenarioDir: fit.suite, k: fit.k_confirm, kind: "confirm", iter });
    ensureNoInfra(cand);
    const safety = fit.safety
      ? await score({ configDir: wt.configDir, scenarioDir: fit.safety, k: fit.k_confirm, kind: "confirm", iter })
      : [];
    ensureNoInfra(safety);
    cost += sumRealCost(cand) + sumRealCost(safety);

    const verdict = decide(cand, safety, best, program);
    if (verdict.kind === "reject") {
      return { verdict, costUsd: cost, train: cand, ...base };
    }

    let holdout: ScenarioResult[] | undefined;
    if (fit.holdout) {
      holdout = await score({ configDir: wt.configDir, scenarioDir: fit.holdout, k: fit.k_confirm, kind: "confirm", iter });
      ensureNoInfra(holdout);
      cost += sumRealCost(holdout);
      if (fit.accept.holdout_no_regression && best.holdoutBaseline) {
        const hr = diffAgainstBaseline(holdout, best.holdoutBaseline, {
          passRateDrop: 0,
          costIncrease: fit.accept.cost_tolerance,
        });
        if (hr.length > 0) {
          return { verdict: reject("holdout-regression", hr[0]!.detail), costUsd: cost, train: cand, holdout, ...base };
        }
      }
    }
    return { verdict, costUsd: cost, train: cand, ...(holdout ? { holdout } : {}), ...base };
  } catch (err: unknown) {
    if (err instanceof InfraError) {
      return { verdict: reject("run-error", `${err.kind}: ${err.message}`), costUsd: cost, infraKind: err.kind, ...base };
    }
    throw err;
  }
}

/**
 * A markdown summary of a run for the PR review gate. Pure. Crucible NEVER merges
 * -- this is the artifact a human reviews before merging the branch themselves.
 */
export function optimizeMarkdown(summary: OptimizeSummary): string {
  const delta = summary.finalObjective - summary.baselineObjective;
  const rej =
    ALL_REJECT_REASONS.filter((r) => summary.rejected[r] > 0)
      .map((r) => `${r}: ${summary.rejected[r]}`)
      .join(", ") || "none";
  return [
    "<!-- crucible-optimize -->",
    `**Crucible optimize** — branch \`${summary.branch}\``,
    "",
    `- objective: ${summary.baselineObjective.toFixed(3)} → ${summary.finalObjective.toFixed(3)} (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`,
    `- accepted: ${summary.accepted} / ${summary.iters} iteration(s)`,
    `- rejected: ${rej}`,
    `- cost: ~$${summary.costUsd.toFixed(4)}`,
    "",
    summary.commits.length > 0
      ? `Lineage: ${summary.commits.length} commit(s) on \`${summary.branch}\`. Review and merge it yourself — Crucible never merges for you.`
      : "No candidate was accepted.",
  ].join("\n");
}

// --- the loop ---------------------------------------------------------------

export async function optimize(opts: OptimizeOptions): Promise<OptimizeSummary> {
  const repo = await resolveConfigRepo(opts.configDir);
  const seed = opts.credentialsPath
    ? [{ from: opts.credentialsPath, to: path.join(repo.relConfig, ".credentials.json") }]
    : [];
  const wt = await openWorktree(repo, opts.branch, { reset: !opts.resume, seed });
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

      const ev = await evaluateCandidate({
        wt, best, program: opts.program, editor: opts.editor, score: opts.score, iter,
      });
      cum += ev.costUsd;
      const verdict = ev.verdict;

      const record = async (v: Verdict, commit?: string): Promise<void> => {
        const rec: IterationRecord = {
          iter,
          verdict: v,
          changedFiles: ev.changedFiles,
          editorMessage: ev.editorMessage,
          costUsd: ev.costUsd,
          cumCostUsd: cum,
          ...(commit ? { commit } : {}),
        };
        records.push(rec);
        if (v.kind === "reject") {
          rejected[v.reason] += 1;
          // Infra failures (run-error) are not the candidate's fault -- they must
          // not advance the plateau counter toward a false "converged".
          if (v.reason !== "run-error") plateau += 1;
        }
        await writeLedger(opts.ledgerPath, rec);
      };

      if (verdict.kind === "reject") {
        await record(verdict);
        // Infra failure: stop only if the run itself was aborted.
        if (ev.infraKind === "aborted" || opts.signal?.aborted) break;
        continue;
      }

      // ACCEPT. In dry-run, report the would-accept but never commit or advance.
      if (opts.dryRun) {
        accepted += 1;
        plateau = 0;
        await record(verdict);
        continue;
      }
      const cand = ev.train ?? []; // an accepted candidate always carries confirm scores
      const commit = await commitWorktree(wt, `optimize: iter ${iter} (+${verdict.gain.toFixed(3)})`);
      commits.push(commit);
      best = {
        objective: verdict.objective,
        cost: medianCostOf(cand),
        baseline: toBaseline(cand),
        holdoutBaseline: ev.holdout ? toBaseline(ev.holdout) : best.holdoutBaseline,
        trainResults: cand,
      };
      accepted += 1;
      plateau = 0;
      await record(verdict, commit);

      // RE-MEASURE the best periodically so the bar does not drift on a single
      // noisy snapshot. Re-scores the just-committed tip.
      if (opts.remeasureEvery && accepted % opts.remeasureEvery === 0) {
        const re = await scoreBaseline(wt, opts, iter);
        best = re.best;
        cum += re.costUsd;
      }
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
  iter = 0,
): Promise<{ best: Best; costUsd: number }> {
  const fit = opts.program.fitness;
  const train = await opts.score({
    configDir: wt.configDir, scenarioDir: fit.suite, k: fit.k_confirm, kind: "confirm", iter,
  });
  ensureNoInfra(train);
  let costUsd = sumRealCost(train);
  let holdout: ScenarioResult[] | undefined;
  if (fit.holdout) {
    holdout = await opts.score({
      configDir: wt.configDir, scenarioDir: fit.holdout, k: fit.k_confirm, kind: "confirm", iter,
    });
    ensureNoInfra(holdout);
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

function initRejectCounts(): Record<RejectReason, number> {
  const counts = {} as Record<RejectReason, number>;
  for (const r of ALL_REJECT_REASONS) counts[r] = 0;
  return counts;
}

async function writeLedger(ledgerPath: string | undefined, record: IterationRecord): Promise<void> {
  if (!ledgerPath) return;
  await appendFile(ledgerPath, JSON.stringify(record) + "\n");
}
