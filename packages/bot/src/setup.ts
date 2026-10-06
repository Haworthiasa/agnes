import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	assertOutsideGitRepository,
	parseUserIds,
	readSavedConfig,
	type SavedConfig,
	savedConfigPath,
	writeSavedConfig,
} from "./config.ts";

/** Asks the person running the bot for a value. */
export interface Prompter {
	text(message: string): Promise<string>;
	/** Input is not echoed. */
	secret(message: string): Promise<string>;
	print(message: string): void;
}

export function createTerminalPrompter(): Prompter {
	return {
		async text(message) {
			const rl = createInterface({ input: stdin, output: stdout });
			try {
				return (await rl.question(message)).trim();
			} finally {
				rl.close();
			}
		},
		secret(message) {
			stdout.write(message);
			return new Promise((resolve) => {
				let value = "";
				const onData = (data: string) => {
					for (const char of data) {
						if (char === "\r" || char === "\n") {
							stdin.setRawMode(false);
							stdin.pause();
							stdin.off("data", onData);
							stdout.write("\n");
							resolve(value.trim());
							return;
						}
						if (char === "\u0003") {
							stdin.setRawMode(false);
							stdout.write("\n");
							process.exit(130);
						}
						if (char === "\u007f" || char === "\b") {
							if (value.length > 0) {
								value = value.slice(0, -1);
								stdout.write("\b \b");
							}
							continue;
						}
						value += char;
						stdout.write("*");
					}
				};
				stdin.setEncoding("utf8");
				stdin.setRawMode(true);
				stdin.resume();
				stdin.on("data", onData);
			});
		},
		print(message) {
			stdout.write(`${message}\n`);
		},
	};
}

export interface SetupOptions {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	modelRuntime: ModelRuntime;
	/** Undefined when nobody can answer, for example under systemd. */
	prompter: Prompter | undefined;
	/** Ask every question again (`npm start -- --setup`). */
	force: boolean;
	/** Offered when the person presses Enter at the model question. */
	defaultModel?: string;
}

function authInteraction(prompter: Prompter): AuthInteraction {
	return {
		async prompt(prompt) {
			if (prompt.type === "secret") return prompter.secret(`${prompt.message} `);
			if (prompt.type === "select") {
				for (const [index, option] of prompt.options.entries()) prompter.print(`  ${index + 1}. ${option.label}`);
				for (;;) {
					const choice =
						prompt.options[Number(await prompter.text(`${prompt.message} [1-${prompt.options.length}] `)) - 1];
					if (choice) return choice.id;
				}
			}
			return prompter.text(`${prompt.message} `);
		},
		notify(event) {
			if (event.type === "info" || event.type === "progress") prompter.print(event.message);
			if (event.type === "auth_url") prompter.print(`${event.instructions ?? "Open"}: ${event.url}`);
			if (event.type === "device_code") prompter.print(`Open ${event.verificationUri} and enter ${event.userCode}`);
		},
	};
}

/**
 * Asks for whatever the bot cannot start without, on the first run or with `force`, and saves the answers.
 * The bot token, user ids and model go to `<dataDir>/config.json`; an API key goes to pi's auth.json.
 */
export async function ensureSetup(options: SetupOptions): Promise<SavedConfig> {
	const { env, prompter, modelRuntime } = options;
	const saved = readSavedConfig(options.dataDir);
	const missingToken = options.force || !(env.TELEGRAM_BOT_TOKEN || saved.telegramToken);
	const missingUsers = options.force || !(env.BOT_ALLOWED_USERS || saved.allowedUserIds?.length);
	// Without anyone to ask, a missing model falls back to pi's default model.
	const missingModel = options.force || !(env.BOT_MODEL || saved.model);
	if (!prompter) {
		if (options.force) throw new Error("--setup needs an interactive terminal.");
		return saved;
	}
	const next: SavedConfig = { ...saved };
	if (missingToken || missingUsers || missingModel) {
		// Fail before the questions, not after the person has typed a token.
		assertOutsideGitRepository(options.dataDir);
		prompter.print(`Agnes setup. Answers are saved to ${savedConfigPath(options.dataDir)}.`);
	}
	if (missingToken) {
		const keep = saved.telegramToken ? " (Enter keeps the saved one)" : "";
		for (;;) {
			const token = await prompter.secret(`Telegram bot token from @BotFather${keep}: `);
			if (token || saved.telegramToken) {
				next.telegramToken = token || saved.telegramToken;
				break;
			}
		}
	}
	if (missingUsers) {
		const current = saved.allowedUserIds?.join(",");
		for (;;) {
			const answer = await prompter.text(
				`Allowed Telegram user ids, comma-separated (from @userinfobot)${current ? ` [${current}]` : ""}: `,
			);
			const ids = parseUserIds(answer || current || "");
			if (ids) {
				next.allowedUserIds = ids;
				break;
			}
			prompter.print("Enter numeric ids, for example 111111111,222222222.");
		}
	}
	if (missingModel) {
		const fallback = saved.model ?? options.defaultModel;
		for (;;) {
			const answer =
				(await prompter.text(`Model as provider/model-id${fallback ? ` [${fallback}]` : ""}: `)) || fallback;
			const [provider, ...rest] = (answer ?? "").split("/");
			if (provider && modelRuntime.getModel(provider, rest.join("/"))) {
				next.model = answer;
				break;
			}
			prompter.print(`Unknown model ${answer ?? "(empty)"}. Example: zai/glm-5.3-flash`);
		}
	}
	const modelName = env.BOT_MODEL || next.model;
	const provider = modelName?.split("/")[0];
	if (provider && modelRuntime.getProvider(provider) && !(await modelRuntime.checkAuth(provider))) {
		if (!modelRuntime.getProvider(provider)?.auth.apiKey?.login) {
			throw new Error(`${provider} needs a sign-in. Run \`pi\` and \`/login\`, then start the bot again.`);
		}
		prompter.print(`${provider} has no API key yet. It is saved to pi's auth.json, shared with the pi CLI.`);
		await modelRuntime.login(provider, "api_key", authInteraction(prompter));
	}
	if (missingToken || missingUsers || missingModel) writeSavedConfig(options.dataDir, next);
	return next;
}
