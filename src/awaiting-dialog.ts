/**
 * The Awaiting-you dialog's state machine (cp-viewer-scroll-stuck).
 *
 * `/cp-decide` and the `agent_settled` auto-open share one loop: item list →
 * one item's answer menu → an answer, a skip, or a *step* (reading the plan)
 * that records nothing and comes back to the same menu. That loop used to live
 * inline in `extensions/command-post/index.ts`, where nothing could test it —
 * and the defect it shipped with was exactly the kind a test catches: after the
 * pager closed, the answer menu re-opened with **`View the plan…` highlighted
 * again**, so the operator's next Enter reopened the pager instead of moving
 * on. Read the plan, press Enter, read the plan, press Enter: "even though I
 * seen the plan and I clicked done, we are still stuck on this decide".
 *
 * So the loop lives here, pure and injected:
 *
 *  - **the menu is a function** (`answerMenuOptions`) of the item plus one bit
 *    of state ("has the plan been read yet?"), so its ordering is asserted
 *    rather than eyeballed;
 *  - **sentinels are compared by identity** before anything is resolved, so a
 *    menu label can never be recorded as an answer or a note;
 *  - **skip and back write nothing, anywhere** — the item simply stays open;
 *  - every prompt is a dependency (`select`, `input`, `viewPlan`, `answer`),
 *    so tests drive the whole machine with no pi, no terminal and no home.
 *
 * This module imports only `./contracts.ts` and `./awaiting.ts` types: the
 * composition-root rule (`src/command-post.ts:1-12`) — `src/` never imports pi.
 */

import {
	AWAITING_DIALOG_MAX_ROUNDS,
	AWAITING_DONE_OPTION,
	AWAITING_ITEM_MAX_STEPS,
	AWAITING_SENTINEL_OPTIONS,
	AWAITING_SKIP_OPTION,
	AWAITING_TYPE_OPTION,
	PLAN_VIEW_AGAIN_OPTION,
	PLAN_VIEW_BACK_OPTION,
	PLAN_VIEW_OPTION,
	SUGGEST_DEADLINE_MS,
} from "./contracts.ts";
import type { ResolvedAwaitingItem } from "./awaiting.ts";

/** Is this string one of the dialog's own labels rather than an answer? */
export function isAwaitingSentinel(option: string): boolean {
	return (AWAITING_SENTINEL_OPTIONS as readonly string[]).includes(option);
}

/**
 * One item's answer menu, in order. The **first** option is the one a stray
 * Enter lands on, which is the whole reason this is a function:
 *
 *  - before the plan has been read, the first option is `View the plan…` —
 *    non-destructive, and ahead of any `approve`, exactly as cp-9c5 specified;
 *  - after it has been read, the first option is `Done reading — back to the
 *    list`, so Enter goes *forward* (out of the item, nothing recorded) instead
 *    of reopening the pager, and `View the plan again…` is still one keystroke
 *    away, just not the default.
 *
 * When no plan is viewable (no artifact, or not a real TUI) the menu is what it
 * always was: the item's options, free text, skip.
 */
export function answerMenuOptions(
	item: Pick<ResolvedAwaitingItem, "options">,
	state: { planViewable: boolean; planViewed: boolean },
	/**
	 * Generated candidates (cp-7t7), a bounded list of ordinary strings inserted
	 * between the item's own options and `Type an answer…` / `Skip`. Defaults to
	 * `[]`, which makes this function byte-identical to the pre-cp-7t7 menu for
	 * every documented state — the regression proof every existing test relies on.
	 *
	 * The **first** option is never a generated candidate, even when the item has
	 * no options of its own and no viewable plan: in that case `Type an answer…`
	 * is pushed *before* the candidates rather than after, so a stray Enter still
	 * lands on the same non-destructive default it always did.
	 */
	suggestions: readonly string[] = [],
): string[] {
	const options: string[] = [];
	if (state.planViewable && !state.planViewed) options.push(PLAN_VIEW_OPTION);
	if (state.planViewed) options.push(PLAN_VIEW_BACK_OPTION);
	options.push(...(item.options ?? []));
	// Never lead with a candidate: if nothing has been pushed yet (no plan
	// sentinel, no item option), the type-an-answer sentinel goes first.
	let typePushed = false;
	if (options.length === 0) {
		options.push(AWAITING_TYPE_OPTION);
		typePushed = true;
	}
	options.push(...suggestions);
	if (!typePushed) options.push(AWAITING_TYPE_OPTION);
	if (state.planViewable && state.planViewed) options.push(PLAN_VIEW_AGAIN_OPTION);
	options.push(AWAITING_SKIP_OPTION);
	return options;
}

/**
 * Race `promise` against `ms`, falling back to `[]` on a timeout or a
 * rejection. A private, minimal twin of `src/suggest.ts`'s own `withDeadline`:
 * this module's import list is asserted literally by a test
 * (`./contracts.ts` + `./awaiting.ts` only), so the generator arrives as an
 * injected dependency and the deadline race is duplicated here rather than
 * imported.
 */
