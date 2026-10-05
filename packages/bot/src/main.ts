#!/usr/bin/env node
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { TelegramTransport } from "./telegram.ts";
import { createDefaultWebBackends } from "./tools/web.ts";

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
const gateway = createBot({
	dataDir: config.dataDir,
	modelRuntime,
	model,
	transport: new TelegramTransport({
		token: config.telegramToken,
		offsetPath: join(config.dataDir, "telegram-offset"),
	}),
	allowedUserIds: config.allowedUserIds,
	allowShell: config.allowShell,
	timeZone: config.timeZone,
	webBackends: createDefaultWebBackends(),
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
