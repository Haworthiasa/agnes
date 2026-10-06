import type { ImageContent } from "@earendil-works/pi-ai";

/** A file attached to a message. Downloaded only after the sender is authorized. */
export interface IncomingFile {
	name: string;
	mimeType: string;
	/** Bytes, when the platform reports it before download. */
	size?: number;
	download(): Promise<Uint8Array>;
}

/** A message from an end user, normalized across chat platforms. */
export interface IncomingMessage {
	chatId: number;
	/** Sender identity. Authorization keys on this, never on chatId: in groups the two differ. */
	userId: number;
	/** Message text or attachment caption. Empty when a file came without one. */
	text: string;
	file?: IncomingFile;
}

export interface Photo {
	data: Uint8Array;
	mimeType: string;
}

/** The platform boundary. Telegram implements it; tests use an in-memory fake. */
export interface ChatTransport {
	receive(signal: AbortSignal): AsyncIterable<IncomingMessage>;
	send(chatId: number, text: string): Promise<void>;
	sendPhoto(chatId: number, photo: Photo, caption?: string): Promise<void>;
	typing(chatId: number): Promise<void>;
}

/** An image the model put in its reply as `![alt](url)`, from a URL it saw in a tool result or user message. */
export interface ReplyImage {
	url: string;
	alt: string;
}

/** A reply in order: text, and images where the model placed them. */
export type ReplyPart = { text: string } | { image: ReplyImage };

export interface AgentReply {
	parts: ReplyPart[];
}

/** One persistent conversation with the agent. */
export interface ChatAgent {
	/** Runs one agent turn and resolves with the final assistant reply. */
	prompt(text: string, images?: ImageContent[]): Promise<AgentReply>;
	dispose(): void;
}

export interface ChatAgentOptions {
	/** Start a new transcript instead of continuing the most recent one. */
	fresh: boolean;
	/** Keep the transcript in memory only. Scheduled runs use this so they never become the chat's latest session. */
	ephemeral?: boolean;
}

export type ChatAgentFactory = (chatId: number, options: ChatAgentOptions) => Promise<ChatAgent>;
