# Changelog

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
