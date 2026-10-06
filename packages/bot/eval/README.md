# Agnes bot eval

Measures how the bot behaves and what it costs, so each change shows whether it helped.

There are two questions, and the eval keeps them apart:

- **Does the agent do the right thing?** The capability suite answers it. Its main number is the capability score (OEC).
- **What does it cost, and did anything break?** The scripted tiers and the live tier answer it. They are the guardrails.

Results over time are in [`HISTORY.md`](HISTORY.md). The run-by-run ledger is `ledger.json`.

## Tiers

| Tier | What it answers | Model | Where | Run |
|---|---|---|---|---|
| Examples | What should happen | scripted | `test/eval-*.test.ts`, `test/eval/checks.ts` | `./test.sh` |
| Properties | What must never happen, for any generated journey (fast-check, fixed seed) | scripted | `test/eval/properties.ts` | `./test.sh` |
| Journeys | The whole user flow: gateway, sessions, tools, scheduler, restart, `/new` | scripted | `test/eval/journeys.ts`, `harness.ts` | `./test.sh` |
| Solvability | Can a competent agent pass each capability task here, and can a wrong one not? | scripted | `test/eval-solvable.test.ts`, `test/eval/solve.ts` | `./test.sh` |
| Live | Cost, tokens, cache hit rate and step time of the journeys on a real model | real | `scripts/eval/run-live.ts` | manual, spends tokens |
| Capability | What a real model decides, over 44 tasks in 7 categories | real, plus an LLM judge | `scripts/eval/run-capability.ts`, `eval/tasks/` | manual, spends tokens |

The scripted tiers are deterministic: injected clock, seeded generators, no network, no sleeps. They finish in a few seconds.
Cache hit rate there comes from `test/eval/cache-sim.ts`, which models zai prefix caching (a changed system prompt is
collapsed into the request head; whole blocks of 64 tokens). Faux does not collapse system messages, so it cannot show
that break. The live tier shows the real numbers and tells whether the simulator has drifted.

Calibration, measured on the first live baseline (zai/glm-5.3-flash, 3 repeats): the number of system messages added per
journey matches exactly (6, 5, 5). The absolute cache hit rate does not: simulated 33-41%, live 47-52%. Putting tool
declarations first in the simulated request gave 71-73%, so that variant overshoots and was not kept. Use the simulator to
compare two builds (direction and size of a change). Use the live tier for absolute numbers.

## Commands (from `packages/bot`)

```
R="node --import ../coding-agent/src/experimental/source-resolver.ts"

$R scripts/eval/run-deterministic.ts [--compare eval/baselines/deterministic.json] [--save-baseline]

$R scripts/eval/run-live.ts --dry-run
$R scripts/eval/run-live.ts [--repeats 3] [--budget-usd 0.5] [--compare eval/baselines/live.json] [--kind feature|optimization --affected j8-skill-routine] [--save-baseline]

$R scripts/eval/run-capability.ts --dry-run
$R scripts/eval/run-capability.ts [--trials 3] [--category memory] [--task a,b] [--exclude-held-out]
                                  [--agent-model zai/glm-5.3-flash] [--grader-model zai/glm-5.3-flash]
                                  [--compare eval/baselines/capability.json --kind feature --target-category memory]
                                  [--save-baseline]
```

Each run writes `eval/results/<time>-<sha>/report.md` and `report.json` (ignored by git). The capability runner also keeps the
stored sessions of every failed trial under `transcripts/`. `eval/baselines/` holds the reports to compare against
(tracked). Save a new baseline only after a change is reviewed. Always start a live run with `--dry-run`.

## Capability suite

### What a task is

One JSON file per task, `eval/tasks/<category>/<id>.json`, checked by a schema (`test/eval/tasks.ts`). The seven categories
are `memory`, `recall`, `skills`, `time`, `web`, `safety`, `conversation`. Each category has tasks that should act
(`should`) and tasks that should not (`should-not`), easy and hard ones, and about 20% held out (`heldOut`, skipped with
`--exclude-held-out` while tuning prompts, so tuning does not overfit the tasks).

| Field | Meaning |
|---|---|
| `description` | What a good agent does, in one or two sentences. Two experts must give the same pass or fail on it. |
| `setup` | Clock, allowed users, and per chat: saved memory, skills, past sessions, and a canned web (search results by query text, pages by URL). |
| `turns` | What the user does: text, a photo (`fixture-photo`), `new`, `tick`, and `advanceMs` to move the clock. |
| `graders` | How the result is judged (below). |
| `reference` | The state and reply of a perfect run. The graders must pass on it. |
| `needs` | What the environment must give the agent: text in the prompt, in earlier messages, in a tool result, a tool offered, an image. |
| `oracle` | A scripted agent that does the task right. |
| `foil` | A scripted agent that does the forbidden thing. Required for a `should-not` task. |
| `suite` | `regression` once the task is reliable, or when the bot itself guarantees the outcome. |
| `source` | `real-failure`, `manual-check`, `transcript` or `synthetic`. |

