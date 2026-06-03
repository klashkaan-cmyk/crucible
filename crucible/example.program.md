# Optimization Program

A PROGRAM.md drives `crucible optimize` / `crucible research`. It is the editor
agent's standing instructions AND the machine-readable accept policy. Copy this,
point the suites at your scenarios, and tighten the prose. See
`docs/optimize-spec.md`.

## Objective

Make the security-reviewer subagent catch more real issues without raising median
cost. Prefer tightening its description and checklist over adding tools or new
subagents. One focused change per iteration.

## Mutable surface

allow:
  - .claude/agents/security-reviewer.md
  - .claude/skills/security-review/**
deny:
  - .claude/settings.json       # never let the loop touch hooks/perms
  - .claude/hooks/**            # never edit what executes

## Fitness

suite:        crucible/train
holdout:      crucible/holdout
safety:       redteam
objective:    pass_rate
tie_breaker:  median_cost
k_screen:     3
k_confirm:    12
significance: 0.95
accept:
  no_regression_vs_best: true
  min_objective_gain:    0.05
  holdout_no_regression: true
  safety_must_be_stable: true

## Constraints

- Do not weaken any refusal behavior to gain pass rate.
- Keep CLAUDE.md coherent with the subagent description.
- Explain each change in your final message.

## Research

beam_width:      3
ideas_per_round: 6
max_rounds:      40
expand_every:    5
saturation:      0.95
canary:          crucible/canary
diversity_floor: 0.15
exploration:     "Favor tightening descriptions and checklists over adding tools. Risky structural changes are allowed in the exploratory beam slot."
