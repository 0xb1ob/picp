/**
 * The foreign-PR CI watch (cp-wlhu S5): CI and PR facts about pull requests this
 * home did NOT ship — a ledger job whose `external_ref` is a PR in its project's
 * own GitHub repo (a cp-pr-review fan-out reviewer, typically).
 *
 * The own-PR watch (`src/ci-watch.ts`) covers only a held `delivery:pr` fleet
 * record with a PR receipt. This one reuses its pure pieces (`deriveCiEvents`,
 * `parsePrUrl`, `ghPrRest`, the cadence) and adds only what differs:
 *
 *  - selection: non-closed ledger jobs, a PR url in the job project's registered
 *    repo, no fleet PR receipt for that url (own PRs stay with CiWatch);
 *  - runs: `actions/runs?head_sha=` against the URL's *base* repo — a fork PR's
 *    runs are listed there, never on a branch of ours;
 *  - `head_moved`, once per new head;
 *  - surfacing: one operator notice per tick. Never a wake-up (the wake-up kinds
 *    are closed), never a merge, comment, re-run, Awaiting-you row or cp_integrate.
 *
 * One consumer beyond the notice: the reviewer dispatch gate (`gate`, binding
 * decision es-314c8e c). A cp-pr-review reviewer job (kind research, a
 * `schedule:` label) waits — armed, through the ordinary armed-dispatch path —
 * until CI on the PR's head has completed, at most `FOREIGN_CI_GATE_TIMEOUT_MS`
 * after the job was created; its brief then carries the CI state, "unknown"
 * past the timeout. Evidence for a reviewer, never authorization for anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CiFacts, type CiWatchCadence, ciStateOf, ciWatchIntervalMs, deriveCiEvents, nextDueMs, parsePrUrl, type PrObservation } from "./ci-watch.ts";
import {
	CI_WATCH_IDLE_MULTIPLIER,
	CI_WATCH_MAX_BACKOFF_MS,
	EMPTY_FOREIGN_CI_WATCH_FILE,
	FOREIGN_CI_GATE_TIMEOUT_MS,
	FOREIGN_CI_KEEP_ANNOUNCED,
	FOREIGN_CI_MAX_PER_TICK,
	type ForeignCiEvent,
	type ForeignCiWatchFile,
	type ForeignCiWatchJob,
	isoTimestamp,
	LAYOUT,
	SCHEMA_VERSION,
	validateForeignCiWatchFile,
} from "./contracts.ts";
import { BlockedDispatchError } from "./dispatch.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";
import { type Job, parseJobLabels } from "./ledger.ts";
import { type CiRun, type CommandRunner, MERGE_ASK_QUERY_TIMEOUT_MS, parseCiRuns, runCommand } from "./merge-ask.ts";

const SCHEDULE_LABEL = "schedule:";
/** A PR that is gone or private to this token: reported once, then never queried again. */
const UNREADABLE = /\b404\b|Not Found/i;

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The slice of a ledger job this module reads. */
export type ForeignJobRecord = Pick<Job, "id" | "status" | "labels" | "external_ref" | "created_at">;

export interface ForeignPr {
	job_id: string;
	project: string;
	/** The canonical `https://github.com/<owner>/<repo>/pull/<n>`. */
	url: string;
	owner: string;
	repo: string;
	number: number;
}

function prKey(owner: string, repo: string, number: number): string {
	return `${owner}/${repo}#${number}`.toLowerCase();
}

/** The PR a non-closed job's `external_ref` names, when it is in the job project's own repo (`repoOf`: `owner/repo`). */
export function foreignPrOf(job: ForeignJobRecord, repoOf: (project: string) => string | undefined): ForeignPr | undefined {
	if (job.status === "closed" || !job.external_ref) return undefined;
	const target = parsePrUrl(job.external_ref);
	if (!target) return undefined;
	let project: string | undefined;
	try {
		project = parseJobLabels(job.labels).project;
	} catch {
		return undefined; // two project labels: not a job this watch can attribute
	}
	const repo = project ? repoOf(project) : undefined;
	if (!project || !repo || repo.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) return undefined;
	return { job_id: job.id, project, url: `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`, ...target };
}

