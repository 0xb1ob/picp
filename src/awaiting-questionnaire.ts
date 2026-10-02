/**
 * The Awaiting-you decide UI as a **questionnaire**, not as a stack of
 * one-choice dialogs (cp-vvaz).
 *
 * cp-4864 shipped the rpiv questionnaire as a *shim* behind
 * `driveAwaitingDialog`'s `select`/`input` pair: one overlay per prompt, first
 * for the item list, then for that item's answer menu. On a real pi TUI that
 * turned out to be either invisible (the package could not be resolved, so
 * every prompt silently fell back to `ctx.ui.select` — the old
 * "Awaiting you — pick one to answer (Done to stop) (Ns)" dialog with its
 * countdown) or, at best, a single-tab overlay imitating a select. Neither is
 * the package's own UI, which is a **tabbed** dialog: one tab per question,
 * `Type something.` on every tab, notes, no deadline.
 *
 * So this module is the projection the overlay actually wants: N open items →
 * N questions in **one** call, answered in any order, submitted once.
 *
 *  - **Nothing about answering moves.** The writers
 *    (`resolveAwaitingResponse`, `CheckpointStore.decide`),
 *    `state/awaiting.json`, the sentinels, and "skip writes nothing anywhere"
 *    are exactly what they were. An unanswered tab is a skip; Esc is a skip
 *    for the whole batch; a sentinel can never reach a writer, because it is
 *    compared by identity before anything is resolved.
 *  - **An option string round-trips byte-identically.** The overlay's label
 *    budget is 60 characters and an awaiting option may be 120
 *    (`AWAITING_OPTION_MAX_CHARS`), so a long option is rendered as a
 *    numbered, truncated *label* with the full string as the *description* and
 *    mapped back through an identity map on the way out. A label we never sent
 *    resolves to nothing, never to a guess.
 *  - **What the overlay cannot render is deferred, never dropped.** The
 *    package takes at most 4 questions per call and 2–4 options per question,
 *    and it refuses its own reserved labels. An item that does not fit comes
 *    back in `deferred` with a reason, and the caller answers it with the
 *    plain dialogs in the same sitting.
 *
 * Like `./awaiting-dialog.ts`, every side effect is injected: `ask`, `answer`,
 * `viewPlan`, `suggest`, `notify`. There is no pi here, no terminal and no
 * home, which is why the whole loop is testable.
 */

import {
	AWAITING_DIALOG_MAX_ROUNDS,
	AWAITING_SKIP_OPTION,
	PLAN_VIEW_AGAIN_OPTION,
	PLAN_VIEW_OPTION,
	SUGGEST_DEADLINE_MS,
} from "./contracts.ts";
import type { ResolvedAwaitingItem } from "./awaiting.ts";
import { type AwaitingDialogStep, isAwaitingSentinel } from "./awaiting-dialog.ts";
import { withDeadline } from "./suggest.ts";

// ---------------------------------------------------------------------------
// The package's runtime limits, restated locally
// ---------------------------------------------------------------------------

/** `tool/types.ts` → `MAX_QUESTIONS`: questions per invocation. */
export const QUESTIONNAIRE_MAX_QUESTIONS = 4;
/** `tool/types.ts` → `MIN_OPTIONS` / `MAX_OPTIONS`, per question. */
export const QUESTIONNAIRE_MIN_OPTIONS = 2;
export const QUESTIONNAIRE_MAX_OPTIONS = 4;
export const QUESTIONNAIRE_MAX_LABEL_LENGTH = 60;
export const QUESTIONNAIRE_MAX_HEADER_LENGTH = 16;
/** `state/row-intent.ts` → `RESERVED_LABEL_SET`, plus the CC-parity `"Other"`. */
export const QUESTIONNAIRE_RESERVED_LABELS: ReadonlySet<string> = new Set(["Other", "Type something.", "Next"]);

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

export interface QuestionnaireOption {
	label: string;
	description: string;
}

export interface AwaitingQuestion {
	item: ResolvedAwaitingItem;
	/** The question body: the decision, why it exists, what it blocks, the id. */
	question: string;
	/** The short chip next to the question, bounded by the package's schema. */
	header: string;
	options: QuestionnaireOption[];
	/** Rendered label → the byte-identical original option string. */
	originalByLabel: Map<string, string>;
	/** True when the labels are the originals verbatim (no numbering). */
	verbatim: boolean;
}

