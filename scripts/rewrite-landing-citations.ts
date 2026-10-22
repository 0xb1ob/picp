/**
 * One-off ledger rewrite after tests/e2e/landing.test.ts was split: `node scripts/rewrite-landing-citations.ts`
 * repoints each citation (row title, `--test-name-pattern`, prose, `landing.test.ts:N`) at the file now holding it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isHistoryRow } from "./landing-history-rows.ts";
import ts from "typescript";

const OLD = "tests/e2e/landing.test.ts";
const GLOB = "tests/e2e/landing-*.test.ts";
const f = (name: string): string => `tests/e2e/landing-${name}.test.ts`;
const NEW_FILES = ["s03", "ci-watch", "s09", "forge-ci", "merge", "review-window"].map(f);

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

const after = new Map(NEW_FILES.flatMap((file) => declarations(file, readFileSync(file, "utf8"))).map((d) => [d.title, d]));
const unresolved: string[] = [];

// Exact doc placeholders that name no test; only these keep the glob.
const TEMPLATES = new Set(["<pattern>", "<prefix>", "<selector>", "<title prefix>", "<scenario prefix>", "<scenario title substring>", "<exact scenario name>"]);
// Line numbers cite several historical file versions, so only these are mapped (by title); other `landing.test.ts:N` stay unresolved.
const LINE_HINTS: Record<string, string> = {
	"landing.test.ts:2991": "S21b: verdict delivery precedes the merge-window notice",
	"landing-ci-watch.test.ts:776": "S21b: verdict delivery precedes the merge-window notice",
	"landing.test.ts:314": "landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job",
	"landing-forge-ci.test.ts:22": "landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job",
};
// Prose cites with no title: the owning file(s) by line content, then by doc (first match wins).
const OWNERS: { doc?: RegExp; line?: RegExp; files: string[] }[] = [
	{ line: /startStack/, files: ["tests/e2e/landing-helpers.ts"] },
	{ line: /S15/, files: [f("review-window")] },
	{ doc: /testing-migration-main-ci-declarations/, files: [f("ci-watch"), f("forge-ci")] },
	{ doc: /testing-migration-p3c-declarations/, files: [f("ci-watch")] },
	{ doc: /testing-migration-s03/, files: [f("s03")] },
	{ doc: /testing-migration-s09/, files: [f("s09")] },
	{ doc: /testing-migration-s10\.md|testing-migration\/s10b\.md/, files: [f("merge")] },
];

function rewrite(doc: string, line: string): string {
	let out = line.replace(/(?<![\w/.-])landing\.test\.ts(?!:\d)/g, OLD);
	// A glob left by an earlier run is a real cite unless it follows a template `--test-name-pattern`.
	out = out.replace(/tests\/e2e\/landing-\*\.test\.ts/g, (glob, at: number) => {
		const head = out.slice(0, at);
		const last = [...head.matchAll(/--test-name-pattern=(?:'([^']*)'|"([^"]*)"|(<[^>]+>))/g)].pop();
		const template = last && TEMPLATES.has(last[1] ?? last[2] ?? last[3] ?? "") && !head.slice(last.index).includes("`");
		return template ? glob : OLD;
	});
	out = out.replace(/`tests\/e2e\/landing\.test\.ts` \| ([^|]+?) \|/g, (whole, title: string) => {
		const found = after.get(title);
		return found ? `\`${found.file}\` | ${title} |` : whole;
	});
	out = out.replace(/(--test-name-pattern=(?:'([^']*)'|"([^"]*)"|(<[^>]+>)))([^\n]*?)tests\/e2e\/landing\.test\.ts/g, (whole, head: string, a?: string, b?: string, c?: string, mid = "") => {
		const pattern = a ?? b ?? c ?? "";
		if (TEMPLATES.has(pattern)) return `${head}${mid}${GLOB}`;
		const needle = pattern.split("<")[0] ?? "";
		const files = [...new Set([...after.values()].filter((d) => needle && d.title.includes(needle)).map((d) => d.file))];
		if (files.length === 0) {
			unresolved.push(`${doc}: pattern '${pattern}'`);
			return whole;
		}
		return `${head}${mid}${files.join(" ")}`;
	});
	// A prose citation that quotes a moved test's exact title in the same line follows that title.
	if (out.includes(OLD)) {
		const files = new Set([...after.values()].filter((d) => out.includes(d.title)).map((d) => d.file));
		if (files.size === 1) out = out.replaceAll(OLD, [...files][0]!);
	}
	out = out.replace(/landing[\w-]*\.test\.ts:\d+/g, (whole) => {
		const hinted = after.get(LINE_HINTS[whole] ?? "");
		if (hinted) return `${hinted.file.replace(/^tests\/e2e\//, "")}:${hinted.line}`;
		if (whole.startsWith("landing.test.ts")) unresolved.push(`${doc}: ${whole}`);
		return whole;
	});
	if (out.includes(OLD)) {
		const owner = OWNERS.find((o) => (!o.doc || o.doc.test(doc)) && (!o.line || o.line.test(out)));
		if (owner) out = out.replaceAll(OLD, owner.files.join(" "));
		else unresolved.push(`${doc}: ${line.slice(0, 80)}`);
	}
	// The old name replaced beside a file already listed leaves the same file twice.
	const token = "tests\\/e2e\\/landing[\\w-]*\\.test\\.ts";
	return out.replace(new RegExp(`(${token})((?: ${token})+)`, "g"), (_whole, first: string, rest: string) =>
		[...new Set([first, ...rest.trim().split(" ")])].join(" "));
}

const docs = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const doc of docs) {
	const text = readFileSync(doc, "utf8");
	const next = text.split("\n").map((line) => (/landing[\w*-]*\.test\.ts/.test(line) && !isHistoryRow(line) ? rewrite(doc, line) : line)).join("\n");
	if (next !== text) writeFileSync(doc, next);
}
if (unresolved.length) process.exitCode = 1;
console.log(unresolved.length ? `unresolved (left pointing at the old file): ${unresolved.join("; ")}` : "all citations resolved");
