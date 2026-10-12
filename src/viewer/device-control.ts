/**
 * Remote dashboard PR 1c: the viewer's owner socket for the device CLI (`cp-tunnel pair|devices|revoke|status`, wired in
 * PR 2). The viewer process is the one writer of `data/devices.json` (device-store.ts); the CLI never opens that file, it
 * asks here. `state/devices/` (0700) holds `control.sock` (0600, bound under umask 077) and `control.json` (0600:
 * version, pid, socket, token, started_at). Frames are newline JSON `{v, token, op, args}` of at most 4 KiB, one reply
 * each; a wrong token closes the connection unanswered, an oversized frame is refused and closed.
 *
 * Ops: `status`; `pair {level?, route?}` (route `cli-pair` or `cli-up`; the code travels back over this socket only);
 * `list`; `revoke {target}` (public id or name). Starting finds a live owner (its socket answers) and refuses, so two
 * viewers never both write the store; a socket nothing answers is stale and replaced. The client refuses a record that
 * is not owner-only or whose pid is gone (a stale owner) before it connects.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { DEVICE_ID_RE, deviceName, isDeviceLevel } from "./device-files.ts";
import { type DeviceRoutes, storeRefusal } from "./devices-api.ts";
import { pidAlive } from "./overview-health.ts";

export const DEVICE_CONTROL_PROTOCOL = 1;
export const DEVICE_FRAME_MAX = 4096;
const REPLY_MAX = 256 * 1024;
/** Linux `sun_path` is 108 bytes including the NUL. */
const MAX_SOCKET_PATH = 107;
const HEX64 = /^[0-9a-f]{64}$/;

export const deviceControlDir = (stateDir: string): string => join(stateDir, "devices");
export const deviceControlSocket = (stateDir: string): string => join(deviceControlDir(stateDir), "control.sock");
export const deviceControlRecordFile = (stateDir: string): string => join(deviceControlDir(stateDir), "control.json");

export type DeviceControlReply = { ok: true; result: unknown } | { ok: false; status: number; error: string };
type OwnerRecord = { version: 1; pid: number; socket: string; token: string; started_at: string };

const fail = (status: number, error: string): DeviceControlReply => ({ ok: false, status, error });
const refusal = (failure: Parameters<typeof storeRefusal>[0]): DeviceControlReply => fail(storeRefusal(failure).status, failure.reason);

/** One frame's answer: the store does the work (and its auditing); nothing here writes the store file. */
export function deviceControlAnswer(routes: DeviceRoutes, op: unknown, args: Record<string, unknown>): DeviceControlReply {
	if (op === "status") {
		const binding = routes.binding();
		return { ok: true, result: { pid: process.pid, running: binding !== null, origin: binding?.origin ?? null } };
	}
	if (op === "list") {
		const listed = routes.store.list();
		return listed.ok ? { ok: true, result: { devices: listed.devices, events: listed.events, pending_codes: listed.pending_codes } } : refusal(listed);
	}
	if (op === "pair") {
		const level = args.level ?? "full", route = args.route ?? "cli-pair";
		if (Object.keys(args).some((key) => key !== "level" && key !== "route") || !isDeviceLevel(level) || (route !== "cli-pair" && route !== "cli-up")) return fail(400, 'args must be {"level"?: "full" | "view", "route"?: "cli-pair" | "cli-up"}');
		const binding = routes.binding();
		if (!binding) return fail(409, "the remote dashboard is not running: start it with cp-tunnel up");
		const issued = routes.store.issueCode({ ...binding, route, level, peer: null });
		return issued.ok ? { ok: true, result: { link: `${binding.origin}/pair#${issued.code}`, level: issued.level, expires_at: issued.expires_at } } : refusal(issued);
	}
	if (op === "revoke") {
		const target = typeof args.target === "string" ? args.target : "";
		if (Object.keys(args).length !== 1 || (!DEVICE_ID_RE.test(target) && deviceName(target) === undefined)) return fail(400, 'args must be {"target": "<device id or name>"}');
		const revoked = routes.store.revoke(target, null);
		return revoked.ok ? { ok: true, result: { id: revoked.device.id, name: revoked.device.name, revoked_at: revoked.device.revoked_at, audit_error: revoked.audit_error } } : refusal(revoked);
	}
	return fail(400, `unknown op ${String(op).slice(0, 40)}`);
}

