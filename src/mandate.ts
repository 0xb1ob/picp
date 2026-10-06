/**
 * Mandate store — operator-issued bounded authority.
 *
 * A checkpoint is still one named job, written pending before anyone answers.
 * This module is the only standing grant: `evaluateAuthority` is a pure
 * function, and when it permits, `decide()` records `decided_by: mandate:<id>`.
 * A model still has no free-text path to an answer.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CheckpointKind,
	type Escalation,
	type GateFlags,
	type JobKind,
	type Mandate,
	type MandateRevokedBy,
	type MandateAction,
	type MandateAskOn,
	type MandateChannel,
	type MandateDecisionRecord,
	type MandateEscalation,
	type MandateProvenance,
	MANDATE_ACTIONS,
	MANDATE_ASK_ON,
	MandateSchema,
	type Risk,
	type RiskPreapproval,
	type RoutingProvenance,
	type ScheduleFire,
	isSafeMandateId,
	SCHEMA_VERSION,
	isoTimestamp,
	LAYOUT,
	paths,
	validate,
} from "./contracts.ts";
import { EscalationStore, raiseBudgetExhausted, raiseConflictingRef, raiseRiskHigh } from "./escalation.ts";
import { atomicWriteJson } from "./json-store.ts";
import { stripSendMarkers } from "./parent-outbox.ts";
import { batchRefusal, capReached, covers, enrollCapacity, isActive, jobCapRefuses, MandateError, mandateSpend, matchingJobs, type MandateUsageJob, reviewerUsage, type ScheduleScope, scheduleIdOf, scheduleScope, supersedeReason, usageBaseline } from "./mandate-accounting.ts";
import { readScheduleFile } from "./viewer/schedule-core.ts";
import { assertGrantsPermit, type GrantPermission, type GrantUse, grantStanding, inFlightRecord, isInFlight } from "./mandate-permission.ts";
import { formatMandate } from "./mandate-format.ts";
import { preapprovedRow, riskPreapproval, withPreapproval } from "./risk-preapproval.ts";
import { type Ledger, readJobsDocument } from "./ledger.ts";
import { loadTokenCeiling } from "./mandate-defaults.ts";
import { describeRefMismatch, describeRefVerification, type RefVerification, verifyExternalRef } from "./verify-external-ref.ts";

export * from "./mandate-accounting.ts";
export * from "./mandate-permission.ts";
export { formatMandate } from "./mandate-format.ts";

/** `cp_mandate issue` job_ids sentinel: expand to ids `cp_job create` returned this parent turn. */
export const MANDATE_JOBS_THIS_TURN = "all jobs created in this turn";

export function resolveMandateJobIds(
	jobIds: readonly string[] | undefined,
	createdThisTurn: readonly string[],
): string[] | undefined {
	if (!jobIds?.length) return undefined;
	const usesSentinel = jobIds.includes(MANDATE_JOBS_THIS_TURN);
	if (!usesSentinel) return [...jobIds];
	if (jobIds.length !== 1) {
		throw new MandateError(`cp_mandate issue: ${JSON.stringify(MANDATE_JOBS_THIS_TURN)} cannot mix with job ids`);
	}
	if (createdThisTurn.length === 0) {
		throw new MandateError("cp_mandate issue: no jobs created in this turn");
	}
	return [...createdThisTurn];
}

// Global for matchAll only (which copies it): never call .exec/.test on it, lastIndex would leak.
const BARE_ISSUE_REF_RE = /(?:^|\s)(?:([\w.-]+\/[\w.-]+))?#(\d+)(?=\s|$)/g;
/** Only an issue-task word right before `#N` is issue intake ("fix #17"); "PR #7" or "after #220 merged" is prose (b-qbi.2). */
const ISSUE_TASK_RE = /(?:^|\W)(?:issues?|fix(?:es|ed)?|close[sd]?|resolve[sd]?|address(?:es)?|implement|target)\s*:?\s*$/i;

/** The first `owner/repo#N`, or `#N` that is the whole text or follows an issue-task word, in free text (a mandate objective). */
export function extractBareIssueRef(text: string): { ownerRepo?: string; number: string } | undefined {
	for (const match of text.matchAll(BARE_ISSUE_REF_RE)) {
		if (!match[1] && text.trim() !== match[0].trim() && !ISSUE_TASK_RE.test(text.slice(0, match.index + match[0].indexOf("#")))) continue;
		return { number: match[2] as string, ...(match[1] ? { ownerRepo: match[1] } : {}) };
	}
	return undefined;
}

/** `owner/repo` out of a GitHub `clone_url` (https or ssh form); undefined for any other remote. */
export function githubRepoFromCloneUrl(cloneUrl: string): string | undefined {
	const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(cloneUrl);
	if (https) return `${https[1]}/${https[2]}`;
	const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(cloneUrl);
	return ssh ? `${ssh[1]}/${ssh[2]}` : undefined;
}

