/**
 * Response reports (M2 PR1): a long human-facing final answer becomes a permanent board under `/boards/report-<hash>/`;
 * a short one stays inline. `content_sha256` hashes the canonical JSON payload (never the HTML); see docs/contracts.md.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishBoard } from "./board-delivery.ts";
import { isIsoTimestamp } from "./contracts.ts";
import { redactSecrets } from "./decision-context.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { type BoardLink, boardLink } from "./viewer/board-link.ts";
import { boardsDir, isBoardSlug, readBoard, resolveBoardFile } from "./viewer/boards.ts";
import { viewerAddress } from "./viewer/cli.ts";
import { resolveStateDir, type ViewerState } from "./viewer/sessions.ts";

/** More Unicode code points than this in the redacted answer publishes a report; exactly this many stays inline. */
export const RESPONSE_INLINE_MAX = 4_000;
/** Canonical payload plus generated HTML, UTF-8 bytes. */
export const RESPONSE_REPORT_MAX_BYTES = 1024 * 1024;
export const RESPONSE_BOARD_JSON_MAX_BYTES = 16 * 1024;
const HEADLINE_MAX = 280;
const SOURCE = /^(?:research|schedule|legacy|chat):\S{1,500}$/;

/** The canonical payload; key order is the hash contract. */
export interface ResponsePayload { project: string | null; question: string; answer: string; evidence: string[]; job: string | null; source: string; time: string }
export interface FinalAnswerInput { project?: string | null; question: string; answer: string; evidence?: readonly string[]; job?: string | null; source: string; time: string }
export interface ReportUrlOptions { viewerHost?: string; viewerPort?: number }
export interface PublishedReport { state: "posted" | "duplicate"; slug: string; href: string; content_sha256: string }
export type FinalAnswerDelivery =
	| { delivery: "inline"; state: "inline"; text: string; url: null; href: null }
	| ({ delivery: "report"; text: string; url: string } & PublishedReport);

export type ResponseReportErrorCode = "invalid" | "secret" | "too_large" | "conflict" | "tampered";
export class ResponseReportError extends Error {
	readonly code: ResponseReportErrorCode;
	constructor(code: ResponseReportErrorCode, message: string) {
		super(message);
		this.name = "ResponseReportError";
		this.code = code;
	}
}

/** Redact every text; one still secret-shaped afterwards refuses the whole answer, by pattern name. */
export function cleanResponseTexts(texts: readonly string[]): string[] {
	const cleaned = texts.map((text) => redactSecrets(text));
	for (const text of cleaned) {
		const hit = SECRET_PATTERNS.find((pattern) => pattern.re.test(text));
		if (hit) throw new ResponseReportError("secret", `answer refused: secret-shaped text (${hit.name}) remains after redaction; remove it`);
	}
	return cleaned;
}

const codePoints = (text: string): number => [...text].length;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export function canonicalResponse(p: ResponsePayload): string {
	return JSON.stringify({ project: p.project, question: p.question, answer: p.answer, evidence: p.evidence, job: p.job, source: p.source, time: p.time });
}

/** `report-` plus 32 hex of SHA-256(source): one stable slug per answer source. */
export function responseReportSlug(source: string): string {
	return `report-${sha256(source).slice(0, 32)}`;
}

function normalize(input: FinalAnswerInput): ResponsePayload {
	const bad = (what: string): never => { throw new ResponseReportError("invalid", `response report refused: ${what}`); };
	if (typeof input.source !== "string" || !SOURCE.test(input.source)) bad("source must be research:|schedule:|legacy:|chat:<id> with no whitespace");
	if (typeof input.time !== "string" || !isIsoTimestamp(input.time)) bad("time must be an ISO timestamp");
	if (typeof input.question !== "string") bad("question must be a string");
	if (typeof input.answer !== "string" || !/\S/.test(input.answer)) bad("answer must be non-empty text");
	const project = input.project ?? null, job = input.job ?? null, evidence = input.evidence ?? [];
	if (project !== null && (typeof project !== "string" || !project)) bad("project must be a non-empty string or null");
	if (job !== null && (typeof job !== "string" || !job)) bad("job must be a non-empty string or null");
	if (!Array.isArray(evidence) || !evidence.every((item) => typeof item === "string")) bad("evidence must be strings");
	// Before redaction: its patterns are not linear on huge single words.
	const size = [input.question, input.answer, ...evidence].reduce((sum, text) => sum + bytes(text), 0);
	if (size > RESPONSE_REPORT_MAX_BYTES) throw new ResponseReportError("too_large", `response report too large: input ${size} bytes > ${RESPONSE_REPORT_MAX_BYTES}`);
	const [question, answer, ...cleaned] = cleanResponseTexts([input.question, input.answer, ...evidence]);
	return { project, question: question!, answer: answer!, evidence: cleaned, job, source: input.source, time: input.time };
}

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function clip(text: string, max: number): string {
	const points = [...text];
	return points.length > max ? `${points.slice(0, max - 1).join("")}\u2026` : text;
}

