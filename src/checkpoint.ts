/**
 * Checkpoints — journaled human authorization.
 *
 * Ported rule, in one line: **evidence is not authorization.** A gate pass says
 * the plan is good; a checkpoint says a person agreed to act on it. The two are
 * different facts and they are stored separately.
 *
 * The discipline (pi-dynamic-workflows' `checkpoint()`):
 *
 *  - the record is written `pending` **before** anyone is asked, so a crash
 *    mid-question leaves an unanswered question, never a silent yes;
 *  - `decide()` is the only writer of an answer, and it refuses to overwrite
 *    one — an authorization is given once and stays on the record;
 *  - `decided_by` names who answered: `mandate:<id>`, `operator-quote` or `operator-delegated`.
 *    A model has no free-text path; `cp_decide` cites a re-evaluated mandate
 *    or a verbatim operator quote.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answeredDecision, type AnsweredSink } from "./answered.ts";
import {
	type Checkpoint,
	type DecisionBasis,
	type DelegationProvenance,
	checkpointAwaitingId,
	type CheckpointKind,
	CheckpointSchema,
	isoTimestamp,
	parseCheckpointFileName,
	LAYOUT, paths,
	SCHEMA_VERSION,
	validate,
} from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export class CheckpointError extends Error {}

export interface CheckpointRequest {
	/** The job being authorized (the ship job in a pipeline). */
	jobId: string;
	researchId?: string;
	question: string;
	/** Headline evidence only — never an artifact body. */
	evidence?: string[];
	at?: string;
	/** `merge` only: the head sha this authorization is bound to (cp-uug). */
	scope?: string;
	/** `final_fix` only: the PR this authorization is bound to (jje.3). */
	prUrl?: string;
}

/**
 * Addressing *within* one store's kind: which file is meant. Only a `merge`
 * store needs it — a ship or diff checkpoint has exactly one file per job,
 * while a merge authorization has one per head sha it approves.
 */
export interface CheckpointAddress {
	scope?: string;
}

export interface CheckpointStoreOptions {
	/**
	 * cp-answer-doesnt-wake: told about every authorization this store actually
	 * records, so a human's approval wakes the parent instead of leaving an
	 * approved pipeline stalled. Injected; a store with no sink behaves exactly as
	 * it did before, and `decide` remains the only writer either way.
	 */
	onAnswered?: AnsweredSink;
	/**
	 * Which of a job's authorizations this store reads and writes
	 * (cp-diffgate-redo-hxb, Stage D; cp-uug for `merge`). The default `"ship"`
	 * is the pre-implementation checkpoint every existing caller means. `"diff"`
	 * is the second, post-implementation one, and `"merge"` is the per-PR,
	 * per-head merge authorization. Each lives in its own file for one reason:
	 * `decide()` refuses to overwrite an answer, so two questions sharing one
	 * record would make the second unanswerable and let it silently inherit the
	 * first answer.
	 */
	kind?: CheckpointKind;
}

export class CheckpointStore {
	readonly home: string;
	readonly kind: CheckpointKind;
	readonly #onAnswered: AnsweredSink | undefined;

	constructor(home: string, options: CheckpointStoreOptions = {}) {
		this.home = home;
		this.kind = options.kind ?? "ship";
		this.#onAnswered = options.onAnswered;
	}

	file(jobId: string, target: CheckpointAddress = {}): string {
		return join(this.home, paths.checkpointFile(jobId, this.kind, target.scope));
	}

	get(jobId: string, target: CheckpointAddress = {}): Checkpoint | undefined {
		const file = this.file(jobId, target);
		if (!existsSync(file)) return undefined;
		const parsed = validate<Checkpoint>(CheckpointSchema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok) {
			throw new CheckpointError(`${file} violates the checkpoint contract:\n  ${parsed.errors.join("\n  ")}`);
		}
		return parsed.value;
	}

	/** Ask. Idempotent: an existing question (answered or not) is returned as is. */
	request(request: CheckpointRequest): Checkpoint {
		const target: CheckpointAddress = request.scope ? { scope: request.scope } : {};
		const existing = this.get(request.jobId, target);
		if (existing) return existing;
		const checkpoint: Checkpoint = {
			schema_version: SCHEMA_VERSION,
			job_id: request.jobId,
			// Written for every kind but `ship`, so a record made before this field
			// existed still validates and still reads as the pre-implementation
			// checkpoint it was.
			...(this.kind === "ship" ? {} : { kind: this.kind }),
			...(request.scope ? { scope: request.scope.trim().toLowerCase() } : {}),
			...(request.researchId ? { research_id: request.researchId } : {}),
			...(request.prUrl ? { pr_url: request.prUrl } : {}),
			question: request.question,
			...(request.evidence && request.evidence.length > 0 ? { evidence: request.evidence.slice(0, 20) } : {}),
			requested_at: request.at ?? isoTimestamp(),
			decision: "pending",
		};
		return this.#write(checkpoint, target);
	}

