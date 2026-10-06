/** A pause this long (or a new local date) makes the bot tell the model the time again. */
export const CLOCK_TAG_GAP_MS = 30 * 60_000;

export function formatLocalTime(ms: number, timeZone: string): string {
	return new Date(ms).toLocaleString("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" });
}

function localDate(ms: number, timeZone: string): string {
	return new Date(ms).toLocaleDateString("en-CA", { timeZone });
}

/**
 * The `[Now: ...]` line to put before a user message, or undefined when the model's last clock reading is still
 * good: under 30 minutes old and on the same local date. The tag is stored in the transcript with the message, so
 * the request prefix of later turns stays byte-identical.
 */
export function clockTag(lastSeenMs: number, nowMs: number, timeZone: string): string | undefined {
	const due = nowMs - lastSeenMs >= CLOCK_TAG_GAP_MS || localDate(nowMs, timeZone) !== localDate(lastSeenMs, timeZone);
	return due ? `[Now: ${formatLocalTime(nowMs, timeZone)} (${timeZone})]` : undefined;
}
