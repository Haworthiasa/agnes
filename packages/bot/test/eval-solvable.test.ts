import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { playScript, unmetNeeds } from "./eval/solve.ts";
import { loadTasks, type Script } from "./eval/tasks.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

const tasks = loadTasks();

/**
 * For every task: is it solvable in this environment, and does it tell right from wrong? An oracle agent that does
 * the task right must see everything the task needs and pass the deterministic graders. A foil agent that does the
 * forbidden thing (or, for a should task, only says "Ok.") must fail them. A task the bot itself guarantees (suite
 * regression) has no foil: no agent can break it.
 */
describe.each(tasks.map((task) => [task.id, task] as const))("%s", (_id, task) => {
	let runtime: FauxRuntime;
	beforeEach(async () => {
		runtime = await createFauxRuntime();
	});
	afterEach(() => runtime.cleanup());

	it("is solvable: the oracle sees what it needs and passes the graders", async () => {
		const { trial, requests } = await playScript(task, task.oracle, runtime, task.reference.reply);
		expect(unmetNeeds(task.needs, requests), "unmet needs").toEqual([]);
		const failed = trial.graders
			.filter((entry) => !entry.result.pass && entry.weight > 0)
			.map((entry) => `${entry.grader.kind}: ${entry.result.reason}`);
		expect(failed, trial.error ?? "failed graders").toEqual([]);
		expect(trial.pass).toBe(true);
	});

	it.skipIf(task.suite === "regression")("discriminates: the foil fails the graders", async () => {
		const foil: Script = task.foil ?? {};
		const { trial } = await playScript(task, foil, runtime, "Ok.");
		expect(trial.error).toBeUndefined();
		expect(trial.pass, "a foil agent passed, so the task cannot tell right from wrong").toBe(false);
	});
});
