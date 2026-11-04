/**
 * Dashboard control (cp-dashboard-operator-control), read-only: where its files live and how a reader tells a good
 * one from a bad one. Shared by the viewer's control routes, `/doctor` and the operator session's bridge half
 * (src/dashboard-control.ts), so all three agree on one layout:
 *
 *   data/dashboard-control.json     optional opt-out, by hand: `{"enabled": false}`; absent is on
 *   state/operator/dashboard.json   0600: the serving session's pid, socket, socket token and CSRF token
 *   state/operator/dashboard.sock   0600: the operator session's control socket
 *   state/operator/dashboard.jsonl  0600: the append-only audit journal (bridge and viewer)
 *   state/operator/inbox.jsonl      0600: messages held while no operator session runs (cp-daemon P3)
 *   state/schedule-control.jsonl    0600: Schedules page requests (viewer request lines) and the parent's
 *                                   claimed/outcome lines (cp-hhuf P6)
 *
 * Nothing in this file writes.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { pushDataDir, readPushConfig } from "./push-files.ts";
import { IMAGE_ID_SOURCE, TEXT_ID_SOURCE, isUploadId, sanitizeUploadName } from "./uploads.ts";

import { runOverrideErrors, schedulePolicyErrors, type RunOverrides, type SchedulePolicy } from "./schedule-policy.ts";
export const CONTROL_PROTOCOL = 1;
/** Composer text cap; with its JSON envelope it fits the body cap. */
export const CONTROL_TEXT_MAX = 16_000;
export const CONTROL_BODY_MAX_BYTES = 20 * 1024;
export const CONTROL_RATE_LIMIT = 20;
export const CONTROL_RATE_WINDOW_MS = 60_000;
const ASK_ID_RE = /^ask-[a-f0-9]+$/;

export const controlConfigFile = (stateDir: string): string => join(pushDataDir(stateDir), "dashboard-control.json");
export const controlRecordFile = (stateDir: string): string => join(stateDir, "operator", "dashboard.json");
export const controlSocketFile = (stateDir: string): string => join(stateDir, "operator", "dashboard.sock");
export const controlJournalFile = (stateDir: string): string => join(stateDir, "operator", "dashboard.jsonl");
/** cp-daemon P3: composer messages held while no operator session runs (viewer appends `held`, the session `delivered`/`dropped`). */
export const controlInboxFile = (stateDir: string): string => join(stateDir, "operator", "inbox.jsonl");
export const INBOX_MAX_HELD = 20;
/** A held message older than this is dropped and reported at delivery, never injected. */
export const INBOX_MAX_AGE_MS = 24 * 3_600_000;
export type InboxLine =
	| { type: "held"; id: string; at: string; text: string; ask_id: string | null; remote?: RemoteDevice }
	| { type: "delivered"; id: string; at: string }
	| { type: "dropped"; id: string; at: string; reason: string };

/** cp-hhuf P6: Schedules page requests; the viewer appends `request`, the parent `claimed` then `outcome`. */
export const scheduleControlFile = (stateDir: string): string => join(stateDir, "schedule-control.jsonl");
export const SCHEDULE_CONTROL_OPS = ["enable", "disable", "run_now", "remove", "save_policy", "adopt", "deactivate"] as const;
export type ScheduleControlOp = (typeof SCHEDULE_CONTROL_OPS)[number];
/** A request the parent has not claimed within this is expired, never applied. */
export const SCHEDULE_CONTROL_MAX_AGE_MS = 120_000;
export const SCHEDULE_CONTROL_MAX_PENDING = 20;
export type ScheduleControlState = "queued" | "applying" | "done" | "refused" | "expired" | "interrupted";
export type ScheduleControlLine =
	| ({ type: "request"; by: "viewer"; id: string; at: string; peer: string | null; op: ScheduleControlOp; schedule_id: string } & ScheduleControlFields)
	| { type: "claimed"; by: "parent"; id: string; at: string; pid: number }
	| { type: "outcome"; by: "parent"; id: string; at: string; state: "done" | "refused" | "expired" | "interrupted"; reason: string | null; job_id: string | null };
