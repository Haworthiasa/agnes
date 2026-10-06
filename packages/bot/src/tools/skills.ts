import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SkillStore } from "../skills.ts";

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

/** Loads the steps of a skill from the index in the prompt. */
export function createSkillViewTool(store: SkillStore): ToolDefinition {
	return defineTool({
		name: "skill_view",
		label: "Skill",
		description: "Read a listed skill's steps, then follow them.",
		promptSnippet: "skill_view: read a saved procedure",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params) {
			const skill = store.get(params.name);
			if (!skill) throw new Error(`No skill named ${params.name}.`);
			if (skill.blocked.length > 0)
				throw new Error(`Skill ${params.name} is blocked (${skill.blocked.join(", ")}).`);
			return text(
				`<skill name="${skill.name}">\n${skill.body}\n</skill>\nFollow these steps. What the user asks now still comes first.`,
			);
		},
	});
}

/** Creates, edits and deletes skills, one change per call. */
export function createSkillManageTool(store: SkillStore): ToolDefinition {
	return defineTool({
		name: "skill_manage",
		label: "Skill manager",
		description:
			"Save a repeatable procedure. create: name, description (one line saying when to use it), body (the steps and format). patch: replace old_text (it appears once in the body) with new_text. delete.",
		promptSnippet: "skill_manage: save, fix or delete a procedure",
		parameters: Type.Object({
			action: StringEnum(["create", "patch", "delete"] as const),
			name: Type.String(),
			description: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			old_text: Type.Optional(Type.String()),
			new_text: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const { action, name } = params;
			if (action === "create") {
				if (!params.description || !params.body) throw new Error("create needs description and body.");
				store.create(name, params.description, params.body);
			} else if (action === "patch") {
				if (params.old_text === undefined || params.new_text === undefined) {
					throw new Error("patch needs old_text and new_text.");
				}
				store.patch(name, params.old_text, params.new_text);
			} else {
				store.delete(name);
			}
			return text(
				action === "delete"
					? `Deleted ${name}.`
					: `Saved ${name}. The skill list in the prompt shows it from the next session; use skill_view to read it now.`,
			);
		},
	});
}
