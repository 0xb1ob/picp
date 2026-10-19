import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrChip, SessionEntry } from "./api-types.ts";
import { changeRequestUrl, type ForgeConfig, type ForgeRepository, isSafeChangeRequestUrl, parseChangeRequestUrl, resolveForgeRepository } from "../forge-url.ts";
import { fileCache } from "./file-cache.ts";
import { hashRefs, linkify } from "./linkify.ts";
import { headCi, jobHead, mergeReceipt, recordedReview } from "./overview-jobs.ts";
import { parseObject } from "./overview-read.ts";
import { fleetJobs, isSafeId, obj, readObject, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";
import { readLines, startOffset } from "./tail.ts";

/** Mirrors PENDING_REVIEW_FILE (src/contracts/reviews.ts): viewer modules import no contracts; a test pins drift. */
export const PENDING_REVIEW_FILE = "pending.json";
const EVENTS_BYTES = 256 * 1024;
const CI_VIEW: Record<string, PrChip["ci"]> = { in_progress: "pending", green: "green", failed: "red", unreadable: "unreadable" };
const LIVE = new Set(["waiting", "held", "launching", "awaiting_merge"]);
const JOB_STATUS = new Set(["open", "in_progress", "closed"]);
const ISSUE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d{0,9})\/?$/;
const ISSUE_VIEW = /^gh issue view ([1-9]\d{0,9}) (?:-R|--repo) ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const CLOSES = /\b(?:closes|fixes|resolves) #([1-9]\d{0,9})\b/gi;
const LEAD = /^(?:\*\*\[([^\]\n]+)\]\*\*|\[([^\]\n]+)\] )/;

const clean = (url: string) => url.trim().replace(/\/+$/, "");
/** A ledger `external_ref` (issue URL or `gh issue view N -R o/r`) as its canonical GitHub issue URL. */
function issueUrl(ref: string | undefined): string | undefined {
	const url = ISSUE.exec(ref?.trim() ?? ""), view = ISSUE_VIEW.exec(ref?.trim() ?? "");
	return url ? `https://github.com/${url[1]}/issues/${url[2]}` : view ? `https://github.com/${view[2]}/issues/${view[1]}` : undefined;
}
const events = fileCache((path: string) => readLines(path, startOffset(path, undefined, EVENTS_BYTES).offset, EVENTS_BYTES).lines
	.map((l) => parseObject(l.text)).filter((e): e is Json => e?.source === "cp" && (e.type === "integration_advanced" || e.type === "ci_observed")));
function runEvents(state: ViewerState, id: string): Json[] {
	try { return events(join(state.stateDir, "runs", id, "events.jsonl")); } catch { return []; }
}

/** Test hook: counts envelope.json parses (cache misses). */
export const envelopeReads = { count: 0 };
const summaries = fileCache((path: string) => { envelopeReads.count++; return str(obj(readObject(path)?.envelope)?.summary) ?? ""; });
/** The envelope summary, "" when missing or unreadable; cached on mtime+size like events. */
function envelopeSummary(path: string): string {
	try { return summaries(path); } catch { return ""; }
}

/** The PR state rule: merged, closed, unknown (a stale open receipt), draft (never readied by cp_integrate), open. */
function prState(state: ViewerState, url: string, job: Json, merged: boolean): Pick<PrChip, "state" | "merge_sha"> {
	const receipt = mergeReceipt(state, String(job.job_id)), landed = receipt && clean(String(receipt.pr_url)) === url ? receipt : undefined;
	if (merged || landed) return { state: "merged", merge_sha: str(landed?.merge_commit_sha) ?? null };
	const log = runEvents(state, String(job.job_id)).filter((e) => { const pr = str(obj(e.payload)?.pr_url); return !pr || clean(pr) === url; });
	const closed = log.some((e) => e.type === "ci_observed" && obj(e.payload)?.event === "pr_closed");
	if (closed || obj(obj(job.awaiting_merge)?.pending)?.kind === "closed_unmerged") return { state: "closed", merge_sha: null };
	if (!LIVE.has(String(job.phase))) return { state: "unknown", merge_sha: null };
	const ready = log.findLast((e) => e.type === "integration_advanced" && obj(e.payload)?.step === "ready");
	return { state: !ready || obj(ready.payload)?.undone === true ? "draft" : "open", merge_sha: null };
}
/** `running` while a diff review's pending file exists (gate dirs are plan reviews), else the verdict for `head`. */
function reviewOf(state: ViewerState, id: string, head: string | null): string | null {
	let names: string[] = [];
	try { names = readdirSync(join(state.stateDir, "runs", id)); } catch { /* No run directory: no review. */ }
	if (names.some((n) => /^review-[1-9]\d*$/.test(n) && existsSync(join(state.stateDir, "runs", id, n, PENDING_REVIEW_FILE)))) return "running";
	return str(recordedReview(state, id, head).review?.verdict) ?? null;
}

/**
 * Chips for every PR and issue URL the entries name, keyed by URL; resolves each `#N` of a registered project into
 * `entry.links`. Reads only fleet, ledger, projects, ci-watch and run files, no GitHub call; an unknown fact is null.
 */