export interface ScheduleControlFields { revision?: number; policy?: SchedulePolicy; client_id?: string; overrides?: RunOverrides }
export const SCHEDULE_CLIENT_ID = /^sk-[0-9]{14}-[0-9a-f]{8}$/;
/** Shared ingress and journal validation; legacy requests may omit revision until a policy is active. */
export function scheduleControlFieldError(value: Record<string, unknown>): string | undefined {
 const op = value.op;
 if (value.client_id !== undefined && (typeof value.client_id !== "string" || !SCHEDULE_CLIENT_ID.test(value.client_id))) return "client_id must be sk-<14 digits>-<8 hex>";
 if ((value.revision !== undefined && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) || ((op === "adopt" || op === "save_policy") && value.revision === undefined)) return "revision must be a non-negative integer";
 if (value.revision !== undefined && !["run_now", "adopt", "save_policy"].includes(String(op))) return "revision is only for run_now, adopt or save_policy";
 if (op === "save_policy") {
  const errors = schedulePolicyErrors(value.policy);
  if (errors.length) return `invalid schedule policy: ${errors.join("; ")}`;
 } else if (value.policy !== undefined) return "policy is only for save_policy";
 if (value.overrides !== undefined) {
  if (op !== "run_now") return "overrides are only for run_now";
  const errors = runOverrideErrors(value.overrides);
  if (errors.length) return `invalid run overrides: ${errors.join("; ")}`;
 }
 return undefined;
}
export interface ScheduleControlRequest extends ScheduleControlFields {
	id: string;
	at: string;
	peer: string | null;
	op: ScheduleControlOp;
	schedule_id: string;
	state: ScheduleControlState;
	claimed_pid: number | null;
	reason: string | null;
	job_id: string | null;
}
const OUTCOME_STATES = ["done", "refused", "expired", "interrupted"];

/** Every request with its latest state, oldest first; `error` names an unreadable file (never silently empty). */
export function readScheduleControl(stateDir: string): { requests: ScheduleControlRequest[]; error: string | null } {
	const file = scheduleControlFile(stateDir);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return { requests: [], error: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `${file}: ${(error as Error).message}` };
	}
	const requests = new Map<string, ScheduleControlRequest>();
	for (const row of text.split("\n")) {
		let line: Record<string, unknown>;
		try {
			line = JSON.parse(row) as Record<string, unknown>;
		} catch {
			continue; // a torn last line: the next append starts a fresh one
		}
		if (typeof line?.id !== "string" || typeof line.at !== "string") continue;
		if (line.type === "request") {
			if (requests.has(line.id) || !(SCHEDULE_CONTROL_OPS as readonly unknown[]).includes(line.op) || typeof line.schedule_id !== "string" || scheduleControlFieldError(line)) continue;
			requests.set(line.id, { id: line.id, at: line.at, peer: typeof line.peer === "string" ? line.peer : null, op: line.op as ScheduleControlOp, schedule_id: line.schedule_id, ...(line.revision !== undefined ? {revision:line.revision as number} : {}), ...(line.policy !== undefined ? {policy:line.policy as SchedulePolicy} : {}), ...(line.client_id !== undefined ? {client_id:line.client_id as string} : {}), ...(line.overrides !== undefined ? {overrides:line.overrides as RunOverrides} : {}), state: "queued", claimed_pid: null, reason: null, job_id: null });
			continue;
		}
		const request = requests.get(line.id);
		if (!request) continue;
		if (line.type === "claimed" && request.state === "queued") Object.assign(request, { state: "applying", claimed_pid: typeof line.pid === "number" ? line.pid : null });
		else if (line.type === "outcome" && OUTCOME_STATES.includes(line.state as string)) {
			Object.assign(request, { state: line.state, reason: typeof line.reason === "string" ? line.reason : null, job_id: typeof line.job_id === "string" ? line.job_id : null });
		}
	}
	return { requests: [...requests.values()].sort((a, b) => a.at.localeCompare(b.at)), error: null };
}


