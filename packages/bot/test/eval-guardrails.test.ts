import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	appendLedger,
	assertSameSeries,
	type Comparison,
	costUnits,
	fixedOverheadTokens,
	POLICY,
	type PrKind,
	readLedger,
	type Series,
	seriesOf,
	verdict,
} from "./eval/guardrails.ts";
import { type LiveJourneyStats, type LiveReport, liveComparison } from "./eval/live-report.ts";
import { fisherDropP } from "./eval/stats.ts";

const series: Series = {
	agentModel: "zai/glm-5.3-flash",
	graderModel: "none",
	scenarioHash: "abc",
	cacheProfile: "provider",
	thinkingLevel: "default",
};

/** A comparison that is neutral on every guardrail. */
const flat: Comparison = { regressionDrops: 0, unaffectedCuPerTurnChange: 0, unaffectedTimeChange: 0 };

describe("cost units", () => {
	it("weights uncached input 1, cache read 0.2, cache write 1.25 and output 4", () => {
		expect(costUnits({ input: 1000, cacheRead: 5000, cacheWrite: 400, output: 100 })).toBe(1000 + 1000 + 500 + 400);
	});

	it("does not depend on a price", () => {
		expect(costUnits({ input: 10, cacheRead: 0, cacheWrite: 0, output: 0 }, POLICY.costUnitWeights)).toBe(10);
	});
});

describe("series", () => {
	it("accepts identical series", () => {
		expect(() => assertSameSeries(series, { ...series })).not.toThrow();
	});

	it("names the differing field and says how to continue", () => {
		const other = { ...series, agentModel: "groq/qwen", thinkingLevel: "high" };
		expect(() => assertSameSeries(series, other)).toThrow(
			/agentModel \(zai\/glm-5.3-flash vs groq\/qwen\), thinkingLevel/,
		);
		expect(() => assertSameSeries(series, other)).toThrow(/save that as the baseline of the new series/);
	});

	it("derives a legacy live series from the model and compares only what is known", () => {
		const legacy = seriesOf({ model: "zai/glm-5.3-flash" });
		expect(legacy).toEqual({ agentModel: "zai/glm-5.3-flash" });
		expect(() => assertSameSeries(legacy, series)).not.toThrow();
		expect(() => assertSameSeries(legacy, { ...series, agentModel: "x/y" })).toThrow(/agentModel/);
	});

	it("derives a legacy deterministic series as scripted", () => {
		expect(seriesOf({ profile: "zai" })).toEqual({ agentModel: "scripted", cacheProfile: "zai" });
		expect(() =>
			assertSameSeries(seriesOf({ profile: "zai" }), { ...series, agentModel: "scripted", cacheProfile: "zai" }),
		).not.toThrow();
	});

	it("reads a stored series as is", () => {
		expect(seriesOf({ series, model: "ignored" })).toEqual(series);
	});
});

describe("fixed overhead", () => {
	it("counts prompt and tool definition characters divided by 4, rounded up", () => {
		expect(fixedOverheadTokens("a".repeat(40), { x: "b".repeat(21), y: "c".repeat(3) })).toBe(16);
	});
});

