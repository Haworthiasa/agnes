import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanForThreats, threatMessage } from "../threat-scan.ts";

export type MemoryTarget = "memory" | "user";

const ENTRY_SEPARATOR = "\n§\n";

/** Character budgets keep memory small enough to sit in every system prompt. */
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1400 };

const FILE_NAMES: Record<MemoryTarget, string> = { memory: "MEMORY.md", user: "USER.md" };

export type MemoryOp =
	| { action: "add"; content: string }
	| { action: "replace"; oldText: string; content: string }
	| { action: "remove"; oldText: string };

export interface ApplyResult {
	/** Adds skipped because the same entry was already saved. */
	duplicates: number;
}

/**
 * Bounded long-term memory for one chat, stored as two Markdown files of entries:
 * MEMORY.md holds the agent's own notes, USER.md holds facts about the user.
 */
export class MemoryStore {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** The saved entries, as written on disk. */
	entries(target: MemoryTarget): string[] {
		const path = join(this.dir, FILE_NAMES[target]);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split(ENTRY_SEPARATOR)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}

	/**
	 * The entries as the model should read them. An entry that matches a threat pattern (written by hand, or
	 * saved before the pattern existed) shows as a placeholder. The text stays on disk, so it can be removed.
	 */
	display(target: MemoryTarget): string[] {
		return this.entries(target).map((entry, index) => {
			const findings = scanForThreats(entry);
			if (findings.length === 0) return entry;
			return `[BLOCKED entry ${index + 1} of ${FILE_NAMES[target]}: matched ${findings.join(", ")}. Remove it with old_text "BLOCKED entry ${index + 1}".]`;
		});
	}

	add(target: MemoryTarget, content: string): ApplyResult {
		return this.apply(target, [{ action: "add", content }]);
	}

	replace(target: MemoryTarget, oldText: string, content: string): void {
		this.apply(target, [{ action: "replace", oldText, content }]);
	}

	remove(target: MemoryTarget, oldText: string): void {
		this.apply(target, [{ action: "remove", oldText }]);
	}

	/**
	 * Applies the operations in order as one change. The character budget is checked on the final result only, so one
	 * call can free room and add an entry together. If any operation fails, nothing is written.
	 */
	apply(target: MemoryTarget, operations: MemoryOp[]): ApplyResult {
		const working = this.entries(target);
		let duplicates = 0;
		for (const operation of operations) {
			if (operation.action !== "remove") {
				const blocked = threatMessage(operation.content);
				if (blocked) throw new Error(blocked);
			}
			if (operation.action === "add") {
				const content = operation.content.trim();
				if (content.length === 0) throw new Error("add needs content.");
				if (working.includes(content)) duplicates++;
				else working.push(content);
			} else if (operation.action === "replace") {
				working[this.find(target, working, operation.oldText)] = operation.content.trim();
			} else {
				working.splice(this.find(target, working, operation.oldText), 1);
			}
		}
		this.write(target, working);
		return { duplicates };
	}

	/** The entries of one store as a bullet list, as the model sees them in the prompt. */
	list(target: MemoryTarget): string {
		const entries = this.display(target);
		return entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : "(empty)";
	}

	usage(target: MemoryTarget): string {
		return `${this.entries(target).join(ENTRY_SEPARATOR).length}/${MEMORY_LIMITS[target]} chars`;
	}

	/** The block appended to the system prompt. */
	render(): string {
		const section = (title: string, target: MemoryTarget) =>
			`## ${title} (${this.usage(target)})\n${this.list(target)}`;
		return `# Long-term memory\n${section("About the user", "user")}\n\n${section("Your notes", "memory")}`;
	}

	/** Matches the text on disk or the placeholder the model was shown. */
	private find(target: MemoryTarget, entries: string[], oldText: string): number {
		const shown = this.display(target);
		const matches = entries.flatMap((entry, index) =>
			entry.includes(oldText) || shown[index]?.includes(oldText) ? [index] : [],
		);
		if (matches.length !== 1) {
			throw new Error(`old_text must match exactly one ${target} entry; it matched ${matches.length}.`);
		}
		return matches[0] as number;
	}

	private write(target: MemoryTarget, entries: string[]): void {
		const text = entries.join(ENTRY_SEPARATOR);
		const limit = MEMORY_LIMITS[target];
		if (text.length > limit) {
			throw new Error(
				`${target} would hold ${text.length}/${limit} chars: free at least ${text.length - limit} chars. Current entries:\n${this.list(target)}`,
			);
		}
		mkdirSync(this.dir, { recursive: true });
		const path = join(this.dir, FILE_NAMES[target]);
		// Write beside the file, then rename, so a reader never sees a half-written file.
		writeFileSync(`${path}.tmp`, text);
		renameSync(`${path}.tmp`, path);
	}
}

const OperationSchema = Type.Object({
	action: StringEnum(["add", "replace", "remove"] as const),
	content: Type.Optional(
		Type.String({ description: "New entry text, for add and replace. For replace, the whole new entry." }),
	),
	old_text: Type.Optional(Type.String({ description: "Unique substring of the entry" })),
});

type OperationParams = { action: "add" | "replace" | "remove"; content?: string; old_text?: string };

function toOperation(params: OperationParams): MemoryOp {
	const { action, content, old_text: oldText } = params;
	if (action !== "remove" && !content) throw new Error(`${action} needs content.`);
	if (action !== "add" && !oldText) throw new Error(`${action} needs old_text.`);
	if (action === "add") return { action, content: content as string };
	if (action === "replace") return { action, oldText: oldText as string, content: content as string };
	return { action, oldText: oldText as string };
}

export function createMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: "memory",
		label: "Memory",
		description:
			"Edit long-term memory, kept across conversations. target=user: facts about the user. target=memory: your own notes. Pass operations (add, replace, remove): they apply together and the size limit is checked on the final result. For one change you may pass action, content, old_text directly. replace and remove find the entry containing old_text. Returns the current entries.",
		promptSnippet: "memory: save durable facts about the user and your own notes",
		promptGuidelines: [
			"Save a fact with the memory tool when the user shares a durable preference or personal detail, or corrects you. Do not save one-off task details.",
		],
		parameters: Type.Object({
			target: StringEnum(["user", "memory"] as const),
			operations: Type.Optional(Type.Array(OperationSchema)),
			action: Type.Optional(StringEnum(["add", "replace", "remove"] as const)),
			content: Type.Optional(Type.String()),
			old_text: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const { target } = params;
			if (params.operations && params.action) throw new Error("Give operations or action, not both.");
			const operations = params.operations
				? params.operations.map(toOperation)
				: params.action
					? [toOperation(params as OperationParams)]
					: [];
			if (operations.length === 0) throw new Error("Give operations, or action with content or old_text.");
			const { duplicates } = store.apply(target, operations);
			const note = duplicates > 0 ? ` ${duplicates} entry was already saved and was not added again.` : "";
			return {
				content: [
					{
						type: "text",
						text: `Saved. ${target}: ${store.usage(target)}.${note} Current entries:\n${store.list(target)}`,
					},
				],
				details: { target, operations: operations.length },
			};
		},
	});
}
