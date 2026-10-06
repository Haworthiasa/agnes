import fc from "fast-check";
import { beforeAll, describe, it } from "vitest";
import { CHECKS, type Results } from "./eval/checks.ts";
import { runJourney } from "./eval/harness.ts";
import { JOURNEYS } from "./eval/journeys.ts";
import { NUM_RUNS, PROPERTIES, SEED } from "./eval/properties.ts";

// A check or property marked `expectFail` describes a behavior a later PR builds. It must fail until then.
// When that PR lands, remove the flag in test/eval/checks.ts or test/eval/properties.ts.

describe("end-to-end journeys", () => {
	const results: Results = {};
	beforeAll(async () => {
		for (const journey of JOURNEYS) results[journey.id] = await runJourney(journey);
	});

	for (const check of CHECKS) {
		const run = () => check.run(results);
		if (check.expectFail) it.fails(`${check.name} (builds in ${check.expectFail})`, run);
		else it(check.name, run);
	}
});

describe("properties", () => {
	for (const { name, expectFail, property } of PROPERTIES) {
		const run = async () => {
			await fc.assert(property, { seed: SEED, numRuns: NUM_RUNS });
		};
		if (expectFail) it.fails(`${name} (builds in ${expectFail})`, run);
		else it(name, run);
	}
});
