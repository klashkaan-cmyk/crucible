# Changelog

## 0.6.0
- New assertions on the agent's final response: `response_contains` (substring) and `response_matches` (regex). Until now you could only assert on files the agent produced, not on what it said.
- New performance-gate assertions: `latency_under` (milliseconds) and `turns_under` (agent turns). These read the run duration and turn count the runner already captures, so you can catch a config that quietly gets slower or chattier.
- New `crucible watch`: re-run the suite whenever the config or scenarios change, with debounced runs and VCS/build-noise filtering. Tightens the local authoring loop.

## 0.5.1
- Replace the Stripe dummy key in the red-team hardcode scenario with a non-secret placeholder (keeps npm byte-identical to the repo; avoids secret-scanning false positives). No behavior change.

## 0.5.0
- New red-team scenario pack (`crucible run --suite redteam`, scaffold with `crucible init --redteam`): tests that a config resists prompt injection, destructive-command baits, secret hardcoding, credential exfiltration, and malware requests.
- `command_not_run` now matches the command/input (not just the tool name), so it catches `curl ...`, `rm -rf ...`, etc. Secret scanner adds Stripe-key detection.

## 0.4.0
- New `crucible bisect`: binary-search the config's git history to find the commit that introduced a regression. Tests only config-touching commits, each in a throwaway `git worktree` (working tree untouched), ~log2(n) runs. Supports `--good/--bad`, `--scenario`, and `--baseline` as the bad signal.

## 0.3.0
- New `crucible lint` command: deterministic, offline static checks on a `.claude` config (invalid settings JSON, hooks referencing missing scripts, subagents missing/duplicate names or descriptions, skills with no description that won't auto-activate, hardcoded secrets in CLAUDE.md/configs, oversized CLAUDE.md). No model calls, no cost; exits non-zero on errors. Secret patterns factored into a shared module.

## 0.2.0
- `run --json` (machine-readable output) and `run --markdown <file>` (PR/Actions summary via `$GITHUB_STEP_SUMMARY`); the example GitHub Action now surfaces results in the Checks tab.
- `run --concurrency <n>` runs trials in parallel.
- New assertions: `file_absent` and `no_secrets` (scans produced files for keys/tokens/private keys).
- Add `examples/` scenarios and a favicon asset.

## 0.1.6
- Ship a runnable `express-api` fixture and point the example scenario at it, so a fresh clone runs end-to-end. Soften the `crucible init` template so first runs don't require a `security-reviewer` subagent.

## 0.1.5
- Add the transcript-diff viewer: `crucible run --save-transcripts <dir>` records each trial's ordered steps (tools/subagents + input summaries), and `crucible diff <a> <b> [--html <file>]` shows an LCS-aligned, color-coded step diff with turn/cost deltas and a standalone HTML side-by-side viewer.

## 0.1.4
- Add LLM-judge assertions: `judge: "<rubric>"` scores the run 1-5 via a neutral, tool-free model. Soft signal by default (never fails a gate); add `min_score` to opt into gating. New `--judge-model` flag.

## 0.1.3
- Add `crucible baseline` to snapshot known-good behavior, and `crucible run --baseline <file> [--fail-on-regression]` to catch silent quality regressions (pass-rate drops, stable->flaky, cost increases) even when each scenario still passes its own gate.

## 0.1.2
- Bake the default anonymous-telemetry collector endpoint; telemetry is now on-by-default, disclosed, and opt-out (was dormant).

## 0.1.1
- Add Terms & Conditions, a post-install disclosure, and a first-run consent gate (`crucible agree` / `terms`).
- Add anonymous, opt-out telemetry (`crucible telemetry on|off|status`); honors DO_NOT_TRACK.

## 0.1.0
- Initial release: headless runner, hook-based tool/subagent capture, deterministic assertions, k-trial pass@k/pass^k gates with cost, JUnit + console reporting, GitHub Action.
