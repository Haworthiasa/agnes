# Agnes bot eval

Measures how the bot behaves and what it costs, so each change shows whether it helped.

## Tiers

| Tier | What it answers | Model | Where | Run |
|---|---|---|---|---|
| Examples | What should happen | scripted | `test/eval-*.test.ts`, `test/eval/checks.ts` | `./test.sh` |
| Properties | What must never happen, for any generated journey (fast-check, fixed seed) | scripted | `test/eval/properties.ts` | `./test.sh` |
| Journeys | The whole user flow: gateway, sessions, tools, scheduler, restart, `/new` | scripted | `test/eval/journeys.ts`, `harness.ts` | `./test.sh` |
| Live | What a real model decides, and its cost, tokens, cache hit rate and step time | real | `scripts/eval/run-live.ts` | manual, spends tokens |

The scripted tiers are deterministic: injected clock, seeded generators, no network, no sleeps. They finish in a few seconds.
Cache hit rate there comes from `test/eval/cache-sim.ts`, which models zai prefix caching (a changed system prompt is
collapsed into the request head; whole blocks of 64 tokens). Faux does not collapse system messages, so it cannot show
that break. The live tier shows the real numbers and tells whether the simulator has drifted.

## Commands (from `packages/bot`)

```
node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-deterministic.ts [--compare eval/baselines/deterministic.json] [--save-baseline]
node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-live.ts --dry-run
node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-live.ts [--repeats 3] [--budget-usd 0.5] [--compare eval/baselines/live.json] [--save-baseline]
```

Each run writes `eval/results/<time>-<sha>/report.md` and `report.json` (ignored by git). `eval/baselines/` holds the
reports to compare against (tracked). Save a new baseline only after a change is reviewed.

## Reading a report

- Checks: example checks and properties. `EXPECTED-FAIL` marks a behavior a later PR builds. When that PR lands, remove its
  `expectFail` flag; an expected failure that passes is reported as `FAIL` so the flag cannot go stale.
- Metrics: model calls, prompt tokens split into uncached, cache read and cache write, cache hit rate, system messages per
  transcript, prefix breaks, cost, step time.
- Cost is recomputed from the price saved in the report. The provider's own figure is shown beside it.
- Comparison: scripted tiers are exact, so any difference counts. Live runs need at least 3 repeats, and a change counts only
  beyond 2 pooled standard deviations. Step time with 3 repeats is mostly noise; read p50 and p95, not one run.

## Rules

- Live runs use `promptSalt`, so separate runs never share a provider cache.
- The live tier never runs in `./test.sh` or CI.
- A behavior of the scripted model is a stand-in. It tests wiring, not what a real model would decide.
