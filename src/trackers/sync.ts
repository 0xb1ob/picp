/**
 * Tracker write-back (B5), parent-owned and off the merge path: nothing in src/integrate.ts, src/merges.ts or
 * src/teardown.ts imports this, so a tracker outage can only delay a write, never a merge. Every tick derives
 * intents from facts (ledger + `readMergeReceipt`) for jobs linked to an active, write-enabled connection:
 * a `kind:ship delivery:pr` job whose receipt matches (job id and head branch) closes its bead with the full
 * PR URL, merge commit and head commit; every other closed, undropped job (research, board, answer, local) closes
 * its bead with `CP <id> done: <close_reason>`; dropped jobs and receipt-less `kind:ship delivery:pr` jobs
 * get one comment and their bead stays open. Keys hash the evidence, so a crash anywhere re-derives the same work.
 */
import { createHash } from "node:crypto";
import { isoTimestamp, type Job, type MergeReceipt, type TrackerConnection } from "../contracts.ts";
import { wasDropped } from "../ledger.ts";
import { readMergeReceipt } from "../merges.ts";
import { adapterFor, type TrackerWrite, type TrackerWriter } from "./adapter.ts";
import { type NewIntent, type SyncIntent, SyncStore } from "./sync-store.ts";

export const marker = (key: string): string => `[cp:${key.slice(0, 12)}]`;

const intentKey = (parts: readonly string[]): string => createHash("sha256").update(parts.join("|")).digest("hex");

/** The receipt proves this job's own PR merged: same job id, head branch = job id (the branch contract). */
export const receiptMatches = (job: Job, receipt: MergeReceipt | undefined): receipt is MergeReceipt =>
	receipt !== undefined && receipt.job_id === job.id && receipt.head_branch === job.id;

export function deriveIntents(
	jobs: readonly Job[],
	connections: readonly TrackerConnection[],
	readReceipt: (jobId: string) => MergeReceipt | undefined,
): NewIntent[] {
	const writable = new Set(connections.filter((c) => c.status === "active" && c.write_enabled).map((c) => c.id));
	const out: NewIntent[] = [];
	for (const job of jobs) {
		if (!job.tracker || !writable.has(job.tracker.connection_id)) continue;
		const { connection_id, item_id } = job.tracker;
		const shipPr = job.labels.includes("kind:ship") && job.labels.includes("delivery:pr");
		const read = shipPr && !wasDropped(job) ? readReceipt(job.id) : undefined;
		const receipt = receiptMatches(job, read) ? read : undefined;
		let op: NewIntent["op"], evidence: string, text: string;
		if (receipt) {
			op = "close";
			evidence = `${receipt.merge_commit_sha}|${receipt.head_sha}`;
			text = `CP ${job.id} merged: ${receipt.pr_url} merge ${receipt.merge_commit_sha} head ${receipt.head_sha}`;
		} else if (job.status === "closed") {
			evidence = job.close_reason ?? "";
			if (wasDropped(job)) {
				op = "comment";
				text = `CP ${job.id} dropped: ${evidence.replace(/^dropped:\s*/, "").slice(0, 300)} (bead left open)`;
			} else if (shipPr) {
				op = "comment";
				text = `CP ${job.id} closed: ${evidence.slice(0, 300)} (no matching merge receipt; bead left open)`;
			} else {
				op = "close";
				text = `CP ${job.id} done: ${evidence.slice(0, 300)}`;
			}
		} else continue;
		const key = intentKey([connection_id, item_id, job.id, op, evidence]);
		out.push({ key, connection_id, item_id, job_id: job.id, op, text: `${text} ${marker(key)}` });
	}
	return out;
}

export interface SyncPorts {
	home: string;
	ledger: { read(): { jobs: readonly Job[] } };
	trackers: { list(): TrackerConnection[] };
	/** Defaults to `adapterFor`, which refuses github as "adapter not implemented (B6)". */
	writer?: (connection: TrackerConnection) => TrackerWriter;
	readReceipt?: (jobId: string) => MergeReceipt | undefined;
	now?: () => Date;
}

export interface SyncReport {
	enqueued: number;
	attempted: Array<{ key: string; job_id: string; item_id: string; op: SyncIntent["op"]; outcome: TrackerWrite["status"] }>;
}

async function execute(writer: TrackerWriter, db: string, intent: SyncIntent): Promise<TrackerWrite> {
	if (intent.op === "comment") return writer.comment(db, intent.item_id, intent.text, marker(intent.key));
	const closed = await writer.close(db, intent.item_id, intent.text);
	// Closed upstream by someone else (or by us before a crash): record the evidence as a comment instead.
	return closed.status === "already" ? writer.comment(db, intent.item_id, intent.text, marker(intent.key)) : closed;
}

export async function runSync(ports: SyncPorts): Promise<SyncReport> {
	const now = (ports.now ?? (() => new Date()))();
	const connections = ports.trackers.list();
	const derived = deriveIntents(ports.ledger.read().jobs, connections, ports.readReceipt ?? ((jobId) => readMergeReceipt(ports.home, jobId)));
	const store = new SyncStore(ports.home);
	const before = store.list().length;
	const intents = await store.enqueue(derived, isoTimestamp(now));
	const report: SyncReport = { enqueued: intents.length - before, attempted: [] };
	for (const intent of intents) {
		if (intent.status !== "pending" || (intent.next_attempt_at && Date.parse(intent.next_attempt_at) > now.getTime())) continue;
		// Write turned off or connection gone: the intent waits, nothing is written or deleted.
		const connection = connections.find((c) => c.id === intent.connection_id && c.status === "active" && c.write_enabled);
		if (!connection) continue;
		let outcome: TrackerWrite;
		try {
			outcome = await execute((ports.writer ?? ((c) => adapterFor(c.adapter)))(connection), connection.endpoint, intent);
		} catch (error) {
			outcome = { status: "retryable", message: (error as Error).message };
		}
		await store.settle(intent.key, outcome, now);
		report.attempted.push({ key: intent.key, job_id: intent.job_id, item_id: intent.item_id, op: intent.op, outcome: outcome.status });
	}
	return report;
}

/** One line per write-back intent not yet done; empty when there is none. */
export function formatSync(intents: readonly SyncIntent[]): string[] {
	const lines: string[] = [];
	for (const intent of intents) {
		if (intent.status === "done") continue;
		const why = intent.last_error ? `: ${intent.last_error}` : "";
		const when = intent.status === "pending" && intent.next_attempt_at ? ` next ${intent.next_attempt_at}` : "";
		lines.push(`  write-back ${intent.status} ${intent.op} ${intent.connection_id}/${intent.item_id} for ${intent.job_id} (attempts ${intent.attempts}${when})${why}`);
	}
	return lines;
}
