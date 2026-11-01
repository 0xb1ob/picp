/**
 * The answer card (cp-u3o4) — pure policy and the one bounded file read.
 *
 * A Q&A job (`kind:research` + `delivery:answer`) writes its answer to the
 * ordinary artifact path, and the operator reads it as a **card in the main
 * TUI transcript** — never by opening a plan. This module owns everything
 * about that card that is not pi: the capped read, the header line, the
 * collapsed/expanded body selection and the degrade line for a file that is no
 * longer there.
 *
 * Import discipline, deliberately close to `plan-view.ts`: `node:*`, `./contracts.ts` and, for the M2 PR2 report
 * routing, `./response-reports.ts`. No pi import, no TUI import, so nothing here can append an entry, send a message
 * or return a tool result — the answer body goes to the renderer's terminal output or into a permanent report.
 *
 * The read is at **render** time, from the path the entry points at. The entry
 * itself stores a pointer (job id, project, path, bytes, headline), so the
 * answer body is never persisted into the session file and never becomes part
 * of anything the model is handed (custom entries do not participate in LLM
 * context — docs/extensions.md).
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { ANSWER_CARD_COLLAPSED_LINES, ANSWER_MAX_BYTES, type AnswerCardRecord } from "./contracts.ts";
import { formatBytes } from "./plan-view.ts";
import { answerMigrationGate } from "./migrate-answer-reports.ts";
import { deliverFinalAnswer, RESPONSE_REPORT_MAX_BYTES, ResponseReportError, type ReportUrlOptions, reportUrlOptions } from "./response-reports.ts";

/** Payload of a `cp-answer` entry: a pointer and a headline, never a body. */
export interface AnswerCardData {
	job_id: string;
	project?: string;
	/** The envelope headline (already bounded to 3 lines by the envelope contract). */
	summary: string;
	/** Absolute path of the stored answer, inside the artifact store. */
	path: string;
	/** Size at intake, so the degrade line can still say how big it was. */
	bytes: number;
	reported_at?: string;
	/** M2 PR2: a long answer was published as a permanent report; the card shows this link, never the body. */
	report_url?: string;
}

/** The card for a queued record: its pointer and headline, never a body. */
export function answerCardData(record: AnswerCardRecord): AnswerCardData {
	return {
		job_id: record.job_id, ...(record.project ? { project: record.project } : {}), summary: record.summary, path: record.path, bytes: record.bytes,
		...(record.reported_at ? { reported_at: record.reported_at } : {}),
	};
}

const lastPending = new Map<string, string>();

/**
 * M2 PR2: route a research answer before its card is shown. Over `RESPONSE_INLINE_MAX` code points it is published as
 * a report first and the card carries the link. A publication failure returns undefined (the card stays pending) and
 * calls `pending` once per distinct error; an answer no report can ever hold (secret, oversize) keeps today's card.
 */
export function routeAnswerCard(home: string, record: AnswerCardRecord, pending: (message: string) => void, url: ReportUrlOptions = reportUrlOptions()): AnswerCardData | undefined {
	const data = answerCardData(record);
	let source: AnswerSource;
	try { source = readAnswerSource(record.path, RESPONSE_REPORT_MAX_BYTES); } catch { return data; } // unreadable: the degrade line, as before
	if (source.truncated) return data;
	try {
		answerMigrationGate(home);
		const sent = deliverFinalAnswer(home, { project: record.project ?? null, question: record.summary, answer: source.text, evidence: [record.path], job: record.job_id, source: `research:${record.id}`, time: record.reported_at }, url);
		lastPending.delete(record.id);
		return sent.delivery === "report" ? { ...data, report_url: sent.url } : data;
	} catch (error) {
		if (error instanceof ResponseReportError && (error.code === "secret" || error.code === "too_large" || error.code === "invalid")) return data;
		const message = `answer report for ${record.id} is still pending: ${(error as Error).message}`;
		if (lastPending.get(record.id) !== message) pending(message);
		lastPending.set(record.id, message);
		return undefined;
	}
}

export interface AnswerSource {
	text: string;
	/** Full size on disk, even when truncated. */
	bytes: number;
	truncated: boolean;
}

/**
 * Read an answer, capped. Mirrors `readPlanSource`, kept separate so the cap
 * (`ANSWER_MAX_BYTES`, not the pager's) is not an argument a caller can widen
 * by accident.
 */
