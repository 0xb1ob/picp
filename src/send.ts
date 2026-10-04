/**
 * `cp_send` — the only way a new message reaches a live worker.
 *
 * Three deliveries, one receipt vocabulary (`SendReceipt`):
 *
 *  | mode        | when                      | receipt     |
 *  |-------------|---------------------------|-------------|
 *  | `prompt`    | the worker is idle        | `delivered` (pi started it, or a handler consumed it) |
 *  | `steer`     | mid-run, change course    | `queued` (or `delivered` if an input handler consumed it) |
 *  | `follow_up` | mid-run, queue for after  | `queued` (or `delivered` if an input handler consumed it) |
 *
 * Receipts come from pi's per-input `disposition`, never from the busy flag.
 *
 * "delivered" means pi accepted the user message, **not** that the model
 * complied. A bare `prompt` to a busy worker is rejected by pi and reported
 * honestly as `failed` — never dressed up as queued.
 *
 * Promotion policy is ported: promote = same worker, same worktree, **same
 * model**. A cross-model role hop (planner → implementer) is teardown plus a
 * fresh dispatch, and is refused here.
 *
 * One invariant governs the rest: **a worker that can be given work must have
 * a way to report it.** Promoting a job that already filed an envelope reopens
 * its envelope slot first (`src/supersede.ts`), so the promoted run ends in a
 * report instead of in silence; a job whose delivery has landed is refused,
 * naming teardown + fresh dispatch. There is no third outcome: this send never
 * hands out work that could not be reported.
 *
 * A second invariant guards the queue itself (cp-send-idle-steer): a `steer`
 * or `follow_up` is only ever flushed by a turn that is already running, so
 * an explicit request for either against an **idle** worker is refused, not
 * silently accepted and left to sit in an empty queue forever — `auto` never
 * needs this, because it already resolves to `prompt` for an idle worker.
 */

import { isScriptFleetRecord, type Risk, type SendReceipt } from "./contracts.ts";
import { readTask, type ResolvedTask } from "./dispatch.ts";
import { type BudgetCheck, checkBudget } from "./failures.ts";
import type { FleetStore } from "./fleet.ts";
import type { MandateStore } from "./mandate.ts";
import { decidePlanSend, recordPlanRevise, vetoedReviseRefusal } from "./plan-followup.ts";
import { inferScopeAndRisk } from "./pipeline.ts";
import { LIVE_PHASES } from "./preflight.ts";
import { assertNotDraining } from "./drain.ts";
import { inferredRiskGate, recordedProvenance, recordedRisk } from "./risk-warning.ts";
import { rebuildStatus } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import { decideReopen, reopenEnvelopeSlot, type Supersession, type TaskUpdate, updateFrozenTask } from "./supersede.ts";
import { type BudgetSource, resolveBudgetSource } from "./worker-manager.ts";
import { readTaskAddenda, taskAddendaText } from "./task-addenda.ts";
import type { WorkerManager } from "./worker-manager.ts";

export class SendError extends Error {}

export const SEND_MODES = ["auto", "prompt", "steer", "follow_up"] as const;
export type SendMode = (typeof SEND_MODES)[number];
export type DeliveryMode = Exclude<SendMode, "auto">;

export interface SendRequest {
	jobId: string;
	message: string;
	/** `auto` picks `prompt` when idle and `steer` when busy. */
	mode?: SendMode;
	/**
	 * The model this message assumes it is talking to. When given, it must be
	 * the worker's model: that is the promote rule, checked rather than trusted.
	 */
	model?: string;
	/**
	 * Replace the frozen task a diff reviewer scores against (cp-promote-task-
	 * record) with this text. Accepted only for a genuine promotion of an IDLE
	 * worker — the mode this send resolves to must be `prompt` and the worker
	 * must not be busy — same as dispatch's `task`; never for a `steer` or
	 * `follow_up`, which must not silently rewrite scope. Applied only once the
	 * worker actually took the message (`receipt: "delivered"`); a failed send
	 * leaves the frozen task untouched. Mutually exclusive with `taskFile`.
	 */
	task?: string;
	/**
	 * Same as `task`, from a file (the ported `--task-file` for a promotion).
	 * Read in full, exactly like `DispatchRequest.taskFile`.
	 */
	taskFile?: string;
	/**
	 * `repair`: a fix asked of the job's own implementer (cp_integrate conflict/red CI, a diff-review revise). Gated
	 * as the mandate's `repair` use before delivery; a ship brief (`task`/`taskFile`) is a `promote` instead.
	 */
	purpose?: "repair";
}

