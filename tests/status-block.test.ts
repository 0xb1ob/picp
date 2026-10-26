/**
 * Retained (P18): a static boundary over src/, which no e2e surface can reach. The block's rendering is covered by
 * tests/e2e/status-block-p18.test.ts through a real parent calling cp_status_block.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { REPO_ROOT } from "./harness/index.ts";

// Opt-in regression: nothing in src/ depends on a block being rendered per
// turn. This is a static boundary check, not prose — a future module that
// wires a gate through the renderer (or that calls the tool by name) fails
// here, which is what would silently reintroduce a per-turn dependency.
test("no core src/ module depends on the status block being rendered", () => {
	const files = readdirSync(join(REPO_ROOT, "src")).filter((name) => name.endsWith(".ts"));
	const renderers = new Set(["status-block.ts", "awaiting-rows.ts", "shipped-seen.ts"]);
	for (const name of files) {
		const source = readFileSync(join(REPO_ROOT, "src", name), "utf8");
		if (!renderers.has(name)) {
			assert.doesNotMatch(source, /from "\.\/status-block\.ts"/, `${name} imports the renderer; a gate must not depend on rendering`);
		}
		// The tool name may be described in a comment; a runtime reference to it
		// would mean src/ expects the parent to have called it.
		for (const [index, line] of source.split("\n").entries()) {
			if (!line.includes("cp_status_block")) continue;
			const trimmed = line.trim();
			assert.ok(
				trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"),
				`src/${name}:${index + 1} references cp_status_block outside a comment`,
			);
		}
	}
	// And the gates themselves are callable with no block in sight: reviewDeferred
	// is exported from the store, not reached through the renderer.
	assert.equal(typeof AwaitingStore.prototype.reviewDeferred, "function");
});
