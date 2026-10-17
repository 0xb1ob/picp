/** Native schedule runs: one start key, one frozen execution, an idempotent anchor (docs/contracts.md). */
import { randomBytes } from "node:crypto";
import { isoTimestamp, type JobKind } from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import { effectivePolicyBounds } from "./schedule-policy.ts";
import { refused, type MintContext, type Refusal } from "./schedule-grant.ts";
import { reconcileRun, type ScheduleRunStore } from "./schedule-runs.ts";
import type { Schedule } from "./viewer/schedule-core.ts";
import { isNativePolicy, runOverrideErrors, type NativeSchedulePolicy, type RunOverrides } from "./viewer/schedule-policy.ts";
import type { RunExecution, ScheduleRun } from "./viewer/schedule-run-core.ts";
import { RUNNER_DELIVERIES } from "./schedule-runner.ts";
import type { ScheduleEvent } from "./scheduler.ts";

/** Who asked; audit metadata only, never authority. */
export type NativeTrigger =
	| { via: "dashboard"; request_id: string; peer: string | null; overrides?: RunOverrides }
	| { via: "cp_schedule"; tool_call_id: string; overrides?: RunOverrides };
export interface NativeStarted { job_id?: string; run_id: string; reason: string; replayed?: true }

/** The idempotency key of a start: the trusted request or tool call, or the fired slot. */
export function startKeyOf(schedule: Pick<Schedule, "trigger">, slot: Date, manual?: NativeTrigger): string {
	if (manual) return manual.via === "dashboard" ? `dashboard:${manual.request_id}` : `cp_schedule:${manual.tool_call_id}`;
	return `${schedule.trigger.type === "watch" ? "watch" : "slot"}:${isoTimestamp(slot)}`;
}

/** Validated before any job exists: a run override wins, then the saved role pin, then routing. */
export function resolveExecution(policy: NativeSchedulePolicy, overrides: RunOverrides = {}): RunExecution | Refusal {
	const errors = runOverrideErrors(overrides);
	if (errors.length) return { refusal: `run overrides refused: ${errors.join("; ")}` };
	if (policy.recipe.script_path !== undefined && (overrides.model !== undefined || overrides.thinking !== undefined)) return { refusal: "a script_path recipe runs no model: model and thinking overrides are refused" };
	return {
		requested: structuredClone(overrides),
		effective: { ...(overrides.model ? { model: overrides.model } : {}), ...(overrides.thinking ? { thinking: overrides.thinking } : {}), parallelism: overrides.parallelism ?? policy.limits.parallelism },
	};
}

/** A native member's run, else undefined (legacy runs and non-members keep their existing paths). */
export function nativeRunOf(runs: ScheduleRunStore | undefined, jobId: string): ScheduleRun | undefined {
	const run = runs?.active ? runs.runOfJob(jobId) : undefined;
	return run && isNativePolicy(run.policy) && run.execution ? run : undefined;
}

/** The run-wide model override, else the frozen policy's pin for `role`; undefined defers to routing. */
export function runModelFor(run: ScheduleRun, role: "planner" | "implementer" | "reviewer"): string | undefined {
	if (!isNativePolicy(run.policy)) return undefined;
	const pins = run.policy.model_policy.mode === "pinned" ? run.policy.model_policy.by_role : {};
	return run.execution?.effective.model ?? pins[role];
}

