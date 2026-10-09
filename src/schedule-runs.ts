/** Durable schedule runs and policies. Code lock stays OFF until P2b wires authority consumers. */
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { atomicWriteJson, canonicalDir, queued } from "./json-store.ts";
import { mandateTokens, type MandateUsageJob } from "./mandate-accounting.ts";
import { readSchedulePolicies, readScheduleRuns, ScheduleRunError, schedulePoliciesFileErrors, scheduleRunsFileErrors, type PolicyRecord, type ScheduleRun, type ScheduleRunMember } from "./viewer/schedule-run-core.ts";
import type { SchedulePolicy } from "./viewer/schedule-policy.ts";

export const SCHEDULE_RUNS_FILE = "schedule-runs.json";
export const SCHEDULE_POLICIES_FILE = "schedule-policies.json";
export const SCHEDULE_RUNS_ACTIVE = false;
export class ScheduleRunsInactiveError extends Error {}
export class ScheduleRunStore {
	readonly runsFile: string;
	readonly policiesFile: string;
	readonly #active: boolean;
	constructor(options: { home: string; active?: boolean }) {
		const home = canonicalDir(options.home);
		this.runsFile = join(home, LAYOUT.state, SCHEDULE_RUNS_FILE);
		this.policiesFile = join(home, LAYOUT.state, SCHEDULE_POLICIES_FILE);
		this.#active = options.active ?? SCHEDULE_RUNS_ACTIVE;
	}
	get active(): boolean { return this.#active; }
	runs(): ScheduleRun[] { return readScheduleRuns(this.runsFile); }
	run(id: string): ScheduleRun | undefined { return this.runs().find((run) => run.id === id); }
	runOfJob(jobId: string): ScheduleRun | undefined { return this.runs().find((run) => run.members.some((m) => m.job_id === jobId)); }
	openRun(scheduleId: string): ScheduleRun | undefined { return this.runs().find((run) => run.schedule_id === scheduleId && run.phase !== "closed"); }
	policyRecord(scheduleId: string): PolicyRecord | undefined { return readSchedulePolicies(this.policiesFile).find((record) => record.schedule_id === scheduleId); }
	activePolicy(scheduleId: string): SchedulePolicy | undefined {
		const record = this.policyRecord(scheduleId);
		return record?.revisions.find((policy) => policy.revision === record.active_revision);
	}
	#assertActive(): void {
		if (!this.#active) throw new ScheduleRunsInactiveError("schedule runs are not active in this build (SCHEDULE_RUNS_ACTIVE=false); nothing was written");
	}
	#mutate<T, R>(file: string, key: string, read: () => T[], validate: (v: unknown) => string[], fn: (rows: T[]) => R): Promise<R> {
		this.#assertActive();
		return queued(file, async () => {
			const rows = read();
			const result = fn(rows);
			const doc = { schema_version: 1, [key]: rows };
			const errors = validate(doc);
			if (errors.length) throw new ScheduleRunError(`refusing to write ${file}: ${errors.join("; ")}`);
			atomicWriteJson(file, doc);
			return structuredClone(result);
		});
	}
	#runs<R>(fn: (rows: ScheduleRun[]) => R): Promise<R> {
		return this.#mutate(this.runsFile, "runs", () => this.runs(), scheduleRunsFileErrors, fn);
	}
	#policies<R>(fn: (rows: PolicyRecord[]) => R): Promise<R> {
		return this.#mutate(this.policiesFile, "policies", () => readSchedulePolicies(this.policiesFile), schedulePoliciesFileErrors, fn);
	}
	#update(id: string, fn: (run: ScheduleRun) => void): Promise<ScheduleRun> {
		return this.#runs((rows) => {
			const run = rows.find((r) => r.id === id);
			if (!run) throw new ScheduleRunError(`unknown run ${id}`);
			fn(run);
			return run;
		});
	}
	createRun(input: ScheduleRun): Promise<ScheduleRun> {
		return this.#runs((rows) => {
			const run = structuredClone(input);
			rows.push(run);
			return run;
		});
	}
	#member(run: ScheduleRun, member: ScheduleRunMember): void {
		if (run.members.some((m) => m.job_id === member.job_id)) return;
		if (run.phase === "closed") throw new ScheduleRunError(`${run.id} is closed`);
		if (run.members.length >= run.policy.limits.child_jobs) throw new ScheduleRunError(`${run.id}: limits.child_jobs reached (anchor included)`);
		run.members.push(structuredClone(member));
	}
	attachAnchor(id: string, member: ScheduleRunMember): Promise<ScheduleRun> {
		return this.#update(id, (run) => {
			if (run.anchor_job_id !== null && run.anchor_job_id !== member.job_id) throw new ScheduleRunError(`${id}: anchor already attached`);
			this.#member(run, member);
			run.anchor_job_id = member.job_id;
		});
	}
	admitMember(id: string, member: ScheduleRunMember): Promise<ScheduleRun> { return this.#update(id, (run) => this.#member(run, member)); }
	setPhase(id: string, phase: ScheduleRun["phase"]): Promise<ScheduleRun> {
		return this.#update(id, (run) => {
			if (run.phase === "closed" || (run.phase === "running" && phase === "accepted") || phase === "closed") throw new ScheduleRunError(`${id}: invalid phase transition; use closeRun to close`);
			run.phase = phase;
		});
	}
	closeRun(id: string, outcome: NonNullable<ScheduleRun["outcome"]>, at: string): Promise<ScheduleRun> {
		return this.#update(id, (run) => {
			if (run.phase === "closed") throw new ScheduleRunError(`${id} is already closed`);
			run.phase = "closed"; run.outcome = outcome; run.closed_at = at;
		});
	}
	/** Synchronous authority consumers must persist their decision before returning. The entire read/validate/write
	 * step has no await, as do queued mutations above, so no in-process writer can interleave it. */
	editRun(id: string, fn: (run: ScheduleRun) => void): ScheduleRun {
		this.#assertActive();
		const rows = this.runs();
		const run = rows.find((r) => r.id === id);
		if (!run) throw new ScheduleRunError(`unknown run ${id}`);
		fn(run);
		const doc = { schema_version: 1, runs: rows };
		const errors = scheduleRunsFileErrors(doc);
		if (errors.length) throw new ScheduleRunError(`refusing to write ${this.runsFile}: ${errors.join("; ")}`);
		atomicWriteJson(this.runsFile, doc);
		return structuredClone(run);
	}
	appendAuthority(id: string, row: ScheduleRun["authority_log"][number]): Promise<ScheduleRun> {
		return this.#update(id, (run) => { run.authority_log = [...run.authority_log, structuredClone(row)].slice(-200); });
	}
	noteCap(id: string, key: string): Promise<ScheduleRun> {
		return this.#update(id, (run) => { if (!run.cap_notices.includes(key)) run.cap_notices.push(key); });
	}
	savePolicyRevision(policy: SchedulePolicy): Promise<PolicyRecord> {
		return this.#policies((rows) => {
			let record = rows.find((r) => r.schedule_id === policy.schedule_id);
			if (!record) { record = { schedule_id: policy.schedule_id, revisions: [], active_revision: null, activated_at: null, activation: null }; rows.push(record); }
			record.revisions.push(structuredClone(policy));
			return record;
		});
	}
	activatePolicy(scheduleId: string, revision: number, at: string, activation: NonNullable<PolicyRecord["activation"]>): Promise<PolicyRecord> {
		return this.#policies((rows) => {
			const record = rows.find((r) => r.schedule_id === scheduleId);
			if (!record || revision !== record.revisions.at(-1)?.revision) throw new ScheduleRunError(`${scheduleId}: missing or stale policy revision ${revision}`);
			record.active_revision = revision; record.activated_at = at; record.activation = structuredClone(activation);
			return record;
		});
	}
	deactivatePolicy(scheduleId: string): Promise<PolicyRecord> {
		return this.#policies((rows) => {
			const record = rows.find((r) => r.schedule_id === scheduleId);
			if (!record) throw new ScheduleRunError(`unknown policy ${scheduleId}`);
			record.active_revision = null; record.activated_at = null; record.activation = null;
			return record;
		});
	}
}
export const openScheduleRunStore = (home: string): ScheduleRunStore => new ScheduleRunStore({ home });

