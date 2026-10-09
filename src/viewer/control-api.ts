/**
 * Dashboard control routes (cp-dashboard-operator-control): the operator steers its own running session from the
 * Full transcript. `GET /api/operator/control` reads the status and this session's CSRF token (never writes);
 * `POST /api/operator/message` forwards one authenticated frame to the operator session's control socket
 * (src/dashboard-control.ts), which journals it and injects it as a user message.
 *
 * Access is the viewer's own (the operator: the dashboard origin is reachable only from tailnet devices): the
 * `--require-tailnet` viewer, then the Origin + CSRF token defences against a hostile page in the operator's own
 * browser. The POST refuses in this order; every refusal after the --require-tailnet guard appends one `refused`
 * line to `state/operator/dashboard.jsonl` (control-audit.ts): method, --require-tailnet, rate (20 per 60 s and
 * 1 in flight per client address, refusals counted, so it also bounds the journal), the opt-out
 * (`data/dashboard-control.json` `{"enabled": false}`), Origin, Sec-Fetch-Site, JSON content type, 20 KiB body,
 * body shape, the session's record, its CSRF token, the socket.
 *
 * cp-daemon P3: with no live session record (absent, invalid, or its pid gone) a send is **held** instead — the
 * inbox token (control-inbox.ts) replaces the session's CSRF token, abort is 409, at most 20 wait — and appended
 * to `state/operator/inbox.jsonl` for the next session to deliver. `POST /api/operator/start` takes exactly
 * `{"via": "tmux"}` — `<tmux> new-session -d -s cp-operator <wrapper>` (cp-rrye: the absolute tmux, run directly, only by
 * a cp-daemon-run viewer) — or `{"via": "herdr"}` — a herdr workspace
 * `cp-operator` running the cp-operator wrapper — (fixed argv, no request data reaches either) behind the same
 * chain, the inbox token, no live session, and at most one start per 60 s; every outcome is one audit line.
 * `"resume": true` beside `via` is Resume last session: the wrapper with the fixed `-c`.
 * `POST /api/operator/restart` (Restart session, operator-restart.ts) reuses `guarded` and `tokenMatches` from here.
 *
 * cp-hhuf P6, Schedules page controls: `GET /api/schedules/control` (--require-tailnet only, never writes) reads the
 * opt-out, this viewer's schedule token, whether the parent holds the home and the recent requests;
 * `POST /api/schedules/request` takes exactly `{op, schedule_id}` behind the same chain (kind `schedule`), then body
 * shape, the parent running, the schedule token, the schedule existing, at most 20 pending, and appends one
 * `request` line to `state/schedule-control.jsonl` before it answers 202. The parent applies it (src/schedule-control.ts).
 *
 * cp-mxk4, Decisions page Answers to acknowledge: `GET /api/answers/control` (--require-tailnet only, never writes) reads
 * the opt-out and this viewer's answer token; `POST /api/answers/ack` takes exactly `{id}` behind the same chain (kind
 * `answer_ack`), then the answer token, the answer existing and not yet acknowledged, and appends one `acked` line to
 * `state/operator/answers.jsonl` before it answers 202. No session, no parent: it only moves the answer to the history.
 *
 * cp-xmw2, operator threads: message and answer bodies may carry `thread`, normalized by `normalizeThreadTag`.
 * It reaches the session's marker; after the 202 (or the held line), the viewer files the dc- id via `bindThread`.
 * A failed bind is named as `thread.error`. The thread list and done route live in threads-api.ts.
 */

import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { HERDR_TIMEOUT_MS, HERDR_WORKSPACE_LABEL, herdrCommand, herdrServerArgv, herdrServerRunning, type Launcher, OPERATOR_TMUX_SESSION, onPath, operatorWrapperPath, tmuxLaunch } from "./launchers.ts";
import type { AnswerAckResponse, AnswersControlStatusResponse, ControlMessageBody, ControlSendResponse, ControlStatusResponse, OperatorStartResponse, ScheduleControlSendResponse, ScheduleControlStatusResponse } from "./api-types.ts";
import { appendAnswerLine, appendControlAudit, appendInboxLine, appendScheduleControlLine, bindThread } from "./control-audit.ts";
import {
	CONTROL_BODY_MAX_BYTES, CONTROL_PROTOCOL, CONTROL_RATE_LIMIT, CONTROL_RATE_WINDOW_MS, CONTROL_TEXT_MAX, type ControlKind, type ControlRecord,
	controlInboxFile, controlOrigin, controlRecordFile, DASHBOARD_ID_RE, INBOX_MAX_HELD, isAnswerId, isAskId, normalizeThreadTag, operatorAnswersFile, readAnswers, readControlConfig, readControlRecord,
	readScheduleControl, SCHEDULE_CONTROL_MAX_AGE_MS, SCHEDULE_CONTROL_MAX_PENDING, SCHEDULE_CONTROL_OPS, scheduleControlFile, type ScheduleControlOp, type ScheduleControlRequest,
} from "./control-files.ts";
import { heldId, INBOX_TOKEN, operatorSession, parentHolder, readInbox } from "./control-inbox.ts";
import { restartStatus } from "./restart-status.ts";
import { allowedOrigins, bindOrigin, readBody } from "./push-api.ts";
import { readScheduleFile, SCHEDULE_ID } from "./schedule-core.ts";
import { readPendingSends } from "./control-pending.ts";
import { isImageUploadId, isTextUploadId, statUpload, UPLOAD_MAX_PER_MESSAGE, UPLOAD_MESSAGE_MAX_BYTES, UPLOAD_RATE_LIMIT, UPLOAD_SEND_TIMEOUT_MS, uploadRoot } from "./uploads.ts";

