import type { Bot } from "../../src/bot.ts";
import type { IncomingFile } from "../../src/types.ts";
import type { FakeTransport } from "../helpers.ts";
import type { Journey, Step } from "./journeys.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function photo(): IncomingFile {
	return { name: "photo.png", mimeType: "image/png", download: async () => PNG };
}

export interface DriveEnv {
	/** Starts a bot on the run's data directory. Called again for each `restart` step. */
	start(): Bot;
	transport: FakeTransport;
	clock: { now: number };
}

export interface TurnInfo {
	index: number;
	step: Step;
	/** Everything the bot sent during the step. */
	reply: string;
	wallMs: number;
	/** The injected clock when the step ran, after `advanceMs`. */
	clockMs: number;
}

/**
 * Plays a journey through the real bot: moves the injected clock, sends each step the way Telegram would,
 * restarts the bot on request and fires due jobs. `snapshot` runs before each step and `finish` after it,
 * so a caller can measure what the step changed.
 */
export async function drive<TBefore, TTurn>(
	journey: Journey,
	env: DriveEnv,
	snapshot: () => TBefore,
	finish: (before: TBefore, info: TurnInfo) => TTurn,
): Promise<TTurn[]> {
	let bot = env.start();
	const turns: TTurn[] = [];
	try {
		for (const [index, step] of journey.steps.entries()) {
			env.clock.now += step.advanceMs ?? 0;
			const before = snapshot();
			const sent = env.transport.order.length;
			const startedAt = performance.now();
			if (step.kind === "say") {
				await bot.gateway.handle({
					chatId: step.chat,
					userId: step.user,
					text: step.text,
					...(step.image ? { file: photo() } : {}),
				});
			} else if (step.kind === "new") {
				await bot.gateway.handle({ chatId: step.chat, userId: step.user, text: "/new" });
			} else if (step.kind === "restart") {
				bot.gateway.dispose();
				bot = env.start();
			} else {
				await bot.scheduler.tick();
			}
			turns.push(
				finish(before, {
					index,
					step,
					reply: env.transport.order.slice(sent).join("\n"),
					wallMs: performance.now() - startedAt,
					clockMs: env.clock.now,
				}),
			);
		}
	} finally {
		bot.gateway.dispose();
	}
	return turns;
}
