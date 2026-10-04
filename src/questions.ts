/**
 * Operator questions (T31) — a planner may ask the human, off the parent's
 * context.
 *
 * A worker in RPC mode that calls `ctx.ui.select` makes pi emit an
 * `extension_ui_request` on the worker's stdout (docs/rpc.md, "Extension UI
 * Protocol"). `WorkerProcess` intercepts those. Until T31 it answered every one
 * with `cancelled: true`, because a worker has no operator behind it. This
 * module is what makes an exception safe:
 *
 *   worker dialog request → policy → journal → the real operator → journal →
 *   `extension_ui_response`
 *
 * Four properties, all enforced here rather than remembered:
 *
 *  - **Context integrity.** Neither the question nor the answer passes through
 *    the parent's LLM context. The relay is code driven by an RPC event; the
 *    operator answers a TUI dialog (`ctx.ui.*`, which pi never models); the
 *    exchange lands in `questions.jsonl` and the run log. The parent model can
 *    learn *that* a job asked something — never what, unless a human retells it.
 *  - **Fail closed.** No operator, wrong role, cap reached, deadline passed, or
 *    an asker that throws: the answer is "no answer", exactly as before T31. The
 *    worker's brief already knows that path — list it as an unknown and report.
 *  - **Bounded.** Caps on length, options and count come from the contract; the
 *    deadline means a human is never load-bearing for a worker's liveness.
 *  - **An answer is not an authorization.** A question that reads like a
 *    permission request is refused with the reason, and the worker is pointed at
 *    the checkpoint, which only `/cp-authorize` or `/cp-decline` can answer.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	isoTimestamp,
	looksLikeAuthorization,
	paths,
	QUESTION_ANSWER_MAX_CHARS,
	QUESTION_DEFAULT_TIMEOUT_MS,
	QUESTION_MAX_CHARS,
	QUESTION_MAX_OPTIONS,
	QUESTION_MAX_PER_JOB,
	QUESTION_METHODS,
	QUESTION_OPTION_MAX_CHARS,
	type QuestionMethod,
	type QuestionOutcome,
	type QuestionRecord,
	type Role,
	REVIEW_DIALOG_TITLE,
	SCHEMA_VERSION,
	validateQuestionRecord,
} from "./contracts.ts";

export class QuestionError extends Error {}

/** Roles that may ask. A planner reads and plans; asking is part of planning. */
export const ASKING_ROLES: readonly Role[] = Object.freeze(["planner"]);

/** The dialog methods a worker may use. `editor` is not a question. */
export const ASKABLE_METHODS: readonly QuestionMethod[] = QUESTION_METHODS;
export type AskableMethod = QuestionMethod;

/** A dialog request as it arrived from the worker (docs/rpc.md §Extension UI). */
export interface DialogRequest {
	id: string;
	method: string;
	title?: string;
	message?: string;
	placeholder?: string;
	options?: unknown;
	timeout?: number;
	/**
	 * Aborted when the asking worker's close is OBSERVED (cp-xbxz,
	 * `WorkerProcess`). Hand it to `ctx.ui.*` so the operator's dialog closes
	 * with the worker, and see `QuestionRelay.handle` for why the relay races it
	 * rather than trusting the asker to honour it.
	 */
	signal?: AbortSignal;
}

/**
 * A `report_result` review arrives as an `input` dialog titled
 * `REVIEW_DIALOG_TITLE` with the envelope summary as its placeholder (pi's
 * `ctx.ui.input(title, placeholder)` has no message slot). Normalised here,
 * once, so policy and journal see `method: "review"` and the summary as the
 * question. Anything else passes through untouched.
 */
export function normaliseReviewRequest(request: DialogRequest): DialogRequest {
	if (request.title !== REVIEW_DIALOG_TITLE) return request;
	const { title: _sentinel, placeholder, ...rest } = request;
	return { ...rest, method: "review", message: (placeholder ?? "").trim() || "review" };
}

