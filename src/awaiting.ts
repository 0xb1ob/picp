/**
 * Awaiting you (cp-av8) — turning the status block's "Awaiting you" table
 * from prose the operator must notice into an answerable, durable surface.
 *
 * The set the operator answers is **three sources merged, not one store**:
 *
 *  - **derived: pending checkpoints** (`state/checkpoints/*.json`) — always
 *    `type: "authorization"`. `CheckpointStore.decide` stays the only writer;
 *    this module never records an authorization, it only reads one. A ship job
 *    can have **two** of these open at once (cp-khf): the pre-implementation
 *    checkpoint and the post-implementation `diff` one a flagged diff review
 *    raises. They are two subjects, two rows and two files — separately
 *    listable, separately answerable, and neither can satisfy the other.
 *  - **derived: finished research with no PR receipt** (`state/fleet.json`,
 *    `phase: "held"`, `kind: "research"`) — `type: "approval"` ("ship, drop or
 *    follow-up?"). A pipeline job that is `escalated` or has `superseded_by`
 *    is not a live ship decision and raises no row.
 *  - **declared: everything else** — persisted in `state/awaiting.json`,
 *    written only through `AwaitingStore`.
 *
 * Deriving the authorization rows instead of duplicating them is the load-
 * bearing decision here: it makes "two records of one human decision"
 * structurally impossible. See docs/contracts.md §Awaiting you.
 *
 * **One decision is one question (cp-80cv).** Two of those sources can describe
 * the same decision: a pipeline's finished research job derives "ship, drop or
 * follow-up?" while the authorization checkpoint minted for its dep-linked ship
 * job asks "authorize <ship-id>?". The checkpoint wins — it is the stronger
 * instrument, with a single writer no model can reach — so the derived research
 * row is suppressed once that ship job has a checkpoint at all, pending or
 * answered (`researchIdsUnderAuthorization`). A standalone research job, and a
 * pipeline that never reached a checkpoint, are untouched. A pipeline that
 * surfaced (`escalated`) or was reanchored (`superseded_by`) is ineligible
 * (`researchApprovalIneligibleReason`) — still held, but not a ship question.
 *
 * Skip records nothing, anywhere — not a file write, not a br write, not a
 * run-log event. An item that is skipped simply stays `state: "open"` and
 * reappears next time the set is rendered or answered.
 *
 * **A derived row is answerable, and the id shown is the id answered.**
 * Derivation is a projection, so a derived row exists nowhere until a human
 * actually answers one; `AwaitingStore.answerResolved` materialises the row
 * *under the very id the operator was shown* and answers it in the same atomic
 * write (`aw-research-<job-id>`), instead of hashing a new one. That identity is
 * the invariant: `/cp-decide aw-research-cp-x ship` must reach the same record
 * the menu offered. An `authorization` row is the one exception and stays a
 * pure read — it resolves through `CheckpointStore.decide` and is never written
 * here, so an authorization still has exactly one record. Once a derived row
 * has been answered, `mergeAwaiting` stops re-deriving it: the stored answer
 * suppresses the projection, which is what makes "answered" stick for a source
 * (a held research job) that has no other place to record one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AnsweredSink } from "./answered.ts";
import { answeredDecision } from "./answered.ts";
import { atomicWriteJson, canonicalDir, queued } from "./json-store.ts";
import {
	AWAITING_DECISION_MAX_CHARS,
	checkpointAwaitingId,
	type CheckpointKind,
	AWAITING_KEEP_ANSWERED,
	AWAITING_SUBJECT_MAX_CHARS,
	AWAITING_MAX_OPTIONS,
	AWAITING_OPTION_MAX_CHARS,
	type AwaitingDeclaredType,
	type AwaitingFile,
	type AwaitingItem,
	type AwaitingState,
	type AwaitingType,
	EMPTY_AWAITING_FILE,
	authorizationTrigger,
	type DecisionBasis,
	type DelegationProvenance,
	isoTimestamp,
	LAYOUT,
	looksLikeAuthorization,
	SCHEMA_VERSION,
	validateAwaitingFile,
} from "./contracts.ts";
import type { Checkpoint, Escalation, PipelineState } from "./contracts.ts";
import type { StatusJob } from "./contracts.ts";
import { isMergeAsk, type MergeAskProbe, type MergeAskVerdict } from "./merge-ask.ts";

export class AwaitingError extends Error {}

/**
 * The two refusals a declared Awaiting-you row can hit, as exported text
 * (cp-nz95). They are exported because the *renderer* has to say them too: a
 * refused row must never appear as an open question, and "it did not appear"
 * is not a message. `cp_status_block` prints these under the table, verbatim,
 * for every row the store would not store.
 */
export const AUTHORIZATION_TYPE_REFUSAL =
	"authorization items are derived from state/checkpoints/*.json, never declared — use cp_pipeline / " +
	"cp_decide instead. Pass this row as type \"approval\" (or \"design\") if it is a decision you are asking for, " +
	"or mint a checkpoint if it is really permission to proceed.";

/**
 * cp-1som: a merge/ship ask that names no job is refused before it is stored.
 *
 * The gate holds such a row back forever and *nothing can ever release it*: the
 * ready facts (branch head, CI runs, review passes) are all resolved through the
 * job's fleet record, and the `cp-ci` watch iterates fleet records too — so a
 * row with no `job_id` is a deferred zombie, printed under the table every turn
 * with a reason no action can change. Refusing it is not an escape hatch in the
 * other direction either: nothing is asked about an unready PR, and the fix is
 * to re-pass the row with the job it concerns.
 */
export const MERGE_ASK_NEEDS_JOB_REFUSAL =
	"a merge/ship ask must name the job it concerns (job_id), because the gate reads its branch head, its CI runs and " +
	"its cp_review passes through that job's fleet record — a row without one can never become askable, and would sit " +
	"deferred forever. Re-pass this row with job_id set, or ask it as a decision that is not about merging a PR.";

/**
 * Why a decision's *wording* was refused, naming the exact phrase that fired
 * and what to write instead. The predicate is deliberately unchanged (the bug
 * was silence, not strictness); only the message is actionable now.
 */
export function authorizationWordingLint(decision: string): string {
	const trigger = authorizationTrigger(decision);
	return (
		`lint: wording${trigger ? ` "${trigger}"` : ""} reads like an authorization request. Prefer a plain choice ` +
		'("Ship cp-x, drop it, or open a follow-up?"); a checkpoint is still the only permission record.'
	);
}


/**
 * A row that was not raised (cp-gmy): the gate said `defer` or `refuse`. It
 * carries the row it stored, so the caller can render a loud notice instead of
 * dropping the ask on the floor.
 */
export class MergeAskDeferredError extends AwaitingError {
	readonly verdict: MergeAskVerdict;
	readonly item: AwaitingItem;
	constructor(item: AwaitingItem, verdict: MergeAskVerdict) {
		super(
			verdict.action === "resolved"
				? // cp-p1sh: not a deferral at all — the question answered itself, so the row
					// is closed and there is nothing for anyone to re-ask.
					`${item.id} was not raised: ${verdict.reason}. The row is closed (withdrawn) rather than asked — the merge it ` +
						"asked about has already happened."
				: `${item.id} was not raised: ${verdict.reason}. It is stored as deferred and will be raised automatically once CI ` +
						"is green on the current head and a cp_review has passed on it — nothing is dropped, and nobody has to re-ask.",
		);
		this.verdict = verdict;
		this.item = item;
	}
}

// ---------------------------------------------------------------------------
// The store — the declared half only
// ---------------------------------------------------------------------------

export interface DeclareInput {
	type: AwaitingDeclaredType;
	decision: string;
	why: string;
	blocks: string;
	job_id?: string;
	options?: string[];
	/**
	 * cp-nx7: what is being decided, when the caller can say it better than the
	 * prose can. Given one, identity is exactly `{job_id,type,subject}` and the
	 * decision text is free to change on every render. Omitted — the normal case
	 * — the subject is derived from the decision (`decisionSubject`).
	 */
	subject?: string;
}

