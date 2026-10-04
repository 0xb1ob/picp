/**
 * Envelope supersession — the mechanics behind one invariant:
 *
 *   **a worker that can be given work must have a way to report it.**
 *   A job is never simultaneously promotable and unreportable.
 *
 * The defect this exists to make impossible: a job files a `blocked` envelope,
 * intake stamps `reported_at` and moves it to `held`, and the parent then
 * promotes it twice with `cp_send`. Both prompts are accepted, both run to
 * completion, the worker pushes a branch and opens a PR — and none of it is
 * ever reported, because `envelope.json` is write-once and `reported_at` is
 * already stamped. Nothing refuses anything; the work is discovered by
 * accident hours later. That silence was the bug.
 *
 * The fix is not to forbid the promote (a `blocked` job whose blocker the
 * operator just cleared is exactly the worker you want to keep — it holds all
 * the context). It is to **reopen the envelope slot** as part of the promote:
 *
 *  1. archive the filed envelope to `envelope-superseded-<n>.json` — moving it
 *     aside is what makes the worker's write-once record writable again, and
 *     nothing is ever destroyed;
 *  2. clear `reported_at` and move the job back to `waiting`;
 *  3. journal a `cp:envelope_superseded` event, so the supersession is a fact
 *     in the run log rather than an inference from two `envelope_received`
 *     counts that do not exist.
 *
 * And one boundary, drawn explicitly: **a delivery that has landed is not
 * reopenable.** A job that is `done`, or that carries a merged PR receipt, is
 * refused with the sanctioned path (teardown + fresh dispatch) rather than
 * being quietly revived by a stray brief.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type EnvelopeStatus, type FleetRecord, isoTimestamp, paths, type Receipt } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import type { RunRegistry } from "./runs.ts";

export class SupersedeError extends Error {}

/**
 * PR receipt statuses that mean the delivery landed. Intake writes `open`; a
 * landed status is set by whoever observes the merge. Compared lowercased and
 * trimmed, because this line is too important to lose to a capital letter.
 */
export const LANDED_RECEIPT_STATUSES: readonly string[] = Object.freeze(["merged", "landed"]);

/** The landed PR receipt, when there is one. Facts only: no git, no network. */
export function landedReceipt(record: FleetRecord): Receipt | undefined {
	return (record.receipts ?? []).find(
		(receipt) => receipt.kind === "pr" && LANDED_RECEIPT_STATUSES.includes(receipt.status.trim().toLowerCase()),
	);
}

export type ReopenDecision =
	/** Nothing is filed: the slot is already open and the promote is ordinary. */
	| { kind: "open" }
	/** An envelope is filed and may be superseded; `generation` is the new one. */
	| { kind: "reopen"; reported_at: string; generation: number }
	/** Fail closed, with the path that is sanctioned instead. */
	| { kind: "refuse"; reason: string };

/**
 * Pure policy. The only question: may a brief delivered right now still be
 * reported? Everything it looks at is on the record.
 */
export function decideReopen(record: FleetRecord): ReopenDecision {
	const landed = landedReceipt(record);
	if (landed) {
		return {
			kind: "refuse",
			reason:
				`${record.job_id} has a landed delivery (${landed.kind} ${landed.status}${landed.url ? `: ${landed.url}` : ""}) — ` +
				"its envelope slot cannot be reopened, so a brief sent now could never be reported. " +
				`Follow-up work on a landed delivery is teardown + fresh dispatch: cp_teardown ${record.job_id}, then cp_dispatch a new job id.`,
		};
	}
	if (record.phase === "done") {
		return {
			kind: "refuse",
			reason:
				`${record.job_id} is done${record.closed_at ? ` (closed at ${record.closed_at})` : ""}: the lease is returned and ` +
				"the envelope slot is closed, so a brief sent now could never be reported. Dispatch a fresh job with its own job id.",
		};
	}
	if (record.phase === "failed") {
		return {
			kind: "refuse",
			reason:
				`${record.job_id} is failed (${record.failure?.class ?? "no class recorded"}): recover or re-dispatch it deliberately — ` +
				"a brief does not revive a failed job.",
		};
	}
	if (record.reported_at === undefined) return { kind: "open" };
	return {
		kind: "reopen",
		reported_at: record.reported_at,
		generation: (record.supersessions ?? 0) + 1,
	};
}

/** What one supersession did. Facts, no bodies — the summary never travels. */
export interface Supersession {
	job_id: string;
	at: string;
	/** The generation that was closed by this supersession (1 for the first). */
	generation: number;
	/** The `reported_at` that was cleared. */
	prior_reported_at: string;
	/** `done` | `blocked`, read off the archived record when it was legible. */
	prior_status?: EnvelopeStatus;
	/** Where the superseded envelope now lives, relative to the home. */
	archived?: string;
	/** Why the slot was reopened, in one clause. Never a brief body. */
	reason: string;
}

export interface ReopenOptions {
	home: string;
	fleet: FleetStore;
	runs: RunRegistry;
	jobId: string;
	/** One clause for the run log, e.g. "promoted with a new brief (cp_send)". */
	reason: string;
	now?: () => Date;
}

/**
 * Reopen the envelope slot for a job that already reported.
 *
 * Returns `undefined` when there was nothing filed (an ordinary promote) and
 * throws `SupersedeError` when the delivery has landed — never silently.
 *
 * Called BEFORE the message is delivered, deliberately: the invariant is that
 * a worker holding a brief can always report, so the slot opens first and the
 * message follows. A refused delivery then leaves an open slot and an archived
 * envelope, which is visible, recorded and recoverable — the opposite ordering
 * leaves a window in which the worker is already working and cannot report,
 * which is the whole defect.
 */
