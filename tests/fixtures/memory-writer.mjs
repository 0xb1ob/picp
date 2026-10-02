#!/usr/bin/env node
/**
 * Fixture for the cp-nqj concurrency test: one of N real processes writing to
 * one `data/learnings.md` through the real `promoteCandidate` path.
 *
 * This is the measurement that decides the mechanism. `O_APPEND` makes
 * concurrent appenders atomic at the kernel; a read-modify-write of the whole
 * file has a lost-update window between the read and the write that no amount
 * of atomicity closes (measured on this defect: 424 of 1600 writes survived).
 * So the append stays, and this fixture is what a future refactor to
 * read-modify-write would have to get past.
 *
 * Usage: node memory-writer.mjs <home> <candidates-json> <first-date>
 *   candidates-json — a JSON array of exact candidate lines this process owns.
 *   first-date      — `YYYY-MM-DD`; this process promotes one per consecutive
 *                     day, so no two processes share a day and the per-day
 *                     bound is never what refuses a write.
 *
 * Deliberately NOT a `*.test.ts`: it is a child process, not a suite.
 */

import { resolve } from "node:path";

const [home, candidatesJson, firstDate] = process.argv.slice(2);
if (!home || !candidatesJson || !firstDate) {
	console.error("usage: memory-writer.mjs <home> <candidates-json> <first-date>");
	process.exit(2);
}

const candidates = JSON.parse(candidatesJson);
const start = Date.parse(`${firstDate}T12:00:00Z`);

const { promoteCandidate } = await import(resolve(import.meta.dirname, "..", "..", "src", "curation.ts"));

const written = [];
for (const [index, candidate] of candidates.entries()) {
	const at = new Date(start + index * 86_400_000);
	const result = promoteCandidate(home, {
		candidate,
		lesson: candidate.replace(/^\d{4}-\d{2}-\d{2}\s+/, ""),
		evidence: "cp-nqj; src/curation.ts; PR #85",
		at,
	});
	written.push(result.line);
}

process.stdout.write(`${JSON.stringify(written)}\n`);