/** Q10: every non-closed job naming a PR in its project's repo that no fleet record of this home carries as its PR receipt. */
export function foreignPrJobs(jobs: readonly ForeignJobRecord[], ownPrUrls: readonly string[], repoOf: (project: string) => string | undefined): ForeignPr[] {
	const own = new Set(
		ownPrUrls.flatMap((url) => {
			const target = parsePrUrl(url);
			return target ? [prKey(target.owner, target.repo, target.number)] : [];
		}),
	);
	return jobs.flatMap((job) => {
		const target = foreignPrOf(job, repoOf);
		return target && !own.has(prKey(target.owner, target.repo, target.number)) ? [target] : [];
	});
}

// ---------------------------------------------------------------------------
// The runs query: one REST GET against the PR's base repo
// ---------------------------------------------------------------------------

const FOREIGN_RUNS_JQ = "[.workflow_runs[] | {status, conclusion, headSha: .head_sha, workflowName: .name, databaseId: .id, attempt: .run_attempt}]";

/** `gh api repos/<owner>/<repo>/actions/runs?head_sha=<sha>` — fork PR runs are listed on the base repo. `execFile` passes no shell. */
export function foreignRunsArgs(owner: string, repo: string, sha: string): string[] {
	if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`refusing to query runs for a malformed head sha ${JSON.stringify(sha.slice(0, 80))}`);
	return ["api", `repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`, "--jq", FOREIGN_RUNS_JQ];
}

export function ghForeignRuns(options: { cwd: string; exec?: CommandRunner; timeoutMs?: number }) {
	const exec = options.exec ?? runCommand;
	return async (owner: string, repo: string, sha: string): Promise<CiRun[]> =>
		parseCiRuns(await exec("gh", foreignRunsArgs(owner, repo, sha), { cwd: options.cwd, timeoutMs: options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS }));
}

// ---------------------------------------------------------------------------
// The persisted memory
// ---------------------------------------------------------------------------

/** `state/foreign-ci-watch.json`. Every read is total: an invalid file is no memory (at worst a duplicate notice), as `CiWatchStore`. */
export class ForeignCiWatchStore {
	readonly file: string;
	readonly #now: () => Date;

	constructor(options: { home: string; now?: () => Date }) {
		this.file = join(canonicalDir(options.home), LAYOUT.foreignCiWatchFile);
		this.#now = options.now ?? (() => new Date());
	}

	read(): ForeignCiWatchFile {
		if (!existsSync(this.file)) return EMPTY_FOREIGN_CI_WATCH_FILE;
		try {
			const result = validateForeignCiWatchFile(JSON.parse(readFileSync(this.file, "utf8")));
			return result.ok ? result.value : EMPTY_FOREIGN_CI_WATCH_FILE;
		} catch {
			return EMPTY_FOREIGN_CI_WATCH_FILE;
		}
	}

	write(jobs: readonly ForeignCiWatchJob[]): void {
		const file = { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()), jobs: [...jobs] };
		const result = validateForeignCiWatchFile(file);
		if (!result.ok) throw new Error(`refusing to write an invalid foreign-ci-watch.json:\n  ${result.errors.join("\n  ")}`);
		atomicWriteJson(this.file, result.value);
	}
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/** Read-only ports: two REST GETs and local reads. No merge, wake, comment or re-run port exists here. */
export interface ForeignCiWatchDeps {
	home: string;
	/** Every ledger job, re-read per tick and per gate. */
	jobs: () => readonly ForeignJobRecord[];
	/** The PR urls this home's own fleet records carry as receipts. */
	ownPrUrls: () => readonly string[];
	/** `owner/repo` of a project's registered GitHub `clone_url`; undefined for any other remote. */
	repoOf: (project: string) => string | undefined;
	pr: (target: ForeignPr) => Promise<PrObservation | undefined>;
	runs: (owner: string, repo: string, sha: string) => Promise<readonly CiRun[]>;
	/** The own-PR watch's disabled reason (gh missing): this watch is off with it. */
	disabled?: () => string | undefined;
	now?: () => Date;
	intervalMs?: number;
	maxPerTick?: number;
	gateTimeoutMs?: number;
}

