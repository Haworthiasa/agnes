import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, readSavedConfig, savedConfigPath, writeSavedConfig } from "../src/config.ts";
import { ensureSetup, type Prompter } from "../src/setup.ts";
import { createFauxRuntime, type FauxRuntime } from "./helpers.ts";

/** Answers questions in order and records what was asked. */
class ScriptedPrompter implements Prompter {
	readonly asked: string[] = [];
	private readonly answers: string[];

	constructor(answers: string[]) {
		this.answers = answers;
	}

	async text(message: string): Promise<string> {
		this.asked.push(message);
		const answer = this.answers.shift();
		if (answer === undefined) throw new Error(`Unexpected question: ${message}`);
		return answer;
	}

	secret(message: string): Promise<string> {
		return this.text(message);
	}

	print(): void {}
}

describe("saved config", () => {
	let runtime: FauxRuntime;
	afterEach(() => runtime.cleanup());

	it("asks once on the first run, then starts without questions", async () => {
		runtime = await createFauxRuntime();
		const model = runtime.faux.getModel();
		const first = new ScriptedPrompter(["123:abc", "111, 222", `${model.provider}/${model.id}`]);
		const options = { dataDir: runtime.dataDir, env: {}, modelRuntime: runtime.modelRuntime, force: false };

		await ensureSetup({ ...options, prompter: first });
		// The faux provider already has a key, so no API key question.
		expect(first.asked).toHaveLength(3);
		expect(readSavedConfig(runtime.dataDir)).toEqual({
			telegramToken: "123:abc",
			allowedUserIds: [111, 222],
			model: `${model.provider}/${model.id}`,
		});
		expect(statSync(savedConfigPath(runtime.dataDir)).mode & 0o777).toBe(0o600);

		const second = new ScriptedPrompter([]);
		const saved = await ensureSetup({ ...options, prompter: second });
		expect(second.asked).toEqual([]);
		const config = loadConfig({}, saved);
		expect(config.telegramToken).toBe("123:abc");
		expect([...config.allowedUserIds]).toEqual([111, 222]);
	});

	it("re-asks an invalid answer and keeps saved values on --setup", async () => {
		runtime = await createFauxRuntime();
		const model = runtime.faux.getModel();
		writeSavedConfig(runtime.dataDir, { telegramToken: "old", allowedUserIds: [111], model: "x/y" });
		const prompter = new ScriptedPrompter(["", "abc", "", "nope/model", `${model.provider}/${model.id}`]);

		const saved = await ensureSetup({
			dataDir: runtime.dataDir,
			env: {},
			modelRuntime: runtime.modelRuntime,
			prompter,
			force: true,
		});
		expect(prompter.asked).toHaveLength(5);
		expect(saved).toEqual({ telegramToken: "old", allowedUserIds: [111], model: `${model.provider}/${model.id}` });
	});

	it("offers pi's default model on Enter and starts headless from the saved config", async () => {
		runtime = await createFauxRuntime();
		const model = runtime.faux.getModel();
		const options = { dataDir: runtime.dataDir, env: {}, modelRuntime: runtime.modelRuntime, force: false };
		await ensureSetup({
			...options,
			prompter: new ScriptedPrompter(["123:abc", "111", ""]),
			defaultModel: `${model.provider}/${model.id}`,
		});
		expect(readSavedConfig(runtime.dataDir).model).toBe(`${model.provider}/${model.id}`);

		const saved = await ensureSetup({ ...options, prompter: undefined });
		expect(loadConfig({}, saved).model).toBe(`${model.provider}/${model.id}`);
	});

	it("fails with guidance when nobody can answer", async () => {
		runtime = await createFauxRuntime();
		const saved = await ensureSetup({
			dataDir: runtime.dataDir,
			env: {},
			modelRuntime: runtime.modelRuntime,
			prompter: undefined,
			force: false,
		});
		expect(() => loadConfig({}, saved)).toThrow(/npm start/);
	});

	it("lets environment variables override the saved config without rewriting it", async () => {
		runtime = await createFauxRuntime();
		const saved = { telegramToken: "saved", allowedUserIds: [111], model: "zai/glm-5.3-flash" };
		writeSavedConfig(runtime.dataDir, saved);
		const config = loadConfig(
			{ TELEGRAM_BOT_TOKEN: "env", BOT_MODEL: "openai/gpt-5", BOT_ALLOWED_USERS: "333" },
			saved,
		);
		expect(config.telegramToken).toBe("env");
		expect(config.model).toBe("openai/gpt-5");
		expect([...config.allowedUserIds]).toEqual([333]);
		expect(readSavedConfig(runtime.dataDir)).toEqual(saved);
	});
});

describe("data dir inside a git repository", () => {
	let runtime: FauxRuntime;
	let repo: string;
	afterEach(() => {
		runtime.cleanup();
		rmSync(repo, { recursive: true, force: true });
	});

	it("refuses to save secrets there, before asking anything", async () => {
		runtime = await createFauxRuntime();
		repo = mkdtempSync(join(tmpdir(), "pi-bot-repo-"));
		mkdirSync(join(repo, ".git"));
		const dataDir = join(repo, "data");
		expect(() => writeSavedConfig(dataDir, { telegramToken: "secret" })).toThrow(/git repository/);

		const prompter = new ScriptedPrompter(["123:abc"]);
		await expect(
			ensureSetup({ dataDir, env: {}, modelRuntime: runtime.modelRuntime, prompter, force: false }),
		).rejects.toThrow(/git repository/);
		expect(prompter.asked).toEqual([]);
	});
});
