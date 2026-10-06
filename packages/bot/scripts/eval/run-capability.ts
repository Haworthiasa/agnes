#!/usr/bin/env node
// Plays the capability tasks (eval/tasks/<category>/<id>.json) against a real model, grades each trial and reports the
// capability score (OEC), reliability (pass^k) and the guardrails. It spends real tokens. Use --dry-run first.
//
// Run from packages/bot:
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-capability.ts --dry-run
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-capability.ts [--agent-model zai/glm-5.3-flash] [--grader-model zai/glm-5.3-flash] [--trials 3] [--category memory] [--task memory-save-fact] [--exclude-held-out] [--compare eval/baselines/capability.json --kind feature --target-category memory] [--save-baseline]
//
// With --compare, the baseline must be in the same series (models, task catalog, cache profile, thinking level);
// otherwise the run exits 2 before it spends anything. With --kind, the run prints `OVERALL: <verdict>` and exits 1 on
// `worse` or `no-gain`. A feature needs --target-category: the one category it must raise.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type CapabilityReport,
	compareCapability,
	renderCapabilityMarkdown,
	runTrial,
	summarize,
	type TrialResult,
} from "../../test/eval/capability.ts";
import { createJudge, loadCalibrated } from "../../test/eval/graders.ts";
import {
	appendLedger,
	assertSameSeries,
	type PrKind,
	scenarioHashOf,
	type Series,
	seriesOf,
} from "../../test/eval/guardrails.ts";
import { priceOf } from "../../test/eval/live.ts";
import { measureFixedOverhead } from "../../test/eval/overhead.ts";
import { CATEGORIES, type Category, loadTasks, validateCatalog } from "../../test/eval/tasks.ts";

const { values: flags } = parseArgs({
	options: {
		"agent-model": { type: "string", default: "zai/glm-5.3-flash" },
		"grader-model": { type: "string", default: "zai/glm-5.3-flash" },
		trials: { type: "string", default: "3" },
		category: { type: "string" },
		task: { type: "string" },
		"exclude-held-out": { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		compare: { type: "string" },
		kind: { type: "string" },
		"target-category": { type: "string" },
		"save-baseline": { type: "boolean", default: false },
	},
});
const botRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: botRoot, encoding: "utf8" }).trim();
const trialCount = Number(flags.trials);
if (!Number.isInteger(trialCount) || trialCount < 1) throw new Error("--trials is a whole number of 1 or more.");

const kind = flags.kind as PrKind | undefined;
if (kind !== undefined && kind !== "feature" && kind !== "optimization") throw new Error("--kind is feature or optimization.");
if (kind && !flags.compare) throw new Error("--kind needs --compare: a verdict compares a run with a baseline.");
const targetCategory = flags["target-category"] as Category | undefined;
if (targetCategory !== undefined && !CATEGORIES.includes(targetCategory)) {
	throw new Error(`--target-category is one of ${CATEGORIES.join(", ")}.`);
}
if (kind === "feature" && !targetCategory) {
	throw new Error("A feature needs --target-category: a gain in one category can hide inside the OEC interval.");
}

