/**
 * `cp_next` — one read, no dispatch, no jobs created (pi-command-post-autonomy-programme-cur.4.1).
 *
 * The parent's own queue is `cp_job ready`; this module answers the one
 * question a continuation loop needs after every wake-up: under the active
 * mandate, which ready jobs does it cover, how many workers are already live
 * against its `dispatch_parallelism`, what are its remaining caps, and what
 * should happen next — dispatch a job, start a pipeline, wait, or (every
 * named job closed) recommend a mission-end escalation. The recommendation is
 * derived from job labels and the ledger's own dependency graph
 * (`ledger.ready()` already drops blocked jobs), never from prose.
 *
 * Every active or paused mandate covering `project` is evaluated on its own
 * (revoked and expired grants never count), so each one's mission end is raised
 * by itself. The headline result is the first grant with a dispatch or pipeline
 * to recommend, else the first in order (active before paused, then issue
 * order); every other grant's result rides along in `others`.
 */

import { type Escalation, type FleetRecord, isoTimestamp, type Mandate } from "./contracts.ts";
import { raiseMissionEnd } from "./escalation.ts";
import type { EscalationStore } from "./escalation.ts";
import { type FleetStore, isPidAlive } from "./fleet.ts";
import { type BlockedJob, blockedJobs, raiseDroppedDependencies } from "./blocked-jobs.ts";
import { type Job, type Ledger, parseJobLabels, wasDropped } from "./ledger.ts";
import { covers, jobCapRefuses, mandateSpend, type MandateStore, type ScheduleScope, scheduleIdOf, scheduleScope } from "./mandate.ts";
import { inFlightRecord, selectGrant } from "./mandate-permission.ts";
import type { PipelineStore } from "./pipeline.ts";
import { execRunner } from "./doctor.ts";
import { homeCheckoutFinding, PACKAGE_ROOT } from "./home.ts";
import type { ProjectRegistry } from "./projects.ts";
import type { CommandRunner } from "./merge-ask.ts";
import { formatReadyBeads, readReadyBeads, type ReadyBeads } from "./ready-beads.ts";
import { readDrain } from "./drain.ts";
import { runnerOwns } from "./schedule-runner.ts";
import { readParentExpanded } from "./schedule-expand.ts";

export interface NextPorts {
	packageRoot?: string;
	registry?: ProjectRegistry;
	beadExec?: CommandRunner;
	ledger: Ledger;
	fleet: FleetStore;
	mandates: MandateStore;
	escalations: EscalationStore;
	/** When present, a ready job with a pipeline record recommends `cp_pipeline advance`, not `cp_dispatch`. */
	pipelines?: PipelineStore;
	now?: () => Date;
	/**
	 * Live worker processes against the manager's `spawn_cap`; `held` are job ids whose fleet phase is `held`,
	 * `releasable` how many of their live, idle processes a dispatch may release (4b-1), `reserved` slots already
	 * held for a dispatch in progress.
	 */
	capacity?: () => { active: number; cap: number; held: string[]; releasable?: number; reserved?: number };
	/** 4b-2: job ids in the persisted dispatch queue (`DispatchQueue.ids`). */
	queued?: () => string[];
}

export type NextActionKind = "dispatch" | "pipeline" | "wait" | "no_mandate" | "paused" | "mission_end" | "draining";

export interface NextAction {
	kind: NextActionKind;
	job_id?: string;
	reason: string;
}

export interface NextMandateView {
	id: string;
	status: "active" | "paused" | "revoked" | "expired";
	parallelism: number;
	/** Jobs actively working (`waiting`); a `held` delivery counts toward spend and jobs, not here. */
	live_workers: number;
	spend_usd: number;
	spend_cap_usd: number;
	tokens: number;
	token_cap: number;
	jobs_used: number;
	job_cap: number;
}

export interface NextResult {
	/** Advisory only; never changes the mandate recommendation. */
	warning?: string;
	/** Workers working across the whole fleet, every mandate: `live_workers` is one grant's scope only. */
	fleet_live_workers?: number;
	ready_beads?: ReadyBeads[];
	mandate?: NextMandateView;
	/** Open, unblocked jobs this mandate covers — the parent's dispatch candidates without reading files. */
	ready: Job[];
	/** Dependency facts only; these jobs are never dispatch candidates. */
	blocked?: BlockedJob[];
	action: NextAction;
	escalation_id?: string;
	/** The other covering mandates' own results, each with its own action and mission-end escalation. */
	others?: NextResult[];
}