/** What identity is keyed on, as one comparable string. */
type SubjectInput = Pick<DeclareInput, "type" | "decision" | "job_id"> & { subject?: string };

/** What `declareGated` returns: the row, whether it was asked, and why not. */
export interface DeclareOutcome {
	item: AwaitingItem;
	/** True when the row is `open` — i.e. the operator is actually being asked. */
	raised: boolean;
	/** Present only when the merge-ask gate ran (cp-gmy). */
	gate?: MergeAskVerdict;
	/** Wording guidance; never a refusal. */
	lint?: string;
}

export interface ReviewDeferredResult {
	/** Rows promoted to `open` by this review — the ask, finally made. */
	raised: AwaitingItem[];
	stillDeferred: AwaitingItem[];
	/**
	 * cp-to39: rows whose job no longer exists. They stay `deferred` — nothing is
	 * deleted and no answer is touched — but they are never promoted to an ask the
	 * operator cannot act on. The caller renders them as "job <id> is gone —
	 * answer or withdraw" instead of "CI unfinished".
	 */
	orphaned: AwaitingItem[];
	/**
	 * cp-p1sh: rows whose merge has already happened. They are moved to
	 * `withdrawn` — the question resolved itself, so it is closed rather than
	 * asked — and handed back once so the caller can say so under the table.
	 * Only a row that was still `deferred` can land here: an answered row, a
	 * withdrawn row and an authorization projection are never touched.
	 */
	resolved: AwaitingItem[];
	/** The verdict per row id, for the notice the caller renders. */
	verdicts: Map<string, MergeAskVerdict>;
}

/**
 * Words that introduce a *condition* on a decision rather than a new decision.
 * "Merge PR #44 **once** its rebase lands green" and "Merge PR #44 **when** CI
 * goes green on cd178f4" are the same question asked twice, with the facts of
 * the moment attached; the facts are prose, the question is the subject.
 */
const QUALIFIER_CLAUSE =
	/\s+(?:once|when|whenever|while|after|before|until|unless|if|now that|so that|because|pending|as soon as|assuming|provided)\s+/;

/** ` - suffix`, ` — suffix`, ` – suffix`: an aside, never the decision itself. */
const DASH_SUFFIX = /\s+[\u2014\u2013-]{1,2}\s+/;

