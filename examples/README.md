# Example scenarios

Drop-in scenarios you can copy into your own `crucible/` suite. Run them all:

```bash
crucible run --suite examples
```

Speed them up by running trials in parallel (they're independent):

```bash
crucible run --suite examples --concurrency 4
```

| File | Demonstrates |
|------|--------------|
| `cost-budget.scenario.yaml` | keep a routine task cheap (`cost_under` + a cost gate) |
| `no-secrets.scenario.yaml` | catch hardcoded keys (`no_secrets`, `file_absent`) |
| `no-known-exposure.scenario.yaml` | supply-chain provenance gate (`no_known_exposure` + `exposure-catalog.example.json`) |

> Heads-up: `--concurrency N` runs N headless agents at once, so peak token cost
> and rate-limit pressure scale with N. Default is `1`.
