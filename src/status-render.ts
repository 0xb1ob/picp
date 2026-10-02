/**
 * The shared cell vocabulary (cp-8tu).
 *
 * Three surfaces render the same fleet: `/status`'s table (`status.ts`), the
 * persistent widget (`widget.ts`) and the parent's status block
 * (`status-block.ts`). They are deliberately *different layouts* — a table
 * compares columns, a widget answers "does anything want me?", a block merges
 * operator judgment — but they must never disagree about what a job's state
 * **is**. So the cells live here, once, and every surface calls them.
 *
 * What is here: the value formatters (age, tokens, cost, model, scope/risk,
 * thinking), the two liveness labels (`runLabel`, `toolCell`) and `jobState`,
 * which is the one place that decides which of the widget's three sections a
 * job belongs to and what word names its state.
 *
 * What is deliberately NOT here: glyphs, colours, widths and section headers.
 * `status.ts`'s file header has said "the renderer owns glyphs" since T23 and
 * that stays true — `jobState` returns a `kind`, and each renderer maps that
 * kind to whatever alphabet it can actually draw (see `widget.ts`'s charset,
 * which has an ASCII fallback the table does not need).
 */

import { ASK_OPERATOR_TOOL, LONG_TOOL_CALL_SECONDS, type StatusJob, WEDGED_TOOL_CALL_SECONDS } from "./contracts.ts";
// Type-only: the CI classification `state/ci-watch.json` records is the gate's
// own union, and this module pins its phrases to it (cp-status-wait-reasons).
// `merge-ask.ts` imports `contracts.ts` and nothing here, so there is no cycle.
import type { MergeAskCi } from "./merge-ask.ts";

// ---------------------------------------------------------------------------
// Value formatters
// ---------------------------------------------------------------------------

/**
 * Seconds between two contract timestamps. Negative deltas clamp to 0 (ported):
 * a clock that ran backwards is not evidence a job started in the future.
 */
export function ageSeconds(timestamp: string, now: string): number {
	const then = Date.parse(timestamp);
	const at = Date.parse(now);
	if (!Number.isFinite(then) || !Number.isFinite(at)) return 0;
	return Math.max(0, Math.floor((at - then) / 1000));
}

