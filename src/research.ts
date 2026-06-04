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
import type { EditorFn, ScoreFn } from "./optimize.js";
import type { Program } from "./program.js";
import type { ScenarioResult } from "./types.js";

// --- types ------------------------------------------------------------------

export interface Hypothesis {
  readonly id: string;
  /** Index into the current beam this idea forks from. */
  readonly parentBeam: number;
  /** The idea, handed to the editor verbatim. */
  readonly rationale: string;
}

/** Propose hypotheses for the round. Stub in this step; LLM-backed later. */
export type IdeatorFn = (
  beam: ReadonlyArray<BeamMember>,
  round: number,
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
  readonly signal?: AbortSignal;
}

export interface RoundRecord {
  readonly round: number;
  readonly hypotheses: number;
  readonly accepted: number;
  readonly beam: ReadonlyArray<{ branch: string; objective: number }>;
  readonly bestObjective: number;
  readonly cumCostUsd: number;
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

  for (let round = 1; round <= opts.maxRounds; round++) {
    if (opts.signal?.aborted) break;
    if (cum >= opts.budgetUsd) break;

    const ideas = await opts.ideator(beam, round);
    const candidates: BeamMember[] = [];
    let accepted = 0;

    for (let i = 0; i < ideas.length; i++) {
      const idea = ideas[i]!;
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
    const rec: RoundRecord = {
      round,
      hypotheses: ideas.length,
      accepted,
      beam: beam.map((m) => ({ branch: m.branch, objective: m.objective })),
      bestObjective: Math.max(...beam.map((m) => m.objective)),
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
