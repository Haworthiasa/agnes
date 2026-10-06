import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBotAgentFactory } from "../src/agent.ts";
import {
	createWebTools,
	FirecrawlBackend,
	fitToObjective,
	htmlToText,
	MAX_FETCHES_PER_TURN,
	McpWebBackend,
	pageImages,
	parseDuckDuckGoLite,
	parseExaSearch,
	parseParallelSearch,
	type WebBackend,
} from "../src/tools/web.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

const exaRateLimited = new McpWebBackend({
	name: "exa",
	url: "https://example.invalid/mcp",
	search: { tool: "web_search_exa", args: ({ objective }) => ({ query: objective }), parse: () => [] },
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
		search: async ({ queries }) => [
			{
				url: "https://example.com/a",
				title: "Example",
				published: "2026-09-21T00:00:00Z",
				excerpts: [`${text} for ${queries[0]}`],
			},
		],
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
			fauxAssistantMessage([fauxToolCall("web_search", { objective: "what dots are", queries: ["dots"] })], {
				stopReason: "toolUse",
			}),
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
			timeZone: "UTC",
			tools: () => createWebTools(backends),
		});
		const agent = await createAgent(1, { fresh: true });
		await agent.prompt("search dots");
		agent.dispose();
		return seen;
	}

	it("skips a rate-limited free tier and uses the next backend", async () => {
		expect(await runSearch([exaRateLimited, staticBackend("ddg", "results")])).toBe(
			"[1] example.com · 2026-09-21 · Example\nhttps://example.com/a\nresults for dots",
		);
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
		expect(parseDuckDuckGoLite(html)[0]).toEqual({
			url: "https://openai.com/index/introducing-dots/",
			title: "Introducing dots - OpenAI",
			excerpts: [
				"Dots by OpenAI are proactive assistants that can keep working across complex projects and everyday tasks. Learn how dots help you stay in control while work moves forward.",
			],
		});
	});
});

describe("parseParallelSearch", () => {
	it("keeps url, title, date and excerpts, and leaves an unknown date undefined", () => {
		const text = JSON.stringify({
			search_id: "s1",
			results: [
				{
					url: "https://nodejs.org/en/blog/release/v26.10.0",
					title: "Node v26.10.0 (Current)",
					publish_date: "2026-09-21",
					excerpts: ["Node.js 26.10.0"],
				},
				{
					url: "https://nodejs.org/en/about/previous-releases",
					title: "Node.js Releases",
					publish_date: null,
					excerpts: [],
				},
			],
		});
		expect(parseParallelSearch(text)).toEqual([
			{
				url: "https://nodejs.org/en/blog/release/v26.10.0",
				title: "Node v26.10.0 (Current)",
				published: "2026-09-21",
				excerpts: ["Node.js 26.10.0"],
			},
			{
				url: "https://nodejs.org/en/about/previous-releases",
				title: "Node.js Releases",
				published: undefined,
				excerpts: [],
			},
		]);
	});
});

