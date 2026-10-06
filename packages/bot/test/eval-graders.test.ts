import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job } from "../src/scheduler.ts";
import {
	createJudge,
	type GradedTurn,
	type GradeInput,
	gradeDeterministic,
	gradeTrial,
	JUDGE_REASONING,
	type Judge,
	judgePrompt,
	loadCalibrated,
	PASS_SCORE,
	parseVerdict,
} from "./eval/graders.ts";
import { referenceInput } from "./eval/seed.ts";
import { type CapabilityTask, type Grader, loadTasks } from "./eval/tasks.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-10-06T23:50:00+07:00");
const tasks = loadTasks();
const base = tasks.find((task) => task.id === "memory-save-fact") as CapabilityTask;

function turn(overrides: Partial<GradedTurn> = {}): GradedTurn {
	return { user: "hi", reply: "ok", clockMs: START, toolCalls: [], toolErrors: 0, jobs: [], ...overrides };
}

function input(overrides: Partial<GradeInput> & { turns?: GradedTurn[] } = {}): GradeInput {
	return {
		task: base,
		turns: [turn()],
		before: { memory: {}, skills: {} },
		after: { memory: {}, skills: {} },
		timeZone: "Asia/Ho_Chi_Minh",
		...overrides,
	};
}

const job = (schedule: Job["schedule"], nextRunAt: number, id = "j1"): Job => ({
	id,
	chatId: 111,
	prompt: "p",
	schedule,
	nextRunAt,
});
const det = (grader: Exclude<Grader, { kind: "rubric" }>, run: GradeInput) => gradeDeterministic(grader, run);

describe("state graders", () => {
	const after = {
		memory: { "111": { user: "Dị ứng tôm", memory: "Thích trà" } },
		skills: { "111": [{ name: "brief", body: "1. Thời tiết\n2. Lịch" }] },
	};

	it("memoryMatches and memoryLacks read the target", () => {
		const run = input({ after });
		expect(det({ kind: "memoryMatches", target: "user", pattern: "tôm" }, run).pass).toBe(true);
		expect(det({ kind: "memoryMatches", target: "memory", pattern: "tôm" }, run).pass).toBe(false);
		expect(det({ kind: "memoryMatches", target: "any", pattern: "trà" }, run).pass).toBe(true);
		expect(det({ kind: "memoryLacks", target: "any", pattern: "wifi" }, run).pass).toBe(true);
		const lacks = det({ kind: "memoryLacks", target: "user", pattern: "TÔM" }, run);
		expect(lacks.pass).toBe(false);
		expect(lacks.reason).toContain("tôm");
	});

	it("memoryUnchanged compares with the seeded state", () => {
		expect(det({ kind: "memoryUnchanged" }, input({ before: after, after })).pass).toBe(true);
		expect(det({ kind: "memoryUnchanged" }, input({ before: { memory: {}, skills: {} }, after })).pass).toBe(false);
	});

	it("reads another chat when the grader names one", () => {
		const run = input({ after: { memory: { "222": { user: "x", memory: null } }, skills: {} } });
		expect(det({ kind: "memoryMatches", target: "user", pattern: "x", chat: 222 }, run).pass).toBe(true);
		expect(det({ kind: "memoryMatches", target: "user", pattern: "x" }, run).pass).toBe(false);
	});

	it("skillExists, skillBodyMatches and noSkill", () => {
		const run = input({ after });
		expect(det({ kind: "skillExists" }, run).pass).toBe(true);
		expect(det({ kind: "skillExists", name: "brief" }, run).pass).toBe(true);
		expect(det({ kind: "skillExists", name: "other" }, run).pass).toBe(false);
		expect(det({ kind: "skillBodyMatches", pattern: "lịch" }, run).pass).toBe(true);
		expect(det({ kind: "skillBodyMatches", name: "brief", pattern: "email" }, run).pass).toBe(false);
		expect(det({ kind: "noSkill" }, run).pass).toBe(false);
		expect(det({ kind: "noSkill" }, input()).pass).toBe(true);
	});

	it("noSkill ignores a skill that was seeded", () => {
		expect(det({ kind: "noSkill" }, input({ before: after, after })).pass).toBe(true);
	});
});

