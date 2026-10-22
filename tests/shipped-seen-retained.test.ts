import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

// cp_status_block exposes the result, not whether the implementation imports a truncating write primitive.
test("the Shipped memory is written the way cp-nqj established: tmp -> fsync -> rename, never a truncating call", () => {
	const source = readFileSync(join(REPO_ROOT, "src/shipped-seen.ts"), "utf8");
	const imported = /import\s*\{([^}]*)\}\s*from\s*"node:fs"/.exec(source)?.[1] ?? "";
	assert.ok(
		!/\bwriteFileSync\b/.test(imported),
		"src/shipped-seen.ts must not import writeFileSync: it opens O_TRUNC (cp-nqj)",
	);
	assert.match(source, /atomicWriteJson/, "the whole-file write goes through the tmp -> fsync -> rename path");
});