function jobProject(job: Job): string | undefined {
	return parseJobLabels(job.labels).project;
}

function jobKind(job: Job) {
	return parseJobLabels(job.labels).kind;
}

function blockedReason(rows: readonly BlockedJob[]): string {
	return rows.slice(0, 3).map((row) => `${row.job.id}: waiting on ${row.waiting_on}`).join("; ") + (rows.length > 3 ? `; +${rows.length - 3} more blocked jobs` : "");
}

/**
 * A reported research job left held or waiting after its worker died: nothing is left to deliver, only `cp_teardown`.
 * Never a ship hold — a `delivery:pr` ship with a dead worker is the contract until its PR lands. Advisory only.
 */
function deadReportedResearch(jobs: readonly FleetRecord[]): string | undefined {
	const ids = jobs
		.filter((job) => job.kind === "research" && (job.phase === "held" || job.phase === "waiting") && job.reported_at && typeof job.worker?.pid === "number" && !isPidAlive(job.worker.pid))
		.map((job) => job.job_id);
	if (!ids.length) return undefined;
	return `reported research with a dead worker: ${ids.slice(0, 3).map((id) => `${id} — cp_teardown ${id}`).join("; ")}${ids.length > 3 ? `; +${ids.length - 3} more` : ""}`;
}

export async function cpNext(ports: NextPorts, project?: string): Promise<NextResult> {
	const checkout = homeCheckoutFinding(ports.fleet.home, ports.packageRoot ?? PACKAGE_ROOT, execRunner);
	const fleetJobs = ports.fleet.read().jobs;
	const notes = [checkout ? `${checkout.what}: ${checkout.fix}` : undefined, deadReportedResearch(fleetJobs)].filter((note) => note !== undefined);
	const warning = notes.length ? { warning: notes.join("\n") } : {};
	const drain = readDrain(ports.fleet.home);
	if (drain) return { ...warning, ready: [], action: { kind: "draining", reason: `draining since ${drain.started_at} (${drain.state}): no dispatch, promotion or new merge step until the parent restarts` } };
	const now = isoTimestamp((ports.now ?? (() => new Date()))());
	const fleetLive = fleetJobs.filter((job) => job.phase === "waiting" || job.phase === "launching").length;
	const grants = ports.mandates.sweep(now, fleetJobs);
	const beads = ports.registry ? await readReadyBeads(ports.registry, ports.ledger, project, ports.beadExec) : [];
	const visibleBeads = beads.filter((row) => {
		if (row.error) return true;
		// A bead becomes an unscheduled job, which no schedule grant covers (schedlater S3): only the grants that could
		// carry it decide whether a slot is free. Their inFlight already excludes scheduled records (schedule_id).
		const active = grants.filter((grant) => grant.status === "active" && !grant.schedule_grant && grant.projects.includes(row.project));
		return !active.length || active.some((grant) => mandateSpend(grant, fleetJobs).inFlight < (grant.dispatch_parallelism ?? 1));
	});
	const schedules = ports.mandates.scheduleMandates();
	const scopeOf = (job: Job) => scheduleScope(scheduleIdOf(job.labels), schedules);
	const blocked = blockedJobs(ports.ledger, grants, now, project, schedules);
	await raiseDroppedDependencies(blocked, grants, ports.escalations, now, schedules);
	const candidates = grants
		.filter((mandate) => mandate.status === "active" || mandate.status === "paused")
		.filter((mandate) => !project || mandate.projects.includes(project))
		// An active grant always wins over a paused one, whatever their issue order.
		.sort((a, b) => Number(b.status === "active") - Number(a.status === "active"));
	if (candidates.length === 0) {
		return { ...warning, fleet_live_workers: fleetLive, ready: [], blocked, ready_beads: visibleBeads, action: { kind: "no_mandate", reason: `no active mandate covers this project${blocked.length ? `; ${blockedReason(blocked)}` : ""}` } };
	}
	const readyAll = await ports.ledger.ready(project ? { project } : {});
	const selected = new Map(readyAll.map((job) => {
		const subject = { jobId: job.id, project: jobProject(job) ?? "", jobKind: jobKind(job), ...scopeOf(job) };
		const record = inFlightRecord(subject, fleetJobs);
		return [job.id, selectGrant(grants, "dispatch", { ...subject, startedAt: record?.dispatched_at ?? job.created_at, inFlight: record !== undefined, failed: record?.phase === "failed" }, now, fleetJobs)] as const;
	}));
	const queued = new Set(ports.queued?.() ?? []);
	const results: NextResult[] = [];
	const expanded = readParentExpanded(ports.fleet.home);
	for (const mandate of candidates) {
		const ownBlocked = blocked.filter(({ job }) => covers(mandate, { jobId: job.id, project: jobProject(job) ?? "", jobKind: jobKind(job), ...scopeOf(job) }));
		const result = await nextForMandate(ports, mandate, readyAll, fleetJobs, selected, queued, expanded);
		if (result.action.kind === "wait" && result.ready.length === 0 && ownBlocked.length) result.action.reason = blockedReason(ownBlocked);
		results.push({ ...result, blocked: ownBlocked });
	}
	// Uncovered dependencies still need a visible explanation, but never an automatic question.
	const uncovered = blocked.filter(({ job }) => !candidates.some((mandate) => covers(mandate, { jobId: job.id, project: jobProject(job) ?? "", jobKind: jobKind(job), ...scopeOf(job) })));
	// The manager refuses a non-reviewer spawn at its cap (held authors keep their process); 4b-2: cp_dispatch then
	// queues the job and starts it when a slot frees, so `dispatch` stays the recommendation and the reason says so.
	// `pipeline` is left as is: `cp_pipeline advance` spawns a gate-reviewer (inside the +3 review reserve) or nothing.
	const capacity = results.some((result) => result.action.kind === "dispatch") ? ports.capacity?.() : undefined;
	// 4b-1: an idle held author's slot is released on demand, so it counts as free; a reserved slot counts as taken.
	if (capacity && capacity.active + (capacity.reserved ?? 0) - (capacity.releasable ?? 0) >= capacity.cap) {
		const held = capacity.held.length ? ` (held: ${capacity.held.slice(0, 3).join(", ")}${capacity.held.length > 3 ? `, +${capacity.held.length - 3} more` : ""})` : "";
		for (const result of results) {
			if (result.action.kind !== "dispatch") continue;
			result.action.reason = `spawn cap ${capacity.cap} full: ${capacity.active} live worker processes${held} — cp_dispatch queues it; ${result.action.job_id} starts under ${result.mandate!.id} when one frees`;
		}
	}
	const primary = results.find((result) => result.action.kind === "dispatch" || result.action.kind === "pipeline") ?? results[0]!;
	primary.blocked = [...(primary.blocked ?? []), ...uncovered];
	primary.ready_beads = visibleBeads;
	const others = results.filter((result) => result !== primary);
	return { ...primary, ...warning, fleet_live_workers: fleetLive, ...(others.length > 0 ? { others } : {}) };
}