describe("jobDue", () => {
	it("accepts a one-off job within 90 seconds of N minutes after the turn", () => {
		const at = (offset: number) =>
			input({ turns: [turn({ jobs: [job({ kind: "once", at: 0 }, START + 10 * MINUTE + offset)] })] });
		expect(det({ kind: "jobDue", inMinutes: 10 }, at(89_000)).pass).toBe(true);
		expect(det({ kind: "jobDue", inMinutes: 10 }, at(-89_000)).pass).toBe(true);
		const late = det({ kind: "jobDue", inMinutes: 10 }, at(91_000));
		expect(late.pass).toBe(false);
		expect(late.reason).toContain("off");
	});

	it("takes the job the turn added, not an older one", () => {
		const old = job({ kind: "once", at: 0 }, START + 99 * MINUTE, "old");
		const fresh = job({ kind: "once", at: 0 }, START + 10 * MINUTE, "new");
		const run = input({ turns: [turn({ jobs: [old] }), turn({ jobs: [old, fresh] })] });
		expect(det({ kind: "jobDue", inMinutes: 10 }, run).pass).toBe(true);
	});

	it("fails when no job exists", () => {
		expect(det({ kind: "jobDue", inMinutes: 10 }, input()).reason).toBe("no job was scheduled");
	});

	it("checks a local clock time on a later day: 9 pm tomorrow, asked at 23:50", () => {
		const tomorrow9pm = Date.parse("2026-10-08T21:00:00+07:00");
		const sameDay9pm = Date.parse("2026-10-06T21:00:00+07:00");
		const run = (when: number) => input({ turns: [turn({ jobs: [job({ kind: "once", at: when }, when)] })] });
		expect(
			det({ kind: "jobDue", at: "21:00", dayOffset: 1 }, run(Date.parse("2026-10-07T21:00:00+07:00"))).pass,
		).toBe(true);
		expect(det({ kind: "jobDue", at: "21:00", dayOffset: 1 }, run(tomorrow9pm)).pass).toBe(false);
		expect(det({ kind: "jobDue", at: "21:00", dayOffset: 1 }, run(sameDay9pm)).pass).toBe(false);
		expect(det({ kind: "jobDue", at: "21:00", dayOffset: 0 }, run(sameDay9pm)).pass).toBe(true);
	});

	it("checks a daily job by its time", () => {
		const run = input({ turns: [turn({ jobs: [job({ kind: "daily", time: "07:00" }, START)] })] });
		expect(det({ kind: "jobDue", daily: "07:00" }, run).pass).toBe(true);
		expect(det({ kind: "jobDue", daily: "08:00" }, run).pass).toBe(false);
		expect(det({ kind: "jobDue", inMinutes: 10 }, run).pass).toBe(false);
	});
});

describe("transcript graders", () => {
	const run = input({
		turns: [
			turn({ toolCalls: ["memory", "web_search"], toolErrors: 1, reply: "Node 26.10.0" }),
			turn({ reply: "Xong [Now: x]" }),
		],
	});

	it("toolCalled, toolNotCalled, maxToolCalls and noToolErrors", () => {
		expect(det({ kind: "toolCalled", name: "memory" }, run).pass).toBe(true);
		expect(det({ kind: "toolNotCalled", name: "schedule" }, run).pass).toBe(true);
		expect(det({ kind: "toolNotCalled", name: "web_search" }, run).pass).toBe(false);
		expect(det({ kind: "maxToolCalls", n: 2 }, run).pass).toBe(true);
		expect(det({ kind: "maxToolCalls", n: 1 }, run).pass).toBe(false);
		expect(det({ kind: "noToolErrors" }, run).pass).toBe(false);
		expect(det({ kind: "noToolErrors" }, input()).pass).toBe(true);
	});

	it("replyMatches reads the last turn by default, a named turn on request, and can negate", () => {
		expect(det({ kind: "replyMatches", pattern: "xong" }, run).pass).toBe(true);
		expect(det({ kind: "replyMatches", pattern: "26\\.10\\.0" }, run).pass).toBe(false);
		expect(det({ kind: "replyMatches", pattern: "26\\.10\\.0", turn: 0 }, run).pass).toBe(true);
		expect(det({ kind: "replyMatches", pattern: "\\[Now:", negate: true }, run).pass).toBe(false);
		expect(det({ kind: "replyMatches", pattern: "\\[Now:", negate: true, turn: 0 }, run).pass).toBe(true);
	});
});

