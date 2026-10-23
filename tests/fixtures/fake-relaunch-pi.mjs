#!/usr/bin/env node
/** External pi stand-in for tests/e2e/operator-launcher-s27.test.ts; records argv and emits restart markers. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const log = process.env.FAKE_RELAUNCH_LOG;
appendFileSync(log, `${JSON.stringify(process.argv.slice(6))}\n`);
const runs = readFileSync(log, "utf8").trim().split("\n").length;
const mode = process.env.FAKE_RELAUNCH_MODE;
const file = process.env.CP_OPERATOR_RELAUNCH_FILE;
const marker = (pid) => writeFileSync(file, JSON.stringify({ version: 1, id: "dc-20260101000000-0123abcd", pid, session_file: process.env.FAKE_RELAUNCH_SESSION, at: "2026-01-01T00:00:00.000Z" }), { mode: 0o600 });
if (file && (mode === "always" || (mode === "once" && runs === 1))) {
	marker(process.pid);
	process.exit(0);
}
if (file && mode === "other" && runs === 1) {
	marker(process.pid + 100_000);
	process.exit(0);
}
process.exit(runs);
