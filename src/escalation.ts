/**
 * Escalation store — one schema for "ask the human".
 *
 * Duplicate key is a stable identity (`escalationIdentity`): kind, mandate id,
 * job set and the question's subject \u2014 its text with numbers normalized out
 * when a mandate is named, so live numbers (cost, tokens) refresh the open
 * record (question, options, recommendation, evidence together) instead of
 * minting a second; the exact text with no mandate. A repeated wake-up returns
 * the open record; a different question, under the same grant or another, or
 * with no grant, files as its own record,
 * never merged into an older one. `superseded` closes a record whose mandate was revoked, expired
 * or replaced, with no operator answer. Answer claims the record inside the store's queue and
 * decides a linked checkpoint in that same synchronous step, so a superseded or withdrawn record,
 * or a contrary answer to an answered one, is refused before any linked write; a linked awaiting
 * row converges after the claim. A newly recorded answer wakes the parent (`onAnswered`) unless
 * its linked checkpoint or awaiting row reports it under its own id.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answeredDecision, type AnsweredSink } from "./answered.ts";
import type { AwaitingStore } from "./awaiting.ts";
import { CheckpointStore } from "./checkpoint.ts";
import {
	type Escalation,
	type DecisionBasis,
	type DelegationProvenance,
	type EscalationFile,
	type EscalationKind,
	type EscalationOption,
	EMPTY_ESCALATION_FILE,
	ESCALATION_NO_MANDATE,
	ESCALATION_QUESTION_MAX_CHARS,
	LAYOUT,
	SCHEMA_VERSION,
	type DecisionSummary,
	type GateVerdict,
	isoTimestamp,
	type PlanSummary,
	paths,
	validateEscalation,
	validateEscalationFile,
} from "./contracts.ts";
import { Ledger } from "./ledger.ts";
import { atomicWriteJson, canonicalDir, queued } from "./json-store.ts";

export class EscalationError extends Error {}

export interface RaiseEscalationInput {
	job_ids: string[];
	kind: EscalationKind;
	question: string;
	options: EscalationOption[];
	recommended: string;
	mandate_id?: string;
	mandate_clause?: string;
	evidence_paths?: string[];
	deferred_refs?: string[];
	dropped_dependency?: Escalation["dropped_dependency"];
	checkpoint_job_id?: string;
	checkpoint_kind?: Escalation["checkpoint_kind"];
	checkpoint_scope?: string;
	awaiting_id?: string;
	plan_summary?: PlanSummary;
	decision_summary?: DecisionSummary;
	original_text?: Escalation["original_text"];
	at?: string;
}

export class EscalationStore {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	readonly #checkpoints: (() => CheckpointStore) | undefined;
	readonly #awaiting: (() => AwaitingStore) | undefined;
	readonly #onAnswered: AnsweredSink | undefined;

	constructor(options: {
		home: string;
		now?: () => Date;
		checkpoints?: () => CheckpointStore;
		awaiting?: () => AwaitingStore;
		/** Told about every answer this store newly records that no linked checkpoint or awaiting row reports. */
		onAnswered?: AnsweredSink;
	}) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.escalationsFile);
		this.#now = options.now ?? (() => new Date());
		this.#checkpoints = options.checkpoints;
		this.#awaiting = options.awaiting;
		this.#onAnswered = options.onAnswered;
	}

	read(): EscalationFile {
		if (!existsSync(this.file)) return EMPTY_ESCALATION_FILE;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new EscalationError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const result = validateEscalationFile(parsed);
		if (!result.ok) {
			throw new EscalationError(`${this.file} violates the escalation contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	list(filter?: { jobId?: string; kind?: EscalationKind; status?: Escalation["status"] }): Escalation[] {
		return this.read().items.filter((item) => {
			if (filter?.jobId && !item.job_ids.includes(filter.jobId)) return false;
			if (filter?.kind && item.kind !== filter.kind) return false;
			if (filter?.status && item.status !== filter.status) return false;
			return true;
		});
	}

	get(id: string): Escalation | undefined {
		return this.read().items.find((item) => item.id === id);
	}

	open(): Escalation[] {
		return this.list({ status: "open" });
	}

	/**
	 * `cp_job` intake (pi-command-post-autonomy-programme-cur.4.5): two bad `external_ref`s named in
	 * one mission must read as one open question, not two. If an open record of this `kind` already
	 * anchors on `jobId`, this appends `line` to its question (once) and returns it; a caller that
	 * gets `undefined` back raises fresh instead.
	 */
	async appendToOpenQuestion(jobId: string, kind: EscalationKind, line: string, deferredRef?: string): Promise<Escalation | undefined> {
		let result: Escalation | undefined;
		await this.#mutate((items) => {
			const existing = items.find((item) => item.status === "open" && item.kind === kind && item.job_ids[0] === jobId);
			if (!existing) return items;
			// A deferred ref must be visible in the question the operator answers; overflow gets its own record.
			if (deferredRef !== undefined && !existing.question.includes(line) &&
				existing.question.length + line.length + 2 > ESCALATION_QUESTION_MAX_CHARS) return items;
			if (deferredRef !== undefined) existing.deferred_refs = [...new Set([...(existing.deferred_refs ?? []), deferredRef])];
			if (!existing.question.includes(line)) {
				existing.question = `${existing.question}; ${line}`.slice(0, ESCALATION_QUESTION_MAX_CHARS);
			}
			result = existing;
			return items;
		});
		return result;
	}

	async raise(input: RaiseEscalationInput): Promise<Escalation> {
		if (input.job_ids.length === 0) throw new EscalationError("cp_escalate needs at least one job id");
		if (!input.options.some((option) => option.id === input.recommended)) {
			throw new EscalationError(`recommended option ${input.recommended} is not among the options`);
		}
		const identity = escalationIdentity(input);
		let result: Escalation | undefined;
		await this.#mutate((items) => {
			const existing = items.find((item) => item.status === "open" && escalationIdentity(item) === identity);
			if (existing) {
				// The same subject with fresher numbers: refresh everything the answer is read against, together.
				existing.question = input.question;
				existing.options = input.options;
				existing.recommended = input.recommended;
				existing.evidence_paths = input.evidence_paths ?? existing.evidence_paths;
				if (input.deferred_refs) existing.deferred_refs = input.deferred_refs;
				if (input.mandate_clause?.trim()) existing.mandate_clause = input.mandate_clause.trim();
				if (input.original_text) existing.original_text = input.original_text;
				result = existing;
				return items;
			}
			const at = input.at ?? isoTimestamp(this.#now());
			const created: Escalation = {
				schema_version: SCHEMA_VERSION,
				id: this.#mintId(items),
				job_ids: input.job_ids,
				kind: input.kind,
				question: input.question,
				options: input.options,
				recommended: input.recommended,
				mandate_id: input.mandate_id?.trim() || ESCALATION_NO_MANDATE,
				mandate_clause: input.mandate_clause?.trim() || ESCALATION_NO_MANDATE,
				evidence_paths: input.evidence_paths ?? [],
				...(input.deferred_refs ? { deferred_refs: input.deferred_refs } : {}),
				created_at: at,
				status: "open",
				...(input.dropped_dependency ? { dropped_dependency: input.dropped_dependency } : {}),
				...(input.checkpoint_job_id ? { checkpoint_job_id: input.checkpoint_job_id } : {}),
				...(input.checkpoint_kind ? { checkpoint_kind: input.checkpoint_kind } : {}),
				...(input.checkpoint_scope ? { checkpoint_scope: input.checkpoint_scope } : {}),
				...(input.awaiting_id ? { awaiting_id: input.awaiting_id } : {}),
				...(input.plan_summary ? { plan_summary: input.plan_summary } : {}),
				...(input.decision_summary ? { decision_summary: input.decision_summary } : {}),
				...(input.original_text ? { original_text: input.original_text } : {}),
			};
			const parsed = validateEscalation(created);
			if (!parsed.ok) {
				throw new EscalationError(`refusing to write an invalid escalation:\n  ${parsed.errors.join("\n  ")}`);
			}
			result = parsed.value;
			return [...items, parsed.value];
		});
		if (!result) throw new EscalationError("failed to raise an escalation");
		return result;
	}

	async answer(
		id: string,
		options: {
			answer: string;
			by: string;
			at?: string;
			basis?: DecisionBasis;
			provenance?: DelegationProvenance;
			/**
			 * The caller records this answer synchronously inside the parent's own tool call and reports it
			 * in that result, so this record's own `onAnswered` wake is marked self-answered (`src/answered.ts`,
			 * "Self-answers do not echo"). Never set for an answer that can land outside a parent turn.
			 */
			selfAnswered?: boolean;
		},
	): Promise<Escalation> {
		const at = options.at ?? isoTimestamp(this.#now());
		const existing = this.get(id);
		if (!existing) throw new EscalationError(`no escalation ${id}`);
		if (existing.status === "withdrawn" || existing.status === "superseded") {
			throw new EscalationError(`escalation ${id} was ${existing.status} — nothing to answer`);
		}
		// An identical answer to an answered record is a retry: it skips the preflight below and
		// reaches the queued claim, which returns the record as is, so the awaiting follow-up
		// re-runs and converges one a failure or crash after the claim left unfinished.
		const retry = existing.status === "answered";
		if (retry && existing.answer !== options.answer) {
			throw new EscalationError(
				`escalation ${id} is already answered ("${existing.answer}" by ${existing.answered_by ?? "?"})`,
			);
		}

		if (!retry && existing.dropped_dependency && !["proceed", "drop", "reopen"].includes(options.answer)) {
			throw new EscalationError(`${id}: choose proceed, drop or reopen`);
		}
		const planRevise = existing.kind === "plan_approval" && /^revise\b/i.test(options.answer.trim());
		const decidesCheckpoint = Boolean(existing.checkpoint_job_id) && !planRevise;
		let target: CheckpointStore | undefined;
		if (decidesCheckpoint && !retry) {
			const store = this.#checkpoints?.();
			if (!store) {
				throw new EscalationError(
					`escalation ${id} names checkpoint ${existing.checkpoint_job_id} but no checkpoint store is wired`,
				);
			}
			const kind = existing.checkpoint_kind ?? store.kind;
			target =
				kind === store.kind
					? store
					: new CheckpointStore(this.home, { kind, ...(this.#onAnswered ? { onAnswered: this.#onAnswered } : {}) });
		}

		// Claim inside the queue, and decide a linked checkpoint in that same synchronous step:
		// a supersede, a withdrawal or a contrary answer that won the race is refused before any
		// linked write, so a refused answer has never authorized anything.
		let result: Escalation | undefined;
		let recordedNow = false as boolean;
		await this.#mutate((items) => {
			const item = items.find((entry) => entry.id === id);
			if (!item) throw new EscalationError(`no escalation ${id}`);
			if (item.status === "withdrawn" || item.status === "superseded") {
				throw new EscalationError(`escalation ${id} was ${item.status} — nothing to answer`);
			}
			if (item.status === "answered") {
				if (item.answer !== options.answer) {
					throw new EscalationError(`escalation ${id} is already answered ("${item.answer}" by ${item.answered_by ?? "?"})`);
				}
				result = item;
				return items;
			}
			if (target && item.checkpoint_job_id) {
				target.decide(item.checkpoint_job_id, escalationApproves(options.answer, item), {
					by: options.by,
					...(options.basis ? { basis: options.basis } : {}),
					...(options.provenance ? { provenance: options.provenance } : {}),
					note: options.answer,
					at,
					...(item.checkpoint_scope ? { scope: item.checkpoint_scope } : {}),
				});
			}
			item.status = "answered";
			item.answer = options.answer.slice(0, 1000);
			item.answered_by = options.by;
			if (options.provenance) Object.assign(item, options.provenance);
			if (options.basis) item.basis = options.basis;
			item.answered_at = at;
			result = item;
			recordedNow = true;
			return items;
		});
		if (!result) throw new EscalationError(`no escalation ${id}`);
		const answered: Escalation = result;

		// The record is final; a linked awaiting row converges after it, never authorizes. It runs
		// on an identical retry too (the awaiting store is idempotent for the same answer), so a
		// follow-up that failed after the claim is completed by retrying the answer.
		let awaitingReported = false;
		if (answered.awaiting_id) {
			const awaiting = this.#awaiting?.();
			if (awaiting) {
				try {
					const { selfAnswered: _selfAnswered, ...awaitingOptions } = options;
					await awaiting.answer(answered.awaiting_id, { ...awaitingOptions, at: recordedNow ? at : (answered.answered_at ?? at) });
					awaitingReported = true;
				} catch {
					// Linked awaiting may already be answered or derived; the escalation still journals.
				}
			}
		}
		// Wake before the dependency ledger, so a ledger failure never costs the wake. A linked
		// checkpoint or awaiting row reports under the id the operator saw; otherwise this does.
		if (recordedNow && !decidesCheckpoint && !awaitingReported && this.#onAnswered) {
			try {
				this.#onAnswered(
					answeredDecision({
						id: answered.id,
						type: "escalation",
						job_id: answered.job_ids[0] ?? "",
						decision: answered.question,
						answer: answered.answer ?? options.answer,
						answered_by: options.by,
						answered_at: at,
					}),
					options.selfAnswered ? { selfAnswered: true } : undefined,
				);
			} catch {
				// Delivery is retried from state/answered.json; see src/answered.ts.
			}
		}
		await this.#resolveDependency(answered);
		return answered;
	}

	async #resolveDependency(item: Escalation): Promise<void> {
		const pair = item.dropped_dependency;
		if (!pair) return;
		const answer = item.answer;
		if (answer !== "proceed" && answer !== "drop" && answer !== "reopen") throw new EscalationError(`${item.id}: choose proceed, drop or reopen`);
		await new Ledger({ home: this.home }).resolveDroppedDependency(pair.job_id, pair.blocker_id, answer, item.id, item.answered_by ?? "operator");
	}

	async withdraw(id: string): Promise<Escalation> {
		let result: Escalation | undefined;
		await this.#mutate((items) => {
			const item = items.find((entry) => entry.id === id);
			if (!item) throw new EscalationError(`no escalation ${id}`);
			if (item.status === "answered") {
				throw new EscalationError(`escalation ${id} is already answered — an answer is never withdrawn`);
			}
			if (item.status === "superseded") {
				throw new EscalationError(`escalation ${id} was already superseded — nothing to withdraw`);
			}
			item.status = "withdrawn";
			result = item;
			return items;
		});
		if (!result) throw new EscalationError(`no escalation ${id}`);
		return result;
	}

	/**
	 * Close every open record `reasonFor` names a reason for as `superseded` \u2014 no answer, no linked
	 * checkpoint decided. Synchronous so a mandate write can supersede in the same call: `#write`'s
	 * body has no await, so this can never interleave with a queued mutation in this process. An
	 * answer claims inside such a mutation, so a supersede either lands first (and the answer is
	 * refused) or finds the record already answered (and leaves it): neither overwrites the other.
	 */
	supersede(reasonFor: (item: Escalation) => string | undefined): Escalation[] {
		const closed: Escalation[] = [];
		const at = isoTimestamp(this.#now());
		const items = structuredClone(this.read().items);
		for (const item of items) {
			const reason = item.status === "open" ? reasonFor(item) : undefined;
			if (!reason) continue;
			item.status = "superseded";
			item.superseded_at = at;
			item.superseded_reason = reason.slice(0, 400);
			closed.push(item);
		}
		if (closed.length > 0) this.#write(items);
		return closed;
	}

	async #mutate(mutator: (items: Escalation[]) => Escalation[]): Promise<EscalationFile> {
		return queued(this.file, async () => this.#write(mutator(structuredClone(this.read().items))));
	}

	#write(items: Escalation[]): EscalationFile {
		const next: EscalationFile = { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()), items };
		const result = validateEscalationFile(next);
		if (!result.ok) {
			throw new EscalationError(`refusing to write an invalid escalations.json:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file, result.value);
		return result.value;
	}

	#mintId(items: readonly Escalation[]): string {
		const taken = new Set(items.map((item) => item.id));
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const id = `es-${randomBytes(3).toString("hex")}`;
			if (!taken.has(id)) return id;
		}
		throw new EscalationError("could not mint a unique escalation id");
	}
}

/**
 * What makes two escalations the same question: kind, mandate id, job set and subject. Under a named grant the
 * subject is the question with every number normalized out (its rendered text carries live numbers \u2014 cost,
 * tokens, landed/dropped \u2014 that move between wake-ups), so a USD cap and a token cap on one grant stay two
 * records; with no grant it is the exact question text, so an unrelated question is never swallowed.
 */
export function escalationIdentity(item: Pick<Escalation, "kind" | "job_ids" | "question"> & { mandate_id?: string; dropped_dependency?: Escalation["dropped_dependency"] }): string {
	if (item.dropped_dependency) return JSON.stringify(["dropped_dependency", item.dropped_dependency.job_id, item.dropped_dependency.blocker_id]);
	const mandate = item.mandate_id?.trim() || ESCALATION_NO_MANDATE;
	const jobs = [...item.job_ids].sort().join(",");
	const subject = mandate === ESCALATION_NO_MANDATE ? item.question : item.question.replace(/\d+(?:[.,]\d+)*/g, "#");
	return JSON.stringify([item.kind, jobs, mandate, subject]);
}

const APPROVE_WORDS = /^(?:approve|approved|yes|y|ok|okay)$/i;

export function escalationApproves(answer: string, escalation: Escalation): boolean {
	const value = answer.trim();
	if (APPROVE_WORDS.test(value)) return true;
	if (value === escalation.recommended) return true;
	const option = escalation.options.find((entry) => entry.id === value || entry.label === value);
	if (option && (option.id === "approve" || option.id === escalation.recommended)) return true;
	return false;
}

const GATE_OPTIONS: EscalationOption[] = [
	{
		id: "replan",
		label: "replan",
		consequence: "planner revises against the named reasons",
		cost: "another gate cycle",
	},
	{
		id: "drop",
		label: "drop",
		consequence: "stop this pipeline",
		cost: "sunk research",
	},
	{
		id: "override",
		label: "override",
		consequence: "human accepts the plan anyway",
		cost: "skips gate judgment",
	},
];

export function kindForGate(verdict: GateVerdict): EscalationKind | undefined {
	if (verdict.verdict !== "escalate") return undefined;
	if (verdict.cause === "flagged" || verdict.cause === "operational") return undefined;
	if (verdict.cause === "operational_persistent") return "loop_exhausted";
	if (verdict.cause === "policy") {
		if (verdict.reasons.some((reason) => /cap|revision max|REVIEW_MAX/i.test(reason))) return "loop_exhausted";
		return "conflicting_acceptance";
	}
	return undefined;
}

/** Only the answer to this exact gate attempt can override its judgment; a later artifact needs a new gate. */
export function gateOverride(store: EscalationStore | undefined, verdict: GateVerdict, modifiedAt?: string): Escalation | undefined {
	const kind = kindForGate(verdict);
	if (!kind || !store) return undefined;
	return store.list({ jobId: verdict.job_id, kind, status: "answered" }).find((item) =>
		item.answer?.trim().toLowerCase() === "override" &&
		item.evidence_paths.includes(paths.gateFile(verdict.job_id, verdict.attempt)) &&
		item.answered_at !== undefined && item.answered_at >= verdict.decided_at &&
		(!modifiedAt || modifiedAt <= item.answered_at));
}

/** Gate ladder: escalate/policy (and operational_persistent) mint a record. Duplicate-safe. */
export function raiseForGate(store: EscalationStore, verdict: GateVerdict): Promise<Escalation> | undefined {
	const kind = kindForGate(verdict);
	if (!kind) return undefined;
	return store.raise({
		job_ids: [verdict.job_id],
		kind,
		question: `${verdict.job_id} gate attempt ${verdict.attempt}: escalate (${verdict.cause ?? "policy"}). ${verdict.reasons[0] ?? "the gate surfaced"}`,
		options: GATE_OPTIONS,
		recommended: "replan",
		evidence_paths: [paths.gateFile(verdict.job_id, verdict.attempt)],
	});
}

export function raiseMergeRefused(
	store: EscalationStore,
	input: { jobId: string; prUrl: string; reason: string },
): Promise<Escalation> {
	return store.raise({
		job_ids: [input.jobId],
		kind: "merge_refused",
		question: `${input.jobId}: ${input.prUrl} is ready but GitHub will not take the merge yet — ${input.reason}`,
		options: [
			{
				id: "retry",
				label: "retry when GitHub permits",
				consequence: "call cp_integrate again later",
				cost: "wait",
			},
			{ id: "drop", label: "drop", consequence: "abandon this PR", cost: "sunk implementation" },
		],
		recommended: "retry",
		evidence_paths: [],
	});
}

export const CONFLICTING_REF_OPTIONS: EscalationOption[] = [
	{
		id: "relay",
		label: "relay to the operator",
		consequence: "no job is created for this ref; the operator sees what was actually found",
		cost: "none",
	},
	{
		id: "override",
		label: "override",
		consequence: "retry cp_job create; an answered override admits only the deferred br refs recorded by this check, or use a corrected ref (or none)",
		cost: "risk of dispatching against the wrong issue",
	},
];

/**
 * `cp_job create` intake (pi-command-post-autonomy-programme-cur.4.5): `external_ref` names an
 * issue that turns out to be closed, merged, the wrong kind, or missing. The job is refused, not
 * created, and this raises (or extends) the one `conflicting_acceptance` record so two bad refs
 * named in the same mission read as one question, not two — see `appendToOpenQuestion`.
 */
export async function raiseConflictingRef(
	store: EscalationStore,
	input: { anchorJobId: string; ref: string; found: string; deferredRef?: string },
): Promise<Escalation> {
	const line = `${input.ref}: ${input.found}`;
	const extended = await store.appendToOpenQuestion(input.anchorJobId, "conflicting_acceptance", line, input.deferredRef);
	if (extended) return extended;
	const question = `external_ref check failed — ${line}`;
	return store.raise({
		job_ids: [input.anchorJobId],
		kind: "conflicting_acceptance",
		question: question.slice(0, ESCALATION_QUESTION_MAX_CHARS),
		options: CONFLICTING_REF_OPTIONS,
		recommended: "relay",
		evidence_paths: [],
		...(input.deferredRef !== undefined && question.length <= ESCALATION_QUESTION_MAX_CHARS ? { deferred_refs: [input.deferredRef] } : {}),
	});
}

export const PLAN_APPROVAL_OPTIONS: EscalationOption[] = [
	{ id: "approve", label: "approve", consequence: "dispatch the implementer on this plan", cost: "commits to the plan" },
	{ id: "revise", label: "revise", consequence: "planner updates the artifact; a changed artifact is re-gated", cost: "another gate cycle" },
	{ id: "drop", label: "drop", consequence: "stop this pipeline", cost: "sunk research" },
];

export function raisePlanApproval(
	store: EscalationStore,
	input: {
		researchId: string;
		shipId: string;
		question: string;
		evidence_paths: string[];
		plan_summary?: PlanSummary;
		decision_summary?: DecisionSummary;
		mandate_id?: string;
		mandate_clause?: string;
	},
): Promise<Escalation> {
	return store.raise({
		job_ids: [input.researchId, input.shipId],
		kind: "plan_approval",
		question: input.question,
		options: PLAN_APPROVAL_OPTIONS,
		recommended: "approve",
		evidence_paths: input.evidence_paths,
		checkpoint_job_id: input.shipId,
		checkpoint_kind: "ship",
		...(input.plan_summary ? { plan_summary: input.plan_summary } : {}),
		...(input.decision_summary ? { decision_summary: input.decision_summary } : {}),
		...(input.mandate_id ? { mandate_id: input.mandate_id } : {}),
		...(input.mandate_clause ? { mandate_clause: input.mandate_clause } : {}),
	});
}

export function raiseBudgetExhausted(
	store: EscalationStore,
	input: { jobId: string; question: string; evidence_paths?: string[]; mandate_id?: string; mandate_clause?: string },
): Promise<Escalation> {
	return store.raise({
		job_ids: [input.jobId],
		kind: "budget_exhausted",
		...(input.mandate_id ? { mandate_id: input.mandate_id } : {}),
		...(input.mandate_clause ? { mandate_clause: input.mandate_clause } : {}),
		question: input.question,
		options: [
			{ id: "pause", label: "pause", consequence: "no new dispatch; in-flight continues", cost: "delay" },
			{ id: "raise_cap", label: "raise the cap", consequence: "operator widens the mandate", cost: "more spend" },
		],
		recommended: "pause",
		evidence_paths: input.evidence_paths ?? [],
	});
}

/** A mission-end answer that closes its grant: the `close` option by id or label, any case. */
export function missionEndCloses(escalation: Escalation, answer: string): boolean {
	if (escalation.kind !== "mission_end") return false;
	const value = answer.trim().toLowerCase();
	return escalation.options.some((option) => option.id === "close" && (option.id === value || option.label.toLowerCase() === value));
}

export function raiseMissionEnd(
	store: EscalationStore,
	input: { jobIds: string[]; mandateId: string; summary: string; evidence_paths?: string[] },
): Promise<Escalation> {
	return store.raise({
		job_ids: input.jobIds,
		kind: "mission_end",
		question: `${input.mandateId}: every job it names is closed — ${input.summary}`.slice(0, 1000),
		options: [
			{ id: "close", label: "close the mandate", consequence: "no further auto-dispatch under it", cost: "none" },
			{ id: "extend", label: "extend the mandate", consequence: "operator names more jobs or objective", cost: "another grant" },
		],
		recommended: "close",
		mandate_id: input.mandateId,
		evidence_paths: input.evidence_paths ?? [],
	});
}

/**
 * Risk-high dispatch gate (pi-command-post-autonomy-programme-cur.2.4):
 * `ask_on: [risk:high]` refuses a direct `cp_dispatch` (and a `cp_send`
 * promotion into a ship brief) the same way it already refuses a checkpoint,
 * with exactly one `risk_high_irreversible` escalation naming the job and the
 * risk evidence words routing matched. `approve` is the job-scoped
 * authorization the next `assertDispatchAllowed` call reads; `drop` leaves it
 * refused.
 */
export function raiseRiskHigh(
	store: EscalationStore,
	input: { jobId: string; evidence: readonly string[]; mandateId?: string },
): Promise<Escalation> {
	// An open batch (src/risk-batch.ts) already asks about this job: name it, never mint a duplicate per-job row.
	const batch = store.list({ jobId: input.jobId, kind: "risk_high_irreversible", status: "open" }).find((item) => item.job_ids.length > 1);
	if (batch) return Promise.resolve(batch);
	const words = input.evidence.length > 0 ? input.evidence.join("; ") : "risk:high";
	return store.raise({
		...(input.mandateId ? { mandate_id: input.mandateId, mandate_clause: `${input.mandateId}: ask_on includes risk:high` } : {}),
		job_ids: [input.jobId],
		kind: "risk_high_irreversible",
		question: `${input.jobId}: risk:high under ask_on \u2014 refused before dispatch (${words})`.slice(0, 1000),
		options: [
			{ id: "approve", label: "approve", consequence: "cp_dispatch (or the cp_send promotion) proceeds for this job", cost: "operator accepts the risk" },
			{ id: "drop", label: "drop", consequence: "the job is not dispatched", cost: "sunk planning" },
		],
		recommended: "drop",
		evidence_paths: [],
	});
}

export function raiseLoopExhausted(
	store: EscalationStore,
	input: { jobId: string; question: string; evidence_paths?: string[] },
): Promise<Escalation> {
	return store.raise({
		job_ids: [input.jobId],
		kind: "loop_exhausted",
		question: input.question,
		options: [
			{ id: "stop", label: "stop", consequence: "tear down; do not retry", cost: "sunk work" },
			{ id: "retry", label: "retry once", consequence: "one more bounded attempt", cost: "another cycle" },
		],
		recommended: "stop",
		evidence_paths: input.evidence_paths ?? [],
	});
}
