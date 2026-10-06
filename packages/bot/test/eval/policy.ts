import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Message,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { CacheSimulator } from "./cache-sim.ts";

export interface ToolCallLog {
	name: string;
	args: JsonObject;
}

export interface PolicyLog {
	toolCalls: ToolCallLog[];
	/** Parameter schema (as JSON) of every tool the latest request declared, by tool name. */
	toolSchemas: Record<string, string>;
}

type Content = Message["content"];

export function textOf(content: Content): string {
	if (typeof content === "string") return content;
	return content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
}

const FILLER = "Mình đã ghi nhận ý của bạn và sẽ trả lời ngắn gọn, đúng trọng tâm, không thêm chi tiết thừa nào khác.";

/** A reply long enough that history grows each turn, and a function of the question only. */
function plainReply(question: string): string {
	const echo = question.replace(/\s+/g, " ").slice(0, 40);
	return `Về "${echo}": ${FILLER} ${FILLER}`;
}

function declared(context: TranscriptContext, name: string): { parameters: unknown } | undefined {
	return getCurrentTools(context.messages).find((tool) => tool.name === name);
}

function lastMessage(context: TranscriptContext): Message | undefined {
	return context.messages.findLast((message) => message.role !== "system");
}

/**
 * The scripted stand-in for a model. It follows fixed rules, so a run is reproducible and tests the bot's wiring
 * (tools, prompts, sessions, cache), not what a real model would decide. Real decisions are measured live.
 */
function decide(context: TranscriptContext, clock: () => number, log: PolicyLog): AssistantMessage {
	const last = lastMessage(context);
	const toolCall = (name: string, args: JsonObject) => {
		log.toolCalls.push({ name, args });
		return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	};
	if (!last) return fauxAssistantMessage("Chưa có tin nhắn.");
	if (last.role === "toolResult") return fauxAssistantMessage("Xong, mình đã xử lý yêu cầu của bạn.");
	if (last.role !== "user") return fauxAssistantMessage(plainReply(""));

	const text = textOf(last.content).replace(/^\[Now:[^\]]*\]\s*/, "");
	if (typeof last.content !== "string" && last.content.some((part) => part.type === "image")) {
		return fauxAssistantMessage("Mình đã nhận được ảnh của bạn.");
	}

	const remember = /^(?:hãy\s+)?nhớ[:,]\s*(.+)$/is.exec(text);
	if (remember?.[1]) return toolCall("memory", { action: "add", target: "user", content: remember[1].trim() });

	const remind = /nhắc.*sau\s+(\d+)\s+phút/is.exec(text);
	if (remind?.[1] && declared(context, "schedule")) {
		const minutes = Number(remind[1]);
		const schedule = declared(context, "schedule");
		// Use the relative parameter when the tool offers it; otherwise compute an absolute time from the clock.
		if (JSON.stringify(schedule?.parameters).includes("in_minutes")) {
			return toolCall("schedule", { action: "create", prompt: "Nhắc uống nước", in_minutes: minutes });
		}
		return toolCall("schedule", {
			action: "create",
			prompt: "Nhắc uống nước",
			at: new Date(clock() + minutes * 60_000).toISOString(),
		});
	}

	const recall = /chuyện cũ|hôm qua/i.test(text);
	if (recall && declared(context, "session_search")) return toolCall("session_search", { query: text.slice(0, 40) });

	const skill = /^lưu quy trình:\s*(.+)$/is.exec(text);
	if (skill?.[1] && declared(context, "skill_manage")) {
		return toolCall("skill_manage", {
			action: "create",
			name: "daily-brief",
			description: "Bản tin buổi sáng theo ý người dùng",
			body: skill[1].trim(),
		});
	}

	return fauxAssistantMessage(plainReply(text));
}

/**
 * Installs the scripted model on a faux provider. Every request goes through the cache simulator, keyed by the
 * session id pi sends. The factory re-queues itself first, so the queue never runs dry.
 */
export function installPolicy(
	faux: FauxProviderRegistration,
	simulator: CacheSimulator,
	clock: () => number,
	log: PolicyLog,
): void {
	const step: FauxResponseFactory = (context, options) => {
		faux.appendResponses([step]);
		log.toolSchemas = Object.fromEntries(
			getCurrentTools(context.messages).map((tool) => [tool.name, JSON.stringify(tool.parameters)]),
		);
		simulator.record(options?.sessionId ?? "no-session", context, getCurrentSystemPrompt(context.messages));
		return decide(context, clock, log);
	};
	faux.setResponses([step]);
}
