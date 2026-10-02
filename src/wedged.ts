/**
 * Wedged tool calls (cp-wedged-tool-call) — making a call that never returns
 * *detectable* instead of invisible.
 *
 * ## The incident
 *
 * Two workers each stopped with `tool_execution_update` as their final event
 * and then sat for fifteen hours. Both were running the full test suite piped
 * into a consumer (`npm test … | tail -50`, `npm test … | grep -A 30 …`), so
 * the call produced no output for the parent to see and never returned.
 * Nothing detected it: `/status` said `working` the entire time, because
 * `working` was *true* — a turn really was in flight. Neither worker pushed
 * anything, both held their leases, and one had to have four modified files
 * salvaged by hand before its lease could be cleared.
 *
 * This is **not** the cp-4dx cause recurring. That one was an interactive git
 * editor blocking on stdin, and it was fixed at the root by
 * `NONINTERACTIVE_WORKER_ENV` (`src/worker-manager.ts`). These two calls were
 * ordinary non-interactive commands. There is no narrow command to make
 * non-interactive here, which is exactly why the fix has to be general.
 *
 * ## Why this is allowed to use a duration, when phases are not
 *
 * `docs/contracts.md` retires `stalled` and says nothing is inferred from age.
 * That rule is intact, and this does not bend it:
 *
 *  - **The fact is structural.** The run's append-only log holds a
 *    `tool_execution_start` with no matching `tool_execution_end`. An unmatched
 *    pair is an observation, the same kind of fact as an observed process
 *    exit. The retired `stalled` had no fact underneath it at all — it read a
 *    dispatch timestamp and guessed about a pane nobody could see.
 *  - **The duration is a reporting threshold, not a verdict.** It answers
 *    "when is this already-observed open call worth an operator's attention",
 *    not "what state is this job in". No `JobPhase` moves, no `RunPhase`
 *    moves, and no new phase is introduced.
 *  - **Progress resets the clock.** What accumulates is *silence* since the
 *    last `tool_execution_update` for this exact call, not the call's age. A
 *    build or a backtest that keeps emitting output is never surfaced however
 *    long it runs — an hour-long ML backtest was legitimate work yesterday and
 *    stays legitimate here.
 *  - **Surfacing is not killing.** This module produces a notice. It has no
 *    kill path, no signal, no lease action. Long work is legitimate work, and
 *    the operator decides.
 *
 * ## Shape
 *
 * `detectWedgedToolCalls()` is pure: a `StatusSnapshot` in, a list out. The
 * snapshot is the one the parent's widget timer already computes from files,
 * so this costs no new read surface and no tokens. `WedgedWatch` adds exactly
 * one thing on top: memory of what has already been announced, so a wedged
 * call is news once rather than every five seconds.
 */

import { ASK_OPERATOR_TOOL, type StatusJob, type StatusSnapshot, WEDGED_TOOL_CALL_SECONDS } from "./contracts.ts";
import { type ProjectOf, projectGroupedLines } from "./project-report.ts";
import { formatAge, isWedgedToolCall, waitingOnOperator } from "./status-render.ts";

/** One open tool call that has gone silent past the threshold. */
export interface WedgedToolCall {
	job_id: string;
	/** Tool name from the run projection's `current_tool`. */
	tool: string;
	/** Seconds the call has been open (`tool_execution_start` → now). */
	running_seconds: number;
	/** Seconds since the call last proved progress. This is what crossed. */
	idle_seconds: number;
	/** Where a human would go to look, verbatim from the fleet record. */
	worktree: string;
	branch: string;
	model: string;
	/** The threshold this crossed, so a notice is self-describing. */
	threshold_seconds: number;
}

export interface WedgedOptions {
	/** Defaults to `wedgedToolCallSeconds()`. */
	thresholdSeconds?: number;
}

/**
 * The configured threshold: `CP_WEDGED_TOOL_CALL_SECONDS` if it is a positive
 * finite number, else `WEDGED_TOOL_CALL_SECONDS` (1800s / 30 minutes).
 *
 * A malformed or non-positive value falls back to the default rather than
 * disabling the watch: a typo in an env var must not silently turn detection
 * off, which is the failure mode this whole module exists to remove.
 */