import { scheduleControlFieldError, type ScheduleControlFields } from "./control-files.ts";
import { schedulePolicyView } from "./schedule-policy-view.ts";
export const SCHEDULE_POLICY_PATH = "/api/schedules/policy";
export function handleSchedulePolicy(req: IncomingMessage, options: ControlRouteOptions): ControlRouteResult {
 if (options.requireTailnet !== true) return {status:403,body:{error:"schedule policy is served only under --require-tailnet"}};
 const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("schedule_id");
 if (!id || !SCHEDULE_ID.test(id)) return {status:400,body:{error:"schedule_id must be sch-<6 hex>"}};
 try { return {status:200,body:schedulePolicyView(options.stateDir,id)}; }
 catch (error) { const message = (error as Error).message; return {status:message === `no schedule ${id}` ? 404 : 503,body:{error:message}}; }
}
export const CONTROL_STATUS_PATH = "/api/operator/control";
export const CONTROL_MESSAGE_PATH = "/api/operator/message";
export const OPERATOR_START_PATH = "/api/operator/start";
export const SCHEDULE_CONTROL_STATUS_PATH = "/api/schedules/control";
export const SCHEDULE_CONTROL_PATH = "/api/schedules/request";
/** The Schedules page's CSRF token: per viewer process; a viewer restart rotates it (the page re-reads it with the status). */
export const SCHEDULE_TOKEN = randomBytes(32).toString("hex");
const scheduleRequestId = (now: Date): string => `sc-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
export const ANSWERS_CONTROL_PATH = "/api/answers/control";
export const ANSWER_ACK_PATH = "/api/answers/ack";
/** The Answers section's CSRF token: per viewer process; a viewer restart rotates it (the page re-reads it with the status). */
export const ANSWER_TOKEN = randomBytes(32).toString("hex");
export const OPERATOR_START_WINDOW_MS = 60_000;
/** How long a herdr server check is reused by the control status. */
export const LAUNCHERS_CACHE_MS = 30_000;
/** Every tmux start is bounded by this. */
const TMUX_TIMEOUT_MS = 30_000;

type Run = (argv: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<{ status: number; output: string; stdout?: string }>;

/** Start session's seams and its state (the last start, the last herdr check), kept on the viewer's options. */
export interface OperatorStart {
	/** Default: the absolute `tmux` on PATH; null: no tmux. */
	tmux?: string | null;
	/** Default: the absolute `herdr` on PATH; null: no herdr. */
	herdr?: string | null;
	/** Default: `~/.local/bin/cp-operator`, what the tmux session and the herdr pane run. */
	wrapper?: string;
	/** Default: `process.env`: `CP_DAEMON_ROLE=viewer` says cp-daemon runs this viewer; tmux gets it minus `CP_DAEMON_*`. */
	env?: NodeJS.ProcessEnv;
	run?: Run;
	lastAt?: number;
	/** Restart session (operator-restart.ts): when the last restart frame was sent. */
	restartAt?: number;
	herdrChecked?: { at: number; running: boolean };
}

export interface ControlRouteOptions {
	home: string;
	stateDir: string;
	host: string;
	port: number;
	requireTailnet?: boolean;
	controlLimiter?: ControlLimiter;
	/** Image attachments: the upload root (default `CP_UPLOAD_ROOT`, else /tmp/cp-dashboard-uploads) and the upload rate limiter (24 per 60 s). */
	uploadRoot?: string;
	uploadLimiter?: ControlLimiter;
	operatorStart?: OperatorStart;
	log?: (line: string) => void;
}

export interface ControlRouteResult {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

/** Sliding window per client address, counting refused requests too, plus one request in flight. */
export class ControlLimiter {
	readonly #hits = new Map<string, { at: number[]; busy: boolean; loggedWindow: number }>();
	/** Requests per window: 20 for the JSON routes; image uploads get their own limiter (24). */
	readonly limit: number;
	constructor(limit = CONTROL_RATE_LIMIT) {
		this.limit = limit;
	}
	take(key: string, now: number): { ok: true; release: () => void } | { ok: false; retryAfterS: number; firstInWindow: boolean } {
		const row = this.#hits.get(key) ?? { at: [], busy: false, loggedWindow: -1 };
		row.at = row.at.filter((t) => now - t < CONTROL_RATE_WINDOW_MS);
		this.#hits.set(key, row);
		if (this.#hits.size > 256) for (const [k, v] of this.#hits) if (!v.busy && !v.at.length) this.#hits.delete(k);
		if (row.at.length >= this.limit || row.busy) {
			const oldest = row.at[0] ?? now;
			const firstInWindow = row.loggedWindow < oldest;
			if (firstInWindow) row.loggedWindow = now;
			return { ok: false, retryAfterS: row.busy ? 1 : Math.max(1, Math.ceil((oldest + CONTROL_RATE_WINDOW_MS - now) / 1000)), firstInWindow };
		}
		row.at.push(now);
		row.busy = true;
		return { ok: true, release: () => { row.busy = false; } };
	}
}

type BridgeReply = { ok: true; result: unknown } | { ok: false; status: number; error: string; result?: unknown };

/** One NDJSON frame to the operator session's socket, one reply back. */
export function controlRequest(record: ControlRecord, op: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<BridgeReply> {
	return new Promise((done) => {
		const socket = createConnection(record.socket);
		let buffer = "";
		let settled = false;
		const finish = (reply: BridgeReply) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			done(reply);
		};
		const timer = setTimeout(() => finish({ ok: false, status: 504, error: `session did not answer on ${record.socket} within ${timeoutMs / 1000} s` }), timeoutMs);
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL, token: record.token, id: 1, op, args })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index < 0) return;
			try {
				const reply = JSON.parse(buffer.slice(0, index)) as { ok?: unknown; result?: unknown; status?: unknown; error?: unknown };
				if (reply.ok === true) finish({ ok: true, result: reply.result });
				else finish({ ok: false, status: typeof reply.status === "number" ? reply.status : 502, error: typeof reply.error === "string" ? reply.error : "the session refused the request", ...(reply.result !== undefined ? { result: reply.result } : {}) });
			} catch {
				finish({ ok: false, status: 502, error: "the session answered with a frame that is not JSON" });
			}
		});
		socket.once("error", (error: NodeJS.ErrnoException) => finish({ ok: false, status: 503, error: `session not running: ${record.socket} refused the connection (${error.code ?? error.message})` }));
		socket.once("close", () => finish({ ok: false, status: 503, error: `session not running: ${record.socket} closed the connection` }));
	});
}

const peerOf = (req: IncomingMessage): string | null => req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? null;
const log = (options: ControlRouteOptions) => options.log ?? ((line: string) => process.stderr.write(line));
export const tokenMatches = (given: unknown, want: string): boolean => {
	const a = Buffer.from(String(given ?? ""));
	const b = Buffer.from(want);
	return a.length === b.length && timingSafeEqual(a, b);
};

const startEnv = (options: ControlRouteOptions): NodeJS.ProcessEnv => options.operatorStart?.env ?? process.env;

/** Start in tmux here: the fixed argv, or why not (launchers.ts `tmuxLaunch`; nothing from the request). */
function tmuxStart(options: ControlRouteOptions, resume = false): { argv: string[] } | { reason: string } {
	const start = options.operatorStart;
	const env = startEnv(options);
	const tmux = start && "tmux" in start ? start.tmux ?? undefined : onPath("tmux", env.PATH ?? "");
	return tmuxLaunch({ daemonRun: env.CP_DAEMON_ROLE === "viewer", tmux, wrapper: start?.wrapper ?? operatorWrapperPath(env) }, resume);
}

/** The tmux client's env: this viewer's, minus cp-daemon's own markers (the session is not a daemon role). */
function tmuxEnv(options: ControlRouteOptions): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(startEnv(options)).filter(([key]) => !key.startsWith("CP_DAEMON_")));
}

const herdrPath = (options: ControlRouteOptions): string | undefined => {
	const start = options.operatorStart;
	return start && "herdr" in start ? start.herdr ?? undefined : onPath("herdr");
};

/** herdr's server is running (`herdr status server --json`); reused for 30 s unless `fresh`. */
async function herdrRunning(options: ControlRouteOptions, herdr: string, now: number, fresh = false): Promise<boolean> {
	const start = (options.operatorStart ??= {});
	if (!fresh && start.herdrChecked && now - start.herdrChecked.at < LAUNCHERS_CACHE_MS) return start.herdrChecked.running;
	const ran = await (start.run ?? runFixed)(herdrServerArgv(herdr), HERDR_TIMEOUT_MS);
	const running = herdrServerRunning({ status: ran.status, stdout: ran.stdout ?? ran.output });
	start.herdrChecked = { at: now, running };
	return running;
}

/** Which launchers Start session can use: tmux = `tmuxLaunch` (cp-daemon runs this viewer, tmux, the wrapper); herdr = binary and server running. */
async function launchers(options: ControlRouteOptions, now: number): Promise<ControlStatusResponse["launchers"]> {
	const herdr = herdrPath(options);
	return { tmux: "argv" in tmuxStart(options), herdr: herdr ? await herdrRunning(options, herdr, now) : false };
}

/** Why Start session cannot work on this home, or null when a launcher can. */
function startUnavailable(options: ControlRouteOptions, can: ControlStatusResponse["launchers"]): string | null {
	const tmux = tmuxStart(options);
	return can.tmux || can.herdr ? null : `${"reason" in tmux ? tmux.reason : "tmux unavailable"}; herdr ${herdrPath(options) ? "server not running" : "is not on PATH"}`;
}

function statusBase(now: Date): ControlStatusResponse {
	return { generated_at: now.toISOString(), enabled: false, running: false, reason: null, token: null, busy: null, pending: null, session_file: null, recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: false, herdr: false }, resume: { tmux: false, herdr: false } };
}

export async function handleControlStatus(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	if (options.requireTailnet !== true) return { status: 403, body: { error: "dashboard control is served only under --require-tailnet" } };
	const config = readControlConfig(options.stateDir);
	if (config.state !== "on") return { status: 200, body: { ...statusBase(now), reason: `Dashboard control is off: ${config.reason}` } };
	const can = await launchers(options, now.getTime());
	// Resume last session: the same launchers (tmux and herdr run the wrapper with the fixed `-c`).
	const record = readControlRecord(options.stateDir);
	const session = operatorSession(options.stateDir);
	const base = { ...statusBase(now), launchers: can, resume: { ...can }, ...readPendingSends(options.stateDir, now, session) };
	if (record.state !== "ok" || !session.running) {
		const inbox = readInbox(options.stateDir);
		const why = record.state === "absent" ? `no dashboard control record at ${controlRecordFile(options.stateDir)}` : session.reason;
		return { status: 200, body: { ...base, enabled: true, offline: true, held: inbox.held.length, inbox_token: INBOX_TOKEN, start_unavailable: startUnavailable(options, can), reason: `Operator session offline: ${why}${inbox.error ? `; inbox unreadable: ${inbox.error}` : ""}` } };
	}
	const reply = await controlRequest(record.record, "status", {});
	if (!reply.ok) return { status: 200, body: { ...base, enabled: true, reason: reply.error.replace(/^session not running/, "Session not running") } };
	const status = reply.result as Partial<ControlStatusResponse>;
	return {
		status: 200,
		body: {
			...base, enabled: true, running: true, token: record.record.csrf,
			busy: typeof status.busy === "boolean" ? status.busy : null, pending: typeof status.pending === "boolean" ? status.pending : null,
			session_file: typeof status.session_file === "string" ? status.session_file : null, recent: Array.isArray(status.recent) ? status.recent : [],
			restart: restartStatus(status.restart), session_started_at: record.record.started_at,
			...(status.images === true ? { images: true } : {}),
			...(status.files === true ? { files: true } : {}),
		} satisfies ControlStatusResponse,
	};
}

type Parsed = { kind: ControlKind | "start" | "schedule" | "answer_ack" | "upload" | "thread_done" | "settings" | "queue" | null; text: string | null; ask_id: string | null; bytes?: number; via?: Launcher; op?: ScheduleControlOp | "edit" | "cancel"; schedule_id?: string; answer_id?: string; images?: string[]; files?: string[]; mime?: string; thread?: string; thread_id?: string; queue_id?: string };
type Body = ControlMessageBody | { kind: "answer"; ask_id: string; label: string; thread?: string } | { kind: "abort" };
type Refuse = (status: number, reason: string, headers?: Record<string, string>, extra?: Record<string, unknown>) => ControlRouteResult;
export interface Gate { peer: string | null; refuse: Refuse; parsed(value: Parsed): void }

/** Normalize a message or click's optional thread before any socket frame or inbox write. */
function parseBody(json: unknown): { ok: true; body: Body; thread: string | null; parsed: Parsed } | { ok: false; reason: string; parsed: Parsed } {
	const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
	const kind = value?.kind === "message" || value?.kind === "answer" || value?.kind === "abort" ? value.kind : null;
	const text = typeof value?.text === "string" ? value.text : kind === "answer" && typeof value?.label === "string" ? value.label : null;
	const images = Array.isArray(value?.images) ? value.images.slice(0, UPLOAD_MAX_PER_MESSAGE).map((image) => String(image).slice(0, 64)) : undefined;
	const files = Array.isArray(value?.files) ? value.files.slice(0, UPLOAD_MAX_PER_MESSAGE).map((file) => String(file).slice(0, 64)) : undefined;
	const parsed: Parsed = { kind, text, ask_id: typeof value?.ask_id === "string" ? value.ask_id.slice(0, 100) : null, ...(images ? { images } : {}), ...(files ? { files } : {}), ...(typeof value?.thread === "string" ? { thread: value.thread.slice(0, 64) } : {}) };
	const keys = { message: ["kind", "text", "deliver", "images", "files", "thread", "client_id"], answer: ["kind", "ask_id", "label", "thread"], abort: ["kind"] };
	if (!value || !kind) return { ok: false, reason: 'kind must be "message", "answer" or "abort"', parsed };
	const extra = Object.keys(value).filter((key) => !keys[kind].includes(key));
	if (extra.length) return { ok: false, reason: `unknown field ${extra.join(", ")}`, parsed };
	if (kind === "abort") return { ok: true, body: { kind }, thread: null, parsed };
	const thread = value.thread === undefined ? null : normalizeThreadTag(value.thread);
	if (value.thread !== undefined && thread === null) return { ok: false, reason: "thread must be a tag: 1-32 of a-z 0-9 -, starting with a letter or digit", parsed };
	const tagged = thread === null ? {} : { thread };
	if (kind === "answer") {
		if (!isAskId(value.ask_id)) return { ok: false, reason: "ask_id must be an ask id", parsed };
		if (typeof value.label !== "string" || !value.label) return { ok: false, reason: "label must be one of the ask's options", parsed };
		return { ok: true, body: { kind, ask_id: value.ask_id, label: value.label, ...tagged }, thread, parsed };
	}
	const ids = value.images, fileIds = value.files;
	if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > UPLOAD_MAX_PER_MESSAGE || new Set(ids).size !== ids.length || !ids.every(isImageUploadId))) return { ok: false, reason: `images must be 1-${UPLOAD_MAX_PER_MESSAGE} distinct upload ids`, parsed };
	if (fileIds !== undefined && (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > UPLOAD_MAX_PER_MESSAGE || new Set(fileIds).size !== fileIds.length || !fileIds.every(isTextUploadId))) return { ok: false, reason: `files must be 1-${UPLOAD_MAX_PER_MESSAGE} distinct text upload ids`, parsed };
	if ((images?.length ?? 0) + (files?.length ?? 0) > UPLOAD_MAX_PER_MESSAGE) return { ok: false, reason: `at most ${UPLOAD_MAX_PER_MESSAGE} attachments per message`, parsed };
	const trimmed = typeof value.text === "string" ? value.text.trim() : "";
	if (!trimmed && !ids && !fileIds) return { ok: false, reason: "text is empty", parsed };
	if (trimmed.length > CONTROL_TEXT_MAX) return { ok: false, reason: `text is longer than ${CONTROL_TEXT_MAX} characters`, parsed };
	if (value.client_id !== undefined && (typeof value.client_id !== "string" || !DASHBOARD_ID_RE.test(value.client_id))) return { ok: false, reason: "client_id must be a dashboard id", parsed };
	if (value.deliver !== undefined && value.deliver !== "followUp" && value.deliver !== "steer") return { ok: false, reason: 'deliver must be "followUp" or "steer"', parsed };
	return { ok: true, body: { kind, text: trimmed, ...(value.deliver ? { deliver: value.deliver } : {}), ...(ids ? { images: ids as string[] } : {}), ...(fileIds ? { files: fileIds as string[] } : {}), ...(typeof value.client_id === "string" ? { client_id: value.client_id } : {}), ...tagged }, thread, parsed };
}

/** The journals' timestamp form: ISO seconds, no milliseconds. */
export const isoSeconds = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * cp-xmw2: file an accepted (or held) `dc-` message under the composer's thread. A failed bind never changes the 202:
 * the body names it as `thread.error` and the viewer log gets one line.
 */
function threaded(options: ControlRouteOptions, result: ControlSendResponse, tag: string | null, peer: string | null, now: Date): ControlSendResponse {
	if (tag === null) return result;
	const id = result?.id;
	const bound = typeof id === "string" && DASHBOARD_ID_RE.test(id)
		? bindThread(options.stateDir, { tag, ref: { kind: "dashboard", id }, by: "viewer", peer, at: isoSeconds(now) })
		: { ok: false as const, error: `the session answered without a dc- id (${JSON.stringify(id ?? null)})` };
	if (!bound.ok) log(options)(`viewer: thread bind unwritten for ${String(id)}: ${bound.error}\n`);
	return { ...result, thread: { tag, id: bound.ok ? bound.thread : null, error: bound.ok ? null : bound.error } };
}

const IMAGE_CONTENT_TYPE = /^image\/(png|jpeg|webp|gif)\s*(?:;|$)/i;

/**
 * The shared refusal chain up to a parsed body: method, --require-tailnet, rate, opt-out, Origin, Sec-Fetch-Site,
 * type, size. `{ image: max }` (POST /api/operator/upload) takes raw image bytes on its own limiter and hands
 * `next` the Buffer; otherwise the body is JSON within CONTROL_BODY_MAX_BYTES.
 */
export async function guarded(req: IncomingMessage, options: ControlRouteOptions, now: Date, kind: Parsed["kind"], next: (json: unknown, gate: Gate) => Promise<ControlRouteResult>, mode: "json" | { image: number; text?: number } = "json"): Promise<ControlRouteResult> {
	const peer = peerOf(req);
	if (req.method !== "POST") {
		log(options)(`viewer: dashboard control refused 405: ${req.method} (${peer ?? "unknown peer"})\n`);
		return { status: 405, body: { error: "POST only" }, headers: { allow: "POST" } };
	}
	if (options.requireTailnet !== true) {
		log(options)(`viewer: dashboard control refused 403: not under --require-tailnet (${peer ?? "unknown peer"})\n`);
		return { status: 403, body: { error: "dashboard control is served only under --require-tailnet" } };
	}
	let parsed: Parsed = { kind, text: null, ask_id: null };
	const refuse: Refuse = (status, reason, headers, extra = {}) => {
		log(options)(`viewer: dashboard control refused ${status}: ${reason} (${peer ?? "unknown peer"})\n`);
		const audit = appendControlAudit(options.stateDir, { type: "refused", by: "viewer", id: null, at: now.toISOString(), peer, ...parsed, status, reason });
		if (!audit.ok) log(options)(`viewer: dashboard control audit line unwritten: ${audit.error}\n`);
		return { status, body: { ...extra, error: reason, ...(audit.ok ? {} : { audit: `unwritten: ${audit.error}` }) }, ...(headers ? { headers } : {}) };
	};
	// Rate first: every refusal after it is journaled, so the limiter is what bounds the journal.
	const image = mode === "json" ? undefined : mode.image;
	const limiter = image === undefined ? (options.controlLimiter ??= new ControlLimiter()) : (options.uploadLimiter ??= new ControlLimiter(UPLOAD_RATE_LIMIT));
	const slot = limiter.take(peer ?? "unknown", now.getTime());
	if (!slot.ok) {
		const reason = `too many dashboard ${image === undefined ? "requests" : "uploads"}: ${limiter.limit} per ${CONTROL_RATE_WINDOW_MS / 1000} s and one at a time; retry in ${slot.retryAfterS} s`;
		if (slot.firstInWindow) return refuse(429, reason, { "retry-after": String(slot.retryAfterS) });
		log(options)(`viewer: dashboard control refused 429 (${peer ?? "unknown peer"})\n`);
		return { status: 429, body: { error: reason }, headers: { "retry-after": String(slot.retryAfterS) } };
	}
	try {
		const config = readControlConfig(options.stateDir);
		if (config.state === "invalid") return refuse(503, `dashboard control config is invalid: ${config.reason}`);
		if (config.state === "off") return refuse(403, `dashboard control is off (${config.reason})`);
		const origin = controlOrigin(options.stateDir);
		// No HTTPS origin configured: same-origin with this bind (the plain-HTTP origin the Host guard already pinned).
		const origins = origin ? allowedOrigins(options, origin) : [bindOrigin(options)];
		if (!origins.includes(req.headers.origin ?? "")) return refuse(403, `Origin must be ${origin ?? `${bindOrigin(options)} (no HTTPS origin is configured; npm run push:init -- --origin https://<dashboard host> to use one)`}`);
		const site = req.headers["sec-fetch-site"];
		if (site !== undefined && site !== "same-origin") return refuse(403, "cross-site request refused");
		const type = req.headers["content-type"] ?? "";
		if (image !== undefined) {
			parsed = { ...parsed, mime: type.slice(0, 100) };
			if (mode !== "json" && mode.text === undefined) {
				if (/^image\/hei[cf]\b/i.test(type)) return refuse(415, "HEIC/HEIF is not supported; share the photo as JPEG");
				if (!IMAGE_CONTENT_TYPE.test(type)) return refuse(415, "Content-Type must be image/png, image/jpeg, image/webp or image/gif");
			}
		} else if (!/^application\/json\s*(?:;|$)/i.test(type)) return refuse(415, "Content-Type must be application/json");
		const max = (mode === "json" ? undefined : mode.text) ?? image ?? CONTROL_BODY_MAX_BYTES;
		const raw = await readBody(req, max);
		if (raw === "too_large") {
			parsed = { ...parsed, bytes: Number(req.headers["content-length"]) || max + 1 };
			return refuse(413, `body is larger than ${max} bytes`, { connection: "close" });
		}
		if (image !== undefined) {
			parsed = { ...parsed, bytes: raw.length };
			return await next(raw, { peer, refuse, parsed: (value) => { parsed = value; } });
		}
		let json: unknown;
		try {
			json = JSON.parse(raw.toString("utf8"));
		} catch {
			parsed = { ...parsed, bytes: raw.length };
			return refuse(400, "body is not JSON");
		}
		return await next(json, { peer, refuse, parsed: (value) => { parsed = value; } });
	} finally {
		slot.release();
	}
}

export function handleControlMessage(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, null, async (json, { peer, refuse, parsed }) => {
		const shape = parseBody(json);
		parsed(shape.parsed);
		if (!shape.ok) return refuse(400, shape.reason);
		const record = readControlRecord(options.stateDir);
		const running = record.state === "ok" && operatorSession(options.stateDir).running;
		const images = shape.body.kind === "message" ? shape.body.images : undefined;
		const files = shape.body.kind === "message" ? shape.body.files : undefined;
		const attachments = [...(images ?? []), ...(files ?? [])];
		if (attachments.length) {
			// Never held in the inbox: a later session could not be sure the uploads still exist.
			if (!running) return refuse(409, `${files ? "file" : "image"} attachments need a running operator session (they are never held in the inbox); start it, or send text only`);
			const root = uploadRoot(options.uploadRoot);
			let total = 0;
			for (const image of attachments) {
				const stat = statUpload(root, image, now);
				if (stat.state !== "ok") return refuse(410, `${isTextUploadId(image) ? "file" : "image"} ${image} expired or was never uploaded; attach it again`);
				total += stat.size;
			}
			if (total > UPLOAD_MESSAGE_MAX_BYTES) return refuse(413, `${files ? "attachments" : "images"} total ${total} bytes; at most ${UPLOAD_MESSAGE_MAX_BYTES} per message`);
		}
		if (!running || record.state !== "ok") return hold(options, now, shape.body, req.headers["x-cp-control-token"], refuse, peer, shape.thread);
		if (!tokenMatches(req.headers["x-cp-control-token"], record.record.csrf)) return refuse(403, "control token missing or stale; reload the transcript");
		const reply = files
			? await controlRequest(record.record, "send_files", { ...shape.body, peer }, UPLOAD_SEND_TIMEOUT_MS)
			: images ? await controlRequest(record.record, "send_images", { ...shape.body, peer }, UPLOAD_SEND_TIMEOUT_MS)
			: await controlRequest(record.record, shape.body.kind === "abort" ? "abort" : "send", { ...shape.body, peer });
		if (reply.ok) return { status: 202, body: threaded(options, reply.result as ControlSendResponse, shape.thread, peer, now) };
		// The bridge journals its own request/outcome once the frame reached it; only transport failures are ours.
		if (reply.status === 503 || (reply.status === 504 && reply.error.startsWith("session "))) return refuse(reply.status, reply.error);
		// An older cp-bridge has no send_images op and journals nothing for it: our refused line is the only record.
		if (attachments.length && reply.status === 400 && /^unknown op/.test(reply.error)) return refuse(409, `unsupported: this session's cp-bridge predates ${files ? "text" : "image"} attachments; restart the session (⋮ → Restart session) and attach again`);
		return { status: reply.status, body: { error: reply.error } };
	});
}