function raceSuggestions(promise: Promise<string[]>, ms: number): Promise<string[]> {
	return new Promise<string[]>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve([]);
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
				resolve([]);
			},
		);
	});
}

/**
 * Resolve this item's candidates exactly once, best-effort. `authorization`
 * items are never sent to a generator at all — belt, alongside
 * `suggestionsEnabled` at the caller: their answer space is exactly
 * approve/decline, already offered as options. A missing `deps.suggest`, a
 * throw, or a slow generator (past `deps.suggestDeadlineMs`) all degrade to
 * `[]`, which is today's exact menu.
 */
async function resolveSuggestionsOnce(item: ResolvedAwaitingItem, deps: AwaitingDialogDeps): Promise<string[]> {
	if (!deps.suggest || item.type === "authorization") return [];
	const ms = deps.suggestDeadlineMs ?? SUGGEST_DEADLINE_MS;
	try {
		return await raceSuggestions(Promise.resolve(deps.suggest(item)), ms);
	} catch {
		return [];
	}
}

/** What one prompt round produced. Purely descriptive; the caller acts on it. */
export type AwaitingDialogStep =
	| { kind: "answered"; id: string; value: string }
	| { kind: "noted"; id: string; value: string }
	| { kind: "failed"; id: string; message: string }
	| { kind: "viewed"; id: string }
	| { kind: "back"; id: string }
	| { kind: "skipped"; id: string };

export type AwaitingDialogReason =
	/** Nothing was open (or nothing is left). */
	| "empty"
	/** The operator picked `Done` on the item list. */
	| "done"
	/** The list prompt was dismissed or timed out. */
	| "dismissed"
	/** The snapshot could not be read. */
	| "error"
	/** The round/step cap tripped — a defensive stop, never expected. */
	| "exhausted";

export interface AwaitingDialogOutcome {
	reason: AwaitingDialogReason;
	steps: AwaitingDialogStep[];
	/** The last batch the operator was shown (what "do not nag" snoozes). */
	offered: ResolvedAwaitingItem[];
	/** Present only for `reason: "error"`. */
	message?: string;
}

export interface AwaitingDialogDeps {
	/** The merged, render-ready set. Called again after every answer. */
	snapshot(): Promise<ResolvedAwaitingItem[]> | ResolvedAwaitingItem[];
	/** One row's one-line rendering for the list menu. */
	formatLine(item: ResolvedAwaitingItem): string;
	/** `undefined` means dismissed or timed out — never an answer. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Free text. `undefined`/blank means "no answer", i.e. leave it open. */
	input(title: string): Promise<string | undefined>;
	/**
	 * Record an answer. Throws to mean "not recorded"; a returned `note` means
	 * the text was kept as a note only (free text on an authorization item).
	 */
	answer(item: ResolvedAwaitingItem, value: string): Promise<{ note?: string } | void>;
	/**
	 * Best-effort, injected generator of candidate answers (cp-7t7). Called at
	 * most once per item per `runItem` invocation — never once per redraw — and
	 * raced against `suggestDeadlineMs`. Absent, throwing, or too slow all mean
	 * `[]`: the exact menu this repo shipped before this option existed.
	 */
	suggest?(item: ResolvedAwaitingItem): Promise<string[]> | string[];
	/** Per-item deadline for `suggest`. Defaults to `SUGGEST_DEADLINE_MS`. */
	suggestDeadlineMs?: number;
	/**
	 * The decision details pane (pi-command-post-4mn): bounded, already-redacted
	 * lines of authoritative evidence for this item, rendered above the menu.
	 * Injected — like `suggest` and `viewPlan` — because this module reads no
	 * files and knows no home (`src/decision-context.ts` builds them).
	 *
	 * It changes the **title** only. The option list is byte-identical with and
	 * without a pane, so what a stray Enter lands on cannot move because evidence
	 * appeared.
	 */
	context?(item: ResolvedAwaitingItem): readonly string[] | undefined;
	/** True when this item has something the pager can show, here and now. */
	planViewable?(item: ResolvedAwaitingItem): boolean;
	/** Open the pager. Resolves when the operator closes it; records nothing. */
	viewPlan?(item: ResolvedAwaitingItem): Promise<void>;
	notify?(text: string, level: "info" | "error" | "warning"): void;
	/** Say "Awaiting you: none" when the set is empty (manual invocations do). */
	announceEmpty?: boolean;
	maxRounds?: number;
	maxSteps?: number;
}

const LIST_TITLE = "Awaiting you \u2014 pick one to answer (Done to stop)";

