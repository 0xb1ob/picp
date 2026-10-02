/**
 * The CI/PR watch (cp-e2d) — the fifth thing that wakes the parent unasked.
 *
 * ## The gap, and why it is structural
 *
 * A worker's job ends at *rebase → suite → push → report the head sha*
 * (cp-kzc): it never waits for CI, because the parent re-verifies CI against
 * that sha before every merge and does not take a worker's word for it. That
 * reasoning is intact and is not being reversed here.
 *
 * What it left behind is that **nothing tells the parent there is something to
 * verify.** The four wake-ups that existed before this module are all produced
 * by processes this system owns: an envelope, an answered decision, a wedged
 * tool call, an unreported settle. CI finishing and a PR merging are facts on
 * GitHub. No worker emits them, no local file changes when they happen, and the
 * parent sleeps on wake-ups and polls nothing — so once the fleet went idle,
 * green PRs sat unmerged until a human noticed. That happened twice in one
 * session, and four merge-ready PRs sat for fourteen hours before that.
 *
 * ## Why a watcher, and why it is a *third* shape
 *
 * Two watcher shapes already exist, and `docs/contracts.md` §The settle
 * boundary is explicit that they are required rather than duplicated plumbing:
 * an event-driven one for facts a worker emits (`EnvelopeIntake`,
 * `SettleWatcher`), and a snapshot-tick one for facts nothing emits
 * (`WedgedWatch`, over the file-derived projection the widget already reads).
 *
 * A fact on a third-party server reaches neither. `src/widget.ts` forbids
 * widening the 5-second tick ("the widget stays files-only … a 5-second
 * `br`/`gh` call is not a widget"), and `cp_status_block`'s CI gate (cp-gmy)
 * only runs *inside a parent turn* — which cannot fix a defect whose symptom is
 * the absence of turns. So this is a dedicated, slow, unref'd interval owned by
 * the extension, outside the model's context entirely.
 *
 * ## What it is not allowed to do
 *
 *  - **It never merges anything.** A green CI wake-up is evidence, never
 *    authorization: the parent verifies against `head_sha` itself and takes the
 *    merge decision by whatever authority is in force. Nothing here encodes
 *    that authority, and nothing here closes a br issue, tears anything down,
 *    or declares an Awaiting-you row.
 *  - **It never blocks.** Every tick issues single, non-blocking queries and
 *    returns: no `sleep`, no shell loop, no `gh run watch`, no
 *    `gh pr checks --watch` — the three shapes `src/ci-wait.ts` refuses at the
 *    worker boundary, which the parent's own machinery must not do either.
 *    A test feeds every command this module builds to `detectCiWait` and
 *    asserts `undefined`.
 *  - **It never uses GraphQL check-rollup fields.** `gh pr checks` and
 *    `gh pr view --json statusCheckRollup` 403 with this home's token. REST
 *    (`gh run list --json …`, `gh api repos/{o}/{r}/pulls/{n}`) works.
 *  - **It never re-derives CI state.** `evaluateMergeAskCi` (cp-gmy) is the one
 *    implementation of "has CI finished for the head that would merge", and
 *    this module calls it. One evaluator, always.
 *
 * ## Delivery: at-least-once, keyed on (job_id, head_sha, event)
 *
 * cp-nx7's rule, applied to this transport: a send is a hand-off to a queue,
 * not evidence of arrival. So a derived fact is announced (persisted) only when
 * the `cp-ci` message is **observed landing in the parent's context**; until
 * then it is in-memory in-flight and is derived and sent again after
 * `CI_WATCH_DELIVERY_RETRY_SECONDS`. A duplicate CI notice is idempotent and
 * visible; a lost one is invisible, which is the entire reason this exists.
 *
 * The idempotence key is `${job_id}|${head_sha}|${event}`, plus the head's run
 * identity for a CI event so a new attempt wakes again; a force-push is simply an
 * unseen key: the old head's runs stop counting the moment the head
 * moves (`evaluateMergeAskCi` returns `superseded` until a run starts on the
 * new one), and a green already delivered for the old head is not retracted —
 * it was true about a sha that is now history, and `src/wakeups.ts` withholds
 * any such message still in flight.
 *
 * ## Seam
 *
 * This module ends at the wake-up. It observes GitHub, decides that a
 * `(job, head, event)` fact is new, and hands a stamped, coalesced notice to
 * the transport. Whoever executes afterwards — the parent by hand, or the merge
 * executor (`cp_integrate`, br cp-uug) — consumes that same wake-up as input.
 * Nothing here rebases, resolves a conflict, merges, or decides who may.
 */

