#!/usr/bin/env node
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBotAgentFactory } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { TelegramTransport } from "./telegram.ts";

const config = loadConfig();
// Shares credentials with the pi CLI: run `pi` and `/login` once on this machine.
const modelRuntime = await ModelRuntime.create();

async function resolveModel(): Promise<Model<Api>> {
	if (config.model) {
		const [provider, ...rest] = config.model.split("/");
		const model = modelRuntime.getModel(provider ?? "", rest.join("/"));
		if (!model) throw new Error(`BOT_MODEL ${config.model} is not a known model.`);
		return model;
	}
	const [first] = await modelRuntime.getAvailable();
	if (!first) throw new Error("No model has credentials. Run `pi` and `/login`, or set BOT_MODEL.");
	return first;
}

const model = await resolveModel();
const transport = new TelegramTransport({
	token: config.telegramToken,
	offsetPath: join(config.dataDir, "telegram-offset"),
});
const gateway = new Gateway({
	transport,
	allowedUserIds: config.allowedUserIds,
	createAgent: createBotAgentFactory({
		dataDir: config.dataDir,
		modelRuntime,
		model,
		allowShell: config.allowShell,
		systemPrompt: () =>
			`You are Agnes, a personal assistant chatting on Telegram. Reply in the user's language. Keep replies short and use plain text, not Markdown tables. Current time zone: ${config.timeZone}.`,
	}),
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		controller.abort();
		gateway.dispose();
	});
}
console.log(
	`[bot] ${model.provider}/${model.id}, data in ${config.dataDir}, shell ${config.allowShell ? "on" : "off"}`,
);
await gateway.run(controller.signal);
