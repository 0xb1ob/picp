/**
 * **One UI for every Awaiting-you surface** (cp-gb3w).
 *
 * `/cp-decide` became the package's questionnaire overlay in cp-4864/cp-vvaz.
 * Every *other* surface that puts the same decision in front of the operator —
 * the `agent_settled` auto-open, and the checkpoint authorization dialog —
 * kept its own `ctx.ui.select` prompt, so answering the same item looked like
 * two different products depending on which surface happened to ask.
 *
 * This module is the routing decision, extracted so it is a tested function
 * rather than an `if` buried in the extension:
 *
 *  - `routeAwaitingUi` says whether a surface may render the overlay at all,
 *    and when it may not, **why** — the reason is shown on screen, never
 *    swallowed (cp-4864's actual defect was a silent degrade);
 *  - `overlayFallbackNotice` is the one wording every surface uses to say it;
 *  - `checkpointQuestion` / `interpretCheckpointAnswer` project a pending
 *    checkpoint onto the same overlay and read the answer back **without**
 *    inventing a second verdict path: only the two verdict rows are verdicts,
 *    typed text and Esc are not, and the write itself is still
 *    `CheckpointStore.decide` at the call site;
 *  - `snoozeCandidates` is the auto-open's "do not nag" bookkeeping, shared by
 *    the overlay run and the plain-dialog run so both surfaces snooze the same
 *    items.
 *
 * Degrade, never fail: a route of `plain` is always available, so no awaiting
 * item is unanswerable in any context, and the package is never a hard
 * dependency of answering. This module imports nothing but `./contracts.ts`
 * and types — no pi, no fs (the composition-root rule, `src/command-post.ts`).
 */

import {
	AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS,
	CHECKPOINT_APPROVE_OPTION,
	CHECKPOINT_DECLINE_OPTION,
	CHECKPOINT_LATER_OPTION,
	ENV_HEADLESS,
} from "./contracts.ts";
import type { AwaitingDialogStep } from "./awaiting-dialog.ts";
import { type AutoOpenEnv, canAutoOpenDialog, hasAutoOpenCandidate, type ResolvedAwaitingItem } from "./awaiting.ts";

// ---------------------------------------------------------------------------
// Which UI a surface gets
// ---------------------------------------------------------------------------

/**
 * Every surface that asks. `decide` is a typed `/cp-decide`, `auto_open` is the
 * `agent_settled` dialog, `checkpoint` is the authorization ask a minted
 * checkpoint raises. The widget itself never asks: it renders the marker
 * (`⧗ N decisions awaiting you`) and points at `/cp-decide`, which is one of
 * these three.
 */
export type AwaitingSurface = "decide" | "auto_open" | "checkpoint";

/** How each surface names itself in an operator-facing line. */
export const AWAITING_SURFACE_LABEL: Record<AwaitingSurface, string> = {
	decide: "/cp-decide",
	auto_open: "Awaiting you",
	checkpoint: "authorization",
};

/** The subset of an `ExtensionContext` the routing decision reads. */
export interface AwaitingUiEnv {
	mode: string;
	hasUI: boolean;
}

export type AwaitingUiRoute = { ui: "overlay" } | { ui: "plain"; reason: string };

/**
 * The overlay renders through `ctx.ui.custom`, which exists only in a real
 * interactive TUI: `print`/`json` have no UI at all, and an RPC or ACP host
 * (`pi --mode rpc`, a `pi -p` re-entry, an editor pendant) resolves it to
 * `undefined`. Both cases route to the plain, timeout-bearing prompts with the
 * reason attached — the same rule for every surface, which is the point of
 * this function: one answer to "can this render?", not three.
 *
 * A `plain` route is never a failure. It is the documented degrade, and it is
 * always answerable.
 */
export function routeAwaitingUi(
	_surface: AwaitingSurface,
	env: AwaitingUiEnv,
	envVars: NodeJS.ProcessEnv = process.env,
): AwaitingUiRoute {
	if (envVars[ENV_HEADLESS] === "1") {
		return { ui: "plain", reason: `${ENV_HEADLESS} is set (bridge-driven)` };
	}
	if (!env.hasUI) return { ui: "plain", reason: `no UI is attached (mode: ${env.mode})` };
	if (env.mode !== "tui") return { ui: "plain", reason: `not a TUI (mode: ${env.mode})` };
	return { ui: "overlay" };
}

