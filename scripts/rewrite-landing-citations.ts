/**
 * One-off ledger rewrite after tests/e2e/landing.test.ts was split: `node scripts/rewrite-landing-citations.ts <old-ref>`
 * repoints each citation (row title, `--test-name-pattern`, `landing.test.ts:N`) at the file now holding that test.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isHistoryRow } from "./landing-history-rows.ts";
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

// Exact doc placeholders that name no test; anything else matching a pattern is looked up by title.
const TEMPLATES = new Set(["<pattern>", "<selector>", "<title prefix>", "<scenario prefix>", "<scenario title substring>"]);
// Stale line numbers cannot be mapped by position (the docs cite several historical file versions): map by title.
const LINE_HINTS: Record<string, string> = {
	"landing.test.ts:2991": "S21b: verdict delivery precedes the merge-window notice",
	"landing.test.ts:314": "landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job",
};
const FILE_TOKEN = "tests\\/e2e\\/landing[\\w*-]*\\.test\\.ts";

function rewrite(line: string): string {
	let out = line.replace(/(?<![\w/.-])landing\.test\.ts(?!:\d)/g, OLD);
	out = out.replace(/`tests\/e2e\/landing\.test\.ts` \| ([^|]+?) \|/g, (whole, title: string) => {
		const found = after.get(title);
		return found ? `\`${found.file}\` | ${title} |` : whole;
	});
	out = out.replace(/(--test-name-pattern=(?:'([^']*)'|"([^"]*)"|(<[^>]+>)))([^\n]*?)tests\/e2e\/landing\.test\.ts/g, (whole, head: string, a?: string, b?: string, c?: string, mid = "") => {
		const pattern = a ?? b ?? c ?? "";
		if (TEMPLATES.has(pattern)) return `${head}${mid}tests/e2e/landing-*.test.ts`;
		const needle = pattern.split("<")[0] ?? "";
		const files = [...new Set([...after.values()].filter((d) => needle && d.title.includes(needle)).map((d) => d.file))];
		if (files.length === 0) {
			unresolved.push(`pattern '${pattern}'`);
			return whole;
		}
		return `${head}${mid}${files.join(" ")}`;
	});
	// A prose citation that quotes a moved test's exact title in the same line follows that title.
	if (out.includes("tests/e2e/landing.test.ts")) {
		const files = new Set([...after.values()].filter((d) => out.includes(d.title)).map((d) => d.file));
		if (files.size === 1) out = out.replaceAll("tests/e2e/landing.test.ts", [...files][0]!);
	}
	out = out.replace(/landing\.test\.ts:(\d+)/g, (whole) => {
		const hint = LINE_HINTS[whole];
		const hinted = hint && after.get(hint);
		if (hinted) return `${hinted.file.replace(/^tests\/e2e\//, "")}:${hinted.line}`;
		const n = Number(whole.split(":")[1]);
		const start = [...before].reverse().find((d) => d.line <= n);
		const moved = start && after.get(start.title);
		if (!moved) {
			unresolved.push(`line ${n}`);
			return whole;
		}
		return `${moved.file.replace(/^tests\/e2e\//, "")}:${moved.line + n - start.line}`;
	});
	out = out.replaceAll("tests/e2e/landing.test.ts", "tests/e2e/landing-*.test.ts");
	// A run of the same file twice (the old name replaced beside a file already listed) collapses to one.
	return out.replace(new RegExp(`(${FILE_TOKEN})((?: ${FILE_TOKEN})+)`, "g"), (_whole, first: string, rest: string) =>
		[...new Set([first, ...rest.trim().split(" ")])].join(" "));
}

const docs = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const doc of docs) {
	const text = readFileSync(doc, "utf8");
	const next = text.split("\n").map((line) => (line.includes("landing.test.ts") && !isHistoryRow(line) ? rewrite(line) : line)).join("\n");
	if (next !== text) writeFileSync(doc, next);
}
if (unresolved.length) process.exitCode = 1;
console.log(unresolved.length ? `unresolved (left pointing at the old file): ${unresolved.join("; ")}` : "all citations resolved");