const catalog = loadTasks();
const problems = validateCatalog(catalog);
if (problems.length > 0) process.stderr.write(`Catalog problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
const tasks = catalog
	.filter((task) => !flags.category || task.category === flags.category)
	.filter((task) => !flags.task || flags.task.split(",").includes(task.id))
	.filter((task) => !(flags["exclude-held-out"] && task.heldOut));
if (tasks.length === 0) throw new Error("No task matches the filters.");

const modelRuntime = await ModelRuntime.create();
function resolveModel(name: string): Model<Api> {
	const [provider, ...rest] = name.split("/");
	const model = modelRuntime.getModel(provider ?? "", rest.join("/"));
	if (!model) throw new Error(`Unknown model ${name}.`);
	return model;
}
const agentModel = resolveModel(flags["agent-model"] as string);
const graderModel = resolveModel(flags["grader-model"] as string);
const price = priceOf(agentModel);
const series: Series = {
	agentModel: price.model,
	graderModel: priceOf(graderModel).model,
	// The hash covers the whole catalog, so a --task or --category subset still compares with a full baseline.
	scenarioHash: scenarioHashOf(catalog),
	cacheProfile: "provider",
	thinkingLevel: "default",
};
const before = flags.compare
	? (JSON.parse(readFileSync(resolve(botRoot, flags.compare), "utf8")) as CapabilityReport)
	: undefined;
if (before) {
	try {
		assertSameSeries(seriesOf(before.meta), series);
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(2);
	}
}

// The estimate: about 2.5 agent calls per trial (a tool call and a final answer, sometimes more), 3600 prompt tokens
// per call as measured on the frozen prompt, billed uncached, plus 150 output tokens. Treat it as a floor.
const AGENT_CALLS_PER_TRIAL = 2.5;
const PROMPT_TOKENS_PER_CALL = 3600;
const OUTPUT_TOKENS_PER_CALL = 150;
const agentCalls = Math.round(tasks.length * trialCount * AGENT_CALLS_PER_TRIAL);
const rubrics = tasks.reduce((total, task) => total + task.graders.filter((grader) => grader.kind === "rubric").length, 0);
const judgeCalls = rubrics * trialCount;
const estimatedUsd =
	(agentCalls * (PROMPT_TOKENS_PER_CALL * price.inputPerM + OUTPUT_TOKENS_PER_CALL * price.outputPerM)) / 1_000_000;
process.stdout.write(
	`${price.model}: ${tasks.length} tasks x ${trialCount} trials, about ${agentCalls} agent calls and ${judgeCalls} judge calls, estimated agent floor $${estimatedUsd.toFixed(4)}.\n`,
);
for (const category of CATEGORIES) {
	const own = tasks.filter((task) => task.category === category);
	if (own.length > 0) process.stdout.write(`  ${category}: ${own.map((task) => task.id).join(", ")}\n`);
}
if (flags["dry-run"]) process.exit(0);

for (const model of [agentModel, graderModel]) {
	if (!(await modelRuntime.checkAuth(model.provider))) throw new Error(`No credentials for ${model.provider}.`);
}

const startedAt = new Date();
const dir = join(botRoot, "eval", "results", `${startedAt.toISOString().replace(/[:.]/g, "-")}-capability-${git("rev-parse", "--short", "HEAD")}`);
mkdirSync(dir, { recursive: true });
const judge = rubrics > 0 ? createJudge({ modelRuntime, model: graderModel }) : undefined;
const calibrated = loadCalibrated();
const trials: TrialResult[] = [];
// Trials are the outer loop, so an interrupted run still leaves every task with the same number of trials.
for (let trial = 1; trial <= trialCount; trial++) {
	for (const task of tasks) {
		const result = await runTrial(task, trial, {
			modelRuntime,
			model: agentModel,
			judge,
			calibrated,
			transcriptDir: join(dir, "transcripts"),
		});
		trials.push(result);
		process.stdout.write(
			`trial ${trial}/${trialCount} ${task.id}: ${result.pass ? "pass" : "FAIL"} score ${result.score.toFixed(2)}${result.error ? ` error ${result.error}` : ""}\n`,
		);
	}
}

const report: CapabilityReport = {
	meta: {
		sha: git("rev-parse", "--short", "HEAD"),
		dirty: git("status", "--porcelain", "--", ".").length > 0,
		agentModel: price.model,
		graderModel: series.graderModel,
		trials: trialCount,
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
		series,
		fixedOverheadTokens: await measureFixedOverhead(),
		price,
		filters: { category: flags.category, task: flags.task, excludeHeldOut: flags["exclude-held-out"] ?? false },
	},
	trials,
};
writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);

const comparison = before ? compareCapability(before, report, { kind, targetCategory }) : undefined;
const markdown = renderCapabilityMarkdown(report, comparison, flags.compare);
writeFileSync(join(dir, "report.md"), markdown);
process.stdout.write(`\n${markdown}\nReport: ${dir}\n`);

if (flags["save-baseline"]) {
	const target = join(botRoot, "eval", "baselines", "capability.json");
	writeFileSync(target, `${JSON.stringify(report, null, "\t")}\n`);
	const summary = summarize(trials);
	appendLedger({
		date: startedAt.toISOString().slice(0, 10),
		sha: report.meta.sha,
		kind: "baseline",
		series,
		oec: summary.oec.mean,
		fixedOverheadTokens: report.meta.fixedOverheadTokens ?? null,
		cuPerTurnByJourney: Object.fromEntries(summary.tasks.map((task) => [task.id, task.cuPerTurn])),
	});
	process.stdout.write(`Baseline saved: ${target}\n`);
}
if (comparison?.verdict && comparison.verdict.verdict !== "better") process.exitCode = 1;