/**
 * The one wording. Every surface says the same thing the same way, so an
 * operator who sees the plain prompts always learns why they are seeing them.
 */
export function overlayFallbackNotice(surface: AwaitingSurface, reason: string): string {
	return (
		`${AWAITING_SURFACE_LABEL[surface]}: the questionnaire overlay is unavailable — ${reason || "no reason given"}. ` +
		"Falling back to the plain dialogs."
	);
}

/**
 * The other one wording: a surface that did **not** ask because another one is
 * already on screen (pi-command-post-p18).
 *
 * pi composites overlays and gives input to the newest, so a second overlay
 * does not queue behind the first — it covers it and steals its keystrokes.
 * The surface that loses says so rather than returning silently, and nothing is
 * written on either side: the refused question is still open wherever it lives
 * (a checkpoint stays `pending` and is already a row in Awaiting you).
 */
export function surfaceBusyNotice(holder: AwaitingSurface, surface: AwaitingSurface): string {
	return (
		`${AWAITING_SURFACE_LABEL[surface]}: ${AWAITING_SURFACE_LABEL[holder]} is already on screen — ` +
		"answer or dismiss it first; nothing was asked and nothing was written."
	);
}

/**
 * **Can the unattended surface open the deadline-less overlay?**
 *
 * The overlay has no external cancel and no deadline, so the `agent_settled`
 * auto-open may only reach it where a human is *provably* at an interactive
 * terminal. That is two conditions, and this function is the conjunction of
 * both so neither can be satisfied alone:
 *
 *  - `canAutoOpenDialog` — the pre-existing gate on the settle hook itself
 *    (a real TUI; never RPC, never `json`/`print`, never a worker, which never
 *    loads this extension at all);
 *  - `routeAwaitingUi("auto_open", …)` — the renderer can actually render.
 *
 * Where it is false the auto-open either does not fire at all or falls back to
 * the timeout-bearing prompts, which is the property the plain dialogs used to
 * carry on this path (cp-gb3w).
 */
export function canAutoOpenOverlay(env: AutoOpenEnv, envVars: NodeJS.ProcessEnv = process.env): boolean {
	return canAutoOpenDialog(env) && routeAwaitingUi("auto_open", env, envVars).ui === "overlay";
}

/** Why the settle hook did or did not open the Awaiting-you surface. */
export type AutoOpenReason = "no_human_surface" | "busy" | "nothing_open" | "open";

/**
 * The settle hook's whole decision, as data (cp-gb3w, review 3): a real
 * interactive TUI where the overlay can render, no run already in flight, and
 * at least one item that is not snoozed. Extracted so the hook's behaviour is
 * asserted by running it, not by matching its source.
 */
export function autoOpenDecision(input: {
	env: AutoOpenEnv;
	latchBusy: boolean;
	items: readonly ResolvedAwaitingItem[];
}): { open: boolean; reason: AutoOpenReason } {
	if (!canAutoOpenOverlay(input.env)) return { open: false, reason: "no_human_surface" };
	if (input.latchBusy) return { open: false, reason: "busy" };
	if (!hasAutoOpenCandidate(input.items)) return { open: false, reason: "nothing_open" };
	return { open: true, reason: "open" };
}

/**
 * How long a surface may leave the overlay up waiting for a human.
 *
 * Only the **auto-open** has a deadline, and it has one for the reason the
 * plain dialog had one there: nobody asked for that surface, so an operator who
 * is attached but absent must not hold the settle handler or the single-run
 * latch. On expiry the overlay is closed and the batch is a **skip** — nothing
 * is written anywhere and every item reappears (`SingleRunLatch` releases, and
 * `driveAwaitingQuestionnaire` treats a cancel as "skipped" for every tab).
 *
 * `/cp-decide` and the checkpoint ask return `undefined`: a human typed the
 * first and a human is being asked by the second, so neither may be closed
 * under them mid-thought.
 */
