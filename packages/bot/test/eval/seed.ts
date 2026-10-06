import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatDir } from "../../src/bot.ts";
import type { Job } from "../../src/scheduler.ts";
import { SkillStore } from "../../src/skills.ts";
import { MemoryStore, type MemoryTarget } from "../../src/tools/memory.ts";
import type { FetchedPage, WebBackend, WebBackends, WebResult } from "../../src/tools/web.ts";
import { type GradeInput, localMidnight, type StateSnapshot } from "./graders.ts";
import type { Journey, Step } from "./journeys.ts";
import { type CapabilityTask, DEFAULT_CHAT, DEFAULT_USER, DEFAULT_USERS, type TaskTurn } from "./tasks.ts";

const DAY = 24 * 60 * 60_000;

export type Line = { role: "user" | "assistant" | "toolResult" | "system"; text: string };

interface StoredLine {
	type: "session" | "message";
	id: string;
	parentId?: string | null;
	timestamp: string;
	version?: number;
	cwd?: string;
	message?: {
		role: Line["role"];
		content: string | Array<{ type: "text"; text: string }>;
		timestamp?: number;
		/** An assistant message carries the fields pi needs to load it into a context. */
		api?: string;
		provider?: string;
		model?: string;
		usage?: Record<string, unknown>;
		stopReason?: string;
	};
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * One stored transcript in the shape pi writes: a session header, then one entry per message, each pointing at the one
 * before it. An assistant entry has the fields pi needs to load it as context, so a session can also be continued.
 */
export function transcript(
	id: string,
	messages: Line[],
	startMs = Date.parse("2026-10-05T08:00:00Z"),
	cwd = "/w",
): string {
	const lines: StoredLine[] = [{ type: "session", version: 3, id, timestamp: new Date(startMs).toISOString(), cwd }];
	for (const [index, message] of messages.entries()) {
		const timestamp = startMs + index * 1000;
		lines.push({
			type: "message",
			id: `e${index}`,
			parentId: index === 0 ? null : `e${index - 1}`,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: message.role,
				content: message.role === "user" ? message.text : [{ type: "text", text: message.text }],
				timestamp,
				...(message.role === "assistant"
					? { api: "seeded", provider: "seeded", model: "seeded", usage: EMPTY_USAGE, stopReason: "stop" }
					: {}),
			},
		});
	}
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** A 64x64 PNG (sky, a yellow disc, grass) that a model with vision can describe. */
export function fixturePhoto(): Uint8Array {
	return readFileSync(fileURLToPath(new URL("../fixtures/photo.png", import.meta.url)));
}

function seedMemory(dataDir: string, chat: number, memory: { user?: string[]; memory?: string[] }): void {
	const store = new MemoryStore(join(chatDir(dataDir, chat), "memory"));
	for (const target of ["user", "memory"] as MemoryTarget[]) {
		const entries = memory[target] ?? [];
		if (entries.length > 0)
			store.apply(
				target,
				entries.map((content) => ({ action: "add", content })),
			);
	}
}

function seedSkills(dataDir: string, chat: number, skills: Array<{ name: string; description: string; body: string }>) {
	const store = new SkillStore(join(chatDir(dataDir, chat), "skills"));
	for (const skill of skills) store.create(skill.name, skill.description, skill.body);
}

/**
 * Writes the task's starting state straight into an empty data directory: memory, skills and past sessions. A
 * session file is named and dated `daysAgo` before the task clock, the way pi names it.
 */
export function seedTask(task: CapabilityTask, dataDir: string): void {
	const clock = Date.parse(task.setup.clock);
	for (const [key, chat] of Object.entries(task.setup.chats ?? {})) {
		const chatId = Number(key);
		if (chat.memory) seedMemory(dataDir, chatId, chat.memory);
		if (chat.skills) seedSkills(dataDir, chatId, chat.skills);
		const sessions = join(chatDir(dataDir, chatId), "sessions");
		for (const [index, session] of (chat.sessions ?? []).entries()) {
			mkdirSync(sessions, { recursive: true });
			const startMs = clock - session.daysAgo * DAY;
			const id = `seed-${chatId}-${index}`;
			const file = join(sessions, `${new Date(startMs).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
			// The header names the bot's workspace, as a real session does. `continueRecent` matches sessions by it.
			writeFileSync(file, transcript(id, session.messages, startMs, join(dataDir, "workspace")));
			utimesSync(file, startMs / 1000, startMs / 1000);
		}
	}
}

/**
 * Writes the reference memory and skills into the default chat, to check that the state graders accept it. The
 * reference is the whole final state, so it replaces what the seeding wrote.
 */
export function seedReference(task: CapabilityTask, dataDir: string): void {
	const { memory, skills } = task.reference;
	if (memory) {
		rmSync(join(chatDir(dataDir, DEFAULT_CHAT), "memory"), { recursive: true, force: true });
		seedMemory(dataDir, DEFAULT_CHAT, memory);
	}
	if (skills) {
		rmSync(join(chatDir(dataDir, DEFAULT_CHAT), "skills"), { recursive: true, force: true });
		seedSkills(dataDir, DEFAULT_CHAT, skills);
	}
}

export interface TaskJourney {
	journey: Journey;
	/** Leading steps the seeding adds (a /new per seeded chat). Skip them when reading turns by index. */
	preludeSteps: number;
}

function stepOf(task: CapabilityTask, turn: TaskTurn): Step {
	const chat = turn.chat ?? DEFAULT_CHAT;
	const user = turn.user ?? task.setup.users?.[0] ?? DEFAULT_USER;
	const advanceMs = turn.advanceMs;
	if ("text" in turn)
		return { kind: "say", chat, user, text: turn.text, image: turn.image ? true : undefined, advanceMs };
	return turn.kind === "tick" ? { kind: "tick", advanceMs } : { kind: "new", chat, user, advanceMs };
}

/** A chat whose newest session would be continued must start fresh, unless the task means that session to be live. */
function hasPastSessionOnly(chat: NonNullable<CapabilityTask["setup"]["chats"]>[string]): boolean {
	const sessions = chat.sessions ?? [];
	return sessions.length > 0 && !sessions.some((session) => session.live);
}

/**
 * The task as a journey for `drive`. The gateway continues the most recent session of a chat, so a chat with only
 * past sessions starts with /new. Without it the seeded session would be the live one: `session_search` skips the
 * current session and the fact would already be in the context. A chat with a `live` session continues it on purpose,
 * and the agent has its messages in context.
 */
export function taskJourney(task: CapabilityTask): TaskJourney {
	const user = task.setup.users?.[0] ?? DEFAULT_USER;
	const prelude: Step[] = Object.entries(task.setup.chats ?? {})
		.filter(([, chat]) => hasPastSessionOnly(chat))
		.map(([key]) => ({ kind: "new", chat: Number(key), user }));
	return {
		journey: {
			id: task.id,
			description: task.description,
			users: task.setup.users ?? DEFAULT_USERS,
			start: Date.parse(task.setup.clock),
			steps: [...prelude, ...task.turns.map((turn) => stepOf(task, turn))],
		},
		preludeSteps: prelude.length,
	};
}

/**
 * Backends that answer from the task's canned web. A search matches when its query text contains a `match` string
 * (case-insensitive); a page is found by its URL. An unknown page comes back with an error, the way a dead link does.
 */
export function taskWebBackends(task: CapabilityTask): WebBackends {
	const { search = [], pages = {} } = task.setup.web ?? {};
	const backend: WebBackend = {
		name: "canned",
		search: async (request): Promise<WebResult[]> => {
			const text = `${request.objective} ${request.queries.join(" ")}`.toLowerCase();
			const hit = search.find((entry) => text.includes(entry.match.toLowerCase()));
			return (hit?.results ?? []).map((result) => ({
				url: result.url,
				title: result.title,
				excerpts: [result.excerpt],
			}));
		},
		fetch: async (request): Promise<FetchedPage[]> =>
			request.urls.map((url) => {
				const page = pages[url];
				if (!page) return { url, text: "", error: "404 Not Found" };
				return { url, text: page.text, images: page.images?.map((image) => ({ url: image })) };
			}),
	};
	return { search: [backend], fetch: [backend] };
}

const MINUTE = 60_000;

/** Every chat the task seeds or plays in. */
function chatsOf(task: CapabilityTask): number[] {
	const chats = new Set<number>([DEFAULT_CHAT, ...Object.keys(task.setup.chats ?? {}).map(Number)]);
	for (const turn of task.turns) chats.add(turn.chat ?? DEFAULT_CHAT);
	return [...chats];
}

/** Reads the memory files and skills of every chat of the task from a data directory. */
export function readTaskState(task: CapabilityTask, dataDir: string): StateSnapshot {
	const state: StateSnapshot = { memory: {}, skills: {} };
	for (const chat of chatsOf(task)) {
		const dir = join(chatDir(dataDir, chat), "memory");
		const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
		state.memory[String(chat)] = { user: read("USER.md"), memory: read("MEMORY.md") };
		state.skills[String(chat)] = new SkillStore(join(chatDir(dataDir, chat), "skills"))
			.list()
			.map(({ name, body }) => ({ name, body }));
	}
	return state;
}

/**
 * The trial a perfect agent would leave: the seeded state, the reference memory and skills, the reference reply on every
 * turn, a reference job on the last turn, and no tool calls. The state graders must pass on it.
 */
export function referenceInput(task: CapabilityTask, dataDir: string, timeZone = "Asia/Ho_Chi_Minh"): GradeInput {
	seedTask(task, dataDir);
	const before = readTaskState(task, dataDir);
	seedReference(task, dataDir);
	const after = readTaskState(task, dataDir);
	let clockMs = Date.parse(task.setup.clock);
	const turns = task.turns.map((turn) => {
		clockMs += turn.advanceMs ?? 0;
		return {
			user: "text" in turn ? turn.text : turn.kind,
			reply: task.reference.reply ?? "",
			clockMs,
			toolCalls: [],
			toolErrors: 0,
			jobs: [] as Job[],
		};
	});
	const last = turns.at(-1);
	const { jobDueInMinutes, jobAt, jobDaily } = task.reference;
	const job = (schedule: Job["schedule"], nextRunAt: number): Job => ({
		id: "reference",
		chatId: DEFAULT_CHAT,
		prompt: "reference",
		schedule,
		nextRunAt,
	});
	if (last && jobDueInMinutes !== undefined) {
		const at = last.clockMs + jobDueInMinutes * MINUTE;
		last.jobs = [job({ kind: "once", at }, at)];
	} else if (last && jobAt) {
		const [hour = 0, minute = 0] = jobAt.time.split(":").map(Number);
		const at = localMidnight(last.clockMs, jobAt.dayOffset, timeZone) + (hour * 60 + minute) * MINUTE;
		last.jobs = [job({ kind: "once", at }, at)];
	} else if (last && jobDaily) {
		last.jobs = [job({ kind: "daily", time: jobDaily }, last.clockMs)];
	}
	return { task, turns, before, after, timeZone };
}

/**
 * An image download for the task: every image URL the canned web lists answers with the fixture PNG, any other URL
 * with a 404. A reply that shows such an image reaches the transport as a photo, so a grader can see it.
 */
export function taskFetchImage(task: CapabilityTask): typeof fetch {
	const known = new Set(Object.values(task.setup.web?.pages ?? {}).flatMap((page) => page.images ?? []));
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!known.has(url)) return new Response("not found", { status: 404 });
		return new Response(fixturePhoto(), { headers: { "content-type": "image/png" } });
	}) as typeof fetch;
}
