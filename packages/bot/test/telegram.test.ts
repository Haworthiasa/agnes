import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitMessage, TelegramTransport } from "../src/telegram.ts";
import type { IncomingMessage } from "../src/types.ts";

interface Call {
	method: string;
	body: Record<string, unknown>;
}

function fakeTelegram(results: Record<string, unknown[]>) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const method = String(url).split("/").at(-1) ?? "";
		calls.push({ method, body: JSON.parse(String(init?.body)) });
		const result = results[method]?.shift() ?? [];
		return new Response(JSON.stringify({ ok: true, result }));
	}) as typeof fetch;
	return { calls, fetchFn };
}

describe("TelegramTransport", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("yields text messages and persists the next offset", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
		const offsetPath = join(dir, "offset");
		const { calls, fetchFn } = fakeTelegram({
			getUpdates: [
				[
					{ update_id: 7, message: { chat: { id: -5 }, from: { id: 42 }, text: "hello" } },
					{ update_id: 8, message: { chat: { id: -5 }, from: { id: 42 } } },
				],
			],
		});
		const transport = new TelegramTransport({ token: "T", offsetPath, fetch: fetchFn });
		const controller = new AbortController();

		const received: IncomingMessage[] = [];
		for await (const message of transport.receive(controller.signal)) {
			received.push(message);
			controller.abort();
		}

		expect(received).toEqual([{ chatId: -5, userId: 42, text: "hello" }]);
		expect(readFileSync(offsetPath, "utf8")).toBe("9");
		expect(calls[0]).toMatchObject({ method: "getUpdates", body: { timeout: 30 } });
		expect(calls[0]?.body.offset).toBeUndefined();

		const resumed = fakeTelegram({ getUpdates: [] });
		const again = new TelegramTransport({ token: "T", offsetPath, fetch: resumed.fetchFn, pollTimeoutSeconds: 0 });
		const stop = new AbortController();
		const iterator = again.receive(stop.signal)[Symbol.asyncIterator]();
		const pending = iterator.next();
		stop.abort();
		await pending;
		expect(resumed.calls[0]?.body.offset).toBe(9);
	});

	it("sends long replies as several plain-text messages", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
		const { calls, fetchFn } = fakeTelegram({});
		const transport = new TelegramTransport({ token: "T", offsetPath: join(dir, "offset"), fetch: fetchFn });

		await transport.send(3, "a".repeat(5000));

		expect(calls.map((call) => [call.method, (call.body.text as string).length, call.body.parse_mode])).toEqual([
			["sendMessage", 4096, undefined],
			["sendMessage", 904, undefined],
		]);
	});
});

describe("splitMessage", () => {
	it("prefers the last newline inside the limit", () => {
		expect(splitMessage("aaaa\nbbbbbb\ncc", 8)).toEqual(["aaaa", "bbbbbb", "cc"]);
	});
});