The seeding writes state straight into a fresh data directory (`test/eval/seed.ts`): memory through `MemoryStore`, skills
through `SkillStore`, sessions as pi JSONL. A past session is dated `daysAgo` before the task clock and carries the bot's
workspace as its `cwd`, as a real one does. The gateway continues the most recent session of a chat, so a chat with only past
sessions starts with `/new`; without it the seeded fact would already be in the context and `session_search` would skip
the session. A session marked `live` is the opposite: it is part of the current conversation, so the agent has it in context.
The canned web feeds the real `web_search` and `web_fetch` tools through fake backends, and a fake image download. A canned
page must have 200 characters or more: the bot treats a shorter page as a failed read.

### How a trial runs

1. Make a fresh data directory and seed it.
2. Play the turns through the real bot (`drive()`), with the injected clock, a unique `promptSalt` (so no run shares a
   provider cache) and the fixture photo (a real 64x64 PNG).
3. Read tokens, tool calls and failed tool calls from the stored sessions, and the jobs from `jobs.json`.
4. Grade. Keep the sessions of a failed trial.

A trial that throws is recorded with score 0 and the error. The run goes on. The runner is sequential, and trials are the
outer loop, so an interrupted run leaves every task with the same number of trials.

### Graders

Each grader returns a score from 0 to 1, a pass flag and a reason. Prefer state graders, then transcript graders. Grade the
outcome, not the path: a path check is right only where the path is the outcome (cost, a should-not task).

| Type | Kinds |
|---|---|
| State | `memoryMatches`, `memoryLacks`, `memoryUnchanged`, `skillExists`, `skillBodyMatches`, `noSkill`, `jobDue` (once in N minutes, at a local time on a later day, or daily; tolerance 90 s) |
| Transcript | `toolCalled`, `toolNotCalled`, `maxToolCalls`, `noToolErrors`, `replyMatches` (regex, can be negated) |
| Rubric | One question to an LLM judge, one dimension per call |

A grader has a `weight` (default 1) and may be `required`. The task score is the weighted mean. **A trial passes when
every required grader passes and the score is at least 0.8.** Regexes use the Unicode flag; use `(?<!\p{L})…(?!\p{L})` and
not `\b` around Vietnamese words, because `\b` treats an accented letter as a non-word character.

### The judge

A rubric grader asks `--grader-model` (default the same model as the agent) one question. The prompt is fixed text: the
task description, what was seeded, the whole conversation up to the graded turn including the assistant's earlier replies, the
reply to grade, a reference reply, the question and the pass condition. The run is quoted between markers as data.
The judge answers with one JSON object, `{"verdict": "pass" | "fail", "reason": "..."}`. Anything else counts as a fail with
the reason "judge output unreadable".

- It asks at temperature 0 and **reasoning `high`**. glm-5.3-flash always thinks and takes only `low`, `high` or `max`
  (`low` was too weak for a judge with no human to check it).
- Answers are cached on disk (`eval/results/judge-cache/`) by a hash of the model, the reasoning level and the prompt.
- The judge and the agent are the same model by default. A model that grades its own output can favor it, so a rubric
  needs human labels before it counts. **A rubric whose dimension is not marked `calibrated` in
  `eval/calibration/status.json` is graded and shown, but weighs nothing and never gates a trial.** Until a dimension is
  calibrated, every task keeps at least one deterministic grader.
- Calibration: a human labels judge verdicts blind, and a dimension is calibrated when the judge agrees with at least 85%
  of at least 8 labels. The labeling page shows the conversation and the reply and hides the judge's verdict.

### Solvability

An eval task can be wrong in two ways that look like an agent failure: the environment hides what the agent needs, or
nothing can make the task fail. `test/eval-solvable.test.ts` checks both for every task, with no tokens:

- The **oracle** is played through the real bot on the faux provider. Every entry in `needs` must hold on the last model
  request, and every deterministic grader must pass.
- The **foil** is played the same way. It must fail. A `should` task without a foil is tested against an agent that only
  says "Ok.". A task the bot itself guarantees (`suite: regression`) has no foil: no agent can break it.

The test found tasks that no agent could fail: saving an instruction-override text (the threat scan blocks it whatever the
agent does), citing an invented URL (the reply filter removes it), and reading another chat's memory (each chat has its own
folder). They are regression tasks or were redefined.

## How results are measured

- **pass@1 of a task**: the mean score over its trials. **pass^k**: every one of the k trials passed. A personal assistant
  needs pass^k, because it must be right every time.
- **Category score**: the mean task score, with a 95% bootstrap interval over tasks (2000 resamples, seed 20261006).
- **OEC (capability score)**: the mean of the category scores. Its interval resamples the tasks inside each category.
  The categories weigh the same.
- **Reliability**: the mean over categories of the share of tasks with pass^k.
- **Cost units (CU)**: uncached input + 0.2 x cache read + 1.25 x cache write + 4 x output tokens. The weights are in
  `eval/policy.json`, so a price change or a model swap never moves history. USD is still printed.
- **Step time**: the wall time of a turn; read p50 and p95, not one run.
- **Fixed overhead**: characters of the frozen system prompt of a new chat plus every tool definition, divided by 4. Characters,
  because tokenizers differ. It is measured on the scripted tier, so a model is not needed.
