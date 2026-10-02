/**
 * The cp-daemon control client (cp-wfo4): one request over `state/daemon.sock`
 * with the token from `state/daemon.json`. Used by the CLI and (job B) by
 * the updater, which imports it statically — the pre-merge copy, the one that
 * matches the running outer. Imports only `node:*` and `./daemon-*.ts`.
 */
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { DAEMON_PROTOCOL, daemonPaths, decodeFrames, encodeFrame, readDaemonState } from "./daemon-files.ts";

export type DaemonReply = { ok: true; detail?: string; state?: unknown } | { ok: false; error: string };

export const RELOAD_TIMEOUT_MS = 90_000;

export function daemonRequest(home: string, op: string, timeoutMs = 10_000): Promise<DaemonReply> {
	let state;
	try {
		state = readDaemonState(daemonPaths(home));
	} catch (error) {
		return Promise.resolve({ ok: false, error: (error as Error).message });
	}
	if (!state || state.state !== "running") return Promise.resolve({ ok: false, error: "cp-daemon is not running (state/daemon.json says so)" });
	const id = randomBytes(8).toString("hex");
	const { socket: path, token } = state;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (reply: DaemonReply): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(reply);
		};
		const timer = setTimeout(() => finish({ ok: false, error: `cp-daemon did not answer ${op} within ${timeoutMs / 1000}s` }), timeoutMs);
		const socket = connect(path, () => socket.write(encodeFrame({ id, token, protocol: DAEMON_PROTOCOL, op })));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			const { frames, rest } = decodeFrames(buffer + chunk);
			buffer = rest;
			for (const frame of frames as Array<{ id?: string; ok?: boolean; error?: string; detail?: string; state?: unknown }>) {
				if (frame instanceof Error || frame.id !== id) continue;
				finish(frame.ok === true ? { ok: true, ...(frame.detail ? { detail: frame.detail } : {}), ...(frame.state ? { state: frame.state } : {}) } : { ok: false, error: frame.error ?? frame.detail ?? "refused" });
			}
		});
		socket.on("error", (error) => finish({ ok: false, error: `cannot reach cp-daemon at ${path}: ${error.message}` }));
		socket.on("close", () => finish({ ok: false, error: "cp-daemon closed the connection without an answer" }));
	});
}

/** The updater's port (job B): each resolves to an error string, or undefined on success. */
export interface DaemonControl {
	hold(): Promise<string | undefined>;
	reload(): Promise<string | undefined>;
	health(): Promise<void>;
}

export function daemonControl(home: string, log: (line: string) => void = () => {}): DaemonControl {
	const ask = async (op: string, timeoutMs?: number): Promise<string | undefined> => {
		const reply = await daemonRequest(home, op, timeoutMs);
		return reply.ok ? undefined : `cp-daemon ${op}: ${reply.error}`;
	};
	return {
		hold: () => ask("hold"),
		reload: () => ask("reload", RELOAD_TIMEOUT_MS),
		health: async () => {
			const error = await ask("health");
			if (error) log(error);
		},
	};
}