/** `PR #47`, `pr 47`, `pull request #47`, or a bare `#47`. */
const PR_REFERENCE = /(?:\bpull request\s*#?\s*|\bpr\s*#?\s*|#)(\d+)/;

/**
 * The **subject** of a decision: what is being decided, with the prose that
 * describes it stripped away (cp-nx7).
 *
 * Identity used to be a hash of the decision text, so the parent refining a
 * still-open question — "Merge PR #44 once its rebase lands green" becoming
 * "Merge PR #44 when CI goes green on cd178f4" — minted a second item and asked
 * a human something they had already answered. The wording of an open question
 * changes constantly and legitimately; what is being decided does not.
 *
 * Deterministic and total: parentheticals, a dash-introduced aside and a
 * trailing conditional clause are dropped, a PR reference (`PR #47`, `pr 47`,
 * `pull request #47`, a bare `#47`) is rewritten in place to `pr#<n>` — the
 * verb phrase before it and the object words after it, in the same clause,
 * both survive — and whatever remains is normalised to lowercase
 * alphanumerics. Rewriting only the reference itself (cp-rs1), rather than
 * collapsing to the first word plus the number, is what keeps "Ship PR #44
 * results" and "Ship PR #44 to staging" apart while still folding "Merge PR
 * #44 once ..." and "... when ..." onto one subject: the qualifier clause and
 * dash suffix that differ between those two are stripped before the PR match
 * ever runs. A decision that reduces to nothing keeps its whole normalised
 * text, so this can never map two unrelated questions onto one empty subject.
 */
export function decisionSubject(decision: string): string {
	const full = normaliseSubject(decision);
	let text = decision.trim().toLowerCase();
	text = text.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
	text = text.split(DASH_SUFFIX)[0] ?? text;
	text = text.split(QUALIFIER_CLAUSE)[0] ?? text;
	const pr = text.match(PR_REFERENCE);
	if (pr && typeof pr.index === "number") {
		// Keep the verb phrase before the reference *and* the object words after it
		// within the same clause, so "Ship PR #44 results" and "Ship PR #44 to
		// staging" stay distinct while "Merge PR #44 once ..."/"... when ..." still
		// fold: the qualifier clause and dash suffix that differ between them were
		// already stripped above, before this match ever runs.
		const collapsed = `${text.slice(0, pr.index)}pr#${pr[1]}${text.slice(pr.index + pr[0].length)}`;
		const core = normaliseSubject(collapsed);
		return core.length > 0 ? core : full;
	}
	const core = normaliseSubject(text);
	return core.length > 0 ? core : full;
}

function normaliseSubject(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9#]+/g, " ")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, AWAITING_SUBJECT_MAX_CHARS);
}

/** The identity of a decision: its type, the job it concerns, and its subject. */
export function awaitingSubjectKey(input: SubjectInput): string {
	const explicit = input.subject?.trim();
	const subject = explicit && explicit.length > 0 ? normaliseSubject(explicit) : decisionSubject(stripJobIdMention(input.decision, input.job_id));
	return `${input.job_id ?? ""}|${input.type}|${subject}`;
}

/**
 * Drop a " for <jobId>" token before deriving a subject (cp-rs1). A merge-ask's
 * first rendering ("Merge PR #58 for cp-gmy?") names the job it concerns with
 * no qualifier word to trigger a `QUALIFIER_CLAUSE` split, while a later
 * rendering attaches real facts behind "once"/"when"/"now that" instead and
 * drops the job mention entirely — without this, the two renderings would
 * derive different subjects and mint a second row for a question the operator
 * already answered. The id itself is never lost: it lives in
 * `awaitingSubjectKey`'s own `job_id` component, so dropping the mention here
 * costs nothing.
 *
 * Deliberately narrow: only the `for <jobId>` token itself is removed, never
 * the rest of the string after it. Dropping everything from that point on
 * would re-collapse decisions the PR-reference rewrite above was written to
 * keep apart — "Ship PR #44 for cp-44 results" and "Ship PR #44 for cp-44 to
 * staging" must stay distinct, so only " for cp-44" is cut, leaving "results"
 * and "to staging" as the still-differing object words.
 */
function stripJobIdMention(decision: string, jobId: string | undefined): string {
	const id = jobId?.trim();
	if (!id) return decision;
	const pattern = new RegExp(`\\s+for\\s+${id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
	return decision.replace(pattern, "");
}

/** Stable id for a declared row: same {job_id,type,subject} → same row. */
export function awaitingId(input: SubjectInput): string {
	const hash = createHash("sha1").update(awaitingSubjectKey(input)).digest("hex").slice(0, 10);
	return `aw-${hash}`;
}

/**
 * The subject of a row already on disk. A row written before this contract
 * carries no `subject` field, so its subject is derived from the same prose the
 * id was once hashed from — which is what lets an old answered row still
 * recognise a reworded re-render of itself instead of being asked again.
 */
export function itemSubjectKey(item: Pick<AwaitingItem, "type" | "decision" | "job_id" | "subject">): string {
	return awaitingSubjectKey({
		type: item.type,
		decision: item.decision,
		...(item.job_id ? { job_id: item.job_id } : {}),
		...(item.subject ? { subject: item.subject } : {}),
	});
}

/** State order for the repair below: an answer outranks everything. */
const STATE_RANK: Record<AwaitingState, number> = { answered: 0, withdrawn: 1, open: 2, deferred: 3 };

/**
 * Repair a store that already holds two records under one id (cp-nx7).
 *
 * `state/awaiting.json` is meant to be keyed by id, and for a while it was not:
 * an upsert that did not recognise an answered row appended a second, `open`
 * record under the same id, and from then on every id-keyed operation —
 * `answer`, `withdraw`, `get` — acted on whichever record it happened to find
 * first. The operator's own answer was destroyed that way once.
 *
 * The repair is deterministic and lossless in the direction that matters: for
 * each id, the record that **carries a human's answer** wins, then a withdrawal,
 * then an open row; ties break on the earliest timestamp and finally on the
 * order the file already had, so two runs over the same file always agree.
 * Nothing here writes: the repaired set is what every read returns, and the
 * next write persists it.
 */
export function repairAwaitingItems(items: readonly AwaitingItem[]): { items: AwaitingItem[]; repaired: string[] } {
	const byId = new Map<string, { item: AwaitingItem; index: number }>();
	const order: string[] = [];
	const repaired: string[] = [];
	items.forEach((item, index) => {
		const held = byId.get(item.id);
		if (!held) {
			byId.set(item.id, { item, index });
			order.push(item.id);
			return;
		}
		if (!repaired.includes(item.id)) repaired.push(item.id);
		if (preferredRecord({ item, index }, held)) byId.set(item.id, { item, index });
	});
	return { items: order.map((id) => byId.get(id)!.item), repaired };
}

function preferredRecord(candidate: { item: AwaitingItem; index: number }, held: { item: AwaitingItem; index: number }): boolean {
	const rank = STATE_RANK[candidate.item.state] - STATE_RANK[held.item.state];
	if (rank !== 0) return rank < 0;
	const answered = (candidate.item.answered_at ?? "").localeCompare(held.item.answered_at ?? "");
	if (answered !== 0) return answered < 0;
	const opened = candidate.item.opened_at.localeCompare(held.item.opened_at);
	if (opened !== 0) return opened < 0;
	return candidate.index < held.index;
}

/** Prefixes `deriveFrom*` mint. A derived id is recognisable on sight, which is
 * what lets an error message name the right fix instead of shrugging. */
export const AWAITING_DERIVED_PREFIXES = ["aw-checkpoint-", "aw-research-"] as const;

/**
 * cp-khf: the ship checkpoint's row id is a prefix of nothing and a suffix of
 * nothing — `aw-checkpoint-<id>` and `aw-checkpoint-<id>.diff` are two ids, and
 * `isDerivedAwaitingId` recognises both through the shared prefix above.
 */

export function isDerivedAwaitingId(id: string): boolean {
	return AWAITING_DERIVED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export class AwaitingStore {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	/**
	 * cp-answer-doesnt-wake: told about every answer this store actually records,
	 * so an answered decision can wake the parent instead of sitting in a file.
	 * Injected, never constructed here — this store still knows nothing about pi,
	 * and a home with no sink behaves exactly as it did before.
	 */
	readonly #onAnswered: AnsweredSink | undefined;
	/**
	 * cp-gmy: the CI gate a merge ask must pass before it is raised. Injected,
	 * never constructed here — this store still knows nothing about `gh`, and a
	 * store built without one behaves exactly as it did before (every ask is
	 * raised immediately).
	 */
	readonly #mergeAsk: MergeAskProbe | undefined;

	constructor(options: { home: string; now?: () => Date; onAnswered?: AnsweredSink; mergeAsk?: MergeAskProbe }) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.awaitingFile);
		this.#now = options.now ?? (() => new Date());
		this.#onAnswered = options.onAnswered;
		this.#mergeAsk = options.mergeAsk;
	}

	/**
	 * Report one recorded answer. Best-effort by construction: the answer is
	 * already on disk when this runs, so a sink that throws costs a wake-up, never
	 * a decision.
	 */
	#reportAnswered(item: AwaitingItem, recorded: boolean): void {
		if (!recorded || !this.#onAnswered) return;
		try {
			this.#onAnswered(
				answeredDecision({
					id: item.id,
					type: item.type,
					...(item.job_id ? { job_id: item.job_id } : {}),
					decision: item.decision,
					answer: item.answer ?? "",
					answered_by: item.answered_by ?? "unknown",
					...(item.answered_at ? { answered_at: item.answered_at } : {}),
				}),
			);
		} catch {
			// Delivery is retried from state/answered.json; an unreachable sink must
			// never turn a recorded answer into a failed write.
		}
	}

	read(): AwaitingFile {
		if (!existsSync(this.file)) return EMPTY_AWAITING_FILE;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new AwaitingError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const result = validateAwaitingFile(parsed);
		if (!result.ok) {
			throw new AwaitingError(`${this.file} violates the awaiting contract:\n  ${result.errors.join("\n  ")}`);
		}
		// cp-nx7: one id, one record — enforced on the way *in* as well as on the way
		// out, so a store that already holds a duplicate (this home's own
		// aw-123b695c29, two answered records under one id) can never hand an
		// id-keyed operation an arbitrary one of two. The repair is deterministic and
		// in memory; the next write is what persists it.
		const repaired = repairAwaitingItems(result.value.items);
		if (repaired.repaired.length === 0) return result.value;
		return { ...result.value, items: repaired.items };
	}

	list(state?: AwaitingState): AwaitingItem[] {
		const items = this.read().items;
		return state ? items.filter((item) => item.state === state) : items;
	}

	get(id: string): AwaitingItem | undefined {
		return this.read().items.find((item) => item.id === id);
	}

	async #mutate(mutator: (items: AwaitingItem[]) => AwaitingItem[]): Promise<AwaitingFile> {
		return queued(this.file, async () => {
			const current = this.read();
			const mutated = mutator(structuredClone(current.items));
			// Belt and braces: a mutator that appended a second record under an existing
			// id must never reach the file. The repair is the same deterministic one
			// `read` applies, so "what is written" and "what is read" cannot disagree.
			const items = repairAwaitingItems(mutated).items;
			const next: AwaitingFile = {
				schema_version: SCHEMA_VERSION,
				updated_at: isoTimestamp(this.#now()),
				items,
			};
			const result = validateAwaitingFile(next);
			if (!result.ok) {
				throw new AwaitingError(`refusing to write an invalid awaiting.json:\n  ${result.errors.join("\n  ")}`);
			}
			atomicWriteJson(this.file, result.value);
			return result.value;
		});
	}

	/**
	 * Upsert one declared row, **keyed by subject** (cp-nx7). `authorization` is
	 * refused outright — that type exists only as a derived read. Authorization-
	 * shaped wording is a lint on the tool result, not a refusal.
	 *
	 * Three cases, and only one of them writes a new row:
	 *
	 *  - **no such subject** — a row is created under the subject's id.
	 *  - **an open row with this subject** — updated in place, prose and all. The
	 *    id and `opened_at` never change, so a reworded question stays the same
	 *    question and the operator is asked once.
	 *  - **an answered or withdrawn row with this subject** — returned untouched.
	 *    Re-rendering a decision a human has already answered is *normal* parent
	 *    behaviour under delivery lag, and it must be harmless: it can neither
	 *    reopen the item nor mint a second one.
	 */
	async declare(input: DeclareInput): Promise<AwaitingItem> {
		const outcome = await this.declareGated(input);
		// Loud, never silent: a caller that does not know about the gate gets an
		// error naming the CI state, not an invisible row. The row is already
		// stored `deferred` at this point, so throwing loses nothing.
		if (!outcome.raised && outcome.gate) throw new MergeAskDeferredError(outcome.item, outcome.gate);
		return outcome.item;
	}

	/**
	 * `declare`, with the merge-ask gate's verdict handed back instead of thrown
	 * (cp-gmy). This is what a *render* calls: a deferred ask is a row to report
	 * under the table, not an error to swallow.
	 *
	 * The gate governs **raising a row, never retracting one**. It runs only when
	 * there is no row for this subject yet, or the row is already `deferred`; an
	 * open question stays open even if a new push restarts CI, because withdrawing
	 * a question the operator can already see is its own kind of lost ask.
	 */
	async declareGated(input: DeclareInput): Promise<DeclareOutcome> {
		const gate = await this.#reviewNewAsk(input);
		const item = await this.#upsert(input, gate);
		const lint = looksLikeAuthorization(input.decision) ? authorizationWordingLint(input.decision) : undefined;
		return { item, raised: item.state === "open", ...(gate ? { gate } : {}), ...(lint ? { lint } : {}) };
	}

	/** The gate's verdict for a not-yet-open merge ask, or undefined if it does not apply. */
	async #reviewNewAsk(input: DeclareInput): Promise<MergeAskVerdict | undefined> {
		if (!this.#mergeAsk) return undefined;
		if (!isMergeAsk({ type: input.type, decision: input.decision, ...(input.subject ? { subject: input.subject } : {}), ...(input.job_id ? { job_id: input.job_id } : {}) })) {
			return undefined;
		}
		const existing = this.#find(this.read().items, input);
		if (existing && existing.state !== "deferred") return undefined;
		const gate = await this.#mergeAsk({
			type: input.type,
			decision: input.decision,
			...(input.subject ? { subject: input.subject } : {}),
			...(input.job_id ? { job_id: input.job_id } : {}),
		});
		// cp-to39: `orphaned` answers "this row's job is gone", which is a fact about
		// a row that OUTLIVED its job. A parent asking *now* about a job the fleet has
		// no record of is the ignorance case, not that one — and since cp-1som
		// ignorance defers instead of raising, so the row is stored and printed rather
		// than asked against a head nobody could read. Only `reviewDeferred` acts on
		// the orphaned cause itself.
		if (gate.action === "orphaned" && !existing) {
			return { action: "defer", ci: "unknown", reason: `CI not checked: ${gate.reason}`.slice(0, AWAITING_DECISION_MAX_CHARS) };
		}
		return gate;
	}

	/** Find a row by id or by subject — the two are the same identity (cp-nx7). */
	#find(items: readonly AwaitingItem[], input: DeclareInput): AwaitingItem | undefined {
		const id = awaitingId(input);
		const subject = awaitingSubjectKey(input);
		return items.find((item) => item.id === id || itemSubjectKey(item) === subject);
	}

	async #upsert(input: DeclareInput, gate: MergeAskVerdict | undefined): Promise<AwaitingItem> {
		if ((input.type as string) === "authorization") {
			throw new AwaitingError(AUTHORIZATION_TYPE_REFUSAL);
		}
		// cp-1som: refused at the one choke point every write goes through, so no
		// caller can mint a merge ask that the ready-gate can never release.
		if (!input.job_id && isMergeAsk({ type: input.type, decision: input.decision, ...(input.subject ? { subject: input.subject } : {}) })) {
			throw new AwaitingError(MERGE_ASK_NEEDS_JOB_REFUSAL);
		}
		const id = awaitingId(input);
		const subject = awaitingSubjectKey(input);
		const at = isoTimestamp(this.#now());
		// A gate verdict of `defer`/`refuse` means the row exists but is not asked.
		// `refuse` is stored deferred too: when the red run is replaced by a green
		// one on a later head, the ask appears by itself rather than depending on
		// the parent thinking to re-declare it.
		const deferring = gate !== undefined && gate.action !== "raise";
		// cp-p1sh: `resolved` is terminal, not pending. A merge ask declared for a PR
		// that has already merged is recorded and closed in the same write, so it can
		// never be promoted to an ask about a merge that happened.
		const resolving = gate?.action === "resolved";
		let result: AwaitingItem | undefined;
		await this.#mutate((items) => {
			// By subject, not by id: a row written under the old prose-derived id is
			// still this decision, and must be found rather than duplicated.
			const existing = items.find((item) => item.id === id || itemSubjectKey(item) === subject);
			if (existing && existing.state !== "open" && existing.state !== "deferred") {
				result = existing;
				return items;
			}
			if (existing) {
				existing.decision = input.decision;
				existing.why = input.why;
				existing.blocks = input.blocks;
				if (input.options) existing.options = input.options.slice(0, 6);
				if (input.subject) existing.subject = input.subject.slice(0, AWAITING_SUBJECT_MAX_CHARS);
				// Deferring twice updates one row; it never mints a second (cp-nx7's
				// identity model is exactly what makes that true).
				// Belt and braces on top of the two guards above (`#reviewNewAsk` runs no
				// gate for a settled row, and this method returns one untouched): a
				// terminal cause may only close a row that is still *pending*. A recorded
				// answer is never overwritten by a gate verdict, whatever the verdict is.
				if (resolving && (existing.state === "deferred" || existing.state === "open")) applyResolved(existing, gate!);
				else if (!resolving) applyGate(existing, deferring, gate, at);
				result = existing;
				return items;
			}
			const created: AwaitingItem = {
				schema_version: SCHEMA_VERSION,
				id,
				type: input.type,
				decision: input.decision,
				why: input.why,
				blocks: input.blocks,
				...(input.job_id ? { job_id: input.job_id } : {}),
				...(input.subject ? { subject: input.subject.slice(0, AWAITING_SUBJECT_MAX_CHARS) } : {}),
				...(input.options && input.options.length > 0 ? { options: input.options.slice(0, 6) } : {}),
				state: resolving ? "withdrawn" : deferring ? "deferred" : "open",
				opened_at: at,
				...(resolving
					? { deferred_reason: gate!.reason.slice(0, AWAITING_DECISION_MAX_CHARS) }
					: deferring
						? { deferred_reason: gate!.reason, deferred_at: at }
						: {}),
			};
			result = created;
			return [...items, created];
		});
		if (!result) throw new AwaitingError("declare produced no item");
		return result;
	}

	/**
	 * Re-review every deferred merge ask and raise the ones whose CI has since
	 * finished green (cp-gmy). This is the half of the rule that makes a deferral
	 * safe: it runs on every render of the Awaiting-you set **and on the two
	 * events that can release a deferral** (a `cp-ci` observation, a passing
	 * `cp_review` verdict — `src/deferred-recheck.ts`), needs no operator action
	 * and no parent turn, and turns "asked too early" into "asked once, when it
	 * can be acted on" instead of "never asked".
	 *
	 * With no probe configured nothing is promoted — and nothing is lost either:
	 * a deferred row is still listed by `list("deferred")` and rendered as a
	 * notice, so it can never become invisible.
	 *
	 * cp-to39: a row whose **job is gone** (verdict `orphaned`) is the one case
	 * that is neither promoted nor left saying "CI unfinished". Before this, the
	 * probe's catch-all turned a missing fleet record into `raise`/`unknown`, so a
	 * torn-down job produced a merge ask for a PR the operator could not act on.
	 * Now the row stays `deferred` with a reason naming the job. Nothing is
	 * deleted here, ever: this method only flips `deferred` rows, so an answered
	 * row, a withdrawn row and an authorization projection are untouched.
	 */
	async reviewDeferred(): Promise<ReviewDeferredResult> {
		const deferred = this.list("deferred");
		if (deferred.length === 0 || !this.#mergeAsk) {
			return { raised: [], stillDeferred: deferred, orphaned: [], resolved: [], verdicts: new Map() };
		}
		const verdicts = new Map<string, MergeAskVerdict>();
		for (const item of deferred) {
			verdicts.set(
				item.id,
				await this.#mergeAsk({
					type: item.type,
					decision: item.decision,
					...(item.subject ? { subject: item.subject } : {}),
					...(item.job_id ? { job_id: item.job_id } : {}),
				}),
			);
		}
		const at = isoTimestamp(this.#now());
		const raised: AwaitingItem[] = [];
		const stillDeferred: AwaitingItem[] = [];
		const orphaned: AwaitingItem[] = [];
		const resolved: AwaitingItem[] = [];
		await this.#mutate((items) => {
			for (const item of items) {
				const gate = verdicts.get(item.id);
				// Only a row this review actually gated, and only one still deferred: an
				// answered row, a withdrawn row and an authorization-derived projection
				// (which has no row here at all) are never touched by this pass.
				if (!gate || item.state !== "deferred") continue;
				// cp-to39: the job is gone. Neither raise (an unanswerable ask) nor drop
				// (a lost question): keep the row deferred with a reason that names the
				// job, so `list("deferred")` still hands it to the renderer and the
				// operator can answer or withdraw it.
				if (gate.action === "orphaned") {
					applyGate(item, true, gate, at);
					orphaned.push(item);
					continue;
				}
				// cp-p1sh: the merge this row was waiting on already happened, so there is
				// no decision left to take. Raising it would ask a human to approve a merge
				// whose commit exists (cp-rud / PR #69, cp-n1a / PR #70, both withdrawn by
				// hand); leaving it deferred would say "CI unfinished", which is false. It
				// is closed exactly the way the parent closed it by hand — `withdrawn`, the
				// row kept, no answer invented and no record removed.
				if (gate.action === "resolved") {
					applyResolved(item, gate);
					resolved.push(item);
					continue;
				}
				const promote = gate.action === "raise";
				applyGate(item, !promote, gate, at);
				(promote ? raised : stillDeferred).push(item);
			}
			return items;
		});
		return { raised, stillDeferred, orphaned, resolved, verdicts };
	}

	async declareMany(inputs: DeclareInput[]): Promise<AwaitingItem[]> {
		const results: AwaitingItem[] = [];
		for (const input of inputs) results.push(await this.declare(input));
		return results;
	}

	/**
	 * Record an answer against an existing row. Refuses to overwrite an existing
	 * (different) answer — the same discipline `CheckpointStore.decide` uses —
	 * and prunes answered items to `AWAITING_KEEP_ANSWERED` so the file never
	 * grows without bound.
	 *
	 * A **derived** id has no row until it is answered, so this method refuses it
	 * by name rather than "no such item": use `answerResolved`, which carries the
	 * projected row and materialises it.
	 */
	async answer(
		id: string,
		options: { answer: string; by: string; at?: string; auditRef?: string; basis?: DecisionBasis; provenance?: DelegationProvenance },
	): Promise<AwaitingItem> {
		let result: AwaitingItem | undefined;
		let recorded = false;
		const at = options.at ?? isoTimestamp(this.#now());
		await this.#mutate((items) => {
			if (!items.some((entry) => entry.id === id) && isDerivedAwaitingId(id)) {
				throw new AwaitingError(missingDerivedRowMessage(id));
			}
			const applied = applyAnswer(items, id, { ...options, at });
			result = applied.item;
			recorded = applied.recorded;
			return applied.items;
		});
		if (!result) throw new AwaitingError(`no awaiting item ${id}`);
		this.#reportAnswered(result, recorded);
		return result;
	}

	/**
	 * Answer a row that may not exist on disk yet — the common case, because the
	 * two derived sources (pending checkpoints, held research with no PR) are
	 * projections the parent never writes by hand. The row is materialised under
	 * the **id the operator was shown** and answered in one atomic write, so the
	 * id in the menu, the id in `/cp-decide <id>` and the id in the store are the
	 * same string.
	 *
	 * An `authorization` row is refused outright: it is decided by
	 * `CheckpointStore.decide` and by nothing else, so there is never a second
	 * record of one. A row already present (declared, or a derived row answered
	 * earlier) takes the ordinary `answer` path, including its
	 * answered-once/withdrawn refusals.
	 */
	async answerResolved(
		item: ResolvedAwaitingItem,
		options: { answer: string; by: string; at?: string; auditRef?: string; basis?: DecisionBasis; provenance?: DelegationProvenance },
	): Promise<AwaitingItem> {
		if (item.type === "authorization") {
			throw new AwaitingError(
				`${item.id} is an authorization item: only CheckpointStore.decide records one (/cp-authorize, /cp-decline, or ` +
					"an approve/decline answer in /cp-decide). It is never written to state/awaiting.json.",
			);
		}
		let result: AwaitingItem | undefined;
		let recorded = false;
		const at = options.at ?? isoTimestamp(this.#now());
		await this.#mutate((items) => {
			const present = items.some((entry) => entry.id === item.id);
			const withRow = present ? items : [...items, materialiseDerived(item)];
			const applied = applyAnswer(withRow, item.id, { ...options, at });
			result = applied.item;
			recorded = applied.recorded;
			return applied.items;
		});
		if (!result) throw new AwaitingError(`no awaiting item ${item.id}`);
		this.#reportAnswered(result, recorded);
		return result;
	}

	/**
	 * Withdraw a declared item without an answer (the parent no longer needs it).
	 * An item that already carries a human's answer is refused: `withdraw` once
	 * resolved a duplicated id to the *answered* record and overwrote it, which
	 * destroyed the operator's answer and left the open duplicate looping
	 * (cp-nx7). A recorded answer is never withdrawn.
	 */
	async withdraw(id: string): Promise<AwaitingItem> {
		let result: AwaitingItem | undefined;
		await this.#mutate((items) => {
			const item = items.find((entry) => entry.id === id);
			if (!item) throw new AwaitingError(`no awaiting item ${id}`);
			if (item.state === "answered") {
				throw new AwaitingError(
					`awaiting item ${id} is already answered ("${item.answer}" by ${item.answered_by ?? "?"}) — an answer is never withdrawn`,
				);
			}
			item.state = "withdrawn";
			result = item;
			return items;
		});
		if (!result) throw new AwaitingError(`no awaiting item ${id}`);
		return result;
	}
}