export interface SendResult {
	job_id: string;
	worker: string;
	mode: DeliveryMode;
	receipt: SendReceipt;
	busy_before: boolean;
	error?: string;
	/** The soft gate's verdict at the moment of delivery. */
	budget?: BudgetCheck;
	/**
	 * Set when this promote reopened a filed envelope slot: the job went back to
	 * `waiting` and the next `report_result` is accepted, not refused.
	 */
	superseded?: Supersession;
	/** Set when this send replaced the frozen task (`task`/`taskFile` given). */
	task_updated?: TaskUpdate;
	/** H6: an inferred-only risk:high against a recorded low promoted under ask_on risk:high; one line naming the keywords. */
	risk_warning?: string;
}

export interface SenderOptions {
	fleet: FleetStore;
	manager: WorkerManager;
	runs: RunRegistry;
	/** Command post home; needed to read a run projection we did not open. */
	home?: string;
	/**
	 * A live value or a getter (cp-sr5). Pass a getter that re-reads
	 * `data/budgets.json` so a raise reaches the very next send — the soft
	 * gate this feeds (`warn_ratio`) must not run on a config snapshot frozen
	 * at construction while the per-job ceiling itself (`record.budget`, set at
	 * dispatch) stays intentionally frozen for the run's lifetime.
	 */
	budgets?: BudgetSource;
	/** When present, a paused/capped mandate or an unauthorized risk:high ship brief refuses this promotion. */
	mandates?: MandateStore;
	/**
	 * A delivered prompt starts a new round: the hard wall-clock
	 * bound restarts (`HardBoundsWatch.rearm`). Never called for a steer, a
	 * follow_up, or a send that failed. Returns whether a watch was rearmed.
	 */
	onPromptDelivered?: (jobId: string) => boolean;
	/** 4b-1: relaunch a job whose idle worker HeldRelease stopped; used only when `released(jobId)` is true. */
	revive?: (jobId: string) => Promise<unknown>;
	/** 4b-1: was this job's process last stopped by HeldRelease (and not revived since)? */
	released?: (jobId: string) => boolean;
}

const MARKER_FOR_MODE: Readonly<Record<DeliveryMode, "prompt_sent" | "steer_sent" | "follow_up_sent">> = Object.freeze({
	prompt: "prompt_sent",
	steer: "steer_sent",
	follow_up: "follow_up_sent",
});

export class Sender {
	readonly #options: SenderOptions;
	/** In-flight sends per job (a counter: two concurrent sends to one job both count). */
	readonly #sending = new Map<string, number>();

	constructor(options: SenderOptions) {
		this.#options = options;
	}

