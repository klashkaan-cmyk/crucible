# Contributing to Crucible

Thanks for helping make Claude Code configs testable.

## Dev setup

```bash
npm install
npm run dev -- run --config .claude --suite crucible   # run the CLI from source
npm test                                                # unit tests (vitest)
npm run typecheck
npm run build                                           # bundle to dist/
```

## Project layout

| Path | Purpose |
|------|---------|
| `src/cli.ts` | command surface (`run`, `init`) |
| `src/scenario.ts` | YAML scenario schema + loader (zod) |
| `src/runner.ts` | headless `claude -p` invocation + envelope parsing |
| `src/hooks.ts` | capture-hook injection + invocation log parsing |
| `src/assertions.ts` | deterministic assertion engine |
| `src/stats.ts` | k-trial aggregation, pass@k / pass^k, gates |
| `src/report.ts` | console + JUnit output |
| `src/suite.ts` | scenario discovery + orchestration |

## Adding an assertion

1. Add the field to `AssertionSpec` in `src/scenario.ts`.
2. Handle it in `evaluateOne()` in `src/assertions.ts`.
3. Document it in the README assertion table.
4. Add a unit test.

## Guidelines

- Keep files small (target < 400 lines) and functions < 50 lines.
- Deterministic assertions are hard gates; anything model-judged must be a soft signal.
- No assertion may mutate the user's real `~/.claude`.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