async function nextForMandate(ports: NextPorts, mandate: Mandate, readyAll: readonly Job[], fleetJobs: readonly FleetRecord[], selected: ReadonlyMap<string, ReturnType<typeof selectGrant>>, queued: ReadonlySet<string>, expanded: ReadonlySet<string>): Promise<NextResult> {
	const covered = readyAll.filter((job) => {
		const choice = selected.get(job.id);
		// Runner-owned jobs stay with the runner; each parent candidate belongs to one selected active view.
		return !runnerOwns(job, expanded) && choice?.grant.id === mandate.id && choice.at.standing === "permit" && choice.at.cause === "active";
	});
	// 4b-2: a queued job is already dispatched as far as the parent is concerned: never ready, and it holds a slot.
	const ready = covered.filter((job) => !queued.has(job.id));
	const queuedCovered = covered.length - ready.length;
	const counted = ports.mandates.withReviewerSpend(fleetJobs, [mandate]);
	const spend = mandateSpend(mandate, counted);
	const parallelism = mandate.dispatch_parallelism ?? 1;
	const view: NextMandateView = {
		id: mandate.id,
		status: mandate.status,
		parallelism,
		live_workers: spend.inFlight,
		spend_usd: spend.usd,
		spend_cap_usd: mandate.spend_cap.usd,
		tokens: spend.tokens,
		token_cap: mandate.spend_cap.tokens,
		jobs_used: spend.jobs,
		job_cap: mandate.job_cap,
	};

	if (mandate.status === "paused") {
		const ceiling = ports.mandates.tokenCeiling();
		const raise =
			mandate.pause_reason === "token_cap"
				? mandate.spend_cap.tokens < ceiling
					? ` — decide it yourself: cp_mandate raise_tokens ${mandate.id} with a reason, up to token_ceiling ${ceiling}`
					: ` — at token_ceiling ${ceiling}: budget_exhausted is the operator's`
				: "";
		return {
			mandate: view,
			ready,
			action: {
				kind: "paused",
				reason: `${mandate.id} is paused${mandate.pause_reason ? ` (${mandate.pause_reason})` : ""} — no new dispatch; in-flight continues${raise}`,
			},
		};
	}

	if (mandate.job_ids && mandate.job_ids.length > 0) {
		const allJobs = await ports.ledger.list({ all: true });
		const named = mandate.job_ids.map((id) => allJobs.find((job) => job.id === id)).filter((job): job is Job => job !== undefined);
		if (named.length === mandate.job_ids.length && named.every((job) => job.status === "closed")) {
			const dropped = named.filter(wasDropped).length;
			const failed = named.filter((job) => fleetJobs.some((record) => record.job_id === job.id && record.phase === "failed")).length;
			const summary = `landed ${named.length - dropped}, dropped ${dropped}${failed ? `, failed ${failed}` : ""}, cost $${spend.usd.toFixed(2)}`;
			let autoClosed = false;
			let escalation: Escalation | undefined;
			let answered: Escalation | undefined;
			try {
				// An answered mission end (close or extend) is terminal for this grant and job set: never re-asked.
				// A replacement grant has its own id, so its own mission end is still raised.
				const jobSet = [...mandate.job_ids].sort().join(",");
				answered = ports.escalations
					.list({ kind: "mission_end", status: "answered" })
					.find((item) => item.mandate_id === mandate.id && [...item.job_ids].sort().join(",") === jobSet);
				escalation = answered ?? (await raiseMissionEnd(ports.escalations, { jobIds: mandate.job_ids, mandateId: mandate.id, summary }));
				// A clean finish (all landed, none dropped or failed) closes itself: the grant's own answer, journaled on the
				// escalation (answered_by, basis), then the same revoke `cp_decide close` runs. A messy one stays open for a human.
				if (!answered && dropped === 0 && failed === 0) {
					// `selfAnswered`: this runs only inside the parent's own `cp_next` call, whose result below reports the close,
					// so its `cp-answered` echo would be a duplicate parent turn. Only this clean own close is marked; every
					// other mandate auto-decision still wakes (`src/answered.ts`, "Self-answers do not echo").
					answered = await ports.escalations.answer(escalation.id, { answer: "close", by: `mandate:${mandate.id}`, basis: { mandate: mandate.id, clause: `${mandate.id}: every named job landed clean — mission closed automatically` }, selfAnswered: true });
					ports.mandates.revoke(mandate.id, { by: "system" });
					autoClosed = true;
				}
			} catch {
				// A malformed prior record must not block the recommendation itself.
			}
			return {
				mandate: view,
				ready: [],
				action: {
					kind: "mission_end",
					reason: `${mandate.id}: every named job is closed — ${summary}${autoClosed ? ` — landed clean: ${answered!.id} answered close by ${answered!.answered_by}, grant revoked` : answered ? ` — already answered "${answered.answer ?? ""}" in ${answered.id}; not re-asked` : ""}`,
				},
				...(escalation ? { escalation_id: escalation.id } : {}),
			};
		}
	}

	if (ready.length === 0) {
		return { mandate: view, ready, action: { kind: "wait", reason: "nothing ready under this mandate" } };
	}
	if (spend.inFlight + queuedCovered >= parallelism) {
		return {
			mandate: view,
			ready,
			action: { kind: "wait", reason: `${mandate.id} dispatch-parallelism ${parallelism} is full — waiting on an in-flight job${queuedCovered ? ` (${queuedCovered} queued)` : ""}` },
		};
	}

	// The job cap limits new dispatches only; the jobs already counted keep their review, repair and merge.
	const target = ready.find((job) => !jobCapRefuses(mandate, job.id, counted));
	if (!target) {
		return {
			mandate: view,
			ready,
			action: { kind: "wait", reason: `${mandate.id} job cap ${mandate.job_cap} reached \u2014 no new dispatch; covered jobs continue review, repair and merge` },
		};
	}
	const pipeline = ports.pipelines?.get(target.id);
	return {
		mandate: view,
		ready,
		action: pipeline
			? { kind: "pipeline", job_id: target.id, reason: `start pipeline for ${target.id} under ${mandate.id}` }
			: { kind: "dispatch", job_id: target.id, reason: `dispatch ${target.id} under ${mandate.id}` },
	};
}