/** No live operator session: hold the message in the inbox for the next session to deliver (filed under its thread, if any). */
function hold(options: ControlRouteOptions, now: Date, body: Body, token: unknown, refuse: Refuse, peer: string | null, thread: string | null): ControlRouteResult {
	if (!tokenMatches(token, INBOX_TOKEN)) return refuse(403, "inbox token missing or stale; reload the page");
	if (body.kind === "abort") return refuse(409, "nothing to abort; the operator session is offline");
	const inbox = readInbox(options.stateDir);
	if (inbox.error) return refuse(500, `inbox unreadable: ${inbox.error}`);
	if (inbox.held.length >= INBOX_MAX_HELD) return refuse(409, `the inbox already holds ${INBOX_MAX_HELD} messages; start the operator session to deliver them`);
	const id = body.kind === "message" && body.client_id ? body.client_id : heldId(now);
	if (inbox.held.some(message=>message.id === id)) return refuse(409, "client_id was already used; check the transcript before retrying");
	const written = appendInboxLine(options.stateDir, { type: "held", id, at: now.toISOString(), text: body.kind === "answer" ? `${body.ask_id}: ${body.label}` : body.text, ask_id: body.kind === "answer" ? body.ask_id : null, ...(thread ? { thread } : {}) });
	if (!written.ok) return refuse(500, `inbox unwritable (${controlInboxFile(options.stateDir)}): ${written.error}`);
	return { status: 202, body: threaded(options, { id, state: "held", deliver: "prompt" }, thread, peer, now) };
}

