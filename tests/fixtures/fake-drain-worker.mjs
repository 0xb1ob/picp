#!/usr/bin/env node
/**
 * Fixture for the drain projection (cp-epy2 §4.2 item 3): a stand-in for
 * `pi --mode rpc` whose busy/idle transitions the test drives explicitly.
 *
 *  - `get_state` answers readiness AND emits `agent_start` in the same write,
 *    so the worker is busy by the time `await getState()` resolves (no timing
 *    race; the same trick as fake-busy-worker.mjs).
 *  - any `prompt` answers and then emits `agent_settled`, so a test can turn
 *    one worker idle and leave the other mid-turn.
 *
 * Deliberately NOT a `*.test.ts`: it is a child process, not a suite.
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
	if (!line.trim()) return;
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	const { type, id } = record;
	if (type === "get_state") {
		const response = JSON.stringify({
			type: "response",
			command: "get_state",
			id,
			success: true,
			data: { isStreaming: false },
		});
		process.stdout.write(`${response}\n${JSON.stringify({ type: "agent_start" })}\n`);
		return;
	}
	const response = JSON.stringify({ type: "response", command: type, id, success: true });
	if (type === "prompt") {
		process.stdout.write(`${response}\n${JSON.stringify({ type: "agent_settled" })}\n`);
		return;
	}
	process.stdout.write(`${response}\n`);
});

rl.on("close", () => {
	process.exit(0);
});