export const DASHBOARD_ID_RE = /^dc-\d{14}-[0-9a-f]{8}$/;
/** The head of the one user message that replays held dashboard messages (src/dashboard-control.ts). */
export const INBOX_REPLAY_PREFIX = "[cp-dashboard inbox — ";

export type ControlConfig = { state: "on" | "off" | "invalid"; reason: string };

/** On unless `data/dashboard-control.json` says `{"enabled": false}`; anything else in that file is invalid (fail closed). */
export function readControlConfig(stateDir: string): ControlConfig {
	const file = controlConfigFile(stateDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "on", reason: "on by default (no data/dashboard-control.json)" };
		return { state: "invalid", reason: `${file} is unreadable: ${(error as Error).message}` };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", reason: `${file} is not a JSON object` };
	const extra = Object.keys(raw).filter((key) => key !== "enabled");
	if (extra.length) return { state: "invalid", reason: `${file} has unknown key ${extra.join(", ")}; the only key is "enabled"` };
	const enabled = (raw as { enabled?: unknown }).enabled;
	if (enabled === false) return { state: "off", reason: "data/dashboard-control.json has enabled:false" };
	if (enabled === true || enabled === undefined) return { state: "on", reason: "data/dashboard-control.json has enabled:true" };
	return { state: "invalid", reason: `${file}: enabled must be true or false` };
}

/** The dashboard's public origin: the one `/api/push` reports (data/push/config.json), or null when push is not set up. */
export function controlOrigin(stateDir: string): string | null {
	return readPushConfig(pushDataDir(stateDir))?.origin ?? null;
}

export interface ControlRecord {
	version: 1;
	pid: number;
	socket: string;
	token: string;
	csrf: string;
	started_at: string;
	/** The commit the operator session loaded (src/viewer/loaded-commit.ts); absent in a record written before cp-kz20. */
	commit?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Read fresh on every call: a session start rotates both tokens. */
export function readControlRecord(stateDir: string): { state: "absent" } | { state: "invalid"; reason: string } | { state: "ok"; record: ControlRecord } {
	const file = controlRecordFile(stateDir);
	let raw: Partial<ControlRecord>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ControlRecord>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "invalid", reason: `${file} is unreadable: ${(error as Error).message}` };
	}
	if (raw?.version !== 1 || !Number.isInteger(raw.pid) || raw.socket !== controlSocketFile(stateDir) || !HEX64.test(String(raw.token)) || !HEX64.test(String(raw.csrf)) || typeof raw.started_at !== "string") {
		return { state: "invalid", reason: `${file} is not a record this build wrote` };
	}
	return { state: "ok", record: raw as ControlRecord };
}

/** The trailing marker keeps ask/images ordering; files and then `; remote` are additive final fields. */
export function dashboardMarker(id: string, askId?: string | null, images?: readonly string[], files?: readonly string[], remote = false): string {
	return `[cp-dashboard ${id} — from the dashboard${askId ? `; ask=${askId}` : ""}${images?.length ? `; images=${images.join(",")}` : ""}${files?.length ? `; files=${files.join(",")}` : ""}${remote ? "; remote" : ""}]`;
}

/**
 * Remote dashboard PR 1c: who on a paired remote device sent or edited a message — only ever the remote gate's
 * authenticated context (access.ts), never a request body. The id and name rules are device-files.ts's (which imports
 * this module, so they are restated here, not imported).
 */
