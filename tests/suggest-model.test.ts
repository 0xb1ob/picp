/**
 * cp-7t7 Stage 3, Test Plan C: `createSuggestionGenerator`
 * (`extensions/command-post/suggest-model.ts`) is the one place that actually
 * calls `ModelRegistry.complete`. Everything upstream of it (the dialog's own
 * type gate, `suggestionsEnabled`) is tested elsewhere
 * (`tests/awaiting-dialog.test.ts`, `tests/suggest.test.ts`); this file is the
 * one that proves the adapter itself declines to call a model rather than
 * calling it anyway and discarding the result — the distinction a call-count
 * assertion, not a return-value assertion, actually makes.
 *
 * Driven against a fake registry (`find` / `hasConfiguredAuth` / `complete`),
 * the same structural-fake technique `tests/routing.test.ts` uses for
 * `PiModelRegistryLike`. No pi, no network, no home except a plain in-memory
 * `RoutingConfig`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import { SCHEMA_VERSION, SUGGEST_MAX_OUTPUT_TOKENS, type RoutingConfig, type SuggestConfig } from "../src/contracts.ts";
import { isAllowed, registryProbe } from "../src/routing.ts";
import { buildSuggestionPrompt, suggestionInput } from "../src/suggest.ts";
import { createSuggestionGenerator, type SuggestModelRegistryLike } from "../extensions/command-post/suggest-model.ts";

const RESEARCH_ITEM: ResolvedAwaitingItem = {
	id: "aw-research-cp-x",
	type: "approval",
	decision: "cp-x: ship, drop or follow-up?",
	why: "finished research with no ship decision yet",
	blocks: "cp-x follow-on work",
	job_id: "cp-x",
	options: ["ship", "drop", "follow-up"],
	opened_at: "2026-08-27T12:00:00Z",
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

const ALLOW_ALL: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["*/*"], rubric: [] };
const ALLOW_NOTHING: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: [], rubric: [] };
const BASE_CONFIG: SuggestConfig = { schema_version: SCHEMA_VERSION };

type CompleteCall = {
	model: unknown;
	context: { systemPrompt?: string; messages: Array<{ role: string; content: string }> };
	options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number };
};

/** A registry that knows exactly the models named in `known`, each optionally authed. */
function fakeRegistry(options: {
	known?: Record<string, boolean>;
	complete?: (call: CompleteCall) => Promise<{ content: unknown }>;
}): { registry: SuggestModelRegistryLike; calls: CompleteCall[] } {
	const known = options.known ?? {};
	const calls: CompleteCall[] = [];
	const registry: SuggestModelRegistryLike = {
		find: (provider, modelId) => {
			const key = `${provider}/${modelId}`;
			return key in known ? { id: modelId, provider } : undefined;
		},
		hasConfiguredAuth: (model) => known[`${model.provider}/${model.id}`] ?? false,
		complete: async (model, context, callOptions) => {
			const call: CompleteCall = { model, context, options: callOptions };
			calls.push(call);
			if (options.complete) return options.complete(call);
			return { content: [{ type: "text", text: "" }] };
		},
	};
	return { registry, calls };
}

/** Mirrors `CommandPost.suggestionModel()`: allowlist, then probe, over a real registry. */
function resolveModelVia(routing: RoutingConfig, registry: SuggestModelRegistryLike, modelRef: string): string | undefined {
	if (!isAllowed(routing, modelRef)) return undefined;
	if (!registryProbe(registry).isAvailable(modelRef)) return undefined;
	return modelRef;
}

// ---------------------------------------------------------------------------
// 1. Disallowed model: no complete() call
// ---------------------------------------------------------------------------

test("a model the allowlist refuses never reaches complete()", async () => {
	const { registry, calls } = fakeRegistry({ known: { "mock/haiku": true } });
	const generator = createSuggestionGenerator({
		registry,
		config: () => BASE_CONFIG,
		resolveModel: () => resolveModelVia(ALLOW_NOTHING, registry, "mock/haiku"),
	});
	const result = await generator(RESEARCH_ITEM);
	assert.deepEqual(result, []);
	assert.equal(calls.length, 0, "the allowlist must refuse before any model call is made");
});

// ---------------------------------------------------------------------------
// 2. Unavailable per probe: no complete() call
// ---------------------------------------------------------------------------

