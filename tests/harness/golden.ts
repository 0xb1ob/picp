/**
 * Golden files: `tests/golden/<name>`.
 *
 * A golden test asserts that rendered output is *exactly* what a human once
 * reviewed. That is only useful if updating one is deliberate, so there is no
 * "write it if it differs" mode: `CP_UPDATE_GOLDEN=1` rewrites the file and
 * **fails the test anyway**, so a regenerated golden always shows up in a diff
 * and never in a green run.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GOLDEN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "golden");

export const UPDATE_GOLDEN = process.env.CP_UPDATE_GOLDEN === "1";

export function goldenPath(name: string): string {
	return join(GOLDEN_DIR, name);
}

/** Compare `actual` (trailing newline normalized) with `tests/golden/<name>`. */
export function assertGolden(name: string, actual: string): void {
	const file = goldenPath(name);
	const content = actual.endsWith("\n") ? actual : `${actual}\n`;
	if (UPDATE_GOLDEN) {
		mkdirSync(GOLDEN_DIR, { recursive: true });
		writeFileSync(file, content);
		assert.fail(`golden ${name} rewritten (CP_UPDATE_GOLDEN=1); review the diff and rerun without it`);
	}
	if (!existsSync(file)) {
		assert.fail(`missing golden ${file} — create it with CP_UPDATE_GOLDEN=1 and review the diff`);
	}
	assert.equal(content, readFileSync(file, "utf8"), `output does not match golden ${name}`);
}
