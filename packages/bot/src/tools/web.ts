import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type CallToolResult, McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

/** Keeps one tool result from flooding the context window. */
const MAX_RESULT_CHARS = 20_000;

/** A search/fetch provider. Every built-in backend works without an API key. */
export interface WebBackend {
	name: string;
	search(query: string, signal?: AbortSignal): Promise<string>;
	fetch(urls: string[], signal?: AbortSignal): Promise<string>;
}

type ToolCaller = Pick<McpClient, "callTool" | "close">;

export interface McpWebBackendOptions {
	name: string;
	url: string;
	search: { tool: string; args: (query: string) => Record<string, unknown> };
	fetch: { tool: string; args: (urls: string[]) => Record<string, unknown> };
	/** Test seam. Defaults to a Streamable HTTP MCP client for `url`. */
	connect?: () => Promise<ToolCaller>;
}

/** Free tiers report throttling as a successful result, so the text and metadata decide. */
function mcpResultText(result: CallToolResult): string {
	const text = toLlmContent(result)
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
	const rateLimited = Object.entries(result._meta ?? {}).some(([key, value]) => /ratelimit/i.test(key) && value);
	if (result.isError || rateLimited) throw new Error(text.slice(0, 300) || "tool error");
	return text;
}

/** A hosted MCP server exposing search and fetch tools on a keyless free tier. */
export class McpWebBackend implements WebBackend {
	readonly name: string;
	private readonly options: McpWebBackendOptions;
	private client: Promise<ToolCaller> | undefined;

	constructor(options: McpWebBackendOptions) {
		this.name = options.name;
		this.options = options;
	}

	search(query: string, signal?: AbortSignal): Promise<string> {
		return this.call(this.options.search.tool, this.options.search.args(query), signal);
	}

	fetch(urls: string[], signal?: AbortSignal): Promise<string> {
		return this.call(this.options.fetch.tool, this.options.fetch.args(urls), signal);
	}

	private async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		this.client ??= (this.options.connect ?? (() => this.connectHttp()))();
		try {
			const client = await this.client;
			return mcpResultText(await client.callTool(tool, args, { signal, timeoutMs: 45_000 }));
		} catch (error) {
			// Drop the connection so the next call starts a fresh MCP session.
			const stale = this.client;
			this.client = undefined;
			void stale?.then((client) => client.close()).catch(() => {});
			throw error;
		}
	}

	private async connectHttp(): Promise<ToolCaller> {
		const client = new McpClient({ name: "agnes-bot", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url: this.options.url }));
		return client;
	}
}

export function createParallelBackend(): McpWebBackend {
	return new McpWebBackend({
		name: "parallel",
		url: "https://search.parallel.ai/mcp",
		search: { tool: "web_search", args: (query) => ({ objective: query, search_queries: [query] }) },
		fetch: { tool: "web_fetch", args: (urls) => ({ urls }) },
	});
}

export function createExaBackend(): McpWebBackend {
	return new McpWebBackend({
		name: "exa",
		url: "https://mcp.exa.ai/mcp",
		search: { tool: "web_search_exa", args: (query) => ({ query, numResults: 6 }) },
		fetch: { tool: "web_fetch_exa", args: (urls) => ({ urls, maxCharacters: 8000 }) },
	});
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity: string) => HTML_ENTITIES[entity] ?? "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n\n")
		.trim();
}

/** Parses DuckDuckGo's no-JavaScript results page into "title / url / snippet" blocks. */
export function parseDuckDuckGoLite(html: string): string {
	const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<td class='result-snippet'>([\s\S]*?)<\/td>/g)];
	return links
		.map((link, index) => {
			const href = (link[1] ?? "").replace(/&amp;/g, "&");
			const target = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
			return `${htmlToText(link[2] ?? "")}\n${target}\n${htmlToText(snippets[index]?.[1] ?? "")}`.trim();
		})
		.join("\n\n");
}

/** Last resort: scrapes DuckDuckGo lite for search and fetches pages directly. */
export class DuckDuckGoBackend implements WebBackend {
	readonly name = "duckduckgo";
	private readonly fetchFn: typeof fetch;

	constructor(fetchFn: typeof fetch = fetch) {
		this.fetchFn = fetchFn;
	}

	async search(query: string, signal?: AbortSignal): Promise<string> {
		const html = await this.get(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, signal);
		const results = parseDuckDuckGoLite(html);
		// Throttled clients get HTTP 202 with an "anomaly" challenge page instead of results.
		if (!results) throw new Error(html.includes("anomaly") ? "blocked by bot check" : "no results");
		return results;
	}

	async fetch(urls: string[], signal?: AbortSignal): Promise<string> {
		const pages = await Promise.all(
			urls.map(async (url) => {
				try {
					return `# ${url}\n${htmlToText(await this.get(url, signal))}`;
				} catch (error) {
					return `# ${url}\n(failed: ${(error as Error).message})`;
				}
			}),
		);
		return pages.join("\n\n");
	}

	private async get(url: string, signal?: AbortSignal): Promise<string> {
		const response = await this.fetchFn(url, {
			headers: { "user-agent": "Mozilla/5.0 (compatible; agnes-bot)" },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.text();
	}
}

export function createDefaultWebBackends(): WebBackend[] {
	return [createParallelBackend(), createExaBackend(), new DuckDuckGoBackend()];
}

/** Tries each backend in order and returns the first success, Hermes-style. */
async function firstSuccess(
	backends: WebBackend[],
	run: (backend: WebBackend) => Promise<string>,
): Promise<{ backend: string; text: string }> {
	const failures: string[] = [];
	for (const backend of backends) {
		try {
			const text = await run(backend);
			if (text.trim()) return { backend: backend.name, text };
			failures.push(`${backend.name}: empty result`);
		} catch (error) {
			failures.push(`${backend.name}: ${(error as Error).message}`);
		}
	}
	throw new Error(`All web backends failed.\n${failures.join("\n")}`);
}

function truncate(text: string): string {
	return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : text;
}

export function createWebTools(backends: WebBackend[]): ToolDefinition[] {
	const webSearch = defineTool({
		name: "web_search",
		label: "Web search",
		description: "Search the web for current information. Returns titles, URLs and excerpts.",
		promptSnippet: "web_search: search the web for fresh facts",
		parameters: Type.Object({ query: Type.String({ description: "What to look for, as a short query" }) }),
		async execute(_id, params, signal) {
			const { backend, text } = await firstSuccess(backends, (b) => b.search(params.query, signal));
			return { content: [{ type: "text", text: truncate(text) }], details: { backend } };
		},
	});
	const webFetch = defineTool({
		name: "web_fetch",
		label: "Web fetch",
		description: "Read the content of web pages as text.",
		promptSnippet: "web_fetch: read web pages by URL",
		parameters: Type.Object({ urls: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }) }),
		async execute(_id, params, signal) {
			const { backend, text } = await firstSuccess(backends, (b) => b.fetch(params.urls, signal));
			return { content: [{ type: "text", text: truncate(text) }], details: { backend } };
		},
	});
	return [webSearch, webFetch];
}
