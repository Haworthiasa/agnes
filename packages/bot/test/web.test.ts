import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBotAgentFactory } from "../src/agent.ts";
import { createWebTools, McpWebBackend, parseDuckDuckGoLite, type WebBackend } from "../src/tools/web.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

const exaRateLimited = new McpWebBackend({
	name: "exa",
	url: "https://example.invalid/mcp",
	search: { tool: "web_search_exa", args: (query) => ({ query }) },
	fetch: { tool: "web_fetch_exa", args: (urls) => ({ urls }) },
	connect: async () => ({
		callTool: async () => ({
			_meta: { "ai.exa/rateLimited": true },
			content: [{ type: "text", text: "You've hit Exa's free MCP rate limit." }],
		}),
		close: async () => {},
	}),
});

function staticBackend(name: string, text: string): WebBackend {
	return {
		name,
		search: async (query) => `${text} for ${query}`,
		fetch: async (urls) => `${text} of ${urls.join(",")}`,
	};
}

function lastToolResult(context: TranscriptContext): string {
	const result = context.messages.findLast((message) => message.role === "toolResult");
	if (result?.role !== "toolResult") return "";
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("web tools inside an agent turn", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	async function runSearch(backends: WebBackend[]): Promise<string> {
		runtime = await createFauxRuntime();
		let seen = "";
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "dots" })], { stopReason: "toolUse" }),
			(context) => {
				seen = lastToolResult(context);
				return fauxAssistantMessage("done");
			},
		]);
		const createAgent = createBotAgentFactory({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			allowShell: false,
			systemPrompt: () => "test",
			tools: () => createWebTools(backends),
		});
		const agent = await createAgent(1, { fresh: true });
		await agent.prompt("search dots");
		agent.dispose();
		return seen;
	}

	it("skips a rate-limited free tier and uses the next backend", async () => {
		expect(await runSearch([exaRateLimited, staticBackend("ddg", "results")])).toBe("results for dots");
	});

	it("reports every backend failure when all fail", async () => {
		const seen = await runSearch([exaRateLimited]);
		expect(seen).toContain("All web backends failed.");
		expect(seen).toContain("exa: You've hit Exa's free MCP rate limit.");
	});
});

describe("parseDuckDuckGoLite", () => {
	it("extracts title, real URL and snippet from the lite results page", () => {
		const html = readFileSync(new URL("./fixtures/duckduckgo-lite.html", import.meta.url), "utf8");
		expect(parseDuckDuckGoLite(html).split("\n\n")[0]).toBe(
			[
				"Introducing dots - OpenAI",
				"https://openai.com/index/introducing-dots/",
				"Dots by OpenAI are proactive assistants that can keep working across complex projects and everyday tasks. Learn how dots help you stay in control while work moves forward.",
			].join("\n"),
		);
	});
});