/**
 * The answer semantics, shared by `answer` and `answerResolved` so there is one
 * definition of "an answer is given once" no matter how the row got here.
 * Mutates the (already cloned) array it is given and returns the pruned result.
 */
function applyAnswer(
	items: AwaitingItem[],
	id: string,
	options: { answer: string; by: string; at: string; auditRef?: string; basis?: DecisionBasis; provenance?: DelegationProvenance },
): { items: AwaitingItem[]; item: AwaitingItem; recorded: boolean } {
	const item = items.find((entry) => entry.id === id);
	if (!item) throw new AwaitingError(`no awaiting item ${id}`);
	if (item.state === "answered") {
		// An idempotent repeat records nothing, and so reports nothing: answering
		// twice must not wake the parent twice (cp-answer-doesnt-wake).
		if (item.answer === options.answer) return { items, item, recorded: false };
		throw new AwaitingError(
			`awaiting item ${id} is already answered ("${item.answer}" by ${item.answered_by ?? "?"}); an answer is given once`,
		);
	}
	if (item.state === "withdrawn") {
		throw new AwaitingError(`awaiting item ${id} was withdrawn — nothing to answer`);
	}
	item.state = "answered";
	item.answer = options.answer.slice(0, 1000);
	item.answered_by = options.by;
	item.answered_at = options.at;
	if (options.auditRef) item.audit_ref = options.auditRef;
	if (options.basis) item.basis = options.basis;
	if (options.provenance) Object.assign(item, options.provenance);
	return { items: prune(items), item, recorded: true };
}

