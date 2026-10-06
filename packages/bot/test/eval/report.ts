import type { Series } from "./guardrails.ts";
import type { JourneyResult } from "./harness.ts";
import { compareSamples, type Verdict } from "./stats.ts";

export interface CheckResult {
	name: string;
	/** `expected-fail` marks a behavior that is not built yet; it flips to `pass` when the feature lands. */
	status: "pass" | "fail" | "expected-fail";
	/** Cases run and seed, or the shrunk counterexample when a property fails. */
	detail?: string;
}

export interface RunMeta {
	sha: string;
	dirty: boolean;
	tier: string;
	profile: string;
	seed: number | null;
	startedAt: string;
	durationMs: number;
	/** What a baseline must share with a run for a comparison to mean anything. Absent in reports saved before it existed. */
	series?: Series;
	/** Characters of the frozen prompt and tool definitions, divided by 4. */
	fixedOverheadTokens?: number;
}

export interface RunReport {
	meta: RunMeta;
	checks: CheckResult[];
	/** Journey results without bulky text, so a report stays small. */
	journeys: Array<Omit<JourneyResult, "sessionPrompts" | "toolSchemas" | "toolDefinitions">>;
}

export function buildReport(meta: RunMeta, checks: CheckResult[], journeys: JourneyResult[]): RunReport {
	return {
		meta,
		checks,
		journeys: journeys.map(
			({ sessionPrompts: _prompts, toolSchemas: _schemas, toolDefinitions: _definitions, ...rest }) => rest,
		),
	};
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function renderMarkdown(report: RunReport): string {
	const { meta } = report;
	const lines: string[] = [
		`# Eval report: ${meta.tier}`,
		"",
		`- Commit: ${meta.sha}${meta.dirty ? " (dirty)" : ""}`,
		`- Provider profile: ${meta.profile}`,
		`- Seed: ${meta.seed ?? "none"}`,
		`- Started: ${meta.startedAt}, took ${(meta.durationMs / 1000).toFixed(1)} s`,
		"",
		"## Checks",
		"",
		...report.checks.map(
			(check) => `- ${check.status.toUpperCase()}: ${check.name}${check.detail ? ` [${check.detail}]` : ""}`,
		),
		"",
		"## Metrics per journey",
		"",
		"| Journey | Turns | Model calls | Prompt tokens | Cached | Cache hit | System msgs | Prefix breaks | Bot CPU ms |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const { id, totals } of report.journeys) {
		lines.push(
			`| ${id} | ${totals.turns} | ${totals.modelCalls} | ${totals.promptTokens} | ${totals.cachedTokens} | ${percent(totals.cacheHitRate)} | ${totals.systemMessages} | ${totals.prefixBreaks} | ${totals.cpuMs.toFixed(0)} |`,
		);
	}
	for (const journey of report.journeys) {
		lines.push("", `## Behavior: ${journey.id}`, "", journey.description, "");
		lines.push(
			"| Turn | Step | Input | Calls | Cached/Prompt | System msgs added | Tools |",
			"|---|---|---|---|---|---|---|",
		);
		for (const turn of journey.turns) {
			const input = turn.user.length > 36 ? `${turn.user.slice(0, 33)}...` : turn.user;
			lines.push(
				`| ${turn.index} | ${turn.kind} | ${input.replace(/\|/g, "/")} | ${turn.modelCalls} | ${turn.cachedTokens}/${turn.promptTokens} | ${turn.systemMessagesAdded} | ${turn.toolCalls.join(", ") || "-"} |`,
			);
		}
		lines.push("", "Memory at the end:");
		for (const [chat, files] of Object.entries(journey.memory)) {
			lines.push(`- chat ${chat}: USER=${JSON.stringify(files.user)} MEMORY=${JSON.stringify(files.memory)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export interface ComparisonRow {
	journey: string;
	metric: string;
	before: number;
	after: number;
	verdict: Verdict;
}

const METRICS: Array<{ name: string; lowerIsBetter: boolean; pick: (totals: JourneyResult["totals"]) => number }> = [
	{ name: "cache hit rate", lowerIsBetter: false, pick: (totals) => totals.cacheHitRate },
	{ name: "uncached prompt tokens", lowerIsBetter: true, pick: (totals) => totals.uncachedTokens },
	{ name: "model calls", lowerIsBetter: true, pick: (totals) => totals.modelCalls },
	{ name: "system messages", lowerIsBetter: true, pick: (totals) => totals.systemMessages },
	{ name: "prefix breaks", lowerIsBetter: true, pick: (totals) => totals.prefixBreaks },
];

/** Compares two deterministic reports journey by journey. The scripted tiers have no noise, so any difference counts. */
export function compareReports(before: RunReport, after: RunReport): ComparisonRow[] {
	const rows: ComparisonRow[] = [];
	for (const journey of after.journeys) {
		const base = before.journeys.find((candidate) => candidate.id === journey.id);
		if (!base) continue;
		for (const metric of METRICS) {
			const a = metric.pick(base.totals);
			const b = metric.pick(journey.totals);
			rows.push({
				journey: journey.id,
				metric: metric.name,
				before: a,
				after: b,
				verdict: compareSamples([a], [b], metric.lowerIsBetter, true),
			});
		}
	}
	return rows;
}

export function renderComparison(rows: ComparisonRow[]): string {
	const lines = ["| Journey | Metric | Before | After | Verdict |", "|---|---|---|---|---|"];
	for (const row of rows) {
		const format = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(3));
		lines.push(`| ${row.journey} | ${row.metric} | ${format(row.before)} | ${format(row.after)} | ${row.verdict} |`);
	}
	return `${lines.join("\n")}\n`;
}
