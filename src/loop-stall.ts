/**
 * F4: the parent's event-loop stall monitor. A tick late by `LOOP_STALL_MS` or more writes one `loop_stall` line
 * to `state/daemon.log`, naming the operations that were running during the stall (see `operation`).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { daemonPaths } from "./service/daemon-files.ts";

export const LOOP_STALL_MS = 5_000;
const TICK_MS = 250;
const OPS_MAX = 10;

const active = new Map<number, string>();
let ended: string[] = [];
let nextId = 0;
let monitor: { timer: ReturnType<typeof setInterval>; lag: IntervalHistogram } | undefined;

/** Marks `name` active until `fn` (sync, or the promise it returns) settles, so a stall during it names it. */
export function operation<T>(name: string, fn: () => T): T {
	const end = beginOperation(name);
	let result: T;
	try {
		result = fn();
	} catch (error) {
		end();
		throw error;
	}
	if (result instanceof Promise) return result.finally(end) as T;
	end();
	return result;
}

/** `operation` for a span with no single function (a tool call between its start and end events); call the result once. */
export function beginOperation(name: string): () => void {
	const id = ++nextId;
	active.set(id, name);
	return () => {
		if (active.delete(id) && monitor) ended.push(name);
	};
}

/** One `daemon.log` line; never throws (a failed write goes to stderr). */
export function daemonLogWriter(home: string): (line: string) => void {
	return (line) => {
		const text = `${new Date().toISOString()} cp-parent[${process.pid}]: ${line}\n`;
		try {
			const file = daemonPaths(home).log;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, text, { mode: 0o600 });
		} catch (error) {
			process.stderr.write(`daemon.log unwritable (${(error as Error).message}): ${text}`);
		}
	};
}

/** Starts the process-wide monitor once (a second call is a no-op); `stopLoopStallMonitor` ends it. */
export function startLoopStallMonitor(log: (line: string) => void, thresholdMs = LOOP_STALL_MS): void {
	if (monitor) return;
	const lag = monitorEventLoopDelay({ resolution: 20 });
	lag.enable();
	let last = Date.now();
	const timer = setInterval(() => {
		const now = Date.now();
		const delay = now - last - TICK_MS;
		last = now;
		// The late tick is the trigger; the histogram adds the loop's own max and p99 since the previous tick.
		if (delay >= thresholdMs) {
			const ops = [...new Set([...ended, ...active.values()])];
			const named = ops.length === 0 ? "none" : ops.slice(0, OPS_MAX).join(",") + (ops.length > OPS_MAX ? `,+${ops.length - OPS_MAX}` : "");
			log(`loop_stall delay_ms=${delay} lag_max_ms=${Math.round(lag.max / 1e6)} lag_p99_ms=${Math.round(lag.percentile(99) / 1e6)} ops=${named}`);
		}
		ended = [];
		lag.reset();
	}, TICK_MS);
	timer.unref();
	monitor = { timer, lag };
}

export function stopLoopStallMonitor(): void {
	if (!monitor) return;
	clearInterval(monitor.timer);
	monitor.lag.disable();
	monitor = undefined;
	ended = [];
}
