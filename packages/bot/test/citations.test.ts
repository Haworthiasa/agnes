import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBotAgentFactory } from "../src/agent.ts";
import { dropUnverifiedUrls } from "../src/citations.ts";
import { createWebTools, type WebBackend } from "../src/tools/web.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

describe("dropUnverifiedUrls", () => {
	it("keeps seen URLs despite cosmetic differences and removes unseen ones", () => {
		const reply = [
			"Node.js 26.10.0 là bản mới nhất.",
			"",
			"Nguồn:",
			"- https://nodejs.org/en/blog/release/v26.10.0/",
			"- https://made-up.example.com/node",
			"Xem thêm [bảng phát hành](https://fake.example.org/releases).",
		].join("\n");
		const { text, dropped } = dropUnverifiedUrls(reply, [
			"[1] nodejs.org\nhttp://www.nodejs.org/en/blog/release/v26.10.0?utm_source=x",
		]);
		expect(dropped).toEqual(["https://made-up.example.com/node", "https://fake.example.org/releases"]);
		expect(text).toBe(
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
			dropUnverifiedUrls("Xem (https://a.example/x, https://b.example/y) và (https://b.example/y).", [
				"https://a.example/x",
			]).text,
		).toBe("Xem (https://a.example/x) và.");
	});

	it("leaves a reply without URLs unchanged", () => {
		expect(dropUnverifiedUrls("Không có nguồn.", [])).toEqual({ text: "Không có nguồn.", dropped: [] });
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
		expect(reply).toBe("Bản mới nhất là 26.10.0 (https://nodejs.org/en/blog/release/v26.10.0).");
	});
});