- **Flags**: a category at 0.9 or above is `SATURATED: add harder tasks`. A task that passes every trial here and in the baseline,
  and is not yet regression, is a `GRADUATE` candidate: set `"suite": "regression"`.

A capability task starts at a low pass rate and is a hill to climb. A regression task stays near 100%. A capability task that
becomes reliable graduates into the regression suite.

## Series and baselines

A comparison means something only when both runs share a **series**: `agentModel`, `graderModel`, `scenarioHash` (a hash of
the whole task catalog, or of the journeys), `cacheProfile` and `thinkingLevel`. Every report writes it to `meta.series`.
`--compare` stops with exit code 2 before it spends anything when the series differ, and names the fields. After a model swap,
run the current commit on the new model and save that as the baseline of the new series. Editing any task changes the
catalog hash, so it needs a new baseline too. A report saved before series existed is legacy: only the fields it implies
(the model, or `scripted`) are compared.

`eval/ledger.json` gets one row per saved capability baseline: date, commit, series, OEC, fixed overhead, CU per turn of
each task.

## Judging a PR

Say what kind of PR it is. `--kind` prints `OVERALL: better | worse | no-gain` and exits 1 on `worse` or `no-gain`. The limits are
in `eval/policy.json`.

| | `feature` | `optimization` |
|---|---|---|
| Must | The target category's interval lower bound is above 0 (`--target-category`) | CU per turn falls at least 5% (or step time 10%, or fixed overhead 10%) |
| Must not | Another category falls by more than 0.03; CU per turn or step time rises more than 15% on the other tasks; fixed overhead grows more than 500 tokens; a regression task drops | OEC lower bound reaches -0.03; a regression task drops; CU per turn or step time rises more than 15% |

A feature moves one category. Averaged over seven, a real gain can hide inside the OEC interval, so the target
category is the test. A regression task has dropped when its pass rate fell and a one-sided Fisher test gives p below 0.1.
With 3 trials only a fall from 3 of 3 to 0 of 3 is significant, so a drop to 2 of 3 does not count.

Retro cases the verdict rules were checked on (numbers from the live baselines):

| PR | Kind | Fixed overhead | Other CU per turn | Verdict |
|---|---|---|---|---|
| A | optimization | +101 | -14.0% | better |
| B | feature | +441 | +12.7% (one journey +47%) | better |
| C | feature | +253 | +0.4% | better |

The fixed-overhead cap over a reference commit (`68af782c1`, +1500 tokens) is checked only when the ledger has a row for that
commit. It has none yet, so the run prints "cap not checked".

## Workflow

**Before building a feature, add its capability tasks and run them on `main`.** They should pass at a low rate. Then build.
A task written together with the feature passes on day one and measures nothing.

1. Write the tasks, with `needs`, `oracle`, `foil` and `reference`. Run `test/eval-tasks.test.ts` and `test/eval-solvable.test.ts`.
2. Run the suite on `main` and save the baseline (`--save-baseline`).
3. Build the feature. Run with `--compare eval/baselines/capability.json --kind feature --target-category <c>`.
4. Read the failing transcripts before you change a grader. A failure is either the agent's mistake or a grader that rejects a
   valid answer, or an environment that hides what the agent needs. Say which one.

## Reading a report

- Checks: example checks and properties. `EXPECTED-FAIL` marks a behavior a later PR builds. When that PR lands, remove its
  `expectFail` flag; an expected failure that passes is reported as `FAIL` so the flag cannot go stale.
- Metrics: model calls, prompt tokens split into uncached, cache read and cache write, cache hit rate, system messages per
  transcript, prefix breaks, cost, step time.
- Cost is recomputed from the price saved in the report. The provider's own figure is shown beside it.
- Live comparison: a change counts only beyond 2 pooled standard deviations, with at least 3 repeats. Step time with 3 repeats is
  mostly noise.
- Capability report: series and models, agent calls, grader spend, OEC and reliability, a category table, a task table with
  the score of each trial, the failing trials with the reason of each failed grader and the transcript folder, the saturation
  and graduation flags, and the comparison with its `OVERALL` line.

## Rules

- Live runs use `promptSalt`, so separate runs never share a provider cache.
- The live and capability tiers never run in `./test.sh` or CI.
- A behavior of the scripted model is a stand-in. It tests wiring, not what a real model would decide.
- Never put a token, key or password from a real chat into a task. Rewrite what a user said in new words.

## Limits

- The runner is sequential. There is no cap on requests or tokens, no rate limit and no concurrency, because the
  owner runs the zai model without a cap. A provider with limits (OpenRouter `:free`, Groq free) needs them added.
- `significance.minRuns` and `significance.pooledSd` in `policy.json` document the live-comparison rule; the code reads the same
  values from `test/eval/stats.ts`, not from the file.
- The judge is the agent's own model, and no rubric is calibrated yet (see `HISTORY.md`).
- Reference timings on this machine (WSL2): `npm run check` 22-78 s; the eval test files 6-30 s; one live capability run of
  44 tasks x 3 trials about 35 minutes and $0.07.
