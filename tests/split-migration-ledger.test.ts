import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// A kept row holding `$&`/`$'` must survive the split verbatim; a string-replacement bug would expand it.
test("split-migration-ledger moves only the named slice and leaves $-sequences in kept rows intact", () => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-split-"));
	try {
		const kept = "| S01-1 | `tests/e2e/a.test.ts` | keeps $& and $' and $$ literally |";
		const moved = "| S02-1 | `tests/e2e/b.test.ts` | moves |";
		const table = `<!-- manifest:scenarios -->\n| ID | E2E file | Test name |\n|---|---|---|\n${kept}\n${moved}\n<!-- /manifest:scenarios -->\n`;
		mkdirSync(join(dir, "docs"));
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "docs/testing-migration.md"), `# Rules\n\n\n\n${table}`);
		writeFileSync(join(dir, "scripts/retired-integration-allowlist.json"), "[]\n");
		execFileSync("node", [resolve("scripts/split-migration-ledger.ts"), "s02"], { cwd: dir, stdio: "pipe" });
		const monolith = readFileSync(join(dir, "docs/testing-migration.md"), "utf8");
		assert.ok(monolith.includes(`${kept}\n`));
		assert.ok(!monolith.includes(moved));
		assert.ok(monolith.startsWith("# Rules\n\n\n\n"));
		assert.ok(readFileSync(join(dir, "docs/testing-migration/s02.md"), "utf8").includes(`${moved}\n`));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
