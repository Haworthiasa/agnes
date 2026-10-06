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

function fakeTelegram(results: Record<string, unknown[]>, files: Record<string, string> = {}) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = String(url).replace("https://api.telegram.org", "");
		if (path.startsWith("/file/")) {
			calls.push({ method: "download", body: { path } });
			const content = files[path];
			return content === undefined ? new Response("missing", { status: 404 }) : new Response(content);
		}
		const method = path.split("/").at(-1) ?? "";
		const body =
			init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body));
		calls.push({ method, body });
		const result = results[method]?.shift() ?? [];
		return new Response(JSON.stringify({ ok: true, result }));
	}) as typeof fetch;
	return { calls, fetchFn };
}

async function receiveOne(transport: TelegramTransport): Promise<IncomingMessage[]> {
	const controller = new AbortController();
	const received: IncomingMessage[] = [];
	for await (const message of transport.receive(controller.signal)) {
		received.push(message);
		controller.abort();
	}
	return received;
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

		expect(await receiveOne(transport)).toEqual([{ chatId: -5, userId: 42, text: "hello" }]);
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

	it("offers the largest photo size with its caption and downloads it only on request", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
		const { calls, fetchFn } = fakeTelegram(
			{
				getUpdates: [
					[
						{
							update_id: 1,
							message: {
								chat: { id: 5 },
								from: { id: 42 },
								caption: "đây là gì?",
								photo: [
									{ file_id: "small", file_size: 900 },
									{ file_id: "large", file_size: 52_000 },
								],
							},
						},
					],
				],
				getFile: [{ file_path: "photos/file_1.jpg" }],
			},
			{ "/file/botT/photos/file_1.jpg": "JPEG" },
		);
		const transport = new TelegramTransport({ token: "T", offsetPath: join(dir, "offset"), fetch: fetchFn });

		const [message] = await receiveOne(transport);
		expect(message).toMatchObject({ chatId: 5, userId: 42, text: "đây là gì?" });
		expect(message?.file).toMatchObject({ name: "photo.jpg", mimeType: "image/jpeg", size: 52_000 });
		expect(calls.map((call) => call.method)).toEqual(["getUpdates"]);

		const data = await message?.file?.download();
		expect(new TextDecoder().decode(data)).toBe("JPEG");
		expect(calls.slice(1)).toEqual([
			{ method: "getFile", body: { file_id: "large" } },
			{ method: "download", body: { path: "/file/botT/photos/file_1.jpg" } },
		]);
	});

	it("offers a document with its name and type, and reports a failed download without the URL", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
		const { fetchFn } = fakeTelegram({
			getUpdates: [
				[
					{
						update_id: 1,
						message: {
							chat: { id: 5 },
							from: { id: 42 },
							document: { file_id: "d", file_name: "notes.md", mime_type: "text/markdown", file_size: 10 },
						},
					},
				],
			],
			getFile: [{ file_path: "documents/gone.md" }],
		});
		const transport = new TelegramTransport({ token: "SECRET", offsetPath: join(dir, "offset"), fetch: fetchFn });

		const [message] = await receiveOne(transport);
		expect(message).toMatchObject({ text: "", file: { name: "notes.md", mimeType: "text/markdown", size: 10 } });
		await expect(message?.file?.download()).rejects.toThrow(/^HTTP 404$/);
	});

	it("uploads a photo as multipart with a caption", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
		const { calls, fetchFn } = fakeTelegram({});
		const transport = new TelegramTransport({ token: "T", offsetPath: join(dir, "offset"), fetch: fetchFn });

		await transport.sendPhoto(3, { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }, "Cầu Rồng");

		const call = calls[0];
		expect(call?.method).toBe("sendPhoto");
		expect(call?.body.chat_id).toBe("3");
		expect(call?.body.caption).toBe("Cầu Rồng");
		const photo = call?.body.photo as File;
		expect([photo.name, photo.type, photo.size]).toEqual(["image.png", "image/png", 3]);
	});
});

describe("splitMessage", () => {
	it("prefers the last newline inside the limit", () => {
		expect(splitMessage("aaaa\nbbbbbb\ncc", 8)).toEqual(["aaaa", "bbbbbb", "cc"]);
	});
});