export interface MandateObjectiveRefPorts {
	ledger: Ledger;
	/** Overridden in tests to script `gh` responses; defaults to `verifyExternalRef`. */
	verifyRef?: (ref: string) => Promise<RefVerification>;
	escalations: EscalationStore;
	noteCreated?: (jobId: string) => void;
}

/**
 * A bare `#N` (or `owner/repo#N`) in a mandate objective becomes a verified job
 * (pi-command-post-autonomy-programme-cur.2.6): resolved to a GitHub issue url via the single named
 * project's `clone_url`, checked the same way `cp_job create` checks an explicit `external_ref`,
 * and either turned into a real job id or refused — with one `conflicting_acceptance` escalation,
 * exactly like `cp_job create`. Ambiguous (no ref, more than one project, or a non-GitHub remote)
 * is quietly `undefined`: nothing to resolve, not a refusal.
 */
export async function resolveMandateObjectiveRef(
	objective: string,
	projects: readonly string[],
	cloneUrlFor: (project: string) => string | undefined,
	ports: MandateObjectiveRefPorts,
): Promise<string | undefined> {
	objective = stripSendMarkers(objective); // a minted job's title is operator words only
	const bare = extractBareIssueRef(objective);
	if (!bare || projects.length !== 1) return undefined;
	const project = projects[0] as string;
	const ownerRepo = bare.ownerRepo ?? (cloneUrlFor(project) ? githubRepoFromCloneUrl(cloneUrlFor(project) as string) : undefined);
	if (!ownerRepo) return undefined;
	const url = `https://github.com/${ownerRepo}/issues/${bare.number}`;
	const existing = ports.ledger.findDuplicate({ title: objective, project, externalRef: url });
	if (existing) {
		ports.noteCreated?.(existing.id);
		return existing.id;
	}
	const verify = ports.verifyRef ?? verifyExternalRef;
	const verification = await verify(url);
	const mismatch = describeRefMismatch(url, verification);
	if (mismatch) {
		const anchorJobId = `verify-mandate-${project}`;
		await raiseConflictingRef(ports.escalations, { anchorJobId, ref: url, found: mismatch });
		throw new MandateError(
			`cp_mandate issue refused: ${mismatch} — raised a conflicting_acceptance escalation (job_ids [${anchorJobId}]); relay it, do not dispatch`,
		);
	}
	// ponytail: every job minted from an objective ref ships as delivery pr / kind ship, the common
	// case; a research or local-delivery ref still needs an explicit cp_job create.
	const job = await ports.ledger.create({ title: objective, project, delivery: "pr", kind: "ship", externalRef: url });
	const noted = await ports.ledger.update(job.id, { notes: describeRefVerification(verification) });
	ports.noteCreated?.(noted.id);
	return noted.id;
}

export interface MandateSubject extends ScheduleScope {
	kind: CheckpointKind;
	jobId: string;
	project: string;
	risk?: Risk;
	riskProvenance?: RoutingProvenance;
	/** Gate flags on a plan checkpoint: any raised flag leaves it pending for the
	 * operator, never mandate-decided (um58 #8). */
	gateFlags?: GateFlags;
	jobKind?: JobKind;
	pathHints?: string[];
	subsystem?: string;
	/** Original task / issue text — used to match path and subsystem exclusions. */
	text?: string;
	artifactHash?: string;
	now?: string;
	usageJobs?: readonly MandateUsageJob[];
	createdAt?: string;
}

export type AuthorityDecision =
	| { permitted: true; mandateId: string; clause: string }
	| { permitted: false; reason: string };

export interface IssueMandateInput {
	projects: string[];
	objective: string;
	expiry: string;
	spend_cap: { usd: number; tokens: number };
	job_cap: number;
	channel?: MandateChannel;
	job_ids?: string[];
	/** A schedule-only grant (schedlater S3): only the one schedule naming it may fire under it. */
	schedule_grant?: true;
	allowed_actions?: MandateAction[];
	dispatch_parallelism?: number;
	exclusions?: Mandate["exclusions"];
	ask_on?: MandateAskOn[];
	at?: string;
	/** Where each defaultable field came from (autonomy-programme-cur.2.5): `resolveMandateGrant`'s output. */
	provenance?: MandateProvenance;
	/** A verified operator risk:high pre-approval written with the grant (`withPreapproval`). */
	risk_preapproval?: RiskPreapproval;
	/** Code-only (a schedule's fire lane, src/schedule-grant.ts); `cp_mandate` exposes neither. */
	id?: string;
	schedule_fire?: ScheduleFire;
}

// final_fix is never granted: evaluateAuthority refuses it before any action is read.
const ACTION_FOR_KIND: Record<CheckpointKind, MandateAction> = { ship: "implement", diff: "review", merge: "merge", final_fix: "merge" };

export function actionForKind(kind: CheckpointKind): MandateAction {
	return ACTION_FOR_KIND[kind];
}