export function overlayTimeoutMs(surface: AwaitingSurface): number | undefined {
	return surface === "auto_open" ? AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS : undefined;
}

/**
 * The mutual-exclusion guard around the Awaiting-you loop, as an object that
 * **cannot** be left latched: the release is in a `finally` inside this class
 * rather than at a call site that might return early. A second run while one is
 * in flight is refused (`undefined`), which is what keeps an auto-open from
 * stacking on an auto-open, or on a manual `/cp-decide` already running.
 *
 * It exists as a class so "a run that times out, throws, or returns early still
 * releases the latch" is a test rather than a reading of the extension closure
 * (cp-gb3w, review 2).
 */
export class SingleRunLatch {
	#holder: AwaitingSurface | undefined;

	get busy(): boolean {
		return this.#holder !== undefined;
	}

	/** Which surface is on screen, or `undefined` when nothing is. */
	get holder(): AwaitingSurface | undefined {
		return this.#holder;
	}

	/** Run `body` unless a surface is already in flight; always releases. */
	async run<T>(surface: AwaitingSurface, body: () => Promise<T>): Promise<LatchResult<T>> {
		const holder = this.#holder;
		if (holder !== undefined) return { ran: false, holder };
		this.#holder = surface;
		try {
			return { ran: true, value: await body() };
		} finally {
			this.#holder = undefined;
		}
	}
}

/** Whether the latch let a surface run, and who refused it when it did not. */
export type LatchResult<T> = { ran: true; value: T } | { ran: false; holder: AwaitingSurface };

/**
 * The outer extension-prompt span pi already coalesces (`ui_prompt_start` /
 * `ui_prompt_end`). Not a latch holder: the pager and T31
 * dialog must not join `SingleRunLatch`. OR'd into the existing busy checks so
 * a free latch plus an overlay pager cannot recreate p18.
 */
export class HumanPrompt {
	#open = false;

	get open(): boolean {
		return this.#open;
	}

	start(): void {
		this.#open = true;
	}

	end(): void {
		this.#open = false;
	}
}

/**
 * A surface that did not ask because an extension prompt is already on screen.
 * Same close as `surfaceBusyNotice`: nothing was asked and nothing was written.
 */
export function promptBusyNotice(surface: AwaitingSurface): string {
	return (
		`${AWAITING_SURFACE_LABEL[surface]}: a prompt is already on screen — ` +
		"dismiss it first; nothing was asked and nothing was written."
	);
}

/**
 * Hide pi's working loader for the outer `ui_prompt` span and restore it when
 * that span ends. Synchronous: pi does not await `ui_prompt_*` handlers.
 */
export function applyPromptWorking(
	ui: { setWorkingVisible(visible: boolean): void },
	prompt: HumanPrompt,
	phase: "start" | "end",
): void {
	if (phase === "start") {
		prompt.start();
		ui.setWorkingVisible(false);
	} else {
		prompt.end();
		ui.setWorkingVisible(true);
	}
}

/**
 * The checkpoint ask, under the same latch every other operator-facing overlay
 * takes (pi-command-post-p18).
 *
 * Refused → `undefined`, which is T21's "not now" that the whole stack already
 * handles: the checkpoint was written `pending` before anyone was asked, the
 * row is already in Awaiting you, and the in-flight loop re-snapshots between
 * rounds — so the question reappears on the surface that is open, with no queue
 * and no second overlay. **Nothing is written on the refusal path.**
 */
export async function askCheckpointUnderLatch<T>(
	latch: SingleRunLatch,
	ask: () => Promise<T | undefined>,
	deps: { notify?: (text: string) => void } = {},
): Promise<T | undefined> {
	const result = await latch.run("checkpoint", ask);
	if (!result.ran) {
		deps.notify?.(surfaceBusyNotice(result.holder, "checkpoint"));
		return undefined;
	}
	return result.value;
}

// ---------------------------------------------------------------------------
// The checkpoint ask, as one overlay question
// ---------------------------------------------------------------------------

/** Just enough of a pending checkpoint to ask about it. */
export interface CheckpointAsk {
	job_id: string;
	kind?: string;
	scope?: string;
}

