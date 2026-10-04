/**
 * Suggested answers (cp-7t7) — the pure core of model-generated candidates for
 * the `/cp-decide` answer menu.
 *
 * This module is inert on its own: nothing calls it yet (Stage 1). It never
 * imports pi, never touches a session, and never reads anything but its own
 * config file (`data/suggest.json`) — exactly the "new, tested, inert" shape
 * `src/diff-review.ts` shipped first. The pi-facing half (the actual model
 * call) was removed with the decide overlay, which was its only caller.
 *
 * The permitted input is a closed type (`SuggestionInput`): a whitelisted
 * projection of an awaiting item plus cheap job metadata already carried on
 * `ResolvedAwaitingItem` (`title`/`project`/`kind`/`delivery`, populated from
 * the status snapshot's own `StatusJob` — no extra br call, no artifact read,
 * no file body, ever, because there is no field in this type to put one in
 * (Constraints §C2). `buildSuggestionPrompt` accepts only `SuggestionInput`,
 * never a string blob, so no caller can smuggle a body past it.
 *
 * `parseSuggestions` is where every invariant that protects the answer menu
 * actually gets enforced on the model's raw text: sentinels are dropped (a
 * model can never mint a second "Skip"), duplicates of the item's own options
 * are dropped, and — belt for invariant 4 — every candidate offered on an
 * `authorization` item is required to already match the same anchored verdict
 * vocabulary the answering path uses (`authorizationVerdict`, exported
 * from `./awaiting.ts`), so a phrase like "approve — the gate passed" (which
 * would resolve to an unwritable *note*, not a verdict) can never be offered
 * as a selectable option. In practice `suggestionsEnabled` refuses to call a
 * model for an authorization item at all (defence in depth, not the only
 * defence).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationVerdict } from "./awaiting.ts";
import type { ResolvedAwaitingItem } from "./awaiting.ts";
import {
	AWAITING_OPTION_MAX_CHARS,
	AWAITING_SENTINEL_OPTIONS,
	LAYOUT,
	SUGGEST_CACHE_MAX_ENTRIES,
	SUGGEST_FIELD_MAX_CHARS,
	SUGGEST_MAX_CANDIDATES,
	SUGGEST_PROMPT_MAX_CHARS,
	type SuggestConfig,
	SuggestConfigSchema,
	DEFAULT_SUGGEST_CONFIG,
	validate,
} from "./contracts.ts";

export class SuggestError extends Error {}

// ---------------------------------------------------------------------------
// The whitelisted input (Constraints §C2)
// ---------------------------------------------------------------------------

/**
 * Every field a generator may ever see, and no others. Adding a field here is
 * a contract change, not a call-site convenience — that is the whole point of
 * closing this type instead of passing the item (or, worse, a string) through.
 */
export interface SuggestionInput {
	type: ResolvedAwaitingItem["type"];
	decision: string;
	why: string;
	blocks: string;
	options?: string[];
	job_id?: string;
	opened_at: string;
	title?: string;
	project?: string;
	kind?: string;
	delivery?: string;
}

function truncateField(value: string): string {
	return value.length > SUGGEST_FIELD_MAX_CHARS ? value.slice(0, SUGGEST_FIELD_MAX_CHARS) : value;
}

/**
 * Project an awaiting item down to `SuggestionInput`: exactly the whitelisted
 * fields, each truncated to `SUGGEST_FIELD_MAX_CHARS`. Any other property the
 * item happens to carry (an artifact path, a diff, anything) is dropped by
 * construction — this builds a fresh object field by field, it never spreads.
 */
export function suggestionInput(item: ResolvedAwaitingItem): SuggestionInput {
	const input: SuggestionInput = {
		type: item.type,
		decision: truncateField(item.decision),
		why: truncateField(item.why),
		blocks: truncateField(item.blocks),
		opened_at: item.opened_at,
	};
	if (item.options && item.options.length > 0) input.options = item.options.map(truncateField);
	if (item.job_id) input.job_id = truncateField(item.job_id);
	if (item.title) input.title = truncateField(item.title);
	if (item.project) input.project = truncateField(item.project);
	if (item.kind) input.kind = truncateField(item.kind);
	if (item.delivery) input.delivery = truncateField(item.delivery);
	return input;
}

