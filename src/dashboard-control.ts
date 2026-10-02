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
 *  - `abort` → abort the running turn.
 * Every `send`/`abort` appends its `request` line to `state/operator/dashboard.jsonl` before anything happens;
 * a request that cannot be journaled is refused and never injected. At listen (cp-daemon P3) the messages the
 * dashboard held in `state/operator/inbox.jsonl` while no session ran are delivered once (`deliverInbox`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, join } from "node:path";
import { OperatorAsks } from "./operator-asks.ts";
import { appendControlAudit, appendInboxLine } from "./viewer/control-audit.ts";
import {
	CONTROL_PROTOCOL, CONTROL_TEXT_MAX, type ControlAuditLine, type ControlDeliver, type ControlKind, controlRecordFile, controlSocketFile,
	dashboardMarker, INBOX_MAX_AGE_MS, type InboxLine, isAskId, readControlConfig, readControlRecord,
} from "./viewer/control-files.ts";
import { readInbox } from "./viewer/control-inbox.ts";

/** Linux `sun_path` is 108 bytes including the NUL. */
const MAX_SOCKET_PATH = 107;
const MAX_FRAME_CHARS = 64 * 1024;
const RECENT_KEEP = 10;
const OPEN_KEEP = 100;

export interface ControlPorts {
	/** Deliver `text` as a user message; `deliverAs` undefined when the session is idle. May return a promise that rejects on failure. */
	inject(text: string, deliverAs: "steer" | "followUp" | undefined): void | Promise<unknown>;
	abort(): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	sessionFile(): string | undefined;
}

export interface ControlOutcome { id: string; kind: ControlKind; state: string; at: string; reason: string | null; ask_id: string | null }

export interface DashboardControl {
	state: "listening";
	socket: string;
	/** Feed every message the session starts or sends to the model; a dashboard marker marks its request delivered. */
	observe(message: unknown): void;
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
}

