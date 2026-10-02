/**
 * The job ledger (spec 2026-09-04): the parent's memory of *work* — what is
 * in flight, what is blocked on what, and, once closed, what happened.
 *
 * One JSON document per home at `<home>/.pi-command-post/jobs.json`, written
 * with the same discipline as `state/fleet.json`: every mutation runs inside
 * pi's per-path mutation queue, reads the file, validates, mutates, validates
 * again and lands with tmp → fsync → rename. No in-memory cache; the parent
 * lock already guarantees one writer process per home.
 *
 * The contract it enforces is the one ported from command-post AGENTS.md §Jobs:
 *
 *  - Every job carries `project:<name>` and `delivery:<mode>` labels, plus
 *    `kind:<ship|research>` when it helps. A job without them is not
 *    dispatchable, and that is checked here rather than hoped for.
 *  - Real dependencies only: A is blocked by B when A *cannot start* until B
 *    closes. `ready` and `blocked` are computed from `blocked_by`, never
 *    stored, and never paged — the fail-open page that cp-i2s found cannot
 *    recur because there is no page.
 *  - Closed is a transition, not an edit: `update()` refuses `closed`,
 *    `close()` always carries a reason, and a second close with a different
 *    reason is refused (a close is a fact). Dropped work is closed, never
 *    deleted.
 *
 * A live worker does not stop the class from closing a job (the pipeline
 * closes a research job after a gate pass while its planner is still up); the
 * `cp_job` tool is where that refusal lives, because the model is the only
 * caller that could do it by accident.
 */

import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { normalizeExternalRef } from "./beads.ts";
import {
	collectLegacyJobFields,
	type Delivery,
	DELIVERIES,
	findDependencyCycle,
	isoTimestamp,
	isSafeJobId,
	isSafeScriptPath,
	isSafeLedgerPrefix,
	type Job,
	JOB_ID_MINT_RETRIES,
	JOB_ID_SUFFIX_LENGTH,
	JOB_KINDS,
	JOB_SLUG_PATTERN,
	type JobKind,
	type JobsDocument,
	type JobStatus,
	LAYOUT,
	OPEN_JOB_STATUSES,
	type Risk,
	RISKS,
	SCHEMA_VERSION,
	stripLegacyJobFields,
	validateJobsDocument,
} from "./contracts.ts";
import { atomicWriteJson, canonicalDir, durableAppend, queued } from "./json-store.ts";
import { filterJobs, LABEL_PREFIX, type ListFilter } from "./ledger-filter.ts";
export { LABEL_PREFIX, type ListFilter } from "./ledger-filter.ts";

// Callers (dispatch.ts, status.ts, tests) import the job type from here, not
// from contracts.ts directly — this is the ledger's own public surface.
export type { Job } from "./contracts.ts";

export class LedgerError extends Error {}

// ---------------------------------------------------------------------------
// Job labels — the dispatchability contract (unchanged)
// ---------------------------------------------------------------------------

/** Label values are branch- and CLI-safe: alphanumerics, hyphen, underscore. */
const LABEL_VALUE_RE = /^[A-Za-z0-9_-]+$/;

export interface JobLabels {
	project: string;
	delivery: Delivery;
	kind?: JobKind;
	risk?: Risk;
}

export function formatJobLabels(job: JobLabels): string[] {
	const labels = [`${LABEL_PREFIX.project}${job.project}`, `${LABEL_PREFIX.delivery}${job.delivery}`];
	if (job.kind) labels.push(`${LABEL_PREFIX.kind}${job.kind}`);
	if (job.risk) labels.push(`${LABEL_PREFIX.risk}${job.risk}`);
	return labels;
}

function labelValue(labels: readonly string[], prefix: string): string | undefined {
	const found = labels.filter((label) => label.startsWith(prefix)).map((label) => label.slice(prefix.length));
	if (found.length > 1) {
		throw new LedgerError(`job carries ${found.length} ${prefix} labels (${found.join(", ")}); exactly one is allowed`);
	}
	return found[0];
}

export { normalizeExternalRef } from "./beads.ts";

