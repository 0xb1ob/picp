/**
 * One-shot import of the open `.beads/` issues (spec 2026-09-04 §Migrations,
 * PR 2). Reads `issues.jsonl` directly — br's documented interchange file — so
 * no br binary is involved.
 *
 *  - Only rows whose status is `open`, `in_progress` or `deferred` are carried;
 *    `closed` and `tombstone` rows stay in `.beads/` as the frozen archive.
 *  - Ids are preserved (they are branch names and run directories).
 *  - br writes sub-second timestamps; ours are second precision, so every
 *    timestamp is re-rendered through `isoTimestamp`.
 *  - A `blocks` dependency on another carried row is kept; one on a closed or
 *    unknown row is dropped with a note (a closed blocker blocks nothing).
 *  - The plan is refused as a whole when any incoming id already exists in
 *    the document or does not carry the document's prefix. Idempotence is a
 *    refusal, not a merge.
 *  - br's `issue_type` and `priority` are not carried; the ledger has neither field.
 *  - Nothing under `.beads/` is ever written.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isoTimestamp, type Job, type JobComment, JobSchema, type JobsDocument, type JobStatus, validate } from "./contracts.ts";
import { type Ledger, LedgerError } from "./ledger.ts";

export interface BeadsRow {
	id: string;
	title: string;
	status: string;
	priority?: number;
	issue_type?: string | null;
	labels?: string[];
	assignee?: string | null;
	description?: string | null;
	notes?: string | null;
	created_at?: string;
	updated_at?: string;
	comments?: Array<{ author?: string; text?: string; created_at?: string }>;
	dependencies?: Array<{ issue_id?: string; depends_on_id: string; type?: string }>;
}

const CARRIED_STATUSES: readonly JobStatus[] = ["open", "in_progress", "deferred"];

export function parseBeadsJsonl(text: string): BeadsRow[] {
	const rows: BeadsRow[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new LedgerError(`.beads/issues.jsonl line ${index + 1} is not JSON`);
		}
		const row = parsed as Partial<BeadsRow>;
		if (typeof row.id !== "string" || row.id.length === 0) throw new LedgerError(`.beads/issues.jsonl line ${index + 1} has no string id`);
		if (typeof row.title !== "string") throw new LedgerError(`.beads/issues.jsonl line ${index + 1} (${row.id}) has no string title`);
		if (typeof row.status !== "string") throw new LedgerError(`.beads/issues.jsonl line ${index + 1} (${row.id}) has no string status`);
		rows.push(row as BeadsRow);
	}
	return rows;
}

export interface BeadsImportPlan {
	jobs: Job[];
	skipped: Array<{ id: string; status: string }>;
	dependencies_kept: Array<[string, string]>;
	dependencies_dropped: Array<{ blocked: string; blocker: string; reason: string }>;
}

function stamp(value: string | undefined, fallback: Date): string {
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return isoTimestamp(parsed);
	}
	return isoTimestamp(fallback);
}

function text(value: string | null | undefined): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function planBeadsImport(rows: readonly BeadsRow[], doc: JobsDocument, now: () => Date = () => new Date()): BeadsImportPlan {
	const carried = rows.filter((row) => (CARRIED_STATUSES as readonly string[]).includes(row.status));
	const skipped = rows.filter((row) => !(CARRIED_STATUSES as readonly string[]).includes(row.status)).map((row) => ({ id: row.id, status: row.status }));

	const existing = new Set(doc.jobs.map((job) => job.id));
	const duplicates = carried.filter((row) => existing.has(row.id)).map((row) => row.id);
	if (duplicates.length > 0) throw new LedgerError(`refusing import: already in the ledger: ${duplicates.join(", ")}`);
	const foreign = carried.filter((row) => !row.id.startsWith(`${doc.prefix}-`)).map((row) => row.id);
	if (foreign.length > 0) throw new LedgerError(`refusing import: the document mints prefix ${doc.prefix}- but the rows are ${foreign.join(", ")}`);

	const carriedIds = new Set(carried.map((row) => row.id));
	const closedIds = new Set(skipped.map((row) => row.id));
	const dependenciesKept: Array<[string, string]> = [];
	const dependenciesDropped: Array<{ blocked: string; blocker: string; reason: string }> = [];
	const at = now();

	const jobs = carried.map((row): Job => {
		const blockedBy: string[] = [];
		for (const dep of row.dependencies ?? []) {
			if (dep.type !== undefined && dep.type !== "blocks") continue;
			const blocker = dep.depends_on_id;
			if (carriedIds.has(blocker) || existing.has(blocker)) {
				if (!blockedBy.includes(blocker)) blockedBy.push(blocker);
				dependenciesKept.push([row.id, blocker]);
			} else if (closedIds.has(blocker)) {
				dependenciesDropped.push({ blocked: row.id, blocker, reason: "blocker is closed in .beads (blocks nothing)" });
			} else {
				dependenciesDropped.push({ blocked: row.id, blocker, reason: "blocker is unknown" });
			}
		}
		const comments: JobComment[] = [];
		for (const comment of row.comments ?? []) {
			const body = text(comment.text);
			if (!body) continue;
			comments.push({ at: stamp(comment.created_at, at), author: text(comment.author) ?? "beads", text: body });
		}
		const job: Job = {
			id: row.id,
			title: row.title.trim().length > 0 ? row.title : row.id,
			status: row.status as JobStatus,
			labels: (row.labels ?? []).filter((label) => typeof label === "string" && label.length > 0 && !label.includes(",")),
			blocked_by: blockedBy,
			comments,
			created_at: stamp(row.created_at, at),
			updated_at: stamp(row.updated_at, at),
			...(text(row.assignee) ? { assignee: row.assignee as string } : {}),
			...(text(row.description) ? { description: row.description as string } : {}),
			...(text(row.notes) ? { notes: row.notes as string } : {}),
		};
		const shape = validate<Job>(JobSchema, job);
		if (!shape.ok) throw new LedgerError(`refusing import: ${row.id} does not fit the job contract:\n  ${shape.errors.join("\n  ")}`);
		return shape.value;
	});

	return { jobs, skipped, dependencies_kept: dependenciesKept, dependencies_dropped: dependenciesDropped };
}

export interface BeadsImportReport extends BeadsImportPlan {
	source: string;
}

/** Read `<home>/.beads/issues.jsonl`, plan, write. Refuses rather than merges. */
export async function importBeads(ledger: Ledger, options: { beadsDir?: string; now?: () => Date } = {}): Promise<BeadsImportReport> {
	const dir = options.beadsDir ?? join(ledger.home, ".beads");
	const source = join(dir, "issues.jsonl");
	if (!existsSync(source)) throw new LedgerError(`no .beads/issues.jsonl under ${dir} — nothing to import`);
	const plan = planBeadsImport(parseBeadsJsonl(readFileSync(source, "utf8")), ledger.read(), options.now);
	await ledger.importJobs(plan.jobs);
	return { ...plan, source };
}

export function formatBeadsImport(report: BeadsImportReport): string {
	const lines = [`imported ${report.jobs.length} job(s) from ${report.source}; skipped ${report.skipped.length} closed/tombstone row(s) (they stay in .beads/ as the archive)`];
	for (const job of report.jobs) lines.push(`  + ${job.id}  ${job.status}  ${job.title}`);
	for (const [blocked, blocker] of report.dependencies_kept) lines.push(`  kept ${blocked} -> ${blocker}`);
	for (const dropped of report.dependencies_dropped) lines.push(`  dropped ${dropped.blocked} -> ${dropped.blocker}: ${dropped.reason}`);
	if (report.jobs.length > 0) lines.push("  .beads/ is now a frozen archive; /doctor will say so until you delete it");
	return lines.join("\n");
}
