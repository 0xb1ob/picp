/** Run authority intercepts grants before any selection or spending decision. */
import { isoTimestamp, type JobKind, type Usage } from "./contracts.ts";
import { EscalationStore, raiseRiskHigh } from "./escalation.ts";
import { parseJobLabels, type Job } from "./ledger.ts";
import { scheduleIdOf, reviewerUsage, type MandateUsageJob } from "./mandate-accounting.ts";
import { inFlightRecord, type GrantUse } from "./mandate-permission.ts";
import { actionForKind, evaluateAuthority, hitsNeedle, type AuthorityDecision, type MandateSubject } from "./mandate.ts";
import { hardStops, preapprovalRecordCovers, quoteSha } from "./risk-preapproval.ts";
import { runSpend, type ScheduleRunStore } from "./schedule-runs.ts";
import type { ScheduleRun } from "./viewer/schedule-run-core.ts";
import type { SchedulePolicy } from "./viewer/schedule-policy.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";

export interface ScheduleAuthorityContext { home: string; runs: ScheduleRunStore; ledgerJob: (id: string) => Job | undefined }
export interface RunAuthorityJob {
	jobId: string; project: string; kind?: JobKind; risk?: "high" | "low"; pathHints?: readonly string[];
	subsystem?: string; text?: string; script?: boolean; evidence?: readonly string[]; advice?: boolean;
	gateFlags?: MandateSubject["gateFlags"]; checkpoint?: MandateSubject["kind"];
}
export type ScheduleAuthorityCode = "not_member" | "policy_missing" | "policy_corrupt" | "run_closed" | "run_usd_cap" | "run_token_cap" | "child_cap" | "parallelism_full" | "deadline_passed" | "action_not_allowed" | "kind_excluded" | "path_excluded" | "subsystem_excluded" | "risk_high" | "hard_stop";
export class ScheduleAuthorityError extends Error {
	readonly code: ScheduleAuthorityCode;
	readonly runId?: string;
	readonly escalation?: Promise<unknown>;
	constructor(code: ScheduleAuthorityCode, message: string, runId?: string, escalation?: Promise<unknown>) {
		super(message); this.code = code; this.runId = runId; this.escalation = escalation;
	}
}
export type RunVerdict = { source: "mandate" } | { source: "schedule-run"; run: ScheduleRun; snapshot: SchedulePolicy };

