/**
 * Folds `changelog.d/*.md` fragments into the top of CHANGELOG.md's `## Unreleased` section, in filename order,
 * then deletes them. Run by hand (`npm run changelog:fold [root]`); it never commits.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADING = "## Unreleased\n";

/** Folds the fragments under `root`; returns how many were folded. Throws, touching nothing, when it cannot. */
export function fold(root: string): number {
	const dir = join(root, "changelog.d");
	const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")).sort() : [];
	if (names.length === 0) return 0;
	const bullets = names.map((name) => {
		const text = readFileSync(join(dir, name), "utf8").trim();
		if (!text.startsWith("- ")) throw new Error(`changelog.d/${name}: a fragment is one bullet starting with "- "`);
		return text;
	});
	const file = join(root, "CHANGELOG.md");
	const log = readFileSync(file, "utf8");
	const at = log.indexOf(HEADING);
	if (at < 0) throw new Error("CHANGELOG.md has no `## Unreleased` section");
	const head = at + HEADING.length;
	writeFileSync(file, `${log.slice(0, head)}\n${bullets.join("\n\n")}\n${log.slice(head)}`);
	for (const name of names) rmSync(join(dir, name));
	return names.length;
}

if (import.meta.main) {
	try {
		const count = fold(process.argv[2] ?? process.cwd());
		console.log(count === 0 ? "changelog.d: nothing to fold" : `changelog.d: folded ${count} fragment(s) into CHANGELOG.md`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
