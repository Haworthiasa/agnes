import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot.ts";
import { CLOCK_TAG_GAP_MS, clockTag } from "../src/clock.ts";
import { textOf } from "./eval/policy.ts";
import { createFauxRuntime, FakeTransport, type FauxRuntime } from "./helpers.ts";

const OWNER = 7;
const MINUTE = 60_000;
const TZ = "Asia/Ho_Chi_Minh";
const START = Date.parse("2026-10-06T08:00:00+07:00");

describe("clock tag", () => {
	it("stays silent under 30 minutes on the same date and speaks at 30", () => {
		expect(clockTag(START, START + 29 * MINUTE, TZ)).toBeUndefined();
		expect(clockTag(START, START + 30 * MINUTE, TZ)).toMatch(
			/^\[Now: .*Tuesday, 6 October 2026 at 08:30.*\(Asia\/Ho_Chi_Minh\)\]$/,
		);
	});

	it("speaks when the local date changes, even after a short gap", () => {
		const lateNight = Date.parse("2026-10-06T23:50:00+07:00");
		expect(clockTag(lateNight, lateNight + 20 * MINUTE, TZ)).toContain("Wednesday, 7 October 2026");
	});

	it("property: it speaks exactly when the gap is 30 minutes or more, or the local date differs", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 3 * 24 * 60 * 60 }), (gapSeconds) => {
				const now = START + gapSeconds * 1000;
				const dateChanged = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ }) !== "2026-10-06";
				expect(clockTag(START, now, TZ) !== undefined).toBe(gapSeconds * 1000 >= CLOCK_TAG_GAP_MS || dateChanged);
			}),
			{ seed: 3 },
		);
	});
});

describe("prefix cache", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	function startBot(clock: { now: number }) {
		return createBot({
			dataDir: runtime.dataDir,
			modelRuntime: runtime.modelRuntime,
			model: runtime.faux.getModel(),
			transport: new FakeTransport(),
			allowedUserIds: new Set([OWNER]),
			allowShell: false,
			timeZone: TZ,
			webBackends: { search: [], fetch: [] },
			now: () => clock.now,
		});
	}

	it("tells the model the time only after a pause, inside the stored user message", async () => {
		runtime = await createFauxRuntime();
		const lastUser: string[] = [];
		const record = (): FauxResponseFactory => (context) => {
			lastUser.push(textOf(context.messages.findLast((message) => message.role === "user")?.content ?? ""));
			return fauxAssistantMessage("ok");
		};
		runtime.faux.setResponses([record(), record(), record(), record()]);
		const clock = { now: START };
		const { gateway } = startBot(clock);
		for (const advance of [0, 10 * MINUTE, 25 * MINUTE, 30 * MINUTE]) {
			clock.now += advance;
			await gateway.handle({ chatId: OWNER, userId: OWNER, text: "hi" });
		}
		gateway.dispose();
		// 0 and +10 min: no tag. +25 min after that is 35 min since the session start: tag. +30 min later: tag again.
		expect(lastUser[0]).toBe("hi");
		expect(lastUser[1]).toBe("hi");
		expect(lastUser[2]).toMatch(/^\[Now: .*08:35.*\]\nhi$/);
		expect(lastUser[3]).toMatch(/^\[Now: .*09:05.*\]\nhi$/);
	});

	it("keeps one system prompt for the whole session, with the persona before the memory and the start time last", async () => {
		runtime = await createFauxRuntime();
		const prompts: string[] = [];
		runtime.faux.setResponses([
			(context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("a");
			},
			(context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("b");
			},
		]);
		const clock = { now: START };
		const { gateway } = startBot(clock);
		await gateway.handle({ chatId: OWNER, userId: OWNER, text: "one" });
		clock.now += 2 * 60 * MINUTE;
		await gateway.handle({ chatId: OWNER, userId: OWNER, text: "two" });
		gateway.dispose();
		expect(prompts[1]).toBe(prompts[0]);
		expect(prompts[0]).toMatch(/Long-term memory[\s\S]*Session started: .*08:00/);
	});

	it("schedule in_minutes resolves from the bot's clock, whatever time the model believes", async () => {
		runtime = await createFauxRuntime();
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("schedule", { action: "create", prompt: "Uống nước", in_minutes: 10 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Đã đặt."),
		]);
		const clock = { now: START };
		const { gateway } = startBot(clock);
		clock.now += 25 * MINUTE;
		await gateway.handle({ chatId: OWNER, userId: OWNER, text: "Nhắc tôi sau 10 phút" });
		gateway.dispose();
		const jobs = JSON.parse(readFileSync(join(runtime.dataDir, "jobs.json"), "utf8")) as Array<{ nextRunAt: number }>;
		expect(jobs[0]?.nextRunAt).toBe(START + 35 * MINUTE);
	});

	it("rejects in_minutes together with another time, and out of range", async () => {
		runtime = await createFauxRuntime();
		const results: string[] = [];
		const call = (args: Record<string, string | number>) =>
			fauxAssistantMessage([fauxToolCall("schedule", { action: "create", prompt: "p", ...args })], {
				stopReason: "toolUse",
			});
		const after = (context: { messages: Array<{ role: string; content?: unknown }> }) => {
			const last = context.messages.at(-1);
			results.push(textOf((last?.content ?? "") as string));
			return fauxAssistantMessage("done");
		};
		runtime.faux.setResponses([call({ in_minutes: 5, daily_at: "08:00" }), after, call({ in_minutes: 0 }), after]);
		const { gateway } = startBot({ now: START });
		await gateway.handle({ chatId: OWNER, userId: OWNER, text: "a" });
		await gateway.handle({ chatId: OWNER, userId: OWNER, text: "b" });
		gateway.dispose();
		expect(results[0]).toContain("exactly one");
		expect(results[1]).toContain("in_minutes must be from 1");
	});

	it("the memory tool answers with the current entries, since the prompt of the session stays frozen", async () => {
		runtime = await createFauxRuntime();
		const results: string[] = [];
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("memory", { action: "add", target: "user", content: "Thích trà" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				results.push(textOf(context.messages.at(-1)?.content ?? ""));
				return fauxAssistantMessage("ok");
			},
		]);
		const { gateway } = startBot({ now: START });
		await gateway.handle({ chatId: OWNER, userId: OWNER, text: "Hãy nhớ tôi thích trà" });
		gateway.dispose();
		expect(results[0]).toContain("Saved. user: 9/1400 chars");
		expect(results[0]).toContain("- Thích trà");
	});
});
