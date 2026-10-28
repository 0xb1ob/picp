import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "changelog-fold.ts");
const LOG = "# Changelog\n\n## Unreleased\n\n- old\n\n## 1.0.0\n\n- first\n";
const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function repo(fragments: Record<string, string> | null, log = LOG): string {
	const root = mkdtempSync(join(tmpdir(), "cp-changelog-fold-"));
	roots.push(root);
	writeFileSync(join(root, "CHANGELOG.md"), log);
	if (fragments) {
		mkdirSync(join(root, "changelog.d"));
		for (const [name, text] of Object.entries(fragments)) writeFileSync(join(root, "changelog.d", name), text);
	}
	return root;
}
const run = (root: string) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });

test("fragments fold into Unreleased in filename order above the older bullets, then are deleted", () => {
	const root = repo({ "b-second.md": "- second\n", "a-first.md": "- first\n", "notes.txt": "ignored" });
	const out = run(root);
	assert.equal(out.status, 0, out.stderr);
	assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), "# Changelog\n\n## Unreleased\n\n- first\n\n- second\n\n- old\n\n## 1.0.0\n\n- first\n");
	assert.equal(existsSync(join(root, "changelog.d", "a-first.md")), false);
	assert.equal(existsSync(join(root, "changelog.d", "b-second.md")), false);
	assert.equal(existsSync(join(root, "changelog.d", "notes.txt")), true);
});

test("an empty or missing changelog.d leaves CHANGELOG.md untouched", () => {
	for (const root of [repo({}), repo(null)]) {
		const out = run(root);
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /nothing to fold/);
		assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), LOG);
	}
});

test("a malformed fragment or a missing Unreleased heading fails and deletes nothing", () => {
	const bad = repo({ "a.md": "- fine\n", "b.md": "not a bullet\n" });
	assert.equal(run(bad).status, 1);
	assert.equal(existsSync(join(bad, "changelog.d", "a.md")), true);
	assert.equal(readFileSync(join(bad, "CHANGELOG.md"), "utf8"), LOG);
	const headless = repo({ "a.md": "- fine\n" }, "# Changelog\n");
	const out = run(headless);
	assert.equal(out.status, 1);
	assert.match(out.stderr, /no `## Unreleased` section/);
	assert.equal(existsSync(join(headless, "changelog.d", "a.md")), true);
});

test("`npm run changelog:fold` is wired to the script", () => {
	const pkg = JSON.parse(readFileSync(join(SCRIPT, "..", "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
	assert.equal(pkg.scripts["changelog:fold"], "node scripts/changelog-fold.ts");
});
