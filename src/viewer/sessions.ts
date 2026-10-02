/**
 * Which sessions exist, derived read-only from `state/` (cp-live-session-viewer).
 *
 * Deliberately dependency-free: no contract validation (that would pull in
 * typebox), just tolerant reads of `fleet.json` and `runs/<job>/status.json`.
 * A field that is missing or the wrong type is absent in the row, never a crash.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { ContextUsage } from "./api-types.ts";
import { fileCache } from "./file-cache.ts";

export const PARENT_ID = "cp-parent";
export const RECENT_LIMIT = 10;
/** The parent is "live" when its transcript moved this recently. */
export const PARENT_LIVE_MS = 60_000;

/** Same shape the contract's job ids take: no dots, no slashes, no traversal. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isSafeId(id: string): boolean {
	return SAFE_ID.test(id);
}

export interface SessionRow {
	id: string;
	kind: "parent" | "worker";
	project?: string | undefined;
	job_id?: string | undefined;
	role?: string | undefined;
	profile?: string | undefined;
	model?: string | undefined;
	/** Workers: the session's latest thinking level, else the level routing recorded at dispatch; absent when unknown. */
	thinking?: string | undefined;
	context_tokens?: number | null;
	last_turn_cost_usd?: number;
	compact_at_tokens?: number;
	standing_orders_at?: string;
	last_compact_at?: string;
	last_rotate_at?: string;
	/** Job phase from the fleet (waiting/held/done/failed). */
	phase?: string | undefined;
	/** Run liveness from status.json (starting/working/idle/exited). */
	run_phase?: string | undefined;
	cost_usd?: number | undefined;
	last_activity?: string | undefined;
	live: boolean;
	/** Context-window usage; the Sessions view fills it (src/viewer/context-usage.ts). */
	context?: ContextUsage;
}

export interface Sidebar {
	parent: SessionRow;
	active: SessionRow[];
	recent: SessionRow[];
}

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}
export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const cachedObject = fileCache((file: string) => obj(JSON.parse(readFileSync(file, "utf8"))));

/** A JSON object file, or `undefined` when missing, unparseable or not an object. */
export function readObject(file: string): Json | undefined {
	try {
		return cachedObject(file);
	} catch {
		return undefined;
	}
}

/**
 * A home's runtime root, contracts-free (mirrors `runtimeRootFor` in src/contracts/layout.ts):
 * the home itself when it is named `.pi-command-post` (the standard home), else `<home>/.pi-command-post`.
 */
export function runtimeRoot(home: string): string {
	return basename(resolve(home)) === ".pi-command-post" ? join(home) : join(home, ".pi-command-post");
}

/** The state directory for a home: `<runtime root>/state` in both modes (cp-u3i2). */
export function resolveStateDir(home: string): string {
	return join(runtimeRoot(home), "state");
}

export interface ViewerState {
	home: string;
	stateDir: string;
}

export function fleetJobs(state: ViewerState): Json[] {
	const jobs = readObject(join(state.stateDir, "fleet.json"))?.jobs;
	return Array.isArray(jobs) ? jobs.map(obj).filter((job): job is Json => job !== undefined) : [];
}

/** The ledger (`<runtime root>/jobs.json`, same place in both modes): title and status by job id. */
export function readLedger(state: ViewerState): Map<string, { title?: string | undefined; status?: string | undefined }> {
	const out = new Map<string, { title?: string | undefined; status?: string | undefined }>();
	const jobs = readObject(join(runtimeRoot(state.home), "jobs.json"))?.jobs;
	for (const entry of Array.isArray(jobs) ? jobs : []) {
		const job = obj(entry);
		const id = str(job?.id);
		if (job && id) out.set(id, { title: str(job.title), status: str(job.status) });
	}
	return out;
}

export function readStatus(state: ViewerState, jobId: string): Json | undefined {
	if (!isSafeId(jobId)) return undefined;
	return readObject(join(state.stateDir, "runs", jobId, "status.json"));
}

function workerRow(job: Json, status: Json | undefined): SessionRow | undefined {
	const id = str(job.job_id);
	if (!id || !isSafeId(id) || job.executor === "script") return undefined;
	const worker = obj(job.worker) ?? {};
	const runPhase = str(status?.phase);
	const phase = str(job.phase);
	const cost = num(obj(status?.usage)?.cost_usd) ?? num(obj(job.usage)?.cost_usd);
	const lastActivity = str(status?.last_activity_at) ?? str(job.closed_at) ?? str(job.dispatched_at);
	const row: SessionRow = {
		id,
		kind: "worker",
		job_id: id,
		project: str(job.project),
		role: str(worker.role),
		profile: str(status?.profile) ?? str(worker.profile),
		model: str(status?.model) ?? str(worker.model),
		thinking: str(obj(job.routing)?.thinking) ?? str(obj(status?.routing)?.thinking),
		phase,
		run_phase: runPhase,
		cost_usd: cost,
		last_activity: lastActivity,
		live: (runPhase === "working" || runPhase === "starting") && phase !== "done" && phase !== "failed",
	};
	return row;
}

