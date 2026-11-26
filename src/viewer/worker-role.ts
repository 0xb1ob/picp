/**
 * The one role label every fleet and worker list shows (Overview, Jobs, Sessions, job detail): read from the fleet
 * record's `worker.profile`, the job kind, a reviewer's `pending.json` and the run log's last send marker. Never a
 * prompt or an id; anything unrecorded is "—".
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkerRole } from "./api-types.ts";
import { fileCache } from "./file-cache.ts";
import { readLines, startOffset } from "./tail.ts";

/** Mirrors PENDING_REVIEW_FILE (src/contracts/reviews.ts): viewer modules import no contracts. */
export const PENDING_REVIEW_FILE = "pending.json";
export const UNKNOWN_ROLE: WorkerRole = { label: "—", short: "—" };
const ROLES = {
	planner: { label: "Planner", short: "Plan" },
	research: { label: "Research", short: "Rsch" },
	implementer: { label: "Implementer", short: "Impl" },
	repair: { label: "Implementer · repair", short: "Repair" },
	reviewer: { label: "Reviewer", short: "Review" },
	gate: { label: "Gate reviewer", short: "Gate" },
	qa: { label: "QA", short: "QA" },
	ops: { label: "Ops", short: "Ops" },
} satisfies Record<string, WorkerRole>;
/** `profiles/*.md` names; `planner` is split by kind below. Any other profile is unknown. */
const PROFILES: Record<string, WorkerRole> = {
	implementer: ROLES.implementer, "gate-reviewer": ROLES.gate, qa: ROLES.qa, ops: ROLES.ops,
};
const SENT = new Set(["prompt_sent", "steer_sent", "follow_up_sent"]);
const EVENTS_BYTES = 256 * 1024;
const FINISHED = new Set(["done", "failed"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type Json = Record<string, unknown>;
const text = (value: unknown): string | undefined =>
	(typeof value === "string" && value.length > 0 ? value : undefined);
const record = (value: unknown): Json | undefined =>
	(value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);
const parsed = (line: string): Json | undefined => {
	try { return record(JSON.parse(line)); } catch { return undefined; }
};

/** The last delivered send marker's `purpose` (src/send.ts); an older log or a marker without one is null. */
const lastPurpose = fileCache((file: string) => {
	const markers = readLines(file, startOffset(file, undefined, EVENTS_BYTES).offset, EVENTS_BYTES).lines
		.filter((line) => line.text.includes('_sent"')).map((line) => parsed(line.text))
		.filter((e): e is Json => e?.source === "cp" && SENT.has(String(e.type)) && record(e.payload)?.receipt !== "failed");
	return text(record(markers.at(-1)?.payload)?.purpose) ?? null;
}, () => 64);

/** The reviewer whose `pending.json` is on disk now: a diff or quality review, else a plan gate. */
function pendingReviewer(stateDir: string, id: string): WorkerRole | undefined {
	let names: string[];
	try { names = readdirSync(join(stateDir, "runs", id)); } catch { return undefined; }
	const pending = (pattern: RegExp) =>
		names.some((n) => pattern.test(n) && existsSync(join(stateDir, "runs", id, n, PENDING_REVIEW_FILE)));
	if (pending(/^(?:review-[1-9]\d*|quality-panel)$/)) return ROLES.reviewer;
	return pending(/^gate-[1-9]\d*$/) ? ROLES.gate : undefined;
}

/** `job`: a fleet record; `status`: its `runs/<id>/status.json`. The live process wins over the recorded profile. */
export function workerRole(stateDir: string, job: Json | undefined, status: Json | undefined): WorkerRole {
	const id = text(job?.job_id);
	const worker = record(job?.worker);
	if (!job || !id || !SAFE_ID.test(id) || job.executor === "script" || !worker) return UNKNOWN_ROLE;
	const profile = text(worker.profile) ?? "";
	// A planner outside a pipeline reads and reports: that is the Research kind, not a plan.
	const planner = job.kind === "research" && job.delivery !== "pipeline" ? ROLES.research : ROLES.planner;
	const base = profile === "planner" ? planner : Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : undefined;
	if (FINISHED.has(String(job.phase))) return base ?? UNKNOWN_ROLE;
	const run = text(status?.phase);
	if ((run === "working" || run === "starting") && job.phase !== "awaiting_merge") {
		if (base !== ROLES.implementer) return base ?? UNKNOWN_ROLE;
		let purpose: string | null = null;
		try {
			purpose = lastPurpose(join(stateDir, "runs", id, "events.jsonl"));
		} catch { /* No run log: no repair recorded. */ }
		return purpose === "repair" ? ROLES.repair : base;
	}
	return pendingReviewer(stateDir, id) ?? base ?? UNKNOWN_ROLE;
}
