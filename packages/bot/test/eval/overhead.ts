import { fixedOverheadTokens } from "./guardrails.ts";
import { runJourney } from "./harness.ts";
import { JOURNEYS } from "./journeys.ts";

/**
 * Fixed prompt overhead of the current commit, in tokens: the frozen system prompt of a new chat plus every tool
 * definition. They do not depend on the model, so the scripted tier measures them without a paid call.
 */
export async function measureFixedOverhead(): Promise<number> {
	const journey = JOURNEYS[0];
	if (!journey) throw new Error("The eval has no journeys.");
	const probe = await runJourney(journey);
	return fixedOverheadTokens(probe.sessionPrompts[0] ?? "", probe.toolDefinitions);
}
