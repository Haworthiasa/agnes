import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deliverReply } from "./media.ts";
import type { ChatAgentFactory, ChatTransport } from "./types.ts";

export type Schedule =
	| { kind: "every"; minutes: number }
	/** Wall-clock time in the bot's time zone. */
	| { kind: "daily"; time: string }
	| { kind: "once"; at: number };

export interface Job {
	id: string;
	chatId: number;
	prompt: string;
	schedule: Schedule;
	nextRunAt: number;
	lastRunAt?: number;
}

const MINUTE = 60_000;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(instant);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - Math.floor(instant / 1000) * 1000;
}

/** First run strictly after `after`. Undefined when a one-shot job has no future run. */
export function nextRun(schedule: Schedule, after: number, timeZone: string): number | undefined {
	if (schedule.kind === "every") return after + schedule.minutes * MINUTE;
	if (schedule.kind === "once") return schedule.at > after ? schedule.at : undefined;
	const [hour, minute] = schedule.time.split(":").map(Number);
	const local = new Date(after + zoneOffset(after, timeZone));
	for (let day = 0; day <= 2; day++) {
		const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour, minute);
		const candidate = guess - zoneOffset(guess, timeZone);
		if (candidate > after) return candidate;
	}
	return undefined;
}

export function describeSchedule(schedule: Schedule, timeZone: string): string {
	if (schedule.kind === "every") return `every ${schedule.minutes} min`;
	if (schedule.kind === "daily") return `daily at ${schedule.time} (${timeZone})`;
	return `once at ${new Date(schedule.at).toLocaleString("en-GB", { timeZone })} (${timeZone})`;
}

/** Jobs persisted as one JSON file, replaced atomically on every write. */
export class JobStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	all(): Job[] {
		if (!existsSync(this.path)) return [];
		return JSON.parse(readFileSync(this.path, "utf8")) as Job[];
	}

	save(jobs: Job[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(`${this.path}.tmp`, JSON.stringify(jobs, null, 2));
		renameSync(`${this.path}.tmp`, this.path);
	}
}

export interface SchedulerOptions {
	store: JobStore;
	transport: ChatTransport;
	createAgent: ChatAgentFactory;
	timeZone: string;
	now?: () => number;
	tickMs?: number;
}

/** Fires due jobs, each in a fresh session, and delivers the result to the job's chat. */
export class Scheduler {
	private readonly store: JobStore;
	private readonly transport: ChatTransport;
	private readonly createAgent: ChatAgentFactory;
	readonly timeZone: string;
	readonly now: () => number;
	private readonly tickMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private ticking: Promise<void> = Promise.resolve();

	constructor(options: SchedulerOptions) {
		this.store = options.store;
		this.transport = options.transport;
		this.createAgent = options.createAgent;
		this.timeZone = options.timeZone;
		this.now = options.now ?? Date.now;
		this.tickMs = options.tickMs ?? 30_000;
	}

	create(chatId: number, prompt: string, schedule: Schedule): Job {
		const nextRunAt = nextRun(schedule, this.now(), this.timeZone);
		if (nextRunAt === undefined) throw new Error("That time is in the past.");
		const job: Job = { id: randomUUID().slice(0, 8), chatId, prompt, schedule, nextRunAt };
		this.store.save([...this.store.all(), job]);
		return job;
	}

	list(chatId: number): Job[] {
		return this.store.all().filter((job) => job.chatId === chatId);
	}

	cancel(chatId: number, id: string): boolean {
		const jobs = this.store.all();
		const kept = jobs.filter((job) => !(job.chatId === chatId && job.id === id));
		this.store.save(kept);
		return kept.length < jobs.length;
	}

	start(): void {
		this.timer = setInterval(() => void this.tick(), this.tickMs);
	}

	stop(): void {
		clearInterval(this.timer);
	}

	/** Runs every due job once. Overlapping calls wait for the previous tick. */
	tick(): Promise<void> {
		this.ticking = this.ticking.then(() => this.runDue());
		return this.ticking;
	}

	private async runDue(): Promise<void> {
		const now = this.now();
		const due: Job[] = [];
		// Advance and persist before running: a crash mid-job skips that run instead of repeating it.
		// A bot that was offline fires a missed job once, then resumes from now.
		const jobs = this.store.all().flatMap((job) => {
			if (job.nextRunAt > now) return [job];
			due.push(job);
			const nextRunAt = nextRun(job.schedule, now, this.timeZone);
			return nextRunAt === undefined ? [] : [{ ...job, nextRunAt, lastRunAt: now }];
		});
		if (due.length === 0) return;
		this.store.save(jobs);
		for (const job of due) await this.run(job);
	}

	private async run(job: Job): Promise<void> {
		try {
			const agent = await this.createAgent(job.chatId, { fresh: true, ephemeral: true });
			try {
				const reply = await agent.prompt(
					`[Scheduled task ${job.id}, ${describeSchedule(job.schedule, this.timeZone)}]\n${job.prompt}`,
				);
				const label = `[Lịch ${job.id}]`;
				const [first, ...rest] = reply.parts;
				const parts =
					first === undefined
						? [{ text: `${label}\n(không có phản hồi)` }]
						: "text" in first
							? [{ text: `${label}\n${first.text}` }, ...rest]
							: [{ text: label }, ...reply.parts];
				await deliverReply(this.transport, job.chatId, { parts });
			} finally {
				agent.dispose();
			}
		} catch (error) {
			console.error(`[scheduler] job ${job.id} failed`, error);
			await this.transport.send(job.chatId, `[Lịch ${job.id}] Lỗi: ${(error as Error).message}`).catch(() => {});
		}
	}
}
