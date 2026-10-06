import { type Message, normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CACHE_BLOCK_TOKENS, CacheSimulator, IN_PLACE_PROFILE, ZAI_PROFILE } from "./eval/cache-sim.ts";

const long = (label: string) => `${label} `.repeat(120);
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const system = (text: string): Message => ({
	role: "system",
	content: text,
	sections: { preamble: text },
	timestamp: 1,
});
const context = (prompt: string, ...messages: Message[]) => normalizeContext({ systemPrompt: prompt, messages });

describe("cache simulator", () => {
	it("caches nothing on the first request", () => {
		const simulator = new CacheSimulator(ZAI_PROFILE);
		expect(simulator.record("s", context(long("persona"), user("hi")), "p").cachedTokens).toBe(0);
	});

	it("reuses the whole earlier request when a turn only appends messages", () => {
		const simulator = new CacheSimulator(ZAI_PROFILE);
		simulator.record("s", context(long("persona"), user(long("one"))), "p");
		const second = simulator.record("s", context(long("persona"), user(long("one")), user(long("two"))), "p");
		expect(second.cachedTokens).toBeGreaterThan(0);
		expect(second.cachedTokens % CACHE_BLOCK_TOKENS).toBe(0);
		expect(second.cachedTokens).toBeLessThanOrEqual(second.promptTokens);
		expect(simulator.prefixBreaks).toEqual([]);
	});

	it("loses the cache after the head when zai collapses a changed prompt", () => {
		const simulator = new CacheSimulator(ZAI_PROFILE);
		const history = [user(long("one")), user(long("two")), user(long("three"))];
		simulator.record("s", context("persona A", ...history.slice(0, 2)), "p");
		const next = simulator.record("s", context("persona A", ...history, system("persona B")), "p");
		// The collapsed head now reads persona B, so almost nothing matches the earlier request.
		expect(next.cachedTokens).toBeLessThan(CACHE_BLOCK_TOKENS);
		expect(simulator.prefixBreaks).toHaveLength(1);
	});

	it("keeps the cache when the provider accepts a system message in place", () => {
		const simulator = new CacheSimulator(IN_PLACE_PROFILE);
		const history = [user(long("one")), user(long("two"))];
		simulator.record("s", context("persona A", ...history), "p");
		const next = simulator.record("s", context("persona A", ...history, system("persona B")), "p");
		expect(next.cachedTokens).toBeGreaterThan(0);
		expect(simulator.prefixBreaks).toEqual([]);
	});

	it("shares a common head across sessions", () => {
		const simulator = new CacheSimulator(ZAI_PROFILE);
		simulator.record("a", context(long("persona"), user("x")), "p");
		expect(simulator.record("b", context(long("persona"), user("y")), "p").cachedTokens).toBeGreaterThan(0);
	});
});