export function runSpend(run: ScheduleRun, usageJobs: readonly MandateUsageJob[]): { usd: number; tokens: number; inFlight: number; members: number } {
	const ids = new Set(run.members.map((m) => m.job_id));
	let usd = 0, tokens = 0, inFlight = 0;
	for (const job of usageJobs) {
		if (!ids.has(job.job_id)) continue;
		usd += (job.usage?.cost_usd ?? 0) + (job.reviewer_usage?.cost_usd ?? 0);
		tokens += mandateTokens(job.usage) + mandateTokens(job.reviewer_usage);
		if (job.phase === "waiting" || job.phase === "launching") inFlight++;
	}
	return { usd, tokens, inFlight, members: ids.size };
}
type RunLedgerJob = { id: string; status: string; notes?: string; created_at?: string };
export function reconcileRun(run: ScheduleRun, ledgerJobs: readonly RunLedgerJob[]): ScheduleRun {
	const result = structuredClone(run);
	if (result.anchor_job_id === null) {
		const anchor = ledgerJobs.find((job) => new RegExp(`under run ${run.id}(?![A-Za-z0-9_-])`).test(job.notes ?? ""));
		if (anchor) {
			result.anchor_job_id = anchor.id;
			if (!result.members.some((m) => m.job_id === anchor.id)) result.members.push({ job_id: anchor.id, role: null, admitted_at: anchor.created_at ?? run.started_at });
		}
	}
	if (result.anchor_job_id !== null && result.phase === "accepted") result.phase = "running";
	return result;
}
export function runIsSettled(run: ScheduleRun, ledgerJobs: readonly RunLedgerJob[]): boolean {
	return run.members.length > 0 && run.members.every((m) => ledgerJobs.some((job) => job.id === m.job_id && job.status === "closed"));
}
