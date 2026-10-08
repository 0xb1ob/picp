/**
 * cp-7bsr PR2: json-store's write options. `mode` states the file's bits regardless of umask (so a
 * 0600 owner file stays 0600 across a rewrite), `syncDir` flushes the directory after the rename,
 * `durableAppend({mode})` creates owner-only and still only appends; no option keeps the old behaviour.
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteJson, atomicWriteText, durableAppend } from "../src/json-store.ts";
import { createScratchHome } from "./harness/index.ts";

const modeOf = (file: string) => statSync(file).mode & 0o777;

function withUmask<T>(mask: number, fn: () => T): T {
	const previous = process.umask(mask);
	try {
		return fn();
	} finally {
		process.umask(previous);
	}
}

test("atomicWriteText: mode keeps an existing 0600 file at 0600 and creates with the mode despite umask", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const kept = join(home.path, "kept.json");
	writeFileSync(kept, "{}\n");
	chmodSync(kept, 0o600);
	atomicWriteText(kept, '{"a":1}\n', { mode: 0o600, syncDir: true });
	assert.equal(readFileSync(kept, "utf8"), '{"a":1}\n');
	assert.equal(modeOf(kept), 0o600);
	const created = join(home.path, "nested", "created.json");
	withUmask(0o077, () => atomicWriteJson(created, { b: 2 }, { mode: 0o640 }));
	assert.equal(modeOf(created), 0o640, "fchmod states the mode the umask would have masked");
	assert.deepEqual(JSON.parse(readFileSync(created, "utf8")), { b: 2 });
});

test("atomicWriteText: no options keep the default create mode (umask applies)", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, "plain.json");
	withUmask(0o022, () => atomicWriteJson(file, { c: 3 }));
	assert.equal(modeOf(file), 0o644);
});

test("durableAppend: {mode: 0o600} creates owner-only and appends without truncating", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, "audit.jsonl");
	withUmask(0o022, () => {
		durableAppend(file, "one\n", { mode: 0o600 });
		durableAppend(file, "two\n", { mode: 0o600 });
	});
	assert.equal(modeOf(file), 0o600);
	assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
	const plain = join(home.path, "plain.jsonl");
	withUmask(0o022, () => durableAppend(plain, "x\n"));
	assert.equal(modeOf(plain), 0o644);
});