/** What we write back over the worker's stdin. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

/** Who the question goes to. The extension implements this with `ctx.ui`. */
export interface Asker {
	/**
	 * Put the question in front of a human. Return `undefined` for "no answer"
	 * (dismissed, timed out, nobody there) — never a fabricated one.
	 */
	ask(question: OperatorQuestion): Promise<OperatorAnswer | undefined>;
}

export interface OperatorQuestion {
	job_id: string;
	role: Role;
	method: AskableMethod;
	question: string;
	options?: string[];
	/** Deadline for the dialog, in ms. The asker must honour it. */
	timeout_ms: number;
	/**
	 * Aborted when the asking worker dies (cp-xbxz). An asker with a real UI
	 * passes it to `ctx.ui.select`/`ctx.ui.input` as `{ signal }`, so the dialog
	 * in front of the operator closes with the worker instead of standing there
	 * asking a question that can no longer be delivered.
	 */
	signal?: AbortSignal;
}

export interface OperatorAnswer {
	/** Free text, or the chosen option, or "yes"/"no" for a confirm. */
	answer: string;
	/** A human, named: "operator dialog", "operator command", never a model. */
	by: string;
}

/**
 * The `ctx.ui.*` options for one question: pi's `ExtensionUIDialogOptions`,
 * built in one place so "the dialog carries the worker's life" is a testable
 * fact rather than a line of prose in an extension.
 *
 * `timeout` is T31's, unchanged. `signal` is present only when the transport
 * gave us one, so a pi build with no `signal` key is never handed an unknown
 * option — and if a build accepts the key and ignores it, the dialog simply
 * lives out its `timeout` as it did before cp-xbxz: the relay races the same
 * signal itself (`QuestionRelay.handle`), so the exchange still closes
 * `worker_exited` and a late answer is still dropped rather than journaled. The
 * signal makes the operator's dialog *disappear*; it is never what makes the
 * journal honest.
 */