import {
	CI_WATCH_DELIVERY_RETRY_SECONDS,
	CI_WATCH_IDLE_MULTIPLIER,
	CI_WATCH_INTERVAL_MS,
	CI_WATCH_KEEP_ANNOUNCED,
	CI_WATCH_MAX_BACKOFF_MS,
	type CiWatchEvent,
	type CiWatchFile,
	type CiWatchJob,
	type Delivery,
	EMPTY_CI_WATCH_FILE,
	isoTimestamp,
	type JobPhase,
	LAYOUT,
	type Receipt,
	SCHEMA_VERSION,
	validateCiWatchFile,
} from "./contracts.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";
import {
	type CiRun,
	type CommandRunner,
	evaluateMergeAskCi,
	type HeadResolution,
	MERGE_ASK_QUERY_TIMEOUT_MS,
	runCommand,
} from "./merge-ask.ts";
import { type ProjectOf, projectGroupedLines } from "./project-report.ts";
import { LANDED_RECEIPT_STATUSES } from "./supersede.ts";

export class CiWatchError extends Error {}

// ---------------------------------------------------------------------------
// The watch predicate
// ---------------------------------------------------------------------------

/** The slice of a fleet record this module reads. Structural on purpose. */
export interface WatchableRecord {
	job_id: string;
	branch: string;
	project: string;
	phase: JobPhase;
	delivery: Delivery;
	reported_at?: string;
	receipts?: readonly Receipt[];
}

/** The job's PR receipt, when intake filed one with a url. */
export function prReceiptOf(record: WatchableRecord): Receipt | undefined {
	return (record.receipts ?? []).find((receipt) => receipt.kind === "pr" && Boolean(receipt.url));
}

/**
 * A job is watched iff it is a `delivery:pr` job that is `held` with an
 * envelope filed and an *open* PR receipt.
 *
 * Every clause is a fact on the record, and each excludes something on purpose:
 *
 *  - `waiting` is out — nothing is contractually pushed yet, and the worker's
 *    own pre-envelope suite is its business;
 *  - `done`/`failed` are out — the story is over;
 *  - a receipt already `merged`/`landed` is out, which is how the watch set
 *    drains itself once `cp_merged` records the receipt;
 *  - `reported_at` is asserted rather than assumed: a promote clears it and
 *    returns the phase to `waiting` (`src/supersede.ts`), and asserting it here
 *    stops a future phase change silently widening the set.
 *
 * Deliberately **not** in the predicate: worker liveness. A `held`
 * `delivery:pr` job keeps its worker alive by design, and this must not care.
 */
