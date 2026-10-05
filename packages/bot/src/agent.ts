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

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const SHELL_TOOLS = ["bash", "edit", "write"];

export interface BotAgentFactoryOptions {
	dataDir: string;
	modelRuntime: ModelRuntime;
	/** Omit to use the default model from the runtime's stored settings. */
	model?: Model<Api>;
	/** Enables bash, edit and write in the workspace. Off by default: the bot is reachable from the internet. */
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

	return async (chatId, { fresh }) => {
		const sessionDir = join(options.dataDir, "chats", String(chatId), "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const customTools = options.tools?.(chatId) ?? [];
		const builtinTools = options.allowShell ? [...READ_ONLY_TOOLS, ...SHELL_TOOLS] : READ_ONLY_TOOLS;
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir: join(options.dataDir, "agent"),
			modelRuntime: options.modelRuntime,
			model: options.model,
			resourceLoader: createBotResourceLoader(() => options.systemPrompt(chatId)),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
			sessionManager: fresh
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
