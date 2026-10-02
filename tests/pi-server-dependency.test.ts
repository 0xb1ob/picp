import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

const PI = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

test("pi's public entry point no longer imports pi-server", async (t) => {
	const mainPath = join(PI, "dist", "main.js");
	if (!existsSync(mainPath)) {
		t.skip("no resolvable pi-coding-agent install in this environment");
		return;
	}

	assert.doesNotMatch(readFileSync(mainPath, "utf8"), /experimental\/server\.js/);
	const pi = await import("@earendil-works/pi-coding-agent");
	assert.equal(typeof pi.withFileMutationQueue, "function");
});