function title(p: ResponsePayload): string {
	const first = p.question.split("\n").find((line) => line.trim()) ?? "";
	return first ? `Answer: ${clip(first.trim(), 120)}` : "Answer";
}

function evidenceItem(item: string): string {
	let href: string | undefined;
	try {
		const url = new URL(item);
		if ((url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(item)) href = item;
	} catch { /* a path, rendered as text */ }
	return href ? `<li><a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(item)}</a></li>` : `<li><code>${escapeHtml(item)}</code></li>`;
}

/** Deterministic, escaped static HTML: no script, no author markup. */
export function renderResponseReport(p: ResponsePayload): string {
	const meta = [p.project, p.job, p.time].filter((part): part is string => part !== null).map(escapeHtml).join(" \u00b7 ");
	const evidence = p.evidence.length ? `<h2>Evidence</h2><ul>${p.evidence.map(evidenceItem).join("")}</ul>` : "";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
		+ `<title>${escapeHtml(title(p))}</title><link rel="stylesheet" href="/boards/board.css">`
		+ `<style>.text{white-space:pre-wrap;overflow-wrap:anywhere}.meta{color:#aaa}code{overflow-wrap:anywhere}</style></head><body>`
		+ `<h1 class="text">${escapeHtml(title(p))}</h1><p class="meta">${meta}</p>`
		+ `<h2>Question</h2><p class="text">${escapeHtml(p.question)}</p><h2>Answer</h2><div class="text">${escapeHtml(p.answer)}</div>`
		+ `${evidence}</body></html>\n`;
}

function readCapped(file: string, max: number, what: string): string {
	if (lstatSync(file).size > max) throw new ResponseReportError("tampered", `${what} is over ${max} bytes`);
	return readFileSync(file, "utf8");
}

function parsePayload(text: string): ResponsePayload | undefined {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return undefined; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const nullable = (x: unknown) => x === null || typeof x === "string";
	if (!nullable(v.project) || typeof v.question !== "string" || typeof v.answer !== "string" || !Array.isArray(v.evidence)
		|| !v.evidence.every((item) => typeof item === "string") || !nullable(v.job) || typeof v.source !== "string" || typeof v.time !== "string") return undefined;
	const payload: ResponsePayload = { project: v.project as string | null, question: v.question, answer: v.answer, evidence: v.evidence as string[],
		job: v.job as string | null, source: v.source, time: v.time };
	return canonicalResponse(payload) === text ? payload : undefined;
}

/** A published report, re-verified: canonical payload, metadata hash and source, and the HTML it renders to. */
function readPublished(state: ViewerState, slug: string): { payload: ResponsePayload; hash: string } {
	const tampered = (why: string): never => { throw new ResponseReportError("tampered", `response report ${slug} failed verification: ${why}`); };
	if (!readBoard(state, slug)) tampered("not a readable board");
	const content = resolveBoardFile(state, slug, "content.json"), index = resolveBoardFile(state, slug, "");
	if (!content || !index) return tampered("site/content.json or site/index.html is missing");
	let meta: Record<string, unknown>;
	try { meta = JSON.parse(readCapped(join(boardsDir(state), slug, "board.json"), RESPONSE_BOARD_JSON_MAX_BYTES, "board.json")); }
	catch (error) { return tampered(error instanceof ResponseReportError ? error.message : "board.json is malformed"); }
	const text = readCapped(content, RESPONSE_REPORT_MAX_BYTES, "content.json");
	const payload = parsePayload(text) ?? tampered("content.json is not a canonical payload");
	const hash = sha256(text);
	if (meta.content_sha256 !== hash) tampered("content_sha256 does not match content.json");
	if (meta.source !== payload.source || responseReportSlug(payload.source) !== slug) tampered("source does not match its slug");
	if (meta.project !== payload.project) tampered("project does not match content.json");
	if (readCapped(index, RESPONSE_REPORT_MAX_BYTES, "index.html") !== renderResponseReport(payload)) tampered("index.html is not the rendered payload");
	return { payload, hash };
}

function publishPayload(home: string, payload: ResponsePayload): PublishedReport {
	const state: ViewerState = { home, stateDir: resolveStateDir(home) };
	const slug = responseReportSlug(payload.source), href = `/boards/${slug}/`, target = join(boardsDir(state), slug);
	const existing = (): PublishedReport | undefined => {
		if (!existsSync(target)) return undefined;
		const stored = readPublished(state, slug);
		// A retry keeps the original time; any other difference is a changed answer, never an overwrite.
		const hash = sha256(canonicalResponse({ ...payload, time: stored.payload.time }));
		if (stored.payload.source !== payload.source || hash !== stored.hash) {
			throw new ResponseReportError("conflict", `response report conflict: ${payload.source} is already published as ${href} with different content`);
		}
		return { state: "duplicate", slug, href, content_sha256: stored.hash };
	};
	const found = existing();
	if (found) return found;
	const text = canonicalResponse(payload), html = renderResponseReport(payload), total = bytes(text) + bytes(html);
	if (total > RESPONSE_REPORT_MAX_BYTES) throw new ResponseReportError("too_large", `response report too large: ${total} bytes > ${RESPONSE_REPORT_MAX_BYTES}`);
	const board = JSON.stringify({ title: title(payload), description: clip(headline(payload.answer), 300), job_ids: [], created_at: payload.time,
		project: payload.project, source: payload.source, content_sha256: sha256(text) });
	if (bytes(board) > RESPONSE_BOARD_JSON_MAX_BYTES) throw new ResponseReportError("too_large", `response report board.json too large: ${bytes(board)} bytes > ${RESPONSE_BOARD_JSON_MAX_BYTES}`);
	mkdirSync(boardsDir(state), { recursive: true });
	const staging = mkdtempSync(join(boardsDir(state), ".staging-"));
	try {
		mkdirSync(join(staging, "site"));
		writeFileSync(join(staging, "board.json"), board, { mode: 0o600 });
		writeFileSync(join(staging, "site", "content.json"), text, { mode: 0o600 });
		writeFileSync(join(staging, "site", "index.html"), html, { mode: 0o600 });
		publishBoard(home, slug, join(staging, "board.json"));
	} catch (error) {
		const raced = existsSync(target) ? existing() : undefined;
		if (raced) return raced;
		throw error;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	if (readPublished(state, slug).hash !== sha256(text)) throw new ResponseReportError("tampered", `response report ${slug} changed while publishing`);
	return { state: "posted", slug, href, content_sha256: sha256(text) };
}

/** Publish regardless of length (migration, explicit report); a retry of the same source and content is `duplicate`. */
export function publishResponseReport(home: string, input: FinalAnswerInput): PublishedReport {
	return publishPayload(home, normalize(input));
}

/** The report published for `source`, re-verified (payload, metadata hash, HTML); undefined when none exists. */
export function readResponseReport(home: string, source: string): { payload: ResponsePayload; content_sha256: string; href: string } | undefined {
	const state: ViewerState = { home, stateDir: resolveStateDir(home) }, slug = responseReportSlug(source);
	if (!existsSync(join(boardsDir(state), slug))) return undefined;
	const { payload, hash } = readPublished(state, slug);
	return { payload, content_sha256: hash, href: `/boards/${slug}/` };
}

/** The viewer address intake uses: CP_VIEWER_HOST as configured (else the tailnet address), a validated port. */
export function reportUrlOptions(env: NodeJS.ProcessEnv = process.env): ReportUrlOptions {
	return { ...(env.CP_VIEWER_HOST ? { viewerHost: env.CP_VIEWER_HOST } : {}), viewerPort: viewerAddress(env, false, () => undefined).port };
}

/**
 * The link for a served board through the shared resolver (src/viewer/board-link.ts): tunnel origin, public URL, viewer
 * host, tailnet, else a relative `/boards/<slug>/` with a remedy `note`. Links never carry credentials.
 */
export function responseReportUrl(home: string, slug: string, options: ReportUrlOptions = {}): BoardLink {
	if (!isBoardSlug(slug)) throw new ResponseReportError("invalid", `board slug ${JSON.stringify(slug)} is not valid`);
	return boardLink(home, slug, options);
}

function headline(answer: string): string {
	return clip((answer.split(/\n\s*\n/).find((part) => part.trim()) ?? answer).trim(), HEADLINE_MAX);
}

/** A final answer: inline at or under `RESPONSE_INLINE_MAX` code points after redaction, else a report and its link. */
export function deliverFinalAnswer(home: string, input: FinalAnswerInput, options: ReportUrlOptions = {}): FinalAnswerDelivery {
	const payload = normalize(input);
	if (codePoints(payload.answer) <= RESPONSE_INLINE_MAX) return { delivery: "inline", state: "inline", text: payload.answer, url: null, href: null };
	const { url, note } = responseReportUrl(home, responseReportSlug(payload.source), options);
	const published = publishPayload(home, payload);
	return { delivery: "report", text: `${headline(payload.answer)}\n\nFull answer: ${url}${note ? `\n(${note})` : ""}`, url, ...published };
}
