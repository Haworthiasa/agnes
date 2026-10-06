import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanForThreats, threatMessage } from "./threat-scan.ts";

export const MAX_SKILLS = 20;
export const MAX_DESCRIPTION_CHARS = 160;
export const MAX_BODY_CHARS = 6000;
/** The index of all skills sits in every session's system prompt, so it has a budget of its own. */
export const MAX_INDEX_CHARS = 2000;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE_NAME = "SKILL.md";

export interface Skill {
	name: string;
	description: string;
	body: string;
	/** Threat patterns the saved text matches (written by hand, or before a pattern existed). */
	blocked: string[];
}

function parse(name: string, text: string): Skill {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	const header = match?.[1] ?? "";
	const description = /^description:\s*(.*)$/m.exec(header)?.[1]?.trim() ?? "";
	const body = (match?.[2] ?? text).trim();
	return { name, description, body, blocked: scanForThreats(`${description}\n${body}`) };
}

const indexLine = (skill: Skill) =>
	skill.blocked.length > 0
		? `- ${skill.name}: [BLOCKED: matched ${skill.blocked.join(", ")}. Delete it with skill_manage.]`
		: `- ${skill.name}: ${skill.description}`;

/**
 * Procedures a chat's user wants repeated, one folder per skill: `<dir>/<name>/SKILL.md` with a `name` and a
 * `description` in the header and the steps below. The model writes the name, description and steps; this class
 * writes the header, so a small model cannot break it. The description is short because the index of all
 * descriptions is part of every session's prompt.
 */
export class SkillStore {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	list(): Skill[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((name) => NAME_PATTERN.test(name) && existsSync(join(this.dir, name, FILE_NAME)))
			.sort()
			.map((name) => parse(name, readFileSync(join(this.dir, name, FILE_NAME), "utf8")));
	}

	get(name: string): Skill | undefined {
		return this.list().find((skill) => skill.name === name);
	}

	/** The block appended to the system prompt. */
	render(): string {
		const skills = this.list();
		const lines = skills.length > 0 ? skills.map(indexLine) : ["(none)"];
		return `# Skills (${skills.length}/${MAX_SKILLS})\n${lines.join("\n")}`;
	}

	create(name: string, description: string, body: string): void {
		this.validateName(name);
		if (this.get(name)) throw new Error(`Skill ${name} already exists. Use patch, or delete it first.`);
		this.validateText(description, body);
		if (this.list().length >= MAX_SKILLS) throw new Error(`The limit is ${MAX_SKILLS} skills. Delete one first.`);
		this.checkIndex([...this.list(), { name, description: description.trim(), body, blocked: [] }]);
		this.write(name, description.trim(), body.trim());
	}

	/** Replaces one piece of the steps. `oldText` must match exactly once. */
	patch(name: string, oldText: string, newText: string): void {
		const skill = this.require(name);
		const parts = skill.body.split(oldText);
		if (oldText.length === 0 || parts.length !== 2) {
			throw new Error(`old_text must match exactly once in the steps of ${name}; it matched ${parts.length - 1}.`);
		}
		const body = `${parts[0]}${newText}${parts[1]}`;
		this.validateText(skill.description, body);
		this.write(name, skill.description, body.trim());
	}

	delete(name: string): void {
		this.require(name);
		rmSync(join(this.dir, name), { recursive: true, force: true });
	}

	private require(name: string): Skill {
		const skill = this.get(name);
		if (!skill) throw new Error(`No skill named ${name}.`);
		return skill;
	}

	private validateName(name: string): void {
		if (!NAME_PATTERN.test(name)) {
			throw new Error(
				"name must be lowercase letters, digits, - or _, start with a letter or digit, at most 64 characters.",
			);
		}
	}

	private validateText(description: string, body: string): void {
		if (description.trim().length === 0 || /\n/.test(description.trim())) {
			throw new Error("description must be one non-empty line.");
		}
		if (description.trim().length > MAX_DESCRIPTION_CHARS) {
			throw new Error(
				`description is ${description.trim().length} characters; the limit is ${MAX_DESCRIPTION_CHARS}.`,
			);
		}
		if (body.trim().length === 0) throw new Error("body needs the steps.");
		if (body.trim().length > MAX_BODY_CHARS) {
			throw new Error(`body is ${body.trim().length} characters; the limit is ${MAX_BODY_CHARS}.`);
		}
		const blocked = threatMessage(`${description}\n${body}`);
		if (blocked) throw new Error(blocked);
	}

	private checkIndex(skills: Skill[]): void {
		const size = skills.map(indexLine).join("\n").length;
		if (size > MAX_INDEX_CHARS) {
			throw new Error(
				`The skill index would be ${size} characters; the limit is ${MAX_INDEX_CHARS}. Delete a skill or shorten a description.`,
			);
		}
	}

	private write(name: string, description: string, body: string): void {
		const folder = join(this.dir, name);
		mkdirSync(folder, { recursive: true });
		const path = join(folder, FILE_NAME);
		writeFileSync(`${path}.tmp`, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
		renameSync(`${path}.tmp`, path);
	}
}
