import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { referencedMaterial } from "../src/task-references.ts";

function setup(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "task-refs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home"), worktree = join(root, "worktree");
	for (const path of [home, worktree, join(home, LAYOUT.state)]) mkdirSync(path, { recursive: true });
	return { home, worktree, root };
}

test("external files are inlined; worktree and state paths including symlinks are excluded", async (t) => {
	const options = setup(t);
	const outside = join(options.root, "requirements with spaces.md");
	const local = join(options.worktree, "local.md"), state = join(options.home, ".pi-command-post/state", "secret.md");
	// Legacy-layout negative fixture: a top-level state/ is not the home's state any more (cp-u3i2).
	const legacy = join(options.home, "state", "legacy.md");
	mkdirSync(join(options.home, "state"), { recursive: true });
	writeFileSync(outside, "External requirements\nverbatim.");
	writeFileSync(local, "LOCAL"); writeFileSync(state, "STATE"); writeFileSync(legacy, "LEGACY");
	const alias = join(options.root, "alias.md"); symlinkSync(state, alias);
	const material = await referencedMaterial({ ...options, task: `Read \`${outside}\`, ${local} and ${state} and ${alias} and ${legacy}.` });
	assert.match(material, /External requirements\nverbatim\./);
	assert.ok(!material.includes("LOCAL") && !material.includes("STATE"));
	assert.ok(material.includes("LEGACY"), "a top-level state/ file is an ordinary external reference");
	assert.match(await referencedMaterial({ ...options, task: `${options.root}/missing.md` }), /missing.md:.*ENOENT/);
});

test("reference count and UTF-8 bytes are bounded with explicit truncation", async (t) => {
	const options = setup(t);
	const files = Array.from({ length: 12 }, (_, i) => join(options.root, `ref-${i}.md`));
	for (const file of files) writeFileSync(file, "é".repeat(5000));
	const material = await referencedMaterial({ ...options, task: files.join(" ") });
	assert.ok(Buffer.byteLength(material) <= 24 * 1024);
	assert.match(material, /truncated/);
	assert.ok(!material.includes("\uFFFD"));
	for (const file of files) writeFileSync(file, "short");
	const short = await referencedMaterial({ ...options, task: files.join(" ") });
	assert.equal(short.match(/### .*ref-\d+\.md/g)?.length, 10);
	assert.match(short, /2 references omitted; 10 reference cap/);
});

test("credential-shaped referenced content becomes a diagnostic, not a dispatch refusal", async (t) => {
	const options = setup(t);
	const path = join(options.root, "credentials.md");
	writeFileSync(path, "OPENAI_API_KEY=sk-" + "a".repeat(48));
	const material = await referencedMaterial({ ...options, task: path });
	assert.match(material, /appears to contain/);
	assert.ok(!material.includes("a".repeat(48)));
});

test("no references leaves the task unchanged", async (t) => {
	assert.equal(await referencedMaterial({ ...setup(t), task: "Bump x in src/app.ts, see tracker-abc." }), "");
});
