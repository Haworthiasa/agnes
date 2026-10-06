import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type MemoryTarget = "memory" | "user";

const ENTRY_SEPARATOR = "\n§\n";

/** Character budgets keep memory small enough to sit in every system prompt. */
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1400 };

const FILE_NAMES: Record<MemoryTarget, string> = { memory: "MEMORY.md", user: "USER.md" };

/**
 * Bounded long-term memory for one chat, stored as two Markdown files of entries:
 * MEMORY.md holds the agent's own notes, USER.md holds facts about the user.
 */
export class MemoryStore {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	entries(target: MemoryTarget): string[] {
		const path = join(this.dir, FILE_NAMES[target]);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split(ENTRY_SEPARATOR)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}

	add(target: MemoryTarget, content: string): void {
		this.write(target, [...this.entries(target), content.trim()]);
	}

	replace(target: MemoryTarget, oldText: string, content: string): void {
		const entries = this.entries(target);
		entries[this.find(target, entries, oldText)] = content.trim();
		this.write(target, entries);
	}

	remove(target: MemoryTarget, oldText: string): void {
		const entries = this.entries(target);
		entries.splice(this.find(target, entries, oldText), 1);
		this.write(target, entries);
	}

	/** The entries of one store as a bullet list, as the model sees them in the prompt. */
	list(target: MemoryTarget): string {
		const entries = this.entries(target);
		return entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : "(empty)";
	}

	usage(target: MemoryTarget): string {
		return `${this.entries(target).join(ENTRY_SEPARATOR).length}/${MEMORY_LIMITS[target]} chars`;
	}

	/** The block appended to the system prompt. */
	render(): string {
		const section = (title: string, target: MemoryTarget) => {
			const entries = this.entries(target);
			return `## ${title} (${this.usage(target)})\n${entries.length > 0 ? entries.map((e) => `- ${e}`).join("\n") : "(empty)"}`;
		};
		return `# Long-term memory\n${section("About the user", "user")}\n\n${section("Your notes", "memory")}`;
	}

	private find(target: MemoryTarget, entries: string[], oldText: string): number {
		const matches = entries.flatMap((entry, index) => (entry.includes(oldText) ? [index] : []));
		if (matches.length !== 1) {
			throw new Error(`old_text must match exactly one ${target} entry; it matched ${matches.length}.`);
		}
		return matches[0] as number;
	}

	private write(target: MemoryTarget, entries: string[]): void {
		const text = entries.join(ENTRY_SEPARATOR);
		if (text.length > MEMORY_LIMITS[target]) {
			throw new Error(
				`${target} would hold ${text.length}/${MEMORY_LIMITS[target]} chars. Merge or remove entries first. Current entries:\n${this.list(target)}`,
			);
		}
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, FILE_NAMES[target]), text);
	}
}

export function createMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: "memory",
		label: "Memory",
		description:
			"Edit long-term memory that persists across conversations. target=user for facts about the user (name, preferences, routines); target=memory for your own notes (lessons, ongoing projects). replace and remove find the entry containing old_text.",
		promptSnippet: "memory: save durable facts about the user and your own notes",
		promptGuidelines: [
			"Save a fact with the memory tool when the user shares a durable preference or personal detail, or corrects you. Do not save one-off task details.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "replace", "remove"] as const),
			target: StringEnum(["user", "memory"] as const),
			content: Type.Optional(Type.String({ description: "New entry text, for add and replace" })),
			old_text: Type.Optional(Type.String({ description: "Unique substring of the entry, for replace and remove" })),
		}),
		async execute(_id, params) {
			const { action, target, content, old_text: oldText } = params;
			if (action !== "remove" && !content) throw new Error(`${action} needs content.`);
			if (action !== "add" && !oldText) throw new Error(`${action} needs old_text.`);
			if (action === "add") store.add(target, content as string);
			if (action === "replace") store.replace(target, oldText as string, content as string);
			if (action === "remove") store.remove(target, oldText as string);
			return {
				content: [
					{
						type: "text",
						text: `Saved. ${target}: ${store.usage(target)}. Current entries:\n${store.list(target)}`,
					},
				],
				details: { target, action },
			};
		},
	});
}
