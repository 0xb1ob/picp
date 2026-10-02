#!/usr/bin/env node
/**
 * Fixture for tests/worker-process.test.ts's `get_entries` cap (cp-xbxz): a
 * minimal stand-in for `pi --mode rpc` that answers `get_entries` with 500
 * entries, and refuses an unknown `since` exactly as pi does (`success: false`).
 *
 * The cap is the transport's arithmetic — which slice, which cursor, how many
 * dropped — so proving it with a fixture is both faster and stricter than
 * scripting 500 real turns through a model.
 *
 * Deliberately NOT a `*.test.ts`: it is a child process, not a suite.
 */

import { createInterface } from "node:readline";

const TOTAL = 500;
const entries = Array.from({ length: TOTAL }, (_, index) => ({
	type: "message",
	id: `e-${index}`,
	parentId: index === 0 ? null : `e-${index - 1}`,
	message: { role: index % 2 === 0 ? "user" : "assistant", content: `entry ${index}` },
}));

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
	if (!line.trim()) return;
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	const { type, id, since } = record;
	if (type === "get_entries") {
		if (since !== undefined) {
			const at = entries.findIndex((entry) => entry.id === since);
			if (at === -1) {
				process.stdout.write(
					`${JSON.stringify({ type: "response", command: type, id, success: false, error: `unknown entry id ${since}` })}\n`,
				);
				return;
			}
			const after = entries.slice(at + 1);
			process.stdout.write(
				`${JSON.stringify({ type: "response", command: type, id, success: true, data: { entries: after, leafId: `e-${TOTAL - 1}` } })}\n`,
			);
			return;
		}
		process.stdout.write(
			`${JSON.stringify({ type: "response", command: type, id, success: true, data: { entries, leafId: `e-${TOTAL - 1}` } })}\n`,
		);
		return;
	}
	process.stdout.write(`${JSON.stringify({ type: "response", command: type, id, success: true })}\n`);
});

rl.on("close", () => {
	process.exit(0);
});