const runFixed: Run = (argv, timeoutMs, env) => new Promise((done) => {
	execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
		const code = (error as { code?: unknown } | null)?.code;
		done({ status: error ? (typeof code === "number" ? code : 1) : 0, output: `${stderr}${stdout}`.trim() || (error?.message ?? ""), stdout });
	});
});

const firstLine = (argv: readonly string[], ran: { status: number; output: string }): string => `${argv.slice(0, 3).join(" ")} exited ${ran.status}: ${ran.output.split("\n")[0]?.slice(0, 300) ?? ""}`;
/** A herdr id as its JSON gives it; anything else (an option, a space) is refused before it reaches an argv. */
const herdrId = (value: unknown): string | undefined => (typeof value === "string" && /^[\w][\w:.-]{0,99}$/.test(value) ? value : undefined);

/**
 * Start in herdr: the server must run; a `cp-operator` workspace at the home, then the wrapper typed into its root
 * pane. Fixed argv, the absolute herdr, ≤ 10 s per call; a failed `pane run` closes the workspace it created.
 */
async function startInHerdr(options: ControlRouteOptions, herdr: string, now: number, resume: boolean): Promise<string | null> {
	const start = (options.operatorStart ??= {});
	const run = start.run ?? runFixed;
	const wrapper = start.wrapper ?? operatorWrapperPath();
	if (!existsSync(wrapper)) return `${wrapper} is not installed: rerun cp-install`;
	if (!(await herdrRunning(options, herdr, now, true))) return "herdr server not running";
	start.lastAt = now;
	const home = resolve(options.home);
	const createArgv = [herdr, "workspace", "create", "--cwd", home, "--label", HERDR_WORKSPACE_LABEL, "--env", `CP_HOME=${home}`, "--no-focus"];
	const created = await run(createArgv, HERDR_TIMEOUT_MS);
	if (created.status !== 0) return firstLine(createArgv, created);
	let result: { workspace?: { workspace_id?: unknown }; root_pane?: { pane_id?: unknown } } | undefined;
	try {
		result = (JSON.parse(created.stdout ?? created.output) as { result?: typeof result }).result;
	} catch {
		return "herdr workspace create answered with output that is not JSON";
	}
	const workspace = herdrId(result?.workspace?.workspace_id);
	const pane = herdrId(result?.root_pane?.pane_id);
	const close = async () => { if (workspace) await run([herdr, "workspace", "close", workspace], HERDR_TIMEOUT_MS); };
	if (!workspace || !pane) {
		await close();
		return "herdr workspace create answered without a workspace id and a root pane id";
	}
	// One quoted `<command>` argument, never loose words: herdr would parse a `--session` among them itself.
	const runArgv = [herdr, "pane", "run", pane, herdrCommand(resume ? [wrapper, "-c"] : [wrapper])];
	const ran = await run(runArgv, HERDR_TIMEOUT_MS);
	if (ran.status === 0) return null;
	await close();
	return firstLine(runArgv, ran);
}