const inodeOf = (path: string): number | null => {
	try { return lstatSync(path).ino; } catch { return null; }
};

/** Whether something answers on `path` (a live owner); doubt counts as live, so a socket is never unlinked on a guess. */
function answers(path: string): Promise<boolean> {
	return new Promise((done) => {
		const socket = createConnection(path);
		const finish = (yes: boolean) => { clearTimeout(timer); socket.destroy(); done(yes); };
		const timer = setTimeout(() => finish(true), 2_000);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

export type DeviceControl = { state: "listening"; socket: string; stop(): void };

export async function startDeviceControl(stateDir: string, routes: DeviceRoutes, log: (line: string) => void = (line) => process.stderr.write(line)): Promise<DeviceControl | { state: "refused"; reason: string }> {
	const socketPath = deviceControlSocket(stateDir), recordFile = deviceControlRecordFile(stateDir);
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) return { state: "refused", reason: `socket path is too long for a Unix socket (${socketPath})` };
	mkdirSync(deviceControlDir(stateDir), { recursive: true, mode: 0o700 });
	chmodSync(deviceControlDir(stateDir), 0o700); // the create mode is masked by umask and ignored for an existing dir
	const token = randomBytes(32).toString("hex");
	const tokenOk = (given: unknown): boolean => typeof given === "string" && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
	const connections = new Set<Socket>();
	const server = createServer((socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setEncoding("utf8");
		let buffer = "";
		const reply = (out: DeviceControlReply & { id?: unknown }) => `${JSON.stringify({ v: DEVICE_CONTROL_PROTOCOL, ...out })}\n`;
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (let index = buffer.indexOf("\n"); index >= 0 && !socket.destroyed; index = buffer.indexOf("\n")) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.length > DEVICE_FRAME_MAX) { socket.end(reply(fail(413, `frame is larger than ${DEVICE_FRAME_MAX} characters`))); return; }
				let frame: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(line);
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
					frame = parsed as Record<string, unknown>;
				} catch {
					socket.end(reply(fail(400, "frame is not a JSON object")));
					return;
				}
				if (frame.v !== DEVICE_CONTROL_PROTOCOL) { socket.end(reply(fail(502, `protocol v${String(frame.v).slice(0, 20)} unsupported`))); return; }
				if (!tokenOk(frame.token)) {
					log("viewer: device control refused a frame with a bad socket token\n");
					socket.destroy();
					return;
				}
				const args = frame.args !== null && typeof frame.args === "object" && !Array.isArray(frame.args) ? (frame.args as Record<string, unknown>) : {};
				let out: DeviceControlReply;
				try { out = deviceControlAnswer(routes, frame.op, args); } catch (error) { out = fail(500, (error as Error).message); }
				socket.write(reply({ ...out, id: frame.id ?? null }));
			}
			if (buffer.length > DEVICE_FRAME_MAX) socket.end(reply(fail(413, `frame is larger than ${DEVICE_FRAME_MAX} characters`)));
		});
	});
	const listen = () => new Promise<void>((done, failed) => {
		server.once("error", failed);
		const umask = process.umask(0o077); // owner-only from the bind, not after
		try {
			server.listen(socketPath, () => { server.off("error", failed); done(); });
		} finally {
			process.umask(umask);
		}
	});
	try {
		await listen();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") return { state: "refused", reason: `cannot bind ${socketPath}: ${(error as Error).message}` };
		const seen = inodeOf(socketPath);
		if (await answers(socketPath)) {
			const other = readOwnerRecord(stateDir);
			return { state: "refused", reason: `device control already served by pid ${"record" in other ? other.record.pid : "unknown"} on ${socketPath}` };
		}
		// Stale: nothing answers. Unlink only the inode that was probed, so a racing starter's fresh socket survives.
		// shortcut: lstat→unlink is not atomic; two starters replacing one stale socket within microseconds could both bind; a lock file if that ever shows up.
		if (seen === null || inodeOf(socketPath) !== seen) return { state: "refused", reason: `${socketPath} changed while it was checked; another viewer is starting` };
		rmSync(socketPath, { force: true });
		try { await listen(); } catch (retry) { return { state: "refused", reason: `cannot bind ${socketPath}: ${(retry as Error).message}` }; }
	}
	chmodSync(socketPath, 0o600);
	const mine = inodeOf(socketPath);
	const tmp = `${recordFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			const record: OwnerRecord = { version: 1, pid: process.pid, socket: socketPath, token, started_at: new Date().toISOString() };
			writeSync(fd, `${JSON.stringify(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, recordFile);
	} catch (error) {
		server.close();
		rmSync(socketPath, { force: true });
		rmSync(tmp, { force: true });
		return { state: "refused", reason: `cannot write ${recordFile}: ${(error as Error).message}` };
	}
	let stopped = false;
	return {
		state: "listening",
		socket: socketPath,
		stop() {
			if (stopped) return;
			stopped = true;
			server.close();
			for (const socket of connections) socket.destroy();
			if (inodeOf(socketPath) === mine) rmSync(socketPath, { force: true }); // only the socket this owner bound
			const current = readOwnerRecord(stateDir);
			if ("record" in current && current.record.pid === process.pid && current.record.token === token) rmSync(recordFile, { force: true });
		},
	};
}

