/**
 * Tracker links (laf): which bead a job closes. B5 write-back only acts on a job's `tracker` link, and before this
 * the only writer was B4 import, so a job created with `external_ref: "br --db <db> show <id> --json"` never closed
 * its bead. This resolves such a ref against the project's active connection and records the link — at `cp_job
 * create`, at `cp_dispatch`, through `cp_tracker link`, and in the write-back tick's backfill of non-closed jobs.
 * Nothing here runs `br`: a missing bead surfaces as a `refused` write-back, visible in `cp_tracker list`.
 *
 * `writeBackLine` names the write-back for a landed job from local files only, and never throws, so the merge
 * result can carry it without a tracker problem ever gating a merge.
 */
import { realpathSync } from "node:fs";
import { type Job, type MergeReceipt, TRACKER_ITEM_ID_PATTERN, type TrackerConnection } from "../contracts.ts";
import { type Ledger, parseJobLabels } from "../ledger.ts";
import { readMergeReceipt } from "../merges.ts";
import { BR_SHOW_RE, unshellQuote } from "../verify-external-ref.ts";
import { TrackerError } from "./adapter.ts";
import { deriveIntents, marker } from "./sync.ts";
import { type SyncIntent, SyncStore } from "./sync-store.ts";

const ITEM_RE = new RegExp(TRACKER_ITEM_ID_PATTERN);

export type RefBead = { ok: true; connection: TrackerConnection; item_id: string } | { ok: false; reason: string };

const safeRealpath = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

const projectOf = (job: Job): string | undefined => {
	try {
		return parseJobLabels(job.labels).project;
	} catch {
		return undefined;
	}
};

const activeFor = (job: Job, connections: readonly TrackerConnection[]): TrackerConnection | undefined => {
	const project = projectOf(job);
	return connections.find((c) => c.project === project && c.status === "active");
};

/** The bead a job's own `external_ref` names on its project's active beads connection, or why none. */
export function beadForRef(job: Job, connections: readonly TrackerConnection[], realpath: (path: string) => string = safeRealpath): RefBead {
	const no = (reason: string): RefBead => ({ ok: false, reason });
	if (!job.external_ref) return no("no external_ref");
	const match = BR_SHOW_RE.exec(job.external_ref);
	if (!match) return no("external_ref is not a br show command");
	if (!match[1]) return no("external_ref has no --db, so it names no database");
	const connection = activeFor(job, connections);
	if (!connection) return no(`project ${projectOf(job) ?? "(none)"} has no active tracker connection`);
	if (connection.adapter !== "beads") return no(`active connection ${connection.id} is ${connection.adapter}, not beads`);
	const db = unshellQuote(match[1]);
	if (db !== connection.endpoint && realpath(db) !== connection.endpoint) {
		return no(`external_ref names ${db}, not ${connection.id}'s database ${connection.endpoint}`);
	}
	const item = match[2] as string;
	if (!ITEM_RE.test(item)) return no(`bead id ${item} is not a valid tracker item id`);
	return { ok: true, connection, item_id: item };
}

/** create/dispatch: link when the ref resolves. Never throws — linking never fails a create or a dispatch. */
export async function autoLink(ledger: Pick<Ledger, "link">, job: Job, connections: readonly TrackerConnection[]): Promise<string> {
	if (job.tracker) return `linked to ${job.tracker.connection_id}/${job.tracker.item_id}`;
	const bead = beadForRef(job, connections);
	if (!bead.ok) return `not linked to a tracker bead: ${bead.reason}`;
	try {
		await ledger.link(job.id, { connection_id: bead.connection.id, item_id: bead.item_id });
		return `linked to ${bead.connection.id}/${bead.item_id}`;
	} catch (error) {
		return `not linked to a tracker bead: ${(error as Error).message}`;
	}
}

/** `cp_tracker link job_id=… [item_id=…]`: explicit, so every refusal reaches the operator. Closed jobs may link. */
export async function linkJob(ledger: Pick<Ledger, "show" | "link">, connections: readonly TrackerConnection[], jobId: string, itemId?: string): Promise<string> {
	const job = await ledger.show(jobId);
	let target: { connection_id: string; item_id: string };
	if (itemId !== undefined) {
		const connection = activeFor(job, connections);
		if (!connection) throw new TrackerError(`project ${projectOf(job) ?? "(none)"} has no active tracker connection; cp_tracker connect first`);
		if (!ITEM_RE.test(itemId)) throw new TrackerError(`bead id ${itemId} is not a valid tracker item id`);
		target = { connection_id: connection.id, item_id: itemId };
	} else {
		const bead = beadForRef(job, connections);
		if (!bead.ok) throw new TrackerError(`${jobId}: ${bead.reason}; pass item_id=<bead>`);
		target = { connection_id: bead.connection.id, item_id: bead.item_id };
	}
	const { linked } = await ledger.link(jobId, target);
	const bead = `${target.connection_id}/${target.item_id}`;
	return linked ? `linked ${jobId} to ${bead}` : `${jobId} already linked to ${bead}`;
}