function missingDerivedRowMessage(id: string): string {
	return (
		`${id} is a derived Awaiting-you row, so it has no record in state/awaiting.json until it is answered — ` +
		"answer it through /cp-decide (AwaitingStore.answerResolved), which materialises the row under this same id."
	);
}

/**
 * Turn a projected row into a storable one. The **id is verbatim** — never
 * truncated, never re-hashed — because the id the operator was shown is the id
 * that must be answerable. The rendering-bounded prose cells are clipped to the
 * contract's own limits (they are regenerated on every render anyway), while
 * anything the contract genuinely cannot hold — a malformed job id, a missing
 * `opened_at` — fails loudly at the write instead of being silently dropped.
 */
export function materialiseDerived(item: ResolvedAwaitingItem): AwaitingItem {
	if (item.type === "authorization") {
		throw new AwaitingError(`${item.id} is an authorization item and is never stored — CheckpointStore.decide owns it`);
	}
	if (item.type === "escalation") {
		throw new AwaitingError(`${item.id} is an escalation and is never stored here — EscalationStore owns it`);
	}
	return {
		schema_version: SCHEMA_VERSION,
		id: item.id,
		type: item.type,
		decision: item.decision.slice(0, AWAITING_DECISION_MAX_CHARS),
		why: item.why.slice(0, AWAITING_DECISION_MAX_CHARS),
		blocks: item.blocks.slice(0, AWAITING_DECISION_MAX_CHARS),
		...(item.job_id ? { job_id: item.job_id } : {}),
		...(item.options && item.options.length > 0
			? { options: item.options.slice(0, AWAITING_MAX_OPTIONS).map((option) => option.slice(0, AWAITING_OPTION_MAX_CHARS)) }
			: {}),
		state: "open",
		opened_at: item.opened_at,
	};
}

