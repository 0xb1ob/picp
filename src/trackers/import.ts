/**
 * `cp_tracker import` (B4): ready beads become ordinary ledger jobs under a named-jobs (batch) mandate.
 * Only beads the call names, or ready children of an epic the mandate's objective records (`epic: <id>`),
 * qualify; there is no label or selector matching (that is B3). Each job is born `deferred` (out of
 * `ready()`, so `cp_next` never offers it), gets its frozen task file, is enrolled into the mandate's
 * `job_ids` through `MandateStore.enroll`, and only then opens. A crash between any two steps leaves a
 * deferred job that no grant was asked to cover; re-running the same import resumes it. Nothing is dispatched.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeExternalRef } from "../beads.ts";
import { type Delivery, isoTimestamp, type Job, type JobKind, LAYOUT } from "../contracts.ts";
import { atomicWriteText } from "../json-store.ts";
import type { Ledger } from "../ledger.ts";
import { batchRefusal, enrollCapacity, type MandateStore, type MandateUsageJob } from "../mandate.ts";
import { notImplemented, type TrackerAdapter, TrackerError, type TrackerItem } from "./adapter.ts";
import type { TrackerStore } from "./config.ts";

export interface ImportInput {
	project: string;
	mandateId: string;
	kind: JobKind;
	delivery: Delivery;
	/** Bead ids named by the call; they qualify alongside the mandate's epic children. */
	ids?: readonly string[];
	limit?: number;
}

export interface ImportPorts {
	home: string;
	store: TrackerStore;
	adapter: TrackerAdapter;
	ledger: Ledger;
	mandates: MandateStore;
	fleetJobs: readonly MandateUsageJob[];
	now?: () => Date;
}

export interface ImportResult {
	mandate_id: string;
	capacity: number;
	created: Array<{ job_id: string; item_id: string; task_file: string; resumed: boolean }>;
	skipped: Array<{ item_id: string; reason: string }>;
}

const EPIC_RE = /\bepic:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,199})/g;

/** The epics a mandate records as its work: every `epic: <id>` in its objective. */
export function mandateEpics(objective: string): string[] {
	return [...new Set([...objective.matchAll(EPIC_RE)].map((match) => (match[1] as string).replace(/\.+$/, "")))];
}

export function trackerTaskFile(home: string, jobId: string): string {
	return join(home, LAYOUT.state, "tracker-tasks", `${jobId}.md`);
}

