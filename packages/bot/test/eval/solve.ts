import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Message,
} from "@earendil-works/pi-ai";
import type { FauxRuntime } from "../helpers.ts";
import { runTrial, type TrialResult } from "./capability.ts";
import type { CapabilityTask, Need, Script } from "./tasks.ts";

/** One model request as the scripted agent saw it. */
export interface CapturedRequest {
	system: string;
	tools: string[];
	messages: Message[];
}

export interface Played {
	trial: TrialResult;
	/** Every model request of the run, in order. */
	requests: CapturedRequest[];
}

/**
 * Plays a scripted agent through the real bot on the faux provider. For each text turn the agent makes its tool calls
 * in order, then replies. A text turn without an entry replies "Ok."; the last one replies `lastReply` instead.
 * Each model request is captured, so the caller can check what the agent could see.
 */
export async function playScript(
	task: CapabilityTask,
	script: Script,
	runtime: FauxRuntime,
	lastReply = "Ok.",
): Promise<Played> {
	const requests: CapturedRequest[] = [];
	const respond =
		(make: () => AssistantMessage): FauxResponseFactory =>
		(context) => {
			requests.push({
				system: getCurrentSystemPrompt(context.messages) ?? "",
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				messages: context.messages.filter((message) => message.role !== "system"),
			});
			return make();
		};
	const lastTextTurn = task.turns.findLastIndex((turn) => "text" in turn);
	const responses: FauxResponseFactory[] = [];
	for (const [index, turn] of task.turns.entries()) {
		if (!("text" in turn)) continue;
		const step = script[String(index)] ?? {};
		for (const call of step.calls ?? []) {
			responses.push(
				respond(() =>
					fauxAssistantMessage([fauxToolCall(call.name, call.args as JsonObject)], { stopReason: "toolUse" }),
				),
			);
		}
		responses.push(respond(() => fauxAssistantMessage(step.reply ?? (index === lastTextTurn ? lastReply : "Ok."))));
	}
	runtime.faux.setResponses(responses);
	const trial = await runTrial(task, 1, { modelRuntime: runtime.modelRuntime, model: runtime.faux.getModel() });
	return { trial, requests };
}

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
}

const includes = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());

/** The needs the last model request does not meet, each as a sentence. Empty when the environment gives all of them. */
export function unmetNeeds(needs: Need[], requests: CapturedRequest[]): string[] {
	const last = requests.at(-1);
	if (!last) return ["the agent made no model request"];
	const newest = last.messages.findLastIndex((message) => message.role === "user");
	const newestMessage = last.messages[newest];
	const history = last.messages.filter((message, index) => message.role !== "toolResult" && index !== newest);
	const unmet: string[] = [];
	for (const need of needs) {
		if ("offers" in need) {
			if (!last.tools.includes(need.offers)) unmet.push(`the request does not offer the tool ${need.offers}`);
			continue;
		}
		if ("image" in need) {
			const content = newestMessage?.content;
			if (!Array.isArray(content) || !content.some((part) => part.type === "image")) {
				unmet.push("the newest user message has no image");
			}
			continue;
		}
		if (need.from === "tool") {
			const found = last.messages.some(
				(message) =>
					message.role === "toolResult" && message.toolName === need.name && includes(textOf(message), need.text),
			);
			if (!found) unmet.push(`no ${need.name} result holds "${need.text}"`);
			continue;
		}
		const where = {
			prompt: [last.system],
			latest: newestMessage ? [textOf(newestMessage)] : [],
			history: history.map(textOf),
		}[need.from];
		if (!where.some((text) => includes(text, need.text))) unmet.push(`the ${need.from} lacks "${need.text}"`);
	}
	return unmet;
}
