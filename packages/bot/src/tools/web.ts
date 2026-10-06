import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type CallToolResult, McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { normalizeUrl } from "../citations.ts";

/** Keeps one tool result from flooding the context window. Split evenly between results or pages. */
const MAX_RESULT_CHARS = 20_000;

export interface SearchRequest {
	/** What to find, how fresh it must be, which sources count. Written by the model. */
	objective: string;
	/** 1-3 short keyword queries. */
	queries: string[];
}

export interface FetchRequest {
	urls: string[];
	/** What to look for on the pages. Backends that support it focus their extraction on it. */
	objective?: string;
	/** Characters the tool keeps per page. A backend may return more; the tool cuts it to the objective. */
	maxCharsPerPage: number;
}

/** One search hit, the same shape for every backend. */
export interface WebResult {
	url: string;
	title: string;
	/** ISO date as the backend reported it. Undefined when unknown. */
	published?: string;
	excerpts: string[];
}

export interface FetchedPage {
	url: string;
	title?: string;
	published?: string;
	text: string;
	error?: string;
}

/** A search and/or fetch provider. Every built-in backend works without an API key. */
export interface WebBackend {
	name: string;
	search?(request: SearchRequest, signal?: AbortSignal): Promise<WebResult[]>;
	fetch?(request: FetchRequest, signal?: AbortSignal): Promise<FetchedPage[]>;
}

/** Search and fetch use different orders: the best searcher is not the best page reader. */
export interface WebBackends {
	search: WebBackend[];
	fetch: WebBackend[];
}

type ToolCaller = Pick<McpClient, "callTool" | "close">;

export interface McpWebBackendOptions {
	name: string;
	url: string;
	search?: {
		tool: string;
		args: (request: SearchRequest) => Record<string, unknown>;
		parse: (text: string) => WebResult[];
	};
	fetch?: {
		tool: string;
		args: (request: FetchRequest) => Record<string, unknown>;
		parse: (text: string) => FetchedPage[];
	};
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
	readonly search?: WebBackend["search"];
	readonly fetch?: WebBackend["fetch"];
	private readonly options: McpWebBackendOptions;
	private client: Promise<ToolCaller> | undefined;