describe("web_search", () => {
	it("tries the chain again once when every backend was rate limited", async () => {
		let calls = 0;
		const flaky: WebBackend = {
			name: "parallel",
			search: async () => {
				calls++;
				if (calls === 1) throw new Error("MCP HTTP request failed with status 429");
				return [{ url: "https://nodejs.org/x", title: "X", excerpts: ["v26"] }];
			},
		};
		const [search] = createWebTools([flaky]);
		const result = await search?.execute(
			"id",
			{ objective: "o", queries: ["q"] } as never,
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toBe(2);
		expect(result?.content[0]).toEqual({
			type: "text",
			text: "[1] nodejs.org · date unknown · X\nhttps://nodejs.org/x\nv26",
		});
	});
});

describe("web_fetch", () => {
	it("falls through per URL, so one unreadable page does not cost the others", async () => {
		const first: WebBackend = {
			name: "parallel",
			fetch: async ({ urls }) =>
				urls.map((url) =>
					url.endsWith("/a") ? { url, title: "A", text: "a".repeat(300) } : { url, text: "", error: "HTTP 403" },
				),
		};
		const second: WebBackend = {
			name: "direct",
			fetch: async ({ urls }) => urls.map((url) => ({ url, title: "B", text: "b".repeat(300) })),
		};
		const [, fetchTool] = createWebTools([], [first, second]);
		const result = await fetchTool?.execute(
			"id",
			{ urls: ["https://x.org/a", "https://x.org/b"] } as never,
			undefined,
			undefined,
			undefined as never,
		);
		expect(result?.content[0]).toEqual({
			type: "text",
			text: `[1] x.org · date unknown · A\nhttps://x.org/a\n${"a".repeat(300)}\n\n[2] x.org · date unknown · B\nhttps://x.org/b\n${"b".repeat(300)}`,
		});
		expect(result?.details).toEqual({ backend: "parallel,direct", failures: ["parallel https://x.org/b: HTTP 403"] });
	});

	it("lists the page's images, reading its HTML when the text backend returned none", async () => {
		const reader: WebBackend = {
			name: "parallel",
			fetch: async ({ urls }) =>
				urls.map((url) =>
					url.endsWith("/a")
						? { url, title: "A", text: "a".repeat(300) }
						: { url, title: "B", text: "b".repeat(300), images: [{ url: "https://cdn.x.org/b.jpg" }] },
				),
		};
		const [, fetchTool] = createWebTools([], [reader], async () => [
			{ url: "https://cdn.x.org/a.jpg", alt: "Cầu Rồng" },
		]);
		const result = await fetchTool?.execute(
			"id",
			{ urls: ["https://x.org/a", "https://x.org/b"] } as never,
			undefined,
			undefined,
			undefined as never,
		);
		expect(result?.content[0]).toEqual({
			type: "text",
			text: `[1] x.org · date unknown · A\nhttps://x.org/a\nImage: https://cdn.x.org/a.jpg (Cầu Rồng)\n${"a".repeat(300)}\n\n[2] x.org · date unknown · B\nhttps://x.org/b\nImage: https://cdn.x.org/b.jpg\n${"b".repeat(300)}`,
		});
	});
});

describe("pageImages", () => {
	it("keeps the preview image and large content images with alt text, and drops decoration", () => {
		const html = `<html><head>
			<meta property="og:image" content="https://cdn.news.vn/cover.jpg?w=1200&amp;h=630">
			<meta property="og:image:alt" content="Cầu Rồng phun lửa">
			<meta name="twitter:image" content="https://cdn.news.vn/cover.jpg?w=1200&h=630">
			</head><body><header><img src="/logo.png" alt="News"></header><article>
			<img src="/photos/1.jpg" alt="Khán giả xem cầu" width="800" height="450">
			<img src="/photos/thumb.jpg" alt="nhỏ" width="80" height="60">
			<img src="/photos/2.jpg">
			<img data-src="https://cdn.news.vn/photos/3.webp" alt='Đêm "pháo hoa"'>
			<img src="/icons/share.svg" alt="share">
			</article></body></html>`;
		expect(pageImages(html, "https://news.vn/post/1")).toEqual([
			{ url: "https://cdn.news.vn/cover.jpg?w=1200&h=630", alt: "Cầu Rồng phun lửa" },
			{ url: "https://news.vn/photos/1.jpg", alt: "Khán giả xem cầu" },
			{ url: "https://cdn.news.vn/photos/3.webp", alt: 'Đêm "pháo hoa"' },
		]);
	});
});

describe("fitToObjective", () => {
	it("keeps the opening and the deep section that matches the objective", () => {
		const filler = Array.from({ length: 2000 }, (_, i) => `Option ${i} has a default value described elsewhere.`);
		filler[1500] = "server.keepAliveTimeout";
		filler[1501] = "Default: 5000 (5 seconds).";
		const text = ["# HTTP", ...filler].join("\n");
		const fitted = fitToObjective(text, 4000, "Default value of server.keepAliveTimeout");
		expect(fitted.startsWith("# HTTP\nOption 0")).toBe(true);
		expect(fitted).toContain("server.keepAliveTimeout\nDefault: 5000 (5 seconds).");
		expect(fitted.length).toBeLessThan(4200);
	});

	it("returns a short page unchanged", () => {
		expect(fitToObjective("short page", 4000, "anything")).toBe("short page");
	});
});

describe("htmlToText", () => {
	it("reads the main content, keeps table rows and drops navigation", () => {
		const html = `<html><head><title>T</title></head><body><nav><a>Home</a><a>Docs</a></nav><main>
			<h2>Releases</h2><table><tr><th>Version</th><th>Codename</th></tr><tr><td>v22</td><td>Jod</td></tr></table>
			<p>Node&#46;js &amp; npm &#x2014; fast</p></main><footer>Copyright</footer></body></html>`;
		expect(htmlToText(html)).toBe("Releases\nVersion | Codename\nv22 | Jod\n\nNode.js & npm — fast");
	});

	it("keeps a table row on one line when the source breaks lines between cells", () => {
		const html =
			"<table><tr>\n<td>text</td>\n<td>String</td>\n<td>Text of the message, 1-4096 characters</td>\n</tr></table>";
		expect(htmlToText(html)).toBe("text | String | Text of the message, 1-4096 characters");
	});
});

describe("parseExaSearch", () => {
	it("reads Exa's text blocks and treats N/A as an unknown date", () => {
		const text = [
			"Title: HTTP | Node.js v26.10.0 Documentation",
			"URL: https://nodejs.org/api/http.html",
			"Published Date: N/A",
			"Author: N/A",
			"Highlights:",
			"Default:`5000` (5 seconds).",
			"",
			"Title: Node.js 26.10.0",
			"URL: https://nodejs.org/en/blog/release/v26.10.0",
			"Published Date: 2026-09-21T00:00:00.000Z",
			"Image: https://nodejs.org/static/og.png",
			"Text: Notable changes",
		].join("\n");
		expect(parseExaSearch(text)).toEqual([
			{
				url: "https://nodejs.org/api/http.html",
				title: "HTTP | Node.js v26.10.0 Documentation",
				published: undefined,
				excerpts: ["Default:`5000` (5 seconds)."],
			},
			{
				url: "https://nodejs.org/en/blog/release/v26.10.0",
				title: "Node.js 26.10.0",
				published: "2026-09-21T00:00:00.000Z",
				excerpts: ["Notable changes"],
				images: [{ url: "https://nodejs.org/static/og.png" }],
			},
		]);
	});
});

describe("FirecrawlBackend", () => {
	function fakeFirecrawl(calls: Array<{ path: string; body: unknown }>): typeof fetch {
		return async (input, init) => {
			const path = new URL(String(input)).pathname;
			calls.push({ path, body: JSON.parse(String(init?.body)) });
			const data =
				path === "/v2/search"
					? {
							web: [
								{
									url: "https://nodejs.org/en/about/previous-releases",
									title: "Node.js Releases",
									description: "| v26 | | Current |",
								},
							],
						}
					: {
							markdown: "# Node.js Releases\n| v24 | Krypton | Active LTS |",
							metadata: { title: "Node.js — Node.js Releases" },
						};
			return new Response(JSON.stringify({ success: true, data }), { status: 200 });
		};
	}

	it("searches with the first query and scrapes pages as markdown, without an API key", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const backend = new FirecrawlBackend(fakeFirecrawl(calls));
		expect(await backend.search({ objective: "latest node", queries: ["Node.js latest release"] })).toEqual([
			{
				url: "https://nodejs.org/en/about/previous-releases",
				title: "Node.js Releases",
				published: undefined,
				excerpts: ["| v26 | | Current |"],
			},
		]);
		expect(
			await backend.fetch({ urls: ["https://nodejs.org/en/about/previous-releases"], maxCharsPerPage: 20_000 }),
		).toEqual([
			{
				url: "https://nodejs.org/en/about/previous-releases",
				title: "Node.js — Node.js Releases",
				published: undefined,
				text: "# Node.js Releases\n| v24 | Krypton | Active LTS |",
			},
		]);
		expect(calls).toEqual([
			{ path: "/v2/search", body: { query: "Node.js latest release", limit: 6 } },
			{ path: "/v2/scrape", body: { url: "https://nodejs.org/en/about/previous-releases", formats: ["markdown"] } },
		]);
	});

	it("reports a throttled call as HTTP 429 so the chain treats it as a rate limit", async () => {
		const throttled: typeof fetch = async () =>
			new Response(JSON.stringify({ success: false, error: "Rate limit exceeded" }), { status: 429 });
		await expect(new FirecrawlBackend(throttled).search({ objective: "o", queries: ["q"] })).rejects.toThrow(
			"HTTP 429: Rate limit exceeded",
		);
	});
});

