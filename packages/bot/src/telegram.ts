import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatTransport, IncomingMessage } from "./types.ts";

/** Telegram rejects messages longer than this many UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

interface TelegramUpdate {
	update_id: number;
	message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

interface TelegramResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

export interface TelegramTransportOptions {
	token: string;
	/** File that stores the next getUpdates offset, so a restart does not replay handled updates. */
	offsetPath: string;
	fetch?: typeof fetch;
	apiBaseUrl?: string;
	pollTimeoutSeconds?: number;
	retryDelayMs?: number;
}

/** Splits text into chunks Telegram accepts, cutting at the last newline that fits. */
export function splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const newline = rest.lastIndexOf("\n", limit);
		const cut = newline > 0 ? newline : limit;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

/** Bot API transport over long polling. Needs no public URL. */
export class TelegramTransport implements ChatTransport {
	private readonly token: string;
	private readonly offsetPath: string;
	private readonly fetchFn: typeof fetch;
	private readonly apiBaseUrl: string;
	private readonly pollTimeoutSeconds: number;
	private readonly retryDelayMs: number;

	constructor(options: TelegramTransportOptions) {
		this.token = options.token;
		this.offsetPath = options.offsetPath;
		this.fetchFn = options.fetch ?? fetch;
		this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
		this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
		this.retryDelayMs = options.retryDelayMs ?? 3000;
	}

	async *receive(signal: AbortSignal): AsyncIterable<IncomingMessage> {
		let offset = this.readOffset();
		while (!signal.aborted) {
			let updates: TelegramUpdate[];
			try {
				updates = await this.call<TelegramUpdate[]>(
					"getUpdates",
					{ offset, timeout: this.pollTimeoutSeconds, allowed_updates: ["message"] },
					signal,
				);
			} catch (error) {
				if (signal.aborted) return;
				console.error(`[telegram] getUpdates failed: ${(error as Error).message}`);
				await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
				continue;
			}
			for (const update of updates) {
				offset = update.update_id + 1;
				this.writeOffset(offset);
				const message = update.message;
				if (message?.text && message.from) {
					yield { chatId: message.chat.id, userId: message.from.id, text: message.text };
				}
			}
		}
	}

	async send(chatId: number, text: string): Promise<void> {
		// Plain text on purpose: MarkdownV2 rejects unescaped model output with HTTP 400.
		for (const chunk of splitMessage(text)) {
			await this.call("sendMessage", { chat_id: chatId, text: chunk });
		}
	}

	async typing(chatId: number): Promise<void> {
		await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
	}

	private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await this.fetchFn(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const payload = (await response.json()) as TelegramResponse<T>;
		if (!payload.ok) throw new Error(`${method}: ${payload.description ?? response.status}`);
		return payload.result as T;
	}

	private readOffset(): number | undefined {
		if (!existsSync(this.offsetPath)) return undefined;
		const value = Number(readFileSync(this.offsetPath, "utf8"));
		return Number.isFinite(value) ? value : undefined;
	}

	private writeOffset(offset: number): void {
		mkdirSync(dirname(this.offsetPath), { recursive: true });
		writeFileSync(this.offsetPath, String(offset));
	}
}