/**
 * A leading double-star-slash in an exclusion means "any directory or none"; a trailing star means
 * "any suffix" (pi-command-post-autonomy-programme-cur.2.6) — minimal globbing so the scaffolded
 * env-file exclusion actually matches `.env`, `services/api/.env`, `.env.production`. A needle
 * without a star keeps the old substring behaviour, so every existing default is unaffected.
 */
function hitsNeedle(value: string, needle: string): boolean {
	if (needle.length === 0) return false;
	if (!needle.includes("*")) {
		return value.includes(needle);
	}
	const pattern = needle
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "(?:.*/)?")
		.replace(/\*/g, "[^/]*");
	return new RegExp(`(?:^|/)${pattern}$`).test(value);
}

function pathExcluded(mandate: Mandate, pathHints: string[] | undefined, text?: string): string | undefined {
	const excluded = mandate.exclusions?.paths;
	if (!excluded) return undefined;
	for (const path of pathHints ?? []) {
		for (const ex of excluded) {
			if (hitsNeedle(path, ex)) return path;
		}
	}
	if (text) {
		for (const ex of excluded) {
			if (text.includes(ex)) return ex;
		}
	}
	return undefined;
}

function subsystemExcluded(mandate: Mandate, subsystem: string | undefined, text?: string): string | undefined {
	const excluded = mandate.exclusions?.subsystems;
	if (!excluded) return undefined;
	if (subsystem && excluded.includes(subsystem)) return subsystem;
	if (text) {
		for (const ex of excluded) {
			if (ex.length > 0 && text.includes(ex)) return ex;
		}
	}
	return undefined;
}

/**
 * Pure: pending checkpoint + active mandates → permitted (id, clause) or not.
 *
 * `risk:high` with any provenance is never permitted unless `ask_on` omits
 * `risk:high` and the objective names the job. Unknown risk is not high;
 * inferred high is high.
 *
 * Standing comes from `grantStanding` (src/mandate-permission.ts), as for every gate: any active grant decides;
 * otherwise the latest speaking grant does, which is how an in-flight job continues under an expired grant.
 */
export function evaluateAuthority(subject: MandateSubject, mandates: readonly Mandate[]): AuthorityDecision {
	if (subject.kind === "final_fix") return { permitted: false, reason: "a final fix at the review cap requires operator text" };
	const now = subject.now ?? isoTimestamp();
	const jobs = subject.usageJobs ?? [];
	const job = { ...subjectAsJob(subject), startedAt: inFlightRecord(subject, jobs)?.dispatched_at ?? subject.createdAt, inFlight: isInFlight(subject, jobs) };
	const judged = mandates.map((grant) => ({ grant, at: grantStanding(grant, actionForKind(subject.kind) as GrantUse, job, now) }));
	const blocked: string[] = [];
	let active = false;
	for (const { grant, at } of judged) {
		if (at.standing === "none") continue;
		if (at.cause === "active") {
			active = true;
			const verdict = judgeCovered(grant, subject, jobs);
			if (verdict.permitted) return verdict;
			blocked.push(verdict.reason);
		} else if (at.standing === "refuse" && at.cause !== "revoked") {
			blocked.push(at.cause === "expired" ? `${grant.id} has expired` : `${grant.id} is paused${grant.pause_reason ? ` (${grant.pause_reason})` : ""}`);
		}
	}
	const latest = active ? undefined : judged.filter(({ at }) => at.standing === "permit" || at.standing === "refuse").at(-1);
	if (latest?.at.standing === "permit") {
		const verdict = judgeCovered(latest.grant, subject, jobs);
		if (verdict.permitted) return { ...verdict, clause: `${verdict.clause}; expired grant continues in-flight ${subject.jobId}`.slice(0, 400) };
		blocked.unshift(verdict.reason);
	}
	if (blocked.length > 0) return { permitted: false, reason: blocked[0] as string };
	return { permitted: false, reason: `no active mandate covers ${subject.jobId}` };
}

