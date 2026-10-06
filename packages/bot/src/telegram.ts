import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatTransport, IncomingFile, IncomingMessage, Photo } from "./types.ts";

/** Telegram rejects messages longer than this many UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

interface TelegramFile {
	file_id: string;
	file_size?: number;
}

interface TelegramMessage {
	chat: { id: number };
	from?: { id: number };
	text?: string;
	caption?: string;
	/** One entry per size, smallest first. */
	photo?: TelegramFile[];
	document?: TelegramFile & { file_name?: string; mime_type?: string };
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
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
				if (!message?.from) continue;
				const file = this.fileOf(message);
				const text = message.text ?? message.caption ?? "";
				if (text || file) yield { chatId: message.chat.id, userId: message.from.id, text, file };
			}
		}
	}

	async send(chatId: number, text: string): Promise<void> {
		// Plain text on purpose: MarkdownV2 rejects unescaped model output with HTTP 400.
		for (const chunk of splitMessage(text)) {
			await this.call("sendMessage", { chat_id: chatId, text: chunk });
		}
	}

	async sendPhoto(chatId: number, photo: Photo, caption?: string): Promise<void> {
		const form = new FormData();
		form.set("chat_id", String(chatId));
		form.set("photo", new Blob([photo.data], { type: photo.mimeType }), `image.${photo.mimeType.split("/")[1]}`);
		if (caption) form.set("caption", caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH));
		await this.call("sendPhoto", form);
	}

	async typing(chatId: number): Promise<void> {
		await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
	}

	/** The largest photo size, or the document. Nothing is downloaded until the gateway asks. */
	private fileOf(message: TelegramMessage): IncomingFile | undefined {
		const photo = message.photo?.at(-1);
		const document = message.document;
		if (photo) return this.file(photo, "photo.jpg", "image/jpeg");
		if (document) return this.file(document, document.file_name ?? "file", document.mime_type ?? "");
		return undefined;
	}

	private file(file: TelegramFile, name: string, mimeType: string): IncomingFile {
		return {
			name,
			mimeType,
			size: file.file_size,
			download: async () => {
				const { file_path } = await this.call<{ file_path?: string }>("getFile", { file_id: file.file_id });
				if (!file_path) throw new Error("Telegram returned no file path");
				// The URL holds the bot token: report only the status.
				const response = await this.fetchFn(`${this.apiBaseUrl}/file/bot${this.token}/${file_path}`);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return new Uint8Array(await response.arrayBuffer());
			},
		};
	}

	private async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
		const form = body instanceof FormData;
		const response = await this.fetchFn(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
			method: "POST",
			headers: form ? undefined : { "content-type": "application/json" },
			body: form ? body : JSON.stringify(body),
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
