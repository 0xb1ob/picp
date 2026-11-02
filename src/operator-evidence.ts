/**
 * `cp_parent jobs show` evidence: resolve one reference against this home's retained run records, read-only and
 * bounded. The selected record is never replaced by a newer one; what is current is reported beside it, labelled.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { DECISION_CONTEXT_MAX_LINES, type DiffVerdict, DiffVerdictSchema, LAYOUT, paths, REVIEW_MAX_ATTEMPTS, validate } from "./contracts.ts";
import { contextLine } from "./decision-context.ts";
import { type EvidenceReference, evidenceReferenceLabel, FLAG_ORDER } from "./evidence-reference.ts";

export const EVIDENCE_VERDICT_MAX_BYTES = 1024 * 1024;
export const EVIDENCE_EVENTS_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const CI_MATCH_MAX_LINES = 8;

export interface OperatorEvidence {
	reference: EvidenceReference;
	label: string;
	/** `available`: the selected record was read; `ambiguous`: recorded matches disagree; `unavailable`: see reason. */
	availability: "available" | "unavailable" | "ambiguous";
	reason?: string;
	/** What the selected record says, each line redacted and clipped. Empty unless available or ambiguous. */
	historical: string[];
	/** What this home records now (latest review, CI watch, latest CI event), each line source-labelled. */
	current: string[];
	/** `current`: the selected head is the current recorded head; `historical`: it is not; `unknown`: no current head. */
	head_relation: "current" | "historical" | "unknown" | "not_applicable";
	events_scan: { bytes: number; truncated: boolean } | null;
}

type Read = { ok: true; text: string; truncated: boolean } | { ok: false; reason: string; missing: boolean };

