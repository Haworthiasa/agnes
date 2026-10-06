import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chatDir, createBot } from "../../src/bot.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "../helpers.ts";
import { CacheSimulator, type ProviderProfile, ZAI_PROFILE } from "./cache-sim.ts";
import { drive } from "./drive.ts";
import type { Journey, Step } from "./journeys.ts";
import { installPolicy, type PolicyLog } from "./policy.ts";

const TIME_ZONE = "Asia/Ho_Chi_Minh";

export interface TurnResult {
	index: number;
	kind: Step["kind"];
	chat: number | null;
	user: string;
	reply: string;
	modelCalls: number;
	promptTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	/** System messages this turn added to the stored transcripts. */
	systemMessagesAdded: number;
	toolCalls: string[];
	/** Wall time of the bot's own code. The scripted model answers at once, so this excludes model time. */
	cpuMs: number;
}

export interface JourneyTotals {
	turns: number;
	modelCalls: number;
	promptTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	cacheHitRate: number;
	systemMessages: number;
	prefixBreaks: number;
	cpuMs: number;
}

export interface JourneyResult {
	id: string;
	description: string;
	profile: string;
	turns: TurnResult[];
	totals: JourneyTotals;
	/** Raw memory files per chat at the end of the journey. */
	memory: Record<string, { user: string | null; memory: string | null }>;
	/** First system prompt of each session, in the order sessions started. */
	sessionPrompts: string[];
	/** `restart` steps. A restart reopens the latest session, so it may rewrite the prompt once. */
	restarts: number;
	/** Names of the tools the model called. */
	toolNames: string[];
	/** Parameter schema (JSON) of every tool the last request declared. */
	toolSchemas: Record<string, string>;
}

function readIfExists(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Counts `system` entries in every stored session transcript under the data directory. */
function countSystemMessages(dataDir: string): number {
	const chats = join(dataDir, "chats");
	if (!existsSync(chats)) return 0;
	let count = 0;
	for (const chat of readdirSync(chats)) {
		const sessions = join(chats, chat, "sessions");
		if (!existsSync(sessions)) continue;
		for (const file of readdirSync(sessions).filter((name) => name.endsWith(".jsonl"))) {
			for (const line of readFileSync(join(sessions, file), "utf8").split("\n")) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as { message?: { role?: string }; role?: string };
				if ((entry.message?.role ?? entry.role) === "system") count++;
			}
		}
	}
	return count;
}

export interface RunOptions {
	profile?: ProviderProfile;
}

/** Runs one journey through the real bot (gateway, sessions, tools, scheduler) with the scripted model. */
export async function runJourney(journey: Journey, options: RunOptions = {}): Promise<JourneyResult> {
	const runtime: FauxRuntime = await createFauxRuntime();
	try {
		const clock = { now: journey.start };
		const simulator = new CacheSimulator(options.profile ?? ZAI_PROFILE);
		const log: PolicyLog = { toolCalls: [], toolSchemas: {} };
		installPolicy(runtime.faux, simulator, () => clock.now, log);
		const transport = new FakeTransport();
		const env = {
			start: () =>
				createBot({
					dataDir: runtime.dataDir,
					modelRuntime: runtime.modelRuntime,
					model: runtime.faux.getModel(),
					transport,
					allowedUserIds: new Set(journey.users),
					allowShell: false,
					timeZone: TIME_ZONE,
					webBackends: { search: [], fetch: [] },
					now: () => clock.now,
				}),
			transport,
			clock,
		};
		const turns = await drive(
			journey,
			env,
			() => ({
				calls: simulator.calls.length,
				tools: log.toolCalls.length,
				system: countSystemMessages(runtime.dataDir),
			}),
			(before, { index, step, reply, wallMs }): TurnResult => {
				const calls = simulator.calls.slice(before.calls);
				return {
					index,
					kind: step.kind,
					chat: "chat" in step ? step.chat : null,
					user: step.kind === "say" ? step.text : step.kind,
					reply,
					modelCalls: calls.length,
					promptTokens: calls.reduce((sum, call) => sum + call.promptTokens, 0),
					cachedTokens: calls.reduce((sum, call) => sum + call.cachedTokens, 0),
					uncachedTokens: calls.reduce((sum, call) => sum + call.uncachedTokens, 0),
					systemMessagesAdded: countSystemMessages(runtime.dataDir) - before.system,
					toolCalls: log.toolCalls.slice(before.tools).map((call) => call.name),
					cpuMs: wallMs,
				};
			},
		);
		const chats = new Set(journey.steps.flatMap((step) => ("chat" in step ? [step.chat] : [])));

		const sum = (pick: (turn: TurnResult) => number) => turns.reduce((total, turn) => total + pick(turn), 0);
		const promptTokens = sum((turn) => turn.promptTokens);
		const cachedTokens = sum((turn) => turn.cachedTokens);
		const memory: JourneyResult["memory"] = {};
		for (const chat of chats) {
			const dir = join(chatDir(runtime.dataDir, chat), "memory");
			memory[String(chat)] = {
				user: readIfExists(join(dir, "USER.md")),
				memory: readIfExists(join(dir, "MEMORY.md")),
			};
		}
		return {
			id: journey.id,
			description: journey.description,
			profile: simulator.profile.name,
			turns,
			totals: {
				turns: turns.length,
				modelCalls: sum((turn) => turn.modelCalls),
				promptTokens,
				cachedTokens,
				uncachedTokens: sum((turn) => turn.uncachedTokens),
				cacheHitRate: promptTokens === 0 ? 0 : cachedTokens / promptTokens,
				systemMessages: countSystemMessages(runtime.dataDir),
				prefixBreaks: simulator.prefixBreaks.length,
				cpuMs: sum((turn) => turn.cpuMs),
			},
			memory,
			sessionPrompts: [...simulator.firstSystemPrompt.values()],
			restarts: journey.steps.filter((step) => step.kind === "restart").length,
			toolNames: [...new Set(log.toolCalls.map((call) => call.name))],
			toolSchemas: log.toolSchemas,
		};
	} finally {
		runtime.cleanup();
	}
}
