import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const SCRIPT = resolve("scripts/rewrite-landing-citations.ts");

function runIn(citation: string): { status: number | null; out: string } {
	const dir = mkdtempSync(join(tmpdir(), "cp-rewrite-"));
	try {
		mkdirSync(join(dir, "tests/e2e"), { recursive: true });
		mkdirSync(join(dir, "docs/testing-migration"), { recursive: true });
		for (const f of ["landing", "landing-s03", "landing-ci-watch", "landing-s09"]) {
			writeFileSync(join(dir, `tests/e2e/${f}.test.ts`), f === "landing" ? 'test("a", () => {});\n' : "");
		}
		writeFileSync(join(dir, "docs/testing-migration.md"), `${citation}\n`);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: dir });
		const r = spawnSync("node", [SCRIPT, "HEAD"], { cwd: dir, encoding: "utf8" });
		return { status: r.status, out: r.stdout + r.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("rewrite-landing-citations exits non-zero on an unresolved citation and zero when all resolve", () => {
	const bad = runIn("see landing.test.ts:0");
	assert.notEqual(bad.status, 0);
	assert.match(bad.out, /unresolved/);
	const ok = runIn("`tests/e2e/landing.test.ts` | a |");
	assert.equal(ok.status, 0, ok.out);
});