export function wedgedToolCallSeconds(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.CP_WEDGED_TOOL_CALL_SECONDS;
	if (raw === undefined || raw.trim() === "") return WEDGED_TOOL_CALL_SECONDS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return WEDGED_TOOL_CALL_SECONDS;
	return Math.floor(parsed);
}

/**
 * A job is a candidate only while it is genuinely mid-call:
 *
 *  - `alive` — a dead worker's open call is not wedged, it is over. That case
 *    already has its own surfacing (`exited` with no envelope → the widget's
 *    attention section, and the failure classifier).
 *  - `run_phase === "working"` — the projection says a turn is in flight.
 *  - an open `current_tool` — the unmatched-pair fact itself.
 *  - **not mid-`auto_retry`** — see below.
 *  - **not an open `ask_operator` call** — see below.
 *
 * ## The waiting-human false positive (cp-ft3d)
 *
 * `ask_operator` is a tool call that blocks until a human answers it. While it
 * is open the run projection carries `current_tool: "ask_operator"`, the phase
 * is `working`, the worker is alive, and no `tool_execution_update` will ever
 * arrive — the worker has nothing to say, because it is not doing anything.
 * Structurally that is *identical* to the two casualties this module exists
 * for, and it means the exact opposite: nothing is stuck, a person has not
 * replied yet.
 *
 * Reporting it would be the fleet waking the operator to tell them they have
 * been quiet for half an hour, about a question `/status` and the widget are
 * already showing them (`? asked you`). Worse, it would arrive as a
 * `cp-wedged` message naming the job — and the sanctioned response to that is
 * an operator decision about ending a worker that is perfectly healthy.
 *
 * The dialog relay hides the gap by accident: a question is deadlined at ten
 * minutes, which is under the thirty-minute threshold. A held question has no
 * deadline on purpose (it waits as long as the operator wants),
 * so the first held question would trip this detector inside the first hour.
 * The exclusion is keyed on the tool name from the run projection, so it holds
 * for the dialog relay (a non-TUI parent) and the held path alike.
 *
 * ## The auto-retry false positive, and why it is excluded
 *
 * pi retries on its own after a transient model/API failure: the agent loop
 * restarts, and the log shows `auto_retry_start`/`auto_retry_end` plus an
 * `agent_start` with no matching `agent_end`, with a genuine pause and no tool
 * activity in between. `cp-viewer-scroll-stuck-dam` was observed doing exactly
 * this while perfectly healthy, and it recovered on its own.
 *
 * None of that is evidence of a wedged tool call, and this detector must never
 * read it as one:
 *
 *  - An `agent_start`/`agent_end` asymmetry is **not** an input here at all.
 *    The only unmatched pair this module looks at is
 *    `tool_execution_start` → `tool_execution_end`, projected as
 *    `current_tool`. A retry produces the agent-level asymmetry and nothing
 *    else, so it cannot reach this code path by that route.
 *  - A *completed* retry leaves `retrying` unset and, if a call was open
 *    across it, refreshes that call's progress mark — the loop demonstrably
 *    ran, so whatever is open is not what was blocking it.
 *  - An *in-flight* retry is excluded outright by `job.retrying`. The pause is
 *    explained by an observed event; there is nothing to report.
 *
 * The signal that actually separated the two casualties from every healthy job
 * is unchanged and narrow: an unmatched `tool_execution_start` whose last
 * activity is hours old, with `tool_execution_update` as the final line in the
 * file. A healthy job has matched start/end counts (54/54, in that case) and
 * recent activity, and matches nothing here.
 */
function isCandidate(job: StatusJob): boolean {
	if (job.retrying) return false;
	// Belt and braces with `isWedgedToolCall`, which refuses the same job: the
	// silence of any open exchange (a question or a plan review) belongs to a
	// human, not only `ask_operator` (cp-ft3d).
	if (waitingOnOperator(job)) return false;
	return job.alive && job.run_phase === "working" && job.current_tool !== null;
}

/**
 * The one tool whose open call is never a wedge, re-exported here because this
 * is the module that owns the reason (see the note on `isCandidate`).
 */
export { ASK_OPERATOR_TOOL };

