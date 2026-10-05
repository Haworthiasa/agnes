import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot.ts";
import { JobStore, nextRun } from "../src/scheduler.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "./helpers.ts";

const OWNER = 5;
const TZ = "Asia/Ho_Chi_Minh";

function userTexts(context: TranscriptContext): string[] {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		);
}

describe("scheduled tasks", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	it("creates a daily task from chat, fires it once per day in a fresh session, and survives a restart", async () => {
		runtime = await createFauxRuntime();
		let clock = Date.parse("2026-10-06T06:00:00+07:00");
		const transport = new FakeTransport();
		const start = () =>
			createBot({
				dataDir: runtime.dataDir,
				modelRuntime: runtime.modelRuntime,
				model: runtime.faux.getModel(),
				transport,
				allowedUserIds: new Set([OWNER]),
				allowShell: false,
				timeZone: TZ,
				webBackends: [],
				now: () => clock,
			});
		const jobContexts: string[][] = [];
		const chatContexts: string[][] = [];
		runtime.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("schedule", { action: "create", daily_at: "07:00", prompt: "Tóm tắt tin công nghệ" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Đã đặt lịch 7:00 mỗi ngày."),
			(context) => {
				jobContexts.push(userTexts(context));
				return fauxAssistantMessage("Tin hôm nay");
			},
			(context) => {
				chatContexts.push(userTexts(context));
				return fauxAssistantMessage("ok");
			},
			(context) => {
				jobContexts.push(userTexts(context));
				return fauxAssistantMessage("Tin ngày mai");
			},
		]);

		const first = start();
		await first.gateway.handle({
			chatId: OWNER,
			userId: OWNER,
			text: "7h sáng mỗi ngày tóm tắt tin công nghệ cho tôi",
		});
		const [job] = first.scheduler.list(OWNER);
		expect(job?.nextRunAt).toBe(Date.parse("2026-10-06T07:00:00+07:00"));

		clock = Date.parse("2026-10-06T06:59:00+07:00");
		await first.scheduler.tick();
		clock = Date.parse("2026-10-06T07:00:20+07:00");
		await first.scheduler.tick();
		first.gateway.dispose();

		const restarted = start();
		await restarted.scheduler.tick();
		await restarted.gateway.handle({ chatId: OWNER, userId: OWNER, text: "cảm ơn" });
		clock = Date.parse("2026-10-07T07:00:05+07:00");
		await restarted.scheduler.tick();
		restarted.gateway.dispose();

		expect(transport.sent.map((entry) => entry.text)).toEqual([
			"Đã đặt lịch 7:00 mỗi ngày.",
			`[Lịch ${job?.id}]\nTin hôm nay`,
			"ok",
			`[Lịch ${job?.id}]\nTin ngày mai`,
		]);
		expect(jobContexts).toEqual([
			[`[Scheduled task ${job?.id}, daily at 07:00 (${TZ})]\nTóm tắt tin công nghệ`],
			[`[Scheduled task ${job?.id}, daily at 07:00 (${TZ})]\nTóm tắt tin công nghệ`],
		]);
		// The job's session must not replace the chat's latest session.
		expect(chatContexts).toEqual([["7h sáng mỗi ngày tóm tắt tin công nghệ cho tôi", "cảm ơn"]]);
	});

	it("fires a job missed while offline once, then resumes from now", async () => {
		runtime = await createFauxRuntime();
		let clock = Date.parse("2026-10-06T08:00:00+07:00");
		const transport = new FakeTransport();
		const { scheduler } = createBot({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			transport,
			allowedUserIds: new Set([OWNER]),
			allowShell: false,
			timeZone: TZ,
			webBackends: [],
			now: () => clock,
		});
		runtime.faux.setResponses([fauxAssistantMessage("uống nước")]);
		const job = scheduler.create(OWNER, "nhắc uống nước", { kind: "every", minutes: 60 });

		clock += 5 * 60 * 60_000;
		await scheduler.tick();

		expect(transport.sent).toEqual([{ chatId: OWNER, text: `[Lịch ${job.id}]\nuống nước` }]);
		expect(new JobStore(join(runtime.dataDir, "jobs.json")).all()[0]?.nextRunAt).toBe(clock + 60 * 60_000);
	});
});

describe("nextRun", () => {
	it("computes daily wall-clock times in the bot's time zone", () => {
		const daily = { kind: "daily", time: "07:00" } as const;
		expect(new Date(nextRun(daily, Date.parse("2026-10-06T06:59:00+07:00"), TZ) ?? 0).toISOString()).toBe(
			"2026-10-06T00:00:00.000Z",
		);
		expect(new Date(nextRun(daily, Date.parse("2026-10-06T07:00:00+07:00"), TZ) ?? 0).toISOString()).toBe(
			"2026-10-07T00:00:00.000Z",
		);
		expect(
			new Date(
				nextRun({ kind: "daily", time: "07:00" }, Date.parse("2026-03-08T12:00:00Z"), "America/New_York") ?? 0,
			).toISOString(),
		).toBe("2026-03-09T11:00:00.000Z");
	});

	it("drops a one-off job once its time has passed", () => {
		const at = Date.parse("2026-10-06T09:00:00+07:00");
		expect(nextRun({ kind: "once", at }, at - 1, TZ)).toBe(at);
		expect(nextRun({ kind: "once", at }, at, TZ)).toBeUndefined();
	});
});