/** Ported `age()`: seconds, minutes, hours, days — one unit, no padding. */
export function formatAge(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "-";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

export function formatTokens(total: number): string {
	if (!Number.isFinite(total) || total < 0) return "-";
	if (total < 1000) return String(total);
	if (total < 1_000_000) return `${(total / 1000).toFixed(1)}k`;
	return `${(total / 1_000_000).toFixed(2)}M`;
}

/**
 * The units a whole column may be rendered in (cp-8tu, defect 5). `formatTokens`
 * picks a unit per *value*, which is right for a single cell and wrong for a
 * column: `558.2k` above `2.39M` cannot be compared down the page.
 */
export type TokenUnit = "raw" | "k" | "M";

/** The one unit that fits the largest value in the column. */
export function chooseTokenUnit(totals: readonly number[]): TokenUnit {
	let max = 0;
	for (const total of totals) if (Number.isFinite(total) && total > max) max = total;
	if (max >= 1_000_000) return "M";
	if (max >= 1000) return "k";
	return "raw";
}

/** `formatTokens` in a caller-chosen unit, so a column shares one scale. */
export function formatTokensIn(total: number, unit: TokenUnit): string {
	if (!Number.isFinite(total) || total < 0) return "-";
	if (unit === "M") return `${(total / 1_000_000).toFixed(2)}M`;
	if (unit === "k") return `${(total / 1000).toFixed(1)}k`;
	return String(total);
}

export function formatCost(costUsd: number): string {
	if (!Number.isFinite(costUsd) || costUsd < 0) return "-";
	return `$${costUsd.toFixed(2)}`;
}

/**
 * The scope/risk a job was routed with (cp-status-scope-risk), as one cell.
 *
 * Convention: `S/low` is chosen (the caller named it, or the pipeline's
 * `self_assessment` did); `M?/high?` is inferred (`inferScopeAndRisk` found the
 * signal). **The mark is per axis** (cp-routing-provenance): `M?/low` is a job
 * whose scope was inferred and whose risk the caller named, and one inferred
 * axis never relabels the other. An axis nobody chose and nothing found prints
 * `-` — routing used its standing default there, and saying `S` would claim a
 * decision that was never made. A job with no routing decision on record at
 * all (dispatched before this field existed) prints the single placeholder
 * `—` (em dash) for the whole cell — never a guessed `S/low`, which is exactly
 * the silent-default bug cp-rte fixed for routing itself.
 *
 * A record written before `provenance` existed has only the one-bit `inferred`
 * flag: it is read exactly as it was rendered then, on both axes. That fallback
 * applies only when `provenance` is absent **entirely** — once a record
 * describes its axes, an axis it does not name is left unmarked rather than
 * inheriting the other axis's `?` from the legacy bit. (The contract requires
 * both axes inside a `provenance` object, so this is belt-and-braces against a
 * hand-edited file.)
 */
export function formatScopeRisk(job: StatusJob): string {
	const routing = job.routing;
	if (!routing) return "\u2014";
	const legacy = routing.provenance === undefined;
	const side = (value: string | undefined, from: string | undefined): string => {
		if (!value) return "-";
		if (legacy) return routing.inferred ? `${value}?` : value;
		// Routing used its standing default here; nobody decided it, so printing
		// `S` would claim a decision that was never made.
		if (from === "defaulted") return "-";
		return from === "inferred" ? `${value}?` : value;
	};
	return `${side(routing.scope, routing.provenance?.scope)}/${side(routing.risk, routing.provenance?.risk)}`;
}

/**
 * The effort level a job was routed with (cp-status-scope-risk): effort travels
 * with the model, so it belongs next to scope/risk, not buried in the model id.
 * `-` when a decision is on record but named no level (the profile's own
 * default was inert or absent); `\u2014` when there is no routing decision at all.
 */
export function formatThinking(job: StatusJob): string {
	if (!job.routing) return "\u2014";
	return job.routing.thinking ?? "-";
}

/**
 * `provider/model-id` -> `model-id`. The provider is implied by context (the
 * routing rule, the allowlist) and the line is width-constrained; the short id
 * is still enough to tell an override apart from the default. A missing or
 * empty model (never expected once dispatched, but a run record predating
 * this field is not impossible) renders as `-`, never the string `undefined`.
 */
export function shortModel(model: string | null | undefined): string {
	if (!model) return "-";
	const slash = model.indexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Liveness labels
// ---------------------------------------------------------------------------

/**
 * The liveness cell. `exited` is only ever printed for an OBSERVED close; a pid
 * that no longer answers prints `no-pid`, which is what we actually know.
 */
export function runLabel(job: StatusJob): string {
	if (job.run_phase === "exited") return "exited";
	if (!job.alive) return "no-pid";
	return job.run_phase ?? "-";
}

/**
 * True while a tool call has been open past the "worth a glance" threshold.
 *
 * An open exchange (a question or a plan review) is excluded for the same
 * reason it is excluded from `isWedgedToolCall` (cp-ft3d): the call is open
 * because a human has not answered yet, so its duration measures the operator's
 * own silence, not only `ask_operator`. Reporting that back as a long-running
 * tool call would be the fleet telling a person how long they have taken to
 * reply, next to the row that already says a human is the blocker.
 */
export function isLongToolCall(job: StatusJob): boolean {
	if (waitingOnOperator(job)) return false;
	return job.current_tool !== null && job.current_tool_seconds !== null && job.current_tool_seconds >= LONG_TOOL_CALL_SECONDS;
}

/**
 * True while a tool call has been open with **no observed progress** past the
 * wedged threshold (cp-wedged-tool-call).
 *
 * Note what is *not* here: the job's own age, its dispatch time, or how quiet
 * the worker has been generally. The only inputs are an open call (a
 * `tool_execution_start` with no matching end) and the silence since its last
 * `tool_execution_update`. A call that keeps emitting output is never wedged,
 * however long it runs — which is the whole reason this can be measured
 * without reintroducing the retired `stalled` guess.
 *
 * `current_tool_idle_seconds` is optional on the contract (an older snapshot
 * has none); absent means "not measurable", which is never "wedged".
 *
 * A job mid-`auto_retry` is never wedged either: pi restarting its own agent
 * loop after a transient model/API failure explains the pause, and an
 * explained pause is not a wedge (see src/wedged.ts).
 */
export function isWedgedToolCall(job: StatusJob, thresholdSeconds: number = WEDGED_TOOL_CALL_SECONDS): boolean {
	if (job.retrying) return false;
	// The silence of an open `ask_operator` call is a human's, not a worker's
	// (cp-ft3d). See `waitingOnOperator` below for why that is a different fact
	// entirely, and why it must never be reported as a wedge.
	if (waitingOnOperator(job)) return false;
	const idle = job.current_tool_idle_seconds;
	return job.current_tool !== null && idle !== null && idle !== undefined && idle >= thresholdSeconds;
}

/**
 * Is this job's open tool call waiting on a human (cp-ft3d, spec 2026-09-13)?
 *
 * `ask_operator` blocks until a human answers, so its `tool_execution_start`
 * has no matching end for exactly as long as the operator takes — minutes with
 * a dialog in front of them. That
 * unmatched pair is the same *structural* fact the wedged detector reads, and
 * it means the opposite thing: the worker is not stuck, it is waiting, and the
 * thing that has gone quiet is the human.
 *
 * Any open exchange — a question or a plan review — is the operator's silence.
 */
export function waitingOnOperator(job: StatusJob): boolean {
	// An open `ask_operator`, or any exchange the relay is holding for a human —
	// a planner's `report_result` waiting for its console review is the second
	// kind (spec 2026-09-13). Either way the silence is the operator's.
	return job.current_tool === ASK_OPERATOR_TOOL || job.open_question !== undefined;
}

/**
 * The TOOL cell's text: the tool name, with a duration suffix only once it has
 * been running long enough to be worth a glance (LONG_TOOL_CALL_SECONDS). A
 * short call never grows a clock; this is a fact surfaced past a threshold,
 * not a running timer for its own sake.
 */
export function toolCell(job: StatusJob): string {
	if (!job.current_tool) return "-";
	if (!isLongToolCall(job)) return job.current_tool;
	return `${job.current_tool} (${formatAge(job.current_tool_seconds as number)}!)`;
}

// ---------------------------------------------------------------------------
// waitReason — why a held job cannot advance, from files alone
// ---------------------------------------------------------------------------

/**
 * The longest phrase `waitReason` can return: `a fix for red CI on d48a81d`.
 *
 * It is a **bound the phrases satisfy**, not a truncation applied to them: a
 * renderer that clipped this cell would cut the short sha, and half an
 * identifier in a status row is worse than no identifier at all. Both
 * renderers size their cell from this constant, and a test pins that every
 * phrase fits it.
 */
export const WAIT_REASON_MAX_CHARS = 27;

/**
 * The CI classifications this renderer knows, keyed by the **producer's own
 * union** (`MergeAskCi`, written to `state/ci-watch.json` by `ciStateOf`).
 *
 * `StatusJob.ci.state` is a bounded string on the contract, because
 * `contracts.ts` cannot import the gate that imports it; this table is where
 * that string is pinned back to the type that produces it. Listing every
 * member is compiler-enforced by the `Record<MergeAskCi, true>` annotation, so
 * a new classification cannot be added to the gate without this switch being
 * told about it.
 */
const KNOWN_CI_STATES: Readonly<Record<MergeAskCi, true>> = Object.freeze({
	green: true,
	in_progress: true,
	superseded: true,
	failed: true,
	unknown: true,
	unreviewed: true,
	job_gone: true,
	already_merged: true,
	no_ci: true,
});

function isKnownCiState(state: string | undefined): state is MergeAskCi {
	return state !== undefined && Object.hasOwn(KNOWN_CI_STATES, state);
}

/**
 * The one short phrase saying what a job is waiting **on**, or null when there
 * is nothing disk-derived to say (cp-status-wait-reasons).
 *
 * Every input is already on `StatusJob` — the CI watcher's last observation
 * (`state/ci-watch.json`) and whether a `cp_review` passed on that head
 * (`review-<n>.json`) — so this stays files-only and safe on a widget tick.
 * Nothing here is a judgment the parent has to author, and nothing here
 * duplicates an **authorization**: a pending checkpoint is a human decision
 * that lives in Awaiting you, not a blocker a status row restates.
 *
 * **A reviewer in flight is deliberately not a wait reason.** Both surfaces
 * already say so where it belongs — `/status` prints the attempt and its
 * deadline under the row, the widget's activity cell carries `review 2 ⋅ 4m` —
 * and one fact printed twice on one row is noise, not detail. The suppression
 * lives here rather than in each renderer so the two can never disagree.
 */
export function waitReason(job: StatusJob): string | null {
	if (job.pending_review) return null;
	// Only a delivered job is *waiting* on something: a live worker's row already
	// says what it is doing, and a failed one says why it stopped.
	if (job.phase !== "held") return null;
	const ci = job.ci;
	if (!ci?.head_sha) return job.delivery === "pr" ? "a pushed head on origin" : null;
	const head = ci.head_sha.slice(0, 7);
	// Deliberate, and the only free-string path: a classification this renderer
	// predates (or a hand-edited file) is still a head CI is being read for, and
	// saying so beats printing a word the operator has no vocabulary for.
	if (!isKnownCiState(ci.state)) return `CI on ${head}`;
	switch (ci.state) {
		case "green":
			return ci.reviewed ? `merge of reviewed ${head}` : `review of green ${head}`;
		// The gate's own word for "green, but no passing review on this head" —
		// `ciStateOf` cannot produce it (it never passes `reviewedHeads`), and it is
		// handled anyway so the two spellings of one situation read identically.
		case "unreviewed":
			return `review of green ${head}`;
		// cp-no-ci-repo-derived: the repository has no workflows, so there is no CI
		// to wait for — only the merge. `ciStateOf` cannot produce it either (it
		// never passes `ciConfigured`); handled so the two spellings agree.
		case "no_ci":
			return ci.reviewed ? `merge of reviewed ${head}` : `review of ${head} (no CI)`;
		case "failed":
			return `a fix for red CI on ${head}`;
		case "superseded":
			return `CI to start on ${head}`;
		case "in_progress":
		case "unknown":
			return `CI on ${head}`;
		// Neither is a wait: the merge landed, or the row's job no longer exists —
		// and a job with no fleet record has no status row to render in the first
		// place.
		case "already_merged":
		case "job_gone":
			return null;
	}
}

// ---------------------------------------------------------------------------
// jobState — one composite state, computed from facts already on the job
// ---------------------------------------------------------------------------

/** Which of the widget's three sections a job belongs to. */
export type WidgetSection = "needs" | "attention" | "running";

/**
 * The composite state. `kind` is the discriminator renderers map to a glyph;
 * `word` is the spelled-out state, so a monochrome terminal (or a renderer
 * with no glyph alphabet at all, like the status block) loses no information.
 */
export type JobStateKind =
	| "asked"
	| "approval"
	| "unreported"
	| "failed"
	| "exited"
	| "long-tool"
	| "working"
	| "idle"
	| "starting"
	| "no-pid"
	| "unknown";

export interface JobState {
	kind: JobStateKind;
	section: WidgetSection;
	word: string;
}

export interface JobStateOptions {
	/** True when an open Awaiting-you item names this job (cp-av8's snapshot). */
	awaiting?: boolean;
}

/**
 * Did this job's run finish without filing an envelope
 * (cp-settle-without-report)? Two facts, either of which is sufficient: the
 * settle counter the settle watcher writes while the worker is still alive,
 * and the failure class the classifier assigns once the worker has exited.
 *
 * Deliberately distinct from `failed`. A job in this state has usually done
 * all of its work — pushed a branch, opened a green PR, written an artifact —
 * and is missing only the last tool call. Rendering it as a plain failure is
 * what let four merge-ready PRs sit unnoticed for fourteen hours.
 *
 * **It is also deliberately disjoint from a wedged call** (cp-wedged-tool-call),
 * and the exclusion is structural rather than a phase name, because that is
 * what actually makes the two impossible to confuse: **an open tool call means
 * the run did not settle.** `isWedgedToolCall` reads exactly one fact, an open
 * `current_tool`; refusing that same fact here is what guarantees no job can
 * ever be reported as both.
 *
 * The seam this closes is a *nudged* worker that started running again: its
 * counter is still set, but the honest present-tense state is `working`, and a
 * call that then goes silent must surface as the wedge it is rather than being
 * masked by a stale counter. The unreported fact is about a run that has
 * **stopped**, so it stands down while one is in flight and returns the moment
 * the worker settles again with no envelope.
 */
export function settledWithoutReport(job: StatusJob): boolean {
	if (job.reported_at) return false;
	// An open call is the wedge watcher's fact, not ours — whatever the phase says.
	if (job.current_tool !== null) return false;
	if (job.run_phase === "working") return false;
	if (job.failure?.class === "settled_without_report") return true;
	return (job.unreported_settles ?? 0) > 0;
}

/**
 * One job, one state — computed from `open_question`, `failure`/`phase`,
 * `run_phase`, `alive`, `reported_at`, `unreported_settles` and
 * `current_tool_seconds`, all of which are already on `StatusJob`. Nothing new
 * is read, and **nothing is inferred from age**: `stalled` stays retired.
 *
 * The three sections answer "what does this ask of me?", in priority order:
 *
 *  - `needs` — a human is the blocker: the worker asked a question, or an open
 *    Awaiting-you item names the job.
 *  - `attention` — something is wrong, unusually slow, or finished but unsaid:
 *    the job failed, its run settled or exited without filing an envelope, or a
 *    tool call has been open past `LONG_TOOL_CALL_SECONDS`.
 *  - `running` — **everything else**, which is why no row can ever be silently
 *    dropped: a job that is neither asking nor alarming still gets a row, with
 *    the word (`working`, `idle`, `exited`, `no-pid`) carrying the detail.
 */
export function jobState(job: StatusJob, options: JobStateOptions = {}): JobState {
	if (job.open_question) return { kind: "asked", section: "needs", word: "asked" };
	if (options.awaiting) return { kind: "approval", section: "needs", word: "held" };
	// Ahead of `failed` on purpose: when both are true the honest word is the
	// specific one. "failed" says the work is lost; "unreported" says the work is
	// probably sitting on a branch and only the envelope is missing.
	if (settledWithoutReport(job)) return { kind: "unreported", section: "attention", word: "unreported" };
	if (job.phase === "failed") return { kind: "failed", section: "attention", word: "failed" };
	// An exit with no envelope is a worker that died without saying anything;
	// an exit *with* one is a finished job waiting on the parent, not an alarm.
	if (job.run_phase === "exited" && !job.reported_at) return { kind: "exited", section: "attention", word: "exited" };
	if (isLongToolCall(job)) return { kind: "long-tool", section: "attention", word: "working" };
	if (job.run_phase === "exited") return { kind: "exited", section: "running", word: "exited" };
	if (!job.alive) return { kind: "no-pid", section: "running", word: "no-pid" };
	if (job.run_phase === "working") return { kind: "working", section: "running", word: "working" };
	if (job.run_phase === "starting") return { kind: "starting", section: "running", word: "starting" };
	if (job.run_phase === "idle") return { kind: "idle", section: "running", word: "idle" };
	// Alive, but no readable projection yet: unknown, not dead. Same `-` the
	// table's RUN cell has always printed for it.
	return { kind: "unknown", section: "running", word: "-" };
}
