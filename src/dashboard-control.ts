/**
 * Dashboard control, the operator session's half (cp-dashboard-operator-control). Loaded by the cp-bridge
 * extension, so it runs only in the operator's own pi session. It owns an owner-only Unix socket
 * (`state/operator/dashboard.sock`) and a 0600 record (`state/operator/dashboard.json`: pid, socket token,
 * per-session CSRF token); the viewer's one control route forwards authenticated frames to it
 * (src/viewer/control-api.ts). No new network listener: with no operator session there is no socket.
 *
 * Frames are NDJSON `{v, token, id, op, args}`; a wrong socket token closes the connection. Ops:
 *  - `status` → busy, pending, session file, last outcomes (no side effect, no journal line);
 *  - `send` → a composer message or a decision-card click, injected as a **user message**, exactly what the
 *    human could type: never a `cp_decide`, never a parent call, never a write to the ask journal;
 *  - `send_images` → a composer message with image attachments (src/viewer/uploads.ts ids): each upload is read,
 *    resized by `prepareImage` and injected as image parts (`userMessageContent`); only a bridge with `prepareImage`
 *    knows the op, so an older one answers `unknown op` and the viewer asks for a restart instead of dropping images;
 *  - cp-y43c: a composer message (not a steer) while the session is busy, or behind one, is **queued by the dashboard**,
 *    not given to pi: `outcome queued`, then each settled turn (`settled()`) hands over the oldest one
 *    (`injected` journaled first). `queue_edit` / `queue_cancel` change it until then (control-queue.ts);
 *  - `abort` → abort the running turn;
 *  - `restart` → Restart session (src/dashboard-restart.ts): checks, a relaunch marker, then pi's own shutdown.
 *  - `settings_get` / `settings_apply` → Settings (src/settings-control.ts), only with the `settings` port; they write
 *    no dashboard.jsonl line, their record is data/settings-audit.jsonl.
 * Every `send`/`abort` appends its `request` line to `state/operator/dashboard.jsonl` before anything happens;
 * a request that cannot be journaled is refused and never injected. At listen (cp-daemon P3) the messages the
 * dashboard held in `state/operator/inbox.jsonl` while no session ran are delivered once (`deliverInbox`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, join, resolve } from "node:path";
import { OperatorAsks } from "./operator-asks.ts";
import { restartRequest, restartState } from "./dashboard-restart.ts";
import { appendControlAudit, appendInboxLine } from "./viewer/control-audit.ts";
import {
	CONTROL_PROTOCOL, CONTROL_TEXT_MAX, type ControlAuditLine, type ControlDeliver, type ControlKind, controlRecordFile, controlSocketFile,
	dashboardMarker, DASHBOARD_ID_RE, INBOX_MAX_AGE_MS, type InboxLine, isAskId, normalizeThreadTag, readControlConfig, readControlRecord, readUploadMetadata,
} from "./viewer/control-files.ts";
import { readInbox } from "./viewer/control-inbox.ts";
import { dashboardHeld, readQueueJournal } from "./viewer/control-queue.ts";
import { LOADED_COMMIT } from "./viewer/loaded-commit.ts";
import { IMAGE_LONG_EDGE, IMAGE_PREP_MS, inlineBudget, inlineTextFiles, isImageUploadId, isTextUploadId, readUpload, statUpload, UPLOAD_MAX_PER_MESSAGE, UPLOAD_MESSAGE_MAX_BYTES, uploadFile, uploadRoot } from "./viewer/uploads.ts";

/** Linux `sun_path` is 108 bytes including the NUL. */
const MAX_SOCKET_PATH = 107;
const MAX_FRAME_CHARS = 64 * 1024;
const RECENT_KEEP = 10;
const OPEN_KEEP = 100;

/** One image part as pi takes it: base64 `data` (already within the inline budget) and its mime type. */
export interface InlineImage { data: string; mimeType: string }
export type UserMessageContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

/**
 * What the bridge hands `pi.sendUserMessage`: the text alone, or with images one text part then one image part per
 * image (pi joins the text parts and passes the images to the prompt, never expanding templates).
 */