test("a model the probe says is unavailable never reaches complete()", async () => {
	// Allowed by policy, but the registry does not know it (unregistered/unauthed):
	// registryProbe.isAvailable is false, so resolveModel must refuse it too.
	const { registry, calls } = fakeRegistry({ known: {} });
	const generator = createSuggestionGenerator({
		registry,
		config: () => BASE_CONFIG,
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	const result = await generator(RESEARCH_ITEM);
	assert.deepEqual(result, []);
	assert.equal(calls.length, 0, "an unavailable model must refuse before any model call is made");
});

// ---------------------------------------------------------------------------
// Authorization items: no model call at all, at this literal adapter
// ---------------------------------------------------------------------------

test("an authorization item never reaches complete(), even with an allowed and available model", async () => {
	const { registry, calls } = fakeRegistry({ known: { "mock/haiku": true } });
	const generator = createSuggestionGenerator({
		registry,
		config: () => BASE_CONFIG,
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	const result = await generator(AUTH_ITEM);
	assert.deepEqual(result, []);
	assert.equal(calls.length, 0, "suggestionsEnabled must refuse an authorization item before any model call");
});

// ---------------------------------------------------------------------------
// 3. complete() rejecting: [] and no throw
// ---------------------------------------------------------------------------

test("complete() rejecting yields [] and never throws out of the generator", async () => {
	const { registry, calls } = fakeRegistry({
		known: { "mock/haiku": true },
		complete: async () => {
			throw new Error("provider unavailable");
		},
	});
	const generator = createSuggestionGenerator({
		registry,
		config: () => BASE_CONFIG,
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	const result = await generator(RESEARCH_ITEM);
	assert.deepEqual(result, []);
	assert.equal(calls.length, 1, "the call was attempted (this is a rejection, not a refusal)");
});

// ---------------------------------------------------------------------------
// 4. complete() returning text: parsed candidates
// ---------------------------------------------------------------------------

test("complete() returning text yields parsed candidates", async () => {
	const { registry } = fakeRegistry({
		known: { "mock/haiku": true },
		complete: async () => ({
			content: [{ type: "text", text: "1. ship it now\n2. follow-up: split the migration" }],
		}),
	});
	const generator = createSuggestionGenerator({
		registry,
		config: () => BASE_CONFIG,
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	const result = await generator(RESEARCH_ITEM);
	assert.deepEqual(result, ["ship it now", "follow-up: split the migration"]);
});

// ---------------------------------------------------------------------------
// 5. Signal aborted at the deadline
// ---------------------------------------------------------------------------

test("the signal passed to complete() is aborted when the deadline passes", async () => {
	let capturedSignal: AbortSignal | undefined;
	const { registry, calls } = fakeRegistry({
		known: { "mock/haiku": true },
		complete: (call) =>
			new Promise((_resolve, reject) => {
				capturedSignal = call.options?.signal;
				call.options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			}),
	});
	const generator = createSuggestionGenerator({
		registry,
		config: () => ({ ...BASE_CONFIG, deadline_ms: 5 }),
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	const result = await generator(RESEARCH_ITEM);
	assert.deepEqual(result, [], "an aborted call must still degrade to [], never throw out");
	assert.equal(calls.length, 1);
	assert.equal(capturedSignal?.aborted, true, "the deadline must actually have fired the abort signal");
});

// ---------------------------------------------------------------------------
// 6. complete() call shape
// ---------------------------------------------------------------------------

test("complete() is called with a bounded maxTokens and a single-message context built from the prompt", async () => {
	let seen: CompleteCall | undefined;
	const { registry } = fakeRegistry({
		known: { "mock/haiku": true },
		complete: async (call) => {
			seen = call;
			return { content: [{ type: "text", text: "" }] };
		},
	});
	const generator = createSuggestionGenerator({
		registry,
		config: () => BASE_CONFIG,
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	await generator(RESEARCH_ITEM);
	assert.ok(seen, "complete() must have been called");
	const expectedPrompt = buildSuggestionPrompt(suggestionInput(RESEARCH_ITEM));
	assert.equal(seen?.context.systemPrompt, expectedPrompt.system);
	assert.equal(seen?.context.messages.length, 1);
	assert.equal(seen?.context.messages[0]?.role, "user");
	assert.equal(seen?.context.messages[0]?.content, expectedPrompt.user);
	assert.ok((seen?.options?.maxTokens ?? Number.POSITIVE_INFINITY) <= SUGGEST_MAX_OUTPUT_TOKENS);
	assert.equal(seen?.options?.temperature, 0);
});

// ---------------------------------------------------------------------------
// Degradation: no registry, disabled config, resolveModel/config throwing
// ---------------------------------------------------------------------------

test("a missing registry, disabled config, and a throwing resolver all degrade to [] with no call", async () => {
	const { registry, calls } = fakeRegistry({ known: { "mock/haiku": true } });

	const noRegistry = createSuggestionGenerator({
		registry: undefined,
		config: () => BASE_CONFIG,
		resolveModel: () => "mock/haiku",
	});
	assert.deepEqual(await noRegistry(RESEARCH_ITEM), []);

	const disabled = createSuggestionGenerator({
		registry,
		config: () => ({ ...BASE_CONFIG, enabled: false }),
		resolveModel: () => resolveModelVia(ALLOW_ALL, registry, "mock/haiku"),
	});
	assert.deepEqual(await disabled(RESEARCH_ITEM), []);

	const throwingConfig = createSuggestionGenerator({
		registry,
		config: () => {
			throw new Error("data/suggest.json is not valid JSON");
		},
		resolveModel: () => "mock/haiku",
	});
	const notices: Array<{ text: string; level: string }> = [];
	const withNotify = createSuggestionGenerator({
		registry,
		config: () => {
			throw new Error("boom");
		},
		resolveModel: () => "mock/haiku",
		notify: (text, level) => notices.push({ text, level }),
	});
	assert.deepEqual(await throwingConfig(RESEARCH_ITEM), []);
	assert.deepEqual(await withNotify(RESEARCH_ITEM), []);
	assert.equal(notices.length, 1);

	assert.equal(calls.length, 0, "none of these paths may ever reach complete()");
});