/**
 * Drive the dialog to completion. Never throws for an operator-visible reason:
 * a failed snapshot, a dismissed prompt and a refused write all end in an
 * outcome the caller can act on, because a dialog that throws out of the middle
 * of a decision leaves the operator with an item they cannot answer — which is
 * the bug this module exists to make impossible.
 */
export async function driveAwaitingDialog(deps: AwaitingDialogDeps): Promise<AwaitingDialogOutcome> {
	const steps: AwaitingDialogStep[] = [];
	const maxRounds = deps.maxRounds ?? AWAITING_DIALOG_MAX_ROUNDS;
	const maxSteps = deps.maxSteps ?? AWAITING_ITEM_MAX_STEPS;
	let offered: ResolvedAwaitingItem[] = [];

	for (let round = 0; round < maxRounds; round += 1) {
		let items: ResolvedAwaitingItem[];
		try {
			items = await deps.snapshot();
		} catch (error) {
			const message = (error as Error).message;
			deps.notify?.(message, "error");
			return { reason: "error", steps, offered, message };
		}
		if (items.length === 0) {
			if (deps.announceEmpty) deps.notify?.("Awaiting you: none", "info");
			return { reason: "empty", steps, offered };
		}
		offered = items;

		const menu = items.map((item) => deps.formatLine(item));
		const choice = await deps.select(LIST_TITLE, [...menu, AWAITING_DONE_OPTION]);
		if (choice === undefined) return { reason: "dismissed", steps, offered };
		if (choice === AWAITING_DONE_OPTION) return { reason: "done", steps, offered };
		const item = items[menu.indexOf(choice)];
		if (!item) return { reason: "dismissed", steps, offered };

		const itemStep = await runItem(item, deps, steps, maxSteps);
		if (itemStep === "exhausted") {
			deps.notify?.(
				`${item.id}: too many rounds in one item's menu without an answer \u2014 closing the dialog; it stays open, ` +
					"run /cp-decide again",
				"error",
			);
			return { reason: "exhausted", steps, offered };
		}
	}
	return { reason: "exhausted", steps, offered };
}

/**
 * One item, until it is answered, skipped or left. Reading the plan is a step
 * inside this loop, never an exit from it: `planViewed` flips, the menu is
 * rebuilt with `Done reading` first, and nothing is recorded on the way.
 */
async function runItem(
	item: ResolvedAwaitingItem,
	deps: AwaitingDialogDeps,
	steps: AwaitingDialogStep[],
	maxSteps: number,
): Promise<"handled" | "exhausted"> {
	const planViewable = deps.viewPlan !== undefined && (deps.planViewable?.(item) ?? false);
	let planViewed = false;
	const contextLines = deps.context?.(item) ?? [];
	const title = [`${item.decision}\n${item.why}`, ...contextLines].join("\n");
	// Resolved once, before the first render, and reused for every redraw in this
	// loop (including the plan-view round trip) — never regenerated on a step.
	const suggestions = await resolveSuggestionsOnce(item, deps);
	const menuTitle =
		suggestions.length > 0 ? `${title}\nSuggested (model-generated, nothing preselected): ${suggestions.join(" | ")}` : title;

	for (let step = 0; step < maxSteps; step += 1) {
		const options = answerMenuOptions(item, { planViewable, planViewed }, suggestions);
		const picked = await deps.select(menuTitle, options);

		// Dismissed, timed out, or explicitly skipped: nothing is written anywhere
		// and the item stays open. Skip is not an answer (§Awaiting you).
		if (picked === undefined || picked === AWAITING_SKIP_OPTION) {
			steps.push({ kind: "skipped", id: item.id });
			return "handled";
		}
		// A step, not an answer: read the plan and come straight back here.
		if (picked === PLAN_VIEW_OPTION || picked === PLAN_VIEW_AGAIN_OPTION) {
			await deps.viewPlan?.(item);
			planViewed = true;
			steps.push({ kind: "viewed", id: item.id });
			continue;
		}
		// Back to the list, having answered nothing by accident.
		if (picked === PLAN_VIEW_BACK_OPTION) {
			steps.push({ kind: "back", id: item.id });
			return "handled";
		}

		let value = picked;
		if (picked === AWAITING_TYPE_OPTION) {
			const typed = await deps.input(item.decision);
			if (!typed || typed.trim().length === 0) {
				steps.push({ kind: "skipped", id: item.id });
				return "handled";
			}
			value = typed;
		}
		// Defensive: no sentinel may ever reach the resolver, even if a future
		// menu grows one this switch does not know about.
		if (isAwaitingSentinel(value)) {
			steps.push({ kind: "skipped", id: item.id });
			return "handled";
		}

		try {
			const result = (await deps.answer(item, value)) ?? {};
			if (result.note) {
				deps.notify?.(
					`noted on ${item.id}; that is not approve/decline, so the checkpoint stays pending`,
					"warning",
				);
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
		return "handled";
	}
	return "exhausted";
}
