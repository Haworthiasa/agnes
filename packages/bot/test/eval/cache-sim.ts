import {
	collapseSystemMessages,
	getSystemMessageText,
	type Message,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/** The real provider log shows every cacheRead is a multiple of 64 tokens. */
export const CACHE_BLOCK_TOKENS = 64;
const CHARS_PER_TOKEN = 4;

/** How a provider treats a system message that arrives after the first message. */
export interface ProviderProfile {
	name: string;
	/** True: a later system message stays in place. False: pi rebuilds the leading system message from all of them. */
	midConvoSystemMessages: boolean;
}

/** zai (the bot's default provider) collapses system messages, so any prompt change rewrites the request head. */
export const ZAI_PROFILE: ProviderProfile = { name: "zai", midConvoSystemMessages: false };
export const IN_PLACE_PROFILE: ProviderProfile = { name: "in-place", midConvoSystemMessages: true };

export interface CallStat {
	sessionId: string;
	promptTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	/** Characters of the current system prompt. */
	systemChars: number;
}

/** Request bytes as the provider sees them. Timestamps are not sent, so they are left out. */
function serializeMessage(message: Message): string {
	if (message.role === "system") {
		return `system:${getSystemMessageText(message)}|+${JSON.stringify(message.toolsAdded ?? [])}|-${JSON.stringify(message.toolsRemoved ?? [])}`;
	}
	if (message.role === "toolResult") return `toolResult:${message.toolCallId}:${JSON.stringify(message.content)}`;
	return `${message.role}:${JSON.stringify(message.content)}`;
}

/** Tool call ids are random per run, so they are renamed in order of appearance to keep a run reproducible. */
function toolCallIds(messages: Message[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") ids.push(message.toolCallId);
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall") ids.push(part.id);
		}
	}
	return [...new Set(ids)];
}

export function serializeRequest(context: TranscriptContext, profile: ProviderProfile): string {
	const resolved = profile.midConvoSystemMessages ? context : collapseSystemMessages(context);
	let text = resolved.messages.map(serializeMessage).join("\n\n");
	for (const [index, id] of toolCallIds(resolved.messages).entries()) text = text.replaceAll(id, `call-${index}`);
	return text;
}

function commonPrefixLength(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) index++;
	return index;
}

/**
 * Deterministic model of provider prefix caching: a request may reuse the longest prefix it shares with any
 * earlier request, in whole blocks of 64 tokens. Reuse across chats is allowed, as with a real provider.
 */
export class CacheSimulator {
	readonly profile: ProviderProfile;
	readonly calls: CallStat[] = [];
	private readonly seen: string[] = [];
	/** Last serialized request per session, for the append-only check. */
	private readonly lastBySession = new Map<string, string>();
	/** Calls whose request did not extend the previous request of the same session. */
	readonly prefixBreaks: Array<{ sessionId: string; callIndex: number }> = [];
	/** The system prompt of each session's first request. */
	readonly firstSystemPrompt = new Map<string, string>();

	constructor(profile: ProviderProfile) {
		this.profile = profile;
	}

	record(sessionId: string, context: TranscriptContext, systemPrompt: string): CallStat {
		const text = serializeRequest(context, this.profile);
		const promptTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
		let sharedChars = 0;
		for (const earlier of this.seen) sharedChars = Math.max(sharedChars, commonPrefixLength(earlier, text));
		const sharedTokens = Math.floor(sharedChars / CHARS_PER_TOKEN);
		const cachedTokens = Math.min(promptTokens, Math.floor(sharedTokens / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS);

		const previous = this.lastBySession.get(sessionId);
		if (previous !== undefined && !text.startsWith(previous)) {
			this.prefixBreaks.push({ sessionId, callIndex: this.calls.length });
		}
		if (!this.firstSystemPrompt.has(sessionId)) this.firstSystemPrompt.set(sessionId, systemPrompt);
		this.lastBySession.set(sessionId, text);
		this.seen.push(text);

		const stat = {
			sessionId,
			promptTokens,
			cachedTokens,
			uncachedTokens: promptTokens - cachedTokens,
			systemChars: systemPrompt.length,
		};
		this.calls.push(stat);
		return stat;
	}
}