/** The owner record, refused unless it is a regular owner-only file this build wrote for this home's socket. */
function readOwnerRecord(stateDir: string): { record: OwnerRecord } | { error: string } {
	const file = deviceControlRecordFile(stateDir);
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return { error: `${file} is not an owner-only file of this user` };
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<OwnerRecord> | null;
		if (raw?.version !== 1 || !Number.isInteger(raw.pid) || raw.socket !== deviceControlSocket(stateDir) || !HEX64.test(String(raw.token)) || typeof raw.started_at !== "string") return { error: `${file} is not a record this build wrote` };
		return { record: raw as OwnerRecord };
	} catch (error) {
		return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? `no device control record at ${file}: is the viewer running?` : `${file} is unreadable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
	}
}

/** The CLI half: one frame to the viewer's owner socket, one bounded reply back. */
export function deviceControlRequest(stateDir: string, op: string, args: Record<string, unknown> = {}, timeoutMs = 5_000, isAlive: (pid: number) => boolean = pidAlive): Promise<DeviceControlReply> {
	const read = readOwnerRecord(stateDir);
	if ("error" in read) return Promise.resolve(fail(503, read.error));
	const { record } = read;
	if (!isAlive(record.pid)) return Promise.resolve(fail(503, `stale device control record: pid ${record.pid} is not running; start the viewer`));
	return new Promise((done) => {
		const socket = createConnection(record.socket);
		let buffer = "";
		let settled = false;
		const finish = (reply: DeviceControlReply) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			done(reply);
		};
		const timer = setTimeout(() => finish(fail(504, `the viewer did not answer on ${record.socket} within ${timeoutMs / 1000} s`)), timeoutMs);
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify({ v: DEVICE_CONTROL_PROTOCOL, token: record.token, id: 1, op, args })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index < 0) {
				if (buffer.length > REPLY_MAX) finish(fail(502, `the viewer's reply is larger than ${REPLY_MAX} characters`));
				return;
			}
			try {
				const reply = JSON.parse(buffer.slice(0, index)) as { ok?: unknown; result?: unknown; status?: unknown; error?: unknown };
				finish(reply.ok === true ? { ok: true, result: reply.result } : fail(typeof reply.status === "number" ? reply.status : 502, typeof reply.error === "string" ? reply.error : "the viewer refused the request"));
			} catch {
				finish(fail(502, "the viewer answered with a frame that is not JSON"));
			}
		});
		socket.once("error", (error: NodeJS.ErrnoException) => finish(fail(503, `the viewer is not answering on ${record.socket} (${error.code ?? error.message})`)));
		socket.once("close", () => finish(fail(503, `the viewer closed ${record.socket} without an answer`)));
	});
}
