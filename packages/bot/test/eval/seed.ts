import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatDir } from "../../src/bot.ts";
import { SkillStore } from "../../src/skills.ts";
import { MemoryStore, type MemoryTarget } from "../../src/tools/memory.ts";
import type { FetchedPage, WebBackend, WebBackends, WebResult } from "../../src/tools/web.ts";
import type { Journey, Step } from "./journeys.ts";
import { type CapabilityTask, DEFAULT_CHAT, DEFAULT_USER, DEFAULT_USERS, type TaskTurn } from "./tasks.ts";

const DAY = 24 * 60 * 60_000;

export type Line = { role: "user" | "assistant" | "toolResult" | "system"; text: string };

interface StoredLine {
	type: "session" | "message";
	id: string;
	timestamp: string;
	version?: number;
	cwd?: string;
	message?: { role: Line["role"]; content: string | Array<{ type: "text"; text: string }> };
}

/** One stored transcript in the shape pi writes: a session header, then one entry per message. */
export function transcript(
	id: string,
	messages: Line[],
	startMs = Date.parse("2026-10-05T08:00:00Z"),
	cwd = "/w",
): string {
	const lines: StoredLine[] = [{ type: "session", version: 3, id, timestamp: new Date(startMs).toISOString(), cwd }];
	for (const [index, message] of messages.entries()) {
		lines.push({
			type: "message",
			id: `e${index}`,
			timestamp: new Date(startMs + index * 1000).toISOString(),
			message: {
				role: message.role,
				content: message.role === "user" ? message.text : [{ type: "text", text: message.text }],
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

/** Writes the reference memory and skills into the default chat, to check that the state graders accept it. */
export function seedReference(task: CapabilityTask, dataDir: string): void {
	const { memory, skills } = task.reference;
	if (memory) seedMemory(dataDir, DEFAULT_CHAT, memory);
	if (skills) seedSkills(dataDir, DEFAULT_CHAT, skills);
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

/**
 * The task as a journey for `drive`. The gateway continues the most recent session of a chat, so every chat with a
 * seeded session starts with /new. Without it the seeded session would be the live one: `session_search` skips the
 * current session and the fact would already be in the context.
 */
export function taskJourney(task: CapabilityTask): TaskJourney {
	const user = task.setup.users?.[0] ?? DEFAULT_USER;
	const prelude: Step[] = Object.entries(task.setup.chats ?? {})
		.filter(([, chat]) => (chat.sessions?.length ?? 0) > 0)
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
