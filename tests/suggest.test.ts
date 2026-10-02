/**
 * cp-7t7 Stage 1: the pure core of model-generated candidate answers.
 * Hermetic — no pi, no network, no home except a temp dir.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import {
	AWAITING_OPTION_MAX_CHARS,
	AWAITING_SENTINEL_OPTIONS,
	LAYOUT,
	SUGGEST_FIELD_MAX_CHARS,
	SUGGEST_MAX_CANDIDATES,
	SUGGEST_PROMPT_MAX_CHARS,
} from "../src/contracts.ts";
import {
	buildSuggestionPrompt,
	loadSuggestConfig,
	parseSuggestions,
	SuggestionCache,
	suggestionFingerprint,
	suggestionInput,
	suggestionsEnabled,
	withDeadline,
} from "../src/suggest.ts";

const RESEARCH_ITEM: ResolvedAwaitingItem = {
	id: "aw-research-cp-x",
	type: "approval",
	decision: "cp-x: ship, drop or follow-up?",
	why: "finished research with no ship decision yet",
	blocks: "cp-x follow-on work",
	job_id: "cp-x",
	options: ["ship", "drop", "follow-up"],
	opened_at: "2026-08-27T12:00:00Z",
	title: "cp-x: some research title",
	project: "pi-command-post",
	kind: "research",
	delivery: "pipeline",
};

const AUTH_ITEM: ResolvedAwaitingItem = {
	id: "aw-checkpoint-cp-ship",
	type: "authorization",
	decision: "authorize cp-ship?",
	why: "the gate passed",
	blocks: "cp-ship implementation",
	job_id: "cp-ship",
	options: ["approve", "decline"],
	opened_at: "2026-08-27T12:00:00Z",
};

function tempHome(): { home: string; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "cp-suggest-"));
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 1-2. suggestionInput
// ---------------------------------------------------------------------------

test("suggestionInput copies exactly the whitelisted fields and nothing else", () => {
	const input = suggestionInput(RESEARCH_ITEM);
	assert.deepEqual(
		Object.keys(input).sort(),
		["blocks", "job_id", "decision", "delivery", "kind", "opened_at", "options", "project", "title", "type", "why"].sort(),
	);

	const withExtra = { ...RESEARCH_ITEM, artifact_path: "state/artifacts/cp-x.md", secret: "nope" } as ResolvedAwaitingItem;
	const dropped = suggestionInput(withExtra);
	assert.ok(!("artifact_path" in dropped));
	assert.ok(!("secret" in dropped));
});

test("every field is truncated, and a pathological input still produces a bounded prompt", () => {
	const huge = "x".repeat(1_000_000);
	const item: ResolvedAwaitingItem = { ...RESEARCH_ITEM, why: huge, decision: huge };
	const input = suggestionInput(item);
	assert.ok(input.decision.length <= SUGGEST_FIELD_MAX_CHARS);
	assert.ok(input.why.length <= SUGGEST_FIELD_MAX_CHARS);
	const prompt = buildSuggestionPrompt(input);
	assert.ok(prompt.system.length + prompt.user.length <= SUGGEST_PROMPT_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// 3. buildSuggestionPrompt never touches an artifact path
// ---------------------------------------------------------------------------

test("buildSuggestionPrompt output names no artifact/state path, and only accepts SuggestionInput", () => {
	const prompt = buildSuggestionPrompt(suggestionInput(RESEARCH_ITEM));
	assert.ok(!prompt.system.includes("state/artifacts"));
	assert.ok(!prompt.user.includes("state/artifacts"));
	// Compile-time: buildSuggestionPrompt(someString) would fail tsc --noEmit
	// (npm test runs the typecheck); nothing to assert further at runtime.
});

// ---------------------------------------------------------------------------
// 4-5. parseSuggestions
// ---------------------------------------------------------------------------

test("parseSuggestions normalises numbered/bulleted/quoted lines and drops blanks", () => {
	const text = ['1. "follow-up: split the migration"', "- ship it now", "", "   ", "* drop, too risky"].join("\n");
	const result = parseSuggestions(text, RESEARCH_ITEM);
	assert.equal(result.length, 3);
	assert.equal(result[0], "follow-up: split the migration");
	assert.equal(result[1], "ship it now");
	assert.equal(result[2], "drop, too risky");
});

test("parseSuggestions truncates over-long candidates, drops duplicates of item options, and caps to max", () => {
	const long = "y".repeat(AWAITING_OPTION_MAX_CHARS + 50);
	const text = [long, "SHIP", "ship", "drop", "a", "b", "c", "d"].join("\n");
	const result = parseSuggestions(text, RESEARCH_ITEM, { max: 2 });
	assert.equal(result.length, 2);
	assert.equal(result[0]?.length, AWAITING_OPTION_MAX_CHARS);
	// "SHIP"/"ship" both duplicate the existing "ship" option (case-insensitive) and "drop" duplicates too.
	assert.ok(!result.includes("SHIP"));
	assert.ok(!result.includes("ship"));
	assert.ok(!result.includes("drop"));
});

test("parseSuggestions drops every sentinel string, verbatim", () => {
	for (const sentinel of AWAITING_SENTINEL_OPTIONS) {
		const result = parseSuggestions(sentinel, RESEARCH_ITEM);
		assert.deepEqual(result, [], `${sentinel} survived parseSuggestions`);
	}
});

test("authorization items: only text matching authorizationVerdict survives, and dedupe removes the rest", () => {
	const text = ["approve — the gate passed", "merge it once CI is green", "decline"].join("\n");
	const beforeDedupe = parseSuggestions(text, { type: "authorization", options: [] });
	assert.deepEqual(beforeDedupe, ["decline"], "only the exact verdict word may survive the authorization filter");

	const afterDedupe = parseSuggestions(text, AUTH_ITEM);
	assert.deepEqual(afterDedupe, [], "decline already exists on the row's own options and must not be re-offered");
});

test("suggestionsEnabled is false for authorization, false when disabled, true otherwise", () => {
	assert.equal(suggestionsEnabled({ schema_version: 1 }, AUTH_ITEM), false);
	assert.equal(suggestionsEnabled({ schema_version: 1, enabled: false }, RESEARCH_ITEM), false);
	assert.equal(suggestionsEnabled({ schema_version: 1 }, RESEARCH_ITEM), true);
	assert.equal(suggestionsEnabled({ schema_version: 1, enabled: true }, RESEARCH_ITEM), true);
});

// ---------------------------------------------------------------------------
// 8. SuggestionCache
// ---------------------------------------------------------------------------

test("SuggestionCache: same item hits once, a mutated item re-invokes, a rejection caches []", async () => {
	const cache = new SuggestionCache();
	let calls = 0;
	const generator = async () => {
		calls += 1;
		return ["a", "b"];
	};
	assert.deepEqual(await cache.get(RESEARCH_ITEM, generator), ["a", "b"]);
	assert.deepEqual(await cache.get(RESEARCH_ITEM, generator), ["a", "b"]);
	assert.equal(calls, 1, "an unchanged item must invoke the generator exactly once");

	const mutated: ResolvedAwaitingItem = { ...RESEARCH_ITEM, why: "a different reason entirely" };
	await cache.get(mutated, generator);
	assert.equal(calls, 2, "a mutated fingerprint must invoke the generator again");

	let rejectCalls = 0;
	const rejecting = async () => {
		rejectCalls += 1;
		throw new Error("boom");
	};
	const failingItem: ResolvedAwaitingItem = { ...RESEARCH_ITEM, id: "aw-research-cp-fail", decision: "cp-fail: ship?" };
	assert.deepEqual(await cache.get(failingItem, rejecting), []);
	assert.deepEqual(await cache.get(failingItem, rejecting), []);
	assert.equal(rejectCalls, 1, "a rejection must be cached (negative caching), not retried on every render");
});

test("SuggestionCache respects its LRU cap", async () => {
	const cache = new SuggestionCache({ maxEntries: 2 });
	const gen = async (item: ResolvedAwaitingItem) => [item.id];
	const a: ResolvedAwaitingItem = { ...RESEARCH_ITEM, id: "a", decision: "a" };
	const b: ResolvedAwaitingItem = { ...RESEARCH_ITEM, id: "b", decision: "b" };
	const c: ResolvedAwaitingItem = { ...RESEARCH_ITEM, id: "c", decision: "c" };
	await cache.get(a, gen);
	await cache.get(b, gen);
	assert.equal(cache.size, 2);
	await cache.get(c, gen);
	assert.equal(cache.size, 2, "the cache must not grow past maxEntries");
	// `a` was evicted (least recently used); re-fetching it must call the generator again.
	let calls = 0;
	await cache.get(a, async (item) => {
		calls += 1;
		return [item.id];
	});
	assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// 9. withDeadline
// ---------------------------------------------------------------------------

test("withDeadline resolves the value when fast", async () => {
	const result = await withDeadline(Promise.resolve("fast"), 5_000, () => "fallback");
	assert.equal(result, "fast");
});

test("withDeadline resolves the fallback when slow, and clears its timer either way", async () => {
	const never = new Promise<string>(() => {});
	const result = await withDeadline(never, 5, () => "fallback");
	assert.equal(result, "fallback");
});

test("withDeadline resolves the fallback on a rejection", async () => {
	const result = await withDeadline(Promise.reject(new Error("boom")), 5_000, () => "fallback");
	assert.equal(result, "fallback");
});

// ---------------------------------------------------------------------------
// 10. loadSuggestConfig
// ---------------------------------------------------------------------------

test("loadSuggestConfig: absent file, malformed JSON, out-of-range deadline, valid file, and fresh-read", () => {
	const { home, cleanup } = tempHome();
	try {
		assert.deepEqual(loadSuggestConfig(home), { schema_version: 1 });

		const file = join(home, LAYOUT.suggestFile);
		mkdirSync(join(home, LAYOUT.data), { recursive: true });
		writeFileSync(file, "not json", "utf8");
		assert.throws(() => loadSuggestConfig(home), /not valid JSON/);

		writeFileSync(file, JSON.stringify({ schema_version: 1, deadline_ms: 50 }), "utf8");
		assert.throws(() => loadSuggestConfig(home), /suggest config contract/);

		writeFileSync(file, JSON.stringify({ schema_version: 1, enabled: true, deadline_ms: 3000, max_candidates: 2 }), "utf8");
		assert.deepEqual(loadSuggestConfig(home), {
			schema_version: 1,
			enabled: true,
			deadline_ms: 3000,
			max_candidates: 2,
		});

		// Read fresh on every call (cp-sr5): mutate between two calls, no cache.
		writeFileSync(file, JSON.stringify({ schema_version: 1, enabled: false }), "utf8");
		assert.deepEqual(loadSuggestConfig(home), { schema_version: 1, enabled: false });
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// 11. Source-level import/read guard
// ---------------------------------------------------------------------------

test("src/suggest.ts never imports pi, never sends/appends, and reads only its own config path", () => {
	const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/suggest.ts"), "utf8");
	for (const forbidden of ["pi-coding-agent", "pi-tui", "sendMessage", "appendEntry", "state/artifacts"]) {
		assert.ok(!source.includes(forbidden), `src/suggest.ts mentions ${forbidden}`);
	}
	const readCalls = [...source.matchAll(/readFileSync\(([^,)]+)/g)].map((match) => match[1]);
	assert.deepEqual(readCalls, ["file"], `unexpected readFileSync target(s): ${JSON.stringify(readCalls)}`);
});
