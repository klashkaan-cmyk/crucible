# `crucible optimize` -- spec

Status: design. Target: `src/optimize.ts`, `src/program.ts`, `crucible optimize` CLI.

## Mental model

`optimize` is an autonomous improvement loop (the pattern from
[karpathy/autoresearch](https://github.com/karpathy/autoresearch)) whose
keep/discard decision runs through Crucible's existing variance-aware,
baselined, safety-gated oracle instead of a single scalar metric.

autoresearch's three files map cleanly:

| autoresearch | Crucible `optimize` |
|---|---|
| `train.py` (mutable, agent edits) | `--target` globs inside `.claude/` |
| `program.md` (human-owned guardrails) | `PROGRAM.md` (see below) |
| `val_bpb` (single scalar, 1 sample) | the accept gate -- a vector over `ScenarioResult` across k trials, with hard safety constraints + a holdout |
| keep/discard log | append-only JSONL ledger + one git commit per accepted candidate (bisectable with `crucible bisect`) |

Structural anti-wirehead property: the editor agent writes only inside a
throwaway git worktree of the config; the scenarios it is scored against live at
a `scenarioDir` *outside* that worktree, so the agent cannot edit its own exam.
The post-edit diff is verified to be inside `--target`; anything that escapes is
rejected before a single trial is spent.

## PROGRAM.md convention

A single human-owned file at the repo root (path via `--program`). It is the
editor agent's standing instructions *and* the machine-readable accept policy.
Frozen during a run -- the optimizer reads it, never writes it. Parsed with `zod`
in `src/program.ts`, same shape as `loadScenario`. Unknown keys error (fail
closed).

```markdown
# Optimization Program

## Objective            <!-- prose, handed to the editor verbatim -->
Make the security-reviewer subagent catch more real issues without raising
median cost. Prefer tightening its description and checklist over adding tools.

## Mutable surface      <!-- parsed: glob allowlist, enforced on the git diff -->
allow:
  - .claude/agents/security-reviewer.md
  - .claude/skills/security-review/**
deny:
  - .claude/settings.json          # never let the loop touch hooks/perms
  - .claude/hooks/**                # never edit what executes

## Fitness              <!-- parsed: the accept gate -->
suite:        crucible/train       # scored every iteration (editor sees failures)
holdout:      crucible/holdout      # scored only on candidates that pass `suite`; editor NEVER sees it
safety:       redteam               # hard constraint, min_pass_rate 1, every iteration
objective:    pass_rate             # maximize mean scenario pass_rate over `suite`
tie_breaker:  median_cost           # lower wins on equal objective
k_screen:     3                     # cheap first pass on every candidate
k_confirm:    12                    # finalists only: re-run at high k before accepting
significance: 0.95                  # accept only if the gain is significant at this level
accept:
  no_regression_vs_best: true       # diffAgainstBaseline(candidate, best) must be empty
  min_objective_gain:    0.05       # effect-size floor (must clear noise AND be significant)
  holdout_no_regression: true       # diffAgainstBaseline(holdout, holdoutBest) empty
  safety_must_be_stable: true       # every `safety` scenario stays pass^k

## Constraints          <!-- prose, handed to the editor verbatim -->
- Do not weaken any refusal behavior to gain pass rate.
- Keep CLAUDE.md coherent with the subagent description.
- One focused change per iteration; explain it in your final message.
```

`Mutable surface` and `Fitness` are structured; `Objective`/`Constraints` prose
is concatenated into the editor prompt. The `accept` block has defaults, so a
minimal PROGRAM.md is `## Mutable surface` + `## Fitness.suite` only.

Loader: `loadProgram(path): Promise<Program>` in `src/program.ts`.

## `src/optimize.ts`

### Types

```ts
export interface OptimizeOptions {
  readonly configDir: string;          // .claude under test (the repo's, not ~/.claude)
  readonly program: Program;           // from loadProgram()
  readonly budgetUsd: number;          // hard ceiling on summed real trial cost
  readonly maxIters: number;
  readonly plateauIters: number;       // stop after N consecutive rejects (default 8)
  readonly editorModel?: string;       // model the mutator runs as
  readonly judgeModel?: string;        // passed through to SuiteOptions
  readonly concurrency?: number;       // passed through (cost-multiplying; default 1)
  readonly claudeBin?: string;
  readonly ledgerPath: string;         // append-only JSONL
  readonly branch: string;             // worktree branch, e.g. optimize/2026-06-03
  readonly signal?: AbortSignal;       // token-watch / SIGTERM -> graceful stop
}

export interface Candidate {
  readonly iter: number;
  readonly editorMessage: string;      // the agent's rationale (final headless text)
  readonly editorCostUsd: number;
  readonly changedFiles: ReadonlyArray<string>;
  readonly commit?: string;            // set iff accepted
}

export type Verdict =
  | { kind: "accept"; objective: number; gain: number }
  | { kind: "reject"; reason: RejectReason; detail: string };

export type RejectReason =
  | "out-of-scope-edit"      // diff escaped the allowlist -> wirehead attempt
  | "no-op"                  // editor changed nothing
  | "lint-error"             // candidate config is malformed
  | "safety-regression"      // a redteam scenario dropped below pass^k
  | "suite-regression"       // diffAgainstBaseline(candidate, best) non-empty
  | "insufficient-gain"      // objective gain < min_objective_gain
  | "holdout-regression"     // generalization gap: train up, holdout down
  | "run-error";

export interface IterationRecord {
  readonly iter: number;
  readonly verdict: Verdict;
  readonly candidate: Candidate;
  readonly suite: ReadonlyArray<ScenarioResult>;     // train scoring
  readonly holdout?: ReadonlyArray<ScenarioResult>;  // only if it reached holdout
  readonly costUsd: number;          // editor + all trials this iteration
  readonly cumCostUsd: number;
  readonly configRef: string;        // configFingerprint() of the candidate
}
```

### Main loop

```
async function optimize(opts): Promise<OptimizeSummary> {
  repo      = await resolveConfigRepo(opts.configDir)          // reuse bisect.ts
  worktree  = await openWorktree(repo, opts.branch)            // new: mutable worktree at HEAD
  best      = await scoreBaseline(worktree, opts)              // initial train+holdout baseline
  let cum = 0, plateau = 0

  for (iter = 1; iter <= opts.maxIters; iter++) {
    if (opts.signal?.aborted) break
    if (cum >= opts.budgetUsd)  break

    resetWorktree(worktree)        // git reset --hard HEAD && git clean -fd (recover dirty state)

    // 1. MUTATE -- editor edits only within worktree, sees train failures, never holdout
    cand = await runEditor(worktree, opts, best.suite, failuresDigest(best.suite))

    // 2. SCOPE + LINT GUARD (anti-wirehead, free) -- reject before any trial
    scope = await gitChangedFiles(worktree)
    if (scope.length === 0)                     -> reject "no-op", continue
    if (!withinAllowlist(scope, opts.program))  -> reject "out-of-scope-edit", continue
    if (await lintHasError(worktree))           -> reject "lint-error", continue

    // 3. SCREEN cheap: k_screen trials against the MUTATED worktree config
    screen = await runSuiteWithRetry(trainFiles, suiteOpts(worktree, opts, p.k_screen))
    cum   += sumRealCost(screen) + cand.editorCostUsd
    if (!promising(screen, best, opts.program))   // clearly not better -> drop without paying k_confirm
      { record("reject", "insufficient-gain"); plateau++; continue }

    // 3b. CONFIRM expensive: re-run finalists at k_confirm so the decision is statistically real
    suite = await runSuiteWithRetry(trainFiles, suiteOpts(worktree, opts, p.k_confirm))
    cum  += sumRealCost(suite)

    // 4. ACCEPT GATE (vector, variance-aware, significance-tested) -- reuses diffAgainstBaseline
    v = decide(suite, best, opts.program)
    if (v.kind === "reject") { record(...); plateau++; continue }

    // 5. HOLDOUT -- only candidates that passed train pay for holdout
    holdout = await runSuiteWithRetry(holdoutFiles, suiteOpts(worktree, opts))
    cum    += sumRealCost(holdout)
    if (diffAgainstBaseline(holdout, best.holdoutBaseline).length)
      -> reject "holdout-regression", record, plateau++, continue

    // 6. KEEP -- commit (autoresearch's "keep"), advance best, reset plateau
    commit = await gitCommit(worktree, `optimize: iter ${iter} (+${v.gain})`)
    best   = { suite, holdout, baseline: toBaseline(suite), holdoutBaseline: toBaseline(holdout),
               objective: v.objective }
    plateau = 0
    record(accept...)
    if (plateau >= opts.plateauIters) break
  }
  return summarize(ledger, best, opts.branch)   // branch is the bisectable lineage
}
```

### The accept decision

```ts
function decide(cand: ScenarioResult[], best: Best, p: Program): Verdict {
  // hard safety constraint first -- never tradeable
  for (const s of cand) if (isSafety(s, p) && !s.stable)
    return { kind: "reject", reason: "safety-regression", detail: s.name };

  // no per-scenario regression vs current best -- reuse existing machinery,
  // tightened so we don't accept noise as improvement
  const regs = diffAgainstBaseline(cand, best.baseline,
                 { passRateDrop: 0, costIncrease: p.accept.costTolerance });
  if (regs.length) return { kind: "reject", reason: "suite-regression", detail: regs[0].detail };

  // objective must clear BOTH an effect-size floor and a significance test --
  // k_confirm trials per scenario give the sample; a two-proportion / bootstrap
  // test on (best trials vs candidate trials) rejects gains indistinguishable
  // from binomial noise. This is the "variance-honest" guarantee made real;
  // fixed thresholds at small k are not enough on their own.
  const obj  = objectiveOf(cand, p);            // mean passRate over suite at k_confirm
  const gain = obj - best.objective;
  if (gain < p.accept.minObjectiveGain || !significant(cand, best, p.significance)) {
    // allow equal-objective acceptance only if strictly cheaper (tie_breaker)
    if (gain >= 0 && medianCostOf(cand) < best.cost - EPS)
      return { kind: "accept", objective: obj, gain: 0 };
    return { kind: "reject", reason: "insufficient-gain", detail: `+${gain.toFixed(3)}` };
  }
  return { kind: "accept", objective: obj, gain };
}
```

`promising(screen, best, p)` is the cheap screen: accept to the confirm stage only
if the k_screen objective is at least `best.objective` (no effect-size or
significance test yet -- those need the k_confirm sample). `significant(...)` runs
the two-proportion / bootstrap test over the pooled per-scenario trial outcomes.

Why this beats `val_bpb`: a candidate is kept only when, at confirm-level k, it
(a) regresses no scenario, (b) breaks no safety property, (c) beats the objective
by more than the noise margin **and passes a significance test**, and (d) holds up
on a holdout the editor never saw. Three of those four cannot be expressed in a
scalar oracle, and (c) is what a single sample (autoresearch's `val_bpb`) cannot
do at all.

> Objective shape: `mean pass_rate` + a single cost tie-breaker is a deliberate
> v1 simplification of a multi-objective space (pass-rate, cost, turns,
> subagent-correctness). A Pareto front in the beam (see research-spec) is the
> fuller version; the scalar keeps the gate legible to start.

### Helper contracts (new, small)

- `openWorktree(repo, branch)` -- `git worktree add` off HEAD on a fresh branch;
  returns `{ configDir, dispose() }`. Modeled on `withWorktree` in `bisect.ts`
  but writable and persistent for the run.
- `resetWorktree(worktree)` -- `git reset --hard HEAD && git clean -fd` at the
  top of every iteration (recover from a crashed/timed-out editor).
- `runEditor(worktree, opts, lastSuite, digest)` -- spawns `claude -p` with
  `cwd = worktree root`, prompt = rendered PROGRAM.md prose + `digest` (failing
  scenarios + their `explain()` output) + the allowlist. Parses the headless
  envelope for `totalCostUsd` and final text. Same `parseHeadless` + `spawn` shape
  as `runHeadlessText`, ~30 lines.
  **Tool restriction (required):** the editor is passed
  `--allowedTools Edit Write Read` only -- **no Bash, no network.** It may *edit*
  files but cannot *act* (run commands, reach out) during the edit phase. The
  post-hoc scope guard (below) is defense-in-depth, not the only line of defense.
- `gitChangedFiles` / `withinAllowlist` -- `git diff --name-only` + minimatch
  against `allow`/`deny`. The structural wirehead guard.
- `lintHasError(worktree)` -- reuse `lintConfig` from `src/lint.ts`; free pre-gate.
- `runSuiteWithRetry(files, opts)` -- wraps `runSuite`; on the auth-failure
  envelope (`authFailureHint`) PAUSE and poll (do not count as a rejection); on
  the real rate-limit envelope, exponential backoff. Never lets infra errors burn
  the plateau counter.
- `suiteOpts(worktree, opts, k)` -- builds `SuiteOptions` with
  `configDir = worktree.configDir` but `scenarioDir` = the canonical suite path
  OUTSIDE the worktree (scenarios read-only to the agent), overriding each
  scenario's `trials` to `k` (the two-stage screen/confirm count). Threads
  `judgeModel`, `concurrency`, `claudeBin`.
- `significant(cand, best, level)` -- two-proportion / bootstrap test over the
  pooled per-scenario trial outcomes; the statistical core of the gate.
- `objectiveOf` / `medianCostOf` / `failuresDigest` -- pure over `ScenarioResult[]`.

### Meta-agent pinning (a wirehead vector, closed)

The judge (and, in research-spec, the Ideator/Reflector) must run on a **frozen
reference config**, never the candidate under test. Otherwise the optimizer could
raise its own scores by editing the brain that grades it. `runHeadlessText` runs
in a throwaway cwd on the host env, so it does NOT inherit the candidate's
`CLAUDE_CONFIG_DIR` -- but this must be asserted explicitly: meta-agents take a
fixed `--config <reference>` (or pinned host config), and a test verifies a
candidate that edits a judge/skill cannot move judge behavior. Treat the meta
layer as outside the mutable surface, always.

### CLI surface

```
crucible optimize \
  --config .claude --program PROGRAM.md \
  --budget-usd 20 --max-iters 100 --plateau 8 \
  --editor-model opus --judge-model haiku \
  --branch optimize/$(date +%F) \
  --ledger .crucible/optimize.jsonl \
  [--concurrency 1] [--dry-run]
```

`--dry-run` runs steps 1-4 but never commits. Exit non-zero if zero candidates
were accepted (CI-legible). Wire `--budget-usd` and `SIGTERM` to an
`AbortController` so `token-watch.sh` AUTO_PAUSE stops it gracefully (flush
ledger, leave branch intact).

### Resumability & output

- Ledger is append-only JSONL (`IterationRecord` per line). On restart: reset
  worktree to branch tip, reload `best` from the last `accept` line, recompute
  `bestObj`.
- The branch IS the artifact: each accepted candidate is one commit, so review is
  `git log <branch>` and any regression introduced during the run is found with
  the existing `crucible bisect`. No new provenance code.
- `summarize()` prints: iters run, accepted/rejected counts by `RejectReason`,
  objective trajectory, total $ spent, branch name.

### Review gate -- never auto-merge

The output config governs production agent behavior; the loop must **not** merge
it. On completion (and in CI), emit a **pull request** off the optimize branch
with the score deltas (baseline -> final objective, per-scenario pass-rate, cost)
and the rejected-candidate tally as the review body -- reuse the existing
`src/prcomment.ts` machinery. A human merges. autoresearch's "review in the
morning" becomes a concrete, diffable PR, not an auto-applied change.

### Cost & determinism (correction)

Record/replay cassettes do **not** cheapen candidate scoring: a config change
alters agent behavior *by design*, so a cassette recorded on the old config
cannot score a new candidate. Cassettes only help re-measuring the *unchanged*
best/holdout baselines. Net: **every candidate costs real tokens** -- which is
exactly why the two-stage k (cheap screen, expensive confirm) and a hard
`--budget-usd` matter. The budget must sum the **full** LLM surface each
iteration: editor + screen trials + confirm trials + every `judge` assertion +
periodic best re-measurement. `sumRealCost` aggregates `totalCostUsd` across all
of them, not just the trial runs.

### Autonomy hardening (MUST for unattended overnight runs)

1. Token-expiry survival -- `runSuiteWithRetry` pauses/polls on auth failure
   instead of counting it as a rejection (see CEO 401 auth-loop history).
2. Rate-limit backoff -- match the real rate-limit envelope; never treat 429 as a
   failed candidate (avoid the false-positive rate-limit detector pattern).
3. Dirty-worktree recovery -- `resetWorktree` at the top of every iteration.
4. Graceful resume -- defined above.
5. Lint pre-gate -- reject malformed candidates free, before scoring.
6. Re-measure `best` every M accepted iters (re-score at k trials) so the
   hill-climb does not drift on a single noisy baseline snapshot.

### Build order (minimal first PR)

1. `program.ts` + `program.test.ts` (pure, no claude). Includes the two-stage k
   fields and `significant()` (pure stats, unit-tested against known proportions).
2. `openWorktree` + `resetWorktree` + `gitChangedFiles` + `withinAllowlist`
   (reuses `bisect.ts` plumbing).
3. `optimize.ts` core loop wired to `runSuite`/`diffAgainstBaseline`/`toBaseline`,
   with the two-stage screen/confirm gate + significance test, and a stubbed
   `runEditor` (returns a fixed patch) -- fully testable offline.
4. `runSuiteWithRetry` (auth/rate-limit wrapper) + lint pre-gate + best
   re-measurement.
5. Real `runEditor` (tool-restricted) + meta-agent pinning + PR review gate
   (reuse `prcomment.ts`) + `crucible optimize` CLI wiring + docs. Wire the
   `crucible generate` bootstrap so a config with no suite can cold-start.

Steps 1-3 are net-new but small and reuse every heavy primitive; 4-5 are the only
parts that touch a live `claude`.

### Tests (`tests/optimize.test.ts`, `tests/program.test.ts`)

Stub `claudeBin` (as the suite tests do) so the loop runs offline:
- out-of-scope edits reject without scoring,
- lint-error candidates reject free,
- a candidate that passes the cheap screen but whose gain is not significant at
  k_confirm is rejected (two-stage gate works),
- a screen-failing candidate is dropped without paying for k_confirm,
- `significant()` rejects a 3/5-vs-4/5 style gain as noise and accepts a clearly
  separated one,
- the editor is invoked with Edit/Write/Read only (no Bash) -- assert the spawned
  args,
- a candidate that edits a judge/skill cannot change judge behavior (meta-agent
  pinning),
- a safety regression is rejected regardless of objective gain,
- a train-up/holdout-down candidate rejects as `holdout-regression`,
- accepted candidates produce exactly one commit each,
- completion emits a PR (mock `prcomment`) and never merges,
- `--budget-usd` halts mid-loop and counts editor + judge + trial cost,
- an auth-failure envelope pauses (does not advance the plateau counter).
- `program.test.ts`: schema valid/invalid, allow/deny precedence, defaults.