/** Stable identity for "has this item changed since we last generated for it?" */
export function suggestionFingerprint(item: ResolvedAwaitingItem): string {
	const json = JSON.stringify(suggestionInput(item));
	return createHash("sha1").update(json).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export interface BuildSuggestionPromptOptions {
	maxCandidates?: number;
}

function suggestionSystemPrompt(maxCandidates: number): string {
	return (
		"You suggest short candidate answers for one pending operator decision in a software delivery fleet. " +
		`Reply with at most ${maxCandidates} candidate answers, one per line, plain text \u2014 no numbering, no bullets, ` +
		"no quotes, no explanation, no preamble. Each candidate must be a complete answer someone could pick as-is, " +
		"not commentary about the decision."
	);
}

/**
 * Build the two halves of the model call. Accepts only `SuggestionInput` — the
 * closed, whitelisted type — so nothing else can reach this function as a
 * prompt source. The whole prompt (system + user) is capped at
 * `SUGGEST_PROMPT_MAX_CHARS` regardless of how large the (already
 * field-truncated) input still adds up to.
 */
export function buildSuggestionPrompt(
	input: SuggestionInput,
	opts: BuildSuggestionPromptOptions = {},
): { system: string; user: string } {
	const maxCandidates = opts.maxCandidates ?? SUGGEST_MAX_CANDIDATES;
	const system = suggestionSystemPrompt(maxCandidates);
	const lines = [`type: ${input.type}`, `decision: ${input.decision}`, `why: ${input.why}`, `blocks: ${input.blocks}`];
	if (input.options && input.options.length > 0) lines.push(`existing options: ${input.options.join(", ")}`);
	if (input.job_id) lines.push(`job_id: ${input.job_id}`);
	lines.push(`opened_at: ${input.opened_at}`);
	if (input.title) lines.push(`title: ${input.title}`);
	if (input.project) lines.push(`project: ${input.project}`);
	if (input.kind) lines.push(`kind: ${input.kind}`);
	if (input.delivery) lines.push(`delivery: ${input.delivery}`);
	let user = lines.join("\n");
	const budget = Math.max(0, SUGGEST_PROMPT_MAX_CHARS - system.length);
	if (user.length > budget) user = user.slice(0, budget);
	return { system, user };
}

// ---------------------------------------------------------------------------
// Parsing the model's reply
// ---------------------------------------------------------------------------

function normalizeCandidateLine(raw: string): string {
	let value = raw.trim();
	value = value.replace(/^[-*\u2022]\s+/, "");
	value = value.replace(/^\d+[.)]\s+/, "");
	value = value.replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, "");
	return value.trim();
}

export interface ParseSuggestionsOptions {
	max?: number;
}

/**
 * Turn raw model text into safe, selectable candidates:
 *
 *  - split into lines, de-bullet/de-number/de-quote, drop blanks;
 *  - truncate to `AWAITING_OPTION_MAX_CHARS` (the same bound `AwaitingItem`
 *    options are stored at);
 *  - drop every `AWAITING_SENTINEL_OPTIONS` string (a model can never mint a
 *    second "Skip" or "Type an answer…");
 *  - drop anything that already matches (case-insensitively) one of the
 *    item's own options, and drop within-batch duplicates;
 *  - on an `authorization` item, drop everything that does not itself match
 *    `authorizationVerdict` — the same anchored vocabulary the resolver uses,
 *    so nothing that would silently become an unwritable note can be offered;
 *  - cap the result to `max` (default `SUGGEST_MAX_CANDIDATES`).
 */