/**
 * `POST /api/operator/start`: the same chain, `{"via": "herdr" | "tmux"}` plus an optional `"resume": true`, the inbox
 * token, no live session, one start per 60 s, the fixed command. Resume adds only the fixed `-c` to the wrapper
 * (both launchers); pi -c with no previous session in this home starts a fresh one. tmux's "duplicate session" is
 * 409 `already_running` (a cp-operator tmux session exists: attach to it).
 */
export function handleOperatorStart(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "start", async (json, { peer, refuse, parsed }) => {
		const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
		const via = value?.via === "herdr" || value?.via === "tmux" ? value.via : undefined;
		const resume = value?.resume === true;
		// Exactly {via} or {via, resume: true}: any other key, or a resume that is not literally true, is refused.
		if (!value || !via || Object.keys(value).length !== (resume ? 2 : 1)) return refuse(400, 'body must be {"via": "herdr"} or {"via": "tmux"}, optionally with "resume": true');
		parsed({ kind: "start", text: null, ask_id: null, via });
		const session = operatorSession(options.stateDir);
		if (session.running) return refuse(409, `an operator session is already running (pid ${session.pid})`, undefined, { state: "already_running", via });
		if (!tokenMatches(req.headers["x-cp-control-token"], INBOX_TOKEN)) return refuse(403, "inbox token missing or stale; reload the page");
		const start = (options.operatorStart ??= {});
		if (start.lastAt !== undefined && now.getTime() - start.lastAt < OPERATOR_START_WINDOW_MS) {
			const wait = Math.max(1, Math.ceil((start.lastAt + OPERATOR_START_WINDOW_MS - now.getTime()) / 1000));
			return refuse(429, `one start per ${OPERATOR_START_WINDOW_MS / 1000} s; retry in ${wait} s`, { "retry-after": String(wait) });
		}
		const answer = (status: number, state: "starting" | "unavailable", reason: string | null): ControlRouteResult => {
			const audit = appendControlAudit(options.stateDir, { type: "start", by: "viewer", id: null, at: now.toISOString(), peer, via, ...(resume ? { resume } : {}), state, reason });
			if (!audit.ok) log(options)(`viewer: operator start audit line unwritten: ${audit.error}\n`);
			return { status, body: { state, via, ...(resume ? { resume } : {}), ...(reason ? { reason } : {}), ...(audit.ok ? {} : { audit: `unwritten: ${audit.error}` }) } satisfies OperatorStartResponse & { audit?: string } };
		};
		if (via === "herdr") {
			const herdr = herdrPath(options);
			const failed = herdr ? await startInHerdr(options, herdr, now.getTime(), resume) : "herdr is not on PATH";
			return failed ? answer(503, "unavailable", failed) : answer(202, "starting", null);
		}
		const tmux = tmuxStart(options, resume);
		if ("reason" in tmux) return answer(503, "unavailable", tmux.reason);
		start.lastAt = now.getTime();
		const ran = await (start.run ?? runFixed)(tmux.argv, TMUX_TIMEOUT_MS, tmuxEnv(options));
		if (ran.status !== 0 && /duplicate session/i.test(ran.output)) return refuse(409, `a tmux session ${OPERATOR_TMUX_SESSION} already runs: tmux attach -t ${OPERATOR_TMUX_SESSION}`, undefined, { state: "already_running", via });
		if (ran.status !== 0) return answer(503, "unavailable", firstLine(tmux.argv, ran));
		return answer(202, "starting", null);
	});
}

