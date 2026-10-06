import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot.ts";
import { MEMORY_LIMITS, MemoryStore } from "../src/tools/memory.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "./helpers.ts";

const OWNER = 7;

describe("long-term memory", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	function startBot(transport = new FakeTransport()) {
		return createBot({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			transport,
			allowedUserIds: new Set([OWNER]),
			allowShell: false,
			timeZone: "Asia/Ho_Chi_Minh",
			webBackends: { search: [], fetch: [] },
		}).gateway;
	}

	it("saves a fact in one turn and shows it in the system prompt of the next turn and of a new chat", async () => {
		runtime = await createFauxRuntime();
		const prompts: string[] = [];
		runtime.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("memory", { action: "add", target: "user", content: "Tên là An, thích cà phê đen" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Đã nhớ."),
			(context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("An");
			},
			(context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("An");
			},
		]);
		const transport = new FakeTransport();
		const bot = startBot(transport);

		await bot.handle({ chatId: OWNER, userId: OWNER, text: "Tôi là An, tôi thích cà phê đen" });
		await bot.handle({ chatId: OWNER, userId: OWNER, text: "Tôi tên gì?" });
		await bot.handle({ chatId: OWNER, userId: OWNER, text: "/new" });
		await bot.handle({ chatId: OWNER, userId: OWNER, text: "Tôi tên gì?" });
		bot.dispose();

		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) expect(prompt).toContain("- Tên là An, thích cà phê đen");
		expect(readFileSync(join(runtime.dataDir, "chats", String(OWNER), "memory", "USER.md"), "utf8")).toBe(
			"Tên là An, thích cà phê đen",
		);
		expect(transport.sent.map((entry) => entry.text)).toEqual(["Đã nhớ.", "An", "Đã bắt đầu hội thoại mới.", "An"]);
	});
});

describe("MemoryStore", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	it("replaces and removes by unique substring and rejects ambiguous or oversized edits", async () => {
		runtime = await createFauxRuntime();
		const store = new MemoryStore(join(runtime.dataDir, "m"));
		store.add("memory", "project: tax filing due Oct 31");
		store.add("memory", "project: renew passport");
		store.replace("memory", "tax filing", "project: tax filed");

		expect(() => store.remove("memory", "project")).toThrow("matched 2");
		store.remove("memory", "passport");
		expect(store.entries("memory")).toEqual(["project: tax filed"]);
		expect(() => store.add("memory", "x".repeat(MEMORY_LIMITS.memory))).toThrow("Merge or remove entries first.");
		expect(store.entries("memory")).toEqual(["project: tax filed"]);
	});
});