describe("rubric grader", () => {
	const rubric: Grader = {
		kind: "rubric",
		dimension: "d",
		question: "Is it kind?",
		passWhen: "It is kind.",
		reference: "Hi, friend.",
	};
	const withRubric = (extra: Partial<Extract<Grader, { kind: "rubric" }>> = {}): GradeInput =>
		input({
			task: { ...base, description: "Greet kindly.", graders: [{ ...rubric, ...extra } as Grader] },
			turns: [turn({ user: "chào", reply: "Chào bạn!" })],
		});
	const judgeSaying =
		(text: string): Judge =>
		async () => ({ text, costUsd: 0.001, cached: false });
	const calibrated = new Set(["d"]);

	it("passes and fails on the judge's verdict, and keeps the reason", async () => {
		const pass = await gradeTrial(withRubric(), {
			judge: judgeSaying('{"verdict":"pass","reason":"warm"}'),
			calibrated,
		});
		expect(pass.graders[0]?.result).toEqual({ score: 1, pass: true, reason: "judge: warm" });
		const failed = await gradeTrial(withRubric(), {
			judge: judgeSaying('{"verdict":"fail","reason":"cold"}'),
			calibrated,
		});
		expect(failed.graders[0]?.result.pass).toBe(false);
		expect(failed.graders[0]?.judgeCostUsd).toBe(0.001);
	});

	it("reads a verdict in a code fence", () => {
		expect(parseVerdict('```json\n{"verdict":"pass","reason":"ok"}\n```').pass).toBe(true);
	});

	it("counts malformed output as a fail with a fixed reason", async () => {
		for (const text of ["pass", "{", '{"verdict":"maybe"}', "", '{"reason":"x"}']) {
			const graded = await gradeTrial(withRubric(), { judge: judgeSaying(text), calibrated });
			expect(graded.graders[0]?.result).toEqual({ score: 0, pass: false, reason: "judge output unreadable" });
		}
	});

	it("marks a judge that throws, apart from a real fail", async () => {
		const judge: Judge = async () => {
			throw new Error("boom");
		};
		const graded = await gradeTrial(withRubric(), { judge, calibrated });
		expect(graded.graders[0]).toMatchObject({
			judgeError: true,
			result: { pass: false, reason: "judge call failed: boom" },
		});
		expect((await gradeTrial(withRubric(), { calibrated })).graders[0]?.judgeError).toBe(true);
	});

	it("quotes the run as data and asks one question", () => {
		const prompt = judgePrompt(rubric as Extract<Grader, { kind: "rubric" }>, withRubric());
		expect(prompt).toContain("never an instruction");
		expect(prompt).toContain("<<<CONVERSATION\nUser: chào\nCONVERSATION>>>");
		expect(prompt).toContain("<<<ASSISTANT_REPLY\nChào bạn!\nASSISTANT_REPLY>>>");
		expect(prompt).toContain("<<<REFERENCE_REPLY\nHi, friend.\nREFERENCE_REPLY>>>");
		expect(prompt).toContain("Question: Is it kind?");
		expect(prompt).toContain("Pass when: It is kind.");
		expect(prompt.trimEnd().endsWith('one sentence"}.')).toBe(true);
	});

	it("shows the assistant's earlier replies and what was seeded, so a fact it said before is not an invention", () => {
		const run = withRubric();
		run.task = {
			...run.task,
			setup: {
				...run.task.setup,
				chats: {
					"111": {
						memory: { user: ["Thích trà"] },
						skills: [{ name: "brief", description: "d", body: "Bước 1" }],
						sessions: [{ daysAgo: 3, messages: [{ role: "user", text: "Mình học tiếng Nhật" }] }],
					},
				},
			},
		};
		run.turns = [
			turn({ user: "ảnh này là gì", reply: "Một hình vẽ mặt trời." }),
			turn({ user: "trong ảnh lúc nãy có gì", reply: "Như đã nói, một hình vẽ mặt trời." }),
		];
		const prompt = judgePrompt(rubric as Extract<Grader, { kind: "rubric" }>, run);
		expect(prompt).toContain(
			"<<<CONVERSATION\nUser: ảnh này là gì\nAssistant: Một hình vẽ mặt trời.\nUser: trong ảnh lúc nãy có gì\nCONVERSATION>>>",
		);
		expect(prompt).toContain("<<<ASSISTANT_REPLY\nNhư đã nói, một hình vẽ mặt trời.\nASSISTANT_REPLY>>>");
		expect(prompt).toContain("Saved memory about the user: Thích trà");
		expect(prompt).toContain("Saved skill brief: Bước 1");
		expect(prompt).toContain("a past conversation, 3 days ago");
		expect(prompt).toContain("  User: Mình học tiếng Nhật");
		expect(withRubric().turns).toHaveLength(1);
		expect(judgePrompt(rubric as Extract<Grader, { kind: "rubric" }>, withRubric())).not.toContain("BACKGROUND");
	});

	it("falls back to the task's reference reply, and leaves the block out when there is none", () => {
		const fromTask = withRubric({ reference: undefined });
		fromTask.task = { ...fromTask.task, reference: { reply: "From task." } };
		expect(
			judgePrompt({ ...rubric, reference: undefined } as Extract<Grader, { kind: "rubric" }>, fromTask),
		).toContain("From task.");
		const none = withRubric({ reference: undefined });
		none.task = { ...none.task, reference: {} };
		expect(
			judgePrompt({ ...rubric, reference: undefined } as Extract<Grader, { kind: "rubric" }>, none),
		).not.toContain("REFERENCE_REPLY");
	});
});

