# `crucible research` -- the autoresearch loop on top of `optimize`

Status: design. Target: `src/research.ts`, `crucible research` CLI. Builds on
[`optimize-spec.md`](./optimize-spec.md).

## Why this exists

`crucible optimize` is autonomous *optimization*: a gated hill-climb against a
frozen scenario suite. It tops out at 100% and stops. That is not autoresearch.

autoresearch (in the karpathy sense) is open-ended: the agent *invents* what to
try, the metric is general (never "solved"), and the agent keeps exploring. This
spec adds the three things `optimize` lacks:

- ideas (hypothesis generation),
- a moving frontier (self-expanding eval),
- exploration (a beam of lineages, not one greedy line).

`optimize` becomes a primitive. Its mutate->score->gate cycle is refactored into
`evaluateCandidate()` -- "given a config and an idea, produce a scored, gated
candidate." `research` is the open-ended loop around it.

```
            +---------------- research.ts (open-ended) ----------------+
            |  Ideator -> Beam(evaluateCandidate xB) -> Reflector/Journal |
            |       ^              |                         |          |
            |   idea backlog   Frontier expander <-----------+          |
            |   + journal      (grows train/holdout)                    |
            +-----------------------------------------------------------+
                                    | evaluateCandidate()  (= optimize core)
                                    v
                       worktree . runSuite . accept-gate
```

## New artifacts (the research "memory")

Under `.crucible/research/<run>/`:

