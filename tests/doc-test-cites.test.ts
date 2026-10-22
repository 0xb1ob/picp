import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isHistoryRow } from "../scripts/landing-history-rows.ts";

const ROOT = join(import.meta.dirname, "..");
// Historical records (one prefix each) may name tests that were since retired; live docs may not.
// docs/parity.md is policed in contract.test.ts. The deleted landing.test.ts is never allowed here, see below.
const STALE_ALLOWED: { prefix: string; reason: string }[] = [
	{ prefix: "docs/testing-migration", reason: "the ledger records retired unit files and e2e files as they were when each slice landed" },
	{ prefix: "docs/superpowers/", reason: "dated plans and specs written before later test renames and deletions" },
	{ prefix: "docs/tui-verification/", reason: "dated verification records" },
	{ prefix: "docs/build-history.md", reason: "task-by-task build record" },
	{ prefix: "CHANGELOG.md", reason: "release notes name tests as they were then" },
];
const SPLIT = "tests/e2e/landing.test.ts";

function exists(path: string): boolean {
	if (!path.includes("*")) return existsSync(join(ROOT, path));
	const re = new RegExp(`^${path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
	const dir = join(ROOT, dirname(path));
	return existsSync(dir) && readdirSync(dir).some((f) => re.test(`${dirname(path)}/${f}`));
}

test("no tracked doc cites a tests/ path that does not exist, and none cites the deleted landing.test.ts outside history rows", () => {
	const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((d) => d && d !== "docs/parity.md");
	const bad: string[] = [];
	for (const doc of docs) {
		const allowed = STALE_ALLOWED.some((a) => doc.startsWith(a.prefix));
		readFileSync(join(ROOT, doc), "utf8").split("\n").forEach((line, i) => {
			for (const [path] of line.matchAll(/tests\/[\w./*-]+\.ts/g)) {
				if (path.includes("**") || (path === SPLIT ? isHistoryRow(line) : allowed || exists(path))) continue;
				bad.push(`${doc}:${i + 1} ${path}`);
			}
		});
	}
	assert.deepEqual(bad, [], "stale test citation: repoint it, or allowlist a history row with a reason");
});
