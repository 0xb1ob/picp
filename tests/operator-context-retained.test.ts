import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { operatorStartContext } from "../src/operator-context.ts";

function scratch(): string {
	return join(mkdtempSync(join(tmpdir(), "cp-opctx-")), ".pi-command-post");
}

test("an empty home has no start context and building it creates no file", () => {
	const home = scratch();
	try {
		assert.equal(operatorStartContext(home, "multi"), undefined);
		assert.equal(existsSync(home), false);
	} finally { rmSync(join(home, ".."), { recursive: true, force: true }); }
});
