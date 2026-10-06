import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot.ts";
import { QueryError, queryWords, SessionIndex } from "../src/session-index.ts";
import { textOf } from "./eval/policy.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "./helpers.ts";

type Line = { role: "user" | "assistant" | "toolResult" | "system"; text: string };

/** One stored transcript in the shape pi writes: a session header, then one entry per message. */
function transcript(id: string, messages: Line[], startMs = Date.parse("2026-10-05T08:00:00Z")): string {
	const lines = [{ type: "session", version: 3, id, timestamp: new Date(startMs).toISOString(), cwd: "/w" }];
	for (const [index, message] of messages.entries()) {
		lines.push({
			type: "message",
			id: `e${index}`,
			timestamp: new Date(startMs + index * 1000).toISOString(),
			message: {
				role: message.role,
				content: message.role === "user" ? message.text : [{ type: "text", text: message.text }],
			},
		} as never);
	}
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("session index", () => {
	let root: string;
	let sessions: string;
	let index: SessionIndex;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agnes-index-"));
		sessions = join(root, "sessions");
		mkdirSync(sessions);
		index = new SessionIndex(sessions, join(root, "state.db"));
	});
	afterEach(() => {
		index.close();
		rmSync(root, { recursive: true, force: true });
	});
	const write = (file: string, id: string, messages: Line[]) =>
		writeFileSync(join(sessions, file), transcript(id, messages));

	it("finds a message without diacritics, and the letter d for đ", () => {
		write("a.jsonl", "s1", [
			{ role: "user", text: "Con mèo của tôi tên là Kiwi" },
			{ role: "assistant", text: "Kiwi là tên dễ thương." },
			{ role: "user", text: "Mình ở đường Nguyễn Huệ" },
		]);
		expect(index.search("con meo", { limit: 3, windowSize: 2 })[0]?.best.text).toContain("Con mèo");
		expect(index.search("duong nguyen hue", { limit: 3, windowSize: 2 })[0]?.best.text).toContain("đường");
		expect(index.search("ĐƯỜNG", { limit: 3, windowSize: 2 })).toHaveLength(1);
	});

	it("leaves out tool results and system messages", () => {
		write("a.jsonl", "s1", [
			{ role: "system", text: "hostilemarker in the prompt" },
			{ role: "user", text: "tìm giá vàng" },
			{ role: "toolResult", text: "hostilemarker inside a web page" },
			{ role: "assistant", text: "Giá vàng hôm nay là 80 triệu." },
		]);
		expect(index.search("hostilemarker", { limit: 3, windowSize: 2 })).toEqual([]);
		expect(index.search("gia vang", { limit: 3, windowSize: 2 })).toHaveLength(1);
	});

	it("skips the current session and returns other sessions, best first", () => {
		write("a.jsonl", "old", [{ role: "user", text: "Mình học tiếng Nhật buổi tối" }]);
		write("b.jsonl", "now", [{ role: "user", text: "Mình học tiếng Nhật và tiếng Hàn" }]);
		const hits = index.search("tieng nhat", { limit: 3, windowSize: 2, excludeSession: "now" });
		expect(hits.map((hit) => hit.session)).toEqual(["old"]);
	});

	it("takes lines appended later, and waits for a half-written line", () => {
		write("a.jsonl", "s1", [{ role: "user", text: "một" }]);
		expect(index.search("hai", { limit: 3, windowSize: 2 })).toEqual([]);
		const whole = transcript("s1", [
			{ role: "user", text: "một" },
			{ role: "user", text: "hai ba" },
		]).split("\n");
		const secondEntry = whole[2] as string;
		appendFileSync(join(sessions, "a.jsonl"), secondEntry.slice(0, 20));
		expect(index.search("hai", { limit: 3, windowSize: 2 })).toEqual([]);
		appendFileSync(join(sessions, "a.jsonl"), `${secondEntry.slice(20)}\n`);
		expect(index.search("hai", { limit: 3, windowSize: 2 })).toHaveLength(1);
	});

	it("falls back to any word when no message holds all of them", () => {
		write("a.jsonl", "s1", [{ role: "user", text: "Mình thích cà phê" }]);
		expect(index.search("cà phê và trà sữa", { limit: 3, windowSize: 2 })).toHaveLength(1);
	});

	it("scrolls around a message and returns the window in order", () => {
		write(
			"a.jsonl",
			"s1",
			Array.from({ length: 9 }, (_, i) => ({ role: "user" as const, text: `tin số ${i}` })),
		);
		const [hit] = index.search("so 4", { limit: 1, windowSize: 1 });
		const around = index.scroll("s1", (hit?.best.id as number) + 2, 2);
		expect(around.map((message) => message.text)).toEqual([
			"tin số 4",
			"tin số 5",
			"tin số 6",
			"tin số 7",
			"tin số 8",
		]);
	});

	it("keeps separate chats apart", () => {
		const other = join(root, "other");
		mkdirSync(join(other, "sessions"), { recursive: true });
		writeFileSync(
			join(other, "sessions", "x.jsonl"),
			transcript("sx", [{ role: "user", text: "bí mật của chat kia" }]),
		);
		write("a.jsonl", "s1", [{ role: "user", text: "chuyện của chat này" }]);
		const otherIndex = new SessionIndex(join(other, "sessions"), join(other, "state.db"));
		expect(index.search("bi mat", { limit: 3, windowSize: 2 })).toEqual([]);
		expect(otherIndex.search("bi mat", { limit: 3, windowSize: 2 })).toHaveLength(1);
		otherIndex.close();
	});

	it("rejects a query with no words", () => {
		expect(() => index.search("?! -- ::", { limit: 3, windowSize: 2 })).toThrow(QueryError);
	});

	it("property: any query either returns results or a QueryError, never another error", () => {
		write("a.jsonl", "s1", [{ role: "user", text: 'có "dấu nháy", gạch-nối và: hai chấm' }]);
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), (query) => {
				try {
					index.search(query, { limit: 3, windowSize: 2 });
				} catch (error) {
					expect(error).toBeInstanceOf(QueryError);
					expect(queryWords(query)).toEqual([]);
				}
			}),
			{ seed: 21, numRuns: 150 },
		);
	});

	it("property: folding is the same for the text and for the query", () => {
		write("a.jsonl", "s1", [{ role: "user", text: "Tiếng Việt có dấu: đường, mèo, Phở" }]);
		fc.assert(
			fc.property(fc.constantFrom("tiếng", "việt", "đường", "mèo", "phở", "dấu", "TIẾNG"), (word) => {
				expect(index.search(word, { limit: 3, windowSize: 2 })).toHaveLength(1);
			}),
			{ seed: 22 },
		);
	});
});

