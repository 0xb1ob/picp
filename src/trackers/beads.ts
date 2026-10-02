/**
 * The beads adapter (B2): read-only `br` calls over argument arrays, always
 * pinned with `--db`. `br --db <missing>` silently creates a database, so the
 * file is checked with `existsSync` before `br` ever runs.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { BR_READ_ONLY } from "../beads.ts";
import { TRACKER_ITEM_ID_PATTERN } from "../contracts.ts";
import { TrackerError, type TrackerAdapter, type TrackerGet, type TrackerItem, type TrackerWrite, type TrackerWriter } from "./adapter.ts";

export type BrRunner = (args: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const TIMEOUT_MS = 10_000;
const ITEM_ID_RE = new RegExp(TRACKER_ITEM_ID_PATTERN);

/** Never rejects: stdout survives a nonzero exit, because `br` reports ISSUE_NOT_FOUND there. */
export const defaultBrRunner: BrRunner = (args, opts) => new Promise((resolve) => {
	execFile("br", [...args], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
		const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
		resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
	});
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Parsed `br` stdout, or undefined when it is not JSON (the caller names the fault). */
function parseJson(text: string): Json | undefined {
	try { return JSON.parse(text) as Json; } catch { return undefined; }
}

const snippet = (result: { stdout: string; stderr: string }): string => (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, " ").slice(0, 200);

/** Validate one `br` row into a tracker item, or throw naming the fault. */
function toItem(row: unknown, source: string): TrackerItem {
	const r = row as Record<string, unknown> | null;
	if (!r || typeof r !== "object" || typeof r.id !== "string" || !ITEM_ID_RE.test(r.id) || typeof r.issue_type !== "string" ||
		(r.labels !== undefined && (!Array.isArray(r.labels) || !r.labels.every((label) => typeof label === "string")))) {
		throw new TrackerError(`${source} returned an invalid bead`);
	}
	return {
		id: r.id,
		title: typeof r.title === "string" ? r.title : "",
		description: typeof r.description === "string" ? r.description : "",
		status: typeof r.status === "string" ? r.status : "",
		issue_type: r.issue_type,
		labels: (r.labels as string[] | undefined) ?? [],
	};
}

export function beadsAdapter(run: BrRunner = defaultBrRunner): TrackerAdapter & TrackerWriter {
	const br = (db: string, args: readonly string[]) => run(["--db", db, ...BR_READ_ONLY, ...args], { cwd: dirname(db), timeoutMs: TIMEOUT_MS });
	// Writes flush to the database's JSONL like any br write; never --force or --bypass-policy.
	const write = (db: string, args: readonly string[]) => run(["--db", db, ...args], { cwd: dirname(db), timeoutMs: TIMEOUT_MS });
	const errorCode = (stdout: string): unknown => (parseJson(stdout) as { error?: { code?: unknown } } | undefined)?.error?.code;
	/** Comment texts, or the write outcome that stops the caller. */
	const comments = async (db: string, id: string): Promise<string[] | TrackerWrite> => {
		const result = await br(db, ["comments", id, "--json"]);
		if (result.code !== 0) {
			return errorCode(result.stdout) === "ISSUE_NOT_FOUND" ? { status: "refused", message: `bead ${id} not found in ${db}` } : { status: "retryable", message: `br comments ${id} failed: ${snippet(result) || `exit ${result.code}`}` };
		}
		const parsed = parseJson(result.stdout);
		if (!Array.isArray(parsed)) return { status: "retryable", message: `br comments ${id} must return an array` };
		return parsed.map((row) => (row && typeof row === "object" && !Array.isArray(row) && typeof row.text === "string" ? row.text : ""));
	};
	/** Existence and id checks shared by both writes; `br --db <missing>` would create a database. */
	const precheck = (db: string, id: string): TrackerWrite | undefined => {
		if (!ITEM_ID_RE.test(id)) return { status: "refused", message: `invalid bead id ${JSON.stringify(id)}` };
		return existsSync(db) ? undefined : { status: "retryable", message: `no beads database at ${db} (br would create one; refusing)` };
	};
	const adapter: TrackerAdapter = {
		name: "beads",
		async probe(endpoint) {
			if (!isAbsolute(endpoint)) throw new TrackerError(`beads endpoint must be an absolute path to beads.db or its .beads directory, got ${JSON.stringify(endpoint)}`);
			const path = existsSync(endpoint) && statSync(endpoint).isDirectory() ? join(endpoint, "beads.db") : endpoint;
			if (!existsSync(path)) throw new TrackerError(`no beads database at ${path} (br would create one; refusing)`);
			const real = realpathSync(path);
			const result = await br(real, ["list", "--json", "--limit", "1"]);
			const parsed = parseJson(result.stdout) as { issues?: unknown } | undefined;
			if (result.code !== 0 || !parsed || typeof parsed !== "object" || !Array.isArray(parsed.issues)) {
				throw new TrackerError(`br cannot read ${real}: ${snippet(result) || `exit ${result.code}`}`);
			}
			return real;
		},
		async get(db, id): Promise<TrackerGet> {
			if (!ITEM_ID_RE.test(id)) return { status: "error", message: `invalid bead id ${JSON.stringify(id)}` };
			const result = await br(db, ["show", id, "--json"]);
			const parsed = parseJson(result.stdout);
			if (result.code !== 0) {
				const code = (parsed as { error?: { code?: unknown } } | undefined)?.error?.code;
				return code === "ISSUE_NOT_FOUND" ? { status: "missing" } : { status: "error", message: `br show ${id} failed: ${snippet(result) || `exit ${result.code}`}` };
			}
			const row = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
			try {
				const item = toItem(row, "br show");
				if (item.id !== id) return { status: "error", message: `br show ${id} returned ${item.id}` };
				if (!item.title || !item.status) return { status: "error", message: `br show ${id} returned no title or status` };
				return { status: "found", item };
			} catch (error) {
				return { status: "error", message: (error as Error).message };
			}
		},
		async listReady(db, options = {}) {
			if (options.parent !== undefined && !ITEM_ID_RE.test(options.parent)) throw new TrackerError(`invalid epic id ${JSON.stringify(options.parent)}`);
			const result = await br(db, ["ready", "--json", "--limit", "0", ...(options.parent !== undefined ? ["--parent", options.parent] : [])]);
			const parsed = parseJson(result.stdout);
			if (result.code !== 0) throw new TrackerError(`br ready failed: ${snippet(result) || `exit ${result.code}`}`);
			if (!Array.isArray(parsed)) throw new TrackerError("br ready must return an array");
			return parsed.map((row) => toItem(row, "br ready")).filter((item) => item.issue_type !== "epic" && !item.labels.includes("deferred"));
		},
	};
	return {
		...adapter,
		async close(db, id, reason) {
			const refused = precheck(db, id);
			if (refused) return refused;
			const before = await adapter.get(db, id);
			if (before.status === "missing") return { status: "refused", message: `bead ${id} not found in ${db}` };
			if (before.status === "error") return { status: "retryable", message: before.message };
			if (before.item.status === "closed") return { status: "already" };
			const result = await write(db, ["close", id, "--reason", reason, "--json"]);
			if (result.code !== 0) {
				return errorCode(result.stdout) === "NOTHING_TO_DO" ? { status: "already" } : { status: "retryable", message: `br close ${id} failed: ${snippet(result) || `exit ${result.code}`}` };
			}
			// The success payload is not trusted; only a read-back that says closed is.
			const after = await adapter.get(db, id);
			if (after.status === "found" && after.item.status === "closed") return { status: "applied" };
			return { status: "retryable", message: `br close ${id} acknowledged but the read-back says ${after.status === "found" ? after.item.status : after.status}` };
		},
		async comment(db, id, text, marker) {
			const refused = precheck(db, id);
			if (refused) return refused;
			const before = await comments(db, id);
			if (!Array.isArray(before)) return before;
			if (before.some((body) => body.includes(marker))) return { status: "already" };
			const result = await write(db, ["comments", "add", id, "--message", text, "--json"]);
			// A failed add may still have landed: the next attempt lists first, so it never double-appends.
			if (result.code !== 0) return { status: "retryable", message: `br comments add ${id} failed: ${snippet(result) || `exit ${result.code}`}` };
			const after = await comments(db, id);
			if (Array.isArray(after) && after.some((body) => body.includes(marker))) return { status: "applied" };
			return { status: "ambiguous", message: `br comments add ${id} acknowledged but ${marker} is not listed; held, never re-appended` };
		},
	};
}