/** One-line-per-fact rendering: enough for the parent to act without reading files. */
export function formatNext(result: NextResult): string {
	const lines: string[] = [];
	if (result.warning) lines.push(`warning: ${result.warning}`);
	if (result.mandate) {
		const m = result.mandate;
		lines.push(`${m.id}: ${m.status}, ${m.live_workers}/${m.parallelism} workers working under this mandate`);
		lines.push(`  spend: $${m.spend_usd.toFixed(2)} / $${m.spend_cap_usd.toFixed(2)}; ${m.tokens} / ${m.token_cap} tokens; jobs ${m.jobs_used} / ${m.job_cap}`);
	} else {
		lines.push("no active mandate");
	}
	if (result.fleet_live_workers !== undefined) lines.push(`fleet: ${result.fleet_live_workers} workers working across all mandates`);
	lines.push(result.ready.length === 0 ? "ready: (none)" : `ready: ${result.ready.map((job) => job.id).join(", ")}`);
	for (const row of (result.blocked ?? []).slice(0, 10)) {
		lines.push(`blocked: ${row.job.id}: waiting on ${row.waiting_on}${row.escalation_ids?.length ? `; cp_decide ${row.escalation_ids.join(", ")}` : ""}`);
	}
	if ((result.blocked?.length ?? 0) > 10) lines.push(`blocked: +${result.blocked!.length - 10} more jobs`);
	lines.push(`action: ${result.action.kind}${result.action.job_id ? ` ${result.action.job_id}` : ""} \u2014 ${result.action.reason}`);
	if (result.escalation_id) lines.push(`escalation: ${result.escalation_id}`);
	for (const other of result.others ?? []) lines.push(needsAction(other) ? formatNext(other) : compactOther(other));
	lines.push(...formatReadyBeads(result.ready_beads ?? []));
	return lines.join("\n");
}

/** An `others` grant the parent must act on renders in full; the rest (waiting, paused) is one line each, so output does not grow per grant. */
function needsAction(result: NextResult): boolean {
	const kind = result.action.kind;
	return kind === "dispatch" || kind === "pipeline" || kind === "mission_end" || result.escalation_id !== undefined || result.warning !== undefined || (result.blocked ?? []).some((row) => row.escalation_ids?.length);
}

function compactOther(result: NextResult): string {
	const m = result.mandate;
	const head = m ? `${m.id}: ${m.status} ${m.live_workers}/${m.parallelism}, jobs ${m.jobs_used}/${m.job_cap}` : "no active mandate";
	return `${head} \u2014 ${result.action.kind}: ${result.action.reason}`;
}

/** A `cp_next` answer identical to the last one for the same scope is one line, not the whole block again. */
export function dedupeNext(seen: Map<string, { text: string; at: string }>, scope: string, text: string, at: string): string {
	const prev = seen.get(scope);
	if (prev?.text === text) return `cp_next unchanged since ${prev.at}: nothing new — end the turn unless a wake-up brought news (cp_next full: true returns the whole answer).`;
	seen.set(scope, { text, at });
	return text;
}