- `ideas.jsonl` -- the hypothesis backlog; every idea ever proposed + outcome.
- `journal.md` -- human-readable research log (autoresearch's "wake up to a log").
- beam branches -- `research/<run>/beam-{0..B}`, one git lineage per member.
- `frontier/` -- the grown scenario set: `train/`, `holdout/`, and a frozen
  `canary/` (see Trust). Seeded from the existing `crucible/` suite.

## Types (`src/research.ts`)

```ts
export interface Hypothesis {
  readonly id: string;
  readonly round: number;
  readonly rationale: string;        // the research idea, in the agent's words
  readonly targets: ReadonlyArray<string>;  // files it expects to change (subset of allowlist)
  readonly predictedEffect: string;
  readonly parentBeam: number;       // which lineage it forks from
  readonly status: "proposed" | "tried" | "held" | "failed" | "duplicate";
  readonly verdict?: Verdict;        // from evaluateCandidate, once tried
  readonly learning?: string;        // Reflector's note on why it held/failed
}

export interface BeamMember {
  readonly branch: string;
  readonly objective: number;        // on current train frontier
  readonly canaryObjective: number;  // on the frozen north-star (never expanded)
  readonly baseline: Baseline;       // its scored snapshot, for diffAgainstBaseline
  readonly lineage: ReadonlyArray<string>;  // accepted commits
  readonly noveltyHash: string;      // config fingerprint for diversity pressure
}

export interface ResearchOptions extends OptimizeOptions {
  readonly beamWidth: number;            // B population members (default 3)
  readonly ideasPerRound: number;        // K hypotheses/round (default beamWidth*2)
  readonly maxRounds: number;
  readonly expandEvery: number;          // frontier-expand cadence (rounds)
  readonly saturationThreshold: number;  // expand early if objective >= this (e.g. 0.95)
  readonly ideatorModel?: string;
  readonly canaryDir: string;            // frozen, human-curated north-star suite
}

export interface RoundRecord {
  readonly round: number;
  readonly hypotheses: ReadonlyArray<Hypothesis>;
  readonly beam: ReadonlyArray<BeamMember>;
  readonly frontierSize: { train: number; holdout: number };
  readonly expanded: boolean;
  readonly journalEntry: string;
  readonly cumCostUsd: number;
}
```

## The loop

```
async function research(opts: ResearchOptions): Promise<ResearchSummary> {
  repo     = await resolveConfigRepo(opts.configDir)
  frontier = await seedFrontier(opts)                 // copy crucible/ -> train/holdout/canary
  beam     = [ await seedMember(repo, opts, frontier) ]   // 1 lineage = current config
  backlog  = []
  let cum = 0

  for (round = 1; round <= opts.maxRounds; round++) {
    if (opts.signal?.aborted || cum >= opts.budgetUsd) break

    // 1. IDEATE -- propose K hypotheses across the beam, deduped against backlog
    ideas = await ideate(beam, frontier, backlog, opts)        // LLM, tool-free
    ideas = await dropDuplicates(ideas, backlog, opts)         // novelty guard

    // 2. EXPLORE -- evaluate each idea as a fork of its parent beam member.
    //    This IS optimize's evaluateCandidate, but we DON'T greedily revert:
    //    every scored fork is a candidate lineage, kept or pruned by the beam.
    forks = await parallelBounded(ideas, opts.concurrency, idea =>
              evaluateCandidate(repo, beamBranchOf(idea.parentBeam), idea, frontier, opts))
    cum += sumCost(forks)

    // 3. SELECT -- new beam = top-B by objective AND diversity (not pure greedy)
    beam = selectBeam([...beam, ...forks.filter(f => f.gated)], opts)

    // 4. EXPAND FRONTIER -- when train saturates or on cadence, grow the eval
    if (round % opts.expandEvery === 0 || maxObjective(beam) >= opts.saturationThreshold) {
      const added = await expandFrontier(frontier, beam, opts)   // generate + validate
      frontier = added.frontier
      beam = await rescoreBeam(beam, frontier, opts)             // objectives shift; re-rank
    }

    // 5. REFLECT -- judge which hypotheses held, write the journal, feed backlog
    backlog = await reflect(round, ideas, forks, beam, backlog, opts)

    // 6. TRUST CHECK -- score the frozen canary; if it regresses while train climbs,
    //    the whole research process is overfitting its own grown eval -> alert/halt
    if (await canaryRegressed(beam, opts)) { alert("autoresearch overfit"); break }

    record(round, ...)
  }
  return summarize(beam, backlog, frontier, opts)
}
```

## The four new components

### 1. Ideator (`ideate`) -- the hypothesis stage

Tool-free `runHeadlessText` call (model = `ideatorModel`) whose prompt is:
- PROGRAM.md `## Objective` + `## Constraints` prose,
- `summarizeConfig(beamMember.configDir)` -- what the config currently is,
- the failure signal: `explain()` output for the lowest-scoring scenarios on that
  member (reuses `src/explain.ts`),
- the backlog digest: ideas already tried and whether they held.

Output is structured (`Hypothesis[]`). One Ideator call per beam member, so
different lineages explore different directions. This is the difference from
`optimize`'s reactive editor -- the Ideator reasons about what is worth trying
next, including directions no scenario is currently failing.

**Meta-agent pinning (required, same rule as optimize-spec):** the Ideator,
Reflector, and judge run on a **frozen reference config**, never a candidate. The
mutable surface can never include what these meta-agents use, or a lineage could
win by editing the brain that proposes/grades it. Asserted by test, not left to
the host-env default.

### 2. Beam search (`selectBeam`) -- exploration, not greedy

`optimize` reverts anything not immediately better. `research` keeps a population.
After scoring, the new beam is top-B by objective with diversity pressure so it
doesn't collapse into B copies of one config:

```
selectBeam(members, opts):
  ranked = members.sort(byObjective desc)
  picked = [ranked[0]]                              // always keep the best
  for m in ranked[1:]:
    if picked.length >= opts.beamWidth: break
    if minDistanceTo(m, picked) >= DIVERSITY_FLOOR: // distinct enough (configFingerprint diff)
      picked.push(m)
  if picked.length == opts.beamWidth:               // reserve a slot for the most-novel member
    picked[last] = mostNovel(ranked, picked)        // -> escapes local optima
  return picked
```

This is what lets it hold a "worse now, promising later" branch -- the thing
greedy gating structurally cannot do.

**Pareto option:** ranking by scalar objective collapses a multi-objective space
(pass-rate, cost, turns). The fuller `selectBeam` keeps the **Pareto front** --
no member is dominated on all axes -- then fills remaining slots by novelty. This
is where the multi-objective handling the optimize gate punts on actually lives;
scalar ranking is the v1, Pareto is the upgrade and the beam is the natural place
for it.

### 3. Frontier expander (`expandFrontier`) -- self-expanding eval

Fix for objective saturation (the step-function floor). Two generators:
- Deterministic -- `renderScenarios(summarizeConfig(...))` (existing) covers any
  new subagents/skills the config grew. Free, no tokens.
- Adversarial -- a new `synthesizeScenarios()` (LLM via `runHeadlessText`) that
  targets near-misses: scenarios passing with low margin or high variance, plus
  the PROGRAM objective. Proposes harder variants.

Every generated scenario is validated before it joins the frontier, or you wedge
the loop with impossible/trivial tests:
- must parse (`loadScenario`),
- must be discriminating: passes on a known-good reference but fails on a
  weakened reference -- if it passes on both or neither, it carries no signal,
  discard it. The two references are defined concretely, not hand-waved:
  - **good reference** = the run's *seed* config (the `.claude` at round 0),
  - **weakened reference** = an empty/minimal config (no subagents, bare
    `CLAUDE.md`) -- materialized once and cached.
  A scenario that the good config passes and the empty config fails is, by
  construction, measuring something the config actually provides.
- a fixed fraction routes to holdout (editor never sees it).

New scenarios are committed, so the frontier is versioned and bisectable.

### 4. Reflector + journal (`reflect`) -- research output, and memory

After each round, a tool-free LLM reads (hypothesis, its `Verdict`, before/after
scores) and writes a one-line learning per idea. These:
- update `ideas.jsonl` status (`held`/`failed`/`duplicate`),
- append a round entry to `journal.md` (the artifact you read in the morning),
- become the backlog memory fed back to the Ideator -- so research compounds
  instead of thrashing.

Novelty guard (`dropDuplicates`): an LLM similarity check rejects hypotheses
near-identical to backlog entries. Without it, autonomous ideation degenerates
into proposing the same idea forever.

## Trust: the canary (why a self-expanding eval is safe)

A self-growing eval can drift anywhere. The guard is a frozen canary suite:
small, human-curated, never expanded, never shown to the Ideator or editor, never
used as the optimization objective. Scored only at round boundaries as the
north-star. If train objective climbs while canary drops, the entire research
process is overfitting its own grown eval -- that is the halt-and-alert condition
(step 6). This is the one piece you cannot generate; it is the human-defined
definition of "actually better," and it is what makes open-ended autoresearch
trustworthy rather than a Goodhart machine.

## PROGRAM.md additions

```markdown
## Research                <!-- parsed: the open-ended layer -->
beam_width:     3
ideas_per_round: 6
max_rounds:     40
expand_every:   5          # grow the frontier every N rounds
saturation:     0.95       # ...or early when train objective hits this
canary:         crucible/canary    # frozen north-star, never grown/shown
diversity_floor: 0.15      # min config distance between beam members
exploration:    "Favor tightening descriptions and checklists over adding tools.
                 Risky structural changes are allowed in the exploratory beam slot."
```

`## Objective`, `## Constraints`, `## Mutable surface`, `## Fitness` from
optimize-spec are unchanged and reused.

## CLI

```
crucible research \
  --config .claude --program PROGRAM.md \
  --canary crucible/canary \
  --budget-usd 60 --max-rounds 40 --beam 3 \
  --ledger .crucible/research/run1 \
  [--ideator-model opus] [--judge-model haiku] [--concurrency 1]
```

Exit non-zero if the best lineage's canary objective ends below where it started
(research made it worse on the north-star). Output: the winning beam branch as a
**pull request** (reuse `prcomment.ts`) with the canary/train deltas + journal as
the review body -- **never auto-merged**; a human merges. Plus `journal.md` and
idea-success-rate stats. Front it with `token-watch.sh` AUTO_PAUSE on the
`AbortSignal` -- research is the most token-hungry mode.

### Cost surface and concurrency (size it honestly)

Research spends on far more than trials: Ideator (xB), every fork's screen +
confirm trials, judge assertions, Reflector, frontier synthesis, and canary
scoring each round. The budget must sum **all** of them. Concurrency is the sharp
edge: a round evaluates `B` forks, each `k_screen x |train|` calls, so peak
in-flight is `B x k_screen x |train|`. The `--concurrency` cap must be set with
beam width folded in, or research will saturate rate limits instantly. Default
`B=3, concurrency=1` (serial forks) for cost-sensitive runs; raise only with
headroom. Every candidate costs real tokens -- cassettes cannot score behavior
the config just changed (see optimize-spec, "Cost & determinism"); they only
cheapen re-measuring the unchanged best/canary baselines.

## Research-specific failure modes (and the guard for each)

| Pathology | Guard |
|---|---|
| Idea collapse (same hypothesis forever) | novelty guard + backlog memory in the Ideator prompt |
| Beam degeneration (B copies of one config) | diversity floor + reserved exploratory slot in `selectBeam` |
| Frontier gaming (expander emits easy tests) | discriminating-power validation; fraction to holdout |
| Goodhart on the grown eval | frozen canary, scored every round, halts on divergence |
| Lineage edits its own grader | meta-agent pinning: Ideator/judge/Reflector on a frozen reference config, outside the mutable surface |
| Scalar objective hides a cost/turn regression | Pareto front in `selectBeam` (no member dominated on all axes) |
| Impossible generated scenarios wedge the loop | validate-before-admit (`loadScenario` + reference run) |
| Unbounded cost (open-ended is not free) | hard `--budget-usd`, per-round accounting, AUTO_PAUSE rail |
| Auth/rate-limit death overnight | the retry/pause wrapper from optimize hardening (carries up) |

## Build order

1. `evaluateCandidate()` -- refactor `optimize.ts`'s mutate-score-gate into a
   reusable primitive (no new behavior; just the seam `research` plugs into).
2. `research.ts` skeleton: beam + `selectBeam` (scalar ranking first; Pareto front
   as a follow-up) + ledger, with a stub Ideator (fixed hypotheses) and no
   frontier growth -- fully offline-testable with a stub `claudeBin`. Proves the
   population search.
3. Ideator + Reflector + novelty guard (`runHeadlessText`-backed, on the pinned
   reference config).
4. `expandFrontier` + `synthesizeScenarios` + the discriminating-power validator
   (seed vs empty reference).
5. Canary trust-check + PR review gate (reuse `prcomment.ts`, never auto-merge) +
   `crucible research` CLI + `journal.md` rendering.

Steps 1-2 are the load-bearing new logic and are testable with zero tokens; 3-5
touch a live `claude`.

## Tests (`tests/research.test.ts`, `tests/frontier.test.ts`)

Stub `claudeBin`:
- beam keeps a diverse top-B and never collapses below the diversity floor,
- with Pareto enabled, a member that wins pass-rate but loses badly on cost does
  not dominate and a cheaper member survives,
- an idea that regresses canary is never promoted to best,
- a lineage that edits a pinned judge/skill cannot change judge behavior,
- frontier expansion only admits scenarios that pass the discriminating-power
  check; the holdout split is honored,
- the winning branch is emitted as a PR and never auto-merged,
- `--budget-usd` halts mid-round and counts ideator/judge/reflector/synth cost,
- resume reloads beam branches + backlog,
- `frontier.test.ts`: generated scenarios that pass on both the seed reference and
  the empty/weakened reference (or fail both) are discarded; only discriminating
  ones are admitted.

## Summary

This is the layer that makes it autoresearch rather than optimization: the agent
invents what to try (Ideator), the eval moves so it is never "done" (Frontier),
the search explores instead of greedily climbing (Beam), and a frozen canary
keeps the open-endedness honest. `optimize` is the engine; this is the researcher
driving it.