/** Intake dedupe key: trim, collapse whitespace, case-fold. */
export function normalizeJobTitle(title: string): string {
	return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Best-effort parse; missing pieces come back undefined. */
export function parseJobLabels(labels: readonly string[] = []): Partial<JobLabels> {
	const project = labelValue(labels, LABEL_PREFIX.project);
	const delivery = labelValue(labels, LABEL_PREFIX.delivery);
	const kind = labelValue(labels, LABEL_PREFIX.kind);
	const risk = labelValue(labels, LABEL_PREFIX.risk);
	const parsed: Partial<JobLabels> = {};
	if (project) parsed.project = project;
	if (delivery && (DELIVERIES as readonly string[]).includes(delivery)) parsed.delivery = delivery as Delivery;
	if (kind && (JOB_KINDS as readonly string[]).includes(kind)) parsed.kind = kind as JobKind;
	if (risk && (RISKS as readonly string[]).includes(risk)) parsed.risk = risk as Risk;
	return parsed;
}

/**
 * Fail-closed read of a job's labels. Dispatch calls this before anything is
 * leased: a job that does not say which project and which delivery it is, is
 * not a job. `update()` calls it after a label edit for the same reason.
 */
export function requireJobLabels(job: Pick<Job, "id" | "labels">): JobLabels {
	const labels = job.labels ?? [];
	const parsed = parseJobLabels(labels);
	const problems: string[] = [];
	if (!parsed.project) problems.push(`missing ${LABEL_PREFIX.project}<name>`);
	const rawDelivery = labelValue(labels, LABEL_PREFIX.delivery);
	if (!parsed.delivery) {
		problems.push(
			rawDelivery
				? `${LABEL_PREFIX.delivery}${rawDelivery} is not one of ${DELIVERIES.join("|")}`
				: `missing ${LABEL_PREFIX.delivery}<${DELIVERIES.join("|")}>`,
		);
	}
	const rawKind = labelValue(labels, LABEL_PREFIX.kind);
	if (rawKind && !parsed.kind) problems.push(`${LABEL_PREFIX.kind}${rawKind} is not one of ${JOB_KINDS.join("|")}`);
	const rawRisk = labelValue(labels, LABEL_PREFIX.risk);
	if (rawRisk && !parsed.risk) problems.push(`${LABEL_PREFIX.risk}${rawRisk} is not one of ${RISKS.join("|")}`);
	if (problems.length > 0) throw new LedgerError(`${job.id} is not dispatchable: ${problems.join("; ")}`);
	return {
		project: parsed.project as string,
		delivery: parsed.delivery as Delivery,
		...(parsed.kind ? { kind: parsed.kind } : {}),
		...(parsed.risk ? { risk: parsed.risk } : {}),
	};
}

// ---------------------------------------------------------------------------
// The document on disk
// ---------------------------------------------------------------------------

export function jobsFile(home: string): string {
	return join(home, LAYOUT.jobsFile);
}

/**
 * Create the document when there is none. Never rewrites an existing one —
 * the prefix recorded on disk wins over the one asked for, which is how a home
 * cannot silently switch id namespaces (doctor reports the mismatch instead).
 */
export function initJobsDocument(home: string, prefix: string): { document: JobsDocument; created: boolean } {
	const file = jobsFile(home);
	if (existsSync(file)) return { document: readJobsDocument(home), created: false };
	if (!isSafeLedgerPrefix(prefix)) {
		throw new LedgerError(`${JSON.stringify(prefix)} is not a usable ledger prefix: lowercase, starts with a letter, at most 8 chars`);
	}
	const document: JobsDocument = { schema_version: SCHEMA_VERSION, prefix, jobs: [] };
	atomicWriteJson(file, document);
	return { document, created: true };
}

/**
 * Read and validate a document at an already-resolved file path, or throw a
 * `LedgerError` that names the file and the fault. Shared by `readJobsDocument`
 * (a fresh, uncontended read given a home) and `Ledger.read()` (which must read
 * the exact path its mutation queue is keyed on — see `Ledger.file`).
 */
function readJobsDocumentAt(file: string): JobsDocument {
	if (!existsSync(file)) {
		throw new LedgerError(`no ledger at ${file} — start a session (the scaffold creates it), or run /doctor`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new LedgerError(`${file} is not JSON: ${(error as Error).message}`);
	}
	const result = validateJobsDocument(stripLegacyJobFields(parsed));
	if (!result.ok) throw new LedgerError(`${file} violates the jobs contract:\n  ${result.errors.join("\n  ")}`);
	return result.value;
}

/** Read and validate, or throw a `LedgerError` that names the file and the fault. */
export function readJobsDocument(home: string): JobsDocument {
	return readJobsDocumentAt(jobsFile(home));
}

/** Where the retired `type`/`priority` values are kept once a mutation drops them. */
export function legacyArchiveFile(home: string): string {
	return join(canonicalDir(home), LAYOUT.jobsLegacyArchive);
}

/**
 * Preserve the retired `type`/`priority` values a document on disk still
 * carries, before the write that removes them.
 *
 * Failure-closed on purpose: the caller runs this *before* `atomicWriteJson`
 * and lets a throw abort the mutation, so a document is never rewritten
 * without its retired values landing durably first (`durableAppend` is
 * `O_APPEND` + `fsync`). A document with nothing retired — every document
 * written after 2026-09-05 — costs one parse and writes nothing.
 */
function archiveLegacyJobFields(file: string, archive: string, at: string): void {
	let parsed: unknown;
	try {
		if (!existsSync(file)) return;
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new LedgerError(`refusing to write ${file}: could not re-read it to archive the retired job fields: ${(error as Error).message}`);
	}
	const jobs = collectLegacyJobFields(parsed);
	if (jobs.length === 0) return;
	try {
		durableAppend(archive, `${JSON.stringify({ at, source: file, jobs })}\n`);
	} catch (error) {
		throw new LedgerError(
			`refusing to write ${file}: the retired job fields (${jobs.map((job) => job.id).join(", ")}) could not be archived to ${archive}: ${(error as Error).message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLUG_RE = new RegExp(JOB_SLUG_PATTERN);

/**
 * `<prefix>-<suffix>` or `<prefix>-<slug>-<suffix>`. Four characters of
 * `[a-z0-9]`, redrawn on collision; after `JOB_ID_MINT_RETRIES` collisions the
 * suffix grows to five. `random(max)` is injectable so tests can force both.
 */
export function mintJobId(
	prefix: string,
	existing: ReadonlySet<string>,
	options: { slug?: string; random?: (max: number) => number } = {},
): string {
	const random = options.random ?? ((max: number) => randomInt(max));
	if (options.slug !== undefined && !SLUG_RE.test(options.slug)) {
		throw new LedgerError(`slug ${JSON.stringify(options.slug)} must match ${JOB_SLUG_PATTERN}`);
	}
	const stem = options.slug ? `${prefix}-${options.slug}` : prefix;
	const attempts = JOB_ID_MINT_RETRIES * 2;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const length = attempt < JOB_ID_MINT_RETRIES ? JOB_ID_SUFFIX_LENGTH : JOB_ID_SUFFIX_LENGTH + 1;
		let suffix = "";
		for (let i = 0; i < length; i += 1) suffix += SUFFIX_ALPHABET[random(SUFFIX_ALPHABET.length)] ?? "0";
		const id = `${stem}-${suffix}`;
		if (!existing.has(id) && isSafeJobId(id)) return id;
	}
	throw new LedgerError(`could not mint a unique id under ${stem}- after ${attempts} attempts`);
}

// ---------------------------------------------------------------------------
// Pure queries over a document
// ---------------------------------------------------------------------------

/** A dropped close records abandonment, not a delivered dependency. */
export function wasDropped(job: Job): boolean {
	return job.status === "closed" && (job.close_reason ?? "").startsWith("dropped:");
}

/** Unresolved blockers, including dropped closes. Unknown dependency ids fail closed. */
export function openBlockersOf(doc: JobsDocument, id: string): string[] {
	const byId = new Map(doc.jobs.map((job) => [job.id, job]));
	const job = byId.get(id);
	if (!job) return [];
	return job.blocked_by.filter((id) => {
		const blocker = byId.get(id);
		return !blocker || blocker.status !== "closed" || wasDropped(blocker);
	});
}

export function isReady(doc: JobsDocument, job: Job): boolean {
	return job.status === "open" && openBlockersOf(doc, job.id).length === 0;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerOptions {
	/** Command post home; the document is `<home>/.pi-command-post/jobs.json`. */
	home: string;
	/** Recorded as the author of comments. Defaults to the OS user name. */
	actor?: string;
	now?: () => Date;
	/**
	 * Project names allowed on `project:` labels (the registry). When present,
	 * intake refuses a project the registry does not know.
	 */
	knownProjects?: readonly string[];
	/**
	 * Resolve a project name to its beads DB's absolute path: the project's
	 * active tracker connection, else `<checkout>/.beads/beads.db` when it exists —
	 * never the home's `.beads`. Used to pin a bare `br show <id> --json`
	 * external_ref to that DB (a leased worktree's `.beads/` is gitignored).
	 * Absent, or no DB: refs pass through unchanged.
	 */
	beadsDbFor?: (project: string) => string | undefined;
	/** Injected in tests to force id collisions. */
	random?: (max: number) => number;
}

export interface IntakeInput {
	title: string;
	project: string;
	delivery: Delivery;
	kind?: JobKind;
	/** Recorded as a `risk:<low|high>` label; the risk:high gate reads it, a low never routes (riskkw-f10). */
	risk?: Risk;
	description?: string;
	/**
	 * Where the issue lives: a tracker url, a file path, or the command that
	 * shows it (for a `br` tracker, `br --db <absolute path to the project's
	 * .beads/beads.db> show <id> --json`; a bare `br show <id> --json` is
	 * rewritten to that form when the project has a discoverable DB). One line;
	 * the ledger points, never copies.
	 */
	externalRef?: string;
	/** Checked-in POSIX repository-relative script; only ship/local jobs. */
	scriptPath?: string;
	slug?: string;
	assignee?: string;
	/** Extra labels beyond the job contract. */
	labels?: readonly string[];
}

export interface UpdatePatch {
	status?: JobStatus;
	assignee?: string;
	notes?: string;
	addLabels?: readonly string[];
	removeLabels?: readonly string[];
}

function assertLabelValue(value: string, what: string): void {
	if (!LABEL_VALUE_RE.test(value)) {
		throw new LedgerError(
			`${what} ${JSON.stringify(value)} is not a valid label value — use alphanumerics, hyphen or underscore`,
		);
	}
}

function safeUsername(): string {
	try {
		return userInfo().username || "operator";
	} catch {
		return "operator";
	}
}

export function assertScriptIntake(input: Pick<IntakeInput, "scriptPath" | "kind" | "delivery">): void {
	if (input.scriptPath === undefined) return;
	if (input.kind !== "ship" || input.delivery !== "local") throw new LedgerError("script requires kind:ship and delivery:local");
	if (!isSafeScriptPath(input.scriptPath)) throw new LedgerError(`unsafe script path ${JSON.stringify(input.scriptPath)}: use a repository-relative path without traversal or control characters`);
}

export class Ledger {
	readonly home: string;
	readonly file: string;
	readonly #options: LedgerOptions;
	readonly #now: () => Date;
	readonly #actor: string;

	constructor(options: LedgerOptions) {
		this.home = options.home;
		this.file = join(canonicalDir(options.home), LAYOUT.jobsFile);
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#actor = options.actor ?? safeUsername();
	}

	get knownProjects(): readonly string[] | undefined {
		return this.#options.knownProjects;
	}

	/**
	 * The document as it is on disk. Throws `LedgerError` when missing or
	 * invalid. Reads `this.file`, not `jobsFile(this.home)` again — the same
	 * canonicalized path `#mutate` writes and queues on, so a home reached
	 * through a symlink never gets two identities for one document.
	 */
	read(): JobsDocument {
		return readJobsDocumentAt(this.file);
	}

	// -- intake -------------------------------------------------------------

	/** Verification and storage must read the same tracker, never the parent's cwd. */
	normalizeRef(ref: string, project: string): string {
		return normalizeExternalRef(ref.trim(), this.beadsDb(project));
	}

	/** The project's own beads DB (connection or clone-local), or undefined. */
	beadsDb(project: string): string | undefined {
		return this.#options.beadsDbFor?.(project);
	}

	async create(input: IntakeInput): Promise<Job> {
		const prepared = this.#prepare(input);
		const { title, externalRef } = prepared;
		return this.#mutate((doc) => {
			const duplicate = doc.jobs.find((job) => job.status !== "closed" && (
				(externalRef !== undefined && this.#projected(job).external_ref === externalRef) ||
				(parseJobLabels(job.labels).project === input.project && normalizeJobTitle(job.title) === normalizeJobTitle(title))
			));
			if (duplicate && duplicate.script?.path !== input.scriptPath) {
				throw new LedgerError(`${duplicate.id}: action mismatch for duplicate title/ref (existing ${duplicate.script?.path ?? "model"}, requested ${input.scriptPath ?? "model"})`);
			}
			return this.#build(doc, prepared, input);
		});
	}

	/** The job linked to tracker item `(connectionId, itemId)`, in any status, or undefined. */
	findTracked(connectionId: string, itemId: string): Job | undefined {
		const job = this.read().jobs.find((candidate) => candidate.tracker?.connection_id === connectionId && candidate.tracker.item_id === itemId);
		return job ? this.#projected(job) : undefined;
	}

	/**
	 * Exactly one job per `(connection_id, item_id)` across all history (B2): the key
	 * check runs inside the mutation queue, so concurrent calls agree. An open unlinked
	 * job already carrying the same ref is refused, never linked silently. No title dedupe. `deferred` keeps it out of `ready()` (B4).
	 */
	async createTracked(input: IntakeInput & { tracker: { connection_id: string; item_id: string; mandate_id?: string; task_sha256?: string }; deferred?: boolean }): Promise<{ job: Job; created: boolean }> {
		const prepared = this.#prepare(input);
		const { connection_id, item_id } = input.tracker;
		return this.#mutate((doc) => {
			const linked = doc.jobs.find((job) => job.tracker?.connection_id === connection_id && job.tracker.item_id === item_id);
			if (linked) return { job: this.#projected(linked), created: false };
			const unlinked = prepared.externalRef === undefined ? undefined
				: doc.jobs.find((job) => job.status !== "closed" && !job.tracker && this.#projected(job).external_ref === prepared.externalRef);
			if (unlinked) throw new LedgerError(`${unlinked.id} already tracks ${prepared.externalRef} without a tracker link; not linked automatically`);
			return { job: this.#build(doc, prepared, input, { tracker: { ...input.tracker, linked_at: isoTimestamp(this.#now()) }, ...(input.deferred ? { status: "deferred" as const } : {}) }), created: true };
		});
	}

	/** Link an existing job to one tracker item (laf): idempotent; another item, or an item another job links, is refused. */
	async link(id: string, link: { connection_id: string; item_id: string }): Promise<{ job: Job; linked: boolean }> {
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			const same = job.tracker?.connection_id === link.connection_id && job.tracker.item_id === link.item_id;
			if (job.tracker && !same) throw new LedgerError(`${id} is already linked to ${job.tracker.connection_id}/${job.tracker.item_id}`);
			const other = doc.jobs.find((j) => j.id !== id && j.tracker?.connection_id === link.connection_id && j.tracker.item_id === link.item_id);
			if (other) throw new LedgerError(`${other.id} already links ${link.connection_id}/${link.item_id}`);
			if (!same) {
				job.tracker = { connection_id: link.connection_id, item_id: link.item_id, linked_at: isoTimestamp(this.#now()) };
				job.updated_at = job.tracker.linked_at;
			}
			return { job: this.#projected(job), linked: !same };
		});
	}

	/** Intake validation and normalization shared by `create` and `createTracked`. */
	#prepare(input: IntakeInput): { title: string; labels: string[]; externalRef: string | undefined } {
		const title = input.title.trim();
		if (title.length === 0) throw new LedgerError("intake needs a title");
		assertLabelValue(input.project, "project");
		if (!(DELIVERIES as readonly string[]).includes(input.delivery)) {
			throw new LedgerError(`delivery ${JSON.stringify(input.delivery)} must be one of ${DELIVERIES.join("|")}`);
		}
		if (input.kind && !(JOB_KINDS as readonly string[]).includes(input.kind)) {
			throw new LedgerError(`kind ${JSON.stringify(input.kind)} must be one of ${JOB_KINDS.join("|")}`);
		}
		if (input.risk && !(RISKS as readonly string[]).includes(input.risk)) {
			throw new LedgerError(`risk ${JSON.stringify(input.risk)} must be one of ${RISKS.join("|")}`);
		}
		assertScriptIntake(input);
		const known = this.#options.knownProjects;
		if (known && !known.includes(input.project)) {
			throw new LedgerError(
				`unknown project ${JSON.stringify(input.project)} — register it first; known: ${known.join(", ") || "(none)"}`,
			);
		}
		let externalRef = input.externalRef?.trim();
		if (externalRef !== undefined && (externalRef.length === 0 || /[\r\n]/.test(externalRef) || externalRef.length > 1000)) {
			throw new LedgerError(
				`external ref must be one non-empty line (a tracker url, a file path, or the command that shows the issue, e.g. \`br --db /abs/path/.beads/beads.db show <id> --json\`), got ${JSON.stringify(input.externalRef)}`,
			);
		}
		if (externalRef !== undefined) externalRef = this.normalizeRef(externalRef, input.project);
		for (const label of input.labels ?? []) {
			if (label.includes(",") || label.trim().length === 0) throw new LedgerError(`label ${JSON.stringify(label)} may not contain a comma or be empty`);
		}
		const labels = [
			...formatJobLabels({ project: input.project, delivery: input.delivery, ...(input.kind ? { kind: input.kind } : {}), ...(input.risk ? { risk: input.risk } : {}) }),
			...(input.labels ?? []),
		];
		const risks = labels.filter((label) => label.startsWith(LABEL_PREFIX.risk));
		if (risks.length > 1 || risks.some((label) => !(RISKS as readonly string[]).includes(label.slice(LABEL_PREFIX.risk.length)))) {
			throw new LedgerError(`labels ${risks.join(", ")}: a job carries at most one risk:<${RISKS.join("|")}> label`);
		}
		return { title, labels, externalRef };
	}

	/** Mint an id and push the new open job; runs inside `#mutate`. */
	#build(doc: JobsDocument, prepared: { title: string; labels: string[]; externalRef: string | undefined }, input: IntakeInput, extra: Partial<Job> = {}): Job {
		const id = mintJobId(doc.prefix, new Set(doc.jobs.map((job) => job.id)), {
			...(input.slug !== undefined ? { slug: input.slug } : {}),
			...(this.#options.random ? { random: this.#options.random } : {}),
		});
		const at = isoTimestamp(this.#now());
		const job: Job = {
			id,
			title: prepared.title,
			status: "open",
			labels: prepared.labels,
			blocked_by: [],
			comments: [],
			created_at: at,
			updated_at: at,
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.scriptPath !== undefined ? { script: { path: input.scriptPath } } : {}),
			...(prepared.externalRef !== undefined ? { external_ref: prepared.externalRef } : {}),
			...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
			...extra,
		};
		doc.jobs.push(job);
		return job;
	}

	/**
	 * Open job already recorded for this intake: same `external_ref` (after the
	 * same pin as `create`), or same project + normalized title. Closed jobs do
	 * not match — finished work may be filed again. Used by `cp_job create` only;
	 * pipeline/`cp_ask` still mint.
	 */
	findDuplicate(input: Pick<IntakeInput, "title" | "project" | "externalRef">): Job | undefined {
		const titleKey = normalizeJobTitle(input.title);
		if (titleKey.length === 0) return undefined;
		let incomingRef = input.externalRef?.trim();
		if (incomingRef) incomingRef = this.normalizeRef(incomingRef, input.project);
		for (const job of this.read().jobs) {
			if (job.status === "closed") continue;
			const projected = this.#projected(job);
			if (incomingRef && projected.external_ref === incomingRef) return projected;
			if (parseJobLabels(job.labels).project === input.project && normalizeJobTitle(job.title) === titleKey) {
				return projected;
			}
		}
		return undefined;
	}

	// -- queries ------------------------------------------------------------

	async show(id: string): Promise<Job> {
		return this.#projected(this.#require(this.read(), id));
	}

	async list(filter: ListFilter = {}): Promise<Job[]> {
		return filterJobs(this.read(), filter).map((job) => this.#projected(job));
	}

	/** Open, unblocked, not deferred — the only queue dispatch may pull from. */
	async ready(filter: Omit<ListFilter, "status" | "all"> = {}): Promise<Job[]> {
		const doc = this.read();
		return filterJobs(doc, { ...filter, status: "open" })
			.filter((job) => isReady(doc, job))
			.map((job) => this.#projected(job));
	}

	/** Every non-closed job waiting on an unresolved (open or dropped) blocker. */
	async blocked(): Promise<Job[]> {
		const doc = this.read();
		return doc.jobs
			.filter((job) => job.status !== "closed" && openBlockersOf(doc, job.id).length > 0)
			.map((job) => this.#projected(job));
	}

	/** Closed jobs are the job history; newest close first. */
	async history(filter: Omit<ListFilter, "status" | "all"> = {}): Promise<Job[]> {
		return filterJobs(this.read(), { ...filter, status: "closed" })
			.map((job) => this.#projected(job))
			.sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? "") || a.id.localeCompare(b.id));
	}

	/** Unresolved blockers of one job. The fail-closed pre-dispatch check. */
	async blockersOf(id: string): Promise<string[]> {
		return openBlockersOf(this.read(), id);
	}

	/** Dependency records retain status and close reason, including landed history. */
	async dependenciesOf(id: string): Promise<Job[]> {
		const doc = this.read();
		return this.#require(doc, id).blocked_by.map((blocker) => this.#projected(this.#require(doc, blocker)));
	}

	/** Apply a journaled dropped-dependency answer once, atomically with its audit comment. */
	async resolveDroppedDependency(id: string, blockerId: string, answer: "proceed" | "drop" | "reopen", decisionId: string, by: string): Promise<void> {
		await this.#mutate((doc) => {
			const job = this.#require(doc, id);
			const blocker = this.#require(doc, blockerId);
			const marker = `decision ${decisionId}:`;
			if (job.comments.some((comment) => comment.text.startsWith(marker))) return;
			const at = isoTimestamp(this.#now());
			const reason = `${marker} ${answer} ${id} dependency ${blockerId} (${blocker.close_reason ?? blocker.status})`;
			if (job.status !== "closed" && job.blocked_by.includes(blockerId) && wasDropped(blocker)) {
				if (answer === "proceed") job.blocked_by = job.blocked_by.filter((dep) => dep !== blockerId);
				else if (answer === "drop") {
					job.status = "closed";
					job.closed_at = at;
					job.close_reason = `dropped: ${reason}`.slice(0, 2000);
				} else {
					blocker.comments.push({ at, author: by, text: reason });
					blocker.status = "open";
					delete blocker.closed_at;
					delete blocker.close_reason;
					blocker.updated_at = at;
				}
			}
			job.comments.push({ at, author: by, text: reason });
			job.updated_at = at;
		});
	}

	// -- transitions --------------------------------------------------------

	async update(id: string, patch: UpdatePatch): Promise<Job> {
		if (patch.status === "closed") {
			throw new LedgerError(`refusing to set ${id} to closed through update — close it with a reason (close())`);
		}
		if (patch.status !== undefined && !OPEN_JOB_STATUSES.includes(patch.status)) {
			throw new LedgerError(`status ${JSON.stringify(patch.status)} must be one of ${OPEN_JOB_STATUSES.join("|")}`);
		}
		const touches =
			patch.status !== undefined ||
			patch.assignee !== undefined ||
			patch.notes !== undefined ||
			(patch.addLabels?.length ?? 0) > 0 ||
			(patch.removeLabels?.length ?? 0) > 0;
		if (!touches) throw new LedgerError(`update ${id}: nothing to change`);
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			if (patch.status !== undefined) job.status = patch.status;
			if (patch.assignee !== undefined) job.assignee = patch.assignee;
			if (patch.notes !== undefined) job.notes = patch.notes;
			const removed = new Set(patch.removeLabels ?? []);
			job.labels = [...job.labels.filter((label) => !removed.has(label)), ...(patch.addLabels ?? []).filter((label) => !job.labels.includes(label))];
			requireJobLabels(job);
			job.updated_at = isoTimestamp(this.#now());
			return job;
		});
	}

	/** Dispatch claim: in_progress + the worker alias that holds it. Never a deferred job (a B4 import not yet enrolled). */
	async claim(id: string, assignee: string): Promise<Job> {
		if ((await this.show(id)).status === "deferred") throw new LedgerError(`${id} is deferred: run cp_tracker import again to finish enrollment`);
		return this.update(id, { status: "in_progress", assignee });
	}

	/**
	 * Close with a reason. Idempotent for the same reason; a different reason
	 * is refused, because a close is a fact and not an edit.
	 */
	async close(id: string, reason: string): Promise<Job> {
		const trimmed = reason.trim();
		if (trimmed.length === 0) throw new LedgerError(`close ${id}: a reason is required (PR url, artifact, or "dropped: …")`);
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			if (job.status === "closed") {
				if (job.close_reason === trimmed) return job;
				throw new LedgerError(`${id} is already closed (${job.close_reason}) — a close is a fact; reopen it deliberately before closing it for another reason`);
			}
			const at = isoTimestamp(this.#now());
			job.status = "closed";
			job.closed_at = at;
			job.close_reason = trimmed;
			job.updated_at = at;
			return job;
		});
	}

	/** Dropped work is closed with a reason, never deleted. */
	async drop(id: string, reason: string): Promise<Job> {
		const trimmed = reason.trim();
		if (trimmed.length === 0) throw new LedgerError(`drop ${id}: say why it was dropped`);
		return this.close(id, trimmed.startsWith("dropped:") ? trimmed : `dropped: ${trimmed}`);
	}

	/** Blockers and decisions are comments; the job's status does not change. */
	async comment(id: string, text: string): Promise<Job> {
		const trimmed = text.trim();
		if (trimmed.length === 0) throw new LedgerError(`comment ${id}: empty comment`);
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			const at = isoTimestamp(this.#now());
			job.comments.push({ at, author: this.#actor, text: trimmed });
			job.updated_at = at;
			return job;
		});
	}

	// -- dependencies -------------------------------------------------------

	/** `blockedId` cannot start until `blockerId` closes. Refuses self, unknown ids and cycles. */
	async addDep(blockedId: string, blockerId: string): Promise<void> {
		if (blockedId === blockerId) throw new LedgerError(`${blockedId} cannot depend on itself`);
		await this.#mutate((doc) => {
			const blocked = this.#require(doc, blockedId);
			this.#require(doc, blockerId);
			if (blocked.blocked_by.includes(blockerId)) return;
			blocked.blocked_by.push(blockerId);
			const cycle = findDependencyCycle(doc.jobs);
			if (cycle) throw new LedgerError(`refusing dependency ${blockedId} -> ${blockerId}: dependency cycle ${cycle.join(" -> ")}`);
			blocked.updated_at = isoTimestamp(this.#now());
		});
	}

	async removeDep(blockedId: string, blockerId: string): Promise<void> {
		await this.#mutate((doc) => {
			const blocked = this.#require(doc, blockedId);
			if (!blocked.blocked_by.includes(blockerId)) return;
			blocked.blocked_by = blocked.blocked_by.filter((id) => id !== blockerId);
			blocked.updated_at = isoTimestamp(this.#now());
		});
	}

	// -- import -------------------------------------------------------------

	/** Append pre-built records (the `.beads/` importer). A duplicate id refuses the whole batch. */
	async importJobs(jobs: readonly Job[]): Promise<void> {
		await this.#mutate((doc) => {
			const existing = new Set(doc.jobs.map((job) => job.id));
			const duplicates = jobs.filter((job) => existing.has(job.id)).map((job) => job.id);
			if (duplicates.length > 0) throw new LedgerError(`refusing import: already in the ledger: ${duplicates.join(", ")}`);
			doc.jobs.push(...jobs.map((job) => structuredClone(job)));
		});
	}

	// -- internals ----------------------------------------------------------

	#require(doc: JobsDocument, id: string): Job {
		const job = doc.jobs.find((candidate) => candidate.id === id);
		if (!job) throw new LedgerError(`${id}: no such job in ${this.file}`);
		return job;
	}

	/**
	 * The read-time view of a job: an older job stored with a bare `br show
	 * <id> --json` ref (from before this DB was pinned) is shown pinned to the
	 * project's beads DB, exactly as `create()` would store it today, whenever
	 * one resolves. Pure and non-persisting — every query path (`show`, `list`,
	 * `ready`, `blocked`, `history`) computes the same view over whatever is on
	 * disk, so a read never rewrites `updated_at` and an older job reads
	 * correctly through every one of them, not just `show`. A ref that is
	 * already pinned, or for which no DB resolves, passes through unchanged.
	 */
	#projected(job: Job): Job {
		if (!job.external_ref) return job;
		const project = parseJobLabels(job.labels).project;
		const normalized = project ? this.normalizeRef(job.external_ref, project) : job.external_ref;
		return normalized === job.external_ref ? job : { ...job, external_ref: normalized };
	}

	/** Read → mutate a clone → validate → archive retired fields → atomic write, serialized per file. */
	#mutate<T>(fn: (doc: JobsDocument) => T): Promise<T> {
		return queued(this.file, async () => {
			const draft = structuredClone(this.read());
			const out = fn(draft);
			const result = validateJobsDocument(draft);
			if (!result.ok) throw new LedgerError(`refusing to write an invalid jobs document:\n  ${result.errors.join("\n  ")}`);
			// Mandatory and before the write: `this.read()` already dropped the
			// retired fields, so this is the last moment they exist anywhere.
			archiveLegacyJobFields(this.file, legacyArchiveFile(this.home), isoTimestamp(this.#now()));
			try {
				atomicWriteJson(this.file, result.value);
			} catch (error) {
				throw new LedgerError(`could not write ${this.file}: ${(error as Error).message}`);
			}
			return out;
		});
	}
}
