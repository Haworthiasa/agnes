import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ChatAgent, ChatAgentFactory } from "./types.ts";

// pi's file tools accept absolute paths, so they can reach secrets outside the workspace.
const SHELL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export interface BotAgentFactoryOptions {
	dataDir: string;
	modelRuntime: ModelRuntime;
	/** Omit to use the default model from the runtime's stored settings. */
	model?: Model<Api>;
	/**
	 * Enables pi's file and shell tools. Off by default: the bot reads untrusted web pages, and these tools are
	 * not confined to the workspace, so an injected page could read local secrets and send them out via web_fetch.
	 */
	allowShell: boolean;
	/** Re-read before every turn, so memory written in one turn reaches the next. */
	systemPrompt: (chatId: number) => string;
	tools?: (chatId: number) => ToolDefinition[];
}

/** Explicit loader: default discovery would pull the host's AGENTS.md, skills and extensions into the bot. */
function createBotResourceLoader(systemPrompt: () => string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function replyText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
	if (message.stopReason === "error") return `${text}\n(Lỗi model: ${message.errorMessage ?? "không rõ"})`.trim();
	return text;
}

export function createBotAgentFactory(options: BotAgentFactoryOptions): ChatAgentFactory {
	const workspace = join(options.dataDir, "workspace");
	mkdirSync(workspace, { recursive: true });

	return async (chatId, { fresh, ephemeral }) => {
		const sessionDir = join(options.dataDir, "chats", String(chatId), "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const customTools = options.tools?.(chatId) ?? [];
		const builtinTools = options.allowShell ? SHELL_TOOLS : [];
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir: join(options.dataDir, "agent"),
			modelRuntime: options.modelRuntime,
			model: options.model,
			resourceLoader: createBotResourceLoader(() => options.systemPrompt(chatId)),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
			sessionManager: ephemeral
				? SessionManager.inMemory(workspace)
				: fresh
					? SessionManager.create(workspace, sessionDir)
					: SessionManager.continueRecent(workspace, sessionDir),
			// An explicit tool list enables only the names it contains, custom tools included.
			tools: [...builtinTools, ...customTools.map((tool) => tool.name)],
			customTools,
		});

		const agent: ChatAgent = {
			async prompt(text) {
				// Re-applying the loadout rebuilds the system prompt from the loader, picking up new memory.
				session.setActiveToolsByName(session.getActiveToolNames());
				await session.prompt(text, { source: "rpc" });
				const last = session.messages.findLast((message) => message.role === "assistant");
				return replyText(last as AssistantMessage | undefined);
			},
			dispose: () => session.dispose(),
		};
		return agent;
	};
}
