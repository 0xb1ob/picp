/**
 * One-off ledger rewrite after tests/e2e/landing.test.ts was split: `node scripts/rewrite-landing-citations.ts <old-ref>`
 * repoints each citation (row title, `--test-name-pattern`, `landing.test.ts:N`) at the file now holding that test.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const OLD = "tests/e2e/landing.test.ts";
const NEW_FILES = [OLD, "tests/e2e/landing-s03.test.ts", "tests/e2e/landing-ci.test.ts", "tests/e2e/landing-integrate.test.ts"];

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
		const needle = pattern.split("<")[0] ?? "";
		const files = [...new Set([...after.values()].filter((d) => needle && d.title.includes(needle)).map((d) => d.file))];
		if (files.length === 0) {
			unresolved.push(`pattern '${pattern}'`);
			return whole;
		}
		return `--test-name-pattern='${pattern}'${mid}${files.join(" ")}`;
	});
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

const docs = ["docs/testing-migration.md", ...readdirSync("docs/testing-migration").filter((f) => f.endsWith(".md")).map((f) => `docs/testing-migration/${f}`)];
for (const doc of docs) {
	const text = readFileSync(doc, "utf8");
	const next = text.split("\n").map((line) => (line.includes("landing.test.ts") ? rewrite(line) : line)).join("\n");
	if (next !== text) writeFileSync(doc, next);
}
console.log(unresolved.length ? `unresolved (left pointing at ${OLD}): ${unresolved.join("; ")}` : "all citations resolved");