describe("verdict", () => {
	it("retro PR A: an optimization that cuts CU per turn 14% is better although the prompt grew 101 tokens", () => {
		const result = verdict("optimization", {
			...flat,
			unaffectedCuPerTurnChange: -0.14,
			fixedOverhead: { before: 2600, after: 2701 },
		});
		expect(result.verdict).toBe("better");
	});

	it("retro PR B: a feature is better at +12.7% CU per turn (one journey +47%) and +441 prompt tokens", () => {
		const result = verdict("feature", {
			...flat,
			gain: { delta: 0.2, lower: 0.05 },
			unaffectedCuPerTurnChange: 0.127,
			fixedOverhead: { before: 2701, after: 3142 },
		});
		expect(result.verdict).toBe("better");
	});

	it("retro PR C: a feature is better at +0.4% CU per turn and +253 prompt tokens", () => {
		const result = verdict("feature", {
			...flat,
			gain: { delta: 0.1, lower: 0.02 },
			unaffectedCuPerTurnChange: 0.004,
			fixedOverhead: { before: 3142, after: 3395 },
		});
		expect(result.verdict).toBe("better");
	});

	it("a feature is worse when CU per turn rises past the margin", () => {
		const result = verdict("feature", { ...flat, gain: { delta: 0.2, lower: 0.1 }, unaffectedCuPerTurnChange: 0.16 });
		expect(result.verdict).toBe("worse");
		expect(result.reasons.join(" ")).toMatch(/CU per turn rose 16.0%/);
	});

	it("a feature is worse when step time rises past the margin", () => {
		expect(verdict("feature", { ...flat, gain: { delta: 0.2, lower: 0.1 }, unaffectedTimeChange: 0.2 }).verdict).toBe(
			"worse",
		);
	});

	it("a feature is worse when it adds more than 500 prompt tokens", () => {
		const result = verdict("feature", {
			...flat,
			gain: { delta: 0.2, lower: 0.1 },
			fixedOverhead: { before: 2000, after: 2501 },
		});
		expect(result.verdict).toBe("worse");
		expect(result.reasons.join(" ")).toMatch(/501 tokens/);
	});

	it("a feature is worse when the prompt passes the cap over the reference", () => {
		const result = verdict("feature", {
			...flat,
			gain: { delta: 0.2, lower: 0.1 },
			fixedOverhead: { before: 3400, after: 3801, reference: 2300 },
		});
		expect(result.verdict).toBe("worse");
		expect(result.reasons.join(" ")).toMatch(/over the cap of 3800/);
	});

	it("a feature is worse when any regression task dropped", () => {
		expect(verdict("feature", { ...flat, gain: { delta: 0.2, lower: 0.1 }, regressionDrops: 1 }).verdict).toBe(
			"worse",
		);
	});

	it("a feature has no gain when the lower bound is not above 0", () => {
		expect(verdict("feature", { ...flat, gain: { delta: 0.1, lower: 0 } }).verdict).toBe("no-gain");
		expect(verdict("feature", flat).verdict).toBe("no-gain");
	});

	it("an optimization has no gain when CU falls less than 5%", () => {
		expect(verdict("optimization", { ...flat, unaffectedCuPerTurnChange: -0.04 }).verdict).toBe("no-gain");
	});

	it("an optimization is worse when the OEC lower bound reaches -0.03", () => {
		const result = verdict("optimization", {
			...flat,
			unaffectedCuPerTurnChange: -0.2,
			oec: { delta: -0.01, lower: -0.03 },
		});
		expect(result.verdict).toBe("worse");
	});

	it("an optimization may target step time or fixed overhead instead", () => {
		expect(verdict("optimization", { ...flat, unaffectedTimeChange: -0.12 }, "time").verdict).toBe("better");
		expect(
			verdict("optimization", { ...flat, fixedOverhead: { before: 3000, after: 2600 } }, "fixedOverhead").verdict,
		).toBe("better");
		expect(
			verdict("optimization", { ...flat, fixedOverhead: { before: 3000, after: 2800 } }, "fixedOverhead").verdict,
		).toBe("no-gain");
	});

	/** The comparison seen from the other side: every increase becomes the matching decrease. */
	function swapped(comparison: Comparison): Comparison {
		const invert = (change: number) => 1 / (1 + change) - 1;
		const gain = comparison.gain && {
			delta: -comparison.gain.delta,
			lower: -2 * comparison.gain.delta + comparison.gain.lower,
		};
		const oec = comparison.oec && {
			delta: -comparison.oec.delta,
			lower: -2 * comparison.oec.delta + comparison.oec.lower,
		};
		return {
			gain,
			oec,
			regressionDrops: comparison.regressionDrops,
			unaffectedCuPerTurnChange: invert(comparison.unaffectedCuPerTurnChange),
			unaffectedTimeChange: invert(comparison.unaffectedTimeChange),
			fixedOverhead: comparison.fixedOverhead && {
				before: comparison.fixedOverhead.after,
				after: comparison.fixedOverhead.before,
				reference: comparison.fixedOverhead.reference,
			},
		};
	}

	const interval = fc
		.record({ delta: fc.double({ min: -1, max: 1, noNaN: true }), width: fc.double({ min: 0, max: 1, noNaN: true }) })
		.map(({ delta, width }) => ({ delta, lower: delta - width }));
	const comparison = fc.record({
		gain: fc.option(interval, { nil: undefined }),
		oec: fc.option(interval, { nil: undefined }),
		regressionDrops: fc.integer({ min: 0, max: 2 }),
		unaffectedCuPerTurnChange: fc.double({ min: -0.9, max: 2, noNaN: true }),
		unaffectedTimeChange: fc.double({ min: -0.9, max: 2, noNaN: true }),
		fixedOverhead: fc.option(
			fc.record({ before: fc.integer({ min: 500, max: 6000 }), after: fc.integer({ min: 500, max: 6000 }) }),
			{ nil: undefined },
		),
	});

	it("property: swapping before and after never turns better into better", () => {
		fc.assert(
			fc.property(
				comparison,
				fc.constantFrom<PrKind>("feature", "optimization"),
				fc.constantFrom("cu", "time", "fixedOverhead" as const),
				(input, kind, target) => {
					const there = verdict(kind, input, target as "cu" | "time" | "fixedOverhead").verdict;
					const back = verdict(kind, swapped(input), target as "cu" | "time" | "fixedOverhead").verdict;
					return !(there === "better" && back === "better");
				},
			),
			{ seed: POLICY.significance.seed, numRuns: 500 },
		);
	});
});

