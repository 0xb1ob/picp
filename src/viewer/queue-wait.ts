/**
 * Why a queued or waiting job has not started, read from the records the dispatcher itself reads: the ledger, the
 * fleet, both queues, the CLI slot limits, the grants and the schedule runs. The one source for the Jobs page, cp_next
 * and cp_status_block; nothing here guesses past what those records say, and an unexplained wait reads `unknown`.
 */
import { join } from "node:path";
import type { QueuedAtSource, QueueWait, QueueWaitKind, QueueWaited } from "./api-types.ts";
import { covers, dashboard, readMandates, scheduleMandates } from "./fleet-view.ts";
import { strings, timestamp } from "./overview-read.ts";
import { readScheduleRuns, type ScheduleRun } from "./schedule-run-core.ts";
import { fleetJobs, obj, readObject, str, type Json, type ViewerState } from "./sessions.ts";

const LIVE_NATIVE: readonly string[] = ["launching", "waiting", "held"];
const WORKING: readonly string[] = ["launching", "waiting"];
const CLI: Record<string, string> = { claude: "Claude", codex: "Codex" };
/** The schedule runner's note on a refused dispatch (src/schedule-runner.ts), retried each tick. */
const REFUSED = "dispatch refused";
// The dispatcher's full-slot refusal (src/dispatch-driver.ts over nativeSlotRefusal in src/drivers/claude.ts).
const OCCUPIED = /cannot run on the (Claude|Codex) CLI driver: \w+ concurrency is \d+/;

/** The files and slot limits each caller resolves its own sanctioned way: LAYOUT in the parent, viewer copies here. */
export interface QueueWaitSources {
	ledgerFile: string;
	dispatchQueueFile: string;
	nativeWaitFile: string;
	/** The slot count the dispatcher enforces for a CLI; undefined when this reader cannot know it. */
	maxConcurrent: (driver: string) => number | undefined;
}

type Reason = [QueueWaitKind, string];
type Stamp = [unknown, QueuedAtSource];

