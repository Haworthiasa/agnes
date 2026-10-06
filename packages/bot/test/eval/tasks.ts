import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const TASKS_DIR = fileURLToPath(new URL("../../eval/tasks/", import.meta.url));

export const CATEGORIES = ["memory", "recall", "skills", "time", "web", "safety", "conversation"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Each category needs at least this many tasks and both polarities. */
export const MIN_TASKS_PER_CATEGORY = 5;

const Strict = { additionalProperties: false } as const;
const Category_ = Type.Union(CATEGORIES.map((category) => Type.Literal(category)));
const Target = Type.Union([Type.Literal("user"), Type.Literal("memory"), Type.Literal("any")]);
const Weighting = {
	weight: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	required: Type.Optional(Type.Boolean()),
};
const Chat = { chat: Type.Optional(Type.Integer()) };

/**
 * One check on what the agent did. State and transcript graders are deterministic and preferred. A rubric grader asks
 * an LLM judge one question. `turn` counts entries of `turns`, from 0; it defaults to the last one.
 */
const Grader = Type.Union([
	// State
	Type.Object(
		{ kind: Type.Literal("memoryMatches"), target: Target, pattern: Type.String(), ...Chat, ...Weighting },
		Strict,
	),
	Type.Object(
		{ kind: Type.Literal("memoryLacks"), target: Target, pattern: Type.String(), ...Chat, ...Weighting },
		Strict,
	),
	Type.Object({ kind: Type.Literal("memoryUnchanged"), ...Chat, ...Weighting }, Strict),
	Type.Object(
		{ kind: Type.Literal("skillExists"), name: Type.Optional(Type.String()), ...Chat, ...Weighting },
		Strict,
	),
	Type.Object(
		{
			kind: Type.Literal("skillBodyMatches"),
			name: Type.Optional(Type.String()),
			pattern: Type.String(),
			...Chat,
			...Weighting,
		},
		Strict,
	),
	Type.Object({ kind: Type.Literal("noSkill"), ...Chat, ...Weighting }, Strict),
	// A job, by when it first runs: `inMinutes` after the turn's clock (tolerance 90 s), `at` a local time `dayOffset`
	// days after the turn's local date, or `daily` at a local time.
	Type.Object(
		{
			kind: Type.Literal("jobDue"),
			inMinutes: Type.Optional(Type.Number()),
			at: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}$" })),
			dayOffset: Type.Optional(Type.Integer()),
			daily: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}$" })),
			turn: Type.Optional(Type.Integer({ minimum: 0 })),
			...Weighting,
		},
		Strict,
	),
	// Transcript
	Type.Object({ kind: Type.Literal("toolNotCalled"), name: Type.String(), ...Weighting }, Strict),
	Type.Object({ kind: Type.Literal("toolCalled"), name: Type.String(), ...Weighting }, Strict),
	Type.Object({ kind: Type.Literal("maxToolCalls"), n: Type.Integer({ minimum: 0 }), ...Weighting }, Strict),
	Type.Object({ kind: Type.Literal("noToolErrors"), ...Weighting }, Strict),
	Type.Object(
		{
			kind: Type.Literal("replyMatches"),
			pattern: Type.String(),
			/** Passes when the reply does NOT match. */
			negate: Type.Optional(Type.Boolean()),
			turn: Type.Optional(Type.Integer({ minimum: 0 })),
			...Weighting,
		},
		Strict,
	),
	// LLM judge, one dimension per call
	Type.Object(
		{
			kind: Type.Literal("rubric"),
			dimension: Type.String({ minLength: 1 }),
			question: Type.String({ minLength: 1 }),
			passWhen: Type.String({ minLength: 1 }),
			reference: Type.Optional(Type.String()),
			turn: Type.Optional(Type.Integer({ minimum: 0 })),
			...Weighting,
		},
		Strict,
	),
]);
export type Grader = Static<typeof Grader>;

const MemorySeed = Type.Object(
	{ user: Type.Optional(Type.Array(Type.String())), memory: Type.Optional(Type.Array(Type.String())) },
	Strict,
);
const SkillSeed = Type.Object({ name: Type.String(), description: Type.String(), body: Type.String() }, Strict);

const TaskSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z]+-[a-z0-9-]+$" }),
		category: Category_,
		polarity: Type.Union([Type.Literal("should"), Type.Literal("should-not")]),
		difficulty: Type.Union([Type.Literal("easy"), Type.Literal("hard")]),
		source: Type.Union([
			Type.Literal("real-failure"),
			Type.Literal("manual-check"),
			Type.Literal("transcript"),
			Type.Literal("synthetic"),
		]),
		/** About 20% of tasks; excluded with --exclude-held-out while tuning prompts. */
		heldOut: Type.Boolean(),
		/** `regression` after the task graduated. */
		suite: Type.Optional(Type.Union([Type.Literal("capability"), Type.Literal("regression")])),
		/** What a good agent does, in one or two sentences. Two experts would give the same pass or fail. */
		description: Type.String({ minLength: 1 }),
		setup: Type.Object(
			{
				/** ISO time of the first turn. */
				clock: Type.String(),
				/** Authorized user ids. Default [7]. */
				users: Type.Optional(Type.Array(Type.Integer())),
				/** Keyed by chat id. Default chat 111. */
				chats: Type.Optional(
					Type.Record(
						Type.String({ pattern: "^\\d+$" }),
						Type.Object(
							{
								memory: Type.Optional(MemorySeed),
								sessions: Type.Optional(
									Type.Array(
										Type.Object(
											{
												daysAgo: Type.Number({ minimum: 0 }),
												messages: Type.Array(
													Type.Object(
														{
															role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
															text: Type.String(),
														},
														Strict,
													),
													{ minItems: 1 },
												),
											},
											Strict,
										),
									),
								),
								skills: Type.Optional(Type.Array(SkillSeed)),
							},
							Strict,
						),
					),
				),
				/** Canned web: search results by query substring, pages by URL. */
				web: Type.Optional(
					Type.Object(
						{
							search: Type.Optional(
								Type.Array(
									Type.Object(
										{
											match: Type.String(),
											results: Type.Array(
												Type.Object(
													{ title: Type.String(), url: Type.String(), excerpt: Type.String() },
													Strict,
												),
											),
										},
										Strict,
									),
								),
							),
							pages: Type.Optional(
								Type.Record(
									Type.String(),
									Type.Object(
										{ text: Type.String(), images: Type.Optional(Type.Array(Type.String())) },
										Strict,
									),
								),
							),
						},
						Strict,
					),
				),
			},
			Strict,
		),
		/** Chat and user default to 111 and 7. */
		turns: Type.Array(
			Type.Union([
				Type.Object(
					{
						text: Type.String(),
						chat: Type.Optional(Type.Integer()),
						user: Type.Optional(Type.Integer()),
						image: Type.Optional(Type.Literal("fixture-photo")),
						advanceMs: Type.Optional(Type.Number({ minimum: 0 })),
					},
					Strict,
				),
				Type.Object(
					{
						kind: Type.Union([Type.Literal("new"), Type.Literal("tick")]),
						chat: Type.Optional(Type.Integer()),
						user: Type.Optional(Type.Integer()),
						advanceMs: Type.Optional(Type.Number({ minimum: 0 })),
					},
					Strict,
				),
			]),
			{ minItems: 1 },
		),
		graders: Type.Array(Grader, { minItems: 1 }),
		/** The state and reply of a perfect run. The state graders must pass on it. */
		reference: Type.Object(
			{
				reply: Type.Optional(Type.String()),
				memory: Type.Optional(MemorySeed),
				skills: Type.Optional(Type.Array(SkillSeed)),
				/** A job a perfect run schedules: once, N minutes after the last turn. */
				jobDueInMinutes: Type.Optional(Type.Number()),
				/** Or once, at a local time `dayOffset` days after the date of the last turn. */
				jobAt: Type.Optional(
					Type.Object({ time: Type.String({ pattern: "^\\d{2}:\\d{2}$" }), dayOffset: Type.Integer() }, Strict),
				),
				/** Or a daily job at a local time. */
				jobDaily: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}$" })),
			},
			Strict,
		),
	},
	Strict,
);
export type CapabilityTask = Static<typeof TaskSchema>;
export type TaskTurn = CapabilityTask["turns"][number];

/** The bot reads a page of fewer characters than this as a failed read. */
export const MIN_PAGE_CHARS = 200;

export const DEFAULT_CHAT = 111;
export const DEFAULT_USER = 7;
export const DEFAULT_USERS = [DEFAULT_USER];

/** Parses one task file's JSON. The message names the file and every field that is wrong. */
export function parseTask(json: unknown, source: string): CapabilityTask {
	const errors = Value.Errors(TaskSchema, json);
	if (errors.length > 0) {
		const detail = errors.map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ");
		throw new Error(`${source}: ${detail}`);
	}
	const task = json as CapabilityTask;
	const issue = crossCheck(task);
	if (issue) throw new Error(`${source}: ${issue}`);
	return task;
}

