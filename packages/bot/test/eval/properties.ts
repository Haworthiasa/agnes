import assert from "node:assert/strict";
import fc from "fast-check";
import { MEMORY_LIMITS } from "../../src/tools/memory.ts";
import { runJourney } from "./harness.ts";
import type { Journey, Step } from "./journeys.ts";
import type { CheckResult } from "./report.ts";

/** Fixed, so a run is reproducible. Set EVAL_SEED to explore other cases. */
export const SEED = Number(process.env.EVAL_SEED ?? 20261006);
export const NUM_RUNS = Number(process.env.EVAL_RUNS ?? 12);

const MINUTE = 60_000;
const START = Date.parse("2026-10-06T08:00:00+07:00");

/** Between 1 minute and 3 days: long enough that a minute-stamped prompt always changes. */
const gap = fc.integer({ min: 1, max: 3 * 24 * 60 }).map((minutes) => minutes * MINUTE);
const chatText = fc.constantFrom(
	"Chào bạn",
	"Hãy nhớ: tôi thích trà",
	"Gợi ý món ăn trưa",
	"Mình tên gì?",
	"Nhắc tôi sau 10 phút uống nước",
);

function journeyOf(steps: Step[]): Journey {
	return { id: "generated", description: "generated", users: [7, 8], start: START, steps };
}

const sayIn = (chat: number) =>
	fc.record({
		kind: fc.constant("say" as const),
		chat: fc.constant(chat),
		user: fc.constantFrom(7, 8),
		text: chatText,
		advanceMs: gap,
	});

/** Any mix of messages, resets, restarts and scheduler ticks in one chat. */
const anyJourney = fc
	.array(
		fc.oneof(
			{ weight: 6, arbitrary: sayIn(111) },
			{
				weight: 1,
				arbitrary: fc.record({
					kind: fc.constant("new" as const),
					chat: fc.constant(111),
					user: fc.constant(7),
					advanceMs: gap,
				}),
			},
			{ weight: 1, arbitrary: fc.record({ kind: fc.constant("restart" as const), advanceMs: gap }) },
			{ weight: 1, arbitrary: fc.record({ kind: fc.constant("tick" as const), advanceMs: gap }) },
		),
		{ minLength: 1, maxLength: 8 },
	)
	.map(journeyOf);

/** Long "remember" messages: more text than the memory budget allows. */
const longFacts = fc
	.array(
		fc.string({ minLength: 200, maxLength: 700 }).map((text) => `Hãy nhớ: ${text.replace(/\s+/g, " ")}`),
		{
			minLength: 1,
			maxLength: 6,
		},
	)
	.map((texts) =>
		journeyOf(texts.map((text) => ({ kind: "say" as const, chat: 111, user: 7, text, advanceMs: MINUTE }))),
	);

/** Facts told in two chats, each carrying a token that names its chat. */
const twoChats = fc.array(fc.constantFrom(111, 222), { minLength: 2, maxLength: 8 }).map((chats) =>
	journeyOf(
		chats.map((chat, index) => ({
			kind: "say" as const,
			chat,
			user: 7,
			text: `Hãy nhớ: token-${chat}-${index}`,
			advanceMs: MINUTE,
		})),
	),
);

export interface Property {
	name: string;
	/** The change that builds this behavior. While set, the property is expected to fail. */
	expectFail?: string;
	property: fc.IAsyncProperty<[Journey]>;
}

/** Property checks: what must never happen, for any generated journey. */
export const PROPERTIES: Property[] = [
	{
		name: "P1: a session's request always starts with its previous request (the prefix stays append-only)",
		expectFail: "PR A",
		property: fc.asyncProperty(anyJourney, async (journey) => {
			assert.equal((await runJourney(journey)).totals.prefixBreaks, 0);
		}),
	},
	{
		name: "P2: a stored transcript never gets a system message after its first",
		expectFail: "PR A",
		property: fc.asyncProperty(anyJourney, async (journey) => {
			const { totals, sessionPrompts } = await runJourney(journey);
			assert.ok(
				totals.systemMessages <= sessionPrompts.length,
				`${totals.systemMessages} system messages in ${sessionPrompts.length} sessions`,
			);
		}),
	},
	{
		name: "P3: USER.md never exceeds its character budget",
		property: fc.asyncProperty(longFacts, async (journey) => {
			const result = await runJourney(journey);
			assert.ok((result.memory["111"]?.user ?? "").length <= MEMORY_LIMITS.user);
		}),
	},
	{
		name: "P4: a fact told in one chat never reaches another chat's memory",
		property: fc.asyncProperty(twoChats, async (journey) => {
			const result = await runJourney(journey);
			assert.doesNotMatch(result.memory["111"]?.user ?? "", /token-222-/);
			assert.doesNotMatch(result.memory["222"]?.user ?? "", /token-111-/);
		}),
	},
	{
		name: "P5: the same journey gives the same totals twice (the run is deterministic)",
		property: fc.asyncProperty(anyJourney, async (journey) => {
			const first = (await runJourney(journey)).totals;
			const second = (await runJourney(journey)).totals;
			assert.deepEqual({ ...first, cpuMs: 0 }, { ...second, cpuMs: 0 });
		}),
	},
];

/** Runs one property. Used by the report script, which needs the seed and a shrunk counterexample on failure. */
export async function evaluateProperties(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const { name, expectFail, property } of PROPERTIES) {
		const outcome = await fc.check(property, { seed: SEED, numRuns: NUM_RUNS });
		const label = expectFail ? `${name} (builds in ${expectFail})` : name;
		const detail = outcome.failed
			? `seed ${outcome.seed}, failed after ${outcome.numRuns} runs, shrunk ${outcome.numShrinks} times; ${String(outcome.errorInstance ?? "")}`
			: `${outcome.numRuns} cases, seed ${outcome.seed}`;
		if (expectFail) results.push({ name: label, status: outcome.failed ? "expected-fail" : "fail", detail });
		else results.push({ name: label, status: outcome.failed ? "fail" : "pass", detail });
	}
	return results;
}