/** Pure: which open tool calls have gone silent past the threshold. */
export function detectWedgedToolCalls(snapshot: StatusSnapshot, options: WedgedOptions = {}): WedgedToolCall[] {
	const threshold = options.thresholdSeconds ?? wedgedToolCallSeconds();
	const wedged: WedgedToolCall[] = [];
	for (const job of snapshot.jobs) {
		if (!isCandidate(job) || !job.model) continue;
		if (!isWedgedToolCall(job, threshold)) continue;
		wedged.push({
			job_id: job.job_id,
			tool: job.current_tool as string,
			running_seconds: job.current_tool_seconds ?? 0,
			idle_seconds: job.current_tool_idle_seconds as number,
			worktree: job.worktree,
			branch: job.branch,
			model: job.model,
			threshold_seconds: threshold,
		});
	}
	return wedged;
}

/**
 * The identity of *this* call, for "have I already said this once".
 *
 * `tool_calls` is the run projection's monotonic count of
 * `tool_execution_start` events, so it is the current call's index: it changes
 * the moment a different call opens, and never changes while one call stays
 * open. Using it means the parent does not need the tool call id plumbed onto
 * `StatusJob` just to deduplicate a notice.
 */
function callKey(job: WedgedToolCall, index: number): string {
	return `${job.job_id}#${index}`;
}

/**
 * The stateful half: remembers what has already been announced.
 *
 * Deliberately in-memory. A restarted parent re-announcing a still-wedged call
 * once is correct — it is exactly the news a fresh session needs — whereas a
 * persisted "already told you" file would let a real wedge stay hidden across
 * the restart that was most likely to notice it.
 */
export class WedgedWatch {
	readonly #threshold: number | undefined;
	#announced = new Set<string>();

	constructor(options: WedgedOptions = {}) {
		this.#threshold = options.thresholdSeconds;
	}

	/**
	 * Fold one snapshot in and return only the calls that are **newly** wedged.
	 * A call that stops being wedged (it returned, the worker died, output
	 * resumed) is forgotten, so a later wedge on the same job is news again.
	 */
	observe(snapshot: StatusSnapshot): WedgedToolCall[] {
		const indexByJob = new Map<string, number>();
		for (const job of snapshot.jobs) indexByJob.set(job.job_id, job.tool_calls);
		const wedged = detectWedgedToolCalls(snapshot, this.#threshold === undefined ? {} : { thresholdSeconds: this.#threshold });
		const live = new Set<string>();
		const fresh: WedgedToolCall[] = [];
		for (const call of wedged) {
			const key = callKey(call, indexByJob.get(call.job_id) ?? 0);
			live.add(key);
			if (this.#announced.has(key)) continue;
			fresh.push(call);
		}
		this.#announced = live;
		return fresh;
	}

	/** Test/diagnostic accessor: how many calls are currently announced. */
	get announcedCount(): number {
		return this.#announced.size;
	}
}

/**
 * The operator-facing notice. Headline plus one line per job, naming the tool,
 * the silence, and the two commands that are actually next. It states what is
 * observed and what is *not* concluded, because "possibly wedged" is the
 * honest verdict: a wedge and a genuinely silent long build look identical
 * from here, and only a human can tell them apart.
 */
export function formatWedgedNotice(calls: readonly WedgedToolCall[], projectOf?: ProjectOf): string {
	if (calls.length === 0) return "";
	const threshold = calls[0]?.threshold_seconds ?? WEDGED_TOOL_CALL_SECONDS;
	const lines = [
		calls.length === 1
			? "WEDGED TOOL CALL — 1 worker has an open tool call with no output"
			: `WEDGED TOOL CALLS — ${calls.length} workers have an open tool call with no output`,
	];
	lines.push(
		...projectGroupedLines(
			calls,
			projectOf && ((call) => projectOf(call.job_id)),
			(call) =>
				`  ${call.job_id}: ${call.tool} open ${formatAge(call.running_seconds)}, silent ${formatAge(call.idle_seconds)} (${call.branch} in ${call.worktree})`,
		),
	);
	lines.push(
		`Observed, not concluded: a tool_execution_start with no matching end, quiet past ${formatAge(threshold)}.`,
	);
	lines.push(
		"Nothing was killed and no phase changed. Tell the operator, name the job, and point at /watch <job-id>;",
	);
	lines.push(
		"if it really is wedged, ending it is an operator decision (cp_teardown, or /cp-revive after the worker is gone).",
	);
	return lines.join("\n");
}