export function readAnswerSource(path: string, maxBytes: number = ANSWER_MAX_BYTES): AnswerSource {
	const stats = statSync(path);
	if (stats.size <= maxBytes) {
		return { text: readFileSync(path, "utf8"), bytes: stats.size, truncated: false };
	}
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, 0);
		return { text: buffer.subarray(0, read).toString("utf8"), bytes: stats.size, truncated: true };
	} finally {
		closeSync(fd);
	}
}

/**
 * The card's first line. `ANSWER` is the word, and it is not the word a plan
 * uses anywhere: a plan has no entry surface at all (it opens in the
 * operator's own pager, `/cp-plan`), and this type is `cp-answer` rather than
 * `cp-output`. Nothing renders both.
 */
export function formatAnswerHeader(data: Pick<AnswerCardData, "job_id" | "project">, bytes: number): string {
	const project = data.project ? ` · ${data.project}` : "";
	return `ANSWER — ${data.job_id}${project} · ${formatBytes(bytes)}`;
}

/** The line shown instead of a body when the answer file is gone or unreadable. */
export function formatAnswerDegrade(data: Pick<AnswerCardData, "path" | "bytes">): string {
	return `answer at ${data.path} (${formatBytes(data.bytes)}) — file no longer readable`;
}

export interface AnswerCardView {
	header: string;
	/** The headline the envelope carried; always shown, never a body. */
	summary: string[];
	/** Body lines to render, already bounded. Empty when the file is gone. */
	body: string[];
	/** Lines withheld from a collapsed view. */
	hidden: number;
	/** Present instead of a body when the file could not be read. */
	degraded?: string;
	/** True when the file on disk is larger than `ANSWER_MAX_BYTES`. */
	truncated: boolean;
}

export interface AnswerCardOptions {
	expanded?: boolean;
	collapsedLines?: number;
	maxBytes?: number;
	/** Injected in tests; defaults to the real capped read. */
	read?: (path: string, maxBytes: number) => AnswerSource;
	exists?: (path: string) => boolean;
}

/**
 * Everything the renderer needs, computed without a terminal.
 *
 * Fail-soft on the file and fail-closed on the size: a missing or unreadable
 * answer degrades to one line naming the path and the byte count (the job is
 * over, the card is still in the transcript, and losing the file must not
 * throw inside a renderer), while a file that is too big is read capped and
 * says so.
 */
export function answerCardView(data: AnswerCardData, options: AnswerCardOptions = {}): AnswerCardView {
	const maxBytes = options.maxBytes ?? ANSWER_MAX_BYTES;
	const collapsedLines = options.collapsedLines ?? ANSWER_CARD_COLLAPSED_LINES;
	const exists = options.exists ?? existsSync;
	const read = options.read ?? ((path: string, cap: number) => readAnswerSource(path, cap));
	const summary = data.summary.trim().length > 0 ? data.summary.trim().split("\n") : [];
	if (data.report_url) return { header: formatAnswerHeader(data, data.bytes), summary, body: [`Full answer: ${data.report_url}`], hidden: 0, truncated: false };

	let source: AnswerSource | undefined;
	if (exists(data.path)) {
		try {
			source = read(data.path, maxBytes);
		} catch {
			source = undefined;
		}
	}
	if (!source) {
		return {
			header: formatAnswerHeader(data, data.bytes),
			summary,
			body: [],
			hidden: 0,
			degraded: formatAnswerDegrade(data),
			truncated: false,
		};
	}

	const lines = source.text.replace(/\s+$/, "").split("\n");
	const header = formatAnswerHeader(data, source.bytes);
	if (options.expanded || lines.length <= collapsedLines) {
		return { header, summary, body: lines, hidden: 0, truncated: source.truncated };
	}
	return {
		header,
		summary,
		body: lines.slice(0, collapsedLines),
		hidden: lines.length - collapsedLines,
		truncated: source.truncated,
	};
}

/**
 * The non-TUI form: a path and a byte count, never a body. Mirrors
 * `chooseOutputChannel`'s exclusions — an RPC or print-mode parent has nobody
 * to show a card to, and a program reading the event stream must not be handed
 * an answer body it never asked for.
 */
export function formatAnswerNotice(data: AnswerCardData): string {
	if (data.report_url) return `answer for ${data.job_id}: ${data.report_url} (${formatBytes(data.bytes)}) — the full answer is a permanent report`;
	return `answer for ${data.job_id}: ${data.path} (${formatBytes(data.bytes)}) — open it yourself; the card needs a terminal`;
}
