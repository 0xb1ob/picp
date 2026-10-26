/**
 * cp-wfo4: the CLI's and the outer's production kill ports. Retained (P14b): the -1/0/1/undefined guards are
 * unreachable from an e2e surface — no real run hands those pids to the port, and sending one would hit real processes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cliKill, outerKill } from "../src/service/daemon.ts";

/** -1 is every process this user owns, 0 our process group, 1 init, absent a failed spawn. */
const INVALID_PIDS = [-1, 0, 1, undefined, 1.5, Number.NaN] as unknown as number[];

function proveGuarded<S extends "SIGTERM" | "SIGKILL">(port: (log: (line: string) => void, raw: (pid: number, signal: NodeJS.Signals) => void) => (pid: number, signal: S) => void, signal: S): void {
	const raw: Array<[number, string]> = [];
	const lines: string[] = [];
	const kill = port((line) => void lines.push(line), (pid, sent) => void raw.push([pid, sent]));
	for (const pid of INVALID_PIDS) kill(pid, signal);
	assert.deepEqual(raw, [], "no invalid pid reaches process.kill");
	assert.deepEqual(lines, INVALID_PIDS.map((pid) => `refused to send ${signal} to pid ${String(pid)}: not one process`));
	kill(4242, signal);
	assert.deepEqual(raw, [[4242, signal]]);
	const gone = port((line) => void lines.push(line), () => {
		throw new Error("kill ESRCH");
	});
	gone(4243, signal);
	assert.equal(lines.at(-1), `kill ${signal} 4243: kill ESRCH`, "a failed signal is logged, not thrown");
}

test("the CLI's production kill port: -1, 0, 1 and undefined never reach process.kill", () => proveGuarded(cliKill, "SIGTERM"));

test("the outer's production kill port: -1, 0, 1 and undefined never reach process.kill", () => proveGuarded(outerKill, "SIGKILL"));
