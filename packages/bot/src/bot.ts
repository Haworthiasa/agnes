import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBotAgentFactory } from "./agent.ts";
import { Gateway } from "./gateway.ts";
import { JobStore, Scheduler } from "./scheduler.ts";
import { createMemoryTool, MemoryStore } from "./tools/memory.ts";
import { createScheduleTool } from "./tools/schedule.ts";
import { createWebTools, type WebBackend } from "./tools/web.ts";
import type { ChatTransport } from "./types.ts";

export interface BotOptions {
	dataDir: string;
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	transport: ChatTransport;
	allowedUserIds: ReadonlySet<number>;
	allowShell: boolean;
	timeZone: string;
	webBackends: WebBackend[];
	now?: () => number;
}

export interface Bot {
	gateway: Gateway;
	scheduler: Scheduler;
}

export function chatDir(dataDir: string, chatId: number): string {
	return join(dataDir, "chats", String(chatId));
}

function persona(timeZone: string, now: number): string {
	const localTime = new Date(now).toLocaleString("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" });
	return [
		"You are Agnes, a personal assistant chatting on Telegram.",
		"Reply in the user's language. Keep replies short. Use plain text, not Markdown tables.",
		"Use web_search for anything that may have changed recently, and cite the URLs you used.",
		"Use schedule for reminders and recurring tasks such as a daily brief.",
		`Current time: ${localTime} (${timeZone}).`,
	].join("\n");
}

/** Wires transport, per-chat sessions, memory, web and scheduling into one running bot. */
export function createBot(options: BotOptions): Bot {
	const now = options.now ?? Date.now;
	const webTools = createWebTools(options.webBackends);
	const memory = (chatId: number) => new MemoryStore(join(chatDir(options.dataDir, chatId), "memory"));
	// The scheduler and the agents reference each other, so the factory reads it lazily.
	const scheduler: Scheduler = new Scheduler({
		store: new JobStore(join(options.dataDir, "jobs.json")),
		transport: options.transport,
		createAgent: (chatId, agentOptions) => createAgent(chatId, agentOptions),
		timeZone: options.timeZone,
		now,
	});
	const createAgent = createBotAgentFactory({
		dataDir: options.dataDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		allowShell: options.allowShell,
		systemPrompt: (chatId) => `${persona(options.timeZone, now())}\n\n${memory(chatId).render()}`,
		tools: (chatId) => [...webTools, createMemoryTool(memory(chatId)), createScheduleTool(scheduler, chatId)],
	});
	const gateway = new Gateway({
		transport: options.transport,
		allowedUserIds: options.allowedUserIds,
		createAgent,
	});
	return { gateway, scheduler };
}