/** An item the overlay cannot render, with the reason the operator is told. */
export interface DeferredAwaitingItem {
	item: ResolvedAwaitingItem;
	reason: string;
}

const HEADER_BY_TYPE: Record<string, string> = {
	authorization: "Authorize",
	approval: "Approve",
	design: "Design",
};

function truncate(text: string, budget: number): string {
	if (text.length <= budget) return text;
	return `${text.slice(0, Math.max(1, budget - 1))}\u2026`;
}

/** The chip. Never longer than the schema allows, never empty. */
export function questionHeader(item: Pick<ResolvedAwaitingItem, "type">): string {
	const header = HEADER_BY_TYPE[item.type] ?? "Decide";
	return header.slice(0, QUESTIONNAIRE_MAX_HEADER_LENGTH);
}

/**
 * The question body. The id is part of it on purpose: the package refuses two
 * questions with the same text in one invocation, and two rows about the same
 * decision on different jobs are otherwise indistinguishable — and the
 * operator answers by id everywhere else, so seeing it is a feature.
 */
export function questionBody(
	item: Pick<ResolvedAwaitingItem, "id" | "decision" | "why" | "blocks">,
	options: { planHint?: string; context?: readonly string[] } = {},
): string {
	const lines = [item.decision, `why: ${item.why}`, `blocks: ${item.blocks}`];
	// The details pane (pi-command-post-4mn): already bounded and redacted by
	// `buildDecisionContext`, and part of the *question*, never of the options —
	// so no evidence line can ever be picked as an answer.
	if (options.context && options.context.length > 0) lines.push(...options.context);
	if (options.planHint) lines.push(options.planHint);
	lines.push(`[${item.id}]`);
	return lines.join("\n");
}

/**
 * The option list for one item, in order, capped at `QUESTIONNAIRE_MAX_OPTIONS`:
 *
 *   1. `View the plan…` (or `View the plan again…` once it has been read) —
 *      first while unread, so a stray Enter lands on the non-destructive row,
 *      exactly as `answerMenuOptions` guarantees for the plain menu; last once
 *      read, so Enter never reopens the pager (cp-viewer-scroll-stuck).
 *   2. the item's own options, never reordered and never dropped.
 *   3. generated candidates (cp-7t7), only while there is room.
 *   4. `Skip` — a real row, and the only padding this function will do, so an
 *      item with a single option still satisfies the package's 2-option floor.
 *      It writes nothing, like every other way out.
 *
 * `undefined` means "the overlay cannot render this item": the caller defers it
 * to the plain dialog rather than showing the operator a menu that is not the
 * menu they were offered.
 */
export function questionOptions(
	item: Pick<ResolvedAwaitingItem, "options">,
	state: { planViewable: boolean; planViewed: boolean },
	suggestions: readonly string[] = [],
): string[] | undefined {
	const own = item.options ?? [];
	if (own.length > QUESTIONNAIRE_MAX_OPTIONS) return undefined;
	const labels: string[] = [];
	if (state.planViewable && !state.planViewed && own.length < QUESTIONNAIRE_MAX_OPTIONS) labels.push(PLAN_VIEW_OPTION);
	labels.push(...own);
	// One slot is reserved for `View the plan again…` when it is due, so a
	// candidate can never displace the way back into the pager.
	const reserved = state.planViewable && state.planViewed ? 1 : 0;
	for (const suggestion of suggestions) {
		if (labels.length + reserved >= QUESTIONNAIRE_MAX_OPTIONS) break;
		if (labels.includes(suggestion)) continue;
		labels.push(suggestion);
	}
	if (state.planViewable && state.planViewed && labels.length < QUESTIONNAIRE_MAX_OPTIONS) {
		labels.push(PLAN_VIEW_AGAIN_OPTION);
	}
	if (labels.length < QUESTIONNAIRE_MIN_OPTIONS && labels.length < QUESTIONNAIRE_MAX_OPTIONS) {
		labels.push(AWAITING_SKIP_OPTION);
	}
	if (labels.length < QUESTIONNAIRE_MIN_OPTIONS) return undefined;
	if (new Set(labels).size !== labels.length) return undefined;
	if (labels.some((label) => QUESTIONNAIRE_RESERVED_LABELS.has(label))) return undefined;
	return labels;
}