	/** Answer. Refuses to overwrite an answer, and refuses an unasked question. */
	decide(
		jobId: string,
		approved: boolean,
		options: { by: string; note?: string; at?: string; scope?: string; basis?: DecisionBasis; provenance?: DelegationProvenance },
	): Checkpoint {
		const target: CheckpointAddress = options.scope ? { scope: options.scope } : {};
		const existing = this.get(jobId, target);
		if (!existing) {
			throw new CheckpointError(
				`no checkpoint for ${jobId} — nothing was asked, so there is nothing to authorize`,
			);
		}
		if (existing.decision !== "pending") {
			if (existing.decision === (approved ? "approved" : "declined")) return existing;
			throw new CheckpointError(
				`checkpoint for ${jobId} is already ${existing.decision} (by ${existing.decided_by ?? "?"} at ${existing.decided_at ?? "?"}). ` +
					"An authorization is given once; open a new job if the decision changed.",
			);
		}
		const by = options.by.trim();
		if (by.length === 0) throw new CheckpointError(`checkpoint for ${jobId}: the answer must say who gave it`);
		// jje.3: the one final fix at the review cap is approved on an operator quote only, whatever the surface.
		if (this.kind === "final_fix" && approved && !(options.basis && "operator_quote" in options.basis)) {
			throw new CheckpointError(
				`the final fix for ${jobId} is approved only with an operator quote: answer it with cp_decide (basis operator_quote). Nothing was written.`,
			);
		}
		const decided = this.#write(
			{
				...existing,
				decision: approved ? "approved" : "declined",
				decided_at: options.at ?? isoTimestamp(),
				decided_by: by,
				...options.provenance,
				...(options.note ? { note: options.note } : {}),
				...(options.basis ? { basis: options.basis } : {}),
			},
			target,
		);
		// Only a *newly* recorded decision is reported: the idempotent repeat above
		// returns early, so answering twice never wakes the parent twice. The
		// authorization itself is already on disk, so a sink that throws costs a
		// wake-up and never a decision.
		if (this.#onAnswered) {
			try {
				this.#onAnswered(
					answeredDecision({
						// The id the operator was shown for this row (src/awaiting.ts'
						// deriveFromCheckpoints), so one decision has one identity across
						// the menu, the store and the wake-up. Kind-aware since cp-khf: a
						// diff answer must never resolve the pre-implementation row — and
						// since cp-uug, a merge answer names the head it authorized.
						id: checkpointAwaitingId(decided.job_id, this.kind, decided.scope),
						type: "authorization",
						job_id: decided.job_id,
						decision: decided.question,
						answer: decided.decision,
						answered_by: decided.decided_by ?? by,
						...(decided.decided_at ? { answered_at: decided.decided_at } : {}),
					}),
				);
			} catch {
				// Delivery is retried from state/answered.json; see src/answered.ts.
			}
		}
		return decided;
	}

	/**
	 * Every checkpoint still `pending`, oldest requested first. Used to derive
	 * the `authorization` rows of Awaiting-you (cp-av8) — a read-only projection,
	 * never a second writer: `decide()` remains the only way an authorization is
	 * recorded. Unparseable files are skipped, not thrown, the same discipline
	 * `QuestionStore.list` uses for a torn line.
	 */
	listPending(): Checkpoint[] {
		return this.list().filter((checkpoint) => checkpoint.decision === "pending");
	}

	/**
	 * Every checkpoint of this kind, whatever its decision, oldest requested
	 * first (cp-80cv). Read-only like `listPending`, which is now a filter over
	 * it, so there is one directory walk and one skip-the-corrupt-file rule.
	 *
	 * An *answered* checkpoint is not a question and renders nothing. It is read
	 * for one thing: Awaiting-you must not re-derive a pipeline research job's
	 * "ship, drop or follow-up?" row after a human already answered that same
	 * decision at the checkpoint (src/awaiting.ts, `mergeAwaiting`).
	 */
	list(): Checkpoint[] {
		const dir = join(this.home, LAYOUT.checkpoints);
		if (!existsSync(dir)) return [];
		const all: Checkpoint[] = [];
		for (const entry of readdirSync(dir)) {
			// One store lists one kind. The file name is parsed rather than
			// prefix-stripped (cp-uug): a job id can hold no dot, so `<id>.diff.json`
			// and `<id>.merge-<sha>.json` decompose exactly, and no store can report
			// another kind's checkpoint under a job id that was never a job id.
			const parsed = parseCheckpointFileName(entry);
			if (!parsed || parsed.kind !== this.kind) continue;
			try {
				const checkpoint = this.get(parsed.jobId, parsed.scope ? { scope: parsed.scope } : {});
				if (checkpoint) all.push(checkpoint);
			} catch {
				// A corrupt checkpoint file is not worth failing the whole read over;
				// `get()` on that one id will still throw when it matters.
			}
		}
		all.sort((a, b) => a.requested_at.localeCompare(b.requested_at));
		return all;
	}

	/** Fail-closed read used before anything irreversible happens. */
	requireApproved(jobId: string, target: CheckpointAddress = {}): Checkpoint {
		const checkpoint = this.get(jobId, target);
		const what = target.scope ? `${jobId} at ${target.scope}` : jobId;
		if (!checkpoint) {
			throw new CheckpointError(`${what} has no checkpoint — a human has not authorized this job`);
		}
		if (checkpoint.decision !== "approved") {
			throw new CheckpointError(
				`${what} is ${checkpoint.decision}, not approved — evidence is not authorization`,
			);
		}
		return checkpoint;
	}

	#write(checkpoint: Checkpoint, target: CheckpointAddress = {}): Checkpoint {
		const parsed = validate<Checkpoint>(CheckpointSchema, checkpoint);
		if (!parsed.ok) {
			throw new CheckpointError(`refusing to write an invalid checkpoint:\n  ${parsed.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file(checkpoint.job_id, target), checkpoint);
		return parsed.value;
	}
}
