import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Resolves a hostname to every address it points at. */
export type Resolve = (hostname: string) => Promise<string[]>;

const MAX_REDIRECTS = 5;

export const USER_AGENT = "Mozilla/5.0 (compatible; agnes-bot)";

export function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

// Loopback, private, link-local (cloud metadata), carrier-grade NAT, benchmark, multicast and reserved ranges.
const NON_PUBLIC = new BlockList();
for (const [network, prefix, family] of [
	["0.0.0.0", 8, "ipv4"],
	["10.0.0.0", 8, "ipv4"],
	["100.64.0.0", 10, "ipv4"],
	["127.0.0.0", 8, "ipv4"],
	["169.254.0.0", 16, "ipv4"],
	["172.16.0.0", 12, "ipv4"],
	["192.0.0.0", 24, "ipv4"],
	["192.168.0.0", 16, "ipv4"],
	["198.18.0.0", 15, "ipv4"],
	["224.0.0.0", 3, "ipv4"],
	["::", 127, "ipv6"],
	["fc00::", 7, "ipv6"],
	["fe80::", 10, "ipv6"],
	["ff00::", 8, "ipv6"],
] as const) {
	NON_PUBLIC.addSubnet(network, prefix, family);
}

const systemResolve: Resolve = async (hostname) =>
	(await lookup(hostname, { all: true })).map((entry) => entry.address);

export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	// BlockList checks an IPv4-mapped IPv6 address (::ffff:127.0.0.1) against the IPv4 rules too.
	return family !== 0 && !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Throws unless `url` is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(url: URL, resolve: Resolve): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`blocked ${url.protocol} URL`);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : await resolve(host);
	if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
		throw new Error(`blocked non-public address ${url.hostname}`);
	}
}

/**
 * fetch for URLs that a model or a web page chose. Refuses loopback, private and link-local hosts, and checks every
 * redirect hop, so an injected page cannot make the bot read services on this machine or its network. A DNS answer
 * that changes between the check and the connection is not covered.
 */
export function createPublicFetch(fetchFn: typeof fetch = fetch, resolve: Resolve = systemResolve): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		let url = new URL(input instanceof Request ? input.url : input);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			await assertPublicUrl(url, resolve);
			const response = await fetchFn(url, { ...init, redirect: "manual" });
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || !location) return response;
			await response.body?.cancel();
			url = new URL(location, url);
		}
		throw new Error(`more than ${MAX_REDIRECTS} redirects`);
	}) as typeof fetch;
}

export const publicFetch = createPublicFetch();