/** Advice reads membership and policy only, without auditing, escalation or mutation. */
export function runAuthority(ctx: ScheduleAuthorityContext, jobId: string): RunVerdict {
	const ledger = ctx.ledgerJob(jobId);
	const schedule = scheduleIdOf(ledger?.labels);
	let run: ScheduleRun | undefined;
	try { run = ctx.runs.runOfJob(jobId); }
	catch (error) { throw new ScheduleAuthorityError("policy_corrupt", `schedule run authority unreadable: ${(error as Error).message}`); }
	if (!run && !schedule) return { source: "mandate" };
	let record;
	try { record = ctx.runs.policyRecord(run?.schedule_id ?? schedule!); }
	catch (error) { throw new ScheduleAuthorityError("policy_corrupt", `schedule policy unreadable: ${(error as Error).message}`, run?.id); }
	if (run) {
		if (!record || !record.revisions.some((policy) => policy.revision === run!.policy_revision)) throw new ScheduleAuthorityError("policy_missing", `${run.id}: policy revision missing`, run.id);
		return { source: "schedule-run", run, snapshot: run.policy };
	}
	const open = ctx.runs.openRun(schedule!);
	if (open && (!record || !record.revisions.some((policy) => policy.revision === open.policy_revision))) throw new ScheduleAuthorityError("policy_missing", `${open.id}: policy revision missing`, open.id);
	if (record?.active_revision === null || !record?.activated_at) return { source: "mandate" };
	if (ledger?.created_at && ledger.created_at < record.activated_at) return { source: "mandate" };
	throw new ScheduleAuthorityError("not_member", `${jobId}: activated schedule ${schedule} requires run membership`, ctx.runs.openRun(schedule!)?.id);
}
export function withRunReviewerSpend(home: string, jobs: readonly MandateUsageJob[], run: ScheduleRun): MandateUsageJob[] {
	const byId = new Map(jobs.map((job) => [job.job_id, job]));
	return run.members.map(({ job_id }) => {
		const job = byId.get(job_id) ?? { job_id, project: run.policy.project };
		const usage = reviewerUsage(home, job_id);
		return usage ? { ...job, reviewer_usage: usage } : job;
	});
}
export function runRiskPreapproval(run: ScheduleRun, job: RunAuthorityJob, createdAt?: string): boolean {
	return job.project === run.policy.project && !job.script && hardStops([...(job.pathHints ?? []), job.text ?? ""].join("\n")).length === 0 &&
		preapprovalRecordCovers(run.risk_preapproval, run.members.map((m) => m.job_id), job, createdAt);
}
function audit(ctx: ScheduleAuthorityContext, run: ScheduleRun, use: GrantUse, job: RunAuthorityJob, now: string, code?: string): void {
	ctx.runs.editRun(run.id, (row) => {
		row.authority_log = [...row.authority_log, { at: now, use, job_id: job.jobId, decision: code ? "refuse" : "permit", ...(code ? { code } : {}) }].slice(-200);
		if (!code && (use === "dispatch" || use === "promote") && job.risk === "high" && runRiskPreapproval(row, job, ctx.ledgerJob(job.jobId)?.created_at)) {
			row.risk_preapproved = [...row.risk_preapproved, { at: now, use, job_id: job.jobId, decided_by: "operator-delegated" as const,
				quote_sha: quoteSha(row.risk_preapproval!.operator_quote), evidence: [...(row.trigger.request_id ? [`fire run_now ${row.trigger.request_id}`] : []), ...(job.evidence ?? [])].slice(0, 8).map((s) => s.slice(0, 200)) }].slice(-200);
		}
	});
}
export function scheduleRunVerdict(ctx: ScheduleAuthorityContext, use: GrantUse, job: RunAuthorityJob, jobs: readonly MandateUsageJob[], now = isoTimestamp()): RunVerdict {
	let verdict: RunVerdict;
	try { verdict = runAuthority(ctx, job.jobId); }
	catch (error) {
		if (!job.advice && error instanceof ScheduleAuthorityError && error.runId) {
			const run = ctx.runs.run(error.runId);
			if (run) audit(ctx, run, use, job, now, error.code);
		}
		throw error;
	}
	if (verdict.source === "mandate") return verdict;
	const { run, snapshot: policy } = verdict;
	const refuse = (code: ScheduleAuthorityCode, detail: string, escalation?: Promise<unknown>): never => {
		if (!job.advice) audit(ctx, run, use, job, now, code);
		throw new ScheduleAuthorityError(code, `${job.jobId}: schedule-run ${run.id}: ${detail}`, run.id, escalation);
	};
	const ledger = ctx.ledgerJob(job.jobId);
	const labels = ledger ? parseJobLabels(ledger.labels) : {};
	const risk = job.risk ?? labels.risk;
	const kind = job.kind ?? labels.kind;
	job = { ...job, kind, risk, text: job.text ?? ledger?.description, script: job.script === true || ledger?.script !== undefined };
	const stops = hardStops([...(job.pathHints ?? []), job.text ?? ledger?.description ?? ""].join("\n"));
	if (stops.length || (risk === "high" && policy.ask_on.includes("risk:high"))) {
		const escalations = new EscalationStore({ home: ctx.home });
		const approved = !job.checkpoint && escalations.list({ jobId: job.jobId, kind: "risk_high_irreversible" }).some((row) => row.status === "answered" && (row.answered_by === "operator-quote" || row.answered_by === "operator-delegated") && row.basis && "operator_quote" in row.basis && /^(approve|approved|yes)$/i.test((row.answer ?? "").trim()) && row.question.includes(run.id));
		if (!approved && !(!stops.length && (use === "dispatch" || use === "promote") && runRiskPreapproval(run, job, ledger?.created_at))) {
			if (job.advice) refuse(stops.length ? "hard_stop" : "risk_high", "risk:high requires operator text");
			const raised = raiseRiskHigh(escalations, { jobId: job.jobId, evidence: [`schedule-run ${run.id}`, ...(job.evidence ?? []), ...stops] });
			// Synchronous checkpoint/reviewer consumers still refuse immediately; a failed escalation is named.
			void raised.catch((error) => process.stderr.write(`schedule-run ${run.id}: risk escalation failed: ${(error as Error).message}\n`));
			refuse(stops.length ? "hard_stop" : "risk_high", "risk:high requires operator text", raised);
		}
	}
	if (run.phase === "closed") refuse("run_closed", "run is closed");
	if (run.policy.project !== job.project) refuse("path_excluded", "job project is outside this policy");
	if (run.members.length > policy.limits.child_jobs) refuse("child_cap", "child cap reached");
	const record = inFlightRecord({ ...job, jobKind: kind }, jobs);
	const continuation = record && use !== "implement" && (use !== "dispatch" || record.phase === "failed");
	if (now >= run.deadline_at && !continuation) refuse("deadline_passed", "deadline passed; only same-kind continuation remains");
	const action = use === "dispatch" ? (kind === "research" ? "plan" : "implement") : use === "promote" ? "repair" : use;
	if (!policy.allowed_actions.some((allowed) => allowed === action)) refuse("action_not_allowed", `${action} is not an allowed action`);
	if (job.checkpoint === "final_fix" || Object.values(job.gateFlags ?? {}).some(Boolean)) refuse("action_not_allowed", "flagged or final-fix checkpoint requires operator text");
	if ((use === "implement" && policy.ask_on.includes("plan_approval")) || (use === "merge" && policy.ask_on.includes("merge"))) refuse("action_not_allowed", `ask_on includes ${use === "merge" ? "merge" : "plan_approval"}`);
	if (kind && policy.exclusions.job_kinds?.includes(kind)) refuse("kind_excluded", `${kind} is excluded`);
	for (const needle of policy.exclusions.paths ?? []) {
		if ((job.pathHints ?? []).some((path) => hitsNeedle(path, needle)) || (job.text ?? "").includes(needle)) refuse("path_excluded", `path ${needle} is excluded`);
	}
	for (const subsystem of policy.exclusions.subsystems ?? []) {
		if (subsystem === job.subsystem || (subsystem.length > 0 && (job.text ?? "").includes(subsystem))) refuse("subsystem_excluded", `subsystem ${subsystem} is excluded`);
	}
	const spend = runSpend(run, withRunReviewerSpend(ctx.home, jobs, run));
	if (spend.usd >= policy.limits.usd) refuse("run_usd_cap", "USD cap reached; in-flight work continues");
	if (spend.tokens >= policy.limits.tokens) refuse("run_token_cap", "token cap reached; in-flight work continues");
	if (use === "dispatch" && spend.inFlight >= policy.limits.parallelism) refuse("parallelism_full", "run parallelism is full");
	if (!job.advice) audit(ctx, run, use, { ...job, risk }, now);
	return verdict;
}
export function checkpointAuthority(ctx: ScheduleAuthorityContext, subject: MandateSubject, mandates: readonly import("./contracts.ts").Mandate[]): AuthorityDecision {
	try {
		const result = scheduleRunVerdict(ctx, actionForKind(subject.kind) as GrantUse, { ...subject, kind: subject.jobKind, checkpoint: subject.kind }, subject.usageJobs ?? [], subject.now);
		if (result.source === "mandate") return evaluateAuthority(subject, mandates);
		return { permitted: true, runId: result.run.id, clause: `schedule-run ${result.run.id} (policy rev ${result.run.policy_revision})` };
	} catch (error) {
		if (!(error instanceof ScheduleAuthorityError)) throw error;
		return { permitted: false, reason: error.message };
	}
}
export function observeRunUsage(ctx: ScheduleAuthorityContext & { jobs: () => readonly MandateUsageJob[]; journal: (input: DurableWakeupInput) => void }, jobId: string, prev: Usage, cur: Usage): void {
	const found = runAuthority(ctx, jobId);
	if (found.source === "mandate") return;
	const { run } = found;
	const jobs = ctx.jobs().map((job) => job.job_id === jobId ? { ...job, usage: cur } : job);
	const spend = runSpend(run, withRunReviewerSpend(ctx.home, jobs, run));
	const previousJobs = jobs.map((job) => job.job_id === jobId ? { ...job, usage: prev } : job);
	const before = runSpend(run, withRunReviewerSpend(ctx.home, previousJobs, run));
	for (const axis of ["usd", "tokens"] as const) for (const ratio of [0.8, 1]) {
		const threshold = run.policy.limits[axis] * ratio;
		const key = `${axis}:${ratio}`;
		if (spend[axis] < threshold || before[axis] >= threshold || run.cap_notices.includes(key)) continue;
		ctx.journal({ id: boundedWakeupId(`schedule-run:${run.id}:${key}`), kind: "recovery", job_id: jobId,
			content: `SCHEDULE RUN CAP — ${run.id} (${axis}): no new admission; in-flight work continues; the run closes partial${ratio === 0.8 ? " (80%)" : ""}` });
		ctx.runs.editRun(run.id, (row) => { if (!row.cap_notices.includes(key)) row.cap_notices.push(key); });
	}
}