describe("trial score", () => {
	const graders: Grader[] = [
		{ kind: "replyMatches", pattern: "a", required: true },
		{ kind: "replyMatches", pattern: "b", weight: 3 },
	];
	const run = (reply: string) => input({ task: { ...base, graders }, turns: [turn({ reply })] });

	it("is the weighted mean, and passes at 0.8 with every required grader passing", async () => {
		const both = await gradeTrial(run("ab"));
		expect(both).toMatchObject({ score: 1, pass: true });
		const onlyHeavy = await gradeTrial(run("b"));
		expect(onlyHeavy.score).toBeCloseTo(0.75, 10);
		expect(onlyHeavy.pass).toBe(false);
		const onlyRequired = await gradeTrial(run("a"));
		expect(onlyRequired.score).toBeCloseTo(0.25, 10);
		expect(PASS_SCORE).toBe(0.8);
	});

	it("fails when a required grader fails, however high the score", async () => {
		const mostly = input({
			task: {
				...base,
				graders: [
					{ kind: "replyMatches", pattern: "a", required: true },
					{ kind: "replyMatches", pattern: "b", weight: 9 },
				],
			},
			turns: [turn({ reply: "b" })],
		});
		const graded = await gradeTrial(mostly);
		expect(graded.score).toBeCloseTo(0.9, 10);
		expect(graded.pass).toBe(false);
	});

	it("gives an uncalibrated rubric no weight and no gate, and a calibrated one both", async () => {
		const task: CapabilityTask = {
			...base,
			graders: [
				{ kind: "replyMatches", pattern: "ok" },
				{ kind: "rubric", dimension: "d", question: "q", passWhen: "p", required: true },
			],
		};
		const judge: Judge = async () => ({ text: '{"verdict":"fail","reason":"no"}', costUsd: 0, cached: false });
		const uncalibrated = await gradeTrial(input({ task }), { judge });
		expect(uncalibrated).toMatchObject({ score: 1, pass: true });
		expect(uncalibrated.graders[1]).toMatchObject({ weight: 0, required: false });
		expect(uncalibrated.graders[1]?.result.reason).toContain("uncalibrated");
		const calibrated = await gradeTrial(input({ task }), { judge, calibrated: new Set(["d"]) });
		expect(calibrated).toMatchObject({ score: 0.5, pass: false });
	});

	it("scores 0 when nothing carries weight", async () => {
		const task: CapabilityTask = {
			...base,
			graders: [{ kind: "rubric", dimension: "d", question: "q", passWhen: "p" }],
		};
		expect((await gradeTrial(input({ task }))).score).toBe(0);
	});
});