export function isWatched(record: WatchableRecord): boolean {
	if (record.delivery !== "pr") return false;
	if (record.phase !== "held") return false;
	if (record.reported_at === undefined) return false;
	const receipt = prReceiptOf(record);
	if (!receipt) return false;
	return !LANDED_RECEIPT_STATUSES.includes(receipt.status.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Facts and events
// ---------------------------------------------------------------------------

/** What REST says about the PR. Never a check rollup: those fields 403 here. */
export interface PrObservation {
	number?: number;
	url?: string;
	/** `open` | `closed`, verbatim from REST. */
	state?: string;
	merged: boolean;
	merge_commit_sha?: string;
	merged_at?: string;
	closed_at?: string;
	/** The PR's own head oid — the cheapest correct answer to "what is pushed". */
	head_sha?: string;
	head_ref?: string;
}

/** One new fact about one job. The whole payload of a `cp-ci` wake-up. */
export interface CiObservation {
	job_id: string;
	event: CiWatchEvent;
	/** `${job_id}|${head_sha}|${event}` — the idempotence key, verbatim. */
	key: string;
	branch: string;
	head_sha: string;
	pr_url?: string;
	pr_number?: number;
	/** One bounded operator-facing line. Never a body, never a diff. */
	reason: string;
	conclusion?: string;
	workflow?: string;
	merge_commit_sha?: string;
	merged_at?: string;
	closed_at?: string;
	/** The head's completed-run identity behind a CI event, when there is one (`ciRunIdentity`). */
	run_identity?: string;
}

/**
 * The identity of one observed fact. Force-push moves it by construction;
 * `runIdentity` moves it again when a CI run gains a new completed attempt on the
 * same head, so a re-run wakes once (pi-command-post-rerunwake-12z).
 */
export function ciEventKey(jobId: string, headSha: string, event: CiWatchEvent, runIdentity?: string): string {
	const key = `${jobId}|${headSha}|${event}`;
	return runIdentity && runIdentity.length > 0 ? `${key}|${runIdentity}` : key;
}

/** The job an event key names, for grouping a coalesced confirmation. */
export function jobIdOfKey(key: string): string | undefined {
	const id = key.split("|")[0];
	return id && id.length > 0 ? id : undefined;
}

export interface CiFacts {
	jobId: string;
	branch: string;
	/** REST facts about the PR, when they could be read. */
	pr?: PrObservation;
	/** The branch's pushed head, used when the PR did not answer. */
	head: HeadResolution;
	runs: readonly CiRun[];
}

/**
 * The whole event rule, as a pure function over facts.
 *
 * A merged or closed PR ends the story, so no CI event is derived alongside it:
 * "CI is green on a commit that already merged" is not news, and the follow-on
 * (`cp_merged`, close the br issue, tear down) is the same either way.
 *
 * Nothing is emitted for `in_progress`, `superseded` (no run has started on
 * this head yet) or `unknown`. Those are the states this watcher exists to sit
 * through quietly — an alarm that fires every tick is an alarm nobody reads.
 */
export function deriveCiEvents(facts: CiFacts): CiObservation[] {
	const head = facts.pr?.head_sha?.trim() || facts.head.sha?.trim() || "";
	const base = {
		job_id: facts.jobId,
		branch: facts.branch,
		head_sha: head,
		...(facts.pr?.url ? { pr_url: facts.pr.url } : {}),
		...(facts.pr?.number !== undefined ? { pr_number: facts.pr.number } : {}),
	};
	const identity = ciRunIdentity(facts.runs, head);
	const at = (event: CiWatchEvent, rest: Partial<CiObservation> & { reason: string }, runIdentity = ""): CiObservation => ({
		...base,
		event,
		key: ciEventKey(facts.jobId, head.length > 0 ? head : "unknown", event, runIdentity),
		...(runIdentity.length > 0 ? { run_identity: runIdentity } : {}),
		...rest,
	});

	if (facts.pr?.merged) {
		const commit = facts.pr.merge_commit_sha?.trim();
		return [
			at("pr_merged", {
				reason: `PR merged${commit ? ` as ${commit.slice(0, 12)}` : ""}${facts.pr.merged_at ? ` at ${facts.pr.merged_at}` : ""}`,
				...(commit ? { merge_commit_sha: commit } : {}),
				...(facts.pr.merged_at ? { merged_at: facts.pr.merged_at } : {}),
			}),
		];
	}
	if (facts.pr && (facts.pr.state ?? "").trim().toLowerCase() === "closed") {
		return [
			at("pr_closed", {
				reason: `PR closed without merging${facts.pr.closed_at ? ` at ${facts.pr.closed_at}` : ""}`,
				...(facts.pr.closed_at ? { closed_at: facts.pr.closed_at } : {}),
			}),
		];
	}
	if (head.length === 0) return [];

	// cp-gmy's evaluator, unforked: a completed run counts only when its headSha
	// is the branch's current pushed head, and one unfinished run on that head
	// defers the whole aggregate.
	const verdict = evaluateMergeAskCi({ branch: facts.branch, head: { sha: head }, runs: facts.runs });
	if (verdict.ci === "green") {
		return [at("ci_green", { reason: verdict.reason, conclusion: "success" }, identity)];
	}
	if (verdict.ci === "failed") {
		const failing = facts.runs.find(
			(run) => run.status === "completed" && (run.conclusion ?? "").toLowerCase() !== "success" && sameHead(run.headSha, head),
		);
		return [
			at("ci_failed", {
				reason: verdict.reason,
				...(verdict.conclusion ? { conclusion: verdict.conclusion } : {}),
				...(failing?.workflowName ? { workflow: failing.workflowName } : {}),
			}, identity),
		];
	}
	return [];
}

function sameHead(a: string | undefined, b: string): boolean {
	if (!a) return false;
	const left = a.trim().toLowerCase();
	const right = b.trim().toLowerCase();
	return left.startsWith(right) || right.startsWith(left);
}

/**
 * The identity of the completed CI attempt(s) on one head (pi-command-post-rerunwake-12z):
 * `gh run rerun` moves it, so a failed re-run on the same head is a new fact. All
 * the head's runs are hashed into one bounded string — a re-run of one workflow
 * changes it even when a later-started run does not; a run with no id contributes
 * nothing (the historical `job|head|event` key).
 */
export function ciRunIdentity(runs: readonly CiRun[], head: string): string {
	const ids = runs
		.filter((run) => sameHead(run.headSha, head) && run.databaseId !== undefined)
		.map((run) => `${run.databaseId}.${run.attempt ?? 1}`)
		.sort();
	return ids.length > 0 ? createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 12) : "";
}

/** The CI classification for a head, without deriving an event from it. */
export function ciStateOf(facts: CiFacts): string {
	const head = facts.pr?.head_sha?.trim() || facts.head.sha?.trim();
	if (!head) return "unknown";
	return evaluateMergeAskCi({ branch: facts.branch, head: { sha: head }, runs: facts.runs }).ci;
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

export interface CiWatchCadence {
	intervalMs: number;
	idleMultiplier: number;
	maxBackoffMs: number;
}

/**
 * The configured cadence: `CP_CI_WATCH_SECONDS` if it is a positive finite
 * number, else `CI_WATCH_INTERVAL_MS`. A malformed or non-positive value falls
 * back to the default rather than disabling the watch — the same rule
 * `wedgedToolCallSeconds()` states, for the same reason: a typo in an env var
 * must not silently turn detection off.
 */
export function ciWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.CP_CI_WATCH_SECONDS;
	if (raw === undefined || raw.trim() === "") return CI_WATCH_INTERVAL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return CI_WATCH_INTERVAL_MS;
	return Math.floor(parsed * 1000);
}

/**
 * When this job is next worth asking about. Three regimes, and the error one is
 * the only one that grows: an unreachable `gh` must cost less every minute, not
 * the same amount forever.
 */
export function nextDueMs(cadence: CiWatchCadence, state: { failures: number; settled: boolean }): number {
	if (state.failures > 0) {
		const grown = cadence.intervalMs * 2 ** Math.max(0, state.failures - 1);
		return Math.min(grown, cadence.maxBackoffMs);
	}
	return state.settled ? cadence.intervalMs * cadence.idleMultiplier : cadence.intervalMs;
}

// ---------------------------------------------------------------------------
// The persisted memory
// ---------------------------------------------------------------------------

/**
 * `state/ci-watch.json`, read-modify-write, **synchronously** — the same
 * discipline `AnsweredOutbox` uses and for the same reasons: with no `await`
 * inside, a read-modify-write is atomic against everything else in this
 * single-threaded process, and this file is written by this module alone.
 *
 * Every read is total. An unreadable or contract-violating file degrades to "no
 * memory" (at worst, one duplicate notice) rather than throwing out of a tick,
 * because a watcher that dies on its own state file is a watcher that stops
 * watching — the failure this module exists to prevent.
 */
export class CiWatchStore {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;

	constructor(options: { home: string; now?: () => Date }) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.ciWatchFile);
		this.#now = options.now ?? (() => new Date());
	}

	read(): CiWatchFile {
		if (!existsSync(this.file)) return EMPTY_CI_WATCH_FILE;
		try {
			const result = validateCiWatchFile(JSON.parse(readFileSync(this.file, "utf8")));
			return result.ok ? result.value : EMPTY_CI_WATCH_FILE;
		} catch {
			return EMPTY_CI_WATCH_FILE;
		}
	}

	job(jobId: string): CiWatchJob | undefined {
		return this.read().jobs.find((job) => job.job_id === jobId);
	}

	/** The head this watcher last observed for a job. Files-only, for wake-ups. */
	head(jobId: string): string | undefined {
		return this.job(jobId)?.head_sha;
	}

	announced(jobId: string): Set<string> {
		return new Set(this.job(jobId)?.announced ?? []);
	}

	#mutate(mutator: (file: CiWatchFile) => CiWatchFile): CiWatchFile {
		const next = mutator(structuredClone(this.read()));
		const stamped: CiWatchFile = { ...next, schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()) };
		const result = validateCiWatchFile(stamped);
		if (!result.ok) {
			throw new CiWatchError(`refusing to write an invalid ci-watch.json:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file, result.value);
		return result.value;
	}

	/** Upsert one job's bookkeeping. `announced` is never touched here. */
	record(jobId: string, patch: Omit<Partial<CiWatchJob>, "job_id" | "announced">): CiWatchJob {
		let written: CiWatchJob | undefined;
		this.#mutate((file) => {
			const index = file.jobs.findIndex((job) => job.job_id === jobId);
			const existing = file.jobs[index] ?? { job_id: jobId, announced: [] };
			const merged: CiWatchJob = cleanJob({ ...existing, ...patch, job_id: jobId, announced: existing.announced });
			written = merged;
			const jobs = [...file.jobs];
			if (index >= 0) jobs[index] = merged;
			else jobs.push(merged);
			return { ...file, jobs };
		});
		return written as CiWatchJob;
	}

	/**
	 * Record that these facts reached the parent. The **only** path that writes
	 * `announced`, and it is called from the arrival observer, never from the
	 * send — sent is not delivered (cp-nx7).
	 */
	confirm(keys: readonly string[]): string[] {
		if (keys.length === 0) return [];
		const fresh: string[] = [];
		this.#mutate((file) => {
			const jobs = [...file.jobs];
			for (const key of keys) {
				const jobId = jobIdOfKey(key);
				if (!jobId) continue;
				const index = jobs.findIndex((job) => job.job_id === jobId);
				const existing = jobs[index] ?? { job_id: jobId, announced: [] };
				if (existing.announced.includes(key)) continue;
				fresh.push(key);
				const announced = [...existing.announced, key].slice(-CI_WATCH_KEEP_ANNOUNCED);
				const merged: CiWatchJob = { ...existing, job_id: jobId, announced };
				if (index >= 0) jobs[index] = merged;
				else jobs.push(merged);
			}
			return { ...file, jobs };
		});
		return fresh;
	}

	/** Drop every job that has left the watch set. The file is bounded by the fleet. */
	prune(live: ReadonlySet<string>): string[] {
		const dropped = this.read()
			.jobs.map((job) => job.job_id)
			.filter((jobId) => !live.has(jobId));
		if (dropped.length === 0) return [];
		this.#mutate((file) => ({ ...file, jobs: file.jobs.filter((job) => live.has(job.job_id)) }));
		return dropped;
	}
}

/** Drop empty optionals so the schema's `minLength` bounds are never tripped. */
function cleanJob(job: CiWatchJob): CiWatchJob {
	const cleaned: CiWatchJob = { job_id: job.job_id, announced: job.announced };
	if (job.head_sha && job.head_sha.length >= 7) cleaned.head_sha = job.head_sha;
	if (job.head_observed_at) cleaned.head_observed_at = job.head_observed_at;
	if (job.last_checked_at) cleaned.last_checked_at = job.last_checked_at;
	if (job.next_due_at) cleaned.next_due_at = job.next_due_at;
	if (job.consecutive_failures !== undefined) cleaned.consecutive_failures = job.consecutive_failures;
	if (job.last_ci) cleaned.last_ci = job.last_ci.slice(0, 40);
	if (job.last_error) cleaned.last_error = job.last_error.slice(0, 300);
	return cleaned;
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

export interface CiWatchDeps {
	home: string;
	/** Every fleet record, re-read per tick. The predicate is applied here. */
	jobs: () => readonly WatchableRecord[];
	/** REST facts about the job's PR. `undefined` when the receipt names none. */
	pr: (job: WatchableRecord, prUrl: string) => Promise<PrObservation | undefined>;
	/** Completed and in-flight runs for the job's branch, newest first. */
	runs: (job: WatchableRecord) => Promise<readonly CiRun[]>;
	/** The branch's pushed head, asked only when the PR did not answer. */
	head?: (job: WatchableRecord) => Promise<HeadResolution>;
	now?: () => Date;
	intervalMs?: number;
	idleMultiplier?: number;
	maxBackoffMs?: number;
	retrySeconds?: number;
	/** One run-log line per newly observed fact (`cp:ci_observed`). */
	onObserved?: (jobId: string, observation: CiObservation) => void;
	/** Called once, with the reason, when the watch disables itself. */
	onDisabled?: (reason: string) => void;
}

export interface CiWatchTick {
	/** Facts that are new and still unconfirmed: what the caller should send. */
	observations: CiObservation[];
	/** Jobs actually queried this tick. */
	checked: string[];
	/** Jobs skipped because they were not due yet. */
	skipped: string[];
	errors: { job_id: string; message: string }[];
	/** Set when the watch has turned itself off for the session. */
	disabled?: string;
}

/** `gh` is not in REQUIRED_TOOLS, so its absence is a degrade, not a crash. */
const MISSING_GH = /\bENOENT\b|command not found|not found in \$?PATH|no such file or directory/i;

export class CiWatch {
	readonly store: CiWatchStore;
	readonly #deps: CiWatchDeps;
	readonly #cadence: CiWatchCadence;
	readonly #retryMs: number;
	/**
	 * Facts sent on this process's watch and not yet observed arriving, keyed by
	 * the same idempotence key a `cp-ci` message carries. In memory on purpose:
	 * "in flight" is a fact about a live transport, and a restart has no transport
	 * to speak of.
	 *
	 * **Bounded at one resend** (pi-command-post-jua), mirroring
	 * `ReviewRuns#inFlight`/`resendDue`: a fact that is never confirmed used to be
	 * re-added to `due` — and re-sent as a brand-new `followUp` — every
	 * `retryMs` *forever*, because only `sentAt` was tracked. Three jobs were
	 * observed doing exactly that: a done/torn-down job kept surfacing a stale
	 * notice, an old-generation head kept resurfacing after a newer one was held,
	 * and an unchanged green head kept re-announcing itself for hours while its
	 * review sat pending. None of those facts was ever lost — each was sent once,
	 * correctly — the defect was that a *lagging confirmation* (a busy or idle
	 * session takes a while to run the turn that observes arrival) was
	 * indistinguishable from a *lost* send, so this kept manufacturing new copies
	 * of the same fact indefinitely instead of trusting the first two. `resent`
	 * makes that bound explicit: at most one delivered resend per key, and once
	 * a key has had it, further ticks leave the fact alone — silent
	 * under-delivery is the accepted trade, exactly as `review-runs.ts` already
	 * accepts it for verdict wake-ups.
	 *
	 * That silence never costs the merge itself: a dropped `ci_green`/`pr_merged`
	 * notice only ever loses the *wake-up* about the fact, never the fact. Merge
	 * permission is `cp_integrate`'s own read of GitHub for the pushed head
	 * (AGENTS.md §Integration), re-derived on every call rather than trusted from
	 * a prior notice — so a parent that never got told still finds a green,
	 * mergeable head the next time anything calls `cp_integrate` on that job.
	 */
	readonly #inFlight = new Map<string, { sentAt: number; resent: boolean }>();
	#tick: Promise<CiWatchTick> | undefined;
	#disabled: string | undefined;
	#disabledNotified = false;

	constructor(deps: CiWatchDeps) {
		this.#deps = deps;
		this.store = new CiWatchStore({ home: deps.home, ...(deps.now ? { now: deps.now } : {}) });
		this.#cadence = {
			intervalMs: deps.intervalMs ?? ciWatchIntervalMs(),
			idleMultiplier: deps.idleMultiplier ?? CI_WATCH_IDLE_MULTIPLIER,
			maxBackoffMs: deps.maxBackoffMs ?? CI_WATCH_MAX_BACKOFF_MS,
		};
		this.#retryMs = (deps.retrySeconds ?? CI_WATCH_DELIVERY_RETRY_SECONDS) * 1000;
	}

	get cadence(): CiWatchCadence {
		return this.#cadence;
	}

	get disabled(): string | undefined {
		return this.#disabled;
	}

	/** The head this watcher last observed for a job, for `wakeupFacts`. */
	head(jobId: string): string | undefined {
		try {
			return this.store.head(jobId);
		} catch {
			return undefined;
		}
	}

	/**
	 * When that head was last read from the remote (pi-command-post-b04). Without
	 * it the observation cannot be told apart from a lagging one — see
	 * `headMoved` in `src/wakeups.ts`.
	 *
	 * **`head_observed_at`, never `last_checked_at`** (pi-command-post-8ok): the
	 * two used to be one field, so a tick that queried and *learned nothing* — an
	 * unreachable `gh`, a PR whose head could not be resolved — advanced the age
	 * of a head it had not re-read. `headMoved` compares this against the moment
	 * the fleet recorded its own head and lets the later reading decide, so an
	 * attempt timestamp masquerading as an observation is a stale head that
	 * withholds a live verdict, and it gets fresher every time the query fails.
	 * Only a tick that actually resolved a head advances this.
	 */
	observedAt(jobId: string): string | undefined {
		try {
			return this.store.job(jobId)?.head_observed_at;
		} catch {
			return undefined;
		}
	}

	/**
	 * Record that a `cp-ci` message carrying these keys reached the parent. This
	 * is the only thing that makes an announcement permanent.
	 */
	confirm(keys: readonly string[]): string[] {
		for (const key of keys) this.#inFlight.delete(key);
		try {
			return this.store.confirm(keys);
		} catch {
			// A memory that cannot be written costs a duplicate notice, never a
			// missed one. That is the trade this module is built on.
			return [];
		}
	}

	/**
	 * One pass over the watch set. Never overlaps itself: a tick already in
	 * flight is returned as-is, in the same shape as `EnvelopeIntake.#inFlight`,
	 * so a slow `gh` cannot stack queries on the next timer beat.
	 */
	async tick(): Promise<CiWatchTick> {
		if (this.#tick) return this.#tick;
		const promise = this.#run().finally(() => {
			this.#tick = undefined;
		});
		this.#tick = promise;
		return promise;
	}

	async #run(): Promise<CiWatchTick> {
		const result: CiWatchTick = { observations: [], checked: [], skipped: [], errors: [] };
		if (this.#disabled) {
			result.disabled = this.#disabled;
			return result;
		}
		let watched: WatchableRecord[];
		try {
			watched = this.#deps.jobs().filter((record) => isWatched(record));
		} catch (error) {
			result.errors.push({ job_id: "-", message: (error as Error).message });
			return result;
		}
		try {
			this.store.prune(new Set(watched.map((record) => record.job_id)));
		} catch {
			// Pruning is housekeeping; a failure here must not skip the tick.
		}
		const now = this.#now();
		for (const record of watched) {
			if (!this.#due(record.job_id, now)) {
				result.skipped.push(record.job_id);
				continue;
			}
			result.checked.push(record.job_id);
			try {
				result.observations.push(...(await this.#check(record, now)));
			} catch (error) {
				const message = (error as Error).message;
				if (MISSING_GH.test(message)) {
					this.#disable(`gh is not available: ${message.slice(0, 200)}`);
					result.disabled = this.#disabled as string;
					return result;
				}
				result.errors.push({ job_id: record.job_id, message });
				this.#fail(record.job_id, message, now);
			}
		}
		return result;
	}

	async #check(record: WatchableRecord, now: Date): Promise<CiObservation[]> {
		const prUrl = prReceiptOf(record)?.url ?? "";
		const pr = prUrl ? await this.#deps.pr(record, prUrl) : undefined;
		let head: HeadResolution = pr?.head_sha ? { sha: pr.head_sha } : { reason: `no head known for ${record.branch}` };
		if (!head.sha && this.#deps.head) head = await this.#deps.head(record);
		// The runs query is skipped entirely once the PR's story is over: a merged
		// or closed PR derives its event from the REST call already made.
		const runs = pr?.merged || (pr?.state ?? "").toLowerCase() === "closed" ? [] : await this.#deps.runs(record);
		const facts: CiFacts = {
			jobId: record.job_id,
			branch: record.branch,
			...(pr ? { pr } : {}),
			head,
			runs,
		};
		const derived = deriveCiEvents(facts);
		const announced = this.store.announced(record.job_id);
		const due: CiObservation[] = [];
		const millis = now.getTime();
		for (const observation of derived) {
			if (announced.has(observation.key)) continue;
			const existing = this.#inFlight.get(observation.key);
			// pi-command-post-jua: a fact that already had its one delivered resend is
			// left alone from here on — resending it again on every future tick is the
			// defect this bound exists to close, and confirmation (or the job leaving
			// the watch set) is what clears it, never a third send.
			if (existing?.resent) continue;
			if (existing !== undefined && millis - existing.sentAt < this.#retryMs) continue;
			const isResend = existing !== undefined;
			this.#inFlight.set(observation.key, { sentAt: millis, resent: isResend });
			due.push(observation);
			if (!isResend) {
				try {
					this.#deps.onObserved?.(record.job_id, observation);
				} catch {
					// A run log that cannot be written must never swallow a wake-up.
				}
			}
		}
		const headSha = facts.pr?.head_sha ?? head.sha;
		const settled = derived.length > 0;
		// pi-command-post-8ok: `head_observed_at` moves with the head, and only with
		// the head. A tick that reached GitHub but could not resolve one keeps the
		// previous reading *at its previous age*, because that is what it is.
		this.#save(record.job_id, {
			...(headSha ? { head_sha: headSha, head_observed_at: isoTimestamp(now) } : {}),
			last_checked_at: isoTimestamp(now),
			next_due_at: isoTimestamp(new Date(millis + nextDueMs(this.#cadence, { failures: 0, settled }))),
			consecutive_failures: 0,
			last_ci: ciStateOf(facts),
		});
		return due;
	}

	#due(jobId: string, now: Date): boolean {
		let due: string | undefined;
		try {
			due = this.store.job(jobId)?.next_due_at;
		} catch {
			return true;
		}
		if (!due) return true;
		const at = Date.parse(due);
		if (!Number.isFinite(at)) return true;
		return now.getTime() >= at;
	}

	/**
	 * A query that failed. It advances the *scheduler's* timestamps — the attempt
	 * happened and the next one backs off — and deliberately not
	 * `head_observed_at`: nothing was read, so the head this watcher still holds
	 * is exactly as old as it was before (pi-command-post-8ok).
	 */
	#fail(jobId: string, message: string, now: Date): void {
		let failures = 1;
		try {
			failures = (this.store.job(jobId)?.consecutive_failures ?? 0) + 1;
		} catch {
			// Fall through with 1: an unreadable memory backs off gently rather than
			// hammering the remote.
		}
		this.#save(jobId, {
			last_checked_at: isoTimestamp(now),
			next_due_at: isoTimestamp(new Date(now.getTime() + nextDueMs(this.#cadence, { failures, settled: false }))),
			consecutive_failures: failures,
			last_error: message.slice(0, 300),
		});
	}

	#save(jobId: string, patch: Omit<Partial<CiWatchJob>, "job_id" | "announced">): void {
		try {
			this.store.record(jobId, patch);
		} catch {
			// Bookkeeping only. Losing it costs a duplicate query, never a lost fact.
		}
	}

	/**
	 * Turn the watch off for this session and say so **once**. An alarm that
	 * fires every minute is an alarm nobody reads, and `gh` is not in
	 * `REQUIRED_TOOLS` — a home without it is a degraded home, not a broken one.
	 */
	#disable(reason: string): void {
		this.#disabled = reason;
		if (this.#disabledNotified) return;
		this.#disabledNotified = true;
		try {
			this.#deps.onDisabled?.(reason);
		} catch {
			// Best-effort by construction.
		}
	}

	#now(): Date {
		return (this.#deps.now ?? (() => new Date()))();
	}
}