export interface OverlayQuestion {
	question: string;
	header: string;
	options: { label: string; description: string }[];
}

const CHECKPOINT_HEADER = "Authorize";

/** What each checkpoint kind is actually asking permission for. */
function checkpointSubject(ask: CheckpointAsk): string {
	switch (ask.kind) {
		case "merge":
			return ask.scope ? `merge ${ask.scope.slice(0, 12)}?` : "merge this PR?";
		case "diff":
			return "accept the reviewed diff?";
		default:
			return "authorize implementation?";
	}
}

/**
 * One pending checkpoint → one overlay question, with exactly the three rows
 * the plain dialog always had. `Not now` is a real row rather than only Esc,
 * so the non-answer is visible and the operator never has to guess that
 * leaving is allowed.
 */
export function checkpointQuestion(ask: CheckpointAsk): OverlayQuestion {
	return {
		question: `${ask.job_id}: ${checkpointSubject(ask)}\n[${ask.job_id}]`,
		header: CHECKPOINT_HEADER,
		options: [
			{ label: CHECKPOINT_APPROVE_OPTION, description: "authorize it now" },
			{ label: CHECKPOINT_DECLINE_OPTION, description: "refuse it; the job stops here" },
			{ label: CHECKPOINT_LATER_OPTION, description: "leave the checkpoint pending; it stays in Awaiting you" },
		],
	};
}

/** What came back from the overlay for one checkpoint question. */
export type CheckpointOverlayAnswer =
	| { kind: "option"; label: string }
	| { kind: "custom"; text: string }
	| { kind: "none" };

/**
 * Read one overlay answer as a verdict, or as nothing.
 *
 * **Only the two verdict rows are verdicts.** Typed free text is never one —
 * the same rule `resolveAwaitingResponse` enforces for an authorization item
 * (free text is a note, never a verdict) — and neither is `Not now`, an
 * untouched tab or Esc. Everything that is not a verdict leaves the checkpoint
 * pending, which is T21's "not now", and it reappears in Awaiting you.
 */
export function interpretCheckpointAnswer(
	answer: CheckpointOverlayAnswer | undefined,
): { approved: boolean } | { note: string } | undefined {
	if (!answer) return undefined;
	if (answer.kind === "custom") {
		const text = answer.text.trim();
		return text.length > 0 ? { note: text } : undefined;
	}
	if (answer.kind !== "option") return undefined;
	if (answer.label === CHECKPOINT_APPROVE_OPTION) return { approved: true };
	if (answer.label === CHECKPOINT_DECLINE_OPTION) return { approved: false };
	return undefined;
}

// ---------------------------------------------------------------------------
// "Do not nag": one rule, both runs
// ---------------------------------------------------------------------------

export interface SnoozeInput {
	steps: readonly AwaitingDialogStep[];
	offered: readonly ResolvedAwaitingItem[];
	/** The run ended because the operator ended it (done, dismissed, cancelled, exhausted). */
	endedByOperator: boolean;
}

/**
 * Which of the items an auto-opened run offered are snoozed for this session.
 *
 * An **answered** row has left the open set for good and is never snoozed.
 * Everything else the run touched — skipped, noted, failed, left via
 * `Done reading` — counts as "offered and not answered", and so does the whole
 * batch when the operator ended the run (Esc on the overlay, Done on the plain
 * dialog, the deadline). Identical for the overlay run and the plain run: the
 * UI is the only thing that differs between them.
 */
export function snoozeCandidates(input: SnoozeInput): ResolvedAwaitingItem[] {
	const answered = new Set(input.steps.filter((step) => step.kind === "answered").map((step) => step.id));
	const touched = new Set(
		input.steps.filter((step) => step.kind !== "answered" && step.kind !== "viewed").map((step) => step.id),
	);
	return input.offered.filter((item) => !answered.has(item.id) && (input.endedByOperator || touched.has(item.id)));
}

/** The run reasons that mean "the operator ended it", for both loops. */
export function endedByOperator(reason: string): boolean {
	return reason === "done" || reason === "dismissed" || reason === "exhausted" || reason === "cancelled";
}