export function userMessageContent(text: string, images?: readonly InlineImage[]): UserMessageContent {
	if (!images?.length) return text;
	return [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
}

export interface ControlPorts {
	/** Deliver `text` (and inlined images) as a user message; `deliverAs` undefined when the session is idle. May return a promise that rejects on failure. */
	inject(text: string, deliverAs: "steer" | "followUp" | undefined, images?: InlineImage[]): void | Promise<unknown>;
	/** Image attachments: resize to the long edge and base64 budget, or null when that cannot be done. Absent: `send_images` is an unknown op. */
	prepareImage?(bytes: Uint8Array, mimeType: string, limits: { maxEdge: number; maxBytes: number }): Promise<InlineImage | null>;
	abort(): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	sessionFile(): string | undefined;
	/** Restart session (src/dashboard-restart.ts); any of the three absent means restart is unsupported. */
	shutdown?(): void;
	relaunchFile?(): string | undefined;
	parentSends?(): { ids: string[]; error: string | null };
	/** Settings (src/settings-control.ts); absent: settings_get/settings_apply are unknown ops; their record is data/settings-audit.jsonl. */
	settings?: { get(): unknown; apply(args: Record<string, unknown>): { status: number } };
}

export interface ControlOutcome { id: string; kind: ControlKind; state: string; at: string; reason: string | null; ask_id: string | null }

export interface DashboardControl {
	state: "listening";
	socket: string;
	/** Feed every message the session starts or sends to the model; a dashboard marker marks its request delivered. */
	observe(message: unknown): void;
	/** cp-y43c: the session's turn settled; hand the oldest dashboard-queued message over (at most one per turn). */
	settled(): void;
	stop(): void;
}

export interface StartOptions {
	stateDir: string;
	ports: ControlPorts;
	now?: () => Date;
	deliveredWaitMs?: number;
	duplicateWindowMs?: number;
	log?: (line: string) => void;
	append?: (line: ControlAuditLine) => { ok: true } | { ok: false; error: string };
	/** Image attachments' upload root (src/viewer/uploads.ts `uploadRoot`); default `CP_UPLOAD_ROOT`, else the production root. */
	uploadRoot?: string;
	/** How long preparing a message's images may take before nothing is sent (default 15 s). A test seam. */
	imagePrepMs?: number;
}

type Reply = { ok: true; result: unknown } | { ok: false; status: number; error: string; result?: unknown };

const stamp = (date: Date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
export const newControlId = (now: Date): string => `dc-${stamp(now)}-${randomBytes(4).toString("hex")}`;

function answers(path: string): Promise<boolean> {
	return new Promise((done) => {
		const socket = createConnection(path);
		const finish = (yes: boolean) => { clearTimeout(timer); socket.destroy(); done(yes); };
		const timer = setTimeout(() => finish(true), 2_000); // never unlink on doubt
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function textOf(message: unknown): string | undefined {
	const m = message as { role?: unknown; content?: unknown } | null;
	if (!m || typeof m !== "object" || m.role !== "user") return undefined;
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return undefined;
	return m.content.map((block: { type?: unknown; text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
}

export async function startDashboardControl(options: StartOptions): Promise<{ state: "off" | "refused"; reason: string } | DashboardControl> {
	const { stateDir, ports } = options;
	const now = options.now ?? (() => new Date());
	const log = options.log ?? ((line: string) => process.stderr.write(line));
	const append = options.append ?? ((line: ControlAuditLine) => appendControlAudit(stateDir, line));
	const waitMs = options.deliveredWaitMs ?? 2_000;
	const duplicateMs = options.duplicateWindowMs ?? 600_000;
	const startedAt = now().toISOString();
	const config = readControlConfig(stateDir);
	if (config.state !== "on") return { state: "off", reason: config.reason };
	const socketPath = controlSocketFile(stateDir);
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) return { state: "refused", reason: `socket path is too long for a Unix socket (${socketPath})` };
	mkdirSync(join(stateDir, "operator"), { recursive: true, mode: 0o700 });

	const token = randomBytes(32).toString("hex");
	const csrf = randomBytes(32).toString("hex");
	const recent: ControlOutcome[] = [];
	/** Injected requests not yet seen in the session, by id. */
	const open = new Map<string, { kind: ControlKind; askId: string | null; peer: string | null; seen?: () => void }>();
	/** Clicks by ask id, for the duplicate-click window. */
	const clicks = new Map<string, { at: number; id: string }>();

	/** One `outcome` line; `track: false` keeps it out of the status op's recent rows (a dashboard-queued message). */
	const outcome = (id: string, kind: ControlKind, askId: string | null, peer: string | null, state: ControlOutcome["state"], reason: string | null, track = true) => {
		const at = now().toISOString();
		const written = append({ type: "outcome", by: "bridge", id, at, peer, state: state as never, reason });
		if (!written.ok) log(`cp-bridge: dashboard control outcome ${id} ${state} not journaled: ${written.error}\n`);
		if (!track) return written;
		const row = { id, kind, state, at, reason, ask_id: askId };
		const index = recent.findIndex((r) => r.id === id);
		if (index >= 0) recent.splice(index, 1);
		recent.push(row);
		if (recent.length > RECENT_KEEP) recent.shift();
		if (state === "failed" && askId && clicks.get(askId)?.id === id) clicks.delete(askId);
		return written;
	};

	const root = uploadRoot(options.uploadRoot);
	const prepMs = options.imagePrepMs ?? IMAGE_PREP_MS;
	type Prepared = { inline: InlineImage[]; paths: string[] } | { status: number; error: string };
	const unreadable = (image: string, stat: { state: "missing" } | { state: "invalid"; reason: string }): Prepared =>
		stat.state === "missing" ? { status: 410, error: `image ${image} expired or was never uploaded; attach it again` } : { status: 400, error: `image ${image} is not a readable upload: ${stat.reason}` };
	/** Every id must exist before any work; then each is read and resized in turn, all within `prepMs` or nothing is sent. */
	const prepareImages = async (ids: string[]): Promise<Prepared> => {
		for (const image of ids) {
			const stat = statUpload(root, image, now());
			if (stat.state !== "ok") return unreadable(image, stat);
		}
		const work = (async (): Promise<Prepared> => {
			const inline: InlineImage[] = [];
			const paths: string[] = [];
			for (const image of ids) {
				const read = readUpload(root, image, now());
				if (read.state !== "ok") return unreadable(image, read);
				const out = await ports.prepareImage!(read.bytes, read.mime, { maxEdge: IMAGE_LONG_EDGE, maxBytes: inlineBudget(ids.length) }).catch(() => null);
				// pi could not take it as an image part: the model still gets the file, by path (the task's fallback).
				if (out) inline.push(out);
				else paths.push(`[image ${image} could not be attached inline; file: ${read.path}]`);
			}
			return { inline, paths };
		})();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<Prepared>((resolve) => { timer = setTimeout(() => resolve({ status: 504, error: `image preparation exceeded ${prepMs / 1000} s; nothing was sent` }), prepMs); });
		try {
			return await Promise.race([work, late]);
		} finally {
			clearTimeout(timer);
		}
	};

	const request = async (args: Record<string, unknown>, op: "send" | "abort", withImages = false, withFiles = false): Promise<Reply> => {
		const kind: ControlKind = op === "abort" ? "abort" : args.kind === "answer" ? "answer" : "message";
		const peer = typeof args.peer === "string" ? args.peer.slice(0, 100) : null;
		const askId = kind === "answer" && isAskId(args.ask_id) ? args.ask_id : null;
		const label = typeof args.label === "string" ? args.label : "";
		const text = kind === "message" ? (typeof args.text === "string" ? args.text.trim() : "") : kind === "answer" ? `${askId ?? String(args.ask_id)}: ${label}` : null;
		// Attachment ids as sent (clipped), journaled with the request; never contents.
		const images = withImages && (args.images !== undefined || !withFiles) ? (Array.isArray(args.images) ? args.images.slice(0, UPLOAD_MAX_PER_MESSAGE + 1).map((image) => String(image).slice(0, 64)) : []) : undefined;
		const files = withFiles ? (Array.isArray(args.files) ? args.files.slice(0, UPLOAD_MAX_PER_MESSAGE + 1).map((file) => String(file).slice(0, 64)) : []) : undefined;
		const idle = ports.isIdle();
		const deliverAs = kind === "abort" || idle ? undefined : args.deliver === "steer" ? "steer" : "followUp";
		const deliver: ControlDeliver = kind === "abort" ? "abort" : deliverAs ?? "prompt";
		const supplied = kind === "message" && typeof args.client_id === "string" && DASHBOARD_ID_RE.test(args.client_id) ? args.client_id : null;
		const duplicate = supplied !== null && (open.has(supplied) || recent.some(row=>row.id === supplied) || queue.some((entry) => entry.id === supplied) || handed.has(supplied));
		const id = supplied && !duplicate ? supplied : newControlId(now());
		const tag = normalizeThreadTag(args.thread);
		const sessionFile = ports.sessionFile();
		const journaled = append({ type: "request", by: "bridge", id, at: now().toISOString(), peer, kind, text, ask_id: askId, deliver, session_started_at: startedAt, ...(sessionFile ? {session_file: sessionFile} : {}), ...(images ? { images } : {}), ...(files ? { files } : {}), ...(tag ? { thread: tag } : {}) });
		if (!journaled.ok) return { ok: false, status: 500, error: `failed: audit journal unwritable (${journaled.error})` };
		const refuse = (status: number, reason: string): Reply => {
			outcome(id, kind, askId, peer, "refused", reason);
			return { ok: false, status, error: reason };
		};
		const latest = readControlConfig(stateDir);
		if (duplicate) return refuse(409, "client_id was already used; check the transcript before retrying");
		if (latest.state !== "on") return refuse(403, `dashboard control is off (${latest.reason})`);
		if (kind === "abort") {
			if (idle) return refuse(409, "session is idle; nothing to abort");
			try { ports.abort(); } catch (error) { outcome(id, kind, null, peer, "failed", (error as Error).message); return { ok: false, status: 502, error: `failed: ${(error as Error).message}` }; }
			outcome(id, kind, null, peer, "delivered", null);
			return { ok: true, result: { id, state: "delivered", deliver } };
		}
		const thread = args.thread === undefined ? null : normalizeThreadTag(args.thread);
		if (args.thread !== undefined && thread === null) return refuse(400, "thread must be a tag: 1-32 of a-z 0-9 -, starting with a letter or digit");
		if (images && (kind !== "message" || images.length < 1 || images.length > UPLOAD_MAX_PER_MESSAGE || new Set(images).size !== images.length || !images.every(isImageUploadId))) return refuse(400, `images must be 1-${UPLOAD_MAX_PER_MESSAGE} distinct upload ids`);
		if (files && (kind !== "message" || files.length < 1 || files.length > UPLOAD_MAX_PER_MESSAGE || new Set(files).size !== files.length || !files.every(isTextUploadId))) return refuse(400, `files must be 1-${UPLOAD_MAX_PER_MESSAGE} distinct text upload ids`);
		const attachments = [...(images ?? []), ...(files ?? [])];
		if (attachments.length > UPLOAD_MAX_PER_MESSAGE) return refuse(400, `at most ${UPLOAD_MAX_PER_MESSAGE} attachments per message`);
		if (images && !ports.prepareImage) return refuse(409, "image attachments unsupported; restart the operator session");
		if (kind === "message" && ((!text && !attachments.length) || (text ?? "").length > CONTROL_TEXT_MAX)) return refuse(400, `text must be 1-${CONTROL_TEXT_MAX} characters`);
		let total = 0;
		for (const attachment of attachments) {
			const stat = statUpload(root, attachment, now());
			if (stat.state !== "ok") return refuse(stat.state === "missing" ? 410 : 400, `${isTextUploadId(attachment) ? "file" : "image"} ${attachment} expired or was never uploaded; attach it again`);
			total += stat.size;
		}
		if (total > UPLOAD_MESSAGE_MAX_BYTES) return refuse(413, `attachments total ${total} bytes; at most ${UPLOAD_MESSAGE_MAX_BYTES} per message`);
		if (kind === "answer") {
			if (!askId) return refuse(400, "ask_id must be an ask id");
			let ask;
			try { ask = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).list().find((item) => item.id === askId); }
			catch (error) { return refuse(500, `asks unreadable: ${(error as Error).message}`); }
			if (!ask) return refuse(400, `unknown ask ${askId}`);
			if (ask.state !== "open") return refuse(409, `${askId} is ${ask.state}; nothing to answer`);
			if (!ask.options.some((option) => option.label === label)) return refuse(400, `"${label}" is not an option of ${askId}`);
			const prior = clicks.get(askId);
			if (prior && now().getTime() - prior.at < duplicateMs) return refuse(409, `${askId} was already answered from the dashboard (${prior.id}); wait for the session to record it`);
			clicks.set(askId, { at: now().getTime(), id });
		}
		// cp-y43c: busy, or behind an earlier queued message: the dashboard holds it (journaled) until the session settles.
		// Also while a handoff is unfinished (review 3): `handing` is set from the shift, through image/file preparation,
		// until that turn settles or fails, so a send made with the queue just emptied still goes behind it.
		if (kind === "message" && deliver !== "steer" && (!idle || queue.length > 0 || inboxAt !== null || handing !== null)) {
			const held = outcome(id, kind, askId, peer, "queued", null, false);
			if (!held.ok) return refuse(500, `failed: audit journal unwritable (${held.error})`);
			queue.push({ id, at: now().toISOString(), peer, text: text ?? "", askId, ...(images ? { images } : {}), ...(files ? { files } : {}), ...(thread ? { thread } : {}) });
			settle(false);
			return { ok: true, result: { id, state: "queued", deliver, editable: true } };
		}
		return handOver({ id, kind, askId, peer, text, images, files, thread }, deliverAs, deliver, refuse, false);
	};

	/**
	 * Give one message to pi: the attachments are read and prepared, the `injected` line is journaled, then pi gets the
	 * text. From the queue (`queued`) the line must be on disk before pi is called, or the message goes back to the head:
	 * a restarted bridge reloads only ids with no `injected` line, so it never hands one over twice. A direct send waits
	 * up to `waitMs` for the sighting to answer delivered or queued, as before.
	 */
	type Handing = { id: string; kind: ControlKind; askId: string | null; peer: string | null; text: string | null; images?: string[]; files?: string[]; thread: string | null };
	const handOver = async (entry: Handing, deliverAs: "steer" | "followUp" | undefined, deliver: ControlDeliver, refuse: (status: number, reason: string) => Reply, queued: boolean): Promise<Reply> => {
		const { id, kind, askId, peer, text, images, files, thread } = entry;
		const metadata = readUploadMetadata(stateDir, files ?? []);
		const textFiles: { name: string; path: string; bytes: Uint8Array }[] = [];
		for (const file of files ?? []) {
			const read = readUpload(root, file, now());
			if (read.state !== "ok") return refuse(read.state === "missing" ? 410 : 400, `file ${file} is not readable; attach it again`);
			textFiles.push({ name: metadata.get(file)?.name ?? file, path: resolve(read.path), bytes: read.bytes });
		}
		const fileText = inlineTextFiles(textFiles);
		let prepared: { inline: InlineImage[]; paths: string[] } = { inline: [], paths: [] };
		if (images) {
			const out = await prepareImages(images);
			if ("status" in out) return refuse(out.status, out.error);
			prepared = out;
		}
		const { inline, paths } = prepared;
		// Stopped while preparing: no `injected` line, never given to pi; the next bridge reloads it as queued.
		if (queued && stopped) return { ok: false, status: 503, error: "dashboard control stopped before the handoff" };
		const claimed = outcome(id, kind, askId, peer, "injected", paths.length ? `${paths.length} image(s) sent as a file path (resize failed)` : null);
		if (!claimed.ok && queued) return { ok: false, status: 500, error: `failed: audit journal unwritable (${claimed.error})` };
		if (queued) {
			// Claimed: from here an edit or cancel is refused as already sent, with the text pi is given.
			preparing.delete(id);
			handed.set(id, text ?? "");
			if (handed.size > OPEN_KEEP) handed.delete(handed.keys().next().value!);
		}
		const seen = new Promise<"delivered">((resolve) => open.set(id, { kind, askId, peer, seen: () => resolve("delivered") }));
		if (open.size > OPEN_KEEP) open.delete(open.keys().next().value!);
		let result: Promise<unknown> | void;
		try {
			const fallback = paths.length ? `${paths.join("\n")}\n\n` : "";
			// One plain line per image before the marker: where the upload lives, and that it is swept (UPLOAD_MAX_AGE_MS = 7 days).
			const imageLines = images?.length ? `${images.map((image) => `image: ${resolve(uploadFile(root, image)!)} (deleted after 7 days; copy it if needed longer)`).join("\n")}\n\n` : "";
			result = ports.inject(`${text ? `${text}\n\n` : ""}${fallback}${imageLines}${fileText}${dashboardMarker(id, askId, images, thread, files)}`, queued ? (ports.isIdle() ? undefined : "followUp") : deliverAs, inline.length ? inline : undefined);
		} catch (error) {
			open.delete(id);
			outcome(id, kind, askId, peer, "failed", (error as Error).message);
			return { ok: false, status: 502, error: `failed: ${(error as Error).message}` };
		}
		const failed = Promise.resolve(result).then(() => new Promise<never>(() => {}), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
		if (queued) {
			// Nobody waits on a handoff: a later rejection names itself, a sighting is journaled by observe().
			void failed.then((late) => { if (open.delete(id)) outcome(id, kind, askId, peer, "failed", late.error); handoffEnded(id); });
			return { ok: true, result: { id, state: "injected", deliver } };
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([seen, failed, new Promise<"queued">((resolve) => { timer = setTimeout(() => resolve("queued"), waitMs); })]);
		clearTimeout(timer);
		if (typeof settled === "object") {
			open.delete(id);
			outcome(id, kind, askId, peer, "failed", settled.error);
			return { ok: false, status: 502, error: `failed: ${settled.error}` };
		}
		if (settled === "queued") {
			outcome(id, kind, askId, peer, "queued", null);
			// A later rejection still names itself; a later sighting is journaled by observe().
			void failed.then((late) => { if (open.delete(id)) outcome(id, kind, askId, peer, "failed", late.error); });
		}
		return { ok: true, result: { id, state: settled, deliver } };
	};

	/**
	 * cp-y43c, the dashboard queue: messages sent while the session was busy, oldest first, never yet given to pi.
	 * `settle` hands over at most one per settled turn, only while the session is idle and no earlier handoff is still
	 * unseen. The shift is synchronous: an edit or cancel lands before it; between it and the `injected` claim (image
	 * preparation) it is refused 503 "being handed over"; after the claim, 409 already sent.
	 * FIFO across a restart: the offline inbox turn (messages typed while no session ran) takes its place by time —
	 * every held message older than its oldest line goes first (addendum 2 review).
	 */
	type Held = { id: string; at: string; peer: string | null; text: string; askId: string | null; images?: string[]; files?: string[]; thread?: string };
	const queue: Held[] = [];
	/** The id last handed over (or INBOX), until it fails or a turn settles: one handoff per settled turn. */
	let handing: string | null = null;
	const INBOX = "inbox";
	/** Text each recent claimed handoff carried: what "already sent" shows. */
	const handed = new Map<string, string>();
	/** Shifted off the queue, not yet claimed: neither editable nor sent. */
	const preparing = new Set<string>();
	/** The offline inbox, once per session start, at the time of its oldest held line (none: no inbox turn). */
	const inbox = readInbox(stateDir);
	let inboxAt: number | null = inbox.held.length ? Math.min(...inbox.held.map((message) => Date.parse(message.at))) : null;
	const handoffEnded = (id: string) => {
		if (handing !== id) return;
		handing = null;
		settle(false); // no turn ran: the next one may go
	};
	function settle(turnEnded: boolean): void {
		if (turnEnded) handing = null;
		while (!stopped && handing === null && (queue.length || inboxAt !== null) && ports.isIdle()) {
			if (readControlConfig(stateDir).state !== "on") return;
			if (inboxAt !== null && !(queue.length && Date.parse(queue[0]!.at) < inboxAt)) {
				inboxAt = null;
				handing = INBOX;
				if (!deliverInbox(stateDir, ports, now(), log, () => handoffEnded(INBOX)).delivered) handing = null;
				continue;
			}
			const entry = queue.shift()!;
			if (!(now().getTime() - Date.parse(entry.at) <= INBOX_MAX_AGE_MS)) {
				outcome(entry.id, "message", entry.askId, entry.peer, "dropped", "queued longer than 24 h");
				continue;
			}
			handing = entry.id;
			preparing.add(entry.id);
			const refuse = (status: number, reason: string): Reply => { outcome(entry.id, "message", entry.askId, entry.peer, "refused", reason); return { ok: false, status, error: reason }; };
			void handOver({ ...entry, kind: "message", thread: entry.thread ?? null }, undefined, "prompt", refuse, true).then((reply) => {
				preparing.delete(entry.id);
				if (reply.ok || stopped) return;
				if (reply.status === 500) {
					// The handoff line never reached the journal: pi was not called, so the message is still the dashboard's.
					queue.unshift(entry);
					log(`cp-bridge: dashboard queue ${entry.id} kept queued: ${reply.error}\n`);
					if (handing === entry.id) handing = null;
					return;
				}
				handoffEnded(entry.id);
			});
		}
	}

	/** `queue_edit` / `queue_cancel`: only a message the dashboard still holds; 404 an id the journal never named. */
	const queueRequest = (args: Record<string, unknown>, op: "queue_edit" | "queue_cancel"): Reply => {
		const id = typeof args.id === "string" && DASHBOARD_ID_RE.test(args.id) ? args.id : null;
		const peer = typeof args.peer === "string" ? args.peer.slice(0, 100) : null;
		if (!id) return { ok: false, status: 400, error: "id must be a dashboard id" };
		const index = queue.findIndex((entry) => entry.id === id);
		if (index < 0) {
			if (preparing.has(id)) return { ok: false, status: 503, error: `${id} is being handed to the session; try again in a moment`, result: { id, state: "handing" } };
			const sent = handed.get(id);
			if (sent !== undefined) return { ok: false, status: 409, error: `already sent: ${id} was handed to the session`, result: { id, state: "sent", text: sent } };
			const journal = readQueueJournal(stateDir);
			if (journal.error) return { ok: false, status: 500, error: `dashboard journal unreadable: ${journal.error}` };
			const known = journal.messages.get(id);
			if (!known) return { ok: false, status: 404, error: `no queued message ${id}` };
			if (known.injected) return { ok: false, status: 409, error: `already sent: ${id} was handed to the session`, result: { id, state: "sent", text: known.text } };
			return { ok: false, status: 409, error: `${id} is ${known.state}; only a queued message can be ${op === "queue_edit" ? "edited" : "cancelled"}`, result: { id, state: known.state, text: known.text } };
		}
		const entry = queue[index]!;
		if (op === "queue_cancel") {
			const written = outcome(id, "message", entry.askId, peer, "cancelled", "cancelled from the dashboard");
			if (!written.ok) return { ok: false, status: 500, error: `failed: audit journal unwritable (${written.error})` };
			queue.splice(index, 1);
			return { ok: true, result: { id, state: "cancelled" } };
		}
		const text = typeof args.text === "string" ? args.text.trim() : "";
		if ((!text && !entry.images?.length && !entry.files?.length) || text.length > CONTROL_TEXT_MAX) return { ok: false, status: 400, error: `text must be 1-${CONTROL_TEXT_MAX} characters` };
		const written = append({ type: "edited", by: "bridge", id, at: now().toISOString(), peer, text });
		if (!written.ok) return { ok: false, status: 500, error: `failed: audit journal unwritable (${written.error})` };
		entry.text = text;
		return { ok: true, result: { id, state: "queued", text, editable: true } };
	};

	const handle = async (frame: Record<string, unknown>): Promise<Reply & { after?: () => void }> => {
		const args = frame.args !== null && typeof frame.args === "object" && !Array.isArray(frame.args) ? (frame.args as Record<string, unknown>) : {};
		if (frame.op === "hello") return { ok: true, result: { pid: process.pid, protocol: CONTROL_PROTOCOL } };
		if (frame.op === "status") {
			const file = ports.sessionFile();
			return { ok: true, result: { busy: !ports.isIdle(), pending: ports.hasPendingMessages(), session_file: file ? basename(file) : null, recent: [...recent], restart: restartState({ ports, stateDir, open, clicks }), files: true, ...(ports.prepareImage ? { images: true } : {}) } };
		}
		if (frame.op === "send" || frame.op === "abort") return request(args, frame.op);
		// A bridge without prepareImage answers `unknown op send_images`: the viewer says restart, never drops the images.
		if (frame.op === "send_images" && ports.prepareImage) return request(args, "send", true);
		if (frame.op === "send_files") return request(args, "send", true, true);
		if (frame.op === "queue_edit" || frame.op === "queue_cancel") return queueRequest(args, frame.op);
		if (frame.op === "restart") return restartRequest({ args, ports, stateDir, open, clicks, now, newId: newControlId, append, outcome });
		if (frame.op === "settings_get" && ports.settings) return { ok: true, result: ports.settings.get() };
		if (frame.op === "settings_apply" && ports.settings) return { ok: true, result: ports.settings.apply(args) };
		return { ok: false, status: 400, error: `unknown op ${String(frame.op)}` };
	};

	const tokenOk = (given: unknown): boolean => {
		const a = Buffer.from(typeof given === "string" ? given : "");
		const b = Buffer.from(token);
		return a.length === b.length && timingSafeEqual(a, b);
	};
	const connections = new Set<Socket>();
	const server = createServer((socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				let frame: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(line);
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
					frame = parsed as Record<string, unknown>;
				} catch {
					socket.end(`${JSON.stringify({ v: CONTROL_PROTOCOL, id: null, ok: false, status: 400, error: "frame is not a JSON object" })}\n`);
					return;
				}
				const id = frame.id ?? null;
				if (frame.v !== CONTROL_PROTOCOL) { socket.end(`${JSON.stringify({ v: CONTROL_PROTOCOL, id, ok: false, status: 502, error: `protocol v${String(frame.v)} unsupported` })}\n`); return; }
				if (!tokenOk(frame.token)) {
					// A local process, not a dashboard request: nothing is journaled.
					log(`cp-bridge: dashboard control refused a frame with a bad socket token\n`);
					socket.destroy();
					return;
				}
				handle(frame)
					.then(({ after, ...reply }) => {
						// Restart: pi's shutdown runs only once the 202 is on the wire (or the viewer is gone).
						const later = after ? () => { setTimeout(after, 50); } : undefined;
						if (!socket.destroyed) socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL, id, ...reply })}\n`, later);
						else later?.();
					})
					.catch((error: Error) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL, id, ok: false, status: 500, error: error.message })}\n`); });
			}
			if (buffer.length > MAX_FRAME_CHARS) socket.destroy();
		});
	});
	const listen = () => new Promise<void>((done, fail) => {
		server.once("error", fail);
		const umask = process.umask(0o077); // owner-only from the bind, not after
		try {
			server.listen(socketPath, () => { server.off("error", fail); done(); });
		} finally {
			process.umask(umask);
		}
	});
	let stopped = false;
	// cp-y43c: what the dashboard held when the last bridge stopped is still its own: reloaded before any frame is read.
	const journal = readQueueJournal(stateDir);
	if (journal.error) log(`cp-bridge: dashboard queue unreadable, nothing reloaded: ${journal.error}\n`);
	for (const message of journal.messages.values()) {
		if (dashboardHeld(message)) queue.push({ id: message.id, at: message.at, peer: message.peer, text: message.text, askId: message.ask_id, ...(message.images ? { images: message.images } : {}), ...(message.files ? { files: message.files } : {}), ...(message.thread ? { thread: message.thread } : {}) });
	}
	try {
		await listen();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") return { state: "refused", reason: `cannot bind ${socketPath}: ${(error as Error).message}` };
		if (await answers(socketPath)) {
			const other = readControlRecord(stateDir);
			return { state: "refused", reason: `dashboard control already served by pid ${other.state === "ok" ? other.record.pid : "unknown"} on ${socketPath}` };
		}
		rmSync(socketPath, { force: true }); // stale: nothing answers
		try { await listen(); } catch (retry) { return { state: "refused", reason: `cannot bind ${socketPath}: ${(retry as Error).message}` }; }
	}
	chmodSync(socketPath, 0o600);
	const recordFile = controlRecordFile(stateDir);
	const tmp = `${recordFile}.${process.pid}.tmp`;
	try {
		const commit = (await LOADED_COMMIT)?.sha;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, pid: process.pid, socket: socketPath, token, csrf, started_at: startedAt, ...(commit ? { commit } : {}) }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, recordFile);
	} catch (error) {
		server.close();
		rmSync(socketPath, { force: true });
		rmSync(tmp, { force: true });
		return { state: "refused", reason: `cannot write ${recordFile}: ${(error as Error).message}` };
	}

	// Oldest first across the restart: reloaded held messages older than the offline inbox, then the inbox turn, then the rest.
	if (inbox.error) log(`cp-bridge: dashboard inbox unreadable, nothing delivered: ${inbox.error}\n`);
	settle(false);
	return {
		state: "listening",
		socket: socketPath,
		observe(message) {
			const text = textOf(message);
			if (!text || !text.includes("[cp-dashboard ")) return;
			for (const [id, entry] of open) {
				if (!text.includes(`[cp-dashboard ${id} `)) continue;
				open.delete(id);
				outcome(id, entry.kind, entry.askId, entry.peer, "delivered", null);
				entry.seen?.();
			}
		},
		settled() {
			settle(true);
		},
		stop() {
			if (stopped) return;
			stopped = true;
			for (const [id, entry] of open) if (entry.kind === "message") outcome(id, entry.kind, entry.askId, entry.peer, "dropped", "target operator session ended");
			open.clear();
			// Still queued in the journal: the next bridge reloads them; none was handed over, so none is lost or sent twice.
			queue.length = 0;
			server.close();
			for (const socket of connections) socket.destroy();
			rmSync(socketPath, { force: true });
			const current = readControlRecord(stateDir);
			if (current.state === "ok" && current.record.pid === process.pid && current.record.token === token) rmSync(recordFile, { force: true });
		},
	};
}