// ---------------------------------------------------------------------------
// Arrival evidence
// ---------------------------------------------------------------------------

/** The custom message type a CI wake-up travels on. */
export const CI_MESSAGE_TYPE = "cp-ci";

/**
 * The keys a `cp-ci` message carries, read off the message itself — the same
 * evidence discipline as `answeredIdsFromMessage`. A non-empty result is proof
 * that *those* facts reached the parent, not that a send was accepted.
 */
export function ciKeysFromMessage(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const record = message as { customType?: unknown; details?: unknown };
	if (record.customType !== CI_MESSAGE_TYPE) return [];
	const details = record.details as { ci?: unknown } | undefined;
	const entries = details?.ci;
	const keys = new Set<string>();
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (typeof entry === "string" && entry.length > 0) keys.add(entry);
			else if (entry && typeof entry === "object") {
				const key = (entry as { key?: unknown }).key;
				if (typeof key === "string" && key.length > 0) keys.add(key);
			}
		}
	}
	return [...keys];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HEADLINES: Readonly<Record<CiWatchEvent, string>> = Object.freeze({
	ci_green: "CI green",
	ci_failed: "CI RED",
	pr_merged: "PR merged",
	pr_closed: "PR closed unmerged",
});

/**
 * The operator-facing notice: a headline, one line per fact, and what is *not*
 * concluded. The last lines are load-bearing — a green run is evidence that a
 * commit passed, never permission to merge it; whether the repository itself
 * permits the merge is `cp_integrate`'s question (cp-e0c, answering cp-x7i),
 * and it is deliberately not answered anywhere in this module.
 *
 * They are also load-bearing in the other direction (cp-3zbp): the green copy
 * used to tell the parent to "verify CI against the head sha yourself, check
 * ancestry", which predates this watcher *being* the GitHub read. It bought a
 * turn of `gh run list` / `gh pr view` (the second of which 403s on
 * `statusCheckRollup` with this home's token) re-proving the fact the message
 * carries. The notice therefore names the one next step instead.
 */