export type RemoteDevice = { device_id: string; name: string };
export type RemoteInvolvement = { sender: RemoteDevice | null; editors: RemoteDevice[] };
/** The bridge's `status` reply carries this; a viewer forwards a remote send only to a bridge that keeps provenance. */
export const REMOTE_PROVENANCE_VERSION = 1;
const REMOTE_ID_RE = /^dev-[0-9a-f]{16}$/;
const REMOTE_NAME_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function remoteDevice(value: unknown): RemoteDevice | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { device_id, name, ...rest } = value as Record<string, unknown>;
	if (Object.keys(rest).length || typeof device_id !== "string" || !REMOTE_ID_RE.test(device_id) || typeof name !== "string") return undefined;
	return name.length >= 1 && name.length <= 80 && name === name.trim() && !REMOTE_NAME_BAD.test(name) ? { device_id, name } : undefined;
}
/** Editors in first-edit order, one entry per device. */
export const withEditor = (editors: readonly RemoteDevice[] | undefined, editor: RemoteDevice): RemoteDevice[] =>
	editors?.some((item) => item.device_id === editor.device_id) ? [...editors] : [...(editors ?? []), editor];

const REMOTE_PREFIX = "[cp-remote — through a paired remote device, not this terminal: ";
const REMOTE_WHO = String.raw`dev-[0-9a-f]{16} "(?:[^"\\\n]|\\.)*"`;
const REMOTE_LINE_RE = new RegExp(String.raw`^\[cp-remote — through a paired remote device, not this terminal: (?:sent|edited) by ${REMOTE_WHO}(?:; edited by ${REMOTE_WHO})*\]$`);
const REMOTE_PART = String.raw`(sent|edited) by (dev-[0-9a-f]{16}) ("(?:[^"\\\n]|\\.)*")`;
/** The human-readable line injected right above the marker (names JSON-quoted: data, never instructions); null when local. */
export function remoteLine(involvement: { remote?: RemoteDevice; editors?: readonly RemoteDevice[] }): string | null {
	const parts = [...(involvement.remote ? [["sent", involvement.remote] as const] : []), ...(involvement.editors ?? []).map((editor) => ["edited", editor] as const)];
	return parts.length ? `${REMOTE_PREFIX}${parts.map(([role, device]) => `${role} by ${device.device_id} ${JSON.stringify(device.name)}`).join("; ")}]` : null;
}
function parseRemoteLine(line: string): RemoteInvolvement | undefined {
	if (!REMOTE_LINE_RE.test(line)) return undefined;
	const out: RemoteInvolvement = { sender: null, editors: [] };
	for (const [, role, device_id, quoted] of line.matchAll(new RegExp(REMOTE_PART, "g"))) {
		let name: unknown;
		try { name = JSON.parse(quoted!); } catch { return undefined; }
		const device = remoteDevice({ device_id, name });
		if (!device) return undefined;
		if (role === "sent") out.sender = device;
		else out.editors.push(device);
	}
	return out;
}

// `; thread=` is a legacy (#588) marker field: still parsed so old transcripts keep their entries, never written.
const MARKER_RE = new RegExp(`(?:^|\\n)\\[cp-dashboard (dc-\\d{14}-[0-9a-f]{8}) — from the dashboard(?:; ask=(ask-[a-f0-9]+))?(?:; thread=[a-z0-9][a-z0-9-]{0,31})?(?:; images=(${IMAGE_ID_SOURCE}(?:,${IMAGE_ID_SOURCE}){0,7}))?(?:; files=(${TEXT_ID_SOURCE}(?:,${TEXT_ID_SOURCE}){0,7}))?(; remote)?\\]\\s*$`);

/**
 * A marker with `; remote` is a remote message: its line directly above the marker names the devices (`remote`) and is
 * not part of the body. Only the bridge writes that flag, after the user's text, so typed text can neither forge nor
 * remove it; a flagged marker without a well-formed line is not a marker.
 */
export function parseDashboardText(text: string): { body: string; id: string; askId: string | null; images?: string[]; files?: string[]; remote?: RemoteInvolvement } | undefined {
	const match = MARKER_RE.exec(text);
	if (!match) return undefined;
	let body = text.slice(0, match.index).trimEnd();
	let remote: RemoteInvolvement | undefined;
	if (match[5]) {
		const cut = body.lastIndexOf("\n");
		remote = parseRemoteLine(body.slice(cut + 1));
		if (!remote) return undefined;
		body = body.slice(0, Math.max(cut, 0)).trimEnd();
	}
	return { body, id: match[1]!, askId: match[2] ?? null, ...(match[3] ? { images: match[3].split(",") } : {}), ...(match[4] ? { files: match[4].split(",") } : {}), ...(remote ? { remote } : {}) };
}

