/**
 * Minimal RPC harness for tests.
 *
 * NOT the worker runtime: `WorkerProcess` (PLAN.md T3) is the real client and
 * owns framing, correlation and shutdown policy. This file exists so T1 can
 * prove the extension loads in a real pi process, and stays deliberately dumb.
 *
 * Framing follows docs/rpc.md: strict LF-delimited JSONL, never node:readline.
 *
 * Shutdown is bounded on purpose (cp-widget-test-hangs). A spawned pi child is
 * a refed handle on the test process's event loop: if a session is never
 * closed — or `close()` waits forever for a child that ignores SIGTERM — the
 * file's tests all pass, all print, and then the process simply never exits.
 * `--test-timeout` does not save you there: it bounds a test that hangs *in* a
 * test, not a process that outlives its tests. So this file holds two
 * invariants:
 *
 *   1. `close()` always settles, escalating SIGTERM -> SIGKILL on a clock
 *      rather than awaiting a child that may never die, and
 *   2. a child nobody closed is still reaped when the process exits.
 *
 * Note on `unref`: unref-ing the child and its stdio also makes a leaked
 * session unable to hold the runner open, and it works locally — but it
 * changes when a test file process is allowed to exit, and a run on CI stalled
 * with it in place. The suite is invoked with `--test-force-exit`, which
 * bounds the same case from the outside, so the refcount is left alone here.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** Grace per shutdown step: stdin EOF, then SIGTERM, then SIGKILL. */
const CLOSE_STEP_MS = 5_000;

/**
 * Every child this harness has spawned and not yet reaped. A test that forgets
 * to close a session must not leak a pi process onto the operator's machine,
 * so the last word is an exit hook rather than a hope.
 */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
let reaperInstalled = false;

function installReaper(): void {
	if (reaperInstalled) return;
	reaperInstalled = true;
	const reap = () => {
		for (const child of liveChildren) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone: nothing to reap.
			}
		}
		liveChildren.clear();
	};
	process.on("exit", reap);
}

export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

export interface RpcSession {
	send(record: RpcRecord): void;
	/** First record matching `predicate` (seen ones count), or fail after `timeoutMs` (default 30 s) naming it. */
	waitFor(predicate: (record: RpcRecord) => boolean, timeoutMs?: number): Promise<RpcRecord>;
	records(): readonly RpcRecord[];
	stderr(): string;
	/** Close stdin only: pi shuts down on its own, so a test can wait on what shutdown does (H7). */
	endInput(): void;
	close(): Promise<number | null>;
}

export interface StartRpcOptions {
	cwd: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
}

export function startRpc(options: StartRpcOptions): RpcSession {
	const child: ChildProcessWithoutNullStreams = spawn("pi", ["--mode", "rpc", ...(options.args ?? [])], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;

	installReaper();
	liveChildren.add(child);

	const seen: RpcRecord[] = [];
	const waiters: Array<{ predicate: (record: RpcRecord) => boolean; resolve: (record: RpcRecord) => void }> = [];
	let stdoutBuffer = "";
	let stderrText = "";
	let exited = false;
	const exitPromise = new Promise<number | null>((resolve) => {
		child.on("close", (code) => {
			exited = true;
			liveChildren.delete(child);
			resolve(code);
		});
	});

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		// LF only. A trailing CR is stripped; nothing else splits records.
		let index = stdoutBuffer.indexOf("\n");
		while (index !== -1) {
			const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			if (line.length > 0) {
				let record: RpcRecord | undefined;
				try {
					record = JSON.parse(line) as RpcRecord;
				} catch {
					record = undefined;
				}
				if (record) {
					seen.push(record);
					for (let i = waiters.length - 1; i >= 0; i--) {
						const waiter = waiters[i];
						if (waiter && waiter.predicate(record)) {
							waiters.splice(i, 1);
							waiter.resolve(record);
						}
					}
				}
			}
			index = stdoutBuffer.indexOf("\n");
		}
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderrText += chunk;
	});

	return {
		send(record) {
			child.stdin.write(`${JSON.stringify(record)}\n`);
		},
		waitFor(predicate, timeoutMs = 30_000) {
			const existing = seen.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<RpcRecord>((resolve, reject) => {
				const timer = setTimeout(() => {
					const at = waiters.findIndex((w) => w.resolve === wrapped);
					if (at !== -1) waiters.splice(at, 1);
					reject(
						new Error(
							`timed out after ${timeoutMs}ms waiting for RPC record matching ${predicate.toString()}\nstderr:\n${stderrText}\nseen: ${seen
								.map((r) => r.type)
								.join(",")}`,
						),
					);
				}, timeoutMs);
				const wrapped = (record: RpcRecord) => {
					clearTimeout(timer);
					resolve(record);
				};
				waiters.push({ predicate, resolve: wrapped });
			});
		},
		endInput() {
			child.stdin.end();
		},
		records() {
			return seen;
		},
		stderr() {
			return stderrText;
		},
		/**
		 * Invariant 1: this always settles. Ask, then SIGTERM, then SIGKILL, each
		 * with its own grace; a child that survives all three is reported as `null`
		 * rather than awaited forever, because a test process that cannot be closed
		 * is a failure to surface, not a reason to block a worker.
		 */
		async close() {
			if (exited) return exitPromise;
			const steps: Array<() => void> = [
				() => child.stdin.end(),
				() => child.kill("SIGTERM"),
				() => child.kill("SIGKILL"),
			];
			for (const step of steps) {
				try {
					step();
				} catch {
					// The child is already gone; fall through to the exit race.
				}
				const TIMED_OUT = Symbol("timed-out");
				let timer: NodeJS.Timeout | undefined;
				const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
					timer = setTimeout(() => resolve(TIMED_OUT), CLOSE_STEP_MS);
				});
				const outcome = await Promise.race([exitPromise, deadline]);
				clearTimeout(timer);
				if (outcome !== TIMED_OUT) return outcome;
			}
			liveChildren.delete(child);
			return null;
		},
	};
}
