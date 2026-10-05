import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBotAgentFactory } from "./agent.ts";
import { Gateway } from "./gateway.ts";
import { createMemoryTool, MemoryStore } from "./tools/memory.ts";
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
}

export function chatDir(dataDir: string, chatId: number): string {
	return join(dataDir, "chats", String(chatId));
}

function persona(timeZone: string): string {
	return [
		"You are Agnes, a personal assistant chatting on Telegram.",
		"Reply in the user's language. Keep replies short. Use plain text, not Markdown tables.",
		"Use web_search for anything that may have changed recently, and cite the URLs you used.",
		`The user's time zone is ${timeZone}.`,
	].join("\n");
}

/** Wires transport, per-chat sessions, memory and tools into one running bot. */
export function createBot(options: BotOptions): Gateway {
	const webTools = createWebTools(options.webBackends);
	const memory = (chatId: number) => new MemoryStore(join(chatDir(options.dataDir, chatId), "memory"));
	return new Gateway({
		transport: options.transport,
		allowedUserIds: options.allowedUserIds,
		createAgent: createBotAgentFactory({
			dataDir: options.dataDir,
			modelRuntime: options.modelRuntime,
			model: options.model,
			allowShell: options.allowShell,
			systemPrompt: (chatId) => `${persona(options.timeZone)}\n\n${memory(chatId).render()}`,
			tools: (chatId) => [...webTools, createMemoryTool(memory(chatId))],
		}),
	});
}
