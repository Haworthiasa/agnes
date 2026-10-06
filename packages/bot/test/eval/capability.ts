import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBot } from "../../src/bot.ts";
import { FakeTransport } from "../helpers.ts";
import { drive } from "./drive.ts";
import { type GradedGrader, type GradeInput, gradeTrial, type Judge } from "./graders.ts";
import {
	type Comparison,
	costUnits,
	POLICY,
	type PrKind,
	type Series,
	type VerdictResult,
	verdict,
} from "./guardrails.ts";
import { type PriceSnapshot, priceOf, turnRecorder } from "./live.ts";
import { fixturePhoto, readTaskState, seedTask, taskJourney, taskWebBackends } from "./seed.ts";
import { fisherDropP, mean } from "./stats.ts";
import { CATEGORIES, type CapabilityTask, type Category } from "./tasks.ts";

const TIME_ZONE = "Asia/Ho_Chi_Minh";
/** A category at or above this mean score has no room left to show a gain. */
export const SATURATION_SCORE = 0.9;

export interface TrialResult {
	taskId: string;
	category: Category;
	polarity: CapabilityTask["polarity"];
	suite: "capability" | "regression";
	heldOut: boolean;
	trial: number;
	score: number;
	pass: boolean;
	/** Set when the trial could not finish (the bot threw). The score is 0. */
	error?: string;
	graders: GradedGrader[];
	usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
	modelCalls: number;
	/** Cost units per task turn, with the weights in policy.json. */
	cuPerTurn: number;
	/** Mean wall time of a task turn. */
	stepMs: number;
	judgeUsd: number;
	turns: Array<{ user: string; reply: string; toolCalls: string[] }>;
	/** Where the stored sessions of a failed trial were copied. */
	transcriptDir?: string;
}

export interface CapabilityMeta {
	sha: string;
	dirty: boolean;
	agentModel: string;
	graderModel: string;
	trials: number;
	startedAt: string;
	durationMs: number;
	series: Series;
	fixedOverheadTokens?: number;
	price: PriceSnapshot;
	/** The filters the run used, so a partial report is not mistaken for a full one. */
	filters: { category?: string; task?: string; excludeHeldOut: boolean };
}

export interface CapabilityReport {
	meta: CapabilityMeta;
	trials: TrialResult[];
}

export interface TrialOptions {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	judge?: Judge;
	calibrated?: ReadonlySet<string>;
	/** Failed trials copy their stored sessions under `<transcriptDir>/<task>-t<trial>`. */
	transcriptDir?: string;
}

/**
 * Plays one task once on a fresh data directory: seeds it, runs the turns through the real bot with `drive`, grades
 * the result and, when it fails, keeps the stored sessions to read.
 */
