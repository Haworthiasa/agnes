import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBotAgentFactory } from "../src/agent.ts";
import { verifyReply } from "../src/citations.ts";
import { createWebTools, type WebBackend } from "../src/tools/web.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

describe("verifyReply", () => {
	it("keeps seen URLs despite cosmetic differences and removes unseen ones", () => {
		const reply = [
			"Node.js 26.10.0 là bản mới nhất.",
			"",
			"Nguồn:",
			"- https://nodejs.org/en/blog/release/v26.10.0/",
			"- https://made-up.example.com/node",
			"Xem thêm [bảng phát hành](https://fake.example.org/releases).",
		].join("\n");
		const { parts, dropped } = verifyReply(reply, [
			"[1] nodejs.org\nhttp://www.nodejs.org/en/blog/release/v26.10.0?utm_source=x",
		]);
		expect(dropped).toEqual(["https://made-up.example.com/node", "https://fake.example.org/releases"]);
		expect(parts).toHaveLength(1);
		expect((parts[0] as { text: string }).text).toBe(
			[
				"Node.js 26.10.0 là bản mới nhất.",
				"",
				"Nguồn:",
				"- https://nodejs.org/en/blog/release/v26.10.0/",
				"Xem thêm bảng phát hành.",
			].join("\n"),
		);
	});

	it("cleans the separators a removed URL leaves behind", () => {
		expect(
			verifyReply("Xem (https://a.example/x, https://b.example/y) và (https://b.example/y).", [
				"https://a.example/x",
			]).parts,
		).toEqual([{ text: "Xem (https://a.example/x) và." }]);
	});

	it("leaves a reply without URLs unchanged", () => {
		expect(verifyReply("Không có nguồn.", [])).toEqual({ parts: [{ text: "Không có nguồn." }], dropped: [] });
	});

	it("keeps seen images where the model placed them and drops invented ones", () => {
		const seen = [
			"[1] vnexpress.net\nImage: https://i.vnecdn.net/a.jpg — Cầu Rồng\nImage: https://i.vnecdn.net/b.jpg\nImage: https://i.vnecdn.net/c.jpg",
		];
		const reply = [
			"Cầu Rồng ở Đà Nẵng.",
			"",
			"Ảnh 1 — ban ngày:",
			"![Cầu Rồng](https://i.vnecdn.net/a.jpg)",
			"![bịa](https://invented.example.com/x.jpg)",
			"Ảnh 2 — ban đêm:",
			"![thêm](https://i.vnecdn.net/b.jpg) ![quá nhiều](https://i.vnecdn.net/c.jpg)",
			"Nguồn: vnexpress.net",
		].join("\n");
		expect(verifyReply(reply, seen)).toEqual({
			parts: [
				{ text: "Cầu Rồng ở Đà Nẵng.\n\nẢnh 1 — ban ngày:" },
				{ image: { url: "https://i.vnecdn.net/a.jpg", alt: "Cầu Rồng" } },
				{ text: "Ảnh 2 — ban đêm:" },
				{ image: { url: "https://i.vnecdn.net/b.jpg", alt: "thêm" } },
				{ text: "Nguồn: vnexpress.net" },
			],
			dropped: ["https://invented.example.com/x.jpg"],
		});
	});
});

describe("agent replies", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	it("never show a URL the model did not get from a tool or the user", async () => {
		runtime = await createFauxRuntime();
		const backend: WebBackend = {
			name: "static",
			search: async () => [
				{ url: "https://nodejs.org/en/blog/release/v26.10.0", title: "Node v26.10.0", excerpts: ["26.10.0"] },
			],
		};
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { objective: "latest node", queries: ["node latest"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				"Bản mới nhất là 26.10.0 (https://nodejs.org/en/blog/release/v26.10.0, https://invented.example.com/node26).",
			),
		]);
		const createAgent = createBotAgentFactory({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			allowShell: false,
			systemPrompt: () => "test",
			tools: () => createWebTools([backend]),
		});
		const agent = await createAgent(1, { fresh: true });
		const reply = await agent.prompt("Node mới nhất?");
		agent.dispose();
		expect(reply).toEqual({
			parts: [{ text: "Bản mới nhất là 26.10.0 (https://nodejs.org/en/blog/release/v26.10.0)." }],
		});
	});
});