/** What the schema cannot say: a grader may name only things the task defines. */
function crossCheck(task: CapabilityTask): string | undefined {
	if (!task.id.startsWith(`${task.category}-`)) return `id must start with "${task.category}-"`;
	if (Number.isNaN(Date.parse(task.setup.clock))) return `setup.clock "${task.setup.clock}" is not a date`;
	const chats = new Set([
		DEFAULT_CHAT,
		...Object.keys(task.setup.chats ?? {}).map(Number),
		...task.turns.flatMap((turn) => (turn.chat === undefined ? [] : [turn.chat])),
	]);
	const users = new Set(task.setup.users ?? DEFAULT_USERS);
	for (const [index, turn] of task.turns.entries()) {
		if (!users.has(turn.user ?? task.setup.users?.[0] ?? DEFAULT_USER))
			return `turns[${index}].user is not in setup.users`;
	}
	const skills = new Set<string>();
	for (const chat of Object.values(task.setup.chats ?? {}))
		for (const skill of chat.skills ?? []) skills.add(skill.name);
	for (const skill of task.reference.skills ?? []) skills.add(skill.name);
	// The bot's page reader treats a page under 200 characters as a failed read, so a canned page must be longer.
	for (const [url, page] of Object.entries(task.setup.web?.pages ?? {})) {
		if (page.text.trim().length < MIN_PAGE_CHARS)
			return `setup.web.pages["${url}"] has under ${MIN_PAGE_CHARS} characters of text`;
	}
	for (const [index, grader] of task.graders.entries()) {
		const where = `graders[${index}] (${grader.kind})`;
		if ("pattern" in grader) {
			try {
				new RegExp(grader.pattern, "iu");
			} catch {
				return `${where}: pattern "${grader.pattern}" is not a valid regular expression`;
			}
		}
		if ("turn" in grader && grader.turn !== undefined && grader.turn >= task.turns.length) {
			return `${where}: turn ${grader.turn} is past the last turn (${task.turns.length - 1})`;
		}
		if ("chat" in grader && grader.chat !== undefined && !chats.has(grader.chat)) {
			return `${where}: chat ${grader.chat} is not a chat of the task`;
		}
		if (
			(grader.kind === "skillExists" || grader.kind === "skillBodyMatches") &&
			grader.name &&
			!skills.has(grader.name)
		) {
			return `${where}: skill "${grader.name}" is in neither setup nor reference.skills`;
		}
		if (grader.kind === "jobDue") {
			const forms = [grader.inMinutes, grader.at, grader.daily].filter((value) => value !== undefined).length;
			if (forms !== 1) return `${where}: give exactly one of inMinutes, at, daily`;
		}
	}
	return undefined;
}

/** Every task under `eval/tasks/<category>/<id>.json`, sorted by id. A file must sit in the folder of its category. */
export function loadTasks(root: string = TASKS_DIR): CapabilityTask[] {
	if (!existsSync(root)) return [];
	const tasks: CapabilityTask[] = [];
	for (const folder of readdirSync(root, { withFileTypes: true })) {
		if (!folder.isDirectory()) continue;
		for (const file of readdirSync(join(root, folder.name)).filter((name) => name.endsWith(".json"))) {
			const path = join(folder.name, file);
			const task = parseTask(JSON.parse(readFileSync(join(root, path), "utf8")), path);
			if (task.category !== folder.name)
				throw new Error(`${path}: category "${task.category}" does not match its folder`);
			if (`${task.id}.json` !== file) throw new Error(`${path}: the file name must be the id "${task.id}"`);
			tasks.push(task);
		}
	}
	return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** Problems with the set as a whole: duplicate ids, thin categories, a missing polarity. Empty when the set is sound. */
export function validateCatalog(tasks: CapabilityTask[], minPerCategory: number = MIN_TASKS_PER_CATEGORY): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const task of tasks) {
		if (seen.has(task.id)) problems.push(`duplicate id ${task.id}`);
		seen.add(task.id);
	}
	for (const category of CATEGORIES) {
		const own = tasks.filter((task) => task.category === category);
		if (own.length < minPerCategory) problems.push(`${category} has ${own.length} tasks, needs ${minPerCategory}`);
		for (const polarity of ["should", "should-not"] as const) {
			if (!own.some((task) => task.polarity === polarity)) problems.push(`${category} has no ${polarity} task`);
		}
	}
	return problems;
}
