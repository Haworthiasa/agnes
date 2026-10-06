import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDir, createBot } from "../src/bot.ts";
import { SkillStore } from "../src/skills.ts";
import { MemoryStore } from "../src/tools/memory.ts";
import { drive } from "./eval/drive.ts";
import { fixturePhoto, seedReference, seedTask, taskJourney, taskWebBackends } from "./eval/seed.ts";
import {
	CATEGORIES,
	type CapabilityTask,
	loadTasks,
	MIN_TASKS_PER_CATEGORY,
	parseTask,
	validateCatalog,
} from "./eval/tasks.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "./helpers.ts";

const tasks = loadTasks();
const byId = (id: string): CapabilityTask => {
	const task = tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`No task ${id}`);
	return task;
};

/** A task that passes the parser, to break one field at a time. */
function sample(): Record<string, unknown> {
	return JSON.parse(JSON.stringify(byId("memory-save-fact")));
}

describe("task catalog", () => {
	it("loads every task file and the set is sound", () => {
		expect(tasks.length).toBeGreaterThanOrEqual(CATEGORIES.length * MIN_TASKS_PER_CATEGORY);
		expect(validateCatalog(tasks)).toEqual([]);
	});

	it("reports duplicate ids, thin categories and a missing polarity", () => {
		const problems = validateCatalog([byId("memory-save-fact"), byId("memory-save-fact")], 2);
		expect(problems).toContain("duplicate id memory-save-fact");
		expect(problems).toContain("memory has no should-not task");
		expect(problems).toContain("recall has 0 tasks, needs 2");
	});

	it("keeps each file in the folder of its category, named by its id", () => {
		for (const task of tasks) {
			expect(
				existsSync(join(new URL("../eval/tasks/", import.meta.url).pathname, task.category, `${task.id}.json`)),
			).toBe(true);
		}
	});

	it("rejects an unknown field with the file and the field", () => {
		expect(() => parseTask({ ...sample(), colour: "red" }, "x.json")).toThrow(/x\.json:.*colour/);
	});

	it("rejects an id that does not start with its category", () => {
		expect(() => parseTask({ ...sample(), id: "web-save-fact" }, "x.json")).toThrow(/must start with "memory-"/);
	});

	it("rejects a grader pattern that is not a regular expression", () => {
		const task = sample() as { graders: unknown[] };
		task.graders = [{ kind: "replyMatches", pattern: "(" }];
		expect(() => parseTask(task, "x.json")).toThrow(/not a valid regular expression/);
	});

	it("rejects a grader that points past the last turn", () => {
		const task = sample() as { graders: unknown[] };
		task.graders = [{ kind: "replyMatches", pattern: "a", turn: 3 }];
		expect(() => parseTask(task, "x.json")).toThrow(/turn 3 is past the last turn/);
	});

	it("rejects a skill name the task does not define", () => {
		const task = sample() as { graders: unknown[] };
		task.graders = [{ kind: "skillExists", name: "ghost" }];
		expect(() => parseTask(task, "x.json")).toThrow(/skill "ghost" is in neither setup nor reference.skills/);
	});

	it("needs exactly one form of jobDue", () => {
		const task = sample() as { graders: unknown[] };
		task.graders = [{ kind: "jobDue", inMinutes: 10, daily: "07:00" }];
		expect(() => parseTask(task, "x.json")).toThrow(/exactly one of inMinutes, at, daily/);
		task.graders = [{ kind: "jobDue" }];
		expect(() => parseTask(task, "x.json")).toThrow(/exactly one of inMinutes, at, daily/);
	});

	it("rejects a canned page too short for the bot's page reader", () => {
		const task = sample() as { setup: Record<string, unknown> };
		task.setup.web = { pages: { "https://a.example/x": { text: "short" } } };
		expect(() => parseTask(task, "x.json")).toThrow(/under 200 characters/);
	});

	it("rejects a turn from a user who is not allowed", () => {
		const task = sample() as { turns: unknown[] };
		task.turns = [{ text: "hi", user: 9 }];
		expect(() => parseTask(task, "x.json")).toThrow(/user is not in setup.users/);
	});
});