/** A member's dispatch uses the run's frozen model and thinking; a conflicting per-job argument is replaced. */
export function withRunExecution<T extends { jobId: string; model?: string; thinking?: unknown }>(request: T, runs: ScheduleRunStore | undefined, kind: JobKind): T {
	const run = nativeRunOf(runs, request.jobId);
	if (!run) return request;
	const model = runModelFor(run, kind === "research" ? "planner" : "implementer");
	const thinking = run.execution?.effective.thinking as T["thinking"] | undefined;
	return { ...request, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

interface StartInput {
	runs: ScheduleRunStore; ledger: Ledger; schedule: Schedule; policy: NativeSchedulePolicy; context: () => MintContext | Refusal;
	title: string; now: Date; slot: Date; missed: boolean; missedAt: Date; manual?: NativeTrigger;
}

/** Creates or finds (by its `under run <id>` note) the run's anchor, then attaches it; heals an accepted run. */
async function ensureAnchor(input: StartInput, run: ScheduleRun): Promise<string | undefined> {
	if (run.anchor_job_id || run.phase === "closed") return run.anchor_job_id ?? undefined;
	const { ledger, runs, schedule, manual } = input;
	const label = `schedule:${schedule.id}`;
	let id = reconcileRun(run, await ledger.list({ labels: [label], all: true })).anchor_job_id;
	let admitted = run.started_at;
	if (!id) {
		const created = await ledger.create({
			title: input.title, project: schedule.project, kind: schedule.job.kind, delivery: schedule.job.delivery, labels: [label],
			...(schedule.job.description ? { description: schedule.job.description } : {}),
			...(schedule.job.script_path !== undefined ? { scriptPath: schedule.job.script_path } : {}),
		});
		const via = manual?.via === "dashboard" ? `run now from the dashboard (${manual.request_id})` : manual ? `run now via cp_schedule (${manual.tool_call_id})` : "scheduled";
		const notes = `${via} for ${schedule.id} (${schedule.name}) under run ${run.id} (native policy rev ${run.policy_revision}; start ${run.start_key})`;
		await ledger.update(created.id, { notes, ...(schedule.job.skill ? { status: "deferred" as const } : {}) });
		id = created.id;
		admitted = created.created_at;
	}
	await runs.attachAnchor(run.id, { job_id: id, role: null, admitted_at: admitted });
	if (run.phase === "accepted") await runs.setPhase(run.id, "running");
	return id;
}

const executionLine = (execution: RunExecution): string =>
	[execution.effective.model ? `model ${execution.effective.model}` : "", execution.effective.thinking ? `thinking ${execution.effective.thinking}` : "", `parallelism ${execution.effective.parallelism}`].filter(Boolean).join(", ");

/** One native start in the fire lane: a replayed key returns its run, an open run refuses, nothing is asked. */
export async function nativeStart(input: StartInput): Promise<NativeStarted | Refusal> {
	const { runs, schedule, policy, now, manual } = input;
	const startKey = startKeyOf(schedule, input.slot, manual);
	const prior = runs.runs().find((run) => run.start_key === startKey);
	if (prior) {
		const anchor = await ensureAnchor(input, prior);
		return { ...(anchor ? { job_id: anchor } : {}), run_id: prior.id, replayed: true, reason: `start ${startKey} was already accepted as run ${prior.id} (${prior.phase}); nothing new dispatched` };
	}
	const open = runs.openRun(schedule.id);
	if (open) return { refusal: `already_running: schedule ${schedule.id} has open run ${open.id}` };
	const recipe = policy.recipe;
	if ((["title", "kind", "delivery", "description", "script_path"] as const).some((key) => schedule.job[key] !== recipe[key]) || (schedule.job.skill ?? null) !== recipe.skill) return { refusal: `schedule ${schedule.id}: saved policy recipe differs from the schedule` };
	const execution = resolveExecution(policy, manual?.overrides);
	if (refused(execution)) return execution;
	const context = input.context();
	if (refused(context)) return context;
	const bounds = effectivePolicyBounds(policy, context, schedule.project, recipe.kind, now);
	if (refused(bounds)) return bounds;
	const stamp = isoTimestamp(now), id = `run-${stamp.replace(/[^0-9]/g, "")}-${randomBytes(3).toString("hex")}`;
	const snapshot = { ...structuredClone(policy), limits: bounds.limits, exclusions: bounds.exclusions };
	const run = await runs.createRun({
		schema_version: 1, id, schedule_id: schedule.id, policy_revision: policy.revision, policy: snapshot, start_key: startKey, execution,
		trigger: { via: manual?.via ?? (schedule.trigger.type === "watch" ? "watch" : "slot"), at: stamp, slot: isoTimestamp(input.slot), missed: input.missed, ...(manual?.via === "dashboard" ? { request_id: manual.request_id } : manual ? { tool_call_id: manual.tool_call_id } : {}) },
		anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: stamp,
		deadline_at: isoTimestamp(new Date(now.getTime() + snapshot.limits.run_hours * 3_600_000)), risk_preapproved: [], authority_log: [], cap_notices: [],
	});
	const anchor = await ensureAnchor(input, run);
	return { ...(anchor ? { job_id: anchor } : {}), run_id: id, reason: `created ${anchor} under run ${id} (native policy rev ${policy.revision}; ${executionLine(execution)}); no grant minted, nothing asked` };
}

/** Native wording: the saved revision authorized the run, so no quote, grant or approval is mentioned. */
export function formatNativeEvent(event: Pick<ScheduleEvent, "reason" | "job_id" | "run_id" | "delivery" | "skill" | "schedule_id" | "manual" | "manual_via" | "missed_at" | "replayed">, head: string): string {
	const via = event.manual ? `; run now via ${event.manual_via === "cp_schedule" ? "cp_schedule" : "the dashboard"} (${event.manual})` : "";
	const fired = `${head} ${event.replayed ? "replayed" : "fired"}: ${event.reason}${event.missed_at ? `; missed ${event.missed_at} while no parent was up` : ""}${via}. `;
	if (event.replayed) return `${fired}Nothing new to do.`;
	if (event.skill) return `${fired}${event.job_id} is a parent-expanded run (deferred anchor) of ${event.run_id}: use skill ${event.skill} to expand it — its jobs carry label schedule:${event.schedule_id}; never dispatch the anchor.`;
	if (event.delivery === "pipeline") return `${fired}The schedule host starts its pipeline in code under ${event.run_id}; no cp_pipeline start needed.`;
	return fired + (RUNNER_DELIVERIES.includes(event.delivery ?? "")
		? `${event.job_id} is dispatched by the schedule runner under ${event.run_id}; no cp_next needed.`
		: `Call cp_next: ${event.job_id} is a member of ${event.run_id}; the saved policy's caps, scope and review apply, nothing to ask.`);
}
