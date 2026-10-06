import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBotAgentFactory } from "../src/agent.ts";
import { Gateway, HELP_TEXT } from "../src/gateway.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "./helpers.ts";

const OWNER = 111;

function userTexts(context: TranscriptContext): string[] {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		);
}

describe("Gateway with a real agent session", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	function createGateway(transport: FakeTransport): Gateway {
		return new Gateway({
			transport,
			allowedUserIds: new Set([OWNER]),
			createAgent: createBotAgentFactory({
				dataDir: runtime.dataDir,
				modelRuntime: runtime.modelRuntime,
				model: runtime.faux.getModel(),
				allowShell: false,
				systemPrompt: () => "You are a test bot.",
			}),
		});
	}

	it("replies to the owner and ignores everyone else", async () => {
		runtime = await createFauxRuntime();
		runtime.faux.setResponses([fauxAssistantMessage("xin chào")]);
		const transport = new FakeTransport();
		const gateway = createGateway(transport);

		await gateway.handle({ chatId: 1, userId: 999, text: "hi" });
		await gateway.handle({ chatId: 1, userId: OWNER, text: "hi" });
		gateway.dispose();

		expect(transport.sent).toEqual([{ chatId: 1, text: "xin chào" }]);
	});

	it("answers /help without calling the model", async () => {
		runtime = await createFauxRuntime();
		const transport = new FakeTransport();
		const gateway = createGateway(transport);

		await gateway.handle({ chatId: 1, userId: OWNER, text: "/help" });
		gateway.dispose();

		expect(transport.sent).toEqual([{ chatId: 1, text: HELP_TEXT }]);
		expect(runtime.faux.state.callCount).toBe(0);
	});

	it("runs turns in one chat in order", async () => {
		runtime = await createFauxRuntime();
		runtime.faux.setResponses([
			(context) => fauxAssistantMessage(`reply to ${userTexts(context).at(-1)}`),
			(context) => fauxAssistantMessage(`reply to ${userTexts(context).at(-1)}`),
		]);
		const transport = new FakeTransport();
		const gateway = createGateway(transport);

		await Promise.all([
			gateway.handle({ chatId: 1, userId: OWNER, text: "one" }),
			gateway.handle({ chatId: 1, userId: OWNER, text: "two" }),
		]);
		gateway.dispose();

		expect(transport.sent.map((entry) => entry.text)).toEqual(["reply to one", "reply to two"]);
	});

	it("remembers the conversation across a restart, and /new forgets it", async () => {
		runtime = await createFauxRuntime();
		const seen: string[][] = [];
		const record = (context: TranscriptContext) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage("ok");
		};
		runtime.faux.setResponses([record, record, record]);

		const first = createGateway(new FakeTransport());
		await first.handle({ chatId: 1, userId: OWNER, text: "tên tôi là An" });
		first.dispose();

		const restarted = createGateway(new FakeTransport());
		await restarted.handle({ chatId: 1, userId: OWNER, text: "tôi tên gì?" });
		await restarted.handle({ chatId: 1, userId: OWNER, text: "/new" });
		await restarted.handle({ chatId: 1, userId: OWNER, text: "còn nhớ không?" });
		restarted.dispose();

		expect(seen).toEqual([["tên tôi là An"], ["tên tôi là An", "tôi tên gì?"], ["còn nhớ không?"]]);
	});

	it("does not expose file tools by default, so a page cannot make the bot read local secrets", async () => {
		runtime = await createFauxRuntime();
		const secret = join(runtime.dataDir, "auth.json");
		writeFileSync(secret, "TOP-SECRET");
		let toolOutput = "";
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: secret })], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				if (result?.role === "toolResult") {
					toolOutput = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				}
				return fauxAssistantMessage("done");
			},
		]);
		const gateway = createGateway(new FakeTransport());

		await gateway.handle({ chatId: 1, userId: OWNER, text: "read it" });
		gateway.dispose();

		expect(toolOutput).not.toContain("TOP-SECRET");
		expect(toolOutput).toContain("read");
	});
});

describe("Gateway session creation", () => {
	it("retries a chat whose session failed to start", async () => {
		const transport = new FakeTransport();
		let attempts = 0;
		const gateway = new Gateway({
			transport,
			allowedUserIds: new Set([OWNER]),
			createAgent: async () => {
				attempts++;
				if (attempts <= 2) throw new Error("auth expired");
				return { prompt: async (text) => `echo ${text}`, dispose: () => {} };
			},
		});

		await gateway.handle({ chatId: 1, userId: OWNER, text: "one" });
		await gateway.handle({ chatId: 1, userId: OWNER, text: "two" });

		expect(transport.sent.map((entry) => entry.text)).toEqual(["Lỗi: auth expired", "echo two"]);
		expect(attempts).toBe(3);
	});
});