export interface ForeignCiObservation {
	job_id: string;
	project: string;
	event: ForeignCiEvent;
	/** `foreign|<job>|<head>|<event>|<runIdentity>`. */
	key: string;
	pr_url: string;
	head_sha: string;
	reason: string;
}

export interface ForeignCiTick {
	observations: ForeignCiObservation[];
	/** Jobs queried this tick. */
	checked: string[];
	/** Due jobs left for a later tick by the per-tick cap. */
	deferred: string[];
	/** Query failures whose cause is new for that job (a repeated cause is backed off silently). */
	errors: { job_id: string; project: string; pr_url: string; message: string }[];
	/** Jobs this watch stopped querying because the PR could not be read. */
	stopped: { job_id: string; project: string; pr_url: string; reason: string }[];
	disabled?: string;
}

/** Waiting for foreign CI: `cp_dispatch` arms it like an open blocker, and every release re-runs this gate. */
export class ForeignCiWaitError extends BlockedDispatchError {
	constructor(message: string) {
		super(message, []);
	}
}

const COMPLETED = new Set(["green", "failed"]);

export class ForeignCiWatch {
	readonly store: ForeignCiWatchStore;
	readonly #deps: ForeignCiWatchDeps;
	readonly #cadence: CiWatchCadence;
	#tick: Promise<ForeignCiTick> | undefined;

	constructor(deps: ForeignCiWatchDeps) {
		this.#deps = deps;
		this.store = new ForeignCiWatchStore({ home: deps.home, ...(deps.now ? { now: deps.now } : {}) });
		this.#cadence = { intervalMs: deps.intervalMs ?? ciWatchIntervalMs(), idleMultiplier: CI_WATCH_IDLE_MULTIPLIER, maxBackoffMs: CI_WATCH_MAX_BACKOFF_MS };
	}

