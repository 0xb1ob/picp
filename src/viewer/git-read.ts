/**
 * The workbench's one git runner (cp-s560 W2c): read-only, bounded, never a shell.
 *
 * Only `diff`/`log`/`show`/`status`/`for-each-ref` run, `--output*` and `--ext-diff` are refused before
 * anything spawns, and `GIT_OPTIONAL_LOCKS=0` keeps `git status` from refreshing the index. Callers build
 * argv in code; request text never reaches it except a sha that already matched `SHA`.
 */

import { spawn } from "node:child_process";

export const SHA = /^[0-9a-f]{40}$/;
const SUBCOMMANDS = new Set(["diff", "log", "show", "status", "for-each-ref"]);
const MAX_RUNNING = 4;
const QUEUE_WAIT_MS = 2_000;

export interface GitResult {
	ok: boolean;
	stdout: string;
	truncated: boolean;
	reason?: string;
}

let running = 0;
const waiting: Array<() => void> = [];

/** A slot within `QUEUE_WAIT_MS`, or false when four runs are still busy. */
function acquire(): Promise<boolean> {
	if (running < MAX_RUNNING) {
		running += 1;
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const wake = (): void => {
			clearTimeout(timer);
			running += 1;
			resolve(true);
		};
		const timer = setTimeout(() => {
			waiting.splice(waiting.indexOf(wake), 1);
			resolve(false);
		}, QUEUE_WAIT_MS);
		waiting.push(wake);
	});
}

function release(): void {
	running -= 1;
	waiting.shift()?.();
}

export async function runGit(cwd: string, args: readonly string[], opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<GitResult> {
	if (!SUBCOMMANDS.has(args[0] ?? "") || args.some((arg) => arg.startsWith("--output") || arg === "--ext-diff")) {
		return { ok: false, stdout: "", truncated: false, reason: "refused" };
	}
	if (!(await acquire())) return { ok: false, stdout: "", truncated: false, reason: "busy" };
	const maxBytes = opts.maxBytes ?? 1_000_000;
	try {
		return await new Promise<GitResult>((resolve) => {
			const child = spawn(
				"git",
				["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "log.showSignature=false", "-C", cwd, ...args],
				{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
			);
			const chunks: Buffer[] = [];
			let size = 0;
			let truncated = false;
			let reason: string | undefined;
			let stderr = "";
			const timer = setTimeout(() => {
				reason = "git timed out";
				child.kill();
			}, opts.timeoutMs ?? 10_000);
			child.stdout.on("data", (chunk: Buffer) => {
				if (truncated) return;
				const room = maxBytes - size;
				chunks.push(chunk.subarray(0, room));
				size += Math.min(room, chunk.length);
				if (chunk.length >= room) {
					truncated = true;
					child.kill();
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < 2000) stderr += chunk.toString("utf8");
			});
			const finish = (code: number | null): void => {
				clearTimeout(timer);
				const stdout = Buffer.concat(chunks).toString("utf8");
				if (truncated) resolve({ ok: true, stdout, truncated });
				else if (reason) resolve({ ok: false, stdout: "", truncated: false, reason });
				else if (code === 0) resolve({ ok: true, stdout, truncated: false });
				else resolve({ ok: false, stdout: "", truncated: false, reason: stderr.split("\n")[0]?.trim().slice(0, 300) || `git exited ${code}` });
			};
			child.on("error", () => {
				reason ??= "git unavailable";
				finish(null);
			});
			child.on("close", finish);
		});
	} finally {
		release();
	}
}