export function attachPrChips(state: ViewerState, entries: SessionEntry[]): Record<string, PrChip> {
	const jobs = fleetJobs(state).filter((j) => isSafeId(String(j.job_id)));
	const rawLedger = readObject(join(runtimeRoot(state.home), "jobs.json"))?.jobs;
	const ledger = (Array.isArray(rawLedger) ? rawLedger.map(obj) : []).filter((j): j is Json => typeof j?.id === "string");
	const rawCi = readObject(join(state.stateDir, "ci-watch.json"))?.jobs, ciRows = Array.isArray(rawCi) ? rawCi.map(obj) : [];
	const rawProjects = readObject(join(dirname(state.stateDir), "data", "projects.json"))?.projects;
	const repos = new Map<string, ForgeRepository>();
	for (const p of Array.isArray(rawProjects) ? rawProjects.map(obj) : []) {
		const name = str(p?.name), clone = str(p?.clone_url), resolved = clone ? resolveForgeRepository(clone, obj(p?.forge) as ForgeConfig | undefined) : undefined;
		if (name && resolved?.ok) repos.set(name, resolved.repository);
	}
	const prs = new Map<string, { job: Json; merged: boolean }>();
	for (const job of jobs) {
		const receipts = (Array.isArray(job.receipts) ? job.receipts.map(obj) : []).filter((r) => r?.kind === "pr");
		for (const raw of [...receipts.map((r) => str(r?.url)), str(obj(job.bound_pr)?.url)]) {
			const url = raw && clean(raw);
			if (url && isSafeChangeRequestUrl(url)) prs.set(url, { job, merged: receipts.some((r) => r?.status === "merged" && clean(str(r.url) ?? "") === url) });
		}
	}
	const add = (map: Map<string, string[]>, key: string, value: string) => map.set(key, [...new Set([...map.get(key) ?? [], value])]);
	const issueJobs = new Map<string, string[]>();
	for (const j of ledger) { const url = issueUrl(str(j.external_ref)); if (url) add(issueJobs, url, String(j.id)); }
	let closerMap: Map<string, string[]> | undefined;
	// Lazy: envelope summaries are read only once an issue chip needs closers.
	const closersOf = () => {
		if (closerMap) return closerMap;
		closerMap = new Map();
		for (const [pr, { job }] of prs) {
			const ref = parseChangeRequestUrl(pr);
			if (ref?.kind !== "github") continue;
			const base = `https://github.com/${ref.path}/issues/`, own = issueUrl(str(ledger.find((l) => l.id === job.job_id)?.external_ref));
			const summary = envelopeSummary(join(state.stateDir, "runs", String(job.job_id), "envelope.json"));
			for (const issue of [...(own?.startsWith(base) ? [own] : []), ...[...summary.matchAll(CLOSES)].map((m) => base + m[1])]) add(closerMap, issue, pr);
		}
		return closerMap;
	};
	const prChip = (url: string): PrChip | undefined => {
		const hit = prs.get(url), ref = parseChangeRequestUrl(url);
		if (!hit || !ref) return undefined;
		const id = String(hit.job.job_id), row = ciRows.find((r) => r?.job_id === id), head = jobHead(state, hit.job, row), ci = headCi(state, id, row, head) ?? "";
		return { kind: "pr", url, number: ref.number, repo: ref.path, job_id: id, head_sha: head, ...prState(state, url, hit.job, hit.merged), closed_by: null, job_status: null,
			ci: Object.hasOwn(CI_VIEW, ci) ? CI_VIEW[ci]! : null, review: reviewOf(state, id, head) };
	};
	const issueChip = (url: string): PrChip | undefined => {
		const m = ISSUE.exec(url);
		if (!m) return undefined;
		const closing = closersOf().get(url) ?? [], jobOf = (pr: string) => String(prs.get(pr)?.job.job_id);
		const landed = closing.find((pr) => clean(str(mergeReceipt(state, jobOf(pr))?.pr_url) ?? "") === pr);
		const ids = new Set([...issueJobs.get(url) ?? [], ...closing.map(jobOf)]);
		const newest = ledger.filter((l) => ids.has(String(l.id)) && JOB_STATUS.has(String(l.status))).sort((a, b) => (str(a.created_at) ?? "").localeCompare(str(b.created_at) ?? "")).at(-1);
		return { kind: "issue", url, number: Number(m[2]), repo: m[1]!, job_id: newest ? String(newest.id) : null, head_sha: null,
			state: landed ? "closed" : issueJobs.has(url) || closing.length ? "open" : null, merge_sha: null,
			closed_by: landed ? { url: landed, number: parseChangeRequestUrl(landed)!.number } : null, job_status: (newest?.status as PrChip["job_status"]) ?? null, ci: null, review: null };
	};
	const chips: Record<string, PrChip> = {};
	for (const e of entries) {
		if (e.kind === "tool") continue;
		const owner = e.bridge?.job ? jobs.find((j) => j.job_id === e.bridge!.job) : undefined;
		const repo = repos.get(str(owner?.project) ?? e.project ?? LEAD.exec(e.text)?.slice(1).find(Boolean) ?? "");
		for (const ref of repo ? hashRefs(e.text) : []) {
			const n = Number(ref.slice(1)), pr = changeRequestUrl(repo!, n);
			const href = prs.has(pr) ? pr : repo!.kind === "github" ? `${repo!.web_base_url}/${repo!.path}/issues/${n}` : undefined;
			if (href) e.links = { ...e.links, [ref]: href };
		}
		const bound = owner ? [...prs].find(([, v]) => v.job === owner)?.[0] : undefined;
		const urls = [...linkify(e.text, e.links).flatMap((s) => s.href ? [s.href] : []), ...Object.values(e.links ?? {}), ...(bound ? [bound] : [])];
		for (const url of urls.map(clean)) { if (!chips[url]) { const chip = prChip(url) ?? issueChip(url); if (chip) chips[url] = chip; } }
	}
	return chips;
}