export function dialogOptions(question: OperatorQuestion): { timeout: number; signal?: AbortSignal } {
	return {
		timeout: question.timeout_ms,
		...(question.signal ? { signal: question.signal } : {}),
	};
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/**
 * Append-only reader/writer for `state/runs/<job-id>/questions.jsonl`.
 *
 * Append-only on purpose: an exchange is a thing that happened. A question that
 * nobody answered stays in the file as `timeout`, which is how "we asked" stops
 * being an inference from silence.
 */
export class QuestionStore {
	readonly #home: string;

	constructor(home: string) {
		this.#home = home;
	}

	file(jobId: string): string {
		return join(this.#home, paths.questionsFile(jobId));
	}

	/** Every exchange for a job, in order. Malformed lines are skipped, not thrown. */
	list(jobId: string): QuestionRecord[] {
		const file = this.file(jobId);
		if (!existsSync(file)) return [];
		const records: QuestionRecord[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				const parsed = validateQuestionRecord(JSON.parse(trimmed));
				if (parsed.ok) records.push(parsed.value);
			} catch {
				// A torn last line is not worth failing a job over.
			}
		}
		return records;
	}

	/**
	 * How many exchanges this job has, refusals included: the complete count.
	 *
	 * Exchanges, not lines: one question writes an `asked` line and a `closed`
	 * line under the same `seq`, so counting lines would halve the cap and charge
	 * an answered question twice.
	 *
	 * This is the numbering authority (`seq` is `count + 1`) and the number an
	 * operator sees. The **cap** is decided on `spent()` instead — see there for
	 * why the two are deliberately different numbers.
	 */
	count(jobId: string): number {
		return new Set(this.list(jobId).map((record) => record.seq)).size;
	}

	/** Exchanges that count against `QUESTION_MAX_PER_JOB`. A refused `review` spends none: it never interrupted anyone. */
	spent(jobId: string): number {
		const records = this.list(jobId);
		const free = new Set(records.filter((record) => record.method === "review").map((record) => record.seq));
		return new Set(records.map((record) => record.seq).filter((seq) => !free.has(seq))).size;
	}

	/**
	 * The exchange still waiting for a human, if there is one. An exchange is
	 * open until a line with its `seq` carries `closed_at` — the `asked` line
	 * itself never gets rewritten, so "has no closed_at" is not the question.
	 */
	open(jobId: string): QuestionRecord | undefined {
		const records = this.list(jobId);
		const closed = new Set(records.filter((record) => record.closed_at !== undefined).map((record) => record.seq));
		return records.find((record) => !closed.has(record.seq));
	}

	append(record: QuestionRecord): QuestionRecord {
		const validated = validateQuestionRecord(record);
		if (!validated.ok) {
			throw new QuestionError(`invalid question record: ${validated.errors.join("; ")}`);
		}
		const file = this.file(record.job_id);
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(validated.value)}\n`);
		return validated.value;
	}
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface AskDecision {
	allowed: boolean;
	/** Present when refused: the worker is told this verbatim. */
	reason?: string;
	/** The normalised question, capped and trimmed. */
	question?: string;
	options?: string[];
	method?: AskableMethod;
}

export interface AskPolicyInput {
	role?: Role;
	request: DialogRequest;
	/** Questions already spent on this job. */
	spent: number;
	/** False when the parent has no human attached. */
	hasOperator: boolean;
	maxPerJob?: number;
}

/**
 * May this dialog reach a human? Pure, so every branch is testable without a
 * worker, a UI or a model.
 */
export function decideAsk(input: AskPolicyInput): AskDecision {
	const method = String(input.request.method) as AskableMethod;
	if (!(ASKABLE_METHODS as readonly string[]).includes(method)) {
		return { allowed: false, reason: `${input.request.method} is not a question a worker may ask` };
	}
	if (!input.role || !ASKING_ROLES.includes(input.role)) {
		return {
			allowed: false,
			reason: `a ${input.role ?? "unknown"} does not ask the operator: only ${ASKING_ROLES.join(", ")} may. Do the job you were briefed on, or report blocked with what you need.`,
		};
	}
	if (!input.hasOperator) {
		return { allowed: false, reason: "no operator is attached to this command post" };
	}
	if (method === "review") {
		return {
			allowed: false,
			reason: "a plan review is a decision (escalation or cp_decide), not a dialog; the envelope is filed as-is",
		};
	}
	const max = input.maxPerJob ?? QUESTION_MAX_PER_JOB;
	if (input.spent >= max) {
		return {
			allowed: false,
			reason: `this job has already asked ${input.spent} question(s) (cap ${max}). Put the rest in Unknowns/Blockers and report.`,
		};
	}
	const raw = `${input.request.title ?? ""}${input.request.message ? `\n${input.request.message}` : ""}`.trim();
	if (raw.length === 0) {
		return { allowed: false, reason: "an empty question cannot be answered" };
	}
	if (looksLikeAuthorization(raw)) {
		return {
			allowed: false,
			reason:
				"that is an authorization request, not a question. A dialog is not a checkpoint: only the operator's " +
				"cp_decide can approve work. Ask what to build, never whether you may ship.",
		};
	}
	const question = raw.slice(0, QUESTION_MAX_CHARS);
	const options = normaliseOptions(input.request.options);
	if (method === "select" && (!options || options.length === 0)) {
		return { allowed: false, reason: "a select with no options is not answerable" };
	}
	return { allowed: true, question, method, ...(options ? { options } : {}) };
}

function normaliseOptions(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const options = value
		.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
		.slice(0, QUESTION_MAX_OPTIONS)
		.map((option) => option.trim().slice(0, QUESTION_OPTION_MAX_CHARS));
	return options.length > 0 ? options : undefined;
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

export interface QuestionRelayOptions {
	home: string;
	asker?: Asker;
	onEvent?: (jobId: string, kind: "question_asked" | "question_closed", payload: Record<string, unknown>) => void;
	timeoutMs?: number;
	maxPerJob?: number;
	now?: () => Date;
}

export interface RelayInput {
	jobId: string;
	role?: Role;
	request: DialogRequest;
	signal?: AbortSignal;
}

export interface RelayResult {
	answer: DialogAnswer;
	outcome: QuestionOutcome;
	record?: QuestionRecord;
}

export type HandleResult = RelayResult;

export class QuestionRelay {
	readonly store: QuestionStore;
	readonly #options: QuestionRelayOptions;
	constructor(options: QuestionRelayOptions) {
		this.#options = options;
		this.store = new QuestionStore(options.home);
	}

	/** A human is reachable only through the dialog asker. Absent means fail closed. */
	get hasOperator(): boolean {
		return this.#options.asker !== undefined;
	}

	/**
	 * Handle one worker dialog request. Never throws: a relay that throws would
	 * leave a worker blocked forever, so every failure becomes "no answer".
	 *
	 * **A worker that dies mid-question closes it `worker_exited`, never
	 * `answered`** (cp-xbxz). The signal the transport hands down is *raced*, not
	 * merely forwarded: an asker that ignores it cannot make this hang, and an
	 * answer that arrives after the worker is gone is dropped rather than
	 * journaled — an answer nobody received must not read like one that landed.
	 */
	async handle(input: RelayInput): Promise<HandleResult> {
		const request = normaliseReviewRequest(input.request);
		const signal = input.signal ?? request.signal;
		const decision = decideAsk({
			...(input.role ? { role: input.role } : {}),
			request,
			spent: this.store.spent(input.jobId),
			hasOperator: this.hasOperator,
			...(this.#options.maxPerJob !== undefined ? { maxPerJob: this.#options.maxPerJob } : {}),
		});
		const at = isoTimestamp(this.#now());

		if (!decision.allowed || !decision.question || !decision.method) {
			// A refusal is still an exchange: it is journaled with its reason, so
			// "the worker tried to ask" is never invisible. `no_operator` is kept
			// distinct from `refused` because one is an environment fact and the
			// other is a policy decision.
			const outcome: QuestionOutcome = this.hasOperator ? "refused" : "no_operator";
			const record = this.#journal({
				jobId: input.jobId,
				role: input.role,
				method: (ASKABLE_METHODS as readonly string[]).includes(String(request.method))
					? (request.method as AskableMethod)
					: "input",
				dialogId: request.id,
				question: truncate(
					`${request.title ?? ""}${request.message ? `\n${request.message}` : ""}`.trim() ||
						"(empty question)",
					QUESTION_MAX_CHARS,
				),
				askedAt: at,
				closedAt: at,
				outcome,
				...(decision.reason ? { reason: decision.reason } : {}),
			});
			return { answer: { cancelled: true }, outcome, ...(record ? { record } : {}) };
		}

		const asked = this.#journal({
			jobId: input.jobId,
			role: input.role,
			method: decision.method,
			dialogId: request.id,
			question: decision.question,
			...(decision.options ? { options: decision.options } : {}),
			askedAt: at,
			outcome: "timeout", // provisional: overwritten by the closing line
		});
		this.#options.onEvent?.(input.jobId, "question_asked", {
			seq: asked?.seq,
			method: decision.method,
			// The question text stays out of the run log's payload only if we put it
			// there; we do put it there on purpose — events.jsonl is the operator's
			// history, and `/watch` renders it in code rather than modelling it.
			question: decision.question,
			...(decision.options ? { options: decision.options } : {}),
		});

		const timeoutMs = this.#options.timeoutMs ?? QUESTION_DEFAULT_TIMEOUT_MS;
		let answer: OperatorAnswer | undefined;
		let outcome: QuestionOutcome = "cancelled";
		try {
			// A worker already gone is never a question put in front of a human.
			if (!signal?.aborted) {
				const asked = this.#options.asker?.ask({
					job_id: input.jobId,
					role: input.role as Role,
					method: decision.method,
					question: decision.question,
					...(decision.options ? { options: decision.options } : {}),
					timeout_ms: timeoutMs,
					...(signal ? { signal } : {}),
				});
				answer = signal ? await raceAbort(asked, signal) : await asked;
			}
			outcome = answer ? "answered" : "cancelled";
		} catch {
			// An asker that fails is not a worker's problem to solve.
			outcome = "cancelled";
		}
		if (signal?.aborted) {
			// The worker is gone. Whatever the asker did or did not produce, nobody
			// received it: the exchange closes as its own outcome, with no `answer`
			// field at all, so the journal cannot be read as "the operator answered".
			answer = undefined;
			outcome = "worker_exited";
		}

		const closedAt = isoTimestamp(this.#now());
		const closed = this.#journal({
			jobId: input.jobId,
			role: input.role,
			method: decision.method,
			dialogId: request.id,
			question: decision.question,
			...(decision.options ? { options: decision.options } : {}),
			askedAt: at,
			closedAt,
			outcome,
			...(answer ? { answer: truncate(answer.answer, QUESTION_ANSWER_MAX_CHARS), answeredBy: answer.by } : {}),
			seq: asked?.seq,
		});
		this.#options.onEvent?.(input.jobId, "question_closed", {
			seq: closed?.seq ?? asked?.seq,
			outcome,
			...(answer ? { answered_by: answer.by } : {}),
		});

		if (!answer) return { answer: { cancelled: true }, outcome, ...(closed ? { record: closed } : {}) };
		return {
			answer:
				decision.method === "confirm"
					? { confirmed: CONFIRMED.test(answer.answer.trim()) }
					: { value: truncate(answer.answer, QUESTION_ANSWER_MAX_CHARS) },
			outcome,
			...(closed ? { record: closed } : {}),
		};
	}

	#journal(input: {
		jobId: string;
		role?: Role;
		method: AskableMethod;
		dialogId: string;
		question: string;
		options?: string[];
		askedAt: string;
		closedAt?: string;
		outcome: QuestionOutcome;
		answer?: string;
		answeredBy?: string;
		reason?: string;
		seq?: number;
	}): QuestionRecord | undefined {
		const record: QuestionRecord = {
			schema_version: SCHEMA_VERSION,
			job_id: input.jobId,
			seq: input.seq ?? this.store.count(input.jobId) + 1,
			dialog_id: input.dialogId,
			// A dialog from a worker whose role we somehow do not know is journaled
			// as what it was: the refusal above has already stopped it.
			role: input.role ?? "planner",
			method: input.method,
			question: input.question,
			...(input.options ? { options: input.options } : {}),
			asked_at: input.askedAt,
			...(input.closedAt ? { closed_at: input.closedAt } : {}),
			outcome: input.outcome,
			...(input.answer !== undefined ? { answer: input.answer } : {}),
			...(input.answeredBy ? { answered_by: input.answeredBy } : {}),
			...(input.reason ? { reason: input.reason } : {}),
		};
		try {
			return this.store.append(record);
		} catch {
			// Journaling must not be able to break a worker. The relay's own answer
			// is still delivered; the loss is visibility, and it is bounded.
			return undefined;
		}
	}

	#now(): Date {
		return this.#options.now?.() ?? new Date();
	}
}

/**
 * The asker's answer, or `undefined` the moment `signal` aborts.
 *
 * Deliberately does not reject: the caller distinguishes "no answer" from
 * "worker gone" by reading `signal.aborted` afterwards, which is true whether
 * the abort won the race or arrived while the asker was still resolving.
 */
async function raceAbort(
	asked: Promise<OperatorAnswer | undefined> | undefined,
	signal: AbortSignal,
): Promise<OperatorAnswer | undefined> {
	if (asked === undefined || signal.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			asked,
			new Promise<undefined>((resolve) => {
				onAbort = () => resolve(undefined);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** What an operator's words mean for a `confirm`. Shared by both modes. */
const CONFIRMED = /^(?:y|yes|true|ok|confirm(?:ed)?)$/i;

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

