import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface BotConfig {
	telegramToken: string;
	allowedUserIds: ReadonlySet<number>;
	dataDir: string;
	/** "provider/model-id". Undefined picks the first model with configured auth. */
	model: string | undefined;
	allowShell: boolean;
	timeZone: string;
}

/** Answers from the first-run setup, kept in `<dataDir>/config.json`. API keys live in pi's auth.json instead. */
export interface SavedConfig {
	telegramToken?: string;
	allowedUserIds?: number[];
	model?: string;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.BOT_DATA_DIR ?? join(homedir(), ".agnes-bot");
}

export function savedConfigPath(dataDir: string): string {
	return join(dataDir, "config.json");
}

/** Parses comma-separated Telegram user ids. Undefined when the list is empty or holds a non-integer. */
export function parseUserIds(value: string): number[] | undefined {
	const ids = value
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.map(Number);
	return ids.length > 0 && ids.every((id) => Number.isSafeInteger(id)) ? ids : undefined;
}

export function readSavedConfig(dataDir: string): SavedConfig {
	const path = savedConfigPath(dataDir);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SavedConfig) : {};
}

function findGitRoot(dir: string): string | undefined {
	for (let current = resolve(dir); ; current = dirname(current)) {
		if (existsSync(join(current, ".git"))) return current;
		if (dirname(current) === current) return undefined;
	}
}

/** Throws for a data dir inside a git work tree, where a saved token could be committed. */
export function assertOutsideGitRepository(dataDir: string): void {
	const gitRoot = findGitRoot(dataDir);
	if (gitRoot) {
		throw new Error(
			`BOT_DATA_DIR ${resolve(dataDir)} is inside the git repository ${gitRoot}. The bot token could be committed from there. Set BOT_DATA_DIR to a directory outside any repository.`,
		);
	}
}

/** Writes the config readable by the owner only. */
export function writeSavedConfig(dataDir: string, config: SavedConfig): void {
	assertOutsideGitRepository(dataDir);
	const path = savedConfigPath(dataDir);
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	// mode applies only when the file is created; tighten an existing file too.
	chmodSync(path, 0o600);
}

/** Environment variables win over the saved config, so one run can override a value without rewriting the file. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, saved: SavedConfig = {}): BotConfig {
	const telegramToken = env.TELEGRAM_BOT_TOKEN || saved.telegramToken;
	if (!telegramToken) {
		throw new Error("No bot token. Run `npm start` in a terminal to set it up, or set TELEGRAM_BOT_TOKEN.");
	}
	const allowedUserIds = env.BOT_ALLOWED_USERS ? parseUserIds(env.BOT_ALLOWED_USERS) : saved.allowedUserIds;
	if (!allowedUserIds || allowedUserIds.length === 0) {
		throw new Error(
			"BOT_ALLOWED_USERS must list numeric Telegram user ids, separated by commas. Run `npm start` in a terminal to set them up.",
		);
	}
	return {
		telegramToken,
		allowedUserIds: new Set(allowedUserIds),
		dataDir: resolveDataDir(env),
		model: env.BOT_MODEL || saved.model,
		allowShell: env.BOT_ALLOW_SHELL === "1",
		timeZone: env.BOT_TZ ?? "Asia/Ho_Chi_Minh",
	};
}
