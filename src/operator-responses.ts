/**
 * Final answers the human asked for and schedule run results (M2 PR2): inline when short, a permanent response report
 * when long (src/response-reports.ts). No pending list, no acknowledgement; never authority, never pushed.
 */
import { Type, type Static } from "typebox";
import { isoTimestamp, validate } from "./contracts.ts";
import { answerMigrationGate } from "./migrate-answer-reports.ts";
import { deliverFinalAnswer, type FinalAnswerDelivery, type FinalAnswerInput, RESPONSE_REPORT_MAX_BYTES, type ReportUrlOptions } from "./response-reports.ts";

const Text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, pattern: "\\S", ...(description ? { description } : {}) });
export const OperatorAnswerInputSchema = Type.Object({
	project: Text(120),
	question: Text(16_000),
	answer: Text(RESPONSE_REPORT_MAX_BYTES, "the full answer, plain text; its first paragraph is the short answer"),
	evidence_paths: Type.Optional(Type.Array(Text(1000), { maxItems: 10 })),
	job_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" })),
}, { additionalProperties: false });
export type OperatorAnswerInput = Static<typeof OperatorAnswerInputSchema>;

/** What the bridge reads off a fleet record. Only `kind`, `project` and `phase` are checked; `delivery` is for the refusal text. */
export interface AnswerJobFacts { project: string; kind: string; delivery: string; phase: string }

/** `cp_parent answer`'s details: the pre-M2 state/id/job_id/project plus delivery, the text to reply with, and the url. */
export interface OperatorAnswerResult {
	state: "inline" | "posted" | "duplicate"; id: string | null; job_id: string | null; project: string;
	delivery: "inline" | "report"; text: string; url: string | null;
}

export interface ScheduleResultInput { project: string; title: string; text: string; evidence_paths: string[]; job_id: string | null; source_key: string; at: string }

/** A relayed wake-up or a decision reply is not a question the human asked. */
const NOT_A_QUESTION = /^\s*(?:\[cp-(?:bridge|dashboard)\b|ask-[a-f0-9]+:)/;

export class OperatorResponses {
	readonly #home: string;
	readonly #jobs: (id: string) => AnswerJobFacts | undefined;
	readonly #now: () => Date;
	readonly #url: ReportUrlOptions;

	constructor(home: string, options: { jobs?: (id: string) => AnswerJobFacts | undefined; now?: () => Date; url?: ReportUrlOptions } = {}) {
		this.#home = home;
		this.#jobs = options.jobs ?? (() => undefined);
		this.#now = options.now ?? (() => new Date());
		this.#url = options.url ?? {};
	}

	/** `chatSource` names this tool call (`chat:<session>:<call>`); a job-bound answer uses the job's stable source instead. */
	post(input: OperatorAnswerInput, chatSource: string): OperatorAnswerResult {
		const checked = validate<OperatorAnswerInput>(OperatorAnswerInputSchema, input);
		if (!checked.ok) throw new Error(`invalid operator answer: ${JSON.stringify(checked.errors)}`);
		const { project, question, answer, evidence_paths: evidence = [], job_id: jobId } = checked.value;
		if (NOT_A_QUESTION.test(question)) throw new Error("answer refused: the question is a relay or a decision reply, not a question the human asked");
		if (jobId !== undefined) this.#checkJob(jobId, project);
		const sent = this.#deliver({ project, question, answer, evidence, job: jobId ?? null, source: jobId ? `research:${jobId}` : chatSource, time: isoTimestamp(this.#now()) });
		return { state: sent.state, id: sent.delivery === "report" ? sent.slug : null, job_id: jobId ?? null, project, delivery: sent.delivery, text: sent.text, url: sent.url };
	}

	/** A schedule run's result: `source_key` and the result's own time keep a retry on the same report. */
	postScheduleResult(input: ScheduleResultInput): FinalAnswerDelivery {
		return this.#deliver({ project: input.project, question: input.title, answer: input.text, evidence: input.evidence_paths, job: input.job_id, source: `schedule:${input.source_key}`, time: input.at });
	}

	#deliver(input: FinalAnswerInput): FinalAnswerDelivery {
		answerMigrationGate(this.#home);
		return deliverFinalAnswer(this.#home, input, this.#url);
	}

	/** A landed kind:research job of the same project, any delivery (local, answer, board, pipeline, pr). */
	#checkJob(id: string, project: string): void {
		const job = this.#jobs(id);
		if (!job) throw new Error(`unknown job ${id}`);
		if (job.kind !== "research") throw new Error(`${id} is a ${job.kind} job (delivery ${job.delivery}); answers name kind:research landings only, any delivery (local, answer, board, pipeline, pr)`);
		if (job.project !== project) throw new Error(`${id} belongs to ${job.project}, not ${project}`);
		if (job.phase !== "held" && job.phase !== "done") throw new Error(`${id} has not landed (phase ${job.phase}); post after its envelope`);
	}
}

/** The tool text: what to reply to the human with, never a pending card. */
export function operatorAnswerText(result: OperatorAnswerResult): string {
	if (result.delivery === "inline") return "answer: short enough to stay inline; reply with the answer itself (nothing was published)";
	const what = result.state === "duplicate" ? `already published at ${result.url}; nothing written` : `published as a permanent report at ${result.url}`;
	return `answer: ${what}. Reply to the human with exactly this:\n${result.text}`;
}
