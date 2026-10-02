/**
 * The pi-facing half of cp-7t7 (Constraints §C1, mirroring the plan-view.ts /
 * plan-viewer.ts split): the one-shot model call that produces candidate
 * answers, wired nowhere `src/` can see it.
 *
 * `src/` never imports pi (`src/command-post.ts:1-12`); the pure core
 * (`src/suggest.ts`) defines its own closed input type and never touches a
 * model registry. This file is the only place that turns a `SuggestionInput`
 * into an actual `ModelRegistry.complete` call — a **separate, one-shot
 * request with its own `Context` object**, never the parent's own session:
 * no message is appended to the transcript, and no tool call is involved
 * (Constraints §I2b). The generator never receives `pi: ExtensionAPI`, only a
 * registry, a config/model resolver and a notifier, so
 * `sendMessage`/`appendEntry` are not in scope by construction — the same
 * unreachable-by-construction argument `openPlanViewer` uses for the plan
 * pager.
 *
 * The allowlist/probe resolution itself is `CommandPost.suggestionModel()`
 * (`src/command-post.ts`), so this file stays a thin adapter: policy in,
 * one HTTP-shaped call out.
 *
 * Every failure path here returns `[]`: suggestions disabled, no resolved
 * model, a missing registry, a rejected call, or a deadline that fires first.
 * The dialog must never block on the model (Constraints §I5), so this
 * function never throws.
 */

import { contentText } from "@earendil-works/pi-ai";
import type { ResolvedAwaitingItem } from "../../src/awaiting.ts";
import { SUGGEST_DEADLINE_MS, SUGGEST_MAX_OUTPUT_TOKENS, type SuggestConfig } from "../../src/contracts.ts";
import { type PiModelRegistryLike, splitModelRef } from "../../src/routing.ts";
import { buildSuggestionPrompt, parseSuggestions, suggestionInput, suggestionsEnabled } from "../../src/suggest.ts";

/**
 * Structural view of pi's `ctx.modelRegistry`, extended with the one-shot
 * `complete` call routing's own `PiModelRegistryLike` does not need. No import
 * of pi's real `ModelRegistry` type: a real registry object satisfies this by
 * shape, same discipline as `routing.ts`'s own comment on the narrower type.
 */
export interface SuggestModelRegistryLike extends PiModelRegistryLike {
	complete(
		model: { id?: string; provider?: string },
		context: { systemPrompt?: string; messages: Array<{ role: "user"; content: string }> },
		options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
	): Promise<{ content: unknown }>;
}

export interface CreateSuggestionGeneratorOptions {
	/** `ctx.modelRegistry`, or `undefined` in a context that never has one. */
	registry: SuggestModelRegistryLike | undefined;
	/** `data/suggest.json`, re-read per call by the caller (cp-sr5's rule). */
	config(): SuggestConfig;
	/**
	 * The resolved model ref, or `undefined` when suggestions are disabled, the
	 * model is not allowlisted, or the probe refuses it \u2014
	 * `CommandPost.suggestionModel()`.
	 */
	resolveModel(): string | undefined;
	/** Best-effort diagnostics only \u2014 never load-bearing, never a body. */
	notify?: (text: string, level: "info" | "error" | "warning") => void;
}

/**
 * Build the injected `suggest` dependency `driveAwaitingDialog` calls.
 * Everything operator-editable (`config()`, `resolveModel()`) is re-resolved
 * on every call: an edit to `data/suggest.json` or `data/routing.json` must
 * take effect on the very next dialog, with no parent restart.
 */
export function createSuggestionGenerator(
	options: CreateSuggestionGeneratorOptions,
): (item: ResolvedAwaitingItem) => Promise<string[]> {
	return async (item: ResolvedAwaitingItem): Promise<string[]> => {
		let config: SuggestConfig;
		let modelRef: string | undefined;
		try {
			config = options.config();
			modelRef = options.resolveModel();
		} catch (error) {
			options.notify?.((error as Error).message, "warning");
			return [];
		}
		if (!suggestionsEnabled(config, item)) return [];

		const registry = options.registry;
		if (!registry) return [];

		if (!modelRef) return [];
		const parts = splitModelRef(modelRef);
		if (!parts) return [];
		const model = registry.find(parts.provider, parts.modelId);
		if (!model) return [];

		const maxCandidates = config.max_candidates;
		const prompt = buildSuggestionPrompt(suggestionInput(item), maxCandidates ? { maxCandidates } : {});
		const deadlineMs = config.deadline_ms ?? SUGGEST_DEADLINE_MS;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), deadlineMs);
		try {
			const message = await registry.complete(
				model,
				{ systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user }] },
				{ signal: controller.signal, maxTokens: SUGGEST_MAX_OUTPUT_TOKENS, temperature: 0 },
			);
			const text = contentText(message.content as never);
			return parseSuggestions(text, item, maxCandidates ? { max: maxCandidates } : {});
		} catch (error) {
			options.notify?.(`suggestion generation failed: ${(error as Error).message}`, "warning");
			return [];
		} finally {
			clearTimeout(timer);
		}
	};
}