/**
 * Render a menu as overlay options with an identity map back. A menu whose rows
 * all fit the label budget is passed verbatim; anything longer is numbered and
 * truncated, with the full row as the description. `undefined` means the
 * mapping is not safe (a duplicate or reserved rendered label) — take the
 * plain dialog.
 */
export function renderOptions(
	menu: readonly string[],
): Pick<AwaitingQuestion, "options" | "originalByLabel" | "verbatim"> | undefined {
	const verbatim =
		new Set(menu).size === menu.length && menu.every((option) => option.length <= QUESTIONNAIRE_MAX_LABEL_LENGTH);
	const options: QuestionnaireOption[] = [];
	const originalByLabel = new Map<string, string>();
	for (const [index, option] of menu.entries()) {
		const prefix = `${index + 1}. `;
		const label = verbatim ? option : `${prefix}${truncate(option, QUESTIONNAIRE_MAX_LABEL_LENGTH - prefix.length)}`;
		if (QUESTIONNAIRE_RESERVED_LABELS.has(label) || originalByLabel.has(label)) return undefined;
		originalByLabel.set(label, option);
		options.push({ label, description: verbatim ? "" : option });
	}
	return { options, originalByLabel, verbatim };
}

export interface BuildQuestionsInput {
	items: readonly ResolvedAwaitingItem[];
	planViewable?(item: ResolvedAwaitingItem): boolean;
	planViewed?: ReadonlySet<string>;
	suggestions?: ReadonlyMap<string, readonly string[]>;
	/** Told to the operator when the plan exists but did not fit the 4 options. */
	planHint?(item: ResolvedAwaitingItem): string | undefined;
	/** The decision details pane's lines for one item (pi-command-post-4mn). */
	context?(item: ResolvedAwaitingItem): readonly string[] | undefined;
	maxQuestions?: number;
}

export interface BuildQuestionsResult {
	questions: AwaitingQuestion[];
	deferred: DeferredAwaitingItem[];
}

/**
 * Project open items onto one questionnaire call. At most
 * `maxQuestions` questions come back; everything the overlay cannot render is
 * `deferred` with a reason, and everything past the cap is simply not in this
 * batch (the caller loops).
 */
export function buildAwaitingQuestions(input: BuildQuestionsInput): BuildQuestionsResult {
	const max = input.maxQuestions ?? QUESTIONNAIRE_MAX_QUESTIONS;
	const questions: AwaitingQuestion[] = [];
	const deferred: DeferredAwaitingItem[] = [];
	for (const item of input.items) {
		if (questions.length >= max) break;
		const planViewable = input.planViewable?.(item) ?? false;
		const planViewed = input.planViewed?.has(item.id) ?? false;
		const menu = questionOptions(item, { planViewable, planViewed }, input.suggestions?.get(item.id) ?? []);
		if (!menu) {
			deferred.push({
				item,
				reason:
					(item.options?.length ?? 0) > QUESTIONNAIRE_MAX_OPTIONS
						? `${item.options?.length} options; the overlay renders at most ${QUESTIONNAIRE_MAX_OPTIONS}`
						: `fewer than ${QUESTIONNAIRE_MIN_OPTIONS} options the overlay can render`,
			});
			continue;
		}
		const rendered = renderOptions(menu);
		if (!rendered) {
			deferred.push({ item, reason: "its options cannot be rendered unambiguously" });
			continue;
		}
		const planOffered = menu.includes(PLAN_VIEW_OPTION) || menu.includes(PLAN_VIEW_AGAIN_OPTION);
		const planHint = planViewable && !planOffered ? input.planHint?.(item) : undefined;
		const context = input.context?.(item);
		questions.push({
			item,
			question: questionBody(item, {
				...(planHint ? { planHint } : {}),
				...(context && context.length > 0 ? { context } : {}),
			}),
			header: questionHeader(item),
			...rendered,
		});
	}
	return { questions, deferred };
}

// ---------------------------------------------------------------------------
// What one submitted questionnaire says
// ---------------------------------------------------------------------------