/** A queued request the parent did not take within the expiry is shown expired: it will never be applied. */
function requestView(request: ScheduleControlRequest, now: Date): ScheduleControlStatusResponse["requests"][number] {
	const stale = request.state === "queued" && !(now.getTime() - Date.parse(request.at) <= SCHEDULE_CONTROL_MAX_AGE_MS);
	return {
		id: request.id, at: request.at, op: request.op, schedule_id: request.schedule_id, ...(request.revision !== undefined ? {revision:request.revision} : {}), ...(request.client_id ? {client_id:request.client_id} : {}),
		state: stale ? "expired" : request.state,
		reason: stale ? `not taken by the parent within ${SCHEDULE_CONTROL_MAX_AGE_MS / 1000} s; it will not be applied` : request.reason,
		job_id: request.job_id,
	};
}

/** `GET /api/schedules/control` (cp-hhuf P6): the opt-out, the schedule token while on, the parent, recent requests. */
export function handleScheduleControlStatus(_req: IncomingMessage, options: ControlRouteOptions, now = new Date()): ControlRouteResult {
	if (options.requireTailnet !== true) return { status: 403, body: { error: "schedule controls are served only under --require-tailnet" } };
	const config = readControlConfig(options.stateDir);
	const enabled = config.state === "on";
	const parent = parentHolder(options.stateDir);
	const journal = readScheduleControl(options.stateDir);
	const body: ScheduleControlStatusResponse = {
		generated_at: now.toISOString(), enabled, token: enabled ? SCHEDULE_TOKEN : null, parent,
		reason: !enabled ? `Dashboard control is off: ${config.reason}` : parent.running ? null : `Parent not running: ${parent.reason}`,
		requests: journal.requests.slice(-20).map((request) => requestView(request, now)), error: journal.error,
	};
	return { status: 200, body };
}

