const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/g;

/** Same page despite cosmetic differences: scheme, `www.`, trailing slash, fragment, tracking parameters. */
export function normalizeUrl(raw: string): string {
	try {
		const url = new URL(raw.replace(/[.,;:!?]+$/, ""));
		for (const key of [...url.searchParams.keys()]) {
			if (/^utm_|^(ref|fbclid|gclid)$/.test(key)) url.searchParams.delete(key);
		}
		const query = url.searchParams.toString();
		return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${query ? `?${query}` : ""}`.toLowerCase();
	} catch {
		return raw.toLowerCase();
	}
}

export function urlsIn(text: string): string[] {
	return [...new Set((text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:!?*_]+$/, "")))];
}

/**
 * Removes URLs from a reply that no tool result or user message contained, so the bot never cites a source it
 * did not see. A Markdown link keeps its text; a bare URL goes, and so does a list line left with nothing else.
 */
export function dropUnverifiedUrls(reply: string, seenTexts: string[]): { text: string; dropped: string[] } {
	const seen = new Set(seenTexts.flatMap(urlsIn).map(normalizeUrl));
	const dropped = urlsIn(reply).filter((url) => !seen.has(normalizeUrl(url)));
	if (dropped.length === 0) return { text: reply, dropped };
	const unverified = new Set(dropped);
	const text = reply
		.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (link, label: string, url: string) =>
			unverified.has(url.replace(/[.,;:!?*_]+$/, "")) ? label : link,
		)
		.replace(URL_PATTERN, (match) => {
			const url = match.replace(/[.,;:!?*_]+$/, "");
			return unverified.has(url) ? match.slice(url.length) : match;
		})
		.split("\n")
		.filter((line, index, lines) => {
			const original = reply.split("\n")[index];
			const emptied =
				/^\s*([-*•]|\d+[.)])?\s*[:(\-–]?\s*\)?\s*$/.test(line) && line.trim() !== (original ?? "").trim();
			return !emptied || lines.length === 1;
		})
		.join("\n")
		// Separators and brackets left behind by a removed URL: "(a, )" -> "(a)", "()" -> "".
		.replace(/[,;]\s*(?=[,;)\]])/g, "")
		.replace(/\(\s*([,;]\s*)?\)|\[\s*\]/g, "")
		.replace(/\(\s*[,;]\s*/g, "(")
		.replace(/ +([.,;:])/g, "$1")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text, dropped };
}