/** Read a file under `root` (default: runs), refusing a symlink that escapes it; `tail` keeps the newest bytes. */
function readConfined(home: string, rel: string, maxBytes: number, tail: boolean, root: string = LAYOUT.runs): Read {
	let fd: number | undefined;
	try {
		const base = realpathSync.native(join(home, root));
		const file = realpathSync.native(join(home, rel));
		if (!file.startsWith(base + sep) || !lstatSync(file).isFile()) return { ok: false, reason: `${rel} is outside ${root}`, missing: false };
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		if (size > maxBytes && !tail) return { ok: false, reason: `${rel} is ${size} bytes, over the ${maxBytes}-byte bound`, missing: false };
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return { ok: true, text: buffer.toString("utf8"), truncated: size > length };
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return { ok: false, reason: missing ? `no ${rel} recorded` : `${rel} unreadable`, missing };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function readVerdict(home: string, jobId: string, attempt: number): { verdict?: DiffVerdict; reason?: string; missing?: boolean } {
	const rel = paths.reviewFile(jobId, attempt);
	const read = readConfined(home, rel, EVIDENCE_VERDICT_MAX_BYTES, false);
	if (!read.ok) return { reason: read.reason, missing: read.missing };
	try {
		const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(read.text));
		if (!parsed.ok) return { reason: `${rel} does not match the verdict contract` };
		if (parsed.value.job_id !== jobId || parsed.value.attempt !== attempt) return { reason: `${rel} names another job or attempt` };
		return { verdict: parsed.value };
	} catch {
		return { reason: `${rel} is not JSON` };
	}
}

interface CiEvent { ts: string; event: string; head_sha: string; run_id?: number; run_attempt?: number; reason?: string }

function ciEvents(home: string, jobId: string): { events: CiEvent[]; scan: OperatorEvidence["events_scan"]; reason?: string } {
	const read = readConfined(home, paths.eventsFile(jobId), EVIDENCE_EVENTS_SCAN_MAX_BYTES, true);
	if (!read.ok) return { events: [], scan: null, reason: read.reason };
	const lines = read.text.split("\n");
	if (read.truncated) lines.shift(); // the first line of a tail read is partial
	const events: CiEvent[] = [];
	for (const line of lines) {
		if (!line.includes('"ci_observed"')) continue;
		try {
			const raw = JSON.parse(line) as { source?: unknown; type?: unknown; ts?: unknown; job_id?: unknown; payload?: Record<string, unknown> };
			const p = raw.payload ?? {};
			if (raw.source !== "cp" || raw.type !== "ci_observed" || raw.job_id !== jobId || typeof p.head_sha !== "string" || typeof p.event !== "string") continue;
			events.push({
				ts: String(raw.ts), event: p.event, head_sha: p.head_sha,
				...(Number.isInteger(p.run_id) ? { run_id: p.run_id as number } : {}),
				...(Number.isInteger(p.run_attempt) ? { run_attempt: p.run_attempt as number } : {}),
				...(typeof p.reason === "string" ? { reason: p.reason } : {}),
			});
		} catch {
			// A torn or foreign line is not an observation.
		}
	}
	return { events, scan: { bytes: Buffer.byteLength(read.text), truncated: read.truncated } };
}

function ciWatchHead(home: string, jobId: string): { head_sha?: string; last_ci?: string; reason?: string } | undefined {
	const read = readConfined(home, LAYOUT.ciWatchFile, EVIDENCE_VERDICT_MAX_BYTES, false, LAYOUT.state);
	if (!read.ok) return read.missing ? undefined : { reason: read.reason };
	try {
		const jobs = (JSON.parse(read.text) as { jobs?: unknown }).jobs;
		const row = Array.isArray(jobs) ? (jobs.find((j) => (j as { job_id?: unknown })?.job_id === jobId) as Record<string, unknown> | undefined) : undefined;
		if (!row) return undefined;
		return { ...(typeof row.head_sha === "string" ? { head_sha: row.head_sha } : {}), ...(typeof row.last_ci === "string" ? { last_ci: row.last_ci } : {}) };
	} catch {
		return { reason: `${LAYOUT.ciWatchFile} is not JSON` };
	}
}

const ciLine = (e: CiEvent) =>
	contextLine(`${e.ts} ${e.event} on ${e.head_sha}${e.run_id === undefined ? " (run id not recorded)" : ` run ${e.run_id}`}${e.run_attempt === undefined ? "" : ` attempt ${e.run_attempt}`}${e.reason ? ` — ${e.reason}` : ""}`);

function reviewLines(v: DiffVerdict, only?: { list: string; ordinal: number }): string[] {
	const lines = [contextLine(`review-${v.attempt}: ${v.verdict}${v.cause ? ` (${v.cause})` : ""} on ${v.head_sha} at ${v.decided_at}${v.model ? ` by ${v.model}` : ""}`)];
	const findings: string[] = [];
	const add = (list: string, ordinal: number, text: string) => {
		if (!only || (only.list === list && only.ordinal === ordinal)) findings.push(contextLine(`${list}[${ordinal}]: ${text}`));
	};
	v.reasons.forEach((text, i) => add("reasons", i, text));
	(v.revisions ?? []).forEach((text, i) => add("revisions", i, text));
	FLAG_ORDER.forEach((flag, i) => {
		if (v.flags[flag]) add("flags", i, flag);
	});
	const room = DECISION_CONTEXT_MAX_LINES - lines.length - 1;
	lines.push(...findings.slice(0, room));
	if (findings.length > room) lines.push(`… ${findings.length - room} more findings elided`);
	return lines;
}

/** Resolve a validated reference whose project and job already match the ledger row. Never throws. */
export function resolveOperatorEvidence(home: string, ref: EvidenceReference): OperatorEvidence {
	const jobId = ref.job_id;
	const out: OperatorEvidence = { reference: ref, label: evidenceReferenceLabel(ref), availability: "available", historical: [], current: [], head_relation: "not_applicable", events_scan: null };
	const unavailable = (reason: string) => Object.assign(out, { availability: "unavailable" as const, reason: contextLine(reason), historical: [] });
	const ci = ciEvents(home, jobId);
	out.events_scan = ci.scan;

	let latest: DiffVerdict | undefined;
	for (let attempt = REVIEW_MAX_ATTEMPTS; attempt >= 1 && !latest; attempt -= 1) {
		const read = readVerdict(home, jobId, attempt);
		latest = read.verdict;
		if (!read.verdict && !read.missing) out.current.push(contextLine(`skipped as unreadable: ${read.reason}`));
	}
	const watch = ciWatchHead(home, jobId);
	const lastCi = ci.events.at(-1);
	const current = watch?.head_sha ? { head: watch.head_sha, source: "ci-watch" } : lastCi ? { head: lastCi.head_sha, source: "events" } : latest ? { head: latest.head_sha, source: `review-${latest.attempt}` } : undefined;
	out.current.push(current ? contextLine(`current head ${current.head} (source: ${current.source})`) : "current head: none recorded");
	if (latest) out.current.push(contextLine(`latest review (source: review-${latest.attempt}): ${latest.verdict} on ${latest.head_sha}`));
	else out.current.push("latest review: none recorded");
	if (current && latest && latest.head_sha !== current.head) out.current.push(contextLine(`no recorded review verdict for current head ${current.head}`));
	if (watch?.last_ci) out.current.push(contextLine(`CI watch (source: ci-watch): ${watch.last_ci}${watch.head_sha ? ` on ${watch.head_sha}` : ""}`));
	if (watch?.reason) out.current.push(contextLine(`ci-watch: ${watch.reason}`));
	if (lastCi) out.current.push(`latest CI event (source: events): ${ciLine(lastCi)}`);
	if (ci.scan?.truncated) out.current.push(`events scan kept the newest ${ci.scan.bytes} bytes; older events were not read`);
	if (ci.reason) out.current.push(contextLine(`events: ${ci.reason}`));
	if (ref.kind === "job") return out;

	out.head_relation = current ? (current.head === ref.head_sha ? "current" : "historical") : "unknown";
	if (ref.kind === "ci") {
		const matches = ci.events.filter((e) => e.head_sha === ref.head_sha && (ref.run_id === undefined || e.run_id === ref.run_id) && (ref.run_attempt === undefined || e.run_attempt === ref.run_attempt));
		if (matches.length === 0) {
			const why = ref.run_attempt !== undefined ? "; run attempts are not recorded by this home's CI journal" : "";
			return unavailable(`no recorded CI observation matches ${out.label}${why}${ci.scan?.truncated ? " in the scanned window" : ""}`);
		}
		out.historical = matches.slice(-CI_MATCH_MAX_LINES).map(ciLine);
		if (matches.length > CI_MATCH_MAX_LINES) out.historical.unshift(`… ${matches.length - CI_MATCH_MAX_LINES} older observations elided`);
		const outcomes = new Set(matches.filter((e) => e.event === "ci_green" || e.event === "ci_failed").map((e) => e.event));
		if (ref.run_id !== undefined && outcomes.size > 1) Object.assign(out, { availability: "ambiguous", reason: `recorded observations of ${out.label} disagree (${[...outcomes].join(", ")})` });
		return out;
	}
	const read = readVerdict(home, jobId, ref.attempt!);
	if (!read.verdict) return unavailable(read.reason ?? "review unreadable");
	if (read.verdict.head_sha !== ref.head_sha) return unavailable(`review-${ref.attempt} reviewed ${read.verdict.head_sha}, not the selected head ${ref.head_sha}`);
	if (ref.kind === "finding") {
		const list = ref.list === "flags" ? (read.verdict.flags[FLAG_ORDER[ref.ordinal!]!] ? [FLAG_ORDER[ref.ordinal!]] : []) : (read.verdict[ref.list!] ?? []);
		const present = ref.list === "flags" ? list.length > 0 : ref.ordinal! < list.length;
		if (!present) return unavailable(`review-${ref.attempt} has no ${ref.list}[${ref.ordinal}]`);
	}
	out.historical = reviewLines(read.verdict, ref.kind === "finding" ? { list: ref.list!, ordinal: ref.ordinal! } : undefined);
	return out;
}
