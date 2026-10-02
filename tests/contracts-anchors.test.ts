/**
 * cur.6.4: a markdown anchor checker, so the 27-broken-anchors regression
 * (docs/contracts.md's own table of contents drifting from its headings as
 * sections were renamed or moved) cannot recur silently. GitHub's heading
 * slugger is reimplemented here (lowercase, strip anything that is not a
 * word char/space/hyphen, spaces to hyphens, de-duplicate with -1, -2, ...)
 * and every `(#anchor)` link found in a tracked markdown file is checked
 * against the slugs of every heading in the file it points at.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MARKDOWN_FILES = ["docs/contracts.md", "docs/storage.md", "docs/build-history.md", "docs/parity.md", "AGENTS.md", "README.md", "PLAN.md"];

function slugify(heading: string): string {
	// GitHub's slugger does not collapse consecutive spaces before hyphenating,
	// so "RPC / X" (two spaces once the slash is stripped) becomes "rpc--x".
	return heading
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/ /g, "-");
}

function headingSlugs(text: string): Set<string> {
	const seen = new Map<string, number>();
	const slugs = new Set<string>();
	for (const line of text.split("\n")) {
		const match = /^#{1,6}\s+(.*)$/.exec(line);
		if (!match) continue;
		const base = slugify(match[1] as string);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		slugs.add(count === 0 ? base : `${base}-${count}`);
	}
	return slugs;
}

test("every #anchor link in a tracked markdown file resolves to a real heading", () => {
	const slugsByFile = new Map<string, Set<string>>();
	for (const relPath of MARKDOWN_FILES) {
		slugsByFile.set(relPath, headingSlugs(readFileSync(join(REPO_ROOT, relPath), "utf8")));
	}

	const broken: string[] = [];
	for (const relPath of MARKDOWN_FILES) {
		const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
		for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = match[1] as string;
			if (!target.includes("#")) continue;
			const [targetPathRaw, anchor] = target.split("#") as [string, string];
			if (!anchor) continue;
			if (/^https?:/.test(targetPathRaw)) continue;
			const targetPath = targetPathRaw === "" ? relPath : join(dirname(relPath), targetPathRaw);
			const slugs = slugsByFile.get(targetPath) ?? headingSlugs(readFileSync(join(REPO_ROOT, targetPath), "utf8"));
			slugsByFile.set(targetPath, slugs);
			if (!slugs.has(anchor)) {
				broken.push(`${relPath} links to ${target}, but ${targetPath} has no heading slug #${anchor}`);
			}
		}
	}
	assert.deepEqual(broken, []);
});

test("docs/contracts.md's table of contents covers every top-level heading it lists, without duplicates", () => {
	const text = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
	const toc = text.slice(text.indexOf("## Table of contents"), text.indexOf("## Directory layout"));
	const entries = [...toc.matchAll(/\(#([\w-]+)\)/g)].map((m) => m[1] as string);
	assert.equal(new Set(entries).size, entries.length, "the table of contents links to the same anchor twice");
});