export type QuestionnaireAnswer =
	/** The operator picked a row; `label` is the original option string. */
	| { kind: "option"; label: string }
	/** The operator typed into the package's own `Type something.` row. */
	| { kind: "custom"; text: string }
	/** That tab was left alone. A skip: it writes nothing. */
	| { kind: "none" };

export type AskQuestionnaireOutcome =
	/** One entry per question, in the order they were asked. */
	| { kind: "answers"; answers: QuestionnaireAnswer[] }
	/** Esc: the whole batch is a skip, and nothing is written. */
	| { kind: "cancelled" }
	/** The overlay cannot serve this batch at all — use the plain dialogs. */
	| { kind: "unavailable"; reason: string };

export interface AwaitingQuestionnaireDeps {
	/** The merged, render-ready set. Called again after every submit. */
	snapshot(): Promise<ResolvedAwaitingItem[]> | ResolvedAwaitingItem[];
	/** Run one questionnaire. The only pi-dependent step. */
	ask(questions: AwaitingQuestion[]): Promise<AskQuestionnaireOutcome>;
	/** Record an answer. Throws to mean "not recorded"; `note` means note-only. */
	answer(item: ResolvedAwaitingItem, value: string): Promise<{ note?: string } | void>;
	planViewable?(item: ResolvedAwaitingItem): boolean;
	viewPlan?(item: ResolvedAwaitingItem): Promise<void>;
	planHint?(item: ResolvedAwaitingItem): string | undefined;
	/** The decision details pane's lines for one item (pi-command-post-4mn). */
	context?(item: ResolvedAwaitingItem): readonly string[] | undefined;
	suggest?(item: ResolvedAwaitingItem): Promise<string[]> | string[];
	suggestDeadlineMs?: number;
	notify?(text: string, level: "info" | "error" | "warning"): void;
	announceEmpty?: boolean;
	maxRounds?: number;
	maxQuestions?: number;
}

export type AwaitingQuestionnaireReason =
	| "empty"
	| "done"
	| "cancelled"
	| "unavailable"
	| "error"
	| "exhausted";

export interface AwaitingQuestionnaireOutcome {
	reason: AwaitingQuestionnaireReason;
	steps: AwaitingDialogStep[];
	/** The last batch the operator was shown. */
	offered: ResolvedAwaitingItem[];
	/** Items the overlay could not render: the caller answers them plainly. */
	deferred: DeferredAwaitingItem[];
	/** Present for `error` and `unavailable`. */
	message?: string;
}

async function suggestionsFor(
	items: readonly ResolvedAwaitingItem[],
	deps: AwaitingQuestionnaireDeps,
): Promise<Map<string, readonly string[]>> {
	const out = new Map<string, readonly string[]>();
	if (!deps.suggest) return out;
	const ms = deps.suggestDeadlineMs ?? SUGGEST_DEADLINE_MS;
	for (const item of items) {
		// Authorization rows are never sent to a generator: their answer space is
		// exactly approve/decline, and both are already options.
		if (item.type === "authorization") continue;
		try {
			const candidates = await withDeadline(Promise.resolve(deps.suggest(item)), ms, () => []);
			if (candidates.length > 0) out.set(item.id, candidates);
		} catch {
			// A broken generator is never a broken decision.
		}
	}
	return out;
}

/**
 * Drive the questionnaire to completion. Never throws for an operator-visible
 * reason: a failed snapshot, an unrenderable batch and a refused write all end
 * in an outcome the caller can act on.
 *
 * The loop converges because every item the operator does not answer is
 * *handled* for this run (offered once, left open in the store), and the only
 * thing that re-offers an item is reading its plan.
 */