export function formatCiNotice(observations: readonly CiObservation[], projectOf?: ProjectOf): string {
	if (observations.length === 0) return "";
	const jobs = new Set(observations.map((observation) => observation.job_id));
	const lines = [
		observations.length === 1
			? `CI/PR OBSERVED — 1 new fact about a held PR`
			: `CI/PR OBSERVED — ${observations.length} new facts about ${jobs.size} held PR(s)`,
	];
	const fact = (observation: CiObservation) =>
		`  ${observation.job_id}: ${HEADLINES[observation.event]} on ${observation.head_sha.slice(0, 12)} — ${observation.reason}${observation.pr_url ? ` ${observation.pr_url}` : ""}`;
	lines.push(...projectGroupedLines(observations, projectOf && ((observation) => projectOf(observation.job_id)), fact));
	if (observations.some((observation) => observation.event === "ci_green")) {
		lines.push(
			"This notice IS the CI read for that head: do not re-query gh to confirm it. Ancestry and whether the",
			"repository permits the merge are cp_integrate's read — call cp_integrate <job-id> and branch on next.",
			"A green run is evidence, not authorization, and this raises no Awaiting-you row. Nothing has been merged.",
		);
	}
	if (observations.some((observation) => observation.event === "ci_failed")) {
		lines.push(
			"Merging red is forbidden, so there is no merge question here: relay the failure, name the job and the",
			"workflow, and exercise ordinary judgment (promote the held worker, or re-dispatch).",
		);
	}
	if (observations.some((observation) => observation.event === "pr_merged")) {
		lines.push("A merged PR's follow-on is already contract: cp_merged <job-id>, close the br issue with a reason, cp_teardown.");
	}
	if (observations.some((observation) => observation.event === "pr_closed")) {
		lines.push("A PR closed unmerged is not a delivery: relay it. Never tear down a job whose branch never landed.");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The production facts: two REST calls per job per tick, both non-blocking
// ---------------------------------------------------------------------------

/** `https://github.com/<owner>/<repo>/pull/<n>` → the pieces REST needs. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | undefined {
	const match = url.trim().match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
	if (!match) return undefined;
	const [, owner, repo, number] = match;
	if (!owner || !repo || !number) return undefined;
	return { owner, repo, number: Number(number) };
}

/** Tolerant of field drift: anything without a state is not a fact. */
export function parsePrRest(stdout: string): PrObservation | undefined {
	const text = stdout.trim();
	if (text.length === 0) return undefined;
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object") return undefined;
	const row = parsed as Record<string, unknown>;
	const head = row.head as { sha?: unknown; ref?: unknown } | undefined;
	const observation: PrObservation = { merged: row.merged === true };
	if (typeof row.number === "number") observation.number = row.number;
	if (typeof row.html_url === "string") observation.url = row.html_url;
	if (typeof row.state === "string") observation.state = row.state;
	if (typeof row.merge_commit_sha === "string") observation.merge_commit_sha = row.merge_commit_sha;
	if (typeof row.merged_at === "string") observation.merged_at = row.merged_at;
	if (typeof row.closed_at === "string") observation.closed_at = row.closed_at;
	if (head && typeof head.sha === "string") observation.head_sha = head.sha;
	if (head && typeof head.ref === "string") observation.head_ref = head.ref;
	return observation;
}

/**
 * `gh api repos/{owner}/{repo}/pulls/{n}` — one REST request that answers the
 * merge question *and* supplies the head sha the CI question needs.
 *
 * REST on purpose: the GraphQL check-rollup fields (`gh pr checks`,
 * `gh pr view --json statusCheckRollup`) 403 with this home's token, and a
 * watcher that dies on a 403 is a watcher that never watches.
 */
export function ghPrRest(options: { cwd: string; exec?: CommandRunner; timeoutMs?: number }) {
	const exec = options.exec ?? runCommand;
	return async (prUrl: string): Promise<PrObservation | undefined> => {
		const target = parsePrUrl(prUrl);
		if (!target) return undefined;
		const stdout = await exec("gh", ["api", `repos/${target.owner}/${target.repo}/pulls/${target.number}`], {
			cwd: options.cwd,
			timeoutMs: options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS,
		});
		return parsePrRest(stdout);
	};
}
