export function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation. Zero for fewer than 2 samples. */
export function stdev(values: number[]): number {
	if (values.length < 2) return 0;
	const average = mean(values);
	return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] as number;
}

export type Verdict = "improved" | "regressed" | "no significant change";

/** The smallest sample count per arm for which a live comparison may claim a change. */
export const MIN_LIVE_SAMPLES = 3;

/**
 * Decides whether arm B differs from arm A. A change counts only when the means differ by more than 2 pooled
 * standard deviations and both arms have at least MIN_LIVE_SAMPLES runs. Identical samples with no spread
 * (a deterministic tier) count as a change whenever the means differ.
 */
export function compareSamples(a: number[], b: number[], lowerIsBetter: boolean, deterministic = false): Verdict {
	const difference = mean(b) - mean(a);
	if (difference === 0) return "no significant change";
	if (!deterministic) {
		if (a.length < MIN_LIVE_SAMPLES || b.length < MIN_LIVE_SAMPLES) return "no significant change";
		const pooled = Math.sqrt((stdev(a) ** 2 + stdev(b) ** 2) / 2);
		if (Math.abs(difference) <= 2 * pooled) return "no significant change";
	}
	return difference < 0 === lowerIsBetter ? "improved" : "regressed";
}