/**
 * `POST /api/schedules/request` (cp-hhuf P6): the shared chain, then exactly `{op, schedule_id}`, the parent running,
 * the schedule token, the schedule existing, at most 20 pending; 202 only once the `request` line is appended.
 */
export function handleScheduleControl(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "schedule", async (json, { peer, refuse, parsed }) => {
		const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
		const op = (SCHEDULE_CONTROL_OPS as readonly unknown[]).includes(value?.op) ? (value?.op as ScheduleControlOp) : undefined;
		const scheduleId = typeof value?.schedule_id === "string" && SCHEDULE_ID.test(value.schedule_id) ? value.schedule_id : undefined;
		parsed({ kind: "schedule", text: null, ask_id: null, ...(op ? { op } : {}), ...(scheduleId ? { schedule_id: scheduleId } : {}) });
		if (!value || !op || !scheduleId || Object.keys(value).some(k=>!["op","schedule_id","revision","policy","client_id"].includes(k))) return refuse(400, 'body must be {op, schedule_id, revision?, policy?, client_id?}');
		const invalid = scheduleControlFieldError(value);
		if (invalid) return refuse(400, invalid);
		const parent = parentHolder(options.stateDir);
		if (!parent.running) return refuse(503, `parent not running: ${parent.reason}; schedule controls apply only while it holds the home`);
		if (!tokenMatches(req.headers["x-cp-control-token"], SCHEDULE_TOKEN)) return refuse(403, "control token missing or stale; reload the page");
		let known: boolean;
		try {
			known = readScheduleFile(join(options.stateDir, "schedules.json")).some((entry) => entry.id === scheduleId);
		} catch (error) {
			return refuse(503, `schedules unreadable: ${(error as Error).message}`);
		}
		if (!known) return refuse(404, `no schedule ${scheduleId}`);
		const journal = readScheduleControl(options.stateDir);
		if (journal.error) return refuse(500, `schedule control journal unreadable: ${journal.error}`);
		const duplicate = value.client_id ? journal.requests.find(r=>r.client_id === value.client_id) : undefined;
		if (duplicate) return {status:202,body:{id:duplicate.id,state:requestView(duplicate,now).state}};
		const pending = journal.requests.filter((request) => requestView(request, now).state === "queued").length;
		if (pending >= SCHEDULE_CONTROL_MAX_PENDING) return refuse(409, `${SCHEDULE_CONTROL_MAX_PENDING} schedule requests already wait for the parent`);
		const id = scheduleRequestId(now);
		const fields: ScheduleControlFields = { ...(value.revision !== undefined ? {revision:value.revision as number} : {}), ...(value.policy !== undefined ? {policy:value.policy as NonNullable<ScheduleControlFields["policy"]>} : {}), ...(value.client_id ? {client_id:value.client_id as string} : {}) };
		const written = appendScheduleControlLine(options.stateDir, { type: "request", by: "viewer", id, at: now.toISOString(), peer, op, schedule_id: scheduleId, ...fields });
		if (!written.ok) return refuse(500, `schedule control journal unwritable (${scheduleControlFile(options.stateDir)}): ${written.error}`);
		return { status: 202, body: { id, state: "queued" } satisfies ScheduleControlSendResponse };
	});
}