/**
 * Apply one gate verdict to a row (cp-gmy). `opened_at` is deliberately never
 * rewritten: a deferred ask is the same decision as the raised one, so its age
 * is measured from when the decision arose, not from when CI happened to
 * finish.
 */
function applyGate(item: AwaitingItem, deferring: boolean, gate: MergeAskVerdict | undefined, at: string): void {
	if (!gate) return;
	if (deferring) {
		item.state = "deferred";
		item.deferred_reason = gate.reason.slice(0, AWAITING_DECISION_MAX_CHARS);
		item.deferred_at = at;
		return;
	}
	item.state = "open";
	delete item.deferred_reason;
	delete item.deferred_at;
}

/**
 * Close a row whose merge already happened (cp-p1sh). `withdrawn` is the
 * existing state for "the parent no longer needs this decision", and that is
 * exactly what a merged PR makes of its own merge ask: the row is kept (nothing
 * is deleted — `state/awaiting.json` has no journal), no answer is invented on
 * a human's behalf, and the reason is carried on the row so the disposition is
 * readable afterwards rather than living only in one render.
 */
function applyResolved(item: AwaitingItem, gate: MergeAskVerdict): void {
	item.state = "withdrawn";
	item.deferred_reason = gate.reason.slice(0, AWAITING_DECISION_MAX_CHARS);
	delete item.deferred_at;
}

function prune(items: AwaitingItem[]): AwaitingItem[] {
	// A deferred row is pending, not settled: it is kept exactly like an open one.
	const open = items.filter((item) => item.state === "open" || item.state === "deferred");
	const other = items.filter((item) => item.state !== "open" && item.state !== "deferred");
	const answered = other
		.filter((item) => item.state === "answered")
		.sort((a, b) => (a.answered_at ?? "").localeCompare(b.answered_at ?? ""));
	const withdrawn = other.filter((item) => item.state === "withdrawn");
	const keptAnswered = answered.slice(Math.max(0, answered.length - AWAITING_KEEP_ANSWERED));
	return [...open, ...keptAnswered, ...withdrawn];
}

// ---------------------------------------------------------------------------
// Derivation — read-only projections, never a second writer
// ---------------------------------------------------------------------------

export interface ResolvedAwaitingItem {
	id: string;
	type: AwaitingType;
	decision: string;
	why: string;
	blocks: string;
	job_id?: string;
	options?: string[];
	opened_at: string;
	/**
	 * Which checkpoint an `authorization` row is about (cp-khf). Present only on
	 * a checkpoint-derived row, and it is what routes an answer to the store that
	 * owns that question: `ship` to the pre-implementation checkpoint, `diff` to
	 * the post-implementation one a flagged diff review raised, `merge` to the
	 * per-head merge authorization (cp-uug). Absent is read as `"ship"`, so
	 * nothing built before this field changes meaning.
	 */
	checkpoint_kind?: CheckpointKind;
	/**
	 * `merge` rows only (cp-uug): the head sha the authorization is bound to. The
	 * writer needs it to address the right file — a job can hold more than one
	 * merge authorization over its life, and only the head tells them apart.
	 */
	checkpoint_scope?: string;
	/** Present only for a snoozed declared item (this session only). */
	snoozed?: boolean;
	/**
	 * Cheap job metadata already in the status snapshot (cp-7t7): the whitelisted
	 * projection `suggestionInput` may draw from, and nothing more. Present only
	 * for a row derived from a `StatusJob` (`deriveFromHeldResearch`); absent for a
	 * checkpoint-derived or declared row, which carry no such job.
	 */
	title?: string;
	project?: string;
	kind?: string;
	delivery?: string;
}

/**
 * Pending checkpoints become `authorization` rows. Read-only: see file header.
 *
 * `kind` says which of a job's authorizations this batch is (cp-khf; cp-uug
 * added `merge`). A `CheckpointStore` lists exactly one kind, so the caller
 * always knows; the default reproduces every pre-cp-khf call site exactly, and
 * a checkpoint that records its own `kind` overrides the argument — a merged
 * list from more than one store still derives each row correctly.
 *
 * The rows for one job are deliberately different **subjects**, not one subject
 * worded three ways (cp-nx7): different ids, different decision text, different
 * `blocks`. "Act on this plan?" was answered before any code existed; "accept
 * this diff?" is a question about code that now exists; "merge this commit?" is
 * a question about one specific sha. Collapsing them would let one answer
 * satisfy a question nobody was asked.
 */
export function deriveFromCheckpoints(
	pending: readonly Checkpoint[],
	defaultKind: CheckpointKind = "ship",
): ResolvedAwaitingItem[] {
	return pending.map((checkpoint) => {
		const kind: CheckpointKind = checkpoint.kind ?? defaultKind;
		const scope = checkpoint.scope;
		return {
			id: checkpointAwaitingId(checkpoint.job_id, kind, scope),
			type: "authorization" as const,
			decision:
				kind === "merge"
					? `merge ${checkpoint.job_id} at ${(scope ?? "?").slice(0, 12)}?`
					: kind === "final_fix"
						? `one final fix for ${checkpoint.job_id} at capped head ${(scope ?? "?").slice(0, 12)}? (operator text only)`
					: kind === "diff"
						? `accept the diff ${checkpoint.job_id} pushed?`
						: `authorize ${checkpoint.job_id}?`,
			why: checkpoint.question.slice(0, 100),
			blocks:
				kind === "merge" || kind === "final_fix"
					? `${checkpoint.job_id} merge, teardown and close`
					: kind === "diff"
						? `${checkpoint.job_id} completion`
						: `${checkpoint.job_id} implementation`,
			job_id: checkpoint.job_id,
			options: ["approve", "decline"],
			opened_at: checkpoint.requested_at,
			checkpoint_kind: kind,
			...(scope ? { checkpoint_scope: scope } : {}),
		};
	});
}

/** A finished research job with no PR receipt becomes an `approval` row. */
export function deriveFromHeldResearch(jobs: readonly StatusJob[]): ResolvedAwaitingItem[] {
	const rows: ResolvedAwaitingItem[] = [];
	for (const job of jobs) {
		if (job.phase !== "held" || job.kind !== "research") continue;
		// cp-u3o4: a Q&A job (`delivery:answer`) is research by kind, but its result
		// is an answer the operator already read on a card — there is no ship
		// decision to take, so "ship, drop or follow-up?" is a question nobody
		// asked. Escalating from an answer to action is a new job, not this row.
		if (job.delivery === "answer" || job.delivery === "board") continue;
		const hasPr = (job.receipts ?? []).some((receipt) => receipt.kind === "pr");
		if (hasPr) continue;
		rows.push({
			id: `aw-research-${job.job_id}`,
			type: "approval",
			decision: `${job.job_id}: ship, drop or follow-up?`,
			why: "finished research with no ship decision yet",
			blocks: `${job.job_id} follow-on work`,
			job_id: job.job_id,
			options: ["ship", "drop", "follow-up"],
			opened_at: job.timestamp,
			// Already in hand from the status snapshot's own StatusJob — no extra br
			// call, no br show. Only populated when present (a title may be null).
			...(job.title ? { title: job.title } : {}),
			project: job.project,
			kind: job.kind,
			delivery: job.delivery,
		});
	}
	return rows;
}

