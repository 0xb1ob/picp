#!/usr/bin/env node
/**
 * Fixture for tests/worker-process.test.ts's ordering test: a minimal stand-in
 * for `pi --mode rpc` that answers whatever it is asked and, once, emits an
 * unprompted `agent_start` with no matching `agent_settled` — so `#busy`
 * reads true throughout. prompt/steer/follow_up answer with pi 0.99.1's
 * `data.disposition`: `DISPOSITION=<word>` in the message forces that word
 * (`DISPOSITION=none` omits `data`, like pi < 0.99.1); otherwise a bare prompt
 * is `started` and everything else `queued` — so the test proves the receipt
 * follows the disposition, never the busy flag.
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
		// Answer readiness AND declare busy in the same write, so both lines
		// land in the same stdout chunk and are handled before the caller's
		// `await getState()` resolves — no timing race, just ordering.
		const response = JSON.stringify({ type: "response", command: "get_state", id, success: true, data: { isStreaming: false } });
		const busy = JSON.stringify({ type: "agent_start" });
		process.stdout.write(`${response}\n${busy}\n`);
		return;
	}
	// Every other request (prompt, steer, follow_up, abort, ...) is accepted.
	// No agent_settled is ever emitted: `#busy` stays true for the life of
	// this process, by design.
	if (type === "prompt" || type === "steer" || type === "follow_up") {
		const text = String(record.message ?? "");
		const forced = /DISPOSITION=(\w+)/.exec(text)?.[1];
		const disposition = forced ?? (type === "prompt" && !record.streamingBehavior ? "started" : "queued");
		const data = disposition === "none" ? {} : { data: { disposition } };
		process.stdout.write(`${JSON.stringify({ type: "response", command: type, id, success: true, ...data })}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify({ type: "response", command: type, id, success: true })}\n`);
});

rl.on("close", () => {
	process.exit(0);
});
