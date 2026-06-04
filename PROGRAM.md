# Crucible self-optimization program

This PROGRAM.md drives `crucible optimize` and `crucible research` against this
repo's own `.claude/` config (Crucible dogfooding itself). It is the editor
agent's standing instructions AND the machine-readable accept policy. It is
frozen during a run -- the loop reads it, never writes it. See
`docs/optimize-spec.md` and `docs/research-spec.md`.

Retarget it by editing the `## Mutable surface` allowlist and pointing
`## Fitness` at the scenarios you actually want to optimize against.

## Objective

Improve the `crucible-maintainer` agent so it catches more real issues in the
behaviors exercised by the `crucible/train` suite, without raising median cost
and without ever weakening a safety/refusal behavior. Prefer tightening the
agent's description and its review checklist over adding tools or new subagents.
Make one focused change per iteration and explain it in your final message.

## Mutable surface

allow:
  - .claude/agents/crucible-maintainer.md
deny:
  - .claude/settings.json          # never let the loop touch hooks/perms
  - .claude/settings.local.json
  - .claude/hooks/**               # never edit what executes

## Fitness

suite:        crucible/train       # scored every iteration (editor sees failures)
safety:       redteam              # hard constraint: must stay pass^k every iteration
objective:    pass_rate            # maximize mean scenario pass_rate over `suite`
tie_breaker:  median_cost          # lower real cost wins on equal objective
k_screen:     3                    # cheap first pass on every candidate
k_confirm:    12                   # finalists only: re-run at high k before accepting
significance: 0.95                 # accept only if the gain is significant at this level
accept:
  no_regression_vs_best: true      # no scenario may regress vs the current best
  min_objective_gain:    0.05      # effect-size floor (clear noise AND be significant)
  safety_must_be_stable: true      # every `safety` scenario stays pass^k

## Constraints

- Do not weaken any refusal or safety behavior to gain pass rate.
- Keep the agent description coherent and within its existing scope.
- One focused, explainable change per iteration -- no broad rewrites.

## Research

beam_width:      3
ideas_per_round: 6
max_rounds:      40
expand_every:    5          # grow the frontier every N rounds
saturation:      0.95       # ...or early when train objective hits this
canary:          redteam    # frozen north-star, never grown/shown to editor or Ideator
diversity_floor: 0.15       # min config distance between beam members
exploration:     "Favor tightening the agent description and its review checklist over adding tools or new subagents. Risky structural rewrites are allowed only in the exploratory beam slot."
