import type { ChatAgent, ChatAgentFactory, ChatTransport, IncomingMessage } from "./types.ts";

export interface GatewayOptions {
	transport: ChatTransport;
	createAgent: ChatAgentFactory;
	/** Telegram user ids allowed to talk to the bot. Everyone else is ignored. */
	allowedUserIds: ReadonlySet<number>;
}

interface ChatState {
	agent: Promise<ChatAgent>;
	/** Tail of this chat's turn chain. Turns in one chat run strictly in order. */
	queue: Promise<void>;
}

export const HELP_TEXT = "Gửi tin nhắn để trò chuyện.\n/new: bắt đầu hội thoại mới.";

/** Routes platform messages to one persistent agent per chat. */
export class Gateway {
	private readonly transport: ChatTransport;
	private readonly createAgent: ChatAgentFactory;
	private readonly allowedUserIds: ReadonlySet<number>;
	private readonly chats = new Map<number, ChatState>();

	constructor(options: GatewayOptions) {
		this.transport = options.transport;
		this.createAgent = options.createAgent;
		this.allowedUserIds = options.allowedUserIds;
	}

	async run(signal: AbortSignal): Promise<void> {
		for await (const message of this.transport.receive(signal)) {
			void this.handle(message);
		}
	}

	/** Resolves when this message's turn has finished and its reply is sent. */
	handle(message: IncomingMessage): Promise<void> {
		if (!this.allowedUserIds.has(message.userId)) {
			console.warn(`[gateway] ignored message from unauthorized user ${message.userId}`);
			return Promise.resolve();
		}
		const text = message.text.trim();
		if (text === "/start" || text === "/help") return this.transport.send(message.chatId, HELP_TEXT);
		if (text === "/new") return this.enqueue(message.chatId, () => this.reset(message.chatId));
		return this.enqueue(message.chatId, async () => {
			const agent = await this.chat(message.chatId).agent;
			await this.transport.typing(message.chatId).catch(() => {});
			const reply = await agent.prompt(text);
			await this.transport.send(message.chatId, reply || "(không có phản hồi)");
		});
	}

	dispose(): void {
		for (const state of this.chats.values()) void state.agent.then((agent) => agent.dispose());
		this.chats.clear();
	}

	private chat(chatId: number): ChatState {
		let state = this.chats.get(chatId);
		if (!state) {
			state = { agent: this.createAgent(chatId, { fresh: false }), queue: Promise.resolve() };
			this.chats.set(chatId, state);
		}
		return state;
	}

	private async reset(chatId: number): Promise<void> {
		const state = this.chat(chatId);
		(await state.agent).dispose();
		state.agent = this.createAgent(chatId, { fresh: true });
		await state.agent;
		await this.transport.send(chatId, "Đã bắt đầu hội thoại mới.");
	}

	private enqueue(chatId: number, turn: () => Promise<void>): Promise<void> {
		const state = this.chat(chatId);
		const run = state.queue.then(turn).catch(async (error: unknown) => {
			console.error(`[gateway] chat ${chatId} turn failed`, error);
			await this.transport.send(chatId, `Lỗi: ${(error as Error).message}`).catch(() => {});
		});
		state.queue = run;
		return run;
	}
}