describe("seeding", () => {
	let dataDir: string;
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "agnes-seed-"));
	});
	afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

	function withSetup(setup: Partial<CapabilityTask["setup"]>): CapabilityTask {
		const task = byId("memory-save-fact");
		return { ...task, setup: { ...task.setup, ...setup } };
	}

	it("writes memory and skills through the stores", () => {
		const task = withSetup({
			chats: {
				"111": {
					memory: { user: ["Tên là An"], memory: ["Thích trà"] },
					skills: [{ name: "daily-brief", description: "Bản tin ngày", body: "1. Thời tiết\n2. Lịch" }],
				},
			},
		});
		seedTask(task, dataDir);
		const memory = new MemoryStore(join(chatDir(dataDir, 111), "memory"));
		expect(memory.entries("user")).toEqual(["Tên là An"]);
		expect(memory.entries("memory")).toEqual(["Thích trà"]);
		expect(new SkillStore(join(chatDir(dataDir, 111), "skills")).get("daily-brief")?.body).toContain("Thời tiết");
	});

	it("dates a seeded session before the task clock, in the file name, the header and the file time", () => {
		const task = byId("recall-old-session");
		seedTask(task, dataDir);
		const sessions = join(chatDir(dataDir, 111), "sessions");
		const [file] = readdirSync(sessions);
		expect(file).toMatch(/^2026-10-03T01-00-00-000Z_seed-111-0\.jsonl$/);
		const header = JSON.parse(readFileSync(join(sessions, file as string), "utf8").split("\n")[0] as string);
		expect(header).toMatchObject({
			type: "session",
			timestamp: "2026-10-03T01:00:00.000Z",
			cwd: join(dataDir, "workspace"),
		});
		expect(statSync(join(sessions, file as string)).mtimeMs).toBe(Date.parse("2026-10-03T01:00:00.000Z"));
	});

	it("seeds the reference state of the default chat", () => {
		seedReference(byId("memory-save-fact"), dataDir);
		expect(new MemoryStore(join(chatDir(dataDir, 111), "memory")).entries("user")).toEqual(["Dị ứng tôm"]);
		seedReference(byId("skills-create-on-request"), dataDir);
		expect(new SkillStore(join(chatDir(dataDir, 111), "skills")).list().map((skill) => skill.name)).toEqual([
			"phim-3-gach",
		]);
	});

	it("seeds the reference of every task without an error", () => {
		for (const task of tasks) {
			const dir = mkdtempSync(join(tmpdir(), "agnes-ref-"));
			try {
				seedTask(task, dir);
				expect(() => seedReference(task, dir), task.id).not.toThrow();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("is a real PNG that a model can see", () => {
		const bytes = fixturePhoto();
		expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(bytes.length).toBeGreaterThan(100);
		expect(bytes.length).toBeLessThan(2000);
	});
});

describe("task journey", () => {
	it("starts every chat with a seeded session with /new, and only those", () => {
		const { journey, preludeSteps } = taskJourney(byId("recall-old-session"));
		expect(preludeSteps).toBe(1);
		expect(journey.steps[0]).toEqual({ kind: "new", chat: 111, user: 7 });
		expect(journey.steps).toHaveLength(2);
		expect(taskJourney(byId("memory-save-fact")).preludeSteps).toBe(0);
	});

	it("maps turns to steps with the default chat and user, a start clock and a photo flag", () => {
		const task: CapabilityTask = {
			...byId("memory-save-fact"),
			setup: { clock: "2026-10-06T08:00:00+07:00", users: [9] },
			turns: [
				{ text: "a", image: "fixture-photo", advanceMs: 5 },
				{ kind: "tick", advanceMs: 7 },
				{ kind: "new", chat: 222 },
			],
		};
		const { journey } = taskJourney(task);
		expect(journey.users).toEqual([9]);
		expect(journey.start).toBe(Date.parse("2026-10-06T08:00:00+07:00"));
		expect(journey.steps).toEqual([
			{ kind: "say", chat: 111, user: 9, text: "a", image: true, advanceMs: 5 },
			{ kind: "tick", advanceMs: 7 },
			{ kind: "new", chat: 222, user: 9, advanceMs: undefined },
		]);
	});
});

describe("canned web", () => {
	const task = byId("web-fresh-fact");

	it("answers a search by a query substring and a fetch by URL", async () => {
		const { search, fetch } = taskWebBackends(task);
		const hits = await search[0]?.search?.({ objective: "newest Node.js release", queries: ["node latest"] });
		expect(hits?.[0]?.url).toBe("https://nodejs.org/en/blog/release/v26.10.0");
		expect(await search[0]?.search?.({ objective: "cats", queries: ["cats"] })).toEqual([]);
		const pages = await fetch[0]?.fetch?.({
			urls: ["https://nodejs.org/en/blog/release/v26.10.0", "https://example.com/dead"],
			maxCharsPerPage: 1000,
		});
		expect(pages?.[0]?.text).toContain("26.10.0");
		expect(pages?.[1]?.error).toBe("404 Not Found");
	});
});

describe("seeded sessions stay in the past", () => {
	let runtime: FauxRuntime;
	beforeEach(async () => {
		runtime = await createFauxRuntime();
	});
	afterEach(() => runtime.cleanup());

	/** Plays the task against the faux provider and returns the text of the first model request. */
	async function firstRequest(task: CapabilityTask, withPrelude: boolean): Promise<string> {
		seedTask(task, runtime.dataDir);
		const requests: string[] = [];
		runtime.faux.setResponses([
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("ok");
			},
		]);
		const { journey, preludeSteps } = taskJourney(task);
		const played = { ...journey, steps: withPrelude ? journey.steps : journey.steps.slice(preludeSteps) };
		const clock = { now: played.start };
		const transport = new FakeTransport();
		await drive(
			played,
			{
				start: () =>
					createBot({
						dataDir: runtime.dataDir,
						modelRuntime: runtime.modelRuntime,
						model: runtime.faux.getModel(),
						transport,
						allowedUserIds: new Set(played.users),
						allowShell: false,
						timeZone: "Asia/Ho_Chi_Minh",
						webBackends: taskWebBackends(task),
						now: () => clock.now,
					}),
				transport,
				clock,
				photo: fixturePhoto(),
			},
			() => undefined,
			() => undefined,
		);
		return requests[0] ?? "";
	}

	it("keeps the seeded session text out of the first request when /new comes first", async () => {
		expect(await firstRequest(byId("recall-old-session"), true)).not.toContain("bán marathon");
	});

	it("control: without /new the seeded session is the live one and its text is in the request", async () => {
		expect(await firstRequest(byId("recall-old-session"), false)).toContain("bán marathon");
	});
});