function finishedAt(job: Json, row: SessionRow): string {
	return str(job.closed_at) ?? str(obj(job.worker)?.exited_at) ?? row.last_activity ?? "";
}

/**
 * Sidebar rows: parent first, then every job still in flight (waiting/held, in
 * dispatch order), then the last `limit` finished (done/failed), newest first.
 */
export function deriveSidebar(
	jobs: readonly Json[],
	status: (jobId: string) => Json | undefined,
	parent: SessionRow,
	limit = RECENT_LIMIT,
): Sidebar {
	const active: Array<{ row: SessionRow; at: string }> = [];
	const recent: Array<{ row: SessionRow; at: string }> = [];
	for (const job of jobs) {
		const id = str(job.job_id);
		const row = workerRow(job, id ? status(id) : undefined);
		if (!row) continue;
		if (row.phase === "done" || row.phase === "failed") recent.push({ row, at: finishedAt(job, row) });
		else active.push({ row, at: str(job.dispatched_at) ?? "" });
	}
	active.sort((a, b) => a.at.localeCompare(b.at));
	recent.sort((a, b) => b.at.localeCompare(a.at));
	return {
		parent,
		active: active.map((entry) => entry.row),
		recent: recent.slice(0, limit).map((entry) => entry.row),
	};
}

export function parentFile(state: ViewerState): string {
	const saved = str(readObject(join(state.stateDir, "sessions", "cp-parent-control.json"))?.sessionFile);
	return saved && saved.endsWith(".jsonl") && realInside(saved, sessionRoots(state)) ? saved : join(state.stateDir, "sessions", `${PARENT_ID}.jsonl`);
}

export function parentRow(state: ViewerState, now = Date.now()): SessionRow {
	let mtime: number | undefined;
	try {
		mtime = statSync(parentFile(state)).mtimeMs;
	} catch {
		mtime = undefined;
	}
	const context = readObject(join(state.stateDir, "sessions", "cp-parent-context.json")) ?? {};
	const dataDir = join(state.stateDir, "..", "data");
	const orders = join(dataDir, "standing-orders.md");
	const limit = num(readObject(join(dataDir, "parent.json"))?.compact_at_tokens);
	let standingOrdersAt: string | undefined;
	try { standingOrdersAt = statSync(orders).mtime.toISOString(); } catch { /* optional */ }
	return {
		id: PARENT_ID,
		kind: "parent",
		role: "parent",
		...(context.contextTokens !== undefined ? { context_tokens: num(context.contextTokens) ?? null } : {}),
		...(num(context.lastTurnCostUsd) !== undefined ? { last_turn_cost_usd: num(context.lastTurnCostUsd) } : {}),
		...(limit && Number.isSafeInteger(limit) && limit > 0 ? { compact_at_tokens: limit } : {}),
		...(standingOrdersAt ? { standing_orders_at: standingOrdersAt } : {}),
		...(str(context.lastCompactAt) ? { last_compact_at: str(context.lastCompactAt) } : {}),
		...(str(context.lastRotateAt) ? { last_rotate_at: str(context.lastRotateAt) } : {}),
		live: mtime !== undefined && now - mtime < PARENT_LIVE_MS,
		...(mtime !== undefined ? { last_activity: new Date(mtime).toISOString() } : {}),
	};
}

export function sidebar(state: ViewerState, now = Date.now()): Sidebar {
	return deriveSidebar(fleetJobs(state), (id) => readStatus(state, id), parentRow(state, now));
}

/** Session transcripts may only be read from these directories. */
export function sessionRoots(state: ViewerState): string[] {
	return [join(state.stateDir, "sessions")];
}

function realInside(file: string, roots: readonly string[]): string | undefined {
	let real: string;
	try {
		real = realpathSync(file);
	} catch {
		return undefined;
	}
	for (const root of roots) {
		let realRoot: string;
		try {
			realRoot = realpathSync(root);
		} catch {
			continue;
		}
		if (real.startsWith(`${realRoot}${sep}`)) return real;
	}
	return undefined;
}

/**
 * The transcript for a session id, or `undefined` for anything that is not a
 * known session: an unsafe id, a job the fleet does not list, or a recorded
 * path that is not a `.jsonl` inside the session roots (traversal, symlinks
 * out, or a hand-edited record pointing at `/etc/passwd`).
 */
export function resolveSessionFile(state: ViewerState, id: string): string | undefined {
	if (!isSafeId(id)) return undefined;
	let file: string | undefined;
	if (id === PARENT_ID) file = parentFile(state);
	else {
		const job = fleetJobs(state).find((candidate) => candidate.job_id === id);
		if (!job || job.executor === "script") return undefined;
		file = str(readStatus(state, id)?.session_file) ?? str(obj(job.worker)?.session_file);
	}
	if (!file || !file.endsWith(".jsonl")) return undefined;
	return realInside(file, sessionRoots(state));
}
