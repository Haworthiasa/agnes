import { homedir } from "node:os";
import { join } from "node:path";

export interface BotConfig {
	telegramToken: string;
	allowedUserIds: ReadonlySet<number>;
	dataDir: string;
	/** "provider/model-id". Undefined picks the first model with configured auth. */
	model: string | undefined;
	allowShell: boolean;
	timeZone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
	const telegramToken = env.TELEGRAM_BOT_TOKEN;
	if (!telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather).");
	const allowedUserIds = new Set(
		(env.BOT_ALLOWED_USERS ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0)
			.map(Number),
	);
	if (allowedUserIds.size === 0 || [...allowedUserIds].some((id) => !Number.isSafeInteger(id))) {
		throw new Error("BOT_ALLOWED_USERS must list numeric Telegram user ids, separated by commas.");
	}
	return {
		telegramToken,
		allowedUserIds,
		dataDir: env.BOT_DATA_DIR ?? join(homedir(), ".agnes-bot"),
		model: env.BOT_MODEL || undefined,
		allowShell: env.BOT_ALLOW_SHELL === "1",
		timeZone: env.BOT_TZ ?? "Asia/Ho_Chi_Minh",
	};
}