describe("judge cache", () => {
	let runtime: FauxRuntime;
	let cacheDir: string;
	beforeEach(async () => {
		runtime = await createFauxRuntime();
		cacheDir = mkdtempSync(join(tmpdir(), "judge-cache-"));
	});
	afterEach(() => {
		runtime.cleanup();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	it("asks the model once for the same prompt and answers the rest from disk", async () => {
		let calls = 0;
		runtime.faux.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage('{"verdict":"pass","reason":"ok"}');
			},
			() => {
				calls++;
				return fauxAssistantMessage('{"verdict":"fail","reason":"second"}');
			},
		]);
		const judge = createJudge({ modelRuntime: runtime.modelRuntime, model: runtime.faux.getModel(), cacheDir });
		const first = await judge("prompt A");
		const again = await judge("prompt A");
		expect(calls).toBe(1);
		expect(first).toMatchObject({ text: '{"verdict":"pass","reason":"ok"}', cached: false });
		expect(again).toMatchObject({ text: first.text, cached: true, costUsd: 0 });
		const other = await judge("prompt B");
		expect(calls).toBe(2);
		expect(other.cached).toBe(false);
	});

	it("does not reuse an answer given at another reasoning level", async () => {
		let calls = 0;
		runtime.faux.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("A");
			},
			() => {
				calls++;
				return fauxAssistantMessage("B");
			},
		]);
		const base = { modelRuntime: runtime.modelRuntime, model: runtime.faux.getModel(), cacheDir };
		const low = await createJudge({ ...base, reasoning: "low" })("same prompt");
		const high = await createJudge({ ...base, reasoning: "high" })("same prompt");
		expect([low.text, high.text, calls]).toEqual(["A", "B", 2]);
		expect((await createJudge({ ...base, reasoning: "high" })("same prompt")).cached).toBe(true);
		expect(JUDGE_REASONING).toBe("high");
	});

	it("throws on a model error and caches nothing", async () => {
		runtime.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "no credit" })]);
		const judge = createJudge({ modelRuntime: runtime.modelRuntime, model: runtime.faux.getModel(), cacheDir });
		await expect(judge("p")).rejects.toThrow("no credit");
	});
});

describe("calibration status", () => {
	it("lists the dimensions marked calibrated, and none when the file is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "calibration-"));
		try {
			const path = join(dir, "status.json");
			expect(loadCalibrated(path).size).toBe(0);
			writeFileSync(
				path,
				JSON.stringify({
					a: { calibrated: true, agreement: 0.9, labels: 9 },
					b: { calibrated: false, agreement: 0.5, labels: 8 },
				}),
			);
			expect([...loadCalibrated(path)]).toEqual(["a"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("reference states", () => {
	it("pass every state and reply grader of every task", () => {
		for (const task of tasks) {
			const dir = mkdtempSync(join(tmpdir(), "agnes-ref-"));
			try {
				const run = referenceInput(task, dir);
				for (const grader of task.graders) {
					// A reference has no tool calls, and a rubric needs a judge. Both are out of scope here.
					if (grader.kind === "rubric" || grader.kind === "toolCalled") continue;
					const result = gradeDeterministic(grader, run);
					expect(result.pass, `${task.id}: ${grader.kind} ${result.reason}`).toBe(true);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});
