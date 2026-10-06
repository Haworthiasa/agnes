#!/usr/bin/env node
// Runs the deterministic eval tiers (examples, properties, end-to-end journeys with a scripted model and a
// simulated provider cache) and writes a report. No network and no paid tokens.
//
// Run from packages/bot:
//   node --import ../coding-agent/src/experimental/source-resolver.ts scripts/eval/run-deterministic.ts [--save-baseline] [--compare eval/baselines/deterministic.json]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ZAI_PROFILE } from "../../test/eval/cache-sim.ts";
import { evaluateChecks, type Results } from "../../test/eval/checks.ts";
import { runJourney } from "../../test/eval/harness.ts";
import { JOURNEYS } from "../../test/eval/journeys.ts";
import { evaluateProperties, SEED } from "../../test/eval/properties.ts";
import {
	buildReport,
	compareReports,
	renderComparison,
	renderMarkdown,
	type RunReport,
} from "../../test/eval/report.ts";

const { values: flags } = parseArgs({
	options: { "save-baseline": { type: "boolean", default: false }, compare: { type: "string" } },
});
const botRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: botRoot, encoding: "utf8" }).trim();

const startedAt = new Date();
const results: Results = {};
for (const journey of JOURNEYS) results[journey.id] = await runJourney(journey);
const checks = [...evaluateChecks(results), ...(await evaluateProperties())];
const report = buildReport(
	{
		sha: git("rev-parse", "--short", "HEAD"),
		dirty: git("status", "--porcelain").length > 0,
		tier: "deterministic (examples, properties, journeys)",
		profile: ZAI_PROFILE.name,
		seed: SEED,
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
	},
	checks,
	Object.values(results),
);

const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const dir = join(botRoot, "eval", "results", `${stamp}-${report.meta.sha}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
const markdown = renderMarkdown(report);
writeFileSync(join(dir, "report.md"), markdown);
process.stdout.write(markdown);
process.stdout.write(`\nReport: ${dir}\n`);

if (flags.compare) {
	const before = JSON.parse(readFileSync(resolve(botRoot, flags.compare), "utf8")) as RunReport;
	process.stdout.write(`\n## Comparison with ${flags.compare} (${before.meta.sha})\n\n${renderComparison(compareReports(before, report))}`);
}
if (flags["save-baseline"]) {
	const target = join(botRoot, "eval", "baselines", "deterministic.json");
	writeFileSync(target, `${JSON.stringify(report, null, "\t")}\n`);
	process.stdout.write(`Baseline saved: ${target}\n`);
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