/** Deterministic, so a resumed import can prove the source is unchanged by its hash. */
export function importTaskText(item: TrackerItem, connectionId: string, mandateId: string): string {
	return `# ${item.title}\n\n${item.description.trim() || "(no description)"}\n\nImported from ${connectionId}/${item.id} under ${mandateId}.\n`;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export async function importReady(ports: ImportPorts, input: ImportInput): Promise<ImportResult> {
	if (input.delivery !== "pr" && input.delivery !== "local") throw new TrackerError(`cp_tracker import delivery must be pr or local, got ${input.delivery}`);
	const connection = ports.store.active(input.project);
	if (!connection) throw new TrackerError(`project ${input.project} has no active tracker connection; cp_tracker connect first`);
	if (connection.adapter !== "beads") throw new TrackerError(notImplemented(connection.adapter));
	if (!connection.intake_enabled) throw new TrackerError(`${connection.id} has intake off; cp_tracker disconnect ${input.project}, then connect with intake:true`);
	const now = isoTimestamp((ports.now ?? (() => new Date()))());
	const mandate = ports.mandates.sweep(now, ports.fleetJobs).find((grant) => grant.id === input.mandateId);
	const counted = ports.mandates.withReviewerSpend(ports.fleetJobs);
	const refusal = batchRefusal(mandate, input.mandateId, input, counted, now);
	if (refusal || !mandate) throw new TrackerError(`cp_tracker import refused: ${refusal}`);
	const ids = [...new Set(input.ids ?? [])];
	const epics = mandateEpics(mandate.objective);
	if (ids.length === 0 && epics.length === 0) {
		throw new TrackerError(`cp_tracker import refused: name the bead ids (ids) or record the work's epic in ${mandate.id}'s objective ("epic: <id>"); no other bead is imported`);
	}
	const db = connection.endpoint;
	const skipped: ImportResult["skipped"] = [];
	const created: ImportResult["created"] = [];
	const candidates: TrackerItem[] = [];
	const ready = ids.length > 0 ? new Map((await ports.adapter.listReady(db)).map((item) => [item.id, item])) : new Map<string, TrackerItem>();
	for (const id of ids) {
		const item = ready.get(id);
		if (item) candidates.push(item);
		else skipped.push({ item_id: id, reason: "refused: not in br ready (open, unblocked, not an epic, not deferred)" });
	}
	for (const epic of epics) {
		for (const item of await ports.adapter.listReady(db, { parent: epic })) if (!candidates.some((seen) => seen.id === item.id)) candidates.push(item);
	}
	const openIds = (): Set<string> => new Set(ports.ledger.read().jobs.filter((job) => job.status !== "closed").map((job) => job.id));
	const capacity = enrollCapacity(mandate, counted, openIds());
	let room = Math.min(capacity, input.limit ?? capacity);
	const resumable = (job: Job): boolean => job.status === "deferred" && job.tracker?.mandate_id === mandate.id;
	for (const candidate of candidates) {
		const skip = (reason: string) => void skipped.push({ item_id: candidate.id, reason });
		let job = ports.ledger.findTracked(connection.id, candidate.id);
		const resumed = job !== undefined;
		if (job && !resumable(job)) { skip(`already imported as ${job.id} (${job.status}${job.tracker?.mandate_id ? ` under ${job.tracker.mandate_id}` : ""})`); continue; }
		// A crash after enroll, before open: the grant already counts this job, so it takes no new slot.
		const enrolled = job !== undefined && (mandate.job_ids ?? []).includes(job.id);
		if (!enrolled && room <= 0) { skip(`no room under ${mandate.id}: job cap ${mandate.job_cap}${input.limit !== undefined ? `, limit ${input.limit}` : ""}`); continue; }
		const conflict = candidate.labels.find((label) => (label.startsWith("kind:") && label !== `kind:${input.kind}`) || (label.startsWith("delivery:") && label !== `delivery:${input.delivery}`));
		if (conflict) { skip(`label ${conflict} conflicts with kind:${input.kind} delivery:${input.delivery}`); continue; }
		const read = await ports.adapter.get(db, candidate.id);
		if (read.status !== "found") { skip(read.status === "missing" ? "not found on re-read" : read.message); continue; }
		if (read.item.status === "closed") { skip("closed upstream since br ready"); continue; }
		const text = importTaskText(read.item, connection.id, mandate.id);
		const file = (id: string) => trackerTaskFile(ports.home, id);
		if (!job) {
			const ref = normalizeExternalRef(`br show ${candidate.id} --json`, db);
			const other = ports.ledger.read().jobs.find((entry) => !entry.tracker && entry.external_ref === ref);
			if (other) { skip(`already tracked by ${other.id} via external_ref`); continue; }
			const made = await ports.ledger.createTracked({
				title: read.item.title, project: input.project, kind: input.kind, delivery: input.delivery, externalRef: ref, deferred: true,
				tracker: { connection_id: connection.id, item_id: candidate.id, mandate_id: mandate.id, task_sha256: sha256(text) },
			});
			if (!made.created && !resumable(made.job)) { skip(`already imported as ${made.job.id}`); continue; }
			job = made.job;
		} else if (!existsSync(file(job.id)) && job.tracker?.task_sha256 !== sha256(text)) {
			skip(`${job.id} stays deferred: the source changed since import and its task file is missing`);
			continue;
		}
		if (!existsSync(file(job.id))) atomicWriteText(file(job.id), text);
		try {
			ports.mandates.enroll(mandate.id, { jobId: job.id, project: input.project, kind: input.kind }, ports.fleetJobs, openIds());
		} catch (error) {
			skip(`${job.id} stays deferred: ${(error as Error).message}`);
			continue;
		}
		await ports.ledger.update(job.id, { status: "open", notes: `task_file: ${file(job.id)}` });
		created.push({ job_id: job.id, item_id: candidate.id, task_file: file(job.id), resumed });
		if (!enrolled) room -= 1;
	}
	return { mandate_id: mandate.id, capacity, created, skipped };
}

export function formatImport(result: ImportResult): string {
	const lines = [`imported ${result.created.length} under ${result.mandate_id} (room ${result.capacity}); nothing dispatched`];
	for (const row of result.created) lines.push(`  ${row.job_id} <- ${row.item_id}${row.resumed ? " (resumed)" : ""}: cp_dispatch ${row.job_id} task_file=${row.task_file}`);
	if (result.skipped.length > 0) lines.push(`skipped ${result.skipped.length}:`);
	for (const row of result.skipped) lines.push(`  ${row.item_id}: ${row.reason}`);
	return lines.join("\n");
}
