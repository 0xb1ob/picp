/**
 * The workbench dashboard (cp-s560 W2b): the fleet grouped by project, and every mandate with its caps
 * and spend. Dependency-free tolerant reads, like `sessions.ts`: a missing or mistyped field is absent,
 * never a crash.
 *
 * The spend rule is a mirror, not an import (importing `src/mandate.ts` pulls typebox into the viewer):
 * `covers`, `mandateTokens`, `mandateSpend` and its `usage_baseline` (usage accrued after issue only) follow
 * `src/mandate-accounting.ts`, reviewer spend follows
 * `MandateStore.withReviewerSpend`, and the live overlay follows `liveUsageJobs` (`src/mandate-usage.ts`).
 * `tests/viewer-workbench.test.ts` pins them to the real functions on the same home.
 */

import { type Dirent, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { worktreeRoot } from "./explorer.ts";
import { readScheduleFile } from "./schedule-core.ts";
import { SHA } from "./git-read.ts";
import { fleetJobs, isSafeId, type Json, num, obj, readLedger, readObject, readStatus, str, type ViewerState } from "./sessions.ts";

/** The only URL shape that reaches the page; everything else is dropped server-side. */
export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const REVIEWER_RUN_DIR = /^(?:gate|review|quality)-[a-z0-9_-]+$/;
const FINISHED_SHOWN = 10;
const OTHER_MANDATES_SHOWN = 5;

interface Usage {
	cost_usd: number;
	total_tokens: number;
	cache_read: number;
}
interface UsageJob {
	job: Json;
	job_id: string;
	project: string;
	kind?: string | undefined;
	phase?: string | undefined;
	usage?: Usage | undefined;
	reviewer_usage?: Usage | undefined;
	/** The fleet record's `schedule_id`, and the mandate that schedule names (state/schedules.json). */
	schedule_id?: string | undefined;
	schedule_mandate?: string | undefined;
}

function usage(value: unknown): Usage | undefined {
	const u = obj(value);
	return u ? { cost_usd: num(u.cost_usd) ?? 0, total_tokens: num(u.total_tokens) ?? 0, cache_read: num(u.cache_read) ?? 0 } : undefined;
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Names in `data/projects.json` (a sibling of the state dir in both modes). */
export function registeredProjects(state: ViewerState): string[] {
	const projects = readObject(join(dirname(state.stateDir), "data", "projects.json"))?.projects;
	return (Array.isArray(projects) ? projects : []).map((p) => str(obj(p)?.name)).filter((n): n is string => n !== undefined && isSafeId(n));
}

/** Every `state/mandates/md-*.json` that looks like a mandate, oldest issued first. */
export function readMandates(state: ViewerState): Json[] {
	let names: string[];
	try {
		names = readdirSync(join(state.stateDir, "mandates"));
	} catch {
		return [];
	}
	return names
		.filter((name) => /^md-[A-Za-z0-9_-]+\.json$/.test(name))
		.map((name) => readObject(join(state.stateDir, "mandates", name)))
		.filter((m): m is Json => !!m && !!str(m.id) && !!str(m.status) && !!str(m.expiry) && !!str(m.issued_at) && Array.isArray(m.projects) && !!obj(m.spend_cap))
		.sort((a, b) => String(a.issued_at).localeCompare(String(b.issued_at)));
}

/** Summed usage of every gate/review/quality run under `runs/<jobId>/`. */
export function reviewerUsage(state: ViewerState, jobId: string): Usage | undefined {
	if (!isSafeId(jobId)) return undefined;
	const dir = join(state.stateDir, "runs", jobId);
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let total: Usage | undefined;
	for (const entry of entries) {
		if (!entry.isDirectory() || !REVIEWER_RUN_DIR.test(entry.name)) continue;
		const u = usage(readObject(join(dir, entry.name, "status.json"))?.usage);
		if (!u) continue;
		total = {
			cost_usd: (total?.cost_usd ?? 0) + u.cost_usd,
			total_tokens: (total?.total_tokens ?? 0) + u.total_tokens,
			cache_read: (total?.cache_read ?? 0) + u.cache_read,
		};
	}
	return total;
}

/** Fleet jobs with each live run total laid over the fleet's, whichever is further along. */
function usageJobs(state: ViewerState): UsageJob[] {
	const out: UsageJob[] = [];
	const schedules = scheduleMandates(state);
	for (const job of fleetJobs(state)) {
		const id = str(job.job_id);
		const project = str(job.project);
		if (!id || !isSafeId(id) || !project) continue;
		const fleet = usage(job.usage);
		const live = usage(readStatus(state, id)?.usage);
		const scheduleId = str(job.schedule_id);
		out.push({ job, job_id: id, project, kind: str(job.kind), phase: str(job.phase), usage: live && live.total_tokens > (fleet?.total_tokens ?? 0) ? live : fleet, schedule_id: scheduleId, schedule_mandate: scheduleId ? schedules.get(scheduleId) : undefined });
	}
	return out;
}

/** Schedule id -> the mandate it names; unreadable is empty, as `MandateStore.scheduleMandates`. */
function scheduleMandates(state: ViewerState): Map<string, string> {
	try {
		return new Map(readScheduleFile(join(state.stateDir, "schedules.json")).flatMap((s) => s.mandate_id ? [[s.id, s.mandate_id] as const] : []));
	} catch {
		return new Map();
	}
}

function covers(m: Json, job: UsageJob): boolean {
	if (!strings(m.projects).includes(job.project)) return false;
	if (m.schedule_grant === true ? !job.schedule_id || job.schedule_mandate !== str(m.id) : job.schedule_id !== undefined) return false;
	const ids = strings(m.job_ids);
	if (ids.length > 0 && !ids.includes(job.job_id)) return false;
	const kinds = strings(obj(m.exclusions)?.job_kinds);
	if (job.kind && kinds.includes(job.kind)) return false;
	return true;
}

const mandateTokens = (u?: Usage): number => Math.max(0, (u?.total_tokens ?? 0) - (u?.cache_read ?? 0));
const isLive = (m: Json): boolean => m.status === "active" || m.status === "paused";

interface Baseline {
	usd: number;
	tokens: number;
	reviewer_usd: number;
	reviewer_tokens: number;
}

/** `usage_baseline`: each covered job's usage at issue; a job without an entry counts in full. */
function baselineOf(m: Json): Map<string, Baseline> {
	const out = new Map<string, Baseline>();
	for (const entry of Array.isArray(m.usage_baseline) ? m.usage_baseline : []) {
		const e = obj(entry);
		const id = str(e?.job_id);
		if (!e || !id) continue;
		out.set(id, { usd: num(e.usd) ?? 0, tokens: num(e.tokens) ?? 0, reviewer_usd: num(e.reviewer_usd) ?? 0, reviewer_tokens: num(e.reviewer_tokens) ?? 0 });
	}
	return out;
}

const past = (now: number, then = 0): number => Math.max(0, now - then);

export function mandateSpend(m: Json, jobs: readonly UsageJob[]): { usd: number; tokens: number; jobs: number; inFlight: number } {
	const matched = jobs.filter((job) => covers(m, job));
	const baseline = baselineOf(m);
	const named = strings(m.job_ids).length > 0;
	let usd = 0;
	let tokens = 0;
	let counted = 0;
	let inFlight = 0;
	for (const job of matched) {
		const base = baseline.get(job.job_id);
		const spentUsd = past(job.usage?.cost_usd ?? 0, base?.usd) + past(job.reviewer_usage?.cost_usd ?? 0, base?.reviewer_usd);
		const spentTokens = past(mandateTokens(job.usage), base?.tokens) + past(mandateTokens(job.reviewer_usage), base?.reviewer_tokens);
		usd += spentUsd;
		tokens += spentTokens;
		if (named || !base || spentUsd > 0 || spentTokens > 0) counted += 1;
		if (job.phase === "waiting" || job.phase === "launching") inFlight += 1;
	}
	return { usd, tokens, jobs: counted, inFlight };
}

export interface JobRow {
	job_id: string;
	title?: string | undefined;
	kind?: string | undefined;
	delivery?: string | undefined;
	phase?: string | undefined;
	run_phase?: string | undefined;
	role?: string | undefined;
	model?: string | undefined;
	script_path?: string | undefined;
	scope?: string | undefined;
	risk?: string | undefined;
	cost_usd: number;
	reviewer_cost_usd: number;
	/** Non-cached tokens, worker plus reviewer: what a mandate's token cap counts. */
	tokens: number;
	dispatched_at?: string | undefined;
	closed_at?: string | undefined;
	branch?: string | undefined;
	pr_url?: string | undefined;
	pr_status?: string | undefined;
	live: boolean;
}

export function jobRow(state: ViewerState, entry: UsageJob, title: string | undefined): JobRow {
	const { job } = entry;
	const status = readStatus(state, entry.job_id);
	const routing = obj(job.routing);
	const pr = (Array.isArray(job.receipts) ? job.receipts : []).map(obj).find((r) => r?.kind === "pr" && PR_URL.test(str(r.url) ?? ""));
	const runPhase = str(status?.phase);
	return {
		job_id: entry.job_id,
		title,
		kind: entry.kind,
		delivery: str(job.delivery),
		phase: entry.phase,
		run_phase: runPhase,
		role: str(obj(job.worker)?.role),
		model: job.executor === "script" ? undefined : str(status?.model) ?? str(obj(job.worker)?.model),
		script_path: str(job.script_path),
		scope: str(routing?.scope),
		risk: str(routing?.risk),
		cost_usd: entry.usage?.cost_usd ?? 0,
		reviewer_cost_usd: entry.reviewer_usage?.cost_usd ?? 0,
		tokens: mandateTokens(entry.usage) + mandateTokens(entry.reviewer_usage),
		dispatched_at: str(job.dispatched_at),
		closed_at: str(job.closed_at),
		branch: str(job.branch),
		pr_url: str(pr?.url),
		pr_status: str(pr?.status),
		live: (runPhase === "working" || runPhase === "starting") && entry.phase !== "done" && entry.phase !== "failed",
	};
}

const finished = (row: JobRow): boolean => row.phase === "done" || row.phase === "failed";

/** Usage jobs with reviewer spend added where a live (active/paused) mandate covers them. */
export function spendJobs(state: ViewerState, live: readonly Json[]): UsageJob[] {
	return usageJobs(state).map((job) => {
		if (!live.some((m) => covers(m, job))) return job;
		const reviewers = reviewerUsage(state, job.job_id);
		return reviewers ? { ...job, reviewer_usage: reviewers } : job;
	});
}

const sha = (value: unknown): string | undefined => (typeof value === "string" && SHA.test(value) ? value : undefined);

/** Newest `runs/<id>/review-<n>.json` (a DiffVerdict record): its attempt, verdict and reviewed head. */
function latestReview(state: ViewerState, id: string): { attempt: number; verdict: string; head_sha?: string | undefined } | undefined {
	let names: string[];
	try {
		names = readdirSync(join(state.stateDir, "runs", id));
	} catch {
		return undefined;
	}
	const attempt = Math.max(0, ...names.map((name) => Number(/^review-([1-9]\d{0,3})\.json$/.exec(name)?.[1] ?? 0)));
	const record = attempt ? readObject(join(state.stateDir, "runs", id, `review-${attempt}.json`)) : undefined;
	const verdict = str(record?.verdict);
	return verdict ? { attempt, verdict, head_sha: sha(record?.head_sha) } : undefined;
}

/**
 * One job for `#job/<id>`: its dashboard row, the envelope's shas, the CI watch and the latest review.
 * `head` prefers the CI watch's sha (it tracks pushes after the envelope); both must be 40-hex.
 */
export function jobDetail(state: ViewerState, id: string) {
	if (!isSafeId(id)) return undefined;
	const entry = spendJobs(state, readMandates(state).filter(isLive)).find((job) => job.job_id === id);
	if (!entry) return undefined;
	const env = obj(readObject(join(state.stateDir, "runs", id, "envelope.json"))?.envelope);
	const watched = readObject(join(state.stateDir, "ci-watch.json"))?.jobs;
	const ci = (Array.isArray(watched) ? watched : []).map(obj).find((w) => w?.job_id === id);
	const envelope = env && { head_sha: str(env.head_sha), base_sha: str(env.base_sha), branch: str(env.branch), status: str(env.status), summary: str(env.summary) };
	return {
		...jobRow(state, entry, readLedger(state).get(id)?.title),
		project: entry.project,
		worktree_live: worktreeRoot(entry.job) !== undefined,
		envelope,
		ci: ci && { head_sha: str(ci.head_sha), last_ci: str(ci.last_ci) },
		review: latestReview(state, id),
		head: sha(ci?.head_sha) ?? sha(env?.head_sha),
		base: sha(env?.base_sha),
	};
}

export function dashboard(state: ViewerState, now = Date.now(), finishedLimit = FINISHED_SHOWN) {
	const mandates = readMandates(state);
	const live = mandates.filter(isLive);
	const jobs = spendJobs(state, live);
	const ledger = readLedger(state);
	const names = new Set([...registeredProjects(state), ...jobs.map((job) => job.project), ...live.flatMap((m) => strings(m.projects))]);
	const projects = [...names].sort().map((name) => {
		const rows = jobs.filter((job) => job.project === name).map((job) => jobRow(state, job, ledger.get(job.job_id)?.title));
		const active = rows.filter((row) => !finished(row)).sort((a, b) => (a.dispatched_at ?? "").localeCompare(b.dispatched_at ?? ""));
		const done = rows.filter(finished).sort((a, b) => (b.closed_at ?? b.dispatched_at ?? "").localeCompare(a.closed_at ?? a.dispatched_at ?? ""));
		return {
			name,
			jobs: [...active, ...done.slice(0, finishedLimit)],
			done_hidden: Math.max(0, done.length - finishedLimit),
			spend: { usd: rows.reduce((sum, row) => sum + row.cost_usd + row.reviewer_cost_usd, 0), tokens: rows.reduce((sum, row) => sum + row.tokens, 0) },
			mandate_ids: live.filter((m) => strings(m.projects).includes(name)).map((m) => String(m.id)),
		};
	});
	const nowIso = new Date(now).toISOString();
	const others = mandates.filter((m) => !isLive(m)).slice(-OTHER_MANDATES_SHOWN);
	const shown = mandates.filter((m) => isLive(m) || others.includes(m)).map((m) => ({
		id: String(m.id),
		status: String(m.status),
		pause_reason: str(m.pause_reason),
		expired_by_clock: String(m.expiry) <= nowIso,
		projects: strings(m.projects),
		...(Array.isArray(m.job_ids) ? { job_ids: strings(m.job_ids) } : {}),
		objective: (str(m.objective) ?? "").slice(0, 200),
		expiry: String(m.expiry),
		spend_cap: { usd: num(obj(m.spend_cap)?.usd) ?? 0, tokens: num(obj(m.spend_cap)?.tokens) ?? 0 },
		job_cap: num(m.job_cap) ?? 0,
		dispatch_parallelism: num(m.dispatch_parallelism) ?? 1,
		allowed_actions: strings(m.allowed_actions),
		ask_on: strings(m.ask_on),
		spend: mandateSpend(m, jobs),
	}));
	return { generated_at: nowIso, projects, mandates: shown };
}
