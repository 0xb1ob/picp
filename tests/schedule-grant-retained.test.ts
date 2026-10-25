/** Retained structural scan (docs/testing-migration/p13a.md): no fire mints a grant (docs/contracts.md). */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

test("PR4: no fire mints a grant — only the mandate store writes schedule_fire, and #fireOnce never issues one", () => {
	const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
	const writers = [...files(join(REPO_ROOT, "src")), ...files(join(REPO_ROOT, "extensions"))]
		.filter((file) => /\.ts$/.test(file) && /\bschedule_fire\s*:/.test(readFileSync(file, "utf8")))
		.map((file) => file.slice(REPO_ROOT.length + 1));
	assert.deepEqual(writers.sort(), ["src/contracts/mandates.ts", "src/mandate.ts"]);
	const source = readFileSync(join(REPO_ROOT, "src/scheduler.ts"), "utf8");
	const start = source.indexOf("async #fireOnce(");
	assert.ok(start > 0);
	assert.doesNotMatch(source.slice(start, source.indexOf("\n\t}\n", start)), /\.issue\(|#mint|grant_template/);
	assert.doesNotMatch(source, /async #mint\(|async move\(/, "the mint and move paths are gone");
});
