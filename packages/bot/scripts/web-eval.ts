#!/usr/bin/env node
// Measures Agnes web search quality against web-eval.questions.json.
//
// Retrieval mode (default, no model): calls the web_search and web_fetch tools directly, once through the full
// backend chain and once per backend, and scores whether the expected fact reaches the tool output.
// E2E mode (--e2e): asks the real bot through the verify-agnes skill and scores the reply.
//
// Run from packages/bot:
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/web-eval.ts [--repeats 2] [--delay 1500] [--configs chain,firecrawl] [--only id,id] [--out file.json]
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/web-eval.ts --e2e [--only id,id] [--out file.json]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDefaultWebBackends, createWebTools } from "../src/tools/web.ts";

interface Question {
	id: string;
	kind: "fresh" | "deep" | "fetch" | "vi";
	question: string;
	objective: string;
	queries: string[];
	expected: string;
	stale?: string[];
	primaryDomains: string[];
	fetchUrl?: string;
}

interface ToolRun {
	ok: boolean;
	backend: string | null;
	error: string | null;
	chars: number;
	recall: boolean;
	staleOnly: boolean;
	primaryRank: number | null;
	urls: number;
	ms: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const questionFile = JSON.parse(readFileSync(join(here, "web-eval.questions.json"), "utf8")) as {
	version: number;
	questions: Question[];
};
const { values: flags } = parseArgs({
	options: {
		e2e: { type: "boolean", default: false },
		repeats: { type: "string", default: "1" },
		delay: { type: "string", default: "1500" },
		configs: { type: "string" },
		only: { type: "string" },
		out: { type: "string" },
	},
});
const questions = flags.only
	? questionFile.questions.filter((q) => flags.only?.split(",").includes(q.id))
	: questionFile.questions;

const URL_PATTERN = /https?:\/\/[^\s)"'<>\]}`*,]+/g;

/** Same page despite cosmetic differences: scheme, www, trailing slash, hash, tracking params. */
function normalizeUrl(raw: string): string {
	try {
		const url = new URL(raw.replace(/[.;:]+$/, ""));
		for (const key of [...url.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$/.test(key)) url.searchParams.delete(key);
		const query = url.searchParams.toString();
		return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${query ? `?${query}` : ""}`.toLowerCase();
	} catch {
		return raw.toLowerCase();
	}
}

function urlsIn(text: string): string[] {
	return [...new Set(text.match(URL_PATTERN) ?? [])];
}

function isPrimary(url: string, domains: string[]): boolean {
	const normalized = normalizeUrl(url);
	const host = normalized.split("/")[0] ?? "";
	return domains.some((domain) => (domain.includes("/") ? normalized.startsWith(domain) : host === domain || host.endsWith(`.${domain}`)));
}

function score(q: Question, text: string): Pick<ToolRun, "recall" | "staleOnly" | "primaryRank" | "urls"> {
	const recall = new RegExp(q.expected, "i").test(text);
	const staleOnly = !recall && (q.stale ?? []).some((pattern) => new RegExp(pattern, "i").test(text));
	const urls = urlsIn(text);
	const rank = urls.findIndex((url) => isPrimary(url, q.primaryDomains));
	return { recall, staleOnly, primaryRank: rank === -1 ? null : rank + 1, urls: urls.length };
}

/** Builds arguments for whichever tool schema is installed, so the same eval runs before and after a schema change. */
function searchArgs(tool: ToolDefinition, q: Question): Record<string, unknown> {
	const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
	if ("query" in properties) return { query: q.queries[0] };
	return { objective: q.objective, queries: q.queries };
}

function fetchArgs(tool: ToolDefinition, q: Question, url: string): Record<string, unknown> {
	const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
	return "objective" in properties ? { urls: [url], objective: q.objective } : { urls: [url] };
}

async function runTool(tool: ToolDefinition, args: Record<string, unknown>, q: Question): Promise<ToolRun> {
	const start = Date.now();
	try {
		const result = await tool.execute("eval", args as never, AbortSignal.timeout(90_000), undefined, undefined as never);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const backend = (result.details as { backend?: string } | undefined)?.backend ?? null;
		return { ok: true, backend, error: null, chars: text.length, ...score(q, text), ms: Date.now() - start };
	} catch (error) {
		const message = (error as Error).message.replace(/\s+/g, " ").slice(0, 300);
		return { ok: false, backend: null, error: message, chars: 0, recall: false, staleOnly: false, primaryRank: null, urls: 0, ms: Date.now() - start };
	}
}

function summarize(runs: ToolRun[]) {
	const scored = runs.filter((r) => r.ok);
	const ranks = scored.map((r) => r.primaryRank).filter((rank): rank is number => rank !== null);
	const rate = (count: number, of: number) => (of === 0 ? null : Math.round((count / of) * 100) / 100);
	return {
		runs: runs.length,
		errors: runs.length - scored.length,
		recall: rate(scored.filter((r) => r.recall).length, runs.length),
		recallWhenOk: rate(scored.filter((r) => r.recall).length, scored.length),
		staleOnly: rate(scored.filter((r) => r.staleOnly).length, runs.length),
		primaryFound: rate(ranks.length, runs.length),
		meanPrimaryRank: ranks.length ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 100) / 100 : null,
		meanChars: scored.length ? Math.round(scored.reduce((a, r) => a + r.chars, 0) / scored.length) : null,
	};
}

async function retrieval() {
	const { search: searchOrder, fetch: fetchOrder } = createDefaultWebBackends();
	const configs = [
		{ name: "chain", tools: createWebTools(searchOrder, fetchOrder), search: true, fetch: true },
		...[...new Set([...searchOrder, ...fetchOrder])].map((backend) => ({
			name: backend.name,
			tools: createWebTools(backend.search ? [backend] : [], backend.fetch ? [backend] : []),
			search: Boolean(backend.search),
			fetch: Boolean(backend.fetch),
		})),
	];
	const selected = flags.configs?.split(",");
	if (selected) configs.splice(0, configs.length, ...configs.filter((config) => selected.includes(config.name)));
	const repeats = Number(flags.repeats);
	const rows: Array<{ config: string; id: string; kind: string; op: "search" | "fetch"; repeat: number } & ToolRun> = [];
	for (let repeat = 1; repeat <= repeats; repeat++) {
		for (const config of configs) {
			const [search, fetchTool] = config.tools as [ToolDefinition, ToolDefinition];
			for (const q of questions) {
				if (config.search) {
					rows.push({ config: config.name, id: q.id, kind: q.kind, op: "search", repeat, ...(await runTool(search, searchArgs(search, q), q)) });
				}
				if (q.fetchUrl && config.fetch) {
					rows.push({ config: config.name, id: q.id, kind: q.kind, op: "fetch", repeat, ...(await runTool(fetchTool, fetchArgs(fetchTool, q, q.fetchUrl), q)) });
				}
				process.stderr.write(".");
				await new Promise((done) => setTimeout(done, Number(flags.delay)));
			}
		}
	}
	process.stderr.write("\n");
	const summary: Record<string, unknown> = {};
	for (const config of configs) {
		for (const op of ["search", "fetch"] as const) {
			if (!config[op]) continue;
			summary[`${config.name}/${op}`] = summarize(rows.filter((r) => r.config === config.name && r.op === op));
		}
	}
	return { mode: "retrieval", summary, rows };
}

function ctl(...args: string[]): Record<string, unknown> {
	const cli = resolve(here, "../../../.claude/skills/verify-agnes/control-agnes.mjs");
	if (!existsSync(cli)) throw new Error(`--e2e needs the verify-agnes skill at ${cli}`);
	const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

interface SessionEntry {
	message?: { role: string; content: unknown; toolName?: string };
}

/** Tool calls and the full text of tool results in the newest session of chat 111. */
function newestSession(dataDir: string) {
	const listing = ctl("inspect", "sessions") as { sessions?: Array<{ file: string }> };
	const file = listing.sessions?.at(-1)?.file;
	if (!file || !file.startsWith(dataDir)) throw new Error("no session file for chat 111");
	const calls: Array<{ name: string; arguments: unknown }> = [];
	let resultText = "";
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const message = (JSON.parse(line) as SessionEntry).message;
		if (!message || !Array.isArray(message.content)) continue;
		for (const part of message.content as Array<{ type: string; text?: string; name?: string; arguments?: unknown }>) {
			if (message.role === "assistant" && part.type === "toolCall") calls.push({ name: part.name ?? "", arguments: part.arguments });
			if (message.role === "toolResult" && part.type === "text") resultText += `\n${part.text ?? ""}`;
		}
	}
	return { calls, resultText };
}

async function e2e() {
	const doctor = ctl("doctor") as { ok?: boolean; run?: string };
	if (!doctor.ok) throw new Error("verify-agnes run is not healthy; start one with control-agnes.mjs up");
	const run = JSON.parse(readFileSync(`/tmp/agnes-verify/${doctor.run}/run.json`, "utf8")) as { dir: string; model: string };
	const dataDir = join(run.dir, "data");
	const logPath = join(run.dir, "evidence/bot.log");
	const dropped = () => (readFileSync(logPath, "utf8").match(/dropped unverified citation/g) ?? []).length;
	const rows = [];
	for (const q of questions) {
		ctl("send", "/new");
		const droppedBefore = dropped();
		const reply = ctl("send", q.question, "--timeout", "300") as { ok?: boolean; replies?: string[]; latencyMs?: number };
		const text = (reply.replies ?? []).join("\n");
		const session = newestSession(dataDir);
		const seen = new Set(urlsIn(session.resultText).map(normalizeUrl));
		const cited = urlsIn(text);
		const citedSeen = cited.filter((url) => seen.has(normalizeUrl(url)));
		const factHit = new RegExp(q.expected, "i").test(text);
		rows.push({
			id: q.id,
			kind: q.kind,
			ok: Boolean(reply.ok),
			factHit,
			staleHit: !factHit && (q.stale ?? []).some((pattern) => new RegExp(pattern, "i").test(text)),
			cited: cited.length,
			citedInResults: cited.length ? Math.round((citedSeen.length / cited.length) * 100) / 100 : null,
			citedPrimary: cited.filter((url) => isPrimary(url, q.primaryDomains)).length,
			droppedCitations: dropped() - droppedBefore,
			searches: session.calls.filter((c) => c.name === "web_search").length,
			fetches: session.calls.filter((c) => c.name === "web_fetch").length,
			latencyMs: reply.latencyMs ?? null,
			reply: text.slice(0, 600),
			calls: session.calls,
		});
		process.stderr.write(factHit ? "+" : "-");
	}
	process.stderr.write("\n");
	const n = rows.length;
	const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + pick(r), 0);
	const withCites = rows.filter((r) => r.citedInResults !== null);
	return {
		mode: "e2e",
		model: run.model,
		run: doctor.run,
		summary: {
			questions: n,
			factHit: Math.round((sum((r) => Number(r.factHit)) / n) * 100) / 100,
			staleRate: Math.round((sum((r) => Number(r.staleHit)) / n) * 100) / 100,
			citedInResults: withCites.length ? Math.round((withCites.reduce((a, r) => a + (r.citedInResults ?? 0), 0) / withCites.length) * 100) / 100 : null,
			citedPrimaryShare: sum((r) => r.cited) ? Math.round((sum((r) => r.citedPrimary) / sum((r) => r.cited)) * 100) / 100 : null,
			fetchedShare: Math.round((rows.filter((r) => r.fetches > 0).length / n) * 100) / 100,
			droppedCitations: sum((r) => r.droppedCitations),
			meanLatencyMs: Math.round(sum((r) => r.latencyMs ?? 0) / n),
		},
		rows,
	};
}

const report = {
	questionSetVersion: questionFile.version,
	at: new Date().toISOString(),
	...(flags.e2e ? await e2e() : await retrieval()),
};
if (flags.out) writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, rows: undefined }, null, 2)}\n`);
process.exit(0);
