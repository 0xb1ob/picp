/**
 * Retained from tests/layout-flat.test.ts by P16 (docs/testing-migration/p16-slice.md): `configureLayout` is
 * process-global, so this is the one process that sees it, and no entry point can reconfigure a running parent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureLayout, currentRuntimeDir, LAYOUT, paths } from "../src/contracts.ts";
import { MEMORY_FILES } from "../src/memory.ts";

const root = mkdtempSync(join(tmpdir(), "cp-flat-"));
const home = join(root, ".pi-command-post");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("configureLayout(multi, flat home) puts every path directly under the home; nothing else may reconfigure it", () => {
	configureLayout("multi", home);
	assert.equal(currentRuntimeDir(), "");
	assert.equal(LAYOUT.runtimeDir, "");
	assert.equal(LAYOUT.state, "state");
	assert.equal(LAYOUT.data, "data");
	assert.equal(LAYOUT.projects, "projects");
	assert.equal(LAYOUT.jobsFile, "jobs.json");
	assert.equal(LAYOUT.operatorWorkspace, "operator");
	assert.equal(LAYOUT.fleetFile, "state/fleet.json");
	assert.equal(paths.runDir("cp-a1b2"), "state/runs/cp-a1b2");
	assert.equal(paths.projectDir("demo"), "projects/demo");
	assert.ok(Object.isFrozen(LAYOUT));
	configureLayout("multi", `${home}/`); // idempotent: same mode, same runtime root
	assert.throws(() => configureLayout("multi"), /runtime root ""; cannot switch to ".pi-command-post"/);
	assert.throws(() => configureLayout("multi", root), /runtime root/);
	// MEMORY_FILES was imported before configureLayout ran: its getters must follow the configured (flat) layout,
	// never the default nested one captured at import time.
	assert.ok(MEMORY_FILES.length > 0);
	for (const file of MEMORY_FILES) {
		assert.ok(file.path.startsWith("data/"), `${file.key}: ${file.path} is not under the flat data/`);
	}
	assert.equal(MEMORY_FILES.find((file) => file.key === "learnings")?.path, LAYOUT.learningsFile);
});
