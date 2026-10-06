import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const EVAL_DIR = new URL("../../eval/", import.meta.url);

export interface Policy {
	costUnitWeights: CostWeights;
	fixedOverhead: { perFeatureTokens: number; capOverReferenceTokens: number; referenceSha: string };
	nim: { unaffectedCuPerTurn: number; unaffectedTime: number; regressionPassRate: number; optimizationOec: number };
	optimizationGain: { cu: number; time: number; fixedOverhead: number };
	significance: { minRuns: number; pooledSd: number; fisherP: number; bootstrapResamples: number; seed: number };
}

/** The decision thresholds. They live in the repo, so a price change or a model swap never moves history. */
export const POLICY: Policy = JSON.parse(readFileSync(new URL("policy.json", EVAL_DIR), "utf8"));

export interface CostWeights {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

export interface Usage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

/** Cost units (CU): uncached input + 0.2 x cache read + 1.25 x cache write + 4 x output, with the weights in policy.json. */
export function costUnits(usage: Usage, weights: CostWeights = POLICY.costUnitWeights): number {
	return (
		usage.input * weights.input +
		usage.cacheRead * weights.cacheRead +
		usage.cacheWrite * weights.cacheWrite +
		usage.output * weights.output
	);
}

/** What a baseline and a run must share for a comparison to mean anything. */
export interface Series {
	/** `provider/model`, or `scripted` for the deterministic tier. */
	agentModel: string;
	/** `provider/model` of the LLM judge, or `none`. */
	graderModel: string;
	/** Hash of the journeys or tasks played. A changed scenario starts a new series. */
	scenarioHash: string;
	cacheProfile: string;
	thinkingLevel: string;
}

export function scenarioHashOf(scenario: unknown): string {
	return createHash("sha256").update(JSON.stringify(scenario)).digest("hex").slice(0, 12);
}

interface SeriesSource {
	series?: Series;
	/** Live reports saved before series existed. */
	model?: string;
	/** Deterministic reports saved before series existed. */
	profile?: string;
}

/**
 * The series of a report. A report saved before series existed is legacy: only the fields it implies are known,
 * and assertSameSeries compares only the fields both sides know.
 */
export function seriesOf(meta: SeriesSource): Partial<Series> {
	if (meta.series) return meta.series;
	if (meta.model) return { agentModel: meta.model };
	return { agentModel: "scripted", cacheProfile: meta.profile };
}

const SERIES_FIELDS: Array<keyof Series> = [
	"agentModel",
	"graderModel",
	"scenarioHash",
	"cacheProfile",
	"thinkingLevel",
];

export function assertSameSeries(before: Partial<Series>, after: Partial<Series>): void {
	const differing = SERIES_FIELDS.flatMap((field) => {
		const a = before[field];
		const b = after[field];
		return a !== undefined && b !== undefined && a !== b ? [`${field} (${a} vs ${b})`] : [];
	});
	if (differing.length === 0) return;
	throw new Error(
		`The baseline and this run are in different series: ${differing.join(", ")}. ` +
			"Run the current commit on the new model and save that as the baseline of the new series.",
	);
}

/** Characters of the frozen system prompt plus the tool definitions, divided by 4. Characters, because tokenizers differ. */
export function fixedOverheadTokens(prompt: string, toolDefinitions: Record<string, string>): number {
	const characters = Object.values(toolDefinitions).reduce((total, json) => total + json.length, prompt.length);
	return Math.ceil(characters / 4);
}

export type PrKind = "feature" | "optimization";
export type VerdictName = "better" | "worse" | "no-gain";

export interface Comparison {
	/** The quantity a feature must raise: mean paired difference and the lower bound of its interval. */
	gain?: { delta: number; lower: number };
	/** The OEC difference, for an optimization. Absent when the run has no capability suite. */
	oec?: { delta: number; lower: number };
	/** Regression tasks whose pass rate fell with a Fisher p below the policy limit. */
	regressionDrops: number;
	/** Relative change of CU per turn over the journeys or tasks the change does not target: 0.127 is +12.7%. */
	unaffectedCuPerTurnChange: number;
	/** Relative change of step time over the same journeys or tasks. */
	unaffectedTimeChange: number;
	/** Fixed prompt overhead in tokens. `reference` is the value at policy.fixedOverhead.referenceSha, when known. */
	fixedOverhead?: { before: number; after: number; reference?: number };
}

export interface VerdictResult {
	verdict: VerdictName;
	reasons: string[];
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** What an optimization must lower. Defaults to CU per turn, as in the policy. */
export type OptimizationTarget = "cu" | "time" | "fixedOverhead";

export function verdict(
	kind: PrKind,
	comparison: Comparison,
	target: OptimizationTarget = "cu",
	policy: Policy = POLICY,
): VerdictResult {
	const worse: string[] = [];
	const { nim, fixedOverhead } = policy;
	if (comparison.regressionDrops > nim.regressionPassRate) {
		worse.push(`${comparison.regressionDrops} regression task(s) dropped in pass rate`);
	}
	if (comparison.unaffectedCuPerTurnChange > nim.unaffectedCuPerTurn) {
		worse.push(
			`CU per turn rose ${percent(comparison.unaffectedCuPerTurnChange)}, over the limit of ${percent(nim.unaffectedCuPerTurn)}`,
		);
	}
	if (comparison.unaffectedTimeChange > nim.unaffectedTime) {
		worse.push(
			`step time rose ${percent(comparison.unaffectedTimeChange)}, over the limit of ${percent(nim.unaffectedTime)}`,
		);
	}
	const overhead = comparison.fixedOverhead;
	if (overhead) {
		if (kind === "feature" && overhead.after - overhead.before > fixedOverhead.perFeatureTokens) {
			worse.push(
				`fixed overhead grew ${overhead.after - overhead.before} tokens, over the limit of ${fixedOverhead.perFeatureTokens} per feature`,
			);
		}
		if (
			overhead.reference !== undefined &&
			overhead.after > overhead.reference + fixedOverhead.capOverReferenceTokens
		) {
			worse.push(
				`fixed overhead ${overhead.after} tokens is over the cap of ${overhead.reference + fixedOverhead.capOverReferenceTokens} (${fixedOverhead.referenceSha} + ${fixedOverhead.capOverReferenceTokens})`,
			);
		}
	}

	if (kind === "feature") {
		if (worse.length > 0) return { verdict: "worse", reasons: worse };
		if (!comparison.gain) return { verdict: "no-gain", reasons: ["no gain measurement for the feature"] };
		if (comparison.gain.lower > 0) {
			return {
				verdict: "better",
				reasons: [
					`gain ${comparison.gain.delta.toFixed(3)}, interval lower bound ${comparison.gain.lower.toFixed(3)} is above 0`,
				],
			};
		}
		return {
			verdict: "no-gain",
			reasons: [
				`gain ${comparison.gain.delta.toFixed(3)}, interval lower bound ${comparison.gain.lower.toFixed(3)} is not above 0`,
			],
		};
	}

	if (comparison.oec && comparison.oec.lower <= -nim.optimizationOec) {
		worse.push(`OEC lower bound ${comparison.oec.lower.toFixed(3)} is at or below -${nim.optimizationOec}`);
	}
	if (worse.length > 0) return { verdict: "worse", reasons: worse };
	const fell = optimizationFall(target, comparison);
	const needed = policy.optimizationGain[target];
	if (fell >= needed)
		return { verdict: "better", reasons: [`${target} fell ${percent(fell)}, at least ${percent(needed)}`] };
	return {
		verdict: "no-gain",
		reasons: [`${target} fell ${percent(fell)}, less than the ${percent(needed)} an optimization needs`],
	};
}

function optimizationFall(target: OptimizationTarget, comparison: Comparison): number {
	if (target === "cu") return -comparison.unaffectedCuPerTurnChange;
	if (target === "time") return -comparison.unaffectedTimeChange;
	const overhead = comparison.fixedOverhead;
	return overhead && overhead.before > 0 ? (overhead.before - overhead.after) / overhead.before : 0;
}

export interface LedgerEntry {
	date: string;
	sha: string;
	kind: PrKind | "baseline";
	series: Series;
	/** Capability score; null before the capability suite exists. */
	oec: number | null;
	fixedOverheadTokens: number | null;
	cuPerTurnByJourney: Record<string, number>;
}

export const LEDGER_PATH = new URL("ledger.json", EVAL_DIR);

export function readLedger(path: URL = LEDGER_PATH): LedgerEntry[] {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LedgerEntry[]) : [];
}

export function appendLedger(entry: LedgerEntry, path: URL = LEDGER_PATH): void {
	writeFileSync(path, `${JSON.stringify([...readLedger(path), entry], null, "\t")}\n`);
}
