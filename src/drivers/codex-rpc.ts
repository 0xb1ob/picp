/**
 * One `codex app-server` child spoken to in LF-framed JSON lines. A bad line or the child's exit rejects every
 * pending request; a server request with no handler gets a `-32601` error reply, never silence and never an accept.
 */
import { spawn } from "node:child_process";
import type { JsonRpcNotification, RequestId } from "./codex-protocol.ts";

export const RPC_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 8 * 1024;

export interface CodexRpcExit { code: number | null; signal: string | null; error?: string }

export class CodexRpcError extends Error {
	/** The JSON-RPC error code when the server answered with one. */
	code?: number;
}

export interface CodexRpc {
	pid: number | undefined;
	request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
	onNotification(listener: (message: JsonRpcNotification) => void): void;
	onRequest(method: string, handler: (params: unknown) => unknown): void;
	stderrTail(): string;
	closeInput(): void;
	kill(signal?: NodeJS.Signals): void;
	exited: Promise<CodexRpcExit>;
}

export interface CodexRpcOptions { command: string; args: readonly string[]; cwd: string; env: Record<string, string> }

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export function spawnCodexRpc(options: CodexRpcOptions): CodexRpc {
	const child = spawn(options.command, [...options.args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
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
	const exited = new Promise<CodexRpcExit>((done) => {
		child.once("exit", (code, signal) => {
			failAll(`codex app-server exited (code ${code}, signal ${signal})`);
			done({ code, signal });
		});
		child.once("error", (error) => {
			failAll(`codex app-server failed to run (${error.message})`);
			done({ code: child.exitCode, signal: child.signalCode, error: error.message });
		});
	});

	return {
		pid: child.pid,
		request<T>(method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
			if (broken !== undefined) return Promise.reject(new CodexRpcError(broken));
			const id = nextId++;
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => failAll(`${method} got no answer in ${timeoutMs} ms`), timeoutMs);
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
				if (!write({ id, method, ...(params === undefined ? {} : { params }) })) failAll(`codex app-server input is closed (${method})`);
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
			child.kill(signal);
		},
		exited,
	};
}
