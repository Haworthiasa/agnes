import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeSchedule, type Schedule, type Scheduler } from "../scheduler.ts";

const MIN_INTERVAL_MINUTES = 5;
const MAX_JOBS_PER_CHAT = 20;
/** One year. */
const MAX_IN_MINUTES = 525_600;

function toSchedule(
	params: { every_minutes?: number; daily_at?: string; at?: string; in_minutes?: number },
	now: number,
): Schedule {
	const given = [params.every_minutes, params.daily_at, params.at, params.in_minutes].filter(
		(value) => value !== undefined,
	);
	if (given.length !== 1) throw new Error("Give exactly one of every_minutes, daily_at, at or in_minutes.");
	if (params.in_minutes !== undefined) {
		if (params.in_minutes < 1 || params.in_minutes > MAX_IN_MINUTES) {
			throw new Error(`in_minutes must be from 1 to ${MAX_IN_MINUTES}.`);
		}
		return { kind: "once", at: now + params.in_minutes * 60_000 };
	}
	if (params.every_minutes !== undefined) {
		if (params.every_minutes < MIN_INTERVAL_MINUTES)
			throw new Error(`every_minutes must be >= ${MIN_INTERVAL_MINUTES}.`);
		return { kind: "every", minutes: params.every_minutes };
	}
	if (params.daily_at !== undefined) {
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(params.daily_at)) throw new Error("daily_at must be HH:MM (24h).");
		return { kind: "daily", time: params.daily_at };
	}
	const at = Date.parse(params.at as string);
	if (Number.isNaN(at)) throw new Error("at must be an ISO 8601 date-time with an offset.");
	return { kind: "once", at };
}

export function createScheduleTool(scheduler: Scheduler, chatId: number): ToolDefinition {
	return defineTool({
		name: "schedule",
		label: "Schedule",
		description: `Create, list or cancel tasks that run later on their own and send the result to this chat. Each run starts a fresh conversation that sees only the task prompt, so write a self-contained prompt. Times use ${scheduler.timeZone}.`,
		promptSnippet: "schedule: run a task later or on a repeating schedule (reminders, daily briefs)",
		parameters: Type.Object({
			action: StringEnum(["create", "list", "cancel"] as const),
			prompt: Type.Optional(Type.String({ description: "Self-contained instruction to run, for create" })),
			every_minutes: Type.Optional(Type.Integer({ description: "Repeat interval in minutes" })),
			daily_at: Type.Optional(Type.String({ description: "Daily wall-clock time HH:MM" })),
			at: Type.Optional(
				Type.String({ description: "One-off ISO 8601 date-time with offset, for a specific clock time" }),
			),
			in_minutes: Type.Optional(
				Type.Integer({
					description: "One-off, this many minutes from now. Use for 'in N minutes' or 'in N hours'",
				}),
			),
			id: Type.Optional(Type.String({ description: "Job id, for cancel" })),
		}),
		async execute(_id, params) {
			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
			if (params.action === "list") {
				const jobs = scheduler.list(chatId);
				if (jobs.length === 0) return text("No scheduled tasks.");
				return text(
					jobs
						.map((job) => `${job.id}: ${describeSchedule(job.schedule, scheduler.timeZone)}: ${job.prompt}`)
						.join("\n"),
				);
			}
			if (params.action === "cancel") {
				if (!params.id) throw new Error("cancel needs id.");
				return text(scheduler.cancel(chatId, params.id) ? `Cancelled ${params.id}.` : `No task ${params.id}.`);
			}
			if (!params.prompt) throw new Error("create needs prompt.");
			if (scheduler.list(chatId).length >= MAX_JOBS_PER_CHAT)
				throw new Error(`Limit is ${MAX_JOBS_PER_CHAT} tasks.`);
			const job = scheduler.create(chatId, params.prompt, toSchedule(params, scheduler.now()));
			const next = new Date(job.nextRunAt).toLocaleString("en-GB", { timeZone: scheduler.timeZone });
			return text(`Created ${job.id} (${describeSchedule(job.schedule, scheduler.timeZone)}). Next run: ${next}.`);
		},
	});
}
