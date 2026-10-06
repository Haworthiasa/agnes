import { describe, expect, it } from "vitest";
import { costOf, type LiveRun, type LiveTurn, type PriceSnapshot } from "./eval/live.ts";
import { buildLiveReport, compareLiveReports, LIVE_CHECKS, renderLiveMarkdown } from "./eval/live-report.ts";

const price: PriceSnapshot = { model: "p/m", inputPerM: 1, outputPerM: 4, cacheReadPerM: 0.1, cacheWritePerM: 0 };

function turn(overrides: Partial<LiveTurn> = {}): LiveTurn {
	return {
		index: 0,
		kind: "say",
		user: "hi",
		reply: "ok",
		clockMs: 0,
		wallMs: 100,
		modelCalls: 1,
		input: 100,
		cacheRead: 300,
		cacheWrite: 0,
		output: 50,
		costReported: 0.001,
		costComputed: costOf(price, { input: 100, output: 50, cacheRead: 300, cacheWrite: 0 }),
		toolCalls: [],
		systemMessagesAdded: 0,
		jobs: [],
		...overrides,
	};
}

const run = (turns: LiveTurn[], journeyId = "j1-new-user"): LiveRun => ({
	journeyId,
	salt: "s",
	turns,
	memory: {},
	skills: {},
});
const meta = (repeats: number) => ({
	sha: "x",
	dirty: false,
	model: "p/m",
	repeats,
	startedAt: "",
	durationMs: 0,
	costUsd: 0,
	price,
});

describe("live report", () => {
	it("prices tokens from the saved snapshot", () => {
		expect(costOf(price, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(1);
		expect(costOf(price, { input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(4.1);
	});

	it("computes the cache hit rate as cache read over all prompt tokens", () => {
		const report = buildLiveReport(meta(1), [run([turn(), turn()])]);
		expect(report.journeys[0]?.metrics.cacheHitRate).toEqual([0.75]);
		expect(report.journeys[0]?.metrics.modelCalls).toEqual([2]);
	});

	it("reports a check pass rate over repeats", () => {
		const saved = turn({ index: 4, reply: "Bạn tên An" });
		const lost = turn({ index: 4, reply: "Mình không biết" });
		const turns = (reply: LiveTurn) => [turn(), turn(), turn(), turn(), reply];
		const report = buildLiveReport(meta(2), [run(turns(saved)), run(turns(lost))]);
		const check = report.checks.find((candidate) => candidate.name.includes("name inside the same session"));
		expect([check?.passes, check?.runs]).toEqual([1, 2]);
	});

	it("checks the reminder time against the injected clock", () => {
		const check = LIVE_CHECKS.find((candidate) => candidate.name.includes("reminder job"));
		const job = (offsetMs: number) => [
			{
				id: "a",
				chatId: 1,
				prompt: "p",
				schedule: { kind: "once" as const, at: 0 },
				nextRunAt: 1_000_000 + offsetMs,
			},
		];
		const at = (offsetMs: number) =>
			run(
				Array.from({ length: 5 }, (_, index) =>
					turn({ index, clockMs: 1_000_000, jobs: index === 4 ? job(offsetMs) : [] }),
				),
				"j2-returning-user",
			);
		expect(() => check?.run(at(10 * 60_000))).not.toThrow();
		expect(() => check?.run(at(35 * 60_000))).toThrow();
	});

	it("compares repeats and calls a clear drop in cost an improvement", () => {
		const cheap = (cost: number) => run([turn({ costComputed: cost })]);
		const before = buildLiveReport(meta(3), [cheap(0.01), cheap(0.011), cheap(0.009)]);
		const after = buildLiveReport(meta(3), [cheap(0.004), cheap(0.005), cheap(0.003)]);
		const row = compareLiveReports(before, after).find((candidate) => candidate.metric === "costUsd");
		expect(row?.verdict).toBe("improved");
	});

	it("renders checks, metrics and a behavior sample", () => {
		const markdown = renderLiveMarkdown(buildLiveReport(meta(1), [run([turn()])]));
		expect(markdown).toContain("## Checks");
		expect(markdown).toContain("cacheHitRate");
		expect(markdown).toContain("Behavior sample: j1-new-user");
	});
});