/** Every non-closed unlinked job whose ref resolves gets linked; per-job refusals become skips, never throws. */
export async function backfillLinks(ledger: Pick<Ledger, "list" | "link">, connections: readonly TrackerConnection[]): Promise<{ linked: string[]; skipped: string[] }> {
	const linked: string[] = [], skipped: string[] = [];
	for (const job of await ledger.list({})) {
		if (job.tracker || !job.external_ref) continue;
		const bead = beadForRef(job, connections);
		if (!bead.ok) {
			skipped.push(`${job.id}: ${bead.reason}`);
			continue;
		}
		try {
			await ledger.link(job.id, { connection_id: bead.connection.id, item_id: bead.item_id });
			linked.push(`${job.id} -> ${bead.connection.id}/${bead.item_id}`);
		} catch (error) {
			skipped.push(`${job.id}: ${(error as Error).message}`);
		}
	}
	return { linked, skipped };
}

/** One line naming what write-back does for this job, or exactly why it writes nothing. Pure. */
export function describeWriteBack(job: Job, connections: readonly TrackerConnection[], receipt: MergeReceipt | undefined, intents: readonly SyncIntent[]): string {
	const line = (text: string): string => `tracker write-back: ${text}`;
	const nothing = (why: string): string => line(`nothing written for ${job.id}: ${why}`);
	if (!job.tracker) {
		const bead = beadForRef(job, connections);
		const why = bead.ok ? `external_ref names ${bead.item_id} on ${bead.connection.id}` : bead.reason;
		return nothing(`not linked to a tracker bead (${why}); cp_tracker link job_id=${job.id}${bead.ok ? "" : " item_id=<bead>"} links it`);
	}
	const { connection_id, item_id } = job.tracker;
	const connection = connections.find((c) => c.id === connection_id);
	if (!connection) return nothing(`connection ${connection_id} is not in data/trackers.json`);
	if (connection.status !== "active") return nothing(`connection ${connection_id} is disconnected`);
	if (!connection.write_enabled) return nothing(`connection ${connection_id} has write off`);
	const bead = `${connection_id}/${item_id}`;
	const [intent] = deriveIntents([job], connections, () => receipt);
	if (!intent) {
		const shipPr = job.labels.includes("kind:ship") && job.labels.includes("delivery:pr");
		return line(`${bead} for ${job.id}: nothing to write yet (${job.status}, ${shipPr ? "no matching merge receipt" : "not a kind:ship delivery:pr job"})`);
	}
	const stored = intents.find((k) => k.key === intent.key);
	const what = intent.op === "close" ? `close with ${receipt?.pr_url ?? "(no PR url)"}` : "comment (bead stays open)";
	if (stored) return line(`${bead} ${what}: ${stored.status} (attempts ${stored.attempts})${stored.last_error ? `: ${stored.last_error}` : ""}`);
	const verb = intent.op === "close" ? `closes with ${receipt?.pr_url ?? "(no PR url)"}` : "comments (bead stays open)";
	return line(`${bead} ${verb} on the next write-back tick (60 s, while this session holds the parent lock) ${marker(intent.key)}`);
}

/** `describeWriteBack` over this home's files; any failure becomes a line, never a throw. */
export function writeBackLine(home: string, ledger: () => Pick<Ledger, "read" | "normalizeRef">, connections: () => readonly TrackerConnection[], jobId: string): string {
	try {
		const jobs = ledger();
		const raw = jobs.read().jobs.find((j) => j.id === jobId);
		if (!raw) throw new Error(`${jobId} is not in the ledger`);
		const project = projectOf(raw);
		const job = raw.external_ref && project ? { ...raw, external_ref: jobs.normalizeRef(raw.external_ref, project) } : raw;
		return describeWriteBack(job, connections(), readMergeReceipt(home, jobId), new SyncStore(home).list());
	} catch (error) {
		return `tracker write-back: unknown for ${jobId} (${(error as Error).message.split("\n")[0]})`;
	}
}
