/**
 * H7: no wall clock under 5000 ms decides a test. Waits end on their event; a
 * clock is only a hang guard, and one under 5 s is a flake on a loaded host.
 * Product inputs (a `timeoutMs` exercising the code's own timeout) are not scanned.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

const FLOOR_MS = 5_000;
const N = String.raw`(\d[\d_]*)`;
const WAIT_CALL = /\b(?:waitFor|waitForEvent|waitForSettled|getState|until)\s*(?:<[^>()]*>)?\(/g;

const RULES: ReadonlyArray<{ what: string; pattern: RegExp }> = [
	{ what: "timeout option", pattern: new RegExp(String.raw`\btimeout\s*:\s*${N}(?![\d_])`, "g") },
	{ what: "t.timeout", pattern: new RegExp(String.raw`\.timeout\s*(?:=|\()\s*${N}`, "g") },
	{ what: "Date.now() deadline", pattern: new RegExp(String.raw`Date\.now\(\)\s*-\s*[\w.]+\s*>=?\s*${N}`, "g") },
	{ what: "Date.now() deadline", pattern: new RegExp(String.raw`deadline\w*\s*=\s*Date\.now\(\)\s*\+\s*${N}`, "gi") },
	{ what: "timeout constant", pattern: new RegExp(String.raw`\bconst\s+\w*(?:TIMEOUT|DEADLINE)\w*\s*=\s*${N}`, "g") },
	{ what: "default parameter", pattern: new RegExp(String.raw`[({,]\s*(?:\w*[Tt]imeout\w*|\w*[Dd]eadline\w*|\w*Ms|ms)\s*(?::\s*number\s*)?=\s*${N}(?![\d_])`, "g") },
];

const ms = (literal: string): number => Number(literal.replaceAll("_", ""));

/** The argument text of the call whose `(` is at `open`, by paren depth. */
function argsAt(text: string, open: number): string {
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		if (text[i] === "(") depth += 1;
		else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
	}
	return text.slice(open + 1);
}

/** Every sub-floor wall clock in `text`, as `file:line: what (N ms)`. */
function shortTimeouts(file: string, text: string): string[] {
	const hits: string[] = [];
	const hit = (index: number, what: string, literal: string) => {
		if (ms(literal) < FLOOR_MS) hits.push(`${file}:${text.slice(0, index).split("\n").length}: ${what} of ${ms(literal)} ms is under ${FLOOR_MS} ms`);
	};
	for (const { what, pattern } of RULES) for (const match of text.matchAll(pattern)) hit(match.index, what, match[1] as string);
	for (const call of text.matchAll(WAIT_CALL)) {
		const open = call.index + call[0].length - 1;
		const args = argsAt(text, open);
		const option = /\btimeoutMs\s*:\s*(\d[\d_]*)/.exec(args);
		if (option) hit(open + 1 + option.index, "wait guard timeoutMs", option[1] as string);
		const trailing = /(?:^|,)\s*(\d[\d_]*)\s*,?\s*$/.exec(args);
		if (trailing) hit(open + 1 + trailing.index, "wait guard argument", trailing[1] as string);
	}
	return hits;
}

test("no test timeout, t.timeout or waiting-helper guard is under 5000 ms", () => {
	const self = relative(REPO_ROOT, import.meta.filename);
	const hits = readdirSync(join(REPO_ROOT, "tests"), { recursive: true, encoding: "utf8" })
		.filter((name) => /\.(ts|mjs)$/.test(name))
		.map((name) => join("tests", name))
		.filter((rel) => rel !== self)
		.flatMap((rel) => shortTimeouts(rel, readFileSync(join(REPO_ROOT, rel), "utf8")));
	assert.deepEqual(hits, [], `wait on the event instead of a short clock:\n${hits.join("\n")}`);
});

test("the scan is not vacuous: each shape is caught, with its file and line", () => {
	const sample = [
		`test("a", { timeout: 1_000 }, () => {});`,
		"t.timeout(200);",
		"\tif (Date.now() - start > 4_999) throw new Error();",
		"const deadline = Date.now() + 100;",
		"const WAIT_TIMEOUT_MS = 300;",
		"await waitFor(() => 1, (v) => v === 1, { timeoutMs: 60 });",
		"await rpc.waitFor((r) => r.type === \"x\", 2_000);",
		"await worker.waitForSettled(10);",
		"async function until(pred: () => boolean, ms = 1_000) {}",
		"function poll(read: () => T, timeoutMs: number = 250) {}",
		`function fine(timeoutMs = 30_000) {}`,
		"const wait = async ({ timeoutMs = 400 } = {}) => {};",
		`test("ok", { timeout: 5_000 }, () => {}); await waitFor(read, ok, { timeoutMs: 60_000 }); ghCiConfigured({ timeoutMs: 1 });`,
	].join("\n");
	assert.deepEqual(
		shortTimeouts("x.test.ts", sample).map((line) => line.replace(/ is under.*/, "")),
		[
			"x.test.ts:1: timeout option of 1000 ms",
			"x.test.ts:2: t.timeout of 200 ms",
			"x.test.ts:3: Date.now() deadline of 4999 ms",
			"x.test.ts:4: Date.now() deadline of 100 ms",
			"x.test.ts:5: timeout constant of 300 ms",
			"x.test.ts:9: default parameter of 1000 ms",
			"x.test.ts:10: default parameter of 250 ms",
			"x.test.ts:12: default parameter of 400 ms",
			"x.test.ts:6: wait guard timeoutMs of 60 ms",
			"x.test.ts:7: wait guard argument of 2000 ms",
			"x.test.ts:8: wait guard argument of 10 ms",
		],
	);
});
