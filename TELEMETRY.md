# Telemetry

Crucible can send **anonymous** usage statistics to help prioritize fixes and
features. This page documents exactly what is and isn't collected. Telemetry is
disclosed on first run and can be turned off permanently in one command.

## TL;DR

- **No content, ever.** Prompts, file contents, file paths, scenario bodies,
  scenario names, assertion text, and run results are **never** collected.
- **Anonymous.** A random UUID is generated locally on first run. It is not tied
  to your identity, IP-as-identity, GitHub, or npm account.
- **Opt out anytime:** `crucible telemetry off`, or set `CRUCIBLE_TELEMETRY=0`,
  or the standard `DO_NOT_TRACK=1`.
- **Dormant unless a collector is configured.** If no endpoint is set, nothing
  leaves your machine regardless of settings.
- **Fail-silent and time-boxed.** Telemetry never blocks, slows, or breaks a run.

## What is collected

On a `crucible run`, a single event with these fields:

| Field | Example | Why |
|-------|---------|-----|
| `event` | `"run"` | which command ran |
| `anonymousId` | random UUID | de-duplicate installs; not identifying |
| `version` | `"0.1.0"` | which Crucible version is in use |
| `os` / `arch` | `"linux"` / `"x64"` | platform support priorities |
| `node` | `"20.11.0"` | runtime support matrix |
| `ci` | `true` | distinguish CI vs local usage |
| `ts` | ISO timestamp | event time |
| `scenarios` | `4` | rough suite size (a count, not names) |
| `gates_failed` | `1` | how often suites fail (a count) |

That is the complete list. Property values are additionally sanitized: only
numbers, booleans, and short non-path strings are allowed through, so a future
code change cannot accidentally leak a path or large blob.

## What is NOT collected

- Prompts or any text you write in scenarios
- File names, paths, or contents from fixtures or workdirs
- Scenario names or assertion definitions
- Agent output, transcripts, or results
- Cost figures, API keys, environment variables
- IP address as an identifier, email, or account handles

## How to turn it off

```bash
crucible telemetry off        # persistent, stored in your config
crucible telemetry status     # check current state + config path
CRUCIBLE_TELEMETRY=0 crucible run ...   # per-invocation
DO_NOT_TRACK=1 crucible run ...         # honored automatically
```

Config lives at `${XDG_CONFIG_HOME:-~/.config}/crucible/config.json`.

## For maintainers / self-hosters

Collection is **off-network by default**: the built-in endpoint is empty, so
nothing is sent until you point Crucible at a collector you operate via
`CRUCIBLE_TELEMETRY_URL` (or by replacing `DEFAULT_ENDPOINT` in
`src/telemetry.ts` in your own build). The payload is a plain JSON POST. Host it,
document your retention policy, and keep this file accurate to what you collect.
