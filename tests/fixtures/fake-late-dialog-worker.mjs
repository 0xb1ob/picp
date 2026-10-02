#!/usr/bin/env node
/**
 * Fixture for tests/worker-process.test.ts (cp-xbxz): a worker that opens a
 * dialog at the one moment nobody can answer it — after its stdin has been
 * ended.
 *
 * `WorkerProcess.shutdown()` ends stdin and then waits out the grace period, so
 * a child that is still mid-turn can genuinely emit an `extension_ui_request`
 * with no channel left for the response. Real pi can reach that state; only a
 * fixture can reach it deterministically, because the OS decides whether a
 * dying child's last stdout chunk or its close arrives first.
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
	process.stdout.write(`${JSON.stringify({ type: "response", command: record.type, id: record.id, success: true })}\n`);
});

// stdin ended (the transport's graceful shutdown): ask a question anyway, then
// leave — the answer, if anyone tried to send one, has nowhere to land.
rl.on("close", () => {
	process.stdout.write(
		`${JSON.stringify({
			type: "extension_ui_request",
			id: "late-dialog-1",
			method: "select",
			title: "Postgres or SQLite?",
			options: ["Postgres", "SQLite"],
		})}\n`,
	);
	setTimeout(() => process.exit(0), 250);
});
