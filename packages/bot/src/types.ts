/** A text message from an end user, normalized across chat platforms. */
export interface IncomingMessage {
	chatId: number;
	/** Sender identity. Authorization keys on this, never on chatId: in groups the two differ. */
	userId: number;
	text: string;
}

/** The platform boundary. Telegram implements it; tests use an in-memory fake. */
export interface ChatTransport {
	receive(signal: AbortSignal): AsyncIterable<IncomingMessage>;
	send(chatId: number, text: string): Promise<void>;
	typing(chatId: number): Promise<void>;
}

/** One persistent conversation with the agent. */
export interface ChatAgent {
	/** Runs one agent turn and resolves with the final assistant text. */
	prompt(text: string): Promise<string>;
	dispose(): void;
}

export interface ChatAgentOptions {
	/** Start a new transcript instead of continuing the most recent one. */
	fresh: boolean;
}

export type ChatAgentFactory = (chatId: number, options: ChatAgentOptions) => Promise<ChatAgent>;
