# Crucible

**Regression CI for Claude Code configs.** Treat your `.claude/` directory -- skills, subagents, hooks, and `CLAUDE.md` -- as code under test. Define behavioral scenarios, run them N times on every change, and gate merges when quality regresses.

> You write a text file, hand it to an agent, and hope for the best. Crucible gives you a signal.

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](#requirements)
[![status](https://img.shields.io/badge/status-v0.1%20alpha-orange)](#status)

---

## Why

Claude Code configs are code now. A change to `CLAUDE.md`, a new subagent, or a tweaked hook can silently make your agent *worse* -- and you won't know until it ships. Two facts make this real:

- Anthropic shipped a **6-week silent quality regression** in Claude Code that its own evals missed. Teams with workflow-level evals caught it in ~72 hours. ([postmortem](https://www.anthropic.com/engineering/april-23-postmortem))
- The skill/plugin marketplace is exploding, with **no quality bar**. "Working" is undefined until you run it on something real.

Existing tools test a skill *in isolation* ("does it trigger?"). Crucible tests the **whole config behaving on a real task** ("did it produce good code, fire the right subagent, and stay under budget?").

## What it does

```
crucible run --config .claude --suite crucible
```

For each scenario, Crucible:

1. **Isolates** -- copies your fixture into a throwaway workdir, points Claude Code at the config under test via `CLAUDE_CONFIG_DIR` (your real `~/.claude` is never touched).
2. **Captures** -- injects `PostToolUse` + `SubagentStop` hooks that log every tool and subagent that actually fired.
3. **Runs headless** -- `claude -p --output-format json`, capturing the result, turn count, and **real cost** (`total_cost_usd`).
4. **Asserts** -- deterministic checks against the workdir and the capture log.
5. **Repeats k times** -- because headless mode has no seed; reports `pass@k`, `pass^k`, variance, and flags flaky scenarios.
6. **Gates** -- exits non-zero when a scenario's pass-rate or cost gate fails, so it blocks a PR like any other test. Emits JUnit XML.

## Quick start

```bash
npm install -g crucible-ci          # or: npx crucible-ci init
crucible init                       # scaffolds crucible/example.scenario.yaml + a GitHub Action
crucible run --config .claude --suite crucible --junit results.xml
```

## A scenario

```yaml
name: security-reviewer-fires-on-auth-changes

fixture: ./fixtures/express-api      # optional git-tracked starting state
prompt: |
  Add a POST /login endpoint that accepts an email and password.

trials: 3                            # non-determinism is expected
max_turns: 30

assert:
  - subagent_invoked: security-reviewer
  - file_matches: "src/routes/auth.ts::bcrypt|argon2"   # password is hashed
  - command_not_run: "rm -rf*"
  - command_succeeds: "npm test"
  - cost_under: 0.50

gate:
  min_pass_rate: 0.67                # 2 of 3 trials must pass
  max_cost_usd: 0.50
```

### Assertion types (v0.1)

| Assertion | Passes when |
|-----------|-------------|
| `file_exists: path` | the file was created in the workdir |
| `file_matches: path::regex` | the file exists and matches the regex |
| `subagent_invoked: name` | that subagent fired during the run |
| `tool_invoked: name` | that tool fired during the run |
| `command_not_run: glob` | no tool invocation matched the glob |
| `command_succeeds: cmd` | the command exits 0 in the workdir |
| `cost_under: usd` | the run's `total_cost_usd` stayed under the ceiling |
| `judge: rubric` (+ `min_score`) | an LLM scores the output 1-5 vs the rubric |

### LLM-judge assertions (soft by default)

Some quality checks are not mechanical ("did it actually hash the password?",
"is the error message helpful?"). A `judge` assertion has a neutral, tool-free
LLM score the run's output against a rubric, 1-5:

```yaml
  - judge: "The error response is helpful and does not leak internal details"
  - judge: "Password is hashed with bcrypt or argon2, never stored plaintext"
    min_score: 4     # opt-in gate
```

By design the judge is a **soft signal**: with no `min_score` it is reported but
never fails a gate. Add `min_score` to explicitly opt into gating on it. Pick the
judge model with `--judge-model` (a cheaper model keeps eval cost down).

## Baselines & regression detection

The whole point of *regression* CI: catch a config change that makes the agent
quietly worse, even when no single scenario newly fails its own gate.

```bash
crucible baseline --config .claude --suite crucible   # snapshot known-good -> crucible/baseline.json
# ...later, on a PR that edits .claude/ ...
crucible run --config .claude --suite crucible --baseline crucible/baseline.json --fail-on-regression
```

A regression is reported when, versus the baseline, a scenario's pass rate drops
past a threshold, a previously **stable** scenario becomes **flaky**, or median
cost jumps significantly. With `--fail-on-regression` these fail the build.

## CI

`crucible init` drops a ready GitHub Action that runs on changes to `.claude/**`. It installs Claude Code + Crucible, runs the suite, and uploads the JUnit report. Set `ANTHROPIC_API_KEY` as a repo secret.

## Requirements

- Node >= 20
- [Claude Code](https://www.anthropic.com/claude-code) on `PATH` (`claude`), authenticated (API key or subscription)

## Status

**v0.1 -- alpha.** The headless runner, hook-based capture, deterministic assertions, k-trial stats, JUnit output, and the GitHub Action are implemented. Live end-to-end runs depend on your local `claude` binary and an authenticated account.

On the roadmap:

- **LLM-judge assertions** -- grade output against a rubric (soft signal, not a hard gate).
- **Transcript-diff viewer** -- see *what changed* between a passing and failing config, turn by turn.
- **Baselines + regression diffing** -- store results keyed by config git SHA; gate on deltas.
- **Hosted parallel runner** -- trials are slow and token-costly; offload them and get history + dashboards.

## How it isolates your config

Crucible never edits your real config. Each trial runs in `mkdtemp()` with `CLAUDE_CONFIG_DIR` pointed at the config under test and a generated `--settings` file that adds only the capture hooks. Delete-on-exit by default; pass `--keep-workdirs` to inspect a run.

## Terms & consent

On first run, Crucible shows its [Terms & Conditions](./TERMS.md) and asks you to
accept. Accepting is one-time and stored locally. In CI / non-interactive use,
continued use constitutes acceptance (set `CRUCIBLE_AGREE=1` to record it
explicitly, or run `crucible agree`). The Terms cover the anonymous telemetry
below and the MIT license; if you do not agree, do not use the tool.

## Telemetry

Crucible can send **anonymous** usage stats (CLI version, OS, command, and pass/fail
counts) to help prioritize work. It **never** collects prompts, file contents, paths,
or results, is disclosed on first run, and is off-network unless a collector is
configured. Opt out anytime:

```bash
crucible telemetry off          # or: CRUCIBLE_TELEMETRY=0 / DO_NOT_TRACK=1
```

Full field list and rationale: [TELEMETRY.md](./TELEMETRY.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and scenario contributions welcome.

## License

MIT (c) 2026 Khalid Vance. See [LICENSE](./LICENSE).
