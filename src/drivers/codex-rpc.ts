/**
 * One `codex app-server`, always inside its own systemd scope, spoken to in LF-framed JSON lines. A bad line, a refused
 * scope or the exit rejects every pending request; an unhandled server request gets a `-32601` reply, never an accept.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type CodexContainment, containedCommand, containmentRefusal } from "./codex-containment.ts";
import type { JsonRpcNotification, RequestId } from "./codex-protocol.ts";

export const RPC_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 8 * 1024;

export interface CodexRpcExit { code: number | null; signal: string | null; error?: string }

export class CodexRpcError extends Error {
	/** The JSON-RPC error code when the server answered with one. */
	code?: number;
}

export interface CodexRpc {
	/** The scope's own child (`systemd-run`, then its leader); the app-server is that leader's child. */
	pid: number | undefined;
	appServerPid(): number | undefined;
	request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
	onNotification(listener: (message: JsonRpcNotification) => void): void;
	onRequest(method: string, handler: (params: unknown) => unknown): void;
	stderrTail(): string;
	closeInput(): void;
	/** Kills the whole scope once it is contained; before that, signals the own child. */
	kill(signal?: NodeJS.Signals): void;
	exited: Promise<CodexRpcExit>;
}

export interface CodexRpcOptions { command: string; args: readonly string[]; cwd: string; env: Record<string, string>; containment: CodexContainment }

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** Starts the app-server inside its own scope; no request is written until the scope leader reports it contained. */
export function spawnCodexRpc(options: CodexRpcOptions): CodexRpc {
	const wrapped = containedCommand(options.containment, options.command, options.args, options.env);
	const child = spawn(wrapped.command, wrapped.args, { cwd: options.cwd, env: wrapped.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
	const pending = new Map<RequestId, Pending>();
	const handlers = new Map<string, (params: unknown) => unknown>();
	const listeners: Array<(message: JsonRpcNotification) => void> = [];
	let stderr = "";
	let buffer = "";
	let nextId = 1;
	let broken: string | undefined;

	const failAll = (why: string) => {
		broken ??= why;
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			pending.delete(id);
			entry.reject(new CodexRpcError(`${why}${stderr ? `; stderr: ${stderr.slice(-512)}` : ""}`));
		}
	};
	const write = (message: Record<string, unknown>): boolean => {
		if (child.stdin.destroyed || !child.stdin.writable) return false;
		child.stdin.write(`${JSON.stringify(message)}\n`);
		return true;
	};
	const answer = async (id: RequestId, method: string, params: unknown) => {
		const handler = handlers.get(method);
		if (handler === undefined) {
			write({ id, error: { code: -32601, message: `picp has no handler for ${method}` } });
			return;
		}
		try {
			write({ id, result: await handler(params) });
		} catch (error) {
			write({ id, error: { code: -32603, message: (error as Error).message } });
		}
	};
	const dispatch = (line: string) => {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			failAll(`codex app-server sent a line that is not JSON (${line.slice(0, 80)})`);
			return;
		}
		const id = message.id as RequestId | undefined;
		const method = typeof message.method === "string" ? message.method : undefined;
		if (id !== undefined && method !== undefined) {
			void answer(id, method, message.params);
		} else if (id !== undefined) {
			const entry = pending.get(id);
			if (entry === undefined) return;
			pending.delete(id);
			clearTimeout(entry.timer);
			const error = message.error as { code?: number; message?: string } | undefined;
			if (error !== undefined) entry.reject(Object.assign(new CodexRpcError(error.message ?? "codex app-server error"), { code: error.code }));
			else entry.resolve(message.result);
		} else if (method !== undefined) {
			for (const listener of listeners) {
				try {
					listener({ method, params: message.params });
				} catch {
					// A listener must never break the stream.
				}
			}
		}
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
			const line = buffer.slice(0, cut).replace(/\r$/, "");
			buffer = buffer.slice(cut + 1);
			if (line.trim() !== "") dispatch(line);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-STDERR_TAIL);
	});
	child.stdin.on("error", () => {});
	let killFile: string | undefined;
	let appServerPid: number | undefined;
	let relayed: CodexRpcExit | undefined;
	let contained: () => void = () => {};
	const ready = new Promise<void>((ok) => (contained = ok));
	const killScope = () => {
		if (killFile === undefined) return;
		try {
			writeFileSync(killFile, "1");
		} catch {
			// The scope is already gone.
		}
	};
	const lifeline = child.stdio[3] as Readable;
	let lines = "";
	lifeline.setEncoding("utf8");
	lifeline.on("error", () => {});
	lifeline.on("data", (chunk: string) => {
		lines += chunk;
		for (let cut = lines.indexOf("\n"); cut >= 0; cut = lines.indexOf("\n")) {
			let message: { contained?: { killFile?: unknown; pid?: unknown }; refused?: unknown; exit?: CodexRpcExit };
			try {
				message = JSON.parse(lines.slice(0, cut)) as typeof message;
			} catch {
				message = { refused: "its scope leader sent a line that is not JSON" };
			}
			lines = lines.slice(cut + 1);
			const file = message.contained?.killFile;
			if (typeof file === "string" && file.endsWith(`/${wrapped.unit}/cgroup.kill`)) {
				killFile = file;
				if (typeof message.contained?.pid === "number") appServerPid = message.contained.pid;
				contained();
			} else if (message.exit !== undefined) relayed = message.exit;
			else failAll(containmentRefusal(String(message.refused ?? "an unexpected scope report")));
		}
	});
	const lifelineClosed = new Promise<void>((done) => lifeline.once("close", () => done()));
	const exited = new Promise<CodexRpcExit>((done) => {
		const finish = async (exit: CodexRpcExit) => {
			await Promise.race([lifelineClosed, sleep(2_000, undefined, { ref: false })]);
			killScope();
			const seen = relayed ?? exit;
			if (killFile === undefined) failAll(containmentRefusal(`the scope never started; exit code ${exit.code}, signal ${exit.signal}${stderr ? `; stderr: ${stderr.slice(-300)}` : ""}`));
			failAll(`codex app-server exited (code ${seen.code}, signal ${seen.signal})`);
			done(seen);
		};
		child.once("exit", (code, signal) => void finish({ code, signal }));
		child.once("error", (error) => void finish({ code: child.exitCode, signal: child.signalCode, error: error.message }));
	});

	return {
		pid: child.pid,
		appServerPid: () => appServerPid,
		request<T>(method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
			if (broken !== undefined) return Promise.reject(new CodexRpcError(broken));
			const id = nextId++;
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => failAll(`${method} got no answer in ${timeoutMs} ms`), timeoutMs);
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
				void ready.then(() => {
					if (pending.has(id) && !write({ id, method, ...(params === undefined ? {} : { params }) })) failAll(`codex app-server input is closed (${method})`);
				});
			});
		},
		notify(method, params) {
			write({ method, ...(params === undefined ? {} : { params }) });
		},
		onNotification(listener) {
			listeners.push(listener);
		},
		onRequest(method, handler) {
			handlers.set(method, handler);
		},
		stderrTail: () => stderr,
		closeInput() {
			child.stdin.end();
		},
		kill(signal = "SIGTERM") {
			if (killFile === undefined) child.kill(signal);
			else killScope();
		},
		exited,
	};
}