export async function driveAwaitingQuestionnaire(
	deps: AwaitingQuestionnaireDeps,
): Promise<AwaitingQuestionnaireOutcome> {
	const steps: AwaitingDialogStep[] = [];
	const deferred: DeferredAwaitingItem[] = [];
	const deferredIds = new Set<string>();
	const handled = new Set<string>();
	const planViewed = new Set<string>();
	const maxRounds = deps.maxRounds ?? AWAITING_DIALOG_MAX_ROUNDS;
	let offered: ResolvedAwaitingItem[] = [];

	for (let round = 0; round < maxRounds; round += 1) {
		let items: ResolvedAwaitingItem[];
		try {
			items = await deps.snapshot();
		} catch (error) {
			const message = (error as Error).message;
			deps.notify?.(message, "error");
			return { reason: "error", steps, offered, deferred, message };
		}
		if (items.length === 0) {
			if (deps.announceEmpty && round === 0) deps.notify?.("Awaiting you: none", "info");
			return { reason: round === 0 ? "empty" : "done", steps, offered, deferred };
		}
		const open = items.filter((item) => !handled.has(item.id) && !deferredIds.has(item.id));
		if (open.length === 0) return { reason: "done", steps, offered, deferred };

		const suggestions = await suggestionsFor(open.slice(0, deps.maxQuestions ?? QUESTIONNAIRE_MAX_QUESTIONS), deps);
		const built = buildAwaitingQuestions({
			items: open,
			...(deps.planViewable ? { planViewable: deps.planViewable } : {}),
			planViewed,
			suggestions,
			...(deps.planHint ? { planHint: deps.planHint } : {}),
			...(deps.context ? { context: deps.context } : {}),
			...(deps.maxQuestions !== undefined ? { maxQuestions: deps.maxQuestions } : {}),
		});
		for (const entry of built.deferred) {
			if (deferredIds.has(entry.item.id)) continue;
			deferredIds.add(entry.item.id);
			deferred.push(entry);
		}
		if (built.questions.length === 0) return { reason: "done", steps, offered, deferred };

		offered = built.questions.map((question) => question.item);
		const outcome = await deps.ask(built.questions);
		if (outcome.kind === "unavailable") {
			return { reason: "unavailable", steps, offered, deferred, message: outcome.reason };
		}
		if (outcome.kind === "cancelled") {
			// Esc: every tab in this batch is a skip, and nothing is written.
			for (const question of built.questions) {
				handled.add(question.item.id);
				steps.push({ kind: "skipped", id: question.item.id });
			}
			return { reason: "cancelled", steps, offered, deferred };
		}

		let progressed = false;
		for (const [index, question] of built.questions.entries()) {
			const item = question.item;
			const answer = outcome.answers[index] ?? { kind: "none" as const };
			if (answer.kind === "none") {
				handled.add(item.id);
				steps.push({ kind: "skipped", id: item.id });
				continue;
			}
			// A label we never sent cannot be resolved to an option, and guessing
			// would be an answer nobody gave: it is a skip.
			const value = answer.kind === "custom" ? answer.text.trim() : (question.originalByLabel.get(answer.label) ?? "");
			if (value.length === 0) {
				handled.add(item.id);
				steps.push({ kind: "skipped", id: item.id });
				continue;
			}
			// Reading the plan is a step, never an answer: the item stays open and
			// is re-offered in the next round with `View the plan again…` last.
			if (value === PLAN_VIEW_OPTION || value === PLAN_VIEW_AGAIN_OPTION) {
				planViewed.add(item.id);
				steps.push({ kind: "viewed", id: item.id });
				progressed = true;
				try {
					await deps.viewPlan?.(item);
				} catch (error) {
					deps.notify?.((error as Error).message, "error");
				}
				continue;
			}
			// Defensive: no sentinel may ever reach a writer, even a future one this
			// loop does not know about.
			if (isAwaitingSentinel(value)) {
				handled.add(item.id);
				steps.push({ kind: "skipped", id: item.id });
				continue;
			}
			handled.add(item.id);
			progressed = true;
			try {
				const result = (await deps.answer(item, value)) ?? {};
				if (result.note) {
					deps.notify?.(`noted on ${item.id}; that is not approve/decline, so the checkpoint stays pending`, "warning");
					steps.push({ kind: "noted", id: item.id, value });
				} else {
					deps.notify?.(`${item.id} answered: ${value}`, "info");
					steps.push({ kind: "answered", id: item.id, value });
				}
			} catch (error) {
				const message = (error as Error).message;
				deps.notify?.(message, "error");
				steps.push({ kind: "failed", id: item.id, message });
			}
		}
		if (!progressed) return { reason: "done", steps, offered, deferred };
	}
	return { reason: "exhausted", steps, offered, deferred };
}
