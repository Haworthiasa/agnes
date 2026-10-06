import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { chatDir, createBot } from "../../src/bot.ts";
import { type Job, JobStore } from "../../src/scheduler.ts";
import { SkillStore } from "../../src/skills.ts";
import { FakeTransport } from "../helpers.ts";
import { drive } from "./drive.ts";
import type { Journey, Step } from "./journeys.ts";

const TIME_ZONE = "Asia/Ho_Chi_Minh";

/** Catalog price in dollars per million tokens, saved with each result so old runs stay comparable. */
export interface PriceSnapshot {
	model: string;
	inputPerM: number;
	outputPerM: number;
	cacheReadPerM: number;
	cacheWritePerM: number;
}

export function priceOf(model: Model<Api>): PriceSnapshot {
	return {
		model: `${model.provider}/${model.id}`,
		inputPerM: model.cost.input,
		outputPerM: model.cost.output,
		cacheReadPerM: model.cost.cacheRead,
		cacheWritePerM: model.cost.cacheWrite,
	};
}

export function costOf(
	price: PriceSnapshot,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
	return (
		(usage.input * price.inputPerM +
			usage.output * price.outputPerM +
			usage.cacheRead * price.cacheReadPerM +
			usage.cacheWrite * price.cacheWritePerM) /
		1_000_000
	);
}

export interface LiveTurn {
	index: number;
	kind: Step["kind"];
	user: string;
	reply: string;
	clockMs: number;
	wallMs: number;
	modelCalls: number;
	/** Prompt tokens the provider did not serve from cache. */
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	/** Cost the provider's usage report states. */
	costReported: number;
	/** Cost recomputed from the saved price snapshot. */
	costComputed: number;
	toolCalls: string[];
	systemMessagesAdded: number;
	/** Tool calls that came back as an error. */
	toolErrors: number;
	/** Scheduled jobs after the step. */
	jobs: Job[];
}

export interface LiveRun {
	journeyId: string;
	salt: string;
	turns: LiveTurn[];
	memory: Record<string, { user: string | null; memory: string | null }>;
	/** The skills saved in each chat at the end. */
	skills: Record<string, Array<{ name: string; body: string }>>;
}

interface StoredAssistant {
	key: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
	toolNames: string[];
}

interface StoredEntry {
	message?: {
		role?: string;
		isError?: boolean;
		usage?: StoredAssistant["usage"];
		content?: Array<{ type: string; name?: string }>;
	};
	role?: string;
	usage?: StoredAssistant["usage"];
	content?: Array<{ type: string; name?: string }>;
}

/** Reads the assistant turns and the system message count from every stored transcript. */
function readStored(dataDir: string): { assistants: StoredAssistant[]; systemMessages: number; toolErrors: number } {
	const assistants: StoredAssistant[] = [];
	let systemMessages = 0;
	let toolErrors = 0;
	const chats = join(dataDir, "chats");
	if (!existsSync(chats)) return { assistants, systemMessages, toolErrors };
	for (const chat of readdirSync(chats)) {
		const sessions = join(chats, chat, "sessions");
		if (!existsSync(sessions)) continue;
		for (const file of readdirSync(sessions).filter((name) => name.endsWith(".jsonl"))) {
			for (const [index, line] of readFileSync(join(sessions, file), "utf8").split("\n").entries()) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as StoredEntry;
				const message = entry.message ?? entry;
				if (message.role === "system") systemMessages++;
				if (message.role === "toolResult" && message.isError) toolErrors++;
				if (message.role === "assistant" && message.usage) {
					assistants.push({
						key: `${chat}/${file}#${index}`,
						usage: message.usage,
						toolNames: (message.content ?? []).flatMap((part) =>
							part.type === "toolCall" && part.name ? [part.name] : [],
						),
					});
				}
			}
		}
	}
	return { assistants, systemMessages, toolErrors };
}

export interface LiveOptions {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
}

/** Plays a journey against the real model and measures every step from the stored transcripts. */
export async function runLiveJourney(journey: Journey, options: LiveOptions): Promise<LiveRun> {
	const dataDir = mkdtempSync(join(tmpdir(), "agnes-eval-"));
	const price = priceOf(options.model);
	const salt = `eval-run ${randomUUID()}`;
	try {
		const clock = { now: journey.start };
		const transport = new FakeTransport();
		const turns = await drive(
			journey,
			{
				start: () =>
					createBot({
						dataDir,
						modelRuntime: options.modelRuntime,
						model: options.model,
						transport,
						allowedUserIds: new Set(journey.users),
						allowShell: false,
						timeZone: TIME_ZONE,
						webBackends: { search: [], fetch: [] },
						now: () => clock.now,
						promptSalt: salt,
					}),
				transport,
				clock,
			},
			() => {
				const stored = readStored(dataDir);
				return {
					seen: new Set(stored.assistants.map((entry) => entry.key)),
					system: stored.systemMessages,
					errors: stored.toolErrors,
				};
			},
			(before, { index, step, reply, wallMs, clockMs }): LiveTurn => {
				const stored = readStored(dataDir);
				const fresh = stored.assistants.filter((entry) => !before.seen.has(entry.key));
				const sum = (pick: (usage: StoredAssistant["usage"]) => number) =>
					fresh.reduce((total, entry) => total + pick(entry.usage), 0);
				const usage = {
					input: sum((u) => u.input),
					output: sum((u) => u.output),
					cacheRead: sum((u) => u.cacheRead),
					cacheWrite: sum((u) => u.cacheWrite),
				};
				return {
					index,
					kind: step.kind,
					user: step.kind === "say" ? step.text : step.kind,
					reply,
					clockMs,
					wallMs,
					modelCalls: fresh.length,
					...usage,
					costReported: sum((u) => u.cost?.total ?? 0),
					costComputed: costOf(price, usage),
					toolCalls: fresh.flatMap((entry) => entry.toolNames),
					systemMessagesAdded: stored.systemMessages - before.system,
					toolErrors: stored.toolErrors - before.errors,
					jobs: new JobStore(join(dataDir, "jobs.json")).all(),
				};
			},
		);
		const memory: LiveRun["memory"] = {};
		for (const chat of new Set(journey.steps.flatMap((step) => ("chat" in step ? [step.chat] : [])))) {
			const dir = join(chatDir(dataDir, chat), "memory");
			const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
			memory[String(chat)] = { user: read("USER.md"), memory: read("MEMORY.md") };
		}
		const skills: LiveRun["skills"] = {};
		for (const chat of new Set(journey.steps.flatMap((step) => ("chat" in step ? [step.chat] : [])))) {
			skills[String(chat)] = new SkillStore(join(chatDir(dataDir, chat), "skills"))
				.list()
				.map(({ name, body }) => ({ name, body }));
		}
		return { journeyId: journey.id, salt, turns, memory, skills };
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}
