import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareReports, type RunReport } from "./eval/report.ts";
import { compareSamples, mean, percentile, stdev } from "./eval/stats.ts";

describe("stats", () => {
	it("computes mean, spread and percentiles", () => {
		expect(mean([1, 2, 3])).toBe(2);
		expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
		expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
		expect(stdev([5])).toBe(0);
	});

	it("calls a live change real only beyond 2 pooled standard deviations with 3 or more runs", () => {
		expect(compareSamples([100, 102, 98], [60, 62, 58], true)).toBe("improved");
		expect(compareSamples([100, 110, 90], [95, 105, 85], true)).toBe("no significant change");
		expect(compareSamples([100, 102], [60, 62], true)).toBe("no significant change");
	});

	it("treats any difference as real in a deterministic tier", () => {
		expect(compareSamples([10], [9], true, true)).toBe("improved");
		expect(compareSamples([0.4], [0.8], false, true)).toBe("improved");
		expect(compareSamples([7], [7], true, true)).toBe("no significant change");
	});

	it("property: swapping the arms swaps improved and regressed", () => {
		const samples = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 3, maxLength: 8 });
		fc.assert(
			fc.property(samples, samples, fc.boolean(), (a, b, lowerIsBetter) => {
				const forward = compareSamples(a, b, lowerIsBetter);
				const backward = compareSamples(b, a, lowerIsBetter);
				const flip = {
					improved: "regressed",
					regressed: "improved",
					"no significant change": "no significant change",
				} as const;
				expect(backward).toBe(flip[forward]);
			}),
			{ seed: 1 },
		);
	});

	it("property: identical samples never count as a change", () => {
		fc.assert(
			fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 8 }), (a) => {
				expect(compareSamples(a, [...a], true)).toBe("no significant change");
				expect(compareSamples(a, [...a], false, true)).toBe("no significant change");
			}),
			{ seed: 2 },
		);
	});
});

const journeyTotals = (cacheHitRate: number, uncachedTokens: number) => ({
	turns: 3,
	modelCalls: 3,
	promptTokens: 1000,
	cachedTokens: 1000 - uncachedTokens,
	uncachedTokens,
	cacheHitRate,
	systemMessages: 3,
	prefixBreaks: 2,
	cpuMs: 1,
});

const report = (totals: ReturnType<typeof journeyTotals>): RunReport => ({
	meta: { sha: "x", dirty: false, tier: "t", profile: "zai", seed: null, startedAt: "", durationMs: 0 },
	checks: [],
	journeys: [{ id: "j", description: "", profile: "zai", turns: [], totals, memory: {}, toolNames: [] }],
});

describe("report comparison", () => {
	it("marks a higher cache hit rate and fewer uncached tokens as improved", () => {
		const rows = compareReports(report(journeyTotals(0.3, 700)), report(journeyTotals(0.8, 200)));
		expect(rows.find((row) => row.metric === "cache hit rate")?.verdict).toBe("improved");
		expect(rows.find((row) => row.metric === "uncached prompt tokens")?.verdict).toBe("improved");
		expect(rows.find((row) => row.metric === "model calls")?.verdict).toBe("no significant change");
	});

	it("marks a lower cache hit rate as regressed", () => {
		const rows = compareReports(report(journeyTotals(0.8, 200)), report(journeyTotals(0.3, 700)));
		expect(rows.find((row) => row.metric === "cache hit rate")?.verdict).toBe("regressed");
	});
});
