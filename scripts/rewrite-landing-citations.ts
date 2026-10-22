/**
 * One-off ledger rewrite after tests/e2e/landing.test.ts was split: `node scripts/rewrite-landing-citations.ts <old-ref>`
 * repoints each citation (row title, `--test-name-pattern`, `landing.test.ts:N`) at the file now holding that test.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const OLD = "tests/e2e/landing.test.ts";
const NEW_FILES = [
	"tests/e2e/landing-s03.test.ts",
	"tests/e2e/landing-ci-watch.test.ts",
	"tests/e2e/landing-s09.test.ts",
	"tests/e2e/landing-forge-ci.test.ts",
	"tests/e2e/landing-merge.test.ts",
	"tests/e2e/landing-review-window.test.ts",
];

interface Decl { title: string; line: number; file: string }

function declarations(file: string, source: string): Decl[] {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out: Decl[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
			const title = node.arguments[0];
			if (title && ts.isStringLiteral(title)) out.push({ title: title.text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, file });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

const ref = process.argv[2];
if (!ref) throw new Error("usage: rewrite-landing-citations.ts <ref holding the unsplit landing.test.ts>");
const before = declarations(OLD, execFileSync("git", ["show", `${ref}:${OLD}`], { encoding: "utf8", maxBuffer: 1 << 28 }));
const after = new Map(NEW_FILES.flatMap((file) => declarations(file, readFileSync(file, "utf8"))).map((d) => [d.title, d]));
const unresolved: string[] = [];

function rewrite(line: string): string {
	let out = line.replace(/`tests\/e2e\/landing\.test\.ts` \| ([^|]+?) \|/g, (whole, title: string) => {
		const found = after.get(title);
		return found ? `\`${found.file}\` | ${title} |` : whole;
	});
	out = out.replace(/--test-name-pattern='([^']*)'([^\n]*?)tests\/e2e\/landing\.test\.ts/g, (whole, pattern: string, mid: string) => {
		// The doc template `--test-name-pattern='<pattern>' tests/e2e/landing.test.ts` names no test: point it at every landing file.
		if (/^<[^>]+>$/.test(pattern)) return `--test-name-pattern='${pattern}'${mid}tests/e2e/landing-*.test.ts`;
		const needle = pattern.split("<")[0] ?? "";
		const files = [...new Set([...after.values()].filter((d) => needle && d.title.includes(needle)).map((d) => d.file))];
		if (files.length === 0) {
			unresolved.push(`pattern '${pattern}'`);
			return whole;
		}
		return `--test-name-pattern='${pattern}'${mid}${files.join(" ")}`;
	});
	// A prose citation that quotes a moved test's exact title in the same line follows that title.
	if (out.includes("tests/e2e/landing.test.ts")) {
		const files = new Set([...after.values()].filter((d) => out.includes(d.title)).map((d) => d.file));
		if (files.size === 1) out = out.replaceAll("tests/e2e/landing.test.ts", [...files][0]!);
	}
	out = out.replace(/landing\.test\.ts:(\d+)/g, (whole, n: string) => {
		const start = [...before].reverse().find((d) => d.line <= Number(n));
		const moved = start && after.get(start.title);
		if (!moved) {
			unresolved.push(`line ${n}`);
			return whole;
		}
		return `${moved.file.replace(/^tests\/e2e\//, "")}:${moved.line + Number(n) - start.line}`;
	});
	return out;
}

const docs = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const doc of docs) {
	const text = readFileSync(doc, "utf8");
	// docs/testing-migration* is history (PR target rows name the file as it was); every other doc must name a live file.
	const live = !doc.startsWith("docs/testing-migration");
	const next = text.split("\n").map((line) => {
		const done = line.includes("landing.test.ts") ? rewrite(line) : line;
		return live ? done.replaceAll("tests/e2e/landing.test.ts", "tests/e2e/landing-*.test.ts") : done;
	}).join("\n");
	if (next !== text) writeFileSync(doc, next);
}
if (unresolved.length) process.exitCode = 1;
console.log(unresolved.length ? `unresolved (left pointing at the old file): ${unresolved.join("; ")}` : "all citations resolved");
