/** Answers the human asked for and schedule result cards, shown on the dashboard; never authority, never pushed. */
import { createHash, randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import { isoTimestamp, validate } from "./contracts.ts";
import { redactSecrets } from "./decision-context.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { appendAnswerLine } from "./viewer/control-audit.ts";
import { ANSWER_EVIDENCE_MAX, ANSWER_PROJECT_MAX, ANSWER_QUESTION_MAX, ANSWER_TEXT_MAX, type AnswerLine, type AnswerSource, type RecordedAnswer, readAnswers } from "./viewer/control-files.ts";

/** Redact every text; one still secret-shaped afterwards refuses the whole answer, by pattern name. */
function cleanAnswerTexts(texts: readonly string[]): string[] {
	const cleaned = texts.map((text) => redactSecrets(text));
	for (const text of cleaned) {
		const hit = SECRET_PATTERNS.find((pattern) => pattern.re.test(text));
		if (hit) throw new Error(`answer refused: secret-shaped text (${hit.name}) remains after redaction; remove it`);
	}
	return cleaned;
}

const Text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, pattern: "\\S", ...(description ? { description } : {}) });
export const OperatorAnswerInputSchema = Type.Object({
	project: Text(ANSWER_PROJECT_MAX),
	question: Text(16_000),
	answer: Text(ANSWER_TEXT_MAX, "the full answer, plain text; its first paragraph is the short answer"),
	evidence_paths: Type.Optional(Type.Array(Text(1000), { maxItems: ANSWER_EVIDENCE_MAX })),
	job_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" })),
}, { additionalProperties: false });
export type OperatorAnswerInput = Static<typeof OperatorAnswerInputSchema>;

/** What the bridge reads off a fleet record. Only `kind`, `project` and `phase` are checked; `delivery` is for the refusal text. */
export interface AnswerJobFacts { project: string; kind: string; delivery: string; phase: string }

/** A relayed wake-up or a decision reply is not a question the human asked. */
const NOT_A_QUESTION = /^\s*(?:\[cp-(?:bridge|dashboard)\b|ask-[a-f0-9]+:)/;

export class OperatorAnswers {
	readonly #stateDir: string;
	readonly #jobs: (id: string) => AnswerJobFacts | undefined;
	readonly #now: () => Date;

	constructor(stateDir: string, options: { jobs?: (id: string) => AnswerJobFacts | undefined; now?: () => Date } = {}) {
		this.#stateDir = stateDir;
		this.#jobs = options.jobs ?? (() => undefined);
		this.#now = options.now ?? (() => new Date());
	}

	post(input: OperatorAnswerInput): { state: "posted" | "duplicate"; answer: RecordedAnswer } {
		const checked = validate<OperatorAnswerInput>(OperatorAnswerInputSchema, input);
		if (!checked.ok) throw new Error(`invalid operator answer: ${JSON.stringify(checked.errors)}`);
		const { project, job_id: jobId } = checked.value;
		if (NOT_A_QUESTION.test(checked.value.question)) throw new Error("answer refused: the question is a relay or a decision reply, not a question the human asked");
		const [question, answer, ...evidence] = cleanAnswerTexts([checked.value.question, checked.value.answer, ...(checked.value.evidence_paths ?? [])]);
		if (jobId !== undefined) this.#checkJob(jobId, project);
		const known = this.list();
		const first = jobId === undefined ? undefined : known.find((item) => item.job_id === jobId);
		if (first) return { state: "duplicate", answer: first };
		return this.#append({ by: "bridge", id: `ans-${randomBytes(6).toString("hex")}`, project, question: question!, answer: answer!, evidence_paths: evidence, job_id: jobId ?? null });
	}

	/**
	 * A schedule run's result card: an internal producer, never an operator question. The id derives from
	 * `source.source_key`, so a retry after a crash (journal written, delivery not yet recorded) returns the first card.
	 */
	postScheduleResult(input: { project: string; title: string; text: string; evidence_paths: string[]; job_id: string | null; source: AnswerSource }): { state: "posted" | "duplicate"; answer: RecordedAnswer } {
		const id = `ans-${createHash("sha256").update(input.source.source_key).digest("hex").slice(0, 12)}`;
		const known = this.list();
		const first = known.find((item) => item.id === id) ?? (input.job_id === null ? undefined : known.find((item) => item.job_id === input.job_id));
		if (first) return { state: "duplicate", answer: first };
		const [question, answer, ...evidence] = cleanAnswerTexts([input.title, input.text.slice(0, ANSWER_TEXT_MAX), ...input.evidence_paths.slice(0, ANSWER_EVIDENCE_MAX)]);
		return this.#append({ by: "schedule", id, project: input.project.slice(0, ANSWER_PROJECT_MAX), question: question!, answer: answer!, evidence_paths: evidence, job_id: input.job_id, source: input.source });
	}

	#append(row: Omit<RecordedAnswer, "posted_at" | "acked_at" | "acked_peer"> & { by: "bridge" | "schedule" }): { state: "posted"; answer: RecordedAnswer } {
		const { by, ...answer } = row;
		const at = isoTimestamp(this.#now());
		const question = answer.question.length > ANSWER_QUESTION_MAX ? `${answer.question.slice(0, ANSWER_QUESTION_MAX - 1)}\u2026` : answer.question;
		const written = appendAnswerLine(this.#stateDir, { type: "posted", by, at, ...answer, question } as AnswerLine);
		if (!written.ok) throw new Error(`answers journal unwritable: ${written.error}`);
		return { state: "posted", answer: { ...answer, question, posted_at: at, acked_at: null, acked_peer: null } };
	}

	list(): RecordedAnswer[] {
		const read = readAnswers(this.#stateDir);
		if (read.error) throw new Error(`answers journal unreadable: ${read.error}`);
		return read.answers;
	}

	open(): RecordedAnswer[] { return this.list().filter((item) => item.acked_at === null); }

	/** A landed kind:research job of the same project, any delivery (local, answer, board, pipeline, pr). */
	#checkJob(id: string, project: string): void {
		const job = this.#jobs(id);
		if (!job) throw new Error(`unknown job ${id}`);
		if (job.kind !== "research") throw new Error(`${id} is a ${job.kind} job (delivery ${job.delivery}); answers name kind:research landings only, any delivery (local, answer, board, pipeline, pr)`);
		if (job.project !== project) throw new Error(`${id} belongs to ${job.project}, not ${project}`);
		if (job.phase !== "held" && job.phase !== "done") throw new Error(`${id} has not landed (phase ${job.phase}); post after its envelope`);
	}
}