describe("fisherDropP", () => {
	it("is small for 3/3 against 0/3 and 1 when nothing changed", () => {
		expect(fisherDropP(3, 3, 0, 3)).toBeCloseTo(0.05, 10);
		expect(fisherDropP(3, 3, 3, 3)).toBe(1);
		expect(fisherDropP(0, 3, 3, 3)).toBe(1);
	});

	it("does not flag 3/3 against 2/3", () => {
		expect(fisherDropP(3, 3, 2, 3)).toBeGreaterThan(POLICY.significance.fisherP);
	});
});

describe("live comparison", () => {
	function journey(id: string, cu: number, wallMs: number): LiveJourneyStats {
		return {
			id,
			runs: 3,
			metrics: {
				costUsd: [0, 0, 0],
				wallMs: [0, 0, 0],
				modelCalls: [1, 1, 1],
				uncachedInput: [cu, cu, cu],
				cacheRead: [0, 0, 0],
				cacheWrite: [0, 0, 0],
				output: [0, 0, 0],
				cacheHitRate: [0, 0, 0],
			},
			stepWallMs: [wallMs, wallMs],
			costReportedUsd: [0, 0, 0],
			systemMessages: [0, 0, 0],
			toolErrors: [0, 0, 0],
		};
	}
	const report = (journeys: LiveJourneyStats[], passes: number, overhead: number): LiveReport => ({
		meta: {
			sha: "x",
			dirty: false,
			model: "p/m",
			repeats: 3,
			startedAt: "",
			durationMs: 0,
			costUsd: 0,
			price: { model: "p/m", inputPerM: 1, outputPerM: 1, cacheReadPerM: 0, cacheWritePerM: 0 },
			fixedOverheadTokens: overhead,
		},
		checks: [
			{ name: "target", journeyId: "j8", passes, runs: 3, failures: [] },
			{ name: "kept", journeyId: "j1", passes: 3, runs: 3, failures: [] },
		],
		journeys,
		sample: [],
	});

	it("pools CU per turn and step time over the journeys the change does not target", () => {
		const before = report([journey("j1", 1000, 100), journey("j8", 500, 100)], 1, 3000);
		const after = report([journey("j1", 1100, 110), journey("j8", 5000, 900)], 3, 3300);
		const result = liveComparison(before, after, { turnsByJourney: { j1: 5, j8: 5 }, affected: ["j8"] });
		expect(result.unaffectedCuPerTurnChange).toBeCloseTo(0.1, 10);
		expect(result.unaffectedTimeChange).toBeCloseTo(0.1, 10);
		expect(result.gain?.delta).toBeCloseTo(1 / 3, 10);
		expect(result.regressionDrops).toBe(0);
		expect(result.fixedOverhead).toEqual({ before: 3000, after: 3300, reference: undefined });
		expect(verdict("feature", result).verdict).toBe("better");
	});

	it("counts a regression check that fell from 3/3 to 0/3", () => {
		const before = report([journey("j1", 1000, 100)], 3, 3000);
		const after = report([journey("j1", 1000, 100)], 3, 3000);
		after.checks[1] = { name: "kept", journeyId: "j1", passes: 0, runs: 3, failures: ["x"] };
		expect(liveComparison(before, after, { turnsByJourney: {}, affected: [] }).regressionDrops).toBe(1);
	});

	it("leaves fixed overhead out when a report has none", () => {
		const before = report([journey("j1", 1000, 100)], 3, 3000);
		delete before.meta.fixedOverheadTokens;
		expect(
			liveComparison(before, report([journey("j1", 1000, 100)], 3, 3000), { turnsByJourney: {}, affected: [] })
				.fixedOverhead,
		).toBeUndefined();
	});
});

describe("ledger", () => {
	it("appends entries in order", () => {
		const dir = mkdtempSync(join(tmpdir(), "ledger-"));
		try {
			const path = pathToFileURL(join(dir, "ledger.json"));
			expect(readLedger(path)).toEqual([]);
			const entry = {
				date: "2026-10-06",
				sha: "a",
				kind: "baseline" as const,
				series,
				oec: null,
				fixedOverheadTokens: 3000,
				cuPerTurnByJourney: { j1: 12 },
			};
			appendLedger(entry, path);
			appendLedger({ ...entry, sha: "b", kind: "feature" }, path);
			expect(readLedger(path).map((row) => row.sha)).toEqual(["a", "b"]);
			expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
