#!/usr/bin/env node
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createBot } from "./bot.ts";
import { loadConfig, resolveDataDir } from "./config.ts";
import { createTerminalPrompter, ensureSetup } from "./setup.ts";
import { TelegramTransport } from "./telegram.ts";
import { createDefaultWebBackends } from "./tools/web.ts";

const dataDir = resolveDataDir();
// Shares credentials with the pi CLI: run `pi` and `/login` once on this machine.
const modelRuntime = await ModelRuntime.create();
// Same default as the pi CLI, from ~/.pi/agent/settings.json.
const settings = SettingsManager.create(dataDir);
const piDefaultProvider = settings.getDefaultProvider();
const piDefaultModel = settings.getDefaultModel();
const saved = await ensureSetup({
	dataDir,
	env: process.env,
	modelRuntime,
	prompter: process.stdin.isTTY && process.stdout.isTTY ? createTerminalPrompter() : undefined,
	force: process.argv.includes("--setup"),
	defaultModel: piDefaultProvider && piDefaultModel ? `${piDefaultProvider}/${piDefaultModel}` : undefined,
});
const config = loadConfig(process.env, saved);

async function resolveModel(): Promise<Model<Api>> {
	if (config.model) {
		const [provider, ...rest] = config.model.split("/");
		const model = modelRuntime.getModel(provider ?? "", rest.join("/"));
		if (!model)
			throw new Error(`Model ${config.model} is not a known model. Run \`npm start -- --setup\` to pick another.`);
		return model;
	}
	const preferred =
		piDefaultProvider && piDefaultModel ? modelRuntime.getModel(piDefaultProvider, piDefaultModel) : undefined;
	if (preferred) return preferred;
	const [first] = await modelRuntime.getAvailable();
	if (!first) throw new Error("No model has credentials. Run `pi` and `/login`, or set BOT_MODEL.");
	return first;
}

const model = await resolveModel();
const auth = await modelRuntime.checkAuth(model.provider);
if (!auth) {
	throw new Error(
		`No credentials for ${model.provider}. Run \`npm start\` in a terminal to enter an API key, export one (for example ZAI_API_KEY for zai), or run \`pi\` and \`/login\`.`,
	);
}
const { gateway, scheduler } = createBot({
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
		scheduler.stop();
		gateway.dispose();
	});
}
console.log(
	`[bot] ${model.provider}/${model.id} (auth: ${auth.source}), data in ${config.dataDir}, shell ${config.allowShell ? "on" : "off"}`,
);
scheduler.start();
await gateway.run(controller.signal);