	/** True while a send to this job is in flight (HeldRelease never releases it then). */
	sending(jobId: string): boolean {
		return (this.#sending.get(jobId) ?? 0) > 0;
	}

	async send(request: SendRequest): Promise<SendResult> {
		this.#sending.set(request.jobId, (this.#sending.get(request.jobId) ?? 0) + 1);
		try {
			return await this.#send(request);
		} finally {
			const left = (this.#sending.get(request.jobId) ?? 1) - 1;
			if (left > 0) this.#sending.set(request.jobId, left);
			else this.#sending.delete(request.jobId);
		}
	}

	async #send(request: SendRequest): Promise<SendResult> {
		const { fleet, manager, runs } = this.#options;
		let message = request.message.trim();
		if (message.length === 0) throw new SendError(`cp_send ${request.jobId}: empty message`);

		// Conversation revise / planner question (cp-command-post-autonomy-programme-cur.3.3):
		// the operator's own words, mapped in AGENTS.md, become this promote's message. Code
		// only enforces the two invariants the AGENTS.md prose cannot: refuse a revise once the
		// plan checkpoint is approved and the implementer is dispatched, and one open revise at a
		// time per job. A message that is neither phrase nor marker is untouched (`ignore`).
		const home = this.#options.home ?? fleet.home;
		const planDecision = decidePlanSend({
			home,
			jobId: request.jobId,
			message,
			implementerDispatched: (shipId) => Boolean(fleet.get(shipId)),
		});
		if (planDecision.kind === "refuse") throw new SendError(planDecision.reason);
		if (planDecision.kind !== "ignore") message = planDecision.message;
		// N4: a veto-forced escalate already spent the one revise; free text must not reopen it.
		const vetoed = vetoedReviseRefusal(home, request.jobId, message);
		if (vetoed) throw new SendError(vetoed);

		const record = fleet.get(request.jobId);
		if (!record) {
			throw new SendError(`no fleet record for ${request.jobId} — dispatch it first (cp_dispatch)`);
		}
		if (isScriptFleetRecord(record)) throw new SendError(`${request.jobId} is a script job; cp_send cannot promote or replay it`);
		if (record.phase === "failed") {
			throw new SendError(
				`${request.jobId} is failed (${record.failure?.class ?? "no class recorded"}); a brief does not revive it. Continue it on ` +
					`its original lease: cp_revive ${request.jobId} continue_failed:true (plan, then confirm), then cp_send — never a ` +
					"takeover job, a new branch or a force push.",
			);
		}
		if (!LIVE_PHASES.includes(record.phase)) {
			throw new SendError(
				`${request.jobId} is ${record.phase}; there is nothing to promote. A finished job is teardown + fresh dispatch ` +
					`(cp_teardown ${request.jobId}, then cp_dispatch a new job id), never a brief to a closed envelope slot.`,
			);
		}

		// The invariant, checked before anything is delivered: could a report for
		// this brief still be accepted? A landed delivery cannot be reopened, and
		// that is a refusal with a path, never a silently unreportable promote.
		const reopen = decideReopen(record);
		if (reopen.kind === "refuse") throw new SendError(reopen.reason);

		// Mandate permission for a repair comes first: a refused repair never relaunches a released worker.
		if (request.purpose === "repair" && request.task === undefined && request.taskFile === undefined && this.#options.mandates) {
			try {
				this.#options.mandates.assertPermitted("repair", { jobId: request.jobId, project: record.project, kind: record.kind }, fleet.read().jobs);
			} catch (error) {
				throw new SendError((error as Error).message);
			}
		}

		// 4b-1: never deliver into a worker HeldRelease is stopping; wait for its observed exit, then restore it.
		// Draining wins first: waiting out a stop or restoring a released worker would start new work.
		const stopping = manager.whenStopped(request.jobId);
		if (stopping) {
			assertNotDraining(home, `promotion or send to stopping ${request.jobId}`);
			await stopping.catch(() => undefined); // a failed stop is HeldRelease's to report; the re-read below decides
		}
		let managed = manager.get(request.jobId);
		const noLiveWorker = () =>
			`${request.jobId} has no live worker in this session (fleet phase ${record.phase}, pid ${record.worker.pid}). ` +
			`cp_revive ${request.jobId} to relaunch it from ${record.worker.session_file || "its session file"}, or tear the job down.`;
		if (!managed && this.#options.revive && this.#options.released?.(request.jobId)) {
			assertNotDraining(home, `restore of released ${request.jobId}`);
			try {
				await this.#options.revive(request.jobId);
			} catch (error) {
				throw new SendError(`${noLiveWorker()} Restoring the released worker failed: ${(error as Error).message}`);
			}
			managed = manager.get(request.jobId);
		}
		if (!managed || !managed.worker.alive) {
			throw new SendError(noLiveWorker());
		}
		if (request.model && request.model !== managed.model) {
			throw new SendError(
				`${request.jobId} runs ${managed.model}, not ${request.model} — a cross-model role hop is teardown + fresh dispatch, never a promote`,
			);
		}

		// The idle-steer trap (cp-send-idle-steer): `steer` is only flushed "after
		// the current assistant turn", and `follow_up` only "when the agent
		// finishes" — both require a turn that is already running. A settled
		// worker (reported or not) has no such turn, so an explicit steer/follow_up
		// sent to one does not fail, it QUEUES — pi answers `success: true`, this
		// method would return `queued`, and nothing will ever consume it: no new
		// turn starts on its own, so the message (and the job) sits idle forever
		// looking "queued", not stuck. Auto mode never causes this (it already
		// picks `prompt` for an idle worker below), so this only fires when the
		// caller explicitly asked to steer/follow-up a worker that is not busy.
		// Checked before any side effect (budget events, envelope reopen, settle
		// clear) so a refused send changes nothing.
		// A drain lets a running turn settle, so only a steer into a busy worker's run passes. Anything else
		// (a prompt or brief, any send to an idle worker, a follow_up that queues a turn after the settle point)
		// starts or queues new work, and names the drain instead.
		const steerIntoRun = managed.worker.busy && (request.mode === undefined || request.mode === "auto" || request.mode === "steer") && request.task === undefined && request.taskFile === undefined;
		if (!steerIntoRun) assertNotDraining(home, `promotion or ${request.mode ?? "auto"} send to ${managed.worker.busy ? "busy" : "idle"} ${request.jobId}`);
		if ((request.mode === "steer" || request.mode === "follow_up") && !managed.worker.busy) {
			throw new SendError(
				`${request.jobId} is idle, not mid-turn: a "${request.mode}" message queues for a turn that is not ` +
					`running, and pi will never start one on its own to deliver it — it would sit queued forever and the ` +
					`job would look busy when it is not. Send it as mode: "prompt" (or omit mode / use "auto") to reach an ` +
					`idle worker.`,
			);
		}

		const busy = managed.worker.busy;
		const mode: DeliveryMode = request.mode && request.mode !== "auto" ? request.mode : busy ? "steer" : "prompt";

		// cp-promote-task-record: a scope change only becomes the frozen task a
		// reviewer scores against when it arrives through a genuine promotion of an
		// IDLE worker — the actual promote case, not merely a send that resolved to
		// the word "prompt". An ordinary steer or follow_up is mid-run guidance to a
		// worker already acting on the frozen brief, never a redefinition of it, and
		// an explicit `mode: "prompt"` aimed at a worker that is still busy is not a
		// promotion either — pi will refuse that bare prompt outright, so a task
		// replacement gated only on the mode string would still fire before the
		// worker ever saw the new scope. Validated here (nothing mutated yet); the
		// resolved text is applied below only once `outcome.receipt === "delivered"`,
		// so a failed or refused send — for any reason, including this one — leaves
		// the frozen task exactly as it was.
		let resolvedTask: ResolvedTask | undefined;
		if (request.task !== undefined || request.taskFile !== undefined) {
			if (mode !== "prompt" || busy) {
				throw new SendError(
					`${request.jobId}: task/taskFile is only accepted with a promotion of an idle worker (mode "prompt"); this send ` +
						`resolved to "${mode}"${busy ? " against a busy worker" : ""}. A steer, a follow_up, or a prompt aimed at a worker ` +
						"still mid-turn must never rewrite the frozen task a diff reviewer scores against — wait for it to settle, then promote it.",
				);
			}
			resolvedTask = readTask({ jobId: request.jobId, task: request.task, taskFile: request.taskFile });
		}

		// risk:high gates this promotion exactly like a direct dispatch
		// (pi-command-post-autonomy-programme-cur.2.4): a promoted ship brief is a
		// fresh implementer brief, and a caller must not be able to bypass the
		// dispatch gate by starting a job low-risk and promoting risky work into it.
		// Checked here \u2014 validated, nothing mutated yet \u2014 from the new brief's own
		// words, the same signal set `cp_dispatch` reads.
		let riskWarning: string | undefined;
		if (resolvedTask && record.kind === "ship" && this.#options.mandates) {
			const assessed = inferScopeAndRisk(resolvedTask.forInference);
			const routing = record.routing;
			const routedFrom = routing?.risk === "high" ? (routing.provenance?.risk ?? "inferred") : assessed.risk ? "inferred" : "defaulted";
			// H6: the risk a parent or planner recorded at dispatch, or the new task's header declares; an inferred-only high then warns, not gates.
			const recorded = recordedRisk({ ...(routing?.risk && recordedProvenance(routing.provenance?.risk) ? { requested: routing.risk } : {}), ...(routing?.recorded_risk ? { fleet: routing.recorded_risk } : {}), taskText: resolvedTask.forInference });
			const gate = inferredRiskGate({
				mandates: this.#options.mandates,
				job: { jobId: request.jobId, project: record.project, kind: record.kind, pathHints: [resolvedTask.forInference] },
				routed: routing?.risk === "high" ? "high" : (assessed.risk ?? "low"),
				routedFrom,
				...(recorded ? { recorded: recorded.risk, recordedFrom: recorded.from } : {}),
				text: resolvedTask.forInference,
			});
			const risk: Risk = gate.risk;
			riskWarning = gate.warning;
			try {
				await this.#options.mandates.assertDispatchAllowed(
					{
						jobId: request.jobId,
						project: record.project,
						kind: record.kind,
						pathHints: [resolvedTask.forInference],
						risk,
						evidence: [...(assessed.riskReason ? [assessed.riskReason] : []), ...(gate.evidence ? [gate.evidence] : [])],
						promotion: true,
					},
					fleet.read().jobs,
				);
			} catch (error) {
				throw new SendError((error as Error).message);
			}
		}

		message += taskAddendaText(readTaskAddenda(home, request.jobId));

		// Soft budget gate: checked from usage events BEFORE the next message.
		// A breach escalates to the operator and is carried on the receipt, but it
		// never severs parent -> worker delivery: the message that fixes a run
		// (a steer) is the cheapest correction there is, and blocking it does not
		// save a token — the worker keeps running and burning them regardless,
		// just without the correction (cp-d7y). The effective ceiling is also
		// frozen into the run at dispatch, so a mid-run budget edit cannot change
		// it anyway; refusing the send and pointing at data/budgets.json was
		// advice that could not work for the exact situation that triggered it.
		const budget = this.#checkBudget(request.jobId);
		if (budget?.state === "exceeded") {
			runs.open(request.jobId).cp("budget_exceeded", { ...budget });
		}
		if (budget?.state === "warn") {
			runs.open(request.jobId).cp("budget_warning", { ...budget });
		}

		// Reopen BEFORE delivering: for the window between the two, the worker must
		// never be holding work it cannot report (see supersede.ts for the ordering
		// argument). A promote that changes nothing here returns undefined.
		const superseded = await reopenEnvelopeSlot({
			home: this.#options.home ?? fleet.home,
			fleet,
			runs,
			jobId: request.jobId,
			reason: `promoted with a new brief (cp_send ${request.mode ?? "auto"})`,
		});
		// Same invariant from the other side (cp-settle-without-report): a new brief
		// is a new chance to report, so the settle nudge budget resets with it. A
		// worker that used its one nudge on the previous brief still gets one for
		// this one — the bound is per brief, never per job lifetime.
		await fleet.clearUnreportedSettles(request.jobId);

		const outcome = await managed.worker.send(message, mode);

		// Same delivered-only rule as the task-replacement below: a revise that was never
		// actually taken by the worker must not close the one-open-revise window.
		if (planDecision.kind === "revise" && outcome.receipt === "delivered") {
			recordPlanRevise(home, planDecision.researchId, planDecision.text, new Date().toISOString());
		}

		const rearmed = mode === "prompt" && outcome.receipt === "delivered" && this.#options.onPromptDelivered?.(request.jobId) === true;

		// The marker is written whatever the receipt says: a refused delivery is
		// exactly the kind of fact a run log exists to keep.
		runs.open(request.jobId).cp(MARKER_FOR_MODE[mode], {
			receipt: outcome.receipt,
			...(outcome.disposition ? { disposition: outcome.disposition } : {}),
			bytes: message.length,
			busy_before: busy,
			...(rearmed ? { wall_clock_rearmed: true } : {}),
			...(superseded ? { superseded_generation: superseded.generation } : {}),
			...(outcome.error ? { error: outcome.error } : {}),
			...(riskWarning ? { risk_warning: riskWarning } : {}),
		});

		// Applied only now, after the worker actually took the brief: a delivery
		// that failed (a race that made the worker busy between the guard above and
		// this send, pi refusing the prompt, anything else) must leave the frozen
		// task exactly as it was, never replaced for a brief nobody received.
		let taskUpdate: TaskUpdate | undefined;
		if (resolvedTask && outcome.receipt === "delivered") {
			const generation = (record.task_generations ?? 0) + 1;
			taskUpdate = updateFrozenTask({
				home: this.#options.home ?? fleet.home,
				jobId: request.jobId,
				generation,
				text: resolvedTask.forInference,
				source: request.taskFile !== undefined ? "task_file" : "task",
			});
			await fleet.mutate((jobs) => {
				const job = jobs.find((candidate) => candidate.job_id === request.jobId);
				if (!job) throw new SendError(`no fleet record for ${request.jobId}`);
				job.task_generations = generation;
			});
			runs.open(request.jobId).cp("original_task_updated", { ...taskUpdate });
		}

		return {
			job_id: request.jobId,
			worker: request.jobId,
			mode,
			receipt: outcome.receipt,
			busy_before: busy,
			...(outcome.error ? { error: outcome.error } : {}),
			...(budget ? { budget } : {}),
			...(superseded ? { superseded } : {}),
			...(taskUpdate ? { task_updated: taskUpdate } : {}),
			...(riskWarning ? { risk_warning: riskWarning } : {}),
		};
	}

	/** Usage comes from the run projection; limits from the job's record. */
	#checkBudget(jobId: string): BudgetCheck | undefined {
		const record = this.#options.fleet.get(jobId);
		const limits = record?.budget;
		if (!record || !limits) return undefined;
		const live = this.#options.runs.get(jobId)?.status.usage;
		const usage = live ?? (this.#options.home ? rebuildStatus(this.#options.home, jobId).usage : record.usage);
		return checkBudget(usage, limits, resolveBudgetSource(this.#options.budgets));
	}
}
