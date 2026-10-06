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

function logChoose(n: number, k: number): number {
	let total = 0;
	for (let index = 1; index <= k; index++) total += Math.log(n - k + index) - Math.log(index);
	return total;
}

/**
 * One-sided Fisher exact test for a drop: the probability that arm B has at most `passesB` passes, given the
 * totals of both arms, if the pass rate were the same. A small value means B passes less often than A.
 */
export function fisherDropP(passesA: number, runsA: number, passesB: number, runsB: number): number {
	const passes = passesA + passesB;
	const total = runsA + runsB;
	let p = 0;
	for (let k = Math.max(0, passes - runsA); k <= Math.min(passesB, runsB, passes); k++) {
		p += Math.exp(logChoose(runsB, k) + logChoose(runsA, passes - k) - logChoose(total, passes));
	}
	return Math.min(1, p);
}
