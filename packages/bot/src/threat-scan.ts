/**
 * Heuristic scan for prompt-injection and exfiltration text, applied before anything is saved to long-term memory.
 * Saved text goes into the system prompt of every later session, so one poisoned entry would persist.
 *
 * The patterns follow Hermes Agent's `tools/threat_patterns.py` (strict scope), which anchors on unambiguous attack
 * wording and not on bossy English ("you must" is normal in a legitimate note). Vietnamese variants are added, since
 * the bot's users write Vietnamese. This lowers the risk; it is not a security boundary.
 */

/** Hard cap on scanned text, so the worst-case run time stays bounded. */
export const MAX_SCAN_CHARS = 65_536;

// Bounded filler between key words. An unbounded `(?:\w+\s+)*` backtracks badly.
const FILLER = String.raw`(?:\w+\s+){0,8}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const MODIFY = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;

const PATTERNS: Array<[source: string, id: string]> = [
	[String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "prompt_injection"],
	[String.raw`system\s+prompt\s+override`, "sys_prompt_override"],
	[String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "disregard_rules"],
	[
		String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`,
		"bypass_restrictions",
	],
	["<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->", "html_comment_injection"],
	[String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div"],
	[
		String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`,
		"translate_execute",
	],
	[String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "deception_hide"],
	[String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "role_hijack"],
	[String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "role_pretend"],
	[String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "leak_system_prompt"],
	[
		String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`,
		"remove_filters",
	],
	[String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`, "fake_update"],
	[String.raw`\bname\s+yourself\s+\w+`, "identity_override"],
	[String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration"],
	[String.raw`(heartbeat|beacon|check[\s-]?in)\s+(to|with)\s+`, "c2_heartbeat"],
	[String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull"],
	[String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect"],
	[String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action"],
	[String.raw`only\s+use\s+one[\s-]?liners?\b`, "anti_forensic_oneliner"],
	[String.raw`never\s+${FILLER}(?:create|write)\s+${FILLER}(?:script|file)\s+${FILLER}disk`, "anti_forensic_disk"],
	[String.raw`unset\s+\w*(?:CLAUDE|CODEX|AGNES|AGENT|OPENAI|ANTHROPIC)\w*`, "env_var_unset_agent"],
	[String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework"],
	[String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit"],
	[String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long"],
	[String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_curl"],
	[String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_wget"],
	[String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets"],
	[String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, "send_to_url"],
	[
		String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`,
		"context_exfil",
	],
	["authorized_keys", "ssh_backdoor"],
	[
		String.raw`(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME/\.ssh|~/\.ssh)`,
		"ssh_access",
	],
	[String.raw`(?:\$HOME|~)/\.(?:agnes-bot|pi)/[^\s]{0,200}(?:config|auth)\.json`, "agnes_secrets"],
	[String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "agent_config_mod"],
];

// Vietnamese, written without diacritics and applied to diacritic-free text, so "bỏ qua" and "bo qua" both match.
const VIETNAMESE_PATTERNS: Array<[source: string, id: string]> = [
	[
		String.raw`(?:bo\s+qua|phot\s+lo|lo\s+di)\s+${FILLER}(huong\s+dan|chi\s+dan|chi\s+thi|quy\s+tac|luat)`,
		"prompt_injection_vi",
	],
	[String.raw`quen\s+(?:het|moi|tat\s+ca)\s+${FILLER}(huong\s+dan|chi\s+dan|quy\s+tac)`, "forget_rules_vi"],
	[
		String.raw`(?:tiet\s+lo|in\s+ra|hien\s+thi|cho\s+toi\s+xem)\s+${FILLER}(system\s+prompt|prompt\s+he\s+thong|loi\s+nhac\s+he\s+thong)`,
		"leak_system_prompt_vi",
	],
	[String.raw`dung\s+${FILLER}noi\s+${FILLER}(?:voi\s+)?nguoi\s+dung`, "deception_hide_vi"],
];

/** Zero-width, joiner, word-joiner, invisible-operator, BOM and bidirectional control characters. */
const INVISIBLE_CHARS = new Set("​‌‍⁠⁢⁣⁤﻿‪‫‬‭‮⁦⁧⁨⁩");

const COMPILED = PATTERNS.map(([source, id]) => ({ regex: new RegExp(source, "i"), id }));
const COMPILED_VIETNAMESE = VIETNAMESE_PATTERNS.map(([source, id]) => ({ regex: new RegExp(source, "i"), id }));

/** `api_key = "..."` with a long value, unless the value is itself an environment variable name (SHOUTY_SNAKE). */
const HARDCODED_SECRET = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})["']/gi;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Lowercase, no diacritics, `đ` as `d`. */
export function foldVietnamese(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/** Ids of the patterns the text matches; invisible characters are reported as `invisible_unicode_U+XXXX`. */
export function scanForThreats(content: string): string[] {
	if (!content) return [];
	const text = content.slice(0, MAX_SCAN_CHARS);
	// Invisible characters are checked on the raw text: NFKC can drop them.
	const findings = [...new Set(text)]
		.filter((char) => INVISIBLE_CHARS.has(char))
		.map((char) => `invisible_unicode_U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`);
	// NFKC folds full-width and compatibility forms (ｃａｔ to cat). It does not fold look-alike letters from other scripts.
	const normalised = text.normalize("NFKC");
	for (const { regex, id } of COMPILED) if (regex.test(normalised)) findings.push(id);
	const folded = foldVietnamese(normalised);
	for (const { regex, id } of COMPILED_VIETNAMESE) if (regex.test(folded)) findings.push(id);
	for (const match of normalised.matchAll(HARDCODED_SECRET)) {
		if (!ENV_VAR_NAME.test(match[1] as string)) {
			findings.push("hardcoded_secret");
			break;
		}
	}
	return findings;
}

/** An error text for the first threat found, or undefined when the text is clean. */
export function threatMessage(content: string): string | undefined {
	const [first] = scanForThreats(content);
	if (!first) return undefined;
	if (first.startsWith("invisible_unicode_")) {
		return `Blocked: content contains the invisible character ${first.slice("invisible_unicode_".length)} (possible injection).`;
	}
	return `Blocked: content matches threat pattern '${first}'. Content saved to memory enters the system prompt and must not hold injection or exfiltration text.`;
}