	/** One pass. Never overlaps itself, like `CiWatch.tick`. */
	tick(): Promise<ForeignCiTick> {
		if (this.#tick) return this.#tick;
		this.#tick = this.#run().finally(() => {
			this.#tick = undefined;
		});
		return this.#tick;
	}

	async #run(): Promise<ForeignCiTick> {
		const result: ForeignCiTick = { observations: [], checked: [], deferred: [], errors: [], stopped: [] };
		const disabled = this.#deps.disabled?.();
		if (disabled) {
			result.disabled = disabled;
			return result;
		}
		const selected = this.#selected();
		const kept = new Map(this.store.read().jobs.map((entry) => [entry.job_id, entry]));
		const memory = new Map<string, ForeignCiWatchJob>();
		const now = this.#now();
		const cap = this.#deps.maxPerTick ?? FOREIGN_CI_MAX_PER_TICK;
		try {
			for (const target of selected) {
				const previous = kept.get(target.job_id);
				const entry: ForeignCiWatchJob = previous?.pr_url === target.url ? structuredClone(previous) : { job_id: target.job_id, pr_url: target.url, failures: 0, announced: [] };
				memory.set(target.job_id, entry);
				if (entry.ended || (entry.next_due_at && now.getTime() < Date.parse(entry.next_due_at))) continue;
				if (result.checked.length >= cap) {
					result.deferred.push(target.job_id);
					continue;
				}
				result.checked.push(target.job_id);
				try {
					const stopped = await this.#check(target, entry, now, result.observations);
					if (stopped) result.stopped.push({ job_id: target.job_id, project: target.project, pr_url: target.url, reason: stopped });
				} catch (error) {
					const message = ((error as Error).message ?? String(error)).split("\n")[0]!.slice(0, 300) || "no message";
					if (UNREADABLE.test(message)) {
						entry.ended = `PR unreadable: ${message}`.slice(0, 300);
						result.stopped.push({ job_id: target.job_id, project: target.project, pr_url: target.url, reason: entry.ended });
						continue;
					}
					entry.failures += 1;
					entry.next_due_at = isoTimestamp(new Date(now.getTime() + nextDueMs(this.#cadence, { failures: entry.failures, settled: false })));
					if (entry.last_error !== message) result.errors.push({ job_id: target.job_id, project: target.project, pr_url: target.url, message });
					entry.last_error = message;
				}
			}
		} finally {
			try {
				this.store.write([...memory.values()]); // jobs that left the selection are pruned here
			} catch (error) {
				result.errors.push({ job_id: "-", project: "-", pr_url: "-", message: `foreign-ci-watch.json not written: ${(error as Error).message.split("\n")[0]}` });
			}
		}
		return result;
	}

	/** Query one job, mutate its memory, push its fresh facts. Returns a stop reason when the PR cannot be read. */
	async #check(target: ForeignPr, entry: ForeignCiWatchJob, now: Date, out: ForeignCiObservation[]): Promise<string | undefined> {
		const pr = await this.#deps.pr(target);
		if (!pr) {
			entry.ended = "PR unreadable: the REST reply carried no PR state";
			return entry.ended;
		}
		const head = pr.head_sha?.trim() ?? "";
		const fact = (event: ForeignCiEvent, key: string, reason: string): ForeignCiObservation => ({ job_id: target.job_id, project: target.project, event, key, pr_url: target.url, head_sha: head, reason });
		const facts: ForeignCiObservation[] = [];
		if (head && entry.head_sha && entry.head_sha !== head) {
			facts.push(fact("head_moved", `foreign|${target.job_id}|${head}|head_moved`, `head moved from ${entry.head_sha.slice(0, 12)} to ${head.slice(0, 12)}`));
		}
		if (head && entry.head_sha !== head) {
			entry.head_sha = head;
			entry.head_observed_at = isoTimestamp(now);
		}
		const over = pr.merged || (pr.state ?? "").trim().toLowerCase() === "closed";
		const runs = over || !head ? [] : await this.#deps.runs(target.owner, target.repo, head);
		const ci: CiFacts = { jobId: target.job_id, branch: pr.head_ref ?? target.url, pr, head: head ? { sha: head } : { reason: "the PR reported no head" }, runs };
		for (const observed of deriveCiEvents(ci)) facts.push(fact(observed.event, `foreign|${observed.key}`, observed.reason));
		entry.last_ci = over ? (pr.merged ? "merged" : "closed") : ciStateOf(ci);
		if (over) entry.ended = pr.merged ? "PR merged" : "PR closed without merging";
		entry.failures = 0;
		delete entry.last_error;
		entry.next_due_at = isoTimestamp(new Date(now.getTime() + nextDueMs(this.#cadence, { failures: 0, settled: COMPLETED.has(entry.last_ci) })));
		const fresh = facts.filter((observation) => !entry.announced.includes(observation.key));
		entry.announced = [...entry.announced, ...fresh.map((observation) => observation.key)].slice(-FOREIGN_CI_KEEP_ANNOUNCED);
		out.push(...fresh);
		return undefined;
	}

	/**
	 * The cp-pr-review reviewer dispatch gate (binding decision es-314c8e c).
	 * `undefined` for a job it does not cover (not research, no `schedule:`
	 * label, or no foreign PR). Otherwise the CI line the brief carries, or a
	 * `ForeignCiWaitError` until CI has completed on the PR's *current* head
	 * (re-read here) and the job is younger than the timeout. Never a merge or review authorization.
	 */
	async gate(job: ForeignJobRecord, now: Date = this.#now()): Promise<{ line: string } | undefined> {
		if (!job.labels.some((label) => label.startsWith(SCHEDULE_LABEL))) return undefined;
		try {
			if (parseJobLabels(job.labels).kind !== "research") return undefined;
		} catch {
			return undefined;
		}
		const target = foreignPrJobs([job], this.#deps.ownPrUrls(), this.#deps.repoOf)[0];
		if (!target) return undefined;
		const entry = this.store.read().jobs.find((candidate) => candidate.job_id === job.id && candidate.pr_url === target.url);
		if (entry?.ended) return { line: `${target.url}: CI unknown — ${entry.ended}.` };
		const disabled = this.#deps.disabled?.();
		if (disabled) return { line: `${target.url}: CI unknown — the CI watch is off (${disabled}).` };
		const on = entry?.head_sha ? ` on ${entry.head_sha.slice(0, 12)}` : "";
		let seen = entry?.last_ci ? `${entry.last_ci}${on}` : "not observed yet";
		// A completed result counts only for the head the reviewer will read: one fresh read-only GET, made only when it could release.
		if (entry?.last_ci && COMPLETED.has(entry.last_ci) && entry.head_sha) {
			const current = await this.#currentHead(target);
			if (current.head === entry.head_sha) return { line: `${target.url}: CI ${entry.last_ci}${on} (foreign CI watch; the PR's current head at dispatch).` };
			seen = `${seen}, but the PR head is now ${current.head ? current.head.slice(0, 12) : `unknown (${current.error})`}`;
		}
		const timeout = this.#deps.gateTimeoutMs ?? FOREIGN_CI_GATE_TIMEOUT_MS;
		const deadline = Date.parse(job.created_at) + timeout;
		if (!(now.getTime() < deadline)) return { line: `${target.url}: CI unknown — not completed within ${Math.round(timeout / 60_000)} min of ${job.created_at} (last seen: ${seen}).` };
		throw new ForeignCiWaitError(
			`${job.id} waits for CI on ${target.url} to complete (${seen}); it is dispatched once CI completes, or with CI "unknown" at ${isoTimestamp(new Date(deadline))} at the latest`,
		);
	}

	/** The PR's head right now, through the same read-only `pr` port the tick uses; never throws. */
	async #currentHead(target: ForeignPr): Promise<{ head?: string; error?: string }> {
		try {
			const head = (await this.#deps.pr(target))?.head_sha?.trim();
			return head ? { head } : { error: "the REST reply carried no head" };
		} catch (error) {
			return { error: ((error as Error).message ?? String(error)).split("\n")[0]!.slice(0, 200) };
		}
	}

	#selected(): ForeignPr[] {
		return foreignPrJobs(this.#deps.jobs(), this.#deps.ownPrUrls(), this.#deps.repoOf);
	}

	#now(): Date {
		return (this.#deps.now ?? (() => new Date()))();
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HEADLINES: Readonly<Record<ForeignCiEvent, string>> = Object.freeze({
	ci_green: "CI green",
	ci_failed: "CI RED",
	pr_merged: "PR merged",
	pr_closed: "PR closed unmerged",
	head_moved: "head moved",
});

/** One coalesced operator notice per tick; empty when there is nothing new. Evidence only, and it says so. */
export function formatForeignCiNotice(tick: Pick<ForeignCiTick, "observations" | "stopped">): string {
	if (tick.observations.length === 0 && tick.stopped.length === 0) return "";
	const lines = [`FOREIGN PR CI — ${tick.observations.length + tick.stopped.length} new fact(s) about PRs this home did not ship`];
	for (const fact of tick.observations) {
		lines.push(`  [${fact.project}] ${fact.job_id}: foreign PR ${fact.pr_url} ${HEADLINES[fact.event]}${fact.head_sha ? ` on ${fact.head_sha.slice(0, 12)}` : ""} — ${fact.reason}`);
	}
	for (const stop of tick.stopped) lines.push(`  [${stop.project}] ${stop.job_id}: stopped watching foreign PR ${stop.pr_url} — ${stop.reason}`);
	lines.push("Evidence only: nothing was merged, commented, re-run or woken, and this raises no Awaiting-you row.");
	return lines.join("\n");
}