/**
 * cp-daemon P3: the messages the dashboard held while no session ran, delivered once, now that one listens. One
 * injected user message, oldest first, each line with its original time; older than 24 h is `dropped` and listed,
 * never injected; an answer whose ask is no longer open says so. Each id gets its `delivered` line once the
 * injection is accepted, so a refused injection leaves them held for the next session.
 */
export function deliverInbox(stateDir: string, ports: Pick<ControlPorts, "inject" | "isIdle">, at: Date, log: (line: string) => void, onFailed?: () => void): { delivered: number; dropped: number } {
	const { held, error } = readInbox(stateDir);
	if (error) log(`cp-bridge: dashboard inbox unreadable, nothing delivered: ${error}\n`);
	if (held.length === 0) return { delivered: 0, dropped: 0 };
	const mark = (line: InboxLine) => { const written = appendInboxLine(stateDir, line); if (!written.ok) log(`cp-bridge: dashboard inbox line for ${line.id} unwritten: ${written.error}\n`); };
	const stale = held.filter((message) => !(at.getTime() - Date.parse(message.at) <= INBOX_MAX_AGE_MS));
	const fresh = held.filter((message) => !stale.includes(message));
	for (const message of stale) mark({ type: "dropped", id: message.id, at: at.toISOString(), reason: "held longer than 24 h" });
	let asks: Map<string, string> | undefined;
	try {
		asks = new Map(new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).list().map((ask) => [ask.id, ask.state]));
	} catch {
		asks = undefined; // unreadable: say nothing about ask state rather than guess
	}
	const lines = fresh.map((message) => {
		const state = message.ask_id ? asks?.get(message.ask_id) : undefined;
		const note = message.ask_id && asks && state !== "open" ? ` (${message.ask_id} is ${state ?? "unknown"}, no longer open)` : "";
		return `- ${message.at} (${message.id}): ${message.text}${note}${message.thread ? `\n${dashboardMarker(message.id, message.ask_id, undefined, message.thread)}` : ""}`;
	});
	const dropped = stale.map((message) => `- dropped, held longer than 24 h: ${message.at} (${message.id})`);
	if (fresh.length === 0) {
		log(`cp-bridge: dashboard inbox: ${stale.length} held message(s) older than 24 h dropped, none injected\n`);
		return { delivered: 0, dropped: stale.length };
	}
	const text = [`[cp-dashboard inbox — ${fresh.length} message(s) typed while this session was offline; each line keeps its time; re-check state before acting on them]`, ...lines, ...dropped].join("\n");
	const delivered = () => { for (const message of fresh) mark({ type: "delivered", id: message.id, at: at.toISOString() }); };
	try {
		void Promise.resolve(ports.inject(text, ports.isIdle() ? undefined : "followUp")).then(delivered, (failure: unknown) => {
			log(`cp-bridge: dashboard inbox not delivered (kept for the next session): ${failure instanceof Error ? failure.message : String(failure)}\n`);
			onFailed?.();
		});
	} catch (failure) {
		log(`cp-bridge: dashboard inbox not delivered (kept for the next session): ${(failure as Error).message}\n`);
		return { delivered: 0, dropped: stale.length };
	}
	return { delivered: fresh.length, dropped: stale.length };
}
