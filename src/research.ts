/**
 * `crucible research` -- the open-ended autoresearch loop on top of optimize.
 *
 * This skeleton is the POPULATION SEARCH: a beam of config lineages (each its own
 * git branch) that explores instead of greedily hill-climbing. Each round an
 * Ideator proposes hypotheses, each is forked off its parent beam member and run
 * through evaluateCandidate (the optimize seam); accepted forks become candidate
 * members, and selectBeam keeps the top-B by objective WITH diversity pressure so
 * the beam never collapses into duplicates and can hold a worse-but-novel branch.
 *
 * The Ideator, editor, and scorer are injected so the whole search is offline-
 * testable. The frontier expander, Reflector, novelty guard, and canary land in
 * later steps; here the Ideator is a stub and the frontier is fixed.
 *
 * selectBeam ranks by the scalar objective for now; a Pareto front is the
 * follow-up (see docs/research-spec.md).
 */

import { appendFile } from "node:fs/promises";
import { resolveConfigRepo } from "./bisect.js";
import { openWorktree, commitWorktree, deleteBranch } from "./worktree.js";
import { evaluateCandidate, objectiveOf, type Best } from "./optimize.js";
import { toBaseline } from "./baseline.js";
import { median } from "./stats.js";
import { configFingerprint } from "./suite.js";
import type { EditorFn, ScoreFn, Verdict } from "./optimize.js";
import type { Program } from "./program.js";
import type { ScenarioResult } from "./types.js";

// --- types ------------------------------------------------------------------

export type HypothesisStatus = "proposed" | "tried" | "held" | "failed" | "duplicate";

export interface Hypothesis {
  readonly id: string;
  /** Index into the current beam this idea forks from. */
  readonly parentBeam: number;
  /** The idea, handed to the editor verbatim. */
  readonly rationale: string;
  readonly round?: number;
  readonly status?: HypothesisStatus;
  /** The Reflector's one-line note on why it held or failed. */
  readonly learning?: string;
}

/**
 * Propose hypotheses for the round, given the current beam and the backlog of
 * everything tried so far (so it does not re-propose dead ends). Stub in tests;
 * LLM-backed via makeIdeator.
 */
export type IdeatorFn = (
  beam: ReadonlyArray<BeamMember>,
  round: number,
  backlog: ReadonlyArray<Hypothesis>,
) => Promise<Hypothesis[]>;

export interface BeamMember {
  readonly branch: string;
  readonly best: Best;
  readonly objective: number;
  /** Config fingerprint for diversity pressure. */
  readonly noveltyHash: string;
  /** Accepted commit shas from the seed to this member. */
  readonly lineage: ReadonlyArray<string>;
}

export interface ResearchOptions {
  readonly configDir: string;
  readonly program: Program;
  readonly editor: EditorFn;
  readonly score: ScoreFn;
  readonly ideator: IdeatorFn;
  readonly beamWidth: number;
  readonly maxRounds: number;
  readonly diversityFloor: number;
  /** Stable id for branch naming (no Date in core; caller supplies it). */
  readonly runId: string;
  readonly budgetUsd: number;
  readonly ledgerPath?: string;
  /** Append the research journal (markdown) here. */
  readonly journalPath?: string;
  /** Append every tried/duplicate hypothesis as JSONL here (the idea backlog). */
  readonly ideasPath?: string;
  /** Jaccard similarity at/above which a new idea is a duplicate (default 0.8). */
  readonly noveltyThreshold?: number;
  readonly signal?: AbortSignal;
}

export interface RoundRecord {
  readonly round: number;
  readonly hypotheses: number;
  readonly deduped: number;
  readonly accepted: number;
  readonly beam: ReadonlyArray<{ branch: string; objective: number }>;
  readonly bestObjective: number;
  readonly cumCostUsd: number;
}

// --- novelty guard + reflector (pure) ---------------------------------------

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Novelty guard: drop hypotheses too lexically similar to anything in the backlog
 * (or earlier in the same batch). Prevents the Ideator from re-proposing the same
 * idea forever -- the research analog of a thrash loop. Pure.
 */
export function dropDuplicates(
  proposed: ReadonlyArray<Hypothesis>,
  backlog: ReadonlyArray<Hypothesis>,
  threshold = 0.8,
): { fresh: Hypothesis[]; duplicates: Hypothesis[] } {
  const fresh: Hypothesis[] = [];
  const duplicates: Hypothesis[] = [];
  const seen = backlog.map((h) => tokenize(h.rationale));
  for (const h of proposed) {
    const t = tokenize(h.rationale);
    if (seen.some((s) => jaccard(t, s) >= threshold)) {
      duplicates.push({ ...h, status: "duplicate" });
    } else {
      fresh.push(h);
      seen.push(t);
    }
  }
  return { fresh, duplicates };
}