export function parseSuggestions(
	text: string,
	item: Pick<ResolvedAwaitingItem, "type" | "options">,
	opts: ParseSuggestionsOptions = {},
): string[] {
	const max = opts.max ?? SUGGEST_MAX_CANDIDATES;
	const sentinels = new Set(AWAITING_SENTINEL_OPTIONS as readonly string[]);
	const existingLower = new Set((item.options ?? []).map((option) => option.trim().toLowerCase()));
	const seen = new Set<string>();
	const result: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		if (result.length >= max) break;
		const candidate = normalizeCandidateLine(rawLine);
		if (candidate.length === 0) continue;
		if (sentinels.has(candidate)) continue;
		const truncated = candidate.length > AWAITING_OPTION_MAX_CHARS ? candidate.slice(0, AWAITING_OPTION_MAX_CHARS) : candidate;
		if (truncated.length === 0) continue;
		const key = truncated.toLowerCase();
		if (existingLower.has(key) || seen.has(key)) continue;
		if (item.type === "authorization" && authorizationVerdict(truncated) === undefined) continue;
		seen.add(key);
		result.push(truncated);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

/**
 * Race `promise` against `ms`. On timeout (or a rejection), resolve with
 * whatever `onTimeout()` returns rather than throwing or hanging — callers use
 * this to fall back to `[]` (today's exact menu) and, in the model adapter, to
 * abort the in-flight request via the same deadline. The pending timer is
 * always cleared once either side settles.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(onTimeout());
		}, ms);
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(onTimeout());
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Session cache (cost bound: one call per unchanged item per session)
// ---------------------------------------------------------------------------

/**
 * Memoised by `suggestionFingerprint`. Negative caching (an empty result, or a
 * generator that threw) is cached exactly like a positive one, so a broken
 * provider is asked once per item, not once per redraw. Never persisted:
 * session-scoped and LRU-capped at `SUGGEST_CACHE_MAX_ENTRIES`.
 */
export class SuggestionCache {
	readonly #entries = new Map<string, string[]>();
	readonly #order: string[] = [];
	readonly #maxEntries: number;

	constructor(options: { maxEntries?: number } = {}) {
		this.#maxEntries = options.maxEntries ?? SUGGEST_CACHE_MAX_ENTRIES;
	}

	get size(): number {
		return this.#entries.size;
	}

	async get(
		item: ResolvedAwaitingItem,
		generator: (item: ResolvedAwaitingItem) => Promise<string[]> | string[],
	): Promise<string[]> {
		const key = suggestionFingerprint(item);
		const cached = this.#entries.get(key);
		if (cached !== undefined) {
			this.#touch(key);
			return cached;
		}
		let result: string[];
		try {
			result = await generator(item);
		} catch {
			result = [];
		}
		this.#set(key, result);
		return result;
	}

	#touch(key: string): void {
		const at = this.#order.indexOf(key);
		if (at >= 0) this.#order.splice(at, 1);
		this.#order.push(key);
	}

	#set(key: string, value: string[]): void {
		this.#entries.set(key, value);
		this.#touch(key);
		while (this.#order.length > this.#maxEntries) {
			const evicted = this.#order.shift();
			if (evicted !== undefined) this.#entries.delete(evicted);
		}
	}
}

// ---------------------------------------------------------------------------
// Config — data/suggest.json, mirrors data/gate.json's own rule
// ---------------------------------------------------------------------------

/**
 * Read fresh on every call, never cached at construction (cp-sr5: this repo
 * already shipped the cached-config bug once). Absent means "no override
 * configured", not "suggestions off" — `enabled` is the operator's switch.
 */
export function loadSuggestConfig(home: string): SuggestConfig {
	const file = join(home, LAYOUT.suggestFile);
	if (!existsSync(file)) return DEFAULT_SUGGEST_CONFIG;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new SuggestError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess suggestion policy`);
	}
	const result = validate<SuggestConfig>(SuggestConfigSchema, parsed);
	if (!result.ok) {
		throw new SuggestError(`${file} violates the suggest config contract:\n  ${result.errors.join("\n  ")}`);
	}
	return result.value;
}

/**
 * Whether a generator may even be tried for this item. Always false for
 * `authorization`: its answer space is exactly approve/decline, already
 * offered as options, and anything else is unwritable (Constraints §I4) — no
 * model call is made for one, ever, regardless of config.
 */
export function suggestionsEnabled(config: SuggestConfig, item: Pick<ResolvedAwaitingItem, "type">): boolean {
	if (item.type === "authorization") return false;
	return config.enabled !== false;
}