describe("web_fetch limit", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	it(`allows ${MAX_FETCHES_PER_TURN} fetches per user message, counting parallel calls in order`, async () => {
		runtime = await createFauxRuntime();
		const reader: WebBackend = {
			name: "static",
			fetch: async ({ urls }) => urls.map((url) => ({ url, text: "x".repeat(300) })),
		};
		const fetchCall = (n: number) => fauxToolCall("web_fetch", { urls: [`https://example.com/${n}`] });
		const outcomes: boolean[][] = [];
		const record = (context: TranscriptContext) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			outcomes.push(results.map((result) => result.role === "toolResult" && result.isError));
		};
		runtime.faux.setResponses([
			fauxAssistantMessage([fetchCall(1), fetchCall(2), fetchCall(3)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fetchCall(4), fetchCall(5), fetchCall(6)], { stopReason: "toolUse" }),
			(context) => {
				record(context);
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage([fetchCall(7)], { stopReason: "toolUse" }),
			(context) => {
				record(context);
				return fauxAssistantMessage("done again");
			},
		]);
		const createAgent = createBotAgentFactory({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			allowShell: false,
			systemPrompt: () => "test",
			timeZone: "UTC",
			tools: () => createWebTools([], [reader]),
		});
		const agent = await createAgent(1, { fresh: true });
		await agent.prompt("read six pages");
		await agent.prompt("read one more");
		agent.dispose();
		expect(outcomes).toEqual([
			[false, false, false, false, true, true],
			[false, false, false, false, true, true, false],
		]);
	});
});
