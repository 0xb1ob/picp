import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type AllowEntry, check, lineHash, RETIRED_PATTERN, scan, trackedFindings } from "../scripts/check-retired-integration.ts";
import { REPO_ROOT } from "./harness/index.ts";

// The corpus reuses the real allowlisted protocol line, so this file never spells a forbidden word itself.
const PROTOCOL = "src/viewer/server.ts";
const line = readFileSync(join(REPO_ROOT, PROTOCOL), "utf8").split("\n").find((text) => RETIRED_PATTERN.test(text)) ?? "";
const token = RETIRED_PATTERN.exec(line)?.[0] ?? "";
const entry: AllowEntry = { path: PROTOCOL, sha256: lineHash(line), count: 1, category: "protocol", reason: "HTTP content-coding token" };
const paths = [PROTOCOL, "src/other.ts"];
const findings = (matches: Array<{ path: string; line: string }>, entries: AllowEntry[] = [entry], tracked = paths) =>
	check(tracked, matches, entries).join("\n");

test("retired integration guard: the tracked tree has no unapproved match and no stale allowance", () => {
	assert.ok(token, "the protocol line still carries the token the corpus is built from");
	assert.deepEqual(trackedFindings(REPO_ROOT).findings, []);
});

test("retired integration guard: an exact allowlisted line passes; additions, edits, copies and stale entries fail", () => {
	assert.equal(findings([{ path: PROTOCOL, line }]), "");
	assert.match(findings([{ path: PROTOCOL, line }, { path: "src/other.ts", line }]), /src\/other\.ts: unapproved match/);
	const appended = findings([{ path: PROTOCOL, line: `${line} // and more` }]);
	assert.match(appended, /unapproved match/);
	assert.match(appended, /stale allowlist entry/);
	assert.match(findings([{ path: PROTOCOL, line }, { path: PROTOCOL, line }]), /appears 2 time\(s\), allowlist says 1/);
	assert.match(findings([]), /stale allowlist entry/);
	assert.match(findings([{ path: PROTOCOL, line }], [entry, entry]), /duplicate allowlist entry/);
	assert.match(findings([{ path: PROTOCOL, line }], [{ ...entry, category: "frozen-history" }]), /cannot exempt this file/);
	assert.match(findings([{ path: PROTOCOL, line }], [{ ...entry, reason: " " }]), /has no reason/);
	assert.match(findings([], [entry], ["src/other.ts"]), /allowlisted file is not tracked/);
});

test("retired integration guard: file names, still-tracked deleted rows, binary files and read failures", () => {
	assert.match(findings([{ path: PROTOCOL, line }], [entry], [...paths, `docs/${token}.md`]), /forbidden file name/);
	const row = `| \`src/other.ts\` | deleted-with-feature | #1 | ${token} |`;
	const record: AllowEntry = { path: "docs/testing-migration.md", sha256: lineHash(row), count: 1, category: "deleted-feature-record", reason: "r" };
	const tracked = [...paths, record.path];
	assert.match(findings([{ path: PROTOCOL, line }, { path: record.path, line: row }], [entry, record], tracked), /names src\/other\.ts, which is still tracked/);
	const files: Record<string, Buffer> = { [PROTOCOL]: Buffer.from(`a\n${line}\r\nb\n`), "image.png": Buffer.from(`\0${line}`) };
	assert.deepEqual(scan(Object.keys(files), (path) => files[path] as Buffer), [{ path: PROTOCOL, line: `${line}\r` }]);
	assert.equal(lineHash(`${line}\r`), entry.sha256, "a CRLF line hashes like its LF form");
	assert.throws(() => scan(["missing"], () => { throw new Error("unreadable"); }), /unreadable/);
});
