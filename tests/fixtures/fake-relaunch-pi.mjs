#!/usr/bin/env node
/** External pi stand-in for tests/e2e/operator-launcher-s27.test.ts; records argv and emits restart markers. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const log = process.env.FAKE_RELAUNCH_LOG;
appendFileSync(log, `${JSON.stringify(process.argv.slice(6))}\n`);
const runs = readFileSync(log, "utf8").trim().split("\n").length;
const mode = process.env.FAKE_RELAUNCH_MODE;
const file = process.env.CP_OPERATOR_RELAUNCH_FILE;
const marker = (pid) => writeFileSync(file, JSON.stringify({ version: 1, id: "dc-20260101000000-0123abcd", pid, session_file: process.env.FAKE_RELAUNCH_SESSION, at: "2026-01-01T00:00:00.000Z" }), { mode: 0o600 });
if (mode === "sliding" && runs === 3) await new Promise((done) => setTimeout(done, 1500));
if (file && mode === "sliding") { marker(process.pid); process.exit(0); }
if (file && mode.startsWith("bad-")) {
  writeFileSync(file, mode === "bad-json" ? "not json" : JSON.stringify({ version: mode === "bad-version" ? 2 : 1, id: "dc-20260101000000-0123abcd", pid: process.pid, session_file: mode === "bad-relative" ? "relative.jsonl" : mode === "bad-session" ? "/etc/passwd" : process.env.FAKE_RELAUNCH_SESSION }));
  process.exit(1);
}
if (file && mode === "signal") { marker(process.pid); process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 1000); await new Promise(() => {}); }
if (file && (mode === "always" || (mode === "once" && runs === 1))) {
	marker(process.pid);
	process.exit(0);
}
if (file && mode === "other" && runs === 1) {
	marker(process.pid + 100_000);
	process.exit(0);
}
process.exit(runs);
