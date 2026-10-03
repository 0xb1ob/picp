// Negation spans up to three words, except `not`/`without` keep the narrower
// gerund/safety-verb rule. Negating `wait` does not negate the awaited action.
// "stop advising/recommending/suggesting/telling" negates what follows (riskkw-f10).
// Credential nouns may share negation ("secrets or tokens"). `benignSenseAt`
// drops LLM/design `tokens` and a delete/backfill identifier, step or quoted
// mention (riskkw-f10), plus spend `tokens`, "Migration: none" and a read-only audit's history-rewrite fix (cp-wkv1).
// ponytail: bounded clause patterns, not a grammar parser; see docs/contracts.md.
const NEGATION_TAIL_RE = /\b(?:(?:do\s+not|must\s+not|don't|no|never|stop\s+(?:advising|recommending|suggesting|telling))(?!\W+wait\b)(?:\W+[\w'-]+){0,3}|(?:not|without)(?:\W+(?:[\w'-]+ing|expose|touch|change|modify|reveal|leak))?(?:\W+(?:the|a|an|any))?)\W*$/i;
const CLAUSE_BREAK_RE = /[.;:!?,\n]|\b(but|and|then|instead|however)\b/gi;

export function negatedAt(text: string, index: number, word: string): boolean {
	let before = text.slice(0, index);
	if (/^(secrets?|credentials?|tokens?|permissions?|password)$/i.test(word)) {
		before = before.replace(/\b(secrets?|credentials?|tokens?|permissions?|password)\s+or\s+$/i, "");
	}
	let start = 0;
	for (const brk of before.matchAll(CLAUSE_BREAK_RE)) start = (brk.index ?? 0) + brk[0].length;
	// Default to a new clause, not a verb allowlist that can hide an unknown action.
	for (const brk of before.matchAll(/\bor\b/gi)) {
		const end = (brk.index ?? 0) + brk[0].length;
		// ponytail: recognize migration noun modifiers; unfamiliar coordination over-warns.
		if (/^migrations?$/i.test(word) && /^\s+(schema|data|database)\s+$/i.test(before.slice(end))) continue;
		start = Math.max(start, end);
	}
	return NEGATION_TAIL_RE.test(before.slice(start));
}

// riskkw-f10: senses of a risk word that are not the risky act (bounded patterns, not a parser; docs/contracts.md).
const CREDENTIAL_QUALIFIER_RE = /\b(?:api|access|auth|bearer|refresh|session|oauth|jwt|github|gh|npm|deploy|personal|leaked|secret|signing|csrf|webhook|bot)[\s-]+$/i;
const TOKEN_USAGE_BEFORE_RE = /(?:\b(?:context(?:[- ]window)?|non-?cached|cached|uncached|input|output|prompt|completion|reasoning|thinking|colou?r|design|css|theme|estimat(?:e[ds]?|ing)(?:\s+the)?)|(?:\d[\d,]*(?:\.\d+)?\s*[kmb]|\d{1,3}(?:,\d{3})+|\d{4,})(?:\s+[a-z][\w-]*)?)[\s-]+$/i;
const TOKEN_USAGE_AFTER_RE = /^[\s-]+(?:caps?|ceilings?|budgets?|counts?|limits?|usage|spend|windows?|per|used|totals?|accounting|(?:[\w'-]+\s+){0,2}in\s+(?:the\s+)?context)\b/i;
// cp-wkv1: `tokens` coordinated with money/spend (`usd, tokens`, `cost/tokens`, `spend.tokens`, `tokens and $`).
const TOKEN_SPEND_BEFORE_RE = /(?:\$|\b(?:usd|cost|spend(?:_cap)?))\s*(?:[,/.]|\band)\s*$/i;
const TOKEN_SPEND_AFTER_RE = /^\s*(?:[,/]|and)\s*(?:\$(?![\w{])|(?:usd|cost)\b)/i;
// cp-wkv1: "Migration: none" / "migration: n/a" says there is no migration.
const MIGRATION_NONE_AFTER_RE = /^(?:\*\*|__|`)?\s*[:=\u2014-]?\s*(?:\*\*|__)?\s*(?:none|n\/a)\b(?!\s+of\b)/i;
// cp-wkv1: a history rewrite named only as one option of a remedy list (`fix (delete/redact/rewrite history)`) in a
// purely advisory read-only audit/answer: a text that also sequences or applies an action keeps it as evidence.
const REMEDY_LIST_BEFORE_RE = /\b(?:fix(?:es)?|remed(?:y|ies)|recommend(?:ed|ations?)?)\s*[:(]?\s*(?:[\w-]+\/)+$/i;
const READ_ONLY_AUDIT_RE = /\bread[- ]only\s+(?:[\w-]+\s+){0,2}(?:audit|review|answer|report)s?\b/i;
const ACTION_CUE_RE = /\b(?:then|first|next|afterwards|apply|applies|applied|run|execute|perform|push(?:es|ed)?|on\s+(?:main|master|trunk))\b/i;
const STEP_NOUN_AFTER_RE = /^\s+(?:failures?|errors?|advice|warning|message|wording)\b/i;
const MENTION_VERB_RE = /\b(?:calls?|called|says?|said|prints?|printed|reports?|reported|warns?|warned|advises?|advised|claims?|claimed|labels?|labell?ed|wording|message|text)\b/i;
const QUOTED_RE = /(^|[\s(\[])(['"\u201c\u2018])(?=\S)(.*?\S)(['"\u201d\u2019])(?=$|[\s.,;:!?)\]])/g;

function quotedMention(text: string, index: number, word: string): boolean {
	const start = text.lastIndexOf("\n", index - 1) + 1;
	const end = text.indexOf("\n", index);
	const line = text.slice(start, end < 0 ? text.length : end);
	const at = index - start;
	for (const quote of line.matchAll(QUOTED_RE)) {
		const open = (quote.index ?? 0) + (quote[1] ?? "").length;
		const close = open + 1 + (quote[3] ?? "").length;
		if (at <= open || at + word.length > close) continue;
		return MENTION_VERB_RE.test(line.slice(0, open).split(/[.!?;]\s/).at(-1) ?? "");
	}
	return false;
}

function identifierAt(text: string, index: number, word: string): boolean {
	const before = text.slice(0, index);
	const after = text.slice(index + word.length);
	if (/\w\/$/.test(before) || (/\w\.$/.test(before) && /^[a-z]/.test(word)) || /^[./]\w/.test(after)) return true;
	const token = (/[\w-]*$/.exec(before)?.[0] ?? "") + word + (/^[\w-]*/.exec(after)?.[0] ?? "");
	return token.split("-").filter(Boolean).length >= 3;
}

/** A match that names LLM/design/spend tokens, "Migration: none", a remedy option in a read-only audit, or a delete/backfill identifier, step or quoted mention: not risk evidence. */
export function benignSenseAt(text: string, index: number, word: string): boolean {
	const before = text.slice(0, index);
	const after = text.slice(index + word.length);
	if (/^tokens?$/i.test(word)) return !CREDENTIAL_QUALIFIER_RE.test(before) && (TOKEN_USAGE_BEFORE_RE.test(before) || TOKEN_USAGE_AFTER_RE.test(after) || TOKEN_SPEND_BEFORE_RE.test(before) || TOKEN_SPEND_AFTER_RE.test(after));
	if (/^migrat/i.test(word)) return MIGRATION_NONE_AFTER_RE.test(after);
	if (/histor/i.test(word)) return REMEDY_LIST_BEFORE_RE.test(before.slice(-200)) && READ_ONLY_AUDIT_RE.test(text) && !ACTION_CUE_RE.test(text);
	if (!/^(?:backfill|delete)$/i.test(word)) return false;
	return identifierAt(text, index, word) || STEP_NOUN_AFTER_RE.test(after) || quotedMention(text, index, word);
}