describe("session_search tool in the bot", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	it("finds a fact from an earlier session and not from the current one", async () => {
		runtime = await createFauxRuntime();
		const results: string[] = [];
		const answer = (text: string) => () => fauxAssistantMessage(text);
		runtime.faux.setResponses([
			answer("Hay quá!"),
			fauxAssistantMessage([fauxToolCall("session_search", { query: "tiếng Nhật" })], { stopReason: "toolUse" }),
			(context) => {
				results.push(textOf(context.messages.at(-1)?.content ?? ""));
				return fauxAssistantMessage("Bạn đang học tiếng Nhật.");
			},
		]);
		const transport = new FakeTransport();
		const { gateway } = createBot({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			transport,
			allowedUserIds: new Set([7]),
			allowShell: false,
			timeZone: "Asia/Ho_Chi_Minh",
			webBackends: { search: [], fetch: [] },
		});
		await gateway.handle({ chatId: 7, userId: 7, text: "Mình đang học tiếng Nhật" });
		await gateway.handle({ chatId: 7, userId: 7, text: "/new" });
		await gateway.handle({ chatId: 7, userId: 7, text: "Hôm trước mình học gì nhỉ, tiếng Nhật hả?" });
		gateway.dispose();
		expect(results[0]).toContain("Quoted history");
		expect(results[0]).toContain("Mình đang học tiếng Nhật");
		expect(results[0]).not.toContain("Hôm trước mình học gì");
	});
});
