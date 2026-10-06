import { describe, expect, it } from "vitest";
import { assertPublicUrl, createPublicFetch, isPublicAddress, type Resolve } from "../src/net.ts";

const dns: Record<string, string[]> = {
	"example.com": ["93.184.215.14"],
	"internal.test": ["10.1.2.3"],
	"mixed.test": ["93.184.215.14", "127.0.0.1"],
};
const resolve: Resolve = async (host) => dns[host] ?? [];

describe("isPublicAddress", () => {
	it("rejects loopback, private, link-local and mapped addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.0.0.5",
			"172.20.1.1",
			"192.168.1.10",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"::1",
			"::",
			"fe80::1",
			"fd00::1",
			"::ffff:127.0.0.1",
			"::ffff:a9fe:a9fe",
		]) {
			expect(isPublicAddress(address), address).toBe(false);
		}
		expect(isPublicAddress("93.184.215.14")).toBe(true);
		expect(isPublicAddress("2606:4700::1111")).toBe(true);
	});
});

describe("assertPublicUrl", () => {
	it("allows a public host and blocks private hosts, IP literals and other schemes", async () => {
		await expect(assertPublicUrl(new URL("https://example.com/a"), resolve)).resolves.toBeUndefined();
		await expect(assertPublicUrl(new URL("http://internal.test/"), resolve)).rejects.toThrow(/non-public/);
		await expect(assertPublicUrl(new URL("http://mixed.test/"), resolve)).rejects.toThrow(/non-public/);
		await expect(assertPublicUrl(new URL("http://169.254.169.254/latest"), resolve)).rejects.toThrow(/non-public/);
		await expect(assertPublicUrl(new URL("http://[::1]:8080/"), resolve)).rejects.toThrow(/non-public/);
		await expect(assertPublicUrl(new URL("http://unknown.test/"), resolve)).rejects.toThrow(/non-public/);
		await expect(assertPublicUrl(new URL("file:///etc/passwd"), resolve)).rejects.toThrow(/blocked file:/);
	});
});

describe("createPublicFetch", () => {
	it("follows public redirects and refuses one that points inside the network", async () => {
		const requested: string[] = [];
		const fetchFn = (async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			if (url === "https://example.com/start")
				return new Response(null, { status: 302, headers: { location: "/next" } });
			if (url === "https://example.com/next") return new Response("done");
			if (url === "https://example.com/evil")
				return new Response(null, { status: 301, headers: { location: "http://127.0.0.1:8080/admin" } });
			throw new Error(`unexpected ${url}`);
		}) as typeof fetch;
		const guarded = createPublicFetch(fetchFn, resolve);

		await expect((await guarded("https://example.com/start")).text()).resolves.toBe("done");
		await expect(guarded("https://example.com/evil")).rejects.toThrow(/non-public address 127.0.0.1/);
		expect(requested).toEqual(["https://example.com/start", "https://example.com/next", "https://example.com/evil"]);
	});
});
