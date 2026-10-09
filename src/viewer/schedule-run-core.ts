/** Read-only, dependency-free schedule run contracts; P2a writes are inert. */
import { existsSync, readFileSync } from "node:fs";
import { boolean, ISO_SECOND, line, lines, number, object, oneOf, pattern, SCHEDULE_ID, text, type Check } from "./schedule-core.ts";
import { schedulePolicyErrors, type SchedulePolicy } from "./schedule-policy.ts";

export class ScheduleRunError extends Error {}
export const SCHEDULE_RUN_ID = /^run-[0-9]{14}-[0-9a-f]{6}$/;
export interface ScheduleRunMember { job_id: string; role: string | null; admitted_at: string }
// Structural mirrors of RiskPreapproval and RiskPreapprovedRow; no contracts runtime in the viewer.
export interface RiskPreapproval {
	operator_quote: string; decided_by: "operator-quote" | "operator-delegated"; delegation_rule?: string; send_id?: string;
	job_ids?: string[]; scope: "named_jobs" | "mandate_jobs"; granted_at: string;
}
export interface RiskPreapprovedRow {
	at: string; job_id: string; use: "dispatch" | "promote"; decided_by: "operator-delegated"; quote_sha: string; evidence: string[];
}
export interface ScheduleRun {
	schema_version: 1; id: string; schedule_id: string; policy_revision: number; policy: SchedulePolicy;
	trigger: { via: "slot" | "watch" | "dashboard" | "cp_schedule"; at: string; slot?: string; missed?: boolean; request_id?: string; tool_call_id?: string; quote_sha?: string };
	anchor_job_id: string | null; members: ScheduleRunMember[]; phase: "accepted" | "running" | "closed";
	outcome: "completed" | "partial" | "refused" | null; started_at: string; deadline_at: string; closed_at?: string;
	risk_preapproval?: RiskPreapproval; risk_preapproved: RiskPreapprovedRow[];
	authority_log: Array<{ at: string; use: string; job_id: string; decision: string; code?: string }>;
	cap_notices: string[];
}
export interface PolicyRecord {
	schedule_id: string; revisions: SchedulePolicy[]; active_revision: number | null; activated_at: string | null;
	activation: SchedulePolicy["provenance"] | null;
}
const at = pattern(ISO_SECOND);
const jobId = pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const positive = number(1, Number.MAX_SAFE_INTEGER, true);
const nullable = (check: Check): Check => (v, p, e) => { if (v !== null) check(v, p, e); };
const array = (check: Check, max = Number.MAX_SAFE_INTEGER, min = 0): Check => (v, p, e) => {
	if (!Array.isArray(v) || v.length < min || v.length > max) e.push(`${p}: must be an array of ${min}-${max} items`);
	else v.forEach((item, i) => check(item, `${p}/${i}`, e));
};
const policy: Check = (v, p, e) => e.push(...schedulePolicyErrors(v).map((error) => `${p}${error}`));
const provenance = object({
	channel: oneOf(["dashboard", "cp_schedule", "migration"]), "request_id?": line(200), "tool_call_id?": line(200),
	"send_id?": pattern(/^ps-[0-9]{14}-[0-9a-f]{8}$/), "delegation_rule?": text(300), "quote_sha?": pattern(/^[0-9a-f]{12}$/),
	"legacy_seed?": pattern(/^md-[a-z0-9]{4,16}$/), "recipe_sha?": pattern(/^[0-9a-f]{64}$/),
});
const member = object({ job_id: jobId, role: nullable(line(200)), admitted_at: at });
const runShape = object({
	schema_version: oneOf([1]), id: pattern(SCHEDULE_RUN_ID), schedule_id: pattern(SCHEDULE_ID), policy_revision: positive, policy,
	trigger: object({ via: oneOf(["slot", "watch", "dashboard", "cp_schedule"]), at, "slot?": line(100), "missed?": boolean, "request_id?": line(200), "tool_call_id?": line(200), "quote_sha?": pattern(/^[0-9a-f]{12}$/) }),
	anchor_job_id: nullable(jobId), members: array(member), phase: oneOf(["accepted", "running", "closed"]), outcome: oneOf([null, "completed", "partial", "refused"]),
	started_at: at, deadline_at: at, "closed_at?": at,
	"risk_preapproval?": object({ operator_quote: text(4000), decided_by: oneOf(["operator-quote", "operator-delegated"]), "delegation_rule?": text(300), "send_id?": pattern(/^ps-[0-9]{14}-[0-9a-f]{8}$/), "job_ids?": array(jobId, 64, 1), scope: oneOf(["named_jobs", "mandate_jobs"]), granted_at: at }),
	risk_preapproved: array(object({ at, job_id: jobId, use: oneOf(["dispatch", "promote"]), decided_by: oneOf(["operator-delegated"]), quote_sha: pattern(/^[0-9a-f]{12}$/), evidence: lines(200, 8) }), 200),
	authority_log: array(object({ at, use: line(100), job_id: jobId, decision: line(100), "code?": line(200) }), 200), cap_notices: lines(200, Number.MAX_SAFE_INTEGER),
});
export function scheduleRunErrors(value: unknown): string[] {
	const errors: string[] = [];
	runShape(value, "", errors);
	if (errors.length) return errors;
	const run = value as ScheduleRun;
	if (run.policy.schedule_id !== run.schedule_id || run.policy.revision !== run.policy_revision) errors.push("/policy: must match schedule_id and policy_revision");
	if (new Set(run.members.map((m) => m.job_id)).size !== run.members.length) errors.push("/members: duplicate job id");
	if (run.members.length > run.policy.limits.child_jobs) errors.push("/members: exceeds limits.child_jobs (anchor included)");
	if (run.anchor_job_id !== null && !run.members.some((m) => m.job_id === run.anchor_job_id)) errors.push("/anchor_job_id: must be a member");
	if (run.deadline_at <= run.started_at) errors.push("/deadline_at: must follow started_at");
	if (run.phase === "closed" ? !run.closed_at || run.outcome === null : run.closed_at !== undefined || run.outcome !== null) errors.push("/phase: only a closed run has closed_at and outcome");
	if (run.closed_at !== undefined && run.closed_at < run.started_at) errors.push("/closed_at: cannot precede started_at");
	if (run.risk_preapproval && (run.trigger.via !== "dashboard" || !run.trigger.request_id || !run.policy.effects.includes("org_review_approve"))) errors.push("/risk_preapproval: requires an org-review dashboard click");
	return errors;
}
export function policyRecordErrors(value: unknown): string[] {
	const errors: string[] = [];
	object({ schedule_id: pattern(SCHEDULE_ID), revisions: array(policy), active_revision: nullable(positive), activated_at: nullable(at), activation: nullable(provenance) })(value, "", errors);
	if (errors.length) return errors;
	const record = value as PolicyRecord;
	if (!record.revisions.length || record.revisions.some((p, i) => p.schedule_id !== record.schedule_id || p.revision !== i + 1)) errors.push("/revisions: must be consecutive revisions of this schedule starting at 1");
	if (record.active_revision === null ? record.activated_at !== null || record.activation !== null : !record.revisions.some((p) => p.revision === record.active_revision) || record.activated_at === null || record.activation === null) errors.push("/active_revision: must name a saved revision with activation provenance and time");
	return errors;
}
function fileErrors(value: unknown, key: string, check: (v: unknown) => string[]): string[] {
	const errors: string[] = [];
	object({ schema_version: oneOf([1]), [key]: array((v, p, e) => e.push(...check(v).map((error) => `${p}${error}`))) })(value, "", errors);
	return errors;
}
export const scheduleRunsFileErrors = (v: unknown): string[] => {
	const errors = fileErrors(v, "runs", scheduleRunErrors);
	if (errors.length) return errors;
	const runs = (v as { runs: ScheduleRun[] }).runs;
	if (new Set(runs.map((r) => r.id)).size !== runs.length) errors.push("/runs: duplicate run id");
	const jobs = runs.flatMap((r) => r.members.map((m) => m.job_id));
	if (new Set(jobs).size !== jobs.length) errors.push("/runs: a job belongs to only one run");
	const open = runs.filter((r) => r.phase !== "closed");
	if (new Set(open.map((r) => r.schedule_id)).size !== open.length) errors.push("/runs: only one open run per schedule");
	return errors;
};
export const schedulePoliciesFileErrors = (v: unknown): string[] => {
	const errors = fileErrors(v, "policies", policyRecordErrors);
	if (!errors.length) {
		const policies = (v as { policies: PolicyRecord[] }).policies;
		if (new Set(policies.map((p) => p.schedule_id)).size !== policies.length) errors.push("/policies: duplicate schedule id");
	}
	return errors;
};
function read<T>(file: string, key: string, validate: (v: unknown) => string[]): T[] {
	if (!existsSync(file)) return [];
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { throw new ScheduleRunError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess`); }
	const errors = validate(raw);
	if (errors.length) throw new ScheduleRunError(`${file} violates the schedule run contract: ${errors.join("; ")}`);
	return (raw as Record<string, T[]>)[key]!;
}
export const readScheduleRuns = (file: string): ScheduleRun[] => read(file, "runs", scheduleRunsFileErrors);
export const readSchedulePolicies = (file: string): PolicyRecord[] => read(file, "policies", schedulePoliciesFileErrors);