export async function reopenEnvelopeSlot(options: ReopenOptions): Promise<Supersession | undefined> {
	const { home, fleet, runs, jobId } = options;
	const now = options.now ?? (() => new Date());
	const record = fleet.require(jobId);

	const decision = decideReopen(record);
	if (decision.kind === "refuse") throw new SupersedeError(decision.reason);
	if (decision.kind === "open") return undefined;

	const { generation, reported_at: priorReportedAt } = decision;
	const envelopeFile = join(home, paths.envelopeFile(jobId));
	const priorStatus = readEnvelopeStatus(envelopeFile);
	const archived = archive(envelopeFile, join(home, paths.supersededEnvelopeFile(jobId, generation)));
	// An exhausted worker's rejection record is archived with it: left in place
	// it would make the next intake fail a job that is working again.
	archive(
		join(home, paths.runDir(jobId), "envelope-rejected.json"),
		join(home, paths.supersededRejectionFile(jobId, generation)),
	);

	await fleet.mutate((jobs) => {
		const job = jobs.find((candidate) => candidate.job_id === jobId);
		if (!job) throw new SupersedeError(`no fleet record for ${jobId}`);
		delete job.reported_at;
		job.phase = "waiting";
		job.supersessions = generation;
	});

	const supersession: Supersession = {
		job_id: jobId,
		at: isoTimestamp(now()),
		generation,
		prior_reported_at: priorReportedAt,
		...(priorStatus ? { prior_status: priorStatus } : {}),
		...(archived ? { archived: paths.supersededEnvelopeFile(jobId, generation) } : {}),
		reason: options.reason,
	};
	runs.open(jobId).cp("envelope_superseded", { ...supersession });
	return supersession;
}

/**
 * The last envelope this job filed: the live one, or — once a promote reopened
 * the slot — the newest archived generation. Supersession moves the record
 * aside so the worker can write again; it never destroys what the worker said,
 * and a reader that wants the last reported facts (the planner's
 * `self_assessment`, say) must still be able to find them.
 */
export function lastFiledEnvelopeFile(home: string, record: FleetRecord): string | undefined {
	const live = join(home, paths.envelopeFile(record.job_id));
	if (existsSync(live)) return live;
	for (let generation = record.supersessions ?? 0; generation >= 1; generation -= 1) {
		const archived = join(home, paths.supersededEnvelopeFile(record.job_id, generation));
		if (existsSync(archived)) return archived;
	}
	return undefined;
}

/** `true` when something was moved. A missing file is not an error. */
function archive(from: string, to: string): boolean {
	if (!existsSync(from)) return false;
	mkdirSync(dirname(to), { recursive: true });
	renameSync(from, to);
	return true;
}

/**
 * The status field only — a control message, the way intake already reads one.
 * Unreadable is not fatal: the supersession is the fact, the label is a bonus.
 */
function readEnvelopeStatus(file: string): EnvelopeStatus | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { envelope?: { status?: unknown } };
		const status = parsed.envelope?.status;
		return status === "done" || status === "blocked" ? status : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Frozen-task replacement (cp-promote-task-record): the same archive-then-
// write shape as envelope supersession, applied to `paths.originalTaskFile`
// instead of `envelope.json`. A promoted brief that carries a real scope
// change must become the task a diff reviewer scores against, or the review
// mechanically flags the newly requested scope as growth — but nothing here
// is a second source of truth: it is the one frozen-task file dispatch
// already writes, updated in place with its own history kept beside it.
// ---------------------------------------------------------------------------

/** What one frozen-task replacement did. Facts, no bodies. */
export interface TaskUpdate {
	job_id: string;
	at: string;
	/** The generation this replacement created (1 for the first). */
	generation: number;
	/** Where the replaced task text now lives, relative to the home. */
	archived?: string;
	bytes: number;
	source: "task" | "task_file";
}

export interface UpdateFrozenTaskOptions {
	home: string;
	jobId: string;
	/** The new generation number: `(record.task_generations ?? 0) + 1`. */
	generation: number;
	text: string;
	source: "task" | "task_file";
	now?: () => Date;
}

/**
 * Replace the frozen original task with `text`, archiving whatever was there
 * first — never destroyed, always at `paths.supersededOriginalTaskFile`. Pure
 * file I/O: the caller (`Sender.send`) owns validating that this only ever
 * runs for a genuine promotion (`mode: "prompt"`), never for a steer or a
 * follow_up, and owns persisting `task_generations` on the fleet record.
 */
export function updateFrozenTask(options: UpdateFrozenTaskOptions): TaskUpdate {
	const { home, jobId, generation, text, source } = options;
	const now = options.now ?? (() => new Date());
	const current = join(home, paths.originalTaskFile(jobId));
	const archived = archive(current, join(home, paths.supersededOriginalTaskFile(jobId, generation)));
	mkdirSync(dirname(current), { recursive: true });
	writeFileSync(current, text);
	return {
		job_id: jobId,
		at: isoTimestamp(now()),
		generation,
		...(archived ? { archived: paths.supersededOriginalTaskFile(jobId, generation) } : {}),
		bytes: Buffer.byteLength(text, "utf8"),
		source,
	};
}
