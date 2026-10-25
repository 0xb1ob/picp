/**
 * Board publication, retained: a site file or directory swapped to a symlink between validation and copy needs
 * publishBoard's test-only hook; no entry point interleaves a swap. The rest is tests/e2e/intake-p9f.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, LAYOUT, paths } from "../src/contracts.ts";
import { publishBoard } from "../src/board-delivery.ts";
import { createScratchHome } from "./harness/index.ts";

test("board publication refuses a site file swapped to an external symlink after validation", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const source = join(home.path, paths.artifactDir("cp-swap"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Safe", description: "", job_ids: [], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "safe");
	const outside = join(home.path, "secret.html");
	writeFileSync(outside, "private");
	assert.throws(() => Reflect.apply(publishBoard, null, [home.path, "cp-swap", join(source, "board.json"), () => {
		rmSync(join(source, "site/index.html"));
		symlinkSync(outside, join(source, "site/index.html"));
	}]), /resolves outside/);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "boards/cp-swap")), false);
});

test("board publication rejects a directory swapped to a symlink while staging", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const source = join(home.path, paths.artifactDir("cp-dir-swap"));
	mkdirSync(join(source, "site/assets"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Safe", description: "", job_ids: [], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "safe");
	writeFileSync(join(source, "site/assets/icon.svg"), "safe");
	const outside = join(home.path, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "icon.svg"), "private");
	assert.throws(() => publishBoard(home.path, "cp-dir-swap", join(source, "board.json"), () => {
		renameSync(join(source, "site/assets"), join(source, "site/old-assets"));
		symlinkSync(outside, join(source, "site/assets"));
	}), /resolves outside/);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "boards/cp-dir-swap")), false);
});