export interface TriedHypothesis {
  readonly hypothesis: Hypothesis;
  readonly verdict: Verdict;
}

export interface Reflection {
  /** The tried hypotheses with held/failed status + a one-line learning. */
  readonly reflected: Hypothesis[];
  /** A markdown block summarizing the round for the journal. */
  readonly journal: string;
}

/**
 * Reflector: turn a round's outcomes into held/failed learnings + a journal
 * block, which feed back into the Ideator's backlog so research compounds instead
 * of thrashing. Deterministic from the verdicts (no model call needed). Pure.
 */
export function reflect(
  round: number,
  tried: ReadonlyArray<TriedHypothesis>,
  bestObjective: number,
): Reflection {
  const reflected: Hypothesis[] = tried.map(({ hypothesis, verdict }) =>
    verdict.kind === "accept"
      ? { ...hypothesis, round, status: "held", learning: `held: objective +${verdict.gain.toFixed(3)}` }
      : { ...hypothesis, round, status: "failed", learning: `failed: ${verdict.reason} (${verdict.detail})` },
  );
  const held = reflected.filter((h) => h.status === "held").length;
  const lines = [
    `## Round ${round} — best objective ${bestObjective.toFixed(3)} (${held}/${tried.length} held)`,
    "",
    ...reflected.map((h) => `- [${h.status}] ${h.rationale} — ${h.learning}`),
    "",
  ];
  return { reflected, journal: lines.join("\n") };
}

export interface ResearchSummary {
  readonly rounds: number;
  readonly bestBranch: string;
  readonly bestObjective: number;
  readonly baselineObjective: number;
  readonly costUsd: number;
  readonly beam: ReadonlyArray<{ branch: string; objective: number; lineage: number }>;
  readonly records: ReadonlyArray<RoundRecord>;
}

// --- beam selection (pure) --------------------------------------------------

/** Fraction of differing characters between two fingerprints, in [0, 1]. */
export function noveltyDistance(a: string, b: string): number {
  if (a === b) return 0;
  const len = Math.max(a.length, b.length, 1);
  let diff = Math.abs(a.length - b.length);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff += 1;
  return Math.min(1, diff / len);
}

function minDistance(m: BeamMember, others: ReadonlyArray<BeamMember>): number {
  if (others.length === 0) return 1;
  return Math.min(...others.map((o) => noveltyDistance(m.noveltyHash, o.noveltyHash)));
}

/**
 * Choose the next beam: best first, then fill by objective but only with members
 * distinct enough (>= diversityFloor) from those already picked, so the beam
 * never collapses into near-duplicates. When the beam is full, the final slot is
 * handed to the most-novel remaining member -- the exploratory slot that lets the
 * search escape a local optimum. Pure.
 */
export function selectBeam(
  members: ReadonlyArray<BeamMember>,
  beamWidth: number,
  diversityFloor: number,
): BeamMember[] {
  if (members.length === 0 || beamWidth <= 0) return [];
  const ranked = [...members].sort((a, b) => b.objective - a.objective);
  const picked: BeamMember[] = [ranked[0]!]; // always keep the best
  for (const m of ranked.slice(1)) {
    if (picked.length >= beamWidth) break;
    if (minDistance(m, picked) >= diversityFloor) picked.push(m);
  }
  // Reserve the final slot for the most-novel non-core member.
  if (picked.length === beamWidth && beamWidth > 1) {
    const core = picked.slice(0, beamWidth - 1);
    let novel: BeamMember | null = null;
    let bestD = -1;
    for (const m of ranked) {
      if (core.includes(m)) continue;
      const d = minDistance(m, core);
      if (d > bestD) {
        bestD = d;
        novel = m;
      }
    }
    if (novel) picked[beamWidth - 1] = novel;
  }
  return picked;
}

// --- the loop ---------------------------------------------------------------

