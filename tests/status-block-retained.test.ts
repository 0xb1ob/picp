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

// A module that gates through the renderer, or calls the tool by name, would reintroduce a per-turn dependency.
test("no core src/ module depends on the status block being rendered", () => {
	const files = readdirSync(join(REPO_ROOT, "src")).filter((name) => name.endsWith(".ts"));
	const renderers = new Set(["status-block.ts", "awaiting-rows.ts", "shipped-seen.ts"]);
	for (const name of files) {
		const source = readFileSync(join(REPO_ROOT, "src", name), "utf8");
		if (!renderers.has(name)) {
			assert.doesNotMatch(source, /from "\.\/status-block\.ts"/, `${name} imports the renderer; a gate must not depend on rendering`);
		}
		// A runtime reference (not a comment) would mean src/ expects the parent to have called the tool.
		for (const [index, line] of source.split("\n").entries()) {
			if (!line.includes("cp_status_block")) continue;
			const trimmed = line.trim();
			assert.ok(
				trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"),
				`src/${name}:${index + 1} references cp_status_block outside a comment`,
			);
		}
	}
	// The gates are callable with no block in sight.
	assert.equal(typeof AwaitingStore.prototype.reviewDeferred, "function");
});