type Reply = { ok: true; result: unknown } | { ok: false; status: number; error: string };

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

	const outcome = (id: string, kind: ControlKind, askId: string | null, peer: string | null, state: ControlOutcome["state"], reason: string | null) => {
		const at = now().toISOString();
		const written = append({ type: "outcome", by: "bridge", id, at, peer, state: state as never, reason });
		if (!written.ok) log(`cp-bridge: dashboard control outcome ${id} ${state} not journaled: ${written.error}\n`);
		const row = { id, kind, state, at, reason, ask_id: askId };
		const index = recent.findIndex((r) => r.id === id);
		if (index >= 0) recent.splice(index, 1);
		recent.push(row);
		if (recent.length > RECENT_KEEP) recent.shift();
		if (state === "failed" && askId && clicks.get(askId)?.id === id) clicks.delete(askId);
	};

	const request = async (args: Record<string, unknown>, op: "send" | "abort"): Promise<Reply> => {
		const kind: ControlKind = op === "abort" ? "abort" : args.kind === "answer" ? "answer" : "message";
		const peer = typeof args.peer === "string" ? args.peer.slice(0, 100) : null;
		const askId = kind === "answer" && isAskId(args.ask_id) ? args.ask_id : null;
		const label = typeof args.label === "string" ? args.label : "";
		const text = kind === "message" ? (typeof args.text === "string" ? args.text.trim() : "") : kind === "answer" ? `${askId ?? String(args.ask_id)}: ${label}` : null;
		const idle = ports.isIdle();
		const deliverAs = kind === "abort" || idle ? undefined : args.deliver === "steer" ? "steer" : "followUp";
		const deliver: ControlDeliver = kind === "abort" ? "abort" : deliverAs ?? "prompt";
		const id = newControlId(now());
		const journaled = append({ type: "request", by: "bridge", id, at: now().toISOString(), peer, kind, text, ask_id: askId, deliver });
		if (!journaled.ok) return { ok: false, status: 500, error: `failed: audit journal unwritable (${journaled.error})` };
		const refuse = (status: number, reason: string): Reply => {
			outcome(id, kind, askId, peer, "refused", reason);
			return { ok: false, status, error: reason };
		};
		const latest = readControlConfig(stateDir);
		if (latest.state !== "on") return refuse(403, `dashboard control is off (${latest.reason})`);
		if (kind === "abort") {
			if (idle) return refuse(409, "session is idle; nothing to abort");
			try { ports.abort(); } catch (error) { outcome(id, kind, null, peer, "failed", (error as Error).message); return { ok: false, status: 502, error: `failed: ${(error as Error).message}` }; }
			outcome(id, kind, null, peer, "delivered", null);
			return { ok: true, result: { id, state: "delivered", deliver } };
		}
		if (kind === "message" && (!text || text.length > CONTROL_TEXT_MAX)) return refuse(400, `text must be 1-${CONTROL_TEXT_MAX} characters`);
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
		const seen = new Promise<"delivered">((resolve) => open.set(id, { kind, askId, peer, seen: () => resolve("delivered") }));
		if (open.size > OPEN_KEEP) open.delete(open.keys().next().value!);
		let result: Promise<unknown> | void;
		try {
			result = ports.inject(`${text}\n\n${dashboardMarker(id, askId)}`, deliverAs);
		} catch (error) {
			open.delete(id);
			outcome(id, kind, askId, peer, "failed", (error as Error).message);
			return { ok: false, status: 502, error: `failed: ${(error as Error).message}` };
		}
		outcome(id, kind, askId, peer, "injected", null);
		const failed = Promise.resolve(result).then(() => new Promise<never>(() => {}), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
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

	const handle = async (frame: Record<string, unknown>): Promise<Reply> => {
		const args = frame.args !== null && typeof frame.args === "object" && !Array.isArray(frame.args) ? (frame.args as Record<string, unknown>) : {};
		if (frame.op === "hello") return { ok: true, result: { pid: process.pid, protocol: CONTROL_PROTOCOL } };
		if (frame.op === "status") {
			const file = ports.sessionFile();
			return { ok: true, result: { busy: !ports.isIdle(), pending: ports.hasPendingMessages(), session_file: file ? basename(file) : null, recent: [...recent] } };
		}
		if (frame.op === "send" || frame.op === "abort") return request(args, frame.op);
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
					.then((reply) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL, id, ...reply })}\n`); })
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
		writeFileSync(tmp, `${JSON.stringify({ version: 1, pid: process.pid, socket: socketPath, token, csrf, started_at: now().toISOString() }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, recordFile);
	} catch (error) {
		server.close();
		rmSync(socketPath, { force: true });
		rmSync(tmp, { force: true });
		return { state: "refused", reason: `cannot write ${recordFile}: ${(error as Error).message}` };
	}

	deliverInbox(stateDir, ports, now(), log);
	let stopped = false;
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
		stop() {
			if (stopped) return;
			stopped = true;
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
export function deliverInbox(stateDir: string, ports: Pick<ControlPorts, "inject" | "isIdle">, at: Date, log: (line: string) => void): { delivered: number; dropped: number } {
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
		return `- ${message.at} (${message.id}): ${message.text}${note}`;
	});
	const dropped = stale.map((message) => `- dropped, held longer than 24 h: ${message.at} (${message.id})`);
	if (fresh.length === 0) {
		log(`cp-bridge: dashboard inbox: ${stale.length} held message(s) older than 24 h dropped, none injected\n`);
		return { delivered: 0, dropped: stale.length };
	}
	const text = [`[cp-dashboard inbox — ${fresh.length} message(s) typed while this session was offline; each line keeps its time; re-check state before acting on them]`, ...lines, ...dropped].join("\n");
	const delivered = () => { for (const message of fresh) mark({ type: "delivered", id: message.id, at: at.toISOString() }); };
	try {
		void Promise.resolve(ports.inject(text, ports.isIdle() ? undefined : "followUp")).then(delivered, (failure: unknown) => log(`cp-bridge: dashboard inbox not delivered (kept for the next session): ${failure instanceof Error ? failure.message : String(failure)}\n`));
	} catch (failure) {
		log(`cp-bridge: dashboard inbox not delivered (kept for the next session): ${(failure as Error).message}\n`);
	}
	return { delivered: fresh.length, dropped: stale.length };
}