/** `12m`, `3h 5m`, `2d 4h`: a wait at a glance, the same words in every text surface. */
export function waitDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
	return days > 0 ? `${days}d ${hours % 24}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const rows = (file: string, key: string): Json[] => {
	const value = readObject(file)?.[key];
	return Array.isArray(value) ? value.map(obj).filter((row): row is Json => row !== undefined) : [];
};
const since = (at: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
const labelled = (labels: readonly string[], prefix: string): string | undefined =>
	labels.find((label) => label.startsWith(prefix))?.slice(prefix.length);
const refusals = (job: Json | undefined): Json[] => (Array.isArray(job?.comments) ? job.comments.map(obj) : [])
	.filter((c): c is Json => !!c && timestamp(c.at) && str(c.text)?.startsWith(REFUSED) === true);
const isOpenBlocker = (blocker: Json | undefined): boolean =>
	!blocker || blocker.status !== "closed" || String(blocker.close_reason ?? "").startsWith("dropped:");

function openRuns(state: ViewerState): ScheduleRun[] {
	try {
		return readScheduleRuns(join(state.stateDir, "schedule-runs.json")).filter((run) => run.phase !== "closed");
	} catch {
		return []; // an unreadable runs file: its members fall through to the grant reasons
	}
}

/** The records one call reads once; every reason below is a pure function of them. */
function snapshot(state: ViewerState, sources: QueueWaitSources, now: number) {
	const ledger = rows(sources.ledgerFile, "jobs"), fleet = fleetJobs(state);
	const used = (driver: string): number => fleet.filter((r) => obj(r.worker)?.driver === driver
		&& obj(r.worker)?.exited_at === undefined && LIVE_NATIVE.includes(String(r.phase))).length;
	return {
		ledger, byId: new Map(ledger.map((job) => [String(job.id), job])),
		fleetById: new Map(fleet.map((record) => [String(record.job_id), record])),
		queued: rows(sources.dispatchQueueFile, "entries"),
		waiting: rows(sources.nativeWaitFile, "entries"),
		cli: (driver: string): string => {
			const max = sources.maxConcurrent(driver);
			return `waiting for a ${CLI[driver] ?? driver} CLI slot (${used(driver)}${max === undefined ? " live" : `/${max}`})`;
		},
		runs: openRuns(state), grants: readMandates(state), schedules: scheduleMandates(state),
		accounting: dashboard(state, now, Infinity).mandates, now,
	};
}
type Snapshot = ReturnType<typeof snapshot>;

/** A ready, unqueued job: its run's slots, else the grant that would admit it (the dispatcher's own coverage). */
function admission(s: Snapshot, job: Json, run: ScheduleRun | undefined): Reason {
	const id = String(job.id), labels = strings(job.labels);
	if (run) {
		const live = run.members.filter((m) => WORKING.includes(String(s.fleetById.get(m.job_id)?.phase))).length;
		const cap = run.execution?.effective.parallelism ?? run.policy.limits.parallelism;
		return live >= cap ? ["grant_slot", `waiting for a run slot (${live}/${cap} under ${run.id})`]
			: ["ready", `ready in ${run.id} (${live}/${cap} slots busy)`];
	}
	const scheduleId = labelled(labels, "schedule:");
	const subject = { job, job_id: id, project: labelled(labels, "project:") ?? "", kind: labelled(labels, "kind:"),
		schedule_id: scheduleId, schedule_mandate: scheduleId ? s.schedules.get(scheduleId) : undefined };
	const matching = s.grants.filter((m) => covers(m, subject) && Date.parse(String(m.issued_at)) <= s.now);
	const unexpired = (m: Json): boolean => Date.parse(String(m.expiry)) > s.now;
	const committed = (m: Json): boolean => obj(m.continuity)?.phase === "committed";
	const active = matching.filter((m) => (m.status === "active" && unexpired(m)) || committed(m));
	const grant = active.findLast((m) => strings(m.job_ids).length > 0) ?? active.at(-1);
	if (grant) {
		const shown = s.accounting.find((m) => m.id === grant.id), gid = String(grant.id);
		const cap = shown?.dispatch_parallelism ?? 1, busy = shown?.spend.inFlight ?? 0, jobs = shown?.spend.jobs ?? 0;
		if (busy >= cap) return ["grant_slot", `waiting for a grant slot (${busy}/${cap} under ${gid})`];
		const jobCap = shown?.job_cap ?? Infinity;
		if (jobs >= jobCap) return ["grant_slot", `the grant ${gid} reached its job cap (${jobs}/${jobCap})`];
		return ["ready", `ready under ${gid} (${busy}/${cap} slots busy); cp_next recommends its dispatch`];
	}
	const paused = matching.findLast((m) => m.status === "paused" && unexpired(m));
	if (paused) {
		const why = str(paused.pause_reason);
		return ["grant_paused", why === "operator" ? "its grant is paused by the operator; nothing starts until it resumes"
			: `the grant ${String(paused.id)} is paused (${why ?? "no reason recorded"}); nothing starts until it resumes`];
	}
	const expired = matching.findLast((m) => m.status === "expired" || (m.status !== "revoked" && !unexpired(m)));
	const gone = expired ? `the grant ${String(expired.id)} expired ${String(expired.expiry)}` : undefined;
	if (gone) return ["grant_expired", `${gone}; nothing will start it`];
	return ["no_grant", "no grant or mandate covers it, so nothing will start it"];
}

/** One open ledger job with no fleet record: the first matching rule wins, with the best stamp it recorded. */
function ledgerWait(s: Snapshot, job: Json): [...Reason, ...Stamp] {
	const id = String(job.id), created: Stamp = [job.created_at, "created"];
	const run = s.runs.find((r) => r.members.some((m) => m.job_id === id));
	if (job.status === "deferred") {
		return labelled(strings(job.labels), "schedule:") || run?.anchor_job_id === id
			? ["anchor", `an anchor job, never dispatched: ${run ? `run ${run.id}'s` : "its schedule run's"} jobs do the work`,
				...created]
			: ["backlog", "backlog (deferred): not dispatched until cp_job update status=open", ...created];
	}
	const blockers = strings(job.blocked_by), open = blockers.filter((b) => isOpenBlocker(s.byId.get(b)));
	const more = open.length > 3 ? ` (+${open.length - 3} more)` : "";
	if (open.length) return ["dependency", `blocked by ${open.slice(0, 3).join(", ")}${more}`, ...created];
	const entry = s.queued.find((e) => e.job_id === id), driver = str(entry?.waiting_driver);
	if (entry) {
		const position = s.queued.indexOf(entry) + 1;
		const slot = driver ? s.cli(driver) : `waiting for a worker slot (spawn cap; queue position ${position})`;
		return [driver ? "cli_slot" : "worker_slot", slot, entry.queued_at, "dispatch_queue"];
	}
	const noted = refusals(job), last = str(noted.at(-1)?.text);
	if (last) {
		const full = OCCUPIED.exec(last)?.[1]?.toLowerCase();
		const refusal = last.replace(/^dispatch refused \S+: /, "dispatch refused: ").slice(0, 160);
		const text = full ? s.cli(full) : `last ${refusal}`;
		return [full ? "cli_slot" : "unknown", text, noted[0]!.at, "refused_dispatch"];
	}
	const closed = blockers.map((b) => s.byId.get(b)?.closed_at).filter(timestamp).sort().at(-1);
	const stamp: Stamp = closed && closed > String(job.created_at) ? [closed, "unblocked"] : created;
	return [...admission(s, job, run), ...stamp];
}

/** Every queued or waiting job's wait: open or deferred jobs with no fleet record, and native-wait-queue entries. */
export function queueWaits(state: ViewerState, sources: QueueWaitSources, now = Date.now()): Map<string, QueueWait> {
	const s = snapshot(state, sources, now), out = new Map<string, QueueWait>();
	const put = (id: string, [kind, reason, at, source]: [...Reason, ...Stamp]): void => {
		if (!timestamp(at)) return;
		out.set(id, { kind, reason, queued_at: at, queued_at_source: source, waiting_seconds: since(at, now) });
	};
	for (const entry of s.waiting) {
		const id = str(entry.job_id), driver = str(entry.driver);
		if (!id || !driver || out.has(id) || s.byId.get(id)?.status === "closed") continue;
		put(id, ["cli_slot", `its ${str(entry.kind) ?? "start"} is ${s.cli(driver)}`, entry.queued_at, "native_wait"]);
	}
	for (const job of s.ledger) {
		const id = String(job.id);
		// An in_progress job with no fleet record is a dispatch in flight (or a ledger disagreeing), never queued.
		const unstarted = job.status === "open" || job.status === "deferred";
		if (unstarted && !out.has(id) && !s.fleetById.has(id)) put(id, ledgerWait(s, job));
	}
	return out;
}

/** A started job's wait: dispatch minus its park stamp (queue entry, else first refused dispatch); else null. */
export function queueWaited(job: Json | undefined, record: Json | undefined): QueueWaited | null {
	const started = record?.dispatched_at;
	if (!timestamp(started)) return null;
	const refused = refusals(job).find((c) => String(c.at) <= started)?.at;
	const [at, source]: Stamp = timestamp(record?.queued_at) ? [record.queued_at, "dispatch_queue"]
		: [refused, "refused_dispatch"];
	if (!timestamp(at) || at > started) return null;
	return { queued_at: at, queued_at_source: source, seconds: since(at, Date.parse(started)) };
}