/** Every rule after coverage and status: exclusions, allowed action, ask_on, risk:high, caps. */
function judgeCovered(mandate: Mandate, subject: MandateSubject, jobs: readonly MandateUsageJob[]): AuthorityDecision {
	// A gate flag is never mandate-decided (um58 #8): a human decides with it in view.
	const flags = subject.gateFlags;
	const raised = flags ? (Object.keys(flags) as Array<keyof GateFlags>).filter((flag) => flags[flag]) : [];
	if (raised.length > 0) return { permitted: false, reason: `${mandate.id}: gate flags raised (${raised.join(", ")}) — a mandate never decides a flagged checkpoint` };
	const excludedPath = pathExcluded(mandate, subject.pathHints, subject.text);
	if (excludedPath) return { permitted: false, reason: `${mandate.id}: path ${excludedPath} is excluded` };
	const excludedSubsystem = subsystemExcluded(mandate, subject.subsystem, subject.text);
	if (excludedSubsystem) return { permitted: false, reason: `${mandate.id}: subsystem ${excludedSubsystem} is excluded` };
	if (mandate.exclusions?.job_kinds && subject.jobKind && mandate.exclusions.job_kinds.includes(subject.jobKind)) {
		return { permitted: false, reason: `${mandate.id}: job kind ${subject.jobKind} is excluded` };
	}

	const action = actionForKind(subject.kind);
	if (!mandate.allowed_actions.includes(action)) return { permitted: false, reason: `${mandate.id}: ${action} is not an allowed action` };
	if (subject.kind === "ship" && mandate.ask_on.includes("plan_approval")) return { permitted: false, reason: `${mandate.id}: ask_on includes plan_approval` };
	if (subject.kind === "merge" && mandate.ask_on.includes("merge")) return { permitted: false, reason: `${mandate.id}: ask_on includes merge` };

	const high = subject.risk === "high";
	if (high && (mandate.ask_on.includes("risk:high") || !mandate.objective.includes(subject.jobId))) {
		return { permitted: false, reason: `${mandate.id}: risk:high is never auto-permitted unless ask_on excludes it and the objective names the job` };
	}

	// The job cap only gates an implement decision for a job not yet counted; review and merge never.
	const cap = capReached(mandate, jobs) ?? (subject.kind === "ship" && jobCapRefuses(mandate, subject.jobId, jobs) ? "job" : undefined);
	if (cap) return { permitted: false, reason: `${mandate.id}: ${cap} cap reached` };

	const clause = `allowed_actions includes ${action} for project ${subject.project}` + (high ? `; risk high named in objective` : "");
	return { permitted: true, mandateId: mandate.id, clause: clause.slice(0, 400) };
}

function subjectAsJob(subject: MandateSubject): {
	jobId: string;
	project: string;
	jobKind?: JobKind;
	pathHints?: string[];
	subsystem?: string;
} & ScheduleScope {
	return {
		jobId: subject.jobId,
		project: subject.project,
		...(subject.jobKind ? { jobKind: subject.jobKind } : {}),
		...(subject.pathHints ? { pathHints: subject.pathHints } : {}),
		...(subject.subsystem ? { subsystem: subject.subsystem } : {}),
		...(subject.scheduleId ? { scheduleId: subject.scheduleId } : {}),
		...(subject.scheduleMandate ? { scheduleMandate: subject.scheduleMandate } : {}),
	};
}

export interface MandateStoreOptions {
	now?: () => Date;
}

export class MandateStore {
	readonly home: string;
	readonly #now: () => Date;

	constructor(home: string, options: MandateStoreOptions = {}) {
		this.home = home;
		this.#now = options.now ?? (() => new Date());
	}