export const isAskId = (value: unknown): value is string => typeof value === "string" && ASK_ID_RE.test(value);

export type DashboardCommand = { command: "status" } | { command: "stop"; job_id: string };
/** Full match S6: the bounded command grammar, checked by the viewer and again by the bridge; the rest is refused. */
export function commandGrammar(value: Record<string, unknown>): ({ ok: true } & DashboardCommand) | { ok: false; reason: string } {
	const job = value.job_id;
	if (typeof value.client_id !== "string" || !DASHBOARD_ID_RE.test(value.client_id)) return { ok: false, reason: "client_id must be a dashboard id" };
	if (value.command === "status") return job === undefined ? { ok: true, command: "status" } : { ok: false, reason: "/status takes no job" };
	if (value.command !== "stop") return { ok: false, reason: 'command must be "status" or "stop"; send anything else as a message' };
	if (job === undefined || job === "") return { ok: false, reason: "/stop needs the job to stop" };
	if (typeof job !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job)) return { ok: false, reason: "job_id must be a job id" };
	return { ok: true, command: "stop", job_id: job };
}
export type ControlKind = "message" | "answer" | "abort" | "restart" | "parent_restart";
export type ControlDeliver = "prompt" | "followUp" | "steer" | "abort" | "restart" | "parent_restart";

/**
 * One audit line. The bridge writes request/outcome; the viewer writes refused (after the --require-tailnet guard)
 * and one `upload` line per stored attachment: ids, mime, bytes and optional display names, never contents.
 */
export type ControlAuditLine =
	| { type: "request"; by: "bridge"; id: string; at: string; peer: string | null; kind: ControlKind; text: string | null; ask_id: string | null; deliver: ControlDeliver; images?: string[]; files?: string[]; session_started_at?: string; session_file?: string; remote?: RemoteDevice; command?: string }
	| { type: "outcome"; by: "bridge"; id: string; at: string; peer: string | null; state: "injected" | "delivered" | "queued" | "failed" | "refused" | "restarting" | "restarted" | "dropped" | "cancelled"; reason: string | null }
	/** cp-y43c: a dashboard-queued message's text replaced before its handoff; every revision stays in the journal. */
	| { type: "edited"; by: "bridge"; id: string; at: string; peer: string | null; text: string; remote?: RemoteDevice }
	| { type: "outcome"; by: "viewer"; id: string; at: string; peer: string | null; state: "dropped"; reason: string }
	| { type: "refused"; by: "viewer"; id: null; at: string; peer: string | null; kind: ControlKind | "command" | "start" | "schedule" | "upload" | "settings" | "queue" | "thread" | null; text: string | null; ask_id: string | null; status: number; reason: string; bytes?: number; via?: "herdr" | "tmux"; op?: ScheduleControlOp | "edit" | "cancel" | "create" | "rename"; schedule_id?: string; images?: string[]; files?: string[]; mime?: string; queue_id?: string; thread_id?: string }
	/** Full match S8: the operator session's answer to one named-thread write; the registry line is the write itself. */
	| { type: "thread"; by: "bridge"; id: string | null; at: string; peer: string | null; op: "create" | "rename"; thread_id: string | null; name: string | null; state: "created" | "renamed" | "replayed" | "refused"; reason: string | null }
	| { type: "upload"; by: "viewer"; id: string; at: string; peer: string | null; mime: string; bytes: number; name?: string }
	/** Remote dashboard: secret-free device events from `device-store.ts`; `id` stays null so the composer readers skip them. */
	| { type: "device"; by: "viewer"; id: null; at: string; peer: string | null; event: "code_issued" | "paired" | "claim_refused" | "signin_refused" | "revoked"; reason: string | null; pairing_id?: string; device_id?: string; name?: string; level?: "full" | "view"; route?: "cli-up" | "cli-pair" | "loopback-dashboard" | "tailnet-dashboard" }
	| { type: "start"; by: "viewer"; id: null; at: string; peer: string | null; via: "herdr" | "tmux"; resume?: true; state: "starting" | "unavailable"; reason: string | null };