/**
 * Why a **declared** row is obsolete (cp-f9jh), or undefined if it is not.
 *
 * Declared rows were the one source with no staleness rule. Unasked wake-ups
 * are staleness-checked, and a derived row disappears when its source condition
 * clears (a checkpoint is decided, a PR receipt appears); a declared row
 * persisted until answered or withdrawn, so the operator was asked at 18:52
 * whether to merge a PR that had merged at 18:45.
 *
 * **Obsolete-on-read, from evidence, never from ignorance.** This is a pure
 * predicate over the same fleet snapshot every Awaiting-you surface already
 * reads, so no retire pass can race an answer and nothing is deleted:
 *
 *  - no `job_id` — untouched. There is no job to be obsolete against.
 *  - no job with that id in the snapshot — untouched. A missing record is
 *    ignorance, and silently dropping a still-meaningful decision is worse than
 *    the bug this fixes.
 *  - the job is `done`, or its br issue is closed, or it carries a merged PR
 *    receipt — obsolete. The decision the row asks for has been taken by the
 *    world.
 *
 * Answered and withdrawn rows are unaffected: this is only ever consulted for a
 * row that would otherwise be offered as open.
 */
export function obsoleteDeclaredReason(
	item: Pick<AwaitingItem, "job_id">,
	jobs: readonly StatusJob[],
): string | undefined {
	const jobId = item.job_id;
	if (!jobId) return undefined;
	const job = jobs.find((entry) => entry.job_id === jobId);
	if (!job) return undefined;
	if ((job.receipts ?? []).some((receipt) => receipt.kind === "pr" && receipt.status.toLowerCase() === "merged")) {
		return `${jobId} has a merged PR receipt, so this decision is obsolete — it is not offered as an open question.`;
	}
	if (job.phase === "done") {
		return `${jobId} is already done, so this decision is obsolete — it is not offered as an open question.`;
	}
	if (job.br_status && /^closed/i.test(job.br_status.trim())) {
		return `${jobId} is closed, so this decision is obsolete — it is not offered as an open question.`;
	}
	return undefined;
}

/**
 * Why a held research job is not a live ship/drop/follow-up question (cp-5hqi),
 * or undefined if it still is.
 *
 * Analogous to `obsoleteDeclaredReason`: a pure predicate over facts
 * `mergeAwaiting` already receives, consulted only for rows that would otherwise
 * be offered as open. Fail closed on **evidence**, open on **ignorance** — no
 * pipeline record, or a record still `researching`/`gating` without
 * `superseded_by`, leaves the row untouched.
 */
export function researchApprovalIneligibleReason(
	jobId: string,
	pipelines: readonly PipelineLink[],
): string | undefined {
	if (!jobId) return undefined;
	const record = pipelines.find((link) => link.research_id === jobId);
	if (!record) return undefined;
	if (record.superseded_by) {
		return `${jobId} was reanchored (superseded by ${record.superseded_by}), so this decision is obsolete — it is not offered as an open question.`;
	}
	if (record.state === "escalated") {
		return `${jobId} is escalated, so this decision is obsolete — it is not offered as an open question.`;
	}
	return undefined;
}

export function deriveFromEscalations(open: readonly Escalation[]): ResolvedAwaitingItem[] {
	return open.map((item) => ({
		id: item.id,
		type: "escalation" as const,
		decision: item.question.slice(0, 100),
		why: item.kind,
		blocks: item.job_ids.join(", "),
		job_id: item.job_ids[0],
		options: item.options.map((option) => option.id),
		opened_at: item.created_at,
		...(item.checkpoint_kind ? { checkpoint_kind: item.checkpoint_kind } : {}),
		...(item.checkpoint_scope ? { checkpoint_scope: item.checkpoint_scope } : {}),
	}));
}

function declaredToResolved(item: AwaitingItem, snoozed: ReadonlySet<string>): ResolvedAwaitingItem {
	return {
		id: item.id,
		type: item.type,
		decision: item.decision,
		why: item.why,
		blocks: item.blocks,
		...(item.job_id ? { job_id: item.job_id } : {}),
		...(item.options ? { options: item.options } : {}),
		opened_at: item.opened_at,
		...(snoozed.has(item.id) ? { snoozed: true } : {}),
	};
}

/**
 * The research → ship link of one pipeline, as `mergeAwaiting` needs it
 * (cp-80cv). Structural on purpose: a `PipelineRecord` satisfies it, so the
 * caller passes its records straight through and this module still knows
 * nothing about `src/pipeline.ts`.
 */
export interface PipelineLink {
	research_id: string;
	ship_id: string;
	state?: PipelineState;
	superseded_by?: string;
}

export interface MergeInput {
	checkpoints: readonly Checkpoint[];
	/**
	 * Pending *diff* checkpoints (cp-khf), from the `kind: "diff"` store. A second
	 * list rather than a merged one because a `Checkpoint` record does not say
	 * which question it is — its store does, and the projection must not guess.
	 */
	diffCheckpoints?: readonly Checkpoint[];
	/**
	 * Pending *merge* authorizations (cp-uug), from the `kind: "merge"` store.
	 * One per PR head sha; a `merge` record does carry its own `kind` and
	 * `scope`, but it arrives as its own list for the same reason the diff one
	 * does — the store is what knows, and the projection must not guess.
	 */
	mergeCheckpoints?: readonly Checkpoint[];
	/**
	 * Ship-kind authorizations that are **already answered** (cp-80cv), from the
	 * same `kind: "ship"` store. They render nothing — an answered checkpoint is
	 * not a question — and exist here for one purpose: a pipeline's implement
	 * decision, once a human has taken it at the checkpoint, is not re-asked as
	 * "ship, drop or follow-up?" on the derived row seconds later, in the window
	 * between the answer and the parent tearing the research job down.
	 */
	answeredCheckpoints?: readonly Checkpoint[];
	heldResearch: readonly StatusJob[];
	/**
	 * The pipelines this home knows about (cp-80cv). `{research_id, ship_id}` is
	 * the second way an authorization is recognised as belonging to a research
	 * job; optional `state` / `superseded_by` (present on a `PipelineRecord`) make
	 * escalated or reanchored research ineligible. Omitted, both filters treat
	 * that as ignorance — a standalone row stays.
	 */
	pipelines?: readonly PipelineLink[];
	/** Every stored row, not just the open ones: an answered row under a derived
	 * id is what stops that row being re-derived forever. */
	declared: readonly AwaitingItem[];
	/**
	 * The fleet snapshot (cp-f9jh), used only to drop a **declared** row whose job
	 * is already done/closed/merged. Omitted, no declared row is ever dropped: the
	 * rule fires on evidence, never on its absence.
	 */
	jobs?: readonly StatusJob[];
	/** Declared item ids snoozed for this session only (never persisted). */
	snoozed?: ReadonlySet<string>;
	/** Open structured escalations (autonomy-programme-cur.2.3). */
	escalations?: readonly Escalation[];
}