export async function runTrial(task: CapabilityTask, trial: number, options: TrialOptions): Promise<TrialResult> {
	const dataDir = mkdtempSync(join(tmpdir(), "agnes-cap-"));
	const price = priceOf(options.model);
	const base = {
		taskId: task.id,
		category: task.category,
		polarity: task.polarity,
		suite: task.suite ?? "capability",
		heldOut: task.heldOut,
		trial,
	} as const;
	try {
		seedTask(task, dataDir);
		const before = readTaskState(task, dataDir);
		const { journey, preludeSteps } = taskJourney(task);
		const clock = { now: journey.start };
		const transport = new FakeTransport();
		const salt = `eval-run ${randomUUID()}`;
		const recorder = turnRecorder(dataDir, price);
		const all = await drive(
			journey,
			{
				start: () =>
					createBot({
						dataDir,
						modelRuntime: options.modelRuntime,
						model: options.model,
						transport,
						allowedUserIds: new Set(journey.users),
						allowShell: false,
						timeZone: TIME_ZONE,
						webBackends: taskWebBackends(task),
						now: () => clock.now,
						promptSalt: salt,
					}),
				transport,
				clock,
				photo: fixturePhoto(),
			},
			recorder.snapshot,
			recorder.finish,
		);
		const turns = all.slice(preludeSteps);
		const input: GradeInput = { task, turns, before, after: readTaskState(task, dataDir), timeZone: TIME_ZONE };
		const graded = await gradeTrial(input, { judge: options.judge, calibrated: options.calibrated });
		const usage = {
			input: sum(turns.map((turn) => turn.input)),
			cacheRead: sum(turns.map((turn) => turn.cacheRead)),
			cacheWrite: sum(turns.map((turn) => turn.cacheWrite)),
			output: sum(turns.map((turn) => turn.output)),
		};
		let transcriptDir: string | undefined;
		if (!graded.pass && options.transcriptDir) {
			transcriptDir = join(options.transcriptDir, `${task.id}-t${trial}`);
			keepSessions(dataDir, transcriptDir);
		}
		return {
			...base,
			score: graded.score,
			pass: graded.pass,
			graders: graded.graders,
			usage,
			modelCalls: sum(turns.map((turn) => turn.modelCalls)),
			cuPerTurn: costUnits(usage) / Math.max(1, turns.length),
			stepMs: mean(turns.map((turn) => turn.wallMs)),
			judgeUsd: sum(graded.graders.map((entry) => entry.judgeCostUsd ?? 0)),
			turns: turns.map((turn) => ({ user: turn.user, reply: turn.reply, toolCalls: turn.toolCalls })),
			transcriptDir,
		};
	} catch (error) {
		return {
			...base,
			score: 0,
			pass: false,
			error: (error as Error).message,
			graders: [],
			usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
			modelCalls: 0,
			cuPerTurn: 0,
			stepMs: 0,
			judgeUsd: 0,
			turns: [],
		};
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function keepSessions(dataDir: string, target: string): void {
	const chats = join(dataDir, "chats");
	if (!existsSync(chats)) return;
	mkdirSync(target, { recursive: true });
	cpSync(chats, target, { recursive: true });
}

// --- Statistics ---------------------------------------------------------------------------------------------------

/** A small seeded generator, so a bootstrap interval is the same on every run. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface Interval {
	mean: number;
	lower: number;
	upper: number;
}

/**
 * The 95% bootstrap interval of the mean over groups. Each group is a list of per-task values. The statistic is the
 * mean of the group means; a resample draws each group's tasks again, with replacement, inside the group. One group
 * gives the plain interval of a mean.
 */
export function bootstrapInterval(
	groups: number[][],
	resamples: number = POLICY.significance.bootstrapResamples,
	seed: number = POLICY.significance.seed,
): Interval {
	const filled = groups.filter((group) => group.length > 0);
	if (filled.length === 0) return { mean: 0, lower: 0, upper: 0 };
	const point = mean(filled.map(mean));
	const random = mulberry32(seed);
	const stats: number[] = [];
	for (let round = 0; round < resamples; round++) {
		stats.push(
			mean(
				filled.map((group) =>
					mean(group.map(() => group[Math.min(group.length - 1, Math.floor(random() * group.length))] as number)),
				),
			),
		);
	}
	stats.sort((a, b) => a - b);
	const at = (fraction: number) => stats[Math.min(stats.length - 1, Math.floor(fraction * stats.length))] as number;
	return { mean: point, lower: at(0.025), upper: at(0.975) };
}

// --- Summary ------------------------------------------------------------------------------------------------------

export interface TaskStat {
	id: string;
	category: Category;
	polarity: CapabilityTask["polarity"];
	suite: "capability" | "regression";
	heldOut: boolean;
	trials: number;
	passes: number;
	/** Mean score over trials. */
	meanScore: number;
	/** pass^k: every trial passed. */
	passAll: boolean;
	cuPerTurn: number;
	stepMs: number;
	scores: number[];
}

export interface CategoryStat {
	category: Category;
	tasks: number;
	meanScore: number;
	lower: number;
	upper: number;
	/** Share of tasks with pass^k. */
	reliability: number;
	saturated: boolean;
}

export interface CapabilitySummary {
	tasks: TaskStat[];
	categories: CategoryStat[];
	/** Capability score: the mean of the category means. */
	oec: Interval;
	/** The mean of the category reliabilities. */
	reliability: number;
	judgeUsd: number;
	modelCalls: number;
	judgeErrors: number;
}

export function summarize(trials: TrialResult[]): CapabilitySummary {
	const ids = [...new Set(trials.map((trial) => trial.taskId))].sort();
	const tasks = ids.map((id): TaskStat => {
		const own = trials.filter((trial) => trial.taskId === id);
		const first = own[0] as TrialResult;
		return {
			id,
			category: first.category,
			polarity: first.polarity,
			suite: first.suite,
			heldOut: first.heldOut,
			trials: own.length,
			passes: own.filter((trial) => trial.pass).length,
			meanScore: mean(own.map((trial) => trial.score)),
			passAll: own.every((trial) => trial.pass),
			cuPerTurn: mean(own.map((trial) => trial.cuPerTurn)),
			stepMs: mean(own.map((trial) => trial.stepMs)),
			scores: own.map((trial) => trial.score),
		};
	});
	const categories = CATEGORIES.flatMap((category): CategoryStat[] => {
		const own = tasks.filter((task) => task.category === category);
		if (own.length === 0) return [];
		const interval = bootstrapInterval([own.map((task) => task.meanScore)]);
		return [
			{
				category,
				tasks: own.length,
				meanScore: interval.mean,
				lower: interval.lower,
				upper: interval.upper,
				reliability: mean(own.map((task) => (task.passAll ? 1 : 0))),
				saturated: interval.mean >= SATURATION_SCORE,
			},
		];
	});
	return {
		tasks,
		categories,
		oec: bootstrapInterval(
			CATEGORIES.map((category) => tasks.filter((task) => task.category === category).map((task) => task.meanScore)),
		),
		reliability: mean(categories.map((category) => category.reliability)),
		judgeUsd: sum(trials.map((trial) => trial.judgeUsd)),
		modelCalls: sum(trials.map((trial) => trial.modelCalls)),
		judgeErrors: sum(trials.map((trial) => trial.graders.filter((entry) => entry.judgeError).length)),
	};
}

// --- Comparison ---------------------------------------------------------------------------------------------------

export interface CategoryDelta {
	category: Category;
	tasks: number;
	delta: Interval;
}

export interface CapabilityComparison {
	/** Mean paired score difference (after minus before) over the tasks both reports ran. */
	oec: Interval;
	categories: CategoryDelta[];
	/** Tasks that pass every trial here and in the baseline and are not yet in the regression suite. */
	graduates: string[];
	/** Regression-suite tasks whose pass rate fell with a Fisher p below the policy limit. */
	regressionDrops: string[];
	/** The numbers `verdict` needs. */
	comparison: Comparison;
	verdict?: VerdictResult;
}

export interface CompareOptions {
	kind?: PrKind;
	/** The category a feature must raise. */
	targetCategory?: Category;
}

const relative = (before: number, after: number) => (before === 0 ? 0 : after / before - 1);

export function compareCapability(
	before: CapabilityReport,
	after: CapabilityReport,
	options: CompareOptions = {},
): CapabilityComparison {
	const was = new Map(summarize(before.trials).tasks.map((task) => [task.id, task]));
	const pairs = summarize(after.trials).tasks.flatMap((now) => {
		const old = was.get(now.id);
		return old ? [{ now, old }] : [];
	});
	const byCategory = (category: Category) => pairs.filter(({ now }) => now.category === category);
	const diff = ({ now, old }: (typeof pairs)[number]) => now.meanScore - old.meanScore;
	const categories = CATEGORIES.flatMap((category): CategoryDelta[] => {
		const own = byCategory(category);
		return own.length === 0 ? [] : [{ category, tasks: own.length, delta: bootstrapInterval([own.map(diff)]) }];
	});
	const oec = bootstrapInterval(CATEGORIES.map((category) => byCategory(category).map(diff)));

	const regressionDrops = pairs
		.filter(
			({ now, old }) =>
				now.suite === "regression" &&
				now.passes < old.passes &&
				fisherDropP(old.passes, old.trials, now.passes, now.trials) < POLICY.significance.fisherP,
		)
		.map(({ now }) => now.id);
	const graduates = pairs
		.filter(({ now, old }) => now.suite !== "regression" && now.passAll && old.passAll)
		.map(({ now }) => now.id);

	// A feature moves one category, so the other tasks are the guardrail. An optimization has no target.
	const target = options.kind === "feature" ? options.targetCategory : undefined;
	const guarded = pairs.filter(({ now }) => now.category !== target);
	const targetDelta = target ? categories.find((entry) => entry.category === target)?.delta : oec;
	const comparison: Comparison = {
		gain: targetDelta && { delta: targetDelta.mean, lower: targetDelta.lower },
		oec: { delta: oec.mean, lower: oec.lower },
		categoryDrops: categories
			.filter((entry) => entry.category !== target && entry.delta.mean < -POLICY.nim.otherCategory)
			.map((entry) => entry.category),
		regressionDrops: regressionDrops.length,
		unaffectedCuPerTurnChange: relative(
			mean(guarded.map(({ old }) => old.cuPerTurn)),
			mean(guarded.map(({ now }) => now.cuPerTurn)),
		),
		unaffectedTimeChange: relative(
			mean(guarded.map(({ old }) => old.stepMs)),
			mean(guarded.map(({ now }) => now.stepMs)),
		),
		fixedOverhead:
			before.meta.fixedOverheadTokens === undefined || after.meta.fixedOverheadTokens === undefined
				? undefined
				: { before: before.meta.fixedOverheadTokens, after: after.meta.fixedOverheadTokens },
	};
	return {
		oec,
		categories,
		graduates,
		regressionDrops,
		comparison,
		verdict: options.kind ? verdict(options.kind, comparison) : undefined,
	};
}

// --- Report -------------------------------------------------------------------------------------------------------

const fixed = (value: number, digits = 2) => value.toFixed(digits);
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
const interval = (value: Interval) => `${fixed(value.mean, 3)} [${fixed(value.lower, 3)}, ${fixed(value.upper, 3)}]`;
const clip = (text: string, length: number) =>
	(text.length > length ? `${text.slice(0, length - 3)}...` : text).replace(/\|/g, "/").replace(/\n/g, " ");

export function renderCapabilityMarkdown(
	report: CapabilityReport,
	comparison?: CapabilityComparison,
	baselineName?: string,
): string {
	const { meta } = report;
	const summary = summarize(report.trials);
	const lines = [
		`# Capability eval report: ${meta.agentModel}`,
		"",
		`- Commit: ${meta.sha}${meta.dirty ? " (dirty)" : ""}`,
		`- Series: ${JSON.stringify(meta.series)}`,
		`- Models: agent ${meta.agentModel}, grader ${meta.graderModel}`,
		`- Trials per task: ${meta.trials}, started ${meta.startedAt}, took ${(meta.durationMs / 1000).toFixed(0)} s`,
		`- Filters: ${JSON.stringify(meta.filters)}`,
		...(meta.fixedOverheadTokens === undefined ? [] : [`- Fixed overhead: ${meta.fixedOverheadTokens} tokens`]),
		`- Agent calls: ${summary.modelCalls}. Grader spend: $${summary.judgeUsd.toFixed(4)}. Judge errors: ${summary.judgeErrors}`,
		"",
		`**OEC (capability score): ${interval(summary.oec)}**`,
		`**Reliability (mean pass^k): ${fixed(summary.reliability, 3)}**`,
		"",
		"## Categories",
		"",
		"| Category | Tasks | Mean score [95% interval] | pass^k | Flag |",
		"|---|---|---|---|---|",
		...summary.categories.map(
			(entry) =>
				`| ${entry.category} | ${entry.tasks} | ${interval({ mean: entry.meanScore, lower: entry.lower, upper: entry.upper })} | ${fixed(entry.reliability, 2)} | ${entry.saturated ? "SATURATED: add harder tasks" : ""} |`,
		),
		"",
		"## Tasks",
		"",
		"| Task | Polarity | Suite | Scores per trial | Mean | pass^k | CU/turn | Step ms |",
		"|---|---|---|---|---|---|---|---|",
		...summary.tasks.map(
			(task) =>
				`| ${task.id}${task.heldOut ? " (held out)" : ""} | ${task.polarity} | ${task.suite} | ${task.scores.map((score) => fixed(score)).join(" / ")} | ${fixed(task.meanScore)} | ${task.passAll ? "yes" : "no"} | ${fixed(task.cuPerTurn, 0)} | ${fixed(task.stepMs, 0)} |`,
		),
	];
	const failed = report.trials.filter((trial) => !trial.pass);
	lines.push("", `## Failing trials (${failed.length} of ${report.trials.length})`);
	for (const trial of failed) {
		lines.push("", `### ${trial.taskId} trial ${trial.trial}: score ${fixed(trial.score)}`);
		if (trial.error) lines.push(`- Error: ${trial.error}`);
		for (const entry of trial.graders) {
			if (!entry.result.pass) {
				const label = entry.grader.kind === "rubric" ? `rubric ${entry.grader.dimension}` : entry.grader.kind;
				lines.push(
					`- ${label}${entry.required ? " (required)" : ""}${entry.judgeError ? " (judge error)" : ""}: ${entry.result.reason}`,
				);
			}
		}
		const last = trial.turns.at(-1);
		if (last) lines.push(`- Last reply: ${clip(last.reply, 200)}`);
		if (trial.transcriptDir) lines.push(`- Transcript: ${trial.transcriptDir}`);
	}
	if (comparison) {
		lines.push(
			"",
			`## Comparison with ${baselineName ?? "the baseline"}`,
			"",
			`OEC change: ${signed(comparison.oec.mean)} [${signed(comparison.oec.lower)}, ${signed(comparison.oec.upper)}]`,
			"",
			"| Category | Paired tasks | Change [95% interval] |",
			"|---|---|---|",
			...comparison.categories.map(
				(entry) =>
					`| ${entry.category} | ${entry.tasks} | ${signed(entry.delta.mean)} [${signed(entry.delta.lower)}, ${signed(entry.delta.upper)}] |`,
			),
			"",
			`- CU per turn change (guarded tasks): ${(comparison.comparison.unaffectedCuPerTurnChange * 100).toFixed(1)}%`,
			`- Step time change (guarded tasks): ${(comparison.comparison.unaffectedTimeChange * 100).toFixed(1)}%`,
			`- Regression tasks that dropped: ${comparison.regressionDrops.join(", ") || "none"}`,
			`- GRADUATE candidates (set "suite": "regression"): ${comparison.graduates.join(", ") || "none"}`,
		);
		if (comparison.verdict) {
			lines.push(
				"",
				`OVERALL: ${comparison.verdict.verdict}`,
				...comparison.verdict.reasons.map((reason) => `- ${reason}`),
			);
		}
	}
	return `${lines.join("\n")}\n`;
}