type UploadMetadata = { name: string; bytes: number };
type UploadCache = { dev: number; ino: number; size: number; mtimeMs: number; offset: number; tail: Buffer; uploads: Map<string, UploadMetadata & { order: number }> };
const uploadMetadataCache = new Map<string, UploadCache>();
/** The up-to-64 bytes before `end`: a replaced journal that reuses the inode and grows no longer matches them. */
const tailAt = (fd: number, end: number): Buffer => {
	const buf = Buffer.alloc(Math.min(64, end));
	readSync(fd, buf, 0, buf.length, end - buf.length);
	return buf;
};

/** Names/sizes have one durable source: upload audit lines, never attachment contents.
 * Cache each journal's uploads and resume at the last complete record; a snapshot bounds each scan.
 */
export function readUploadMetadata(stateDir: string, ids: readonly string[]): Map<string, UploadMetadata> {
	const found = new Map<string, UploadMetadata>();
	const wanted = new Set(ids);
	if (!wanted.size) return found;
	const file = controlJournalFile(stateDir);
	let fd: number;
	try { fd = openSync(file, "r"); } catch { uploadMetadataCache.delete(file); return found; }
	try {
		const stat = fstatSync(fd);
		const fresh = (): UploadCache => ({ dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, offset: 0, tail: Buffer.alloc(0), uploads: new Map() });
		const scan = (c: UploadCache) => {
			c.size = stat.size;
			c.mtimeMs = stat.mtimeMs;
			let pending = Buffer.alloc(0);
			for (let offset = c.offset; offset < stat.size;) {
				const buf = Buffer.alloc(Math.min(1024 * 1024, stat.size - offset));
				const read = readSync(fd, buf, 0, buf.length, offset);
				if (!read) break;
				offset += read;
				const chunk = Buffer.concat([pending, buf.subarray(0, read)]);
				let start = 0;
				for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
					const row = chunk.subarray(start, end).toString("utf8");
					start = end + 1;
					let line;
					try { line = JSON.parse(row); } catch { continue; }
					if (line?.type !== "upload" || !isUploadId(line.id) || typeof line.name !== "string" || !Number.isSafeInteger(line.bytes) || line.bytes < 0) continue;
					c.uploads.set(line.id, { name: sanitizeUploadName(line.name), bytes: line.bytes, order: c.uploads.get(line.id)?.order ?? c.uploads.size });
				}
				pending = chunk.subarray(start);
				c.offset = offset - pending.length;
				c.tail = Buffer.from(Buffer.concat([c.tail, chunk.subarray(0, start)]).subarray(-64));
			}
		};
		let cache = uploadMetadataCache.get(file);
		if (!cache || cache.dev !== stat.dev || cache.ino !== stat.ino || stat.size < cache.size) {
			cache = fresh();
			uploadMetadataCache.set(file, cache);
			scan(cache);
		} else if (cache.size !== stat.size || cache.mtimeMs !== stat.mtimeMs) {
			const { offset, tail } = cache;
			scan(cache);
			// One verify read on growth: the bytes before the old offset must still be the ones we parsed.
			if (offset && !tailAt(fd, offset).equals(tail)) {
				cache = fresh();
				uploadMetadataCache.set(file, cache);
				scan(cache);
			}
		}
		const matches = [...wanted].flatMap(id => { const metadata = cache.uploads.get(id); return metadata ? [{ id, ...metadata }] : []; });
		matches.sort((a, b) => a.order - b.order); // Preserve the journal's first-seen order.
		for (const { id, name, bytes } of matches) found.set(id, { name, bytes });
	} finally {
		closeSync(fd);
	}
	return found;
}