/** `GET /api/answers/control` (cp-mxk4): the opt-out and the ack token while control is on (--require-tailnet only, never writes). */
export function handleAnswersControlStatus(_req: IncomingMessage, options: ControlRouteOptions, now = new Date()): ControlRouteResult {
	if (options.requireTailnet !== true) return { status: 403, body: { error: "answer acknowledgement is served only under --require-tailnet" } };
	const config = readControlConfig(options.stateDir);
	const enabled = config.state === "on";
	const body: AnswersControlStatusResponse = { generated_at: now.toISOString(), enabled, reason: enabled ? null : `Dashboard control is off: ${config.reason}`, token: enabled ? ANSWER_TOKEN : null };
	return { status: 200, body };
}

/**
 * `POST /api/answers/ack` (cp-mxk4): the shared chain, then exactly `{id}`, the answer token, the id known and not yet
 * acknowledged; 202 only once the `acked` line is appended. Needs no operator session and no parent, reaches neither,
 * and is not an operator decision: it only moves the answer from the open list to the history.
 */
export function handleAnswerAck(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "answer_ack", async (json, { peer, refuse, parsed }) => {
		const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
		const id = isAnswerId(value?.id) ? value.id : undefined;
		parsed({ kind: "answer_ack", text: null, ask_id: null, ...(id ? { answer_id: id } : {}) });
		if (!value || !id || Object.keys(value).length !== 1) return refuse(400, 'body must be {"id": "ans-<12 hex>"}');
		if (!tokenMatches(req.headers["x-cp-control-token"], ANSWER_TOKEN)) return refuse(403, "control token missing or stale; reload the page");
		const journal = readAnswers(options.stateDir);
		if (journal.error) return refuse(500, `answers unreadable: ${journal.error}`);
		const known = journal.answers.find((answer) => answer.id === id);
		if (!known) return refuse(404, `no answer ${id}`);
		if (known.acked_at !== null) return refuse(409, `${id} was already acknowledged at ${known.acked_at}`);
		const at = now.toISOString().replace(/\.\d{3}Z$/, "Z"); // the journal's timestamp form has no milliseconds
		const written = appendAnswerLine(options.stateDir, { type: "acked", by: "viewer", id, at, peer });
		if (!written.ok) return refuse(500, `answers journal unwritable (${operatorAnswersFile(options.stateDir)}): ${written.error}`);
		return { status: 202, body: { id, state: "acked", acked_at: at } satisfies AnswerAckResponse };
	});
}
