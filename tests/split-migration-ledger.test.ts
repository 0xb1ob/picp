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

// Control for the prose check: a log line dropped from the after-union is reported, an intact move is not.
test("preservationFindings catches a dropped prose or log line", async () => {
	const { preservationFindings } = await import("../scripts/test-migration-check.ts");
	const before = ["Intro prose.\n\n```\n✖ failure log\n```\n"];
	assert.deepEqual(preservationFindings(before, ["# Ledger rows: b02\n\nIntro prose.\n\n```\n✖ failure log\n```\n"]), []);
	assert.deepEqual(preservationFindings(before, ["Intro prose.\n\n```\n```\n"]), ["preservation: prose lines has 4 before, 3 after", "preservation: prose lines content differs"]);
});

// An NC-nn intro paragraph and its failure log follow their patch into the slice file, whichever slice owns the patch.
test("split-migration-ledger moves an NC intro and log beside the owning slice's patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-split-"));
	try {
		const patch = "<!-- patch:NC-24-x -->\n```diff\n-a\n+b\n```\n";
		const prose = "## Assertion map\n\nNC-24 breaks it:\n\n```\n✖ log line\n```\n\nShared prose.\n";
		mkdirSync(join(dir, "docs/testing-migration"), { recursive: true });
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "docs/testing-migration.md"), `# Rules\n\n${prose}`);
		writeFileSync(join(dir, "docs/testing-migration/b05.md"), `# Ledger rows: b05\n\n${patch}`);
		writeFileSync(join(dir, "scripts/retired-integration-allowlist.json"), "[]\n");
		execFileSync("node", [resolve("scripts/split-migration-ledger.ts"), "b05"], { cwd: dir, stdio: "pipe" });
		assert.equal(readFileSync(join(dir, "docs/testing-migration.md"), "utf8"), "# Rules\n\n## Assertion map\n\nShared prose.\n");
		assert.equal(readFileSync(join(dir, "docs/testing-migration/b05.md"), "utf8"), `# Ledger rows: b05\n\nNC-24 breaks it:\n\n${patch}\n\`\`\`\n✖ log line\n\`\`\`\n`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