export async function research(opts: ResearchOptions): Promise<ResearchSummary> {
  const repo = await resolveConfigRepo(opts.configDir);
  const records: RoundRecord[] = [];
  let cum = 0;

  const seed = await seedMember(repo, `research/${opts.runId}/seed`, opts);
  cum += seed.costUsd;
  let beam: BeamMember[] = [seed.member];
  const baselineObjective = seed.member.objective;
  const backlog: Hypothesis[] = [];

  for (let round = 1; round <= opts.maxRounds; round++) {
    if (opts.signal?.aborted) break;
    if (cum >= opts.budgetUsd) break;

    const proposed = await opts.ideator(beam, round, backlog);
    const { fresh, duplicates } = dropDuplicates(proposed, backlog, opts.noveltyThreshold ?? 0.8);
    const candidates: BeamMember[] = [];
    const tried: TriedHypothesis[] = [];
    let accepted = 0;

    for (let i = 0; i < fresh.length; i++) {
      const idea = fresh[i]!;
      const parent = beam[idea.parentBeam] ?? beam[0]!;
      const branch = `research/${opts.runId}/r${round}-c${i}`;
      const wt = await openWorktree(repo, branch, { reset: true, from: parent.branch });
      try {
        const ev = await evaluateCandidate({
          wt,
          best: parent.best,
          program: opts.program,
          editor: opts.editor,
          score: opts.score,
          iter: round,
          hypothesis: idea.rationale,
        });
        cum += ev.costUsd;
        tried.push({ hypothesis: idea, verdict: ev.verdict });
        if (ev.verdict.kind === "accept") {
          const commit = await commitWorktree(wt, `research: r${round} c${i} (+${ev.verdict.gain.toFixed(3)})`);
          const train = ev.train ?? [];
          candidates.push({
            branch,
            best: {
              objective: ev.verdict.objective,
              cost: median(train.map((r) => r.medianCostUsd)),
              baseline: toBaseline(train),
              ...(ev.holdout ? { holdoutBaseline: toBaseline(ev.holdout) } : parent.best.holdoutBaseline ? { holdoutBaseline: parent.best.holdoutBaseline } : {}),
              trainResults: train,
            },
            objective: ev.verdict.objective,
            noveltyHash: (await configFingerprint(wt.configDir)) ?? commit,
            lineage: [...parent.lineage, commit],
          });
          accepted += 1;
        } else {
          await deleteBranch(repo, branch); // prune the rejected fork
        }
      } finally {
        await wt.dispose();
      }
    }

    beam = selectBeam([...beam, ...candidates], opts.beamWidth, opts.diversityFloor);
    const bestObjective = Math.max(...beam.map((m) => m.objective));

    // Reflect: record learnings, feed the backlog, append the journal.
    const { reflected, journal } = reflect(round, tried, bestObjective);
    backlog.push(...reflected, ...duplicates);
    if (opts.journalPath) await appendFile(opts.journalPath, journal + "\n");
    if (opts.ideasPath) {
      for (const h of [...reflected, ...duplicates]) {
        await appendFile(opts.ideasPath, JSON.stringify(h) + "\n");
      }
    }

    const rec: RoundRecord = {
      round,
      hypotheses: proposed.length,
      deduped: duplicates.length,
      accepted,
      beam: beam.map((m) => ({ branch: m.branch, objective: m.objective })),
      bestObjective,
      cumCostUsd: cum,
    };
    records.push(rec);
    await writeLedger(opts.ledgerPath, rec);
  }

  const best = beam.reduce((a, b) => (b.objective > a.objective ? b : a), beam[0]!);
  return {
    rounds: records.length,
    bestBranch: best.branch,
    bestObjective: best.objective,
    baselineObjective,
    costUsd: cum,
    beam: beam.map((m) => ({ branch: m.branch, objective: m.objective, lineage: m.lineage.length })),
    records,
  };
}

// --- internals --------------------------------------------------------------

async function seedMember(
  repo: Awaited<ReturnType<typeof resolveConfigRepo>>,
  branch: string,
  opts: ResearchOptions,
): Promise<{ member: BeamMember; costUsd: number }> {
  const fit = opts.program.fitness;
  const wt = await openWorktree(repo, branch, { reset: true });
  try {
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
    const member: BeamMember = {
      branch,
      best: {
        objective: objectiveOf(train),
        cost: median(train.map((r) => r.medianCostUsd)),
        baseline: toBaseline(train),
        ...(holdout ? { holdoutBaseline: toBaseline(holdout) } : {}),
        trainResults: train,
      },
      objective: objectiveOf(train),
      noveltyHash: (await configFingerprint(wt.configDir)) ?? branch,
      lineage: [],
    };
    return { member, costUsd };
  } finally {
    await wt.dispose();
  }
}

function sumRealCost(results: ReadonlyArray<ScenarioResult>): number {
  let total = 0;
  for (const r of results) for (const t of r.trials) total += t.costUsd;
  return total;
}

async function writeLedger(ledgerPath: string | undefined, record: RoundRecord): Promise<void> {
  if (!ledgerPath) return;
  await appendFile(ledgerPath, JSON.stringify(record) + "\n");
}