	constructor(options: McpWebBackendOptions) {
		this.name = options.name;
		this.options = options;
		const { search, fetch } = options;
		if (search)
			this.search = async (request, signal) =>
				search.parse(await this.call(search.tool, search.args(request), signal));
		if (fetch)
			this.fetch = async (request, signal) => fetch.parse(await this.call(fetch.tool, fetch.args(request), signal));
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

interface ParallelItem {
	url?: string;
	title?: string | null;
	publish_date?: string | null;
	excerpts?: string[] | null;
	full_content?: string | null;
}

function parallelItems(text: string): ParallelItem[] {
	const parsed = JSON.parse(text) as { results?: ParallelItem[] };
	return parsed.results ?? [];
}

export function parseParallelSearch(text: string): WebResult[] {
	return parallelItems(text)
		.filter((item) => item.url)
		.map((item) => ({
			url: item.url as string,
			title: item.title ?? "",
			published: item.publish_date ?? undefined,
			excerpts: item.excerpts ?? [],
		}));
}

export function parseParallelFetch(text: string): FetchedPage[] {
	return parallelItems(text)
		.filter((item) => item.url)
		.map((item) => ({
			url: item.url as string,
			title: item.title ?? undefined,
			published: item.publish_date ?? undefined,
			text: item.full_content ?? (item.excerpts ?? []).join("\n\n"),
		}));
}

export function createParallelBackend(): McpWebBackend {
	// Parallel's free tier keys rate limits on a stable session id.
	const sessionId = randomUUID();
	return new McpWebBackend({
		name: "parallel",
		url: "https://search.parallel.ai/mcp",
		search: {
			tool: "web_search",
			args: ({ objective, queries }) => ({ objective, search_queries: queries, session_id: sessionId }),
			parse: parseParallelSearch,
		},
		fetch: {
			tool: "web_fetch",
			args: ({ urls, objective }) => ({ urls, objective: objective?.slice(0, 200) ?? null, session_id: sessionId }),
			parse: parseParallelFetch,
		},
	});
}

/** Exa answers in plain text blocks: "Title: …", "URL: …", "Published Date: …", then the text. */
export function parseExaSearch(text: string): WebResult[] {
	return text
		.split(/\n(?=Title: )/)
		.map((block) => {
			const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, "m").exec(block)?.[1]?.trim();
			const body = block
				.split("\n")
				.filter((line) => !/^(Title|URL|Published Date|Published|Author|Image|Favicon|ID):/.test(line))
				.map((line) => line.replace(/^(Highlights|Text|Summary): ?/, ""))
				.join("\n")
				.trim();
			const published = field("Published Date") ?? field("Published");
			return {
				url: field("URL") ?? "",
				title: field("Title") ?? "",
				published: published && /\d{4}/.test(published) ? published : undefined,
				excerpts: body ? [body] : [],
			};
		})
		.filter((result) => result.url);
}

/** Exa's fetch answers "# Title\nURL: …\n<markdown>" per page. */
export function parseExaFetch(text: string): FetchedPage[] {
	return text
		.split(/\n(?=# .*\nURL: )/)
		.map((block) => {
			const url = /^URL: (.*)$/m.exec(block)?.[1]?.trim() ?? "";
			const title = /^# (.*)$/m.exec(block)?.[1]?.trim();
			return {
				url,
				title,
				text: block
					.replace(/^# .*\n/, "")
					.replace(/^URL: .*\n?/m, "")
					.trim(),
			};
		})
		.filter((page) => page.url);
}

export function createExaBackend(): McpWebBackend {
	return new McpWebBackend({
		name: "exa",
		url: "https://mcp.exa.ai/mcp",
		search: {
			tool: "web_search_exa",
			args: ({ objective }) => ({ query: objective, objective, numResults: 8 }),
			parse: parseExaSearch,
		},
		// Exa returns the head of the page; ask for a lot and let the tool cut to the objective.
		fetch: { tool: "web_fetch_exa", args: ({ urls }) => ({ urls, maxCharacters: 60_000 }), parse: parseExaFetch },
	});
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	copy: "©",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] === "#") {
			const code =
				entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

/** The page's main content as text: tables as "a | b" rows, navigation and chrome dropped. */
export function htmlToText(html: string): string {
	const main = /<(main|article)\b[\s\S]*<\/\1>/i.exec(html)?.[0] ?? html;
	return decodeEntities(
		main
			.replace(/<!--[\s\S]*?-->/g, "")
			// Source newlines inside a row would split one table row into a line per cell.
			.replace(/<tr\b[\s\S]*?<\/tr>/gi, (row) => row.replace(/\s*\n\s*/g, " "))
			.replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, "")
			.replace(/<\/t[dh]>/gi, " | ")
			.replace(/<li\b[^>]*>/gi, "\n- ")
			.replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
			.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|pre|section|dt|dd)>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\| *\n/g, "\n")
		.replace(/\n +/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function pageTitle(html: string): string | undefined {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	return title ? decodeEntities(title).replace(/\s+/g, " ").trim() : undefined;
}

/** Parses DuckDuckGo's no-JavaScript results page. */
export function parseDuckDuckGoLite(html: string): WebResult[] {
	const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<td class='result-snippet'>([\s\S]*?)<\/td>/g)];
	return links.map((link, index) => {
		const href = (link[1] ?? "").replace(/&amp;/g, "&");
		const snippet = htmlToText(snippets[index]?.[1] ?? "");
		return {
			url: new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href,
			title: htmlToText(link[2] ?? ""),
			excerpts: snippet ? [snippet] : [],
		};
	});
}

const USER_AGENT = "Mozilla/5.0 (compatible; agnes-bot)";

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** Last-resort search: scrapes DuckDuckGo lite. */
export class DuckDuckGoBackend implements WebBackend {
	readonly name = "duckduckgo";
	private readonly fetchFn: typeof fetch;

	constructor(fetchFn: typeof fetch = fetch) {
		this.fetchFn = fetchFn;
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<WebResult[]> {
		const query = request.queries[0] ?? request.objective;
		const response = await this.fetchFn(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
			headers: { "user-agent": USER_AGENT },
			signal: timeoutSignal(signal, 20_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const html = await response.text();
		const results = parseDuckDuckGoLite(html);
		// Throttled clients get HTTP 202 with an "anomaly" challenge page instead of results.
		if (results.length === 0) throw new Error(html.includes("anomaly") ? "blocked by bot check" : "no results");
		return results;
	}
}

/** Reads pages straight from their origin. Sees what a browser without JavaScript sees. */
export class DirectFetchBackend implements WebBackend {
	readonly name = "direct";
	private readonly fetchFn: typeof fetch;

	constructor(fetchFn: typeof fetch = fetch) {
		this.fetchFn = fetchFn;
	}

	fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchedPage[]> {
		return Promise.all(request.urls.map((url) => this.fetchOne(url, signal)));
	}

	private async fetchOne(url: string, signal?: AbortSignal): Promise<FetchedPage> {
		try {
			const response = await this.fetchFn(url, {
				headers: {
					"user-agent": USER_AGENT,
					accept: "text/html,application/xhtml+xml,text/plain,application/json",
				},
				signal: timeoutSignal(signal, 20_000),
			});
			if (!response.ok) return { url, text: "", error: `HTTP ${response.status}` };
			const type = response.headers.get("content-type") ?? "";
			if (/html|xml/.test(type)) {
				const html = await response.text();
				return { url, title: pageTitle(html), text: htmlToText(html) };
			}
			if (/^text\/|json/.test(type)) return { url, text: await response.text() };
			return { url, text: "", error: `unsupported content type ${type.split(";")[0] || "unknown"}` };
		} catch (error) {
			return { url, text: "", error: (error as Error).message };
		}
	}
}

export function createDefaultWebBackends(): WebBackends {
	const parallel = createParallelBackend();
	const exa = createExaBackend();
	// Exa's fetch drops tables, so it reads pages last.
	return { search: [parallel, exa, new DuckDuckGoBackend()], fetch: [parallel, new DirectFetchBackend(), exa] };
}

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;

/** Tries each backend in order. When every failure was throttling, waits once and tries the chain again. */
async function firstSuccess<T>(
	backends: WebBackend[],
	run: (backend: WebBackend) => Promise<T[] | undefined>,
	signal?: AbortSignal,
): Promise<{ backend: string; items: T[] }> {
	const failures: string[] = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		for (const backend of backends) {
			try {
				const items = await run(backend);
				if (items === undefined) continue;
				if (items.length > 0) return { backend: backend.name, items };
				failures.push(`${backend.name}: empty result`);
			} catch (error) {
				failures.push(`${backend.name}: ${(error as Error).message}`);
			}
		}
		if (attempt > 0 || failures.length === 0 || !failures.every((failure) => RATE_LIMITED.test(failure))) break;
		await new Promise((resolve) => setTimeout(resolve, 2000));
		signal?.throwIfAborted();
	}
	throw new Error(`All web backends failed.\n${failures.join("\n")}`);
}

const STOP_WORDS = new Set(
	"the and for from with what which that this when where who how are was were has have does did into about than then them they their there find page pages official source sources latest current today newest information value using used use documentation docs website site article according của và là các cho trong này được có không những một với theo từ như khi đã đang sẽ thì nào gì bao nhiêu hiện nay ưu tiên nguồn chính thức".split(
		" ",
	),
);

function terms(text: string): string[] {
	return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
		(term) => term.length >= 3 && !STOP_WORDS.has(term),
	);
}

/**
 * Cuts a long page to `budget` characters, keeping its opening and the windows of lines that best match the
 * objective. Rare terms weigh more, so a page full of "default" still surfaces the line about the one setting asked.
 */
export function fitToObjective(text: string, budget: number, objective: string | undefined): string {
	if (text.length <= budget) return text;
	// Blank lines would let a window cover half as much content.
	const lines = text.split("\n").filter((line) => line.trim());
	const wanted = terms(objective ?? "");
	const lineTerms = lines.map((line) => new Set(terms(line)));
	const weight = new Map(
		wanted.map((term) => [term, 1 / (1 + Math.log(1 + lineTerms.filter((set) => set.has(term)).length))]),
	);
	const WINDOW = 10;
	const scored = lines.map((_, start) => {
		const hits = new Set<string>();
		for (let i = start; i < Math.min(lines.length, start + WINDOW); i++) {
			for (const term of wanted) if (lineTerms[i]?.has(term)) hits.add(term);
		}
		// A short line naming an objective term is usually the heading of the section that answers it.
		const heading =
			(lines[start]?.trim().length ?? 0) <= 40 && [...(lineTerms[start] ?? [])].some((term) => weight.has(term));
		return { start, score: [...hits].reduce((sum, term) => sum + (weight.get(term) ?? 0), 0) + (heading ? 1 : 0) };
	});
	const keep = new Set<number>();
	let used = 0;
	const take = (index: number) => {
		if (keep.has(index) || index >= lines.length) return true;
		const cost = (lines[index]?.length ?? 0) + 1;
		if (used + cost > budget - 200) return false;
		keep.add(index);
		used += cost;
		return true;
	};
	for (let i = 0; i < lines.length && used < Math.min(1500, budget / 4); i++) take(i);
	for (const { start } of scored.filter((window) => window.score > 0).sort((a, b) => b.score - a.score)) {
		let fits = true;
		for (let i = Math.max(0, start - 1); i < start + WINDOW && fits; i++) fits = take(i);
		if (!fits) break;
	}
	const out: string[] = [];
	let previous = -1;
	for (const index of [...keep].sort((a, b) => a - b)) {
		if (index !== previous + 1) out.push("[…]");
		out.push(lines[index] ?? "");
		previous = index;
	}
	if (previous < lines.length - 1) out.push("[…]");
	return `${out.join("\n")}\n(page has ${text.length} chars; showing its start and the parts that match the objective)`;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function header(index: number, url: string, title: string | undefined, published: string | undefined): string {
	return `[${index}] ${domainOf(url)} · ${published?.slice(0, 10) || "date unknown"} · ${title || "(no title)"}\n${url}`;
}

export function formatSearchResults(results: WebResult[]): string {
	const seen = new Set<string>();
	const unique = results.filter((result) => {
		const key = normalizeUrl(result.url);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const perResult = Math.max(600, Math.floor(MAX_RESULT_CHARS / Math.max(1, unique.length)));
	return unique
		.map((result, index) => {
			const body = result.excerpts.join("\n…\n").trim();
			const cut = body.length > perResult ? `${body.slice(0, perResult)}…` : body;
			return `${header(index + 1, result.url, result.title, result.published)}\n${cut}`;
		})
		.join("\n\n");
}

function usable(page: FetchedPage): boolean {
	// A JavaScript-only page comes back as a few hundred characters of chrome.
	return !page.error && page.text.trim().length >= 200;
}

export function createWebTools(
	searchBackends: WebBackend[],
	fetchBackends: WebBackend[] = searchBackends,
): ToolDefinition[] {
	const webSearch = defineTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for current information. Returns numbered results with domain, publish date (or 'date unknown'), title, URL and excerpts.",
		promptSnippet: "web_search: search the web for fresh facts",
		promptGuidelines: [
			"Give web_search an objective that names the fact you need, how recent it must be, and which sources count (official or primary sources, in English or Vietnamese). Add 1-3 short keyword queries.",
		],
		parameters: Type.Object({
			objective: Type.String({
				description: "What to find, how fresh it must be, and which sources count, in one or two sentences",
			}),
			queries: Type.Array(Type.String({ description: "Short keyword query, 3-6 words" }), {
				minItems: 1,
				maxItems: 3,
			}),
		}),
		async execute(_id, params, signal) {
			const request = { objective: params.objective, queries: params.queries };
			const { backend, items } = await firstSuccess(
				searchBackends,
				async (b) => b.search?.(request, signal),
				signal,
			);
			return { content: [{ type: "text", text: formatSearchResults(items) }], details: { backend } };
		},
	});
	const webFetch = defineTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Read web pages as text. Long pages are cut to the parts that match the objective, so say exactly what you are looking for.",
		promptSnippet: "web_fetch: read web pages by URL",
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
			objective: Type.Optional(Type.String({ description: "The fact or section you need from these pages" })),
		}),
		async execute(_id, params, signal) {
			const maxCharsPerPage = Math.floor(MAX_RESULT_CHARS / params.urls.length);
			const pages = new Map<string, FetchedPage & { backend?: string }>();
			let pending = params.urls;
			const failures: string[] = [];
			// Each URL falls through to the next backend on its own, so one blocked page does not cost the others.
			for (const backend of fetchBackends) {
				if (!backend.fetch || pending.length === 0) continue;
				try {
					const fetched = await backend.fetch(
						{ urls: pending, objective: params.objective, maxCharsPerPage },
						signal,
					);
					for (const url of pending) {
						const page =
							fetched.find((candidate) => normalizeUrl(candidate.url) === normalizeUrl(url)) ??
							(pending.length === 1 ? fetched[0] : undefined);
						if (page && usable(page)) pages.set(url, { ...page, backend: backend.name });
						else if (page && !pages.has(url))
							failures.push(`${backend.name} ${url}: ${page.error ?? "too little text"}`);
					}
				} catch (error) {
					failures.push(`${backend.name}: ${(error as Error).message}`);
				}
				pending = pending.filter((url) => !pages.has(url));
			}
			if (pages.size === 0) throw new Error(`All web backends failed.\n${failures.join("\n")}`);
			const text = params.urls
				.map((url, index) => {
					const page = pages.get(url);
					if (!page)
						return `${header(index + 1, url, undefined, undefined)}\n(failed: no backend could read this page)`;
					return `${header(index + 1, url, page.title, page.published)}\n${fitToObjective(page.text, maxCharsPerPage, params.objective)}`;
				})
				.join("\n\n");
			const backends = [...new Set([...pages.values()].map((page) => page.backend))];
			return { content: [{ type: "text", text }], details: { backend: backends.join(","), failures } };
		},
	});
	return [webSearch, webFetch];
}