	/** Every instant this store writes, normalized once here to second precision (a caller's `…:20.123Z` included). */
	#stamp(at?: string): string {
		const date = at === undefined ? this.#now() : new Date(at);
		if (Number.isNaN(date.getTime())) throw new MandateError(`invalid timestamp ${JSON.stringify(at)}`);
		return isoTimestamp(date);
	}

	file(id: string): string {
		return join(this.home, paths.mandateFile(id));
	}

	get(id: string): Mandate | undefined {
		const file = this.file(id);
		if (!existsSync(file)) return undefined;
		const parsed = validate<Mandate>(MandateSchema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok) {
			throw new MandateError(`${file} violates the mandate contract:\n  ${parsed.errors.join("\n  ")}`);
		}
		return parsed.value;
	}

	list(): Mandate[] {
		const dir = join(this.home, LAYOUT.mandates);
		if (!existsSync(dir)) return [];
		const all: Mandate[] = [];
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".json")) continue;
			const id = entry.slice(0, -".json".length);
			try {
				const mandate = this.get(id);
				if (mandate) all.push(mandate);
			} catch {
				// Skip a torn file; get() still throws on a direct read.
			}
		}
		all.sort((a, b) => a.issued_at.localeCompare(b.issued_at));
		return all;
	}

	sweep(now?: string, jobs: readonly MandateUsageJob[] = []): Mandate[] {
		const at = this.#stamp(now);
		const counted = this.withReviewerSpend(jobs);
		const out: Mandate[] = [];
		for (const mandate of this.list()) {
			out.push(this.#refresh(mandate, at, counted));
		}
		return out;
	}

	/**
	 * `jobs` with each job's reviewer spend (gate, diff review, quality panel) laid on as `reviewer_usage`, so
	 * `mandateSpend` counts it toward USD and token caps with the same non-cached rule as worker spend.
	 * Idempotent: `reviewer_usage` is overwritten, never added to. Only jobs some live grant covers are read.
	 */
	withReviewerSpend(jobs: readonly MandateUsageJob[], grants?: readonly Mandate[]): MandateUsageJob[] {
		// ponytail: one readdir per covered job per sweep; cache per run dir mtime if sweeps get hot.
		const live = grants ?? this.list().filter((mandate) => mandate.status === "active" || mandate.status === "paused");
		const schedules = this.scheduleMandates();
		return jobs.map((record) => {
			// A scheduled record carries the grant its schedule names, so that schedule grant (and only it) counts it.
			const mandate = record.schedule_id ? schedules.get(record.schedule_id) : undefined;
			const job = mandate ? { ...record, schedule_mandate: mandate } : record;
			if (!live.some((grant) => matchingJobs(grant, [job]).length > 0)) return job;
			const reviewers = reviewerUsage(this.home, job.job_id);
			return reviewers ? { ...job, reviewer_usage: reviewers } : job;
		});
	}

	/** Schedule id -> the mandate it names, from state/schedules.json. Unreadable is empty: no schedule grant covers anything, and every other grant still excludes a scheduled job. */
	scheduleMandates(): Map<string, string> {
		try {
			return new Map(readScheduleFile(join(this.home, LAYOUT.state, "schedules.json")).map((schedule) => [schedule.id, schedule.mandate_id]));
		} catch {
			return new Map(); // fail closed, never open: see above
		}
	}

	/** The ledger job's schedule scope (its `schedule:` label and the mandate that schedule names), for `covers`. */
	scheduleOf(jobId: string): ScheduleScope {
		if (!existsSync(join(this.home, LAYOUT.jobsFile))) return {};
		const labels = readJobsDocument(this.home).jobs.find((job) => job.id === jobId)?.labels;
		return scheduleScope(scheduleIdOf(labels), this.scheduleMandates());
	}

	#refresh(mandate: Mandate, now: string, jobs: readonly MandateUsageJob[]): Mandate {
		let next = mandate;
		// The job cap never pauses a grant: one paused on it before that rule resumes and is re-checked below.
		if (next.status === "paused" && next.pause_reason === "job_cap") {
			const { paused_at: _paused, pause_reason: _reason, ...rest } = next;
			next = this.#write({ ...rest, status: "active" });
		}
		if (next.status === "active" && next.expiry <= now) {
			next = this.#write({
				...next,
				status: "expired",
				escalations: withEscalation(next, {
					at: now,
					kind: "expired",
					reason: `${next.id} expired at ${next.expiry}; in-flight workers were not killed`,
				}),
			});
			this.supersedeEscalations(jobs);
		}
		if (next.status === "active") {
			const cap = capReached(next, jobs);
			if (cap) {
				// A token cap under the home's ceiling is the parent's to raise (raiseTokenCap), never a human ask.
				const parentRaisable = cap === "token" && next.spend_cap.tokens < this.tokenCeiling();
				const reason =
					cap === "spend"
						? `${next.id} spend cap reached (usd ${next.spend_cap.usd})`
						: `${next.id} token cap reached (${next.spend_cap.tokens} non-cached; token_ceiling ${this.tokenCeiling()})`;
				const kind = `${cap}_cap`;
				next = this.#write({ ...next, status: "paused", paused_at: now, pause_reason: kind, escalations: withEscalation(next, { at: now, kind, reason }) });
				const jobId = next.job_ids?.[0];
				if (jobId && !parentRaisable) {
					void raiseBudgetExhausted(new EscalationStore({ home: this.home }), {
						jobId,
						question: reason,
						mandate_id: next.id,
						mandate_clause: `${next.id}: ${kind}`,
					}).catch(() => {
						// Nested mandate.escalations already recorded the cap; the structured row is extra.
					});
				}
			}
		}
		return next;
	}

	/**
	 * `jobs` is the fleet as the live sweep sees it (`liveUsageJobs`): every job the new grant covers is recorded in
	 * `usage_baseline` with its usage now, so the grant counts only what accrues after issue (`mandateSpend`). Its
	 * counted spend at issue is therefore zero: only a zero USD or token cap is refused here, before anything is written.
	 */
	issue(input: IssueMandateInput, jobs: readonly MandateUsageJob[] = []): Mandate {
		const at = this.#stamp(input.at);
		if (input.expiry <= at) throw new MandateError("expiry must be after issued-at");
		const allowed = input.allowed_actions ?? ["plan", "implement", "review", "repair"];
		for (const action of allowed) {
			if (!(MANDATE_ACTIONS as readonly string[]).includes(action)) {
				throw new MandateError(`unknown allowed action ${action}`);
			}
		}
		const askOn = input.ask_on ?? ["merge", "risk:high"];
		for (const item of askOn) {
			if (!(MANDATE_ASK_ON as readonly string[]).includes(item)) {
				throw new MandateError(`unknown ask_on ${item}`);
			}
		}
		const projects = input.projects.map((name) => name.trim()).filter((name) => name.length > 0);
		if (projects.length === 0) throw new MandateError("cp_mandate issue needs at least one project");
		const id = input.id ?? this.mintId();
		if (input.id !== undefined && (!isSafeMandateId(id) || existsSync(this.file(id)))) throw new MandateError(`refusing to issue ${id}: not a fresh mandate id`);
		const mandate: Mandate = {
			schema_version: SCHEMA_VERSION,
			id,
			issued_by: { channel: input.channel ?? "operator_chat" },
			issued_at: at,
			expiry: input.expiry,
			projects,
			objective: stripSendMarkers(input.objective), // never the bridge's `[cp-send <id> ...]` lines
			...(input.job_ids && input.job_ids.length > 0 ? { job_ids: input.job_ids } : {}),
			...(input.schedule_grant ? { schedule_grant: true as const } : {}),
			allowed_actions: allowed,
			...(input.dispatch_parallelism ? { dispatch_parallelism: input.dispatch_parallelism } : {}),
			...(input.exclusions ? { exclusions: input.exclusions } : {}),
			spend_cap: input.spend_cap,
			job_cap: input.job_cap,
			ask_on: askOn,
			status: "active",
			decisions: [],
			escalations: [],
			...(input.provenance ? { provenance: input.provenance } : {}),
			...(input.schedule_fire ? { schedule_fire: input.schedule_fire } : {}),
		};
		const counted = this.withReviewerSpend(jobs, [mandate]);
		const baseline = usageBaseline(mandate, counted);
		if (baseline.length > 0) mandate.usage_baseline = baseline;
		const spend = mandateSpend(mandate, counted);
		// The job cap is not here: it limits new dispatches only, so a grant whose covered jobs already fill it
		// still carries their review, repair and merge.
		const exhausted = [
			spend.tokens >= mandate.spend_cap.tokens ? "tokens" : "",
			spend.usd >= mandate.spend_cap.usd ? "usd" : "",
		].filter(Boolean);
		if (exhausted.length > 0) {
			throw new MandateError(
				`cp_mandate issue refused: the ${exhausted.join(", ")} cap leaves nothing to spend — used ` +
					`${spend.tokens} / ${mandate.spend_cap.tokens} tokens, $${spend.usd.toFixed(2)} / $${mandate.spend_cap.usd.toFixed(2)}, ` +
					`${spend.jobs} / ${mandate.job_cap} jobs. Usage from before a grant is never counted (usage_baseline); issue a cap above zero.`,
			);
		}
		const written = this.#write(this.#underCeiling(input.risk_preapproval ? withPreapproval(mandate, input.risk_preapproval) : mandate));
		this.supersedeEscalations(jobs);
		return written;
	}

	pause(id: string, reason = "operator"): Mandate {
		const existing = this.require(id);
		if (existing.status === "revoked" || existing.status === "expired") {
			throw new MandateError(`${id} is ${existing.status}; it cannot be paused`);
		}
		if (existing.status === "paused") return existing;
		const at = this.#stamp();
		return this.#write({
			...existing,
			status: "paused",
			paused_at: at,
			pause_reason: reason,
		});
	}

	resume(id: string): Mandate {
		const existing = this.require(id);
		if (existing.status !== "paused") {
			throw new MandateError(`${id} is ${existing.status}, not paused`);
		}
		const { paused_at: _paused, pause_reason: _reason, ...rest } = existing;
		return this.#write({ ...rest, status: "active" });
	}

	/** `by`: the operator's verified quote (`cp_mandate revoke operator_quote`); without it the revoke is the system's or the parent's. */
	revoke(id: string, by?: MandateRevokedBy): Mandate {
		const existing = this.require(id);
		if (existing.status === "revoked") return existing;
		const at = this.#stamp();
		const revoked = this.#write({
			...existing,
			status: "revoked",
			revoked_at: at,
			...(by ? { revoked_by: by } : {}),
			escalations: withEscalation(existing, {
				at,
				kind: "revoked",
				reason: `${id} revoked; in-flight workers were not killed`,
			}),
		});
		this.supersedeEscalations();
		return revoked;
	}

	require(id: string): Mandate {
		const mandate = this.get(id);
		if (!mandate) throw new MandateError(`no mandate ${id}`);
		return mandate;
	}

	journal(id: string, decision: MandateDecisionRecord): Mandate {
		const existing = this.require(id);
		return this.#write({ ...existing, decisions: [...existing.decisions, decision] });
	}

	/**
	 * Named-jobs enrollment (B4 `cp_tracker import`): append `job.jobId` to an active batch grant's `job_ids`, the
	 * grant file being the record. Re-checked here against the grant and its caps (`batchRefusal`, `enrollCapacity`;
	 * `open` holds the ids of non-closed ledger jobs). Idempotent for a job already listed.
	 */
	enroll(id: string, job: { jobId: string; project: string; kind: JobKind }, jobs: readonly MandateUsageJob[], open: ReadonlySet<string>): Mandate {
		const mandate = this.require(id);
		if (mandate.job_ids?.includes(job.jobId)) return mandate;
		const counted = this.withReviewerSpend(jobs, [mandate]);
		const refusal = batchRefusal(mandate, id, job, counted, this.#stamp()) ?? (enrollCapacity(mandate, counted, open) < 1 ? `${id} job cap ${mandate.job_cap} reached` : undefined);
		if (refusal) throw new MandateError(`cannot enroll ${job.jobId}: ${refusal}`);
		return this.#write({ ...mandate, job_ids: [...(mandate.job_ids ?? []), job.jobId] });
	}

	/**
	 * `ask_on: [risk:high]` gates a direct dispatch and a `cp_send` promotion
	 * exactly as it already gates a checkpoint (pi-command-post-autonomy-
	 * programme-cur.2.4): a `risk: "high"` job under an active, covering
	 * mandate whose `ask_on` names `risk:high` is refused before any lease,
	 * with one `risk_high_irreversible` escalation raised naming the job and
	 * `job.evidence` (the risk words routing matched). An already-answered
	 * escalation for this job id that approves is read as permission for this
	 * job only \u2014 a new job needs a new decision.
	 */
	async assertDispatchAllowed(job: {
		jobId: string;
		project: string;
		kind?: JobKind;
		pathHints?: string[];
		risk?: Risk;
		evidence?: readonly string[];
		/** A same-worker promotion of an existing job: gated like a dispatch, but never by the parallelism slot. */
		promotion?: boolean;
		/** A script dispatch: never covered by a risk pre-approval (its text is a path, so no hard stop can be read). */
		script?: boolean;
	}, jobs: readonly MandateUsageJob[] = []): Promise<void> {
		// No active grant: the latest speaking one decides (src/mandate-permission.ts); an expired grant's continuation keeps its risk ask.
		const { active, continuing } = this.assertPermitted(job.promotion ? "promote" : "dispatch", job, jobs);
		const speaking = continuing ? [continuing] : active;
		if (speaking.length === 0) return;

		let preapproved: Mandate[] = [];
		if (job.risk === "high" && speaking.some((mandate) => mandate.ask_on.includes("risk:high"))) {
			const escalations = new EscalationStore({ home: this.home });
			// Not escalationApproves: its recommended-shortcut approves a bare
			// match against `escalation.recommended`, and raiseRiskHigh recommends
			// "drop" \u2014 so that generic helper would fail open on the operator's
			// own refusal. This gate requires an explicit approve answer.
			const APPROVE = /^(?:approve|approved|yes)$/i;
			const authorized = escalations
				.list({ jobId: job.jobId, kind: "risk_high_irreversible" })
				.some((entry) => entry.status === "answered" && APPROVE.test((entry.answer ?? "").trim()));
			const asking = speaking.filter((mandate) => mandate.ask_on.includes("risk:high"));
			// An operator pre-approval naming the job passes (audited below, after the caps); a hard stop still asks.
			const pre = authorized ? undefined : riskPreapproval(asking, job, this.jobCreatedAt(job.jobId));
			if (pre?.covered) preapproved = asking;
			else if (pre) {
				const raised = await raiseRiskHigh(escalations, { jobId: job.jobId, evidence: [...(job.evidence ?? []), ...pre.stops], ...(asking[0] ? { mandateId: asking[0].id } : {}) });
				throw new MandateError(
					`${job.jobId}: risk:high under ask_on \u2014 refused before dispatch; ${raised.id} raised, cp_decide it with an operator quote to authorize it`,
				);
			}
		}

		const counted = this.withReviewerSpend(jobs, active);
		for (const mandate of active) {
			// The job cap limits fresh dispatches only: a job already counted (a promotion, a repair) never hits it.
			if (!job.promotion && jobCapRefuses(mandate, job.jobId, counted)) {
				throw new MandateError(
					`${job.jobId}: mandate ${mandate.id} job cap ${mandate.job_cap} reached \u2014 no new dispatch; the jobs it already covers continue (review, repair, merge)`,
				);
			}
			// Serial means one fresh implementer at a time; repairing an existing job (its own worker) may overlap.
			if (mandate.dispatch_parallelism && !job.promotion) {
				const spend = mandateSpend(mandate, counted);
				if (spend.inFlight >= mandate.dispatch_parallelism) {
					throw new MandateError(
						`${job.jobId}: mandate ${mandate.id} dispatch-parallelism ${mandate.dispatch_parallelism} is full`, { code: "parallelism_full" },
					);
				}
			}
		}
		const at = this.#stamp();
		for (const { id } of preapproved) {
			const grant = this.require(id);
			this.#write({ ...grant, risk_preapproved: [...(grant.risk_preapproved ?? []), preapprovedRow(grant, job.jobId, job.promotion ? "promote" : "dispatch", at, job.evidence)].slice(-500) });
		}
	}

	/** Record an operator risk:high pre-approval on a grant (`withPreapproval` checks it; audit rows stay). */
	preapproveRisk(id: string, record: RiskPreapproval): Mandate {
		return this.#write(withPreapproval(this.require(id), record));
	}

	/** `assertGrantsPermit` at this store's clock: the active grants covering the job, or the expired grant continuing it. */
	assertPermitted(use: GrantUse, job: { jobId: string; project: string; kind?: JobKind; pathHints?: string[] }, jobs: readonly MandateUsageJob[] = []): GrantPermission {
		const startedAt = jobs.find((record) => record.job_id === job.jobId && record.project === job.project)?.dispatched_at ?? this.jobCreatedAt(job.jobId);
		return assertGrantsPermit(this, use, { jobId: job.jobId, project: job.project, startedAt, ...(job.kind ? { jobKind: job.kind } : {}), ...(job.pathHints ? { pathHints: job.pathHints } : {}), ...this.scheduleOf(job.jobId) }, jobs, this.#stamp());
	}

	jobCreatedAt(jobId: string): string | undefined {
		return existsSync(join(this.home, LAYOUT.jobsFile)) ? readJobsDocument(this.home).jobs.find((job) => job.id === jobId)?.created_at : undefined;
	}

	/**
	 * A `dry_run` reads this instead of calling `assertDispatchAllowed`: the
	 * same predicate, with no escalation raised and nothing taken.
	 */
	wouldAskRiskHigh(job: { jobId: string; project: string; kind?: JobKind; pathHints?: string[]; script?: boolean }, risk: Risk | undefined): boolean {
		if (risk !== "high") return false;
		const now = this.#stamp();
		const scope = this.scheduleOf(job.jobId);
		const asking = this.sweep(now).filter((mandate) => covers(mandate, { ...job, ...scope }) && isActive(mandate, now) && mandate.ask_on.includes("risk:high"));
		return asking.length > 0 && !riskPreapproval(asking, job, this.jobCreatedAt(job.jobId)).covered;
	}

	/** The home's `token_ceiling`, raiseTokenCap's bound (src/mandate-usage.ts). */
	tokenCeiling = (): number => loadTokenCeiling(this.home);

	/** No write path \u2014 `save`, operator `issue` included \u2014 persists a token cap above the home's `token_ceiling`. */
	#underCeiling(m: Mandate): Mandate {
		const ceiling = this.tokenCeiling();
		if (m.spend_cap.tokens <= ceiling) return m;
		throw new MandateError(
			`${m.id}: ${m.spend_cap.tokens} tokens is over the home's token_ceiling ${ceiling} (data/mandate-defaults.json) \u2014 ` +
				`raise the ceiling first: cp_mandate defaults_set token_ceiling ${m.spend_cap.tokens}`,
		);
	}

	/** Re-write an existing grant and re-sweep it. USD is always re-read from disk (a new grant only); tokens obey `#underCeiling`. */
	save(m: Mandate, jobs: readonly MandateUsageJob[] = []): Mandate {
		const usd = this.require(m.id).spend_cap.usd;
		return this.#refresh(this.#write(this.#underCeiling({ ...m, spend_cap: { ...m.spend_cap, usd } })), this.#stamp(), this.withReviewerSpend(jobs));
	}

	show(id?: string, jobs: readonly MandateUsageJob[] = []): string {
		const counted = this.withReviewerSpend(jobs);
		const mandates = id ? [this.#refresh(this.require(id), this.#stamp(), counted)] : this.sweep(undefined, jobs);
		if (mandates.length === 0) return "no mandates";
		return mandates.map((mandate) => formatMandate(mandate, counted)).join("\n\n");
	}

	/** Close as `superseded` (no answer) every open escalation `supersedeReason` names; runs on revoke, expiry and issue,
	 * and on demand as `cp_mandate supersede_stale` for records left open before this rule. Returns what it closed. */
	supersedeEscalations(jobs: readonly MandateUsageJob[] = []): Escalation[] {
		const all = this.list();
		const scoped = this.withReviewerSpend(jobs, []); // lays on each scheduled record's schedule_mandate, reads no reviewer run
		return new EscalationStore({ home: this.home }).supersede((item) => supersedeReason(item, all, scoped, this.#stamp()));
	}

	/** A fresh `md-<6 hex>` no file holds yet; a schedule's fire lane names its grant with it before issuing (src/schedule-grant.ts). */
	mintId(): string {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const id = `md-${randomBytes(3).toString("hex")}`;
			if (!existsSync(this.file(id))) return id;
		}
		throw new MandateError("could not mint a unique mandate id");
	}

	#write(mandate: Mandate): Mandate {
		const parsed = validate<Mandate>(MandateSchema, mandate);
		if (!parsed.ok) {
			throw new MandateError(`refusing to write an invalid mandate:\n  ${parsed.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file(mandate.id), mandate);
		return parsed.value;
	}
}

function withEscalation(mandate: Mandate, escalation: MandateEscalation): MandateEscalation[] {
	if (mandate.escalations.some((entry) => entry.kind === escalation.kind)) return mandate.escalations;
	return [...mandate.escalations, escalation];
}
