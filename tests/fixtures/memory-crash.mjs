#!/usr/bin/env node
/**
 * Fixture for the cp-nqj truncation tests: crash a real memory write at an
 * exact syscall, in a real process, through the real `src/memory.ts` path.
 *
 * `writeFileSync(path, text)` opens `O_TRUNC` — the file is **zero bytes**
 * between the open and the write, and a process killed in that window used to
 * leave `data/learnings.md` empty. Proving that window is closed needs a crash
 * at a named instant, not a mock: this fixture patches one `node:fs` function
 * to SIGKILL itself and then runs the real function.
 *
 * Node's builtin ESM named exports read through the CJS exports object, so
 * patching `require("node:fs").writeSync` before the dynamic `import()` is seen
 * by `src/memory.ts`'s own `import { … } from "node:fs"` — no loader, no mock
 * module, and the code under test is the shipped code.
 *
 * Usage: node memory-crash.mjs <home> <archive|capture> <write|rename> <nth> [line]
 *   write   — kill on the nth content write, before any byte of it lands
 *             (exactly the instant `writeFileSync` would have left the target
 *             truncated and empty).
 *   rename  — kill on the nth rename, after that file was written and fsynced
 *             but before it is visible (the atomic write's own window).
 *   nth     — 1-based. `archiveEntry` writes `archive.md` first (1) and
 *             `learnings.md` second (2), so 2 is the total-loss path.
 *
 * Deliberately NOT a `*.test.ts`: it is a child process, not a suite.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");

const [home, op, point, nthRaw, line] = process.argv.slice(2);
const nth = Number(nthRaw ?? "1");
if (!home || !op || !point || !Number.isInteger(nth) || nth < 1) {
	console.error("usage: memory-crash.mjs <home> <archive|capture> <write|rename> <nth> [line]");
	process.exit(2);
}

const die = () => {
	// A real crash, not an exception: nothing runs after this — no `finally`, no
	// flush, no cleanup — which is the whole point.
	process.kill(process.pid, "SIGKILL");
};

let seen = 0;
if (point === "write") {
	const realWriteSync = fs.writeSync;
	fs.writeSync = (...args) => {
		// Content writes only (string or buffer); an empty write is not the window
		// we are proving.
		const payload = args[1];
		const bytes = typeof payload === "string" || ArrayBuffer.isView(payload) ? payload.length : 0;
		if (bytes > 0 && ++seen === nth) die();
		return realWriteSync.apply(fs, args);
	};
} else if (point === "rename") {
	const realRenameSync = fs.renameSync;
	fs.renameSync = (...args) => {
		if (++seen === nth) die();
		return realRenameSync.apply(fs, args);
	};
} else {
	console.error(`unknown crash point: ${point}`);
	process.exit(2);
}

const memory = await import(resolve(import.meta.dirname, "..", "..", "src", "memory.ts"));

if (op === "archive") {
	memory.archiveEntry(home, line, { reason: "crash-injection fixture", at: new Date("2026-08-27T12:00:00Z") });
} else if (op === "capture") {
	memory.captureCandidate(home, "a capture that will not survive this process", new Date("2026-08-27T12:00:00Z"));
} else {
	console.error(`unknown op: ${op}`);
	process.exit(2);
}

// Reached only if the crash point was never hit, which is itself a test failure.
console.log("SURVIVED");
