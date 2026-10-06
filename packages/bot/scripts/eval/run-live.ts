#!/usr/bin/env node
// Plays the eval journeys against a real model and reports cost, tokens, cache hit rate, step time and what the
// model decided. It spends real tokens. Use --dry-run first, and keep --budget-usd low.
//
// Run from packages/bot:
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-live.ts --dry-run
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-live.ts [--model zai/glm-5.3-flash] [--repeats 3] [--journeys j1-new-user,j2-returning-user] [--budget-usd 0.5] [--compare eval/baselines/live.json] [--save-baseline]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { JOURNEYS } from "../../test/eval/journeys.ts";
import { type LiveRun, priceOf, runLiveJourney } from "../../test/eval/live.ts";
import {
	buildLiveReport,
	compareLiveReports,
	type LiveReport,
	renderLiveComparison,
	renderLiveMarkdown,
} from "../../test/eval/live-report.ts";
import type { RunReport } from "../../test/eval/report.ts";

const { values: flags } = parseArgs({
	options: {
		model: { type: "string", default: "zai/glm-5.3-flash" },
		repeats: { type: "string", default: "3" },
		journeys: { type: "string" },
		"budget-usd": { type: "string", default: "0.5" },
		"dry-run": { type: "boolean", default: false },
		"save-baseline": { type: "boolean", default: false },
		compare: { type: "string" },
	},
});
const botRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: botRoot, encoding: "utf8" }).trim();
const repeats = Number(flags.repeats);
const budget = Number(flags["budget-usd"]);
const wanted = flags.journeys?.split(",");
const journeys = JOURNEYS.filter((journey) => !wanted || wanted.includes(journey.id));

const modelRuntime = await ModelRuntime.create();
const [provider, ...rest] = (flags.model as string).split("/");
const model = modelRuntime.getModel(provider ?? "", rest.join("/"));
if (!model) throw new Error(`Unknown model ${flags.model}.`);
const price = priceOf(model);

// The estimate reuses the deterministic baseline: its prompt tokens per journey, billed uncached, plus a guess of
// 150 output tokens per model call. A real model may call tools more often, so treat it as a floor.
const OUTPUT_TOKENS_PER_CALL = 150;
const baseline = JSON.parse(readFileSync(join(botRoot, "eval/baselines/deterministic.json"), "utf8")) as RunReport;
let estimatedCalls = 0;
let estimatedUsd = 0;
for (const journey of journeys) {
	const totals = baseline.journeys.find((candidate) => candidate.id === journey.id)?.totals;
	if (!totals) continue;
	estimatedCalls += totals.modelCalls * repeats;
	estimatedUsd += (repeats * (totals.promptTokens * price.inputPerM + totals.modelCalls * OUTPUT_TOKENS_PER_CALL * price.outputPerM)) / 1_000_000;
}
process.stdout.write(`${price.model}: ${journeys.length} journeys x ${repeats} repeats, at least ${estimatedCalls} model calls, estimated floor $${estimatedUsd.toFixed(4)} (budget $${budget}).\n`);
if (flags["dry-run"]) process.exit(0);

const auth = await modelRuntime.checkAuth(model.provider);
if (!auth) throw new Error(`No credentials for ${model.provider}.`);

const startedAt = new Date();
const runs: LiveRun[] = [];
let spent = 0;
// Repeats are the outer loop, so a budget stop still leaves every journey with the same number of runs.
outer: for (let repeat = 0; repeat < repeats; repeat++) {
	for (const journey of journeys) {
		const run = await runLiveJourney(journey, { modelRuntime, model });
		runs.push(run);
		spent += run.turns.reduce((total, turn) => total + turn.costComputed, 0);
		process.stdout.write(`repeat ${repeat + 1}/${repeats} ${journey.id}: spent $${spent.toFixed(4)}\n`);
		if (spent > budget) {
			process.stdout.write(`Stopped: spent $${spent.toFixed(4)} is over the budget of $${budget}.\n`);
			break outer;
		}
	}
}

const report: LiveReport = buildLiveReport(
	{
		sha: git("rev-parse", "--short", "HEAD"),
		dirty: git("status", "--porcelain", "--", ".").length > 0,
		model: price.model,
		repeats,
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
		costUsd: spent,
		price,
	},
	runs,
);
const dir = join(botRoot, "eval", "results", `${startedAt.toISOString().replace(/[:.]/g, "-")}-live-${report.meta.sha}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
const markdown = renderLiveMarkdown(report);
writeFileSync(join(dir, "report.md"), markdown);
process.stdout.write(`\n${markdown}\nReport: ${dir}\n`);
if (flags.compare) {
	const before = JSON.parse(readFileSync(resolve(botRoot, flags.compare), "utf8")) as LiveReport;
	process.stdout.write(`\n## Comparison with ${flags.compare} (${before.meta.sha})\n\n${renderLiveComparison(compareLiveReports(before, report))}`);
}
if (flags["save-baseline"]) {
	const target = join(botRoot, "eval", "baselines", "live.json");
	writeFileSync(target, `${JSON.stringify(report, null, "\t")}\n`);
	process.stdout.write(`Baseline saved: ${target}\n`);
}
