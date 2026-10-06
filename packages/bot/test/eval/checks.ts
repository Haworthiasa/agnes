import assert from "node:assert/strict";
import type { JourneyResult } from "./harness.ts";
import type { CheckResult } from "./report.ts";

export type Results = Record<string, JourneyResult>;

export interface Check {
	name: string;
	/** The change that builds this behavior. While set, the check is expected to fail. Remove it when the change lands. */
	expectFail?: string;
	run(results: Results): void;
}

function journey(results: Results, id: string): JourneyResult {
	const found = results[id];
	assert.ok(found, `journey ${id} did not run`);
	return found;
}

const all = (results: Results) => Object.values(results);

/** Example checks: what should happen. Each runs against the journey results, so tests and reports share them. */
export const CHECKS: Check[] = [
	{
		name: "j1: a fact the user asks to remember lands in USER.md",
		run: (results) => assert.match(journey(results, "j1-new-user").memory["111"]?.user ?? "", /tôi tên An/),
	},
	{
		name: "j1: a new session after /new shows the fact in its system prompt",
		run: (results) => {
			const prompts = journey(results, "j1-new-user").sessionPrompts;
			assert.ok(prompts.length >= 2, "expected two sessions");
			assert.match(prompts[1] ?? "", /tôi tên An/);
		},
	},
	{
		name: "j2: a reminder calls schedule and the due job runs",
		run: (results) => {
			const result = journey(results, "j2-returning-user");
			assert.ok(result.toolNames.includes("schedule"));
			assert.match(result.turns.find((turn) => turn.kind === "tick")?.reply ?? "", /\[Lịch/);
		},
	},
	{
		name: "j3: memory stays inside its chat",
		run: (results) => {
			const result = journey(results, "j3-group-chat");
			assert.match(result.memory["222"]?.user ?? "", /họp thứ Sáu/);
			assert.equal(result.memory["333"]?.user, null);
		},
	},
	{
		name: "every say, new and tick step gets a reply",
		run: (results) => {
			for (const result of all(results)) {
				for (const turn of result.turns.filter((candidate) => candidate.kind !== "restart")) {
					assert.notEqual(turn.reply, "", `${result.id} turn ${turn.index} had no reply`);
				}
			}
		},
	},
	{
		name: "no journey breaks the append-only prefix of its requests",
		expectFail: "PR A",
		run: (results) => {
			for (const result of all(results)) assert.equal(result.totals.prefixBreaks, 0, result.id);
		},
	},
	{
		name: "no turn adds a system message to a stored transcript after the first",
		expectFail: "PR A",
		run: (results) => {
			for (const result of all(results)) {
				const sessions = result.sessionPrompts.length;
				assert.ok(
					result.totals.systemMessages <= sessions,
					`${result.id}: ${result.totals.systemMessages} > ${sessions}`,
				);
			}
		},
	},
	{
		name: "j1: cache hit rate is at least 60%",
		expectFail: "PR A",
		run: (results) => assert.ok(journey(results, "j1-new-user").totals.cacheHitRate >= 0.6),
	},
	{
		name: "schedule accepts a relative time, in_minutes",
		expectFail: "PR A",
		run: (results) => assert.match(journey(results, "j2-returning-user").toolSchemas.schedule ?? "", /in_minutes/),
	},
	{
		name: "session_search is a declared tool",
		expectFail: "PR B",
		run: (results) => assert.ok("session_search" in journey(results, "j2-returning-user").toolSchemas),
	},
	{
		name: "memory refuses an instruction-override entry",
		expectFail: "PR B",
		run: (results) =>
			assert.doesNotMatch(
				journey(results, "j4-poisoned-memory").memory["111"]?.user ?? "",
				/ignore all previous instructions/i,
			),
	},
	{
		name: "skill_manage and skill_view are declared tools",
		expectFail: "PR C",
		run: (results) => {
			const schemas = journey(results, "j2-returning-user").toolSchemas;
			assert.ok("skill_manage" in schemas && "skill_view" in schemas);
		},
	},
];

/** Runs every check against the results. A check with `expectFail` that passes is reported as a failure: remove the flag. */
export function evaluateChecks(results: Results): CheckResult[] {
	return CHECKS.map((check) => {
		let passed = true;
		try {
			check.run(results);
		} catch {
			passed = false;
		}
		const name = check.expectFail ? `${check.name} (builds in ${check.expectFail})` : check.name;
		if (check.expectFail) return { name, status: passed ? "fail" : "expected-fail" };
		return { name, status: passed ? "pass" : "fail" };
	});
}
