// Retained from tests/scaffold.test.ts by P16 (docs/testing-migration/p16-slice.md): no entry point reaches these.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readPackageIdentity } from "../extensions/command-post/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import { scaffoldHome } from "../src/scaffold.ts";
import { createScratchHome } from "./harness/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("readPackageIdentity fails closed on a missing manifest", () => {
	assert.throws(() => readPackageIdentity(join(REPO_ROOT, "does-not-exist")), /cannot read/);
});

test("pi manifest declares the parent extension and not the worker extension", () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		pi: { extensions: string[]; skills: string[]; prompts: string[] };
		keywords: string[];
	};
	assert.deepEqual(manifest.pi.extensions, ["./extensions/command-post/index.ts"]);
	// Recursion guard starts here: the worker extension is never manifest-loaded.
	assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("worker-reporter")));
	assert.ok(manifest.keywords.includes("pi-package"));
});

test("package directory skeleton exists", () => {
	for (const dir of [
		"extensions/command-post",
		"extensions/worker-reporter",
		"skills",
		"prompts",
		"profiles",
		"src",
		"docs",
		"tests",
	]) {
		assert.ok(existsSync(join(REPO_ROOT, dir)), `missing ${dir}`);
	}
});

test("the ledger step can be turned off for a home that will never dispatch", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, ledger: false });
	assert.ok(!report.steps.some((step) => step.step === "ledger"));
	assert.ok(!existsSync(join(home.path, LAYOUT.jobsFile)));
});
