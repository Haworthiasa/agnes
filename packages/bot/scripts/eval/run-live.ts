#!/usr/bin/env node
// Plays the eval journeys against a real model and reports cost, tokens, cache hit rate, step time and what the
// model decided. It spends real tokens. Use --dry-run first, and keep --budget-usd low.
//
// Run from packages/bot:
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-live.ts --dry-run
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-live.ts [--model zai/glm-5.3-flash] [--repeats 3] [--journeys j1-new-user,j2-returning-user] [--budget-usd 0.5] [--compare eval/baselines/live.json] [--kind feature|optimization --affected j8-skill-routine] [--save-baseline]
//
// With --compare, the baseline must be in the same series (model, scenarios, cache profile, thinking level);
// otherwise the run exits 2 before it spends anything. With --kind, the run prints `OVERALL: <verdict>` and exits 1
// on `worse` or `no-gain`. --affected lists the journeys the change targets; every other journey is a guardrail.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	assertSameSeries,
	POLICY,
	type PrKind,
	readLedger,
	type Series,
	scenarioHashOf,
	seriesOf,
	verdict,
} from "../../test/eval/guardrails.ts";
import { JOURNEYS } from "../../test/eval/journeys.ts";
import { measureFixedOverhead } from "../../test/eval/overhead.ts";
import { type LiveRun, priceOf, runLiveJourney } from "../../test/eval/live.ts";
import {
	buildLiveReport,
	compareLiveReports,
	type LiveReport,
	liveComparison,
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
		kind: { type: "string" },
		affected: { type: "string" },
	},
});
const botRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: botRoot, encoding: "utf8" }).trim();
const repeats = Number(flags.repeats);
const budget = Number(flags["budget-usd"]);
const wanted = flags.journeys?.split(",");
const kind = flags.kind as PrKind | undefined;
if (kind !== undefined && kind !== "feature" && kind !== "optimization") throw new Error("--kind is feature or optimization.");
if (kind && !flags.compare) throw new Error("--kind needs --compare: a verdict compares a run with a baseline.");
const journeys = JOURNEYS.filter((journey) => !wanted || wanted.includes(journey.id));

const modelRuntime = await ModelRuntime.create();
const [provider, ...rest] = (flags.model as string).split("/");
const model = modelRuntime.getModel(provider ?? "", rest.join("/"));
if (!model) throw new Error(`Unknown model ${flags.model}.`);
const price = priceOf(model);
// The scenario hash covers every journey, so a --journeys subset still compares with a full baseline.
const series: Series = {
	agentModel: price.model,
	graderModel: "none",
	scenarioHash: scenarioHashOf(JOURNEYS),
	cacheProfile: "provider",
	thinkingLevel: "default",
};
const before = flags.compare ? (JSON.parse(readFileSync(resolve(botRoot, flags.compare), "utf8")) as LiveReport) : undefined;
if (before) {
	try {
		assertSameSeries(seriesOf(before.meta), series);
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(2);
	}
}

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

// The prompt and the tool definitions do not depend on the model, so the scripted tier measures them without a call.
const overhead = await measureFixedOverhead();

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
if (before) {
	process.stdout.write(`\n## Comparison with ${flags.compare} (${before.meta.sha})\n\n${renderLiveComparison(compareLiveReports(before, report))}`);
}
let exitCode = 0;
if (before && kind) {
	const reference = readLedger().find((entry) => entry.sha === POLICY.fixedOverhead.referenceSha)?.fixedOverheadTokens ?? undefined;
	const result = verdict(
		kind,
		liveComparison(before, report, {
			turnsByJourney: Object.fromEntries(JOURNEYS.map((journey) => [journey.id, journey.steps.length])),
			affected: flags.affected?.split(",") ?? [],
			fixedOverheadReference: reference,
		}),
	);
	process.stdout.write(`\nOVERALL: ${result.verdict}\n${result.reasons.map((reason) => `- ${reason}`).join("\n")}\n`);
	if (reference === undefined) process.stdout.write(`- fixed overhead cap not checked: the ledger has no row for ${POLICY.fixedOverhead.referenceSha}\n`);
	if (result.verdict !== "better") exitCode = 1;
}
if (flags["save-baseline"]) {
	const target = join(botRoot, "eval", "baselines", "live.json");
	writeFileSync(target, `${JSON.stringify(report, null, "\t")}\n`);
	process.stdout.write(`Baseline saved: ${target}\n`);
}
process.exitCode = exitCode;