/**
 * The research jobs whose **one** decision is already being asked as an
 * authorization (cp-80cv).
 *
 * A pipeline's "should this be implemented?" reached the operator twice: as the
 * derived approval row for the finished research job ("cp-uf00: ship, drop or
 * follow-up?") and as the authorization checkpoint minted for its dep-linked
 * ship job ("Authorize implementation of cp-76xa?"). Eighteen seconds apart,
 * one decision, two questions.
 *
 * The checkpoint is the stronger instrument and the one that survives: only
 * `/cp-authorize` / `/cp-decline` (or an approve/decline answer in
 * `/cp-decide`) can answer it, `CheckpointStore.decide` is its single writer,
 * and a model has no path to it at all. So the *derived* row is the one
 * suppressed, for exactly as long as the checkpoint owns that decision: while
 * it is pending **and** once it has been answered, because "decline the
 * implementation" and "drop the research" are the same answer, and re-deriving
 * the row in the seconds between the answer and the parent's teardown would
 * reproduce the very defect (one decision, asked twice) a few seconds later
 * instead of eighteen.
 *
 * Two ways the ship job is recognised as this research job's, both read-only
 * and neither guessing:
 *
 *  - `Checkpoint.research_id`, which `cp_pipeline advance` writes when it mints
 *    the checkpoint — the normal case;
 *  - the pipeline records themselves, for a checkpoint file written before that
 *    field or by another path.
 *
 * **The `ship` checkpoint, and only it.** A `diff` checkpoint ("accept the diff
 * cp-x pushed?") and a `merge` one ("merge cp-x at <sha>?") carry a
 * `research_id` too, and both are questions about code that already exists —
 * not about whether to implement the plan. Reading them here would make the
 * suppression depend on which of a ship job's three authorizations happened to
 * be open, so they are excluded outright: they neither create the suppression
 * nor remove one the ship checkpoint established, and both still render their
 * own rows exactly as cp-khf and cp-uug specify.
 *
 * Nothing else is suppressed by this function: a standalone (non-pipeline)
 * finished research job has no such checkpoint and raises its row exactly as
 * before, and a research job whose pipeline has not reached a checkpoint at all
 * is untouched. Escalated or superseded pipeline research is ineligible
 * separately (`researchApprovalIneligibleReason`).
 */
function researchIdsUnderAuthorization(input: {
	/** Pending **ship** checkpoints whose row is on the table now. */
	asked: readonly Checkpoint[];
	/** Ship ids whose *ship* authorization row is in the rendered set. */
	askedShipIds: ReadonlySet<string>;
	/** Ship-kind checkpoints a human has already answered. */
	answered: readonly Checkpoint[];
	pipelines: readonly PipelineLink[];
}): Set<string> {
	const shipIds = new Set(input.askedShipIds);
	for (const checkpoint of input.answered) shipIds.add(checkpoint.job_id);
	const suppressed = new Set<string>();
	for (const checkpoint of [...input.asked, ...input.answered]) {
		if (!checkpoint.research_id) continue;
		if (!shipIds.has(checkpoint.job_id)) continue;
		suppressed.add(checkpoint.research_id);
	}
	for (const link of input.pipelines) {
		if (shipIds.has(link.ship_id)) suppressed.add(link.research_id);
	}
	return suppressed;
}

/**
 * The merged, render-ready set: authorization first, then oldest-first. A
 * snoozed declared item is still returned (never hidden — a snooze suppresses
 * re-*prompting*, never rendering) with `snoozed: true`.
 *
 * A pipeline research job whose ship job has an authorization checkpoint yields
 * **one** question, not two: the checkpoint (see
 * `researchIdsUnderAuthorization`, cp-80cv). A pipeline that has surfaced
 * (`escalated`) or been reanchored (`superseded_by`) raises no research row
 * (`researchApprovalIneligibleReason`).
 */
export function mergeAwaiting(input: MergeInput): ResolvedAwaitingItem[] {
	const snoozed = input.snoozed ?? new Set<string>();
	// A derived row that has already been answered (materialised under its own id)
	// or withdrawn must not be re-derived: the projection's source (a held research
	// job) has nowhere else to record that a human answered it.
	// Settled means *answered or withdrawn*, never merely deferred: a deferred row
	// is still a question waiting to be asked (cp-gmy).
	const settled = new Set(
		input.declared.filter((item) => item.state === "answered" || item.state === "withdrawn").map((item) => item.id),
	);
	// Every authorization of one ship job is listable at once and separately
	// answerable (cp-khf, cp-uug); none hides another, and oldest-first among them
	// keeps the order deterministic whichever store reported first.
	// The ship rows are kept apart from the other two kinds only because cp-80cv's
	// suppression reads the ship question and nothing else; the rendered set is the
	// same list, sorted the same way.
	const shipRows = deriveFromCheckpoints(input.checkpoints, "ship").filter((row) => !settled.has(row.id));
	const authorization = [
		...shipRows,
		...deriveFromCheckpoints(input.diffCheckpoints ?? [], "diff").filter((row) => !settled.has(row.id)),
		...deriveFromCheckpoints(input.mergeCheckpoints ?? [], "merge").filter((row) => !settled.has(row.id)),
	].sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id));
	// cp-80cv: the derived research row is dropped only when the *same* decision is
	// already on the table as the ship authorization — computed from the rows that
	// survived the filter above, so a settled checkpoint row (one nobody is being
	// asked) can never silence a research row either.
	const askedShipIds = new Set(shipRows.map((row) => row.job_id).filter((id): id is string => Boolean(id)));
	const pipelines = input.pipelines ?? [];
	const underAuthorization = researchIdsUnderAuthorization({
		asked: input.checkpoints,
		askedShipIds,
		answered: input.answeredCheckpoints ?? [],
		pipelines,
	});
	const rest = [
		...deriveFromHeldResearch(input.heldResearch).filter(
			(row) =>
				!settled.has(row.id) &&
				!underAuthorization.has(row.job_id ?? "") &&
				!researchApprovalIneligibleReason(row.job_id ?? "", pipelines),
		),
		...input.declared
			.filter(
				(item) =>
					item.state === "open" &&
					!obsoleteDeclaredReason(item, input.jobs ?? []) &&
					!(item.job_id && researchApprovalIneligibleReason(item.job_id, pipelines)),
			)
			.map((item) => declaredToResolved(item, snoozed)),
		...deriveFromEscalations(input.escalations ?? []).filter((row) => !settled.has(row.id)),
	].sort((a, b) => a.opened_at.localeCompare(b.opened_at));
	return [...authorization, ...rest];
}

/**
 * Declared rows that are **not** among the ones the caller supplied this turn
 * (cp-gmy), compared by subject so a rewording is not a second row.
 *
 * This is what makes a deferred-then-promoted ask appear on a later render with
 * no operator action and no parent action: the row was raised by
 * `reviewDeferred`, and the renderer folds it in even if the model never
 * mentioned it again.
 */
export function awaitingRowsNotSupplied(
	supplied: readonly SubjectInput[],
	items: readonly AwaitingItem[],
): AwaitingItem[] {
	const keys = new Set(supplied.map((row) => awaitingSubjectKey(row)));
	return items.filter((item) => !keys.has(itemSubjectKey(item)));
}

const APPROVE_WORDS = /^(?:approve|approved|yes|y|ok|okay)$/i;
const DECLINE_WORDS = /^(?:decline|declined|no|n)$/i;

/**
 * The one definition of the verdict vocabulary an authorization item answers
 * to, so there is exactly one place that
 * knows what "approve" and "decline" mean; `parseSuggestions` (src/suggest.ts)
 * calls the very same function to filter a generated candidate before it can
 * ever be offered on an authorization row (cp-7t7 invariant 4: a candidate
 * like "approve — the gate passed" does not match and so is never offered,
 * rather than silently becoming an unwritable note).
 */
export function authorizationVerdict(text: string): "approve" | "decline" | undefined {
	const value = text.trim();
	if (APPROVE_WORDS.test(value)) return "approve";
	if (DECLINE_WORDS.test(value)) return "decline";
	return undefined;
}
