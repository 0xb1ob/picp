/**
 * F2: src/contracts.ts is a re-export barrel over src/contracts/*.ts. This pins
 * the contract surface it exports — every name, whether it is a type or a
 * value, the source text of its declaration, and (for values) a hash of the
 * runtime value itself (typebox schemas, frozen tables, function shape) — so
 * a move between modules is provably behaviour-preserving, and any real
 * contract change shows up as a reviewed diff of
 * tests/golden/contracts-exports.txt (CP_UPDATE_GOLDEN=1 rewrites it).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import * as contracts from "../src/contracts.ts";
import { assertGolden } from "./harness/golden.ts";
import { REPO_ROOT } from "./harness/index.ts";

const BARREL = join(REPO_ROOT, "src/contracts.ts");

type Declared = { kind: "type" | "value" | "class"; text: string; file: string };

/** Every exported declaration reachable from the barrel, following `export *` only. */
function declaredExports(file: string, into = new Map<string, Declared>()): Map<string, Declared> {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	for (const st of source.statements) {
		if (ts.isExportDeclaration(st)) {
			assert.ok(!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier), `${relative(REPO_ROOT, file)}: only \`export * from\` re-exports are allowed`);
			declaredExports(resolve(dirname(file), st.moduleSpecifier.text), into);
			continue;
		}
		if (!ts.canHaveModifiers(st) || !ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		const names = ts.isVariableStatement(st)
			? st.declarationList.declarations.map((d) => d.name.getText(source))
			: [(st as ts.DeclarationStatement).name?.getText(source) ?? ""];
		const kind = ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) ? "type" : ts.isClassDeclaration(st) ? "class" : "value";
		for (const name of names) {
			assert.ok(!into.has(name), `${name} is exported twice (${into.get(name)?.file} and ${relative(REPO_ROOT, file)})`);
			into.set(name, { kind, text: st.getText(source), file: relative(REPO_ROOT, file) });
		}
	}
	return into;
}

/** A stable, order-free rendering of a runtime value: own keys sorted, symbols by description, freeze state kept. */
function canon(value: unknown, seen = new Set<unknown>()): unknown {
	// Function source is pinned by the declaration hash; here only its shape, so a Node upgrade cannot churn the golden.
	if (typeof value === "function") return { function: value.name, arity: value.length, own: canonKeys(value, seen) };
	if (value instanceof RegExp) return { re: String(value) };
	if (value === undefined) return { undefined: true };
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return { cycle: true };
	seen.add(value);
	const out = Array.isArray(value)
		? { array: value.map((item) => canon(item, seen)), frozen: Object.isFrozen(value) }
		: { object: canonKeys(value, seen), frozen: Object.isFrozen(value) };
	seen.delete(value);
	return out;
}

function canonKeys(value: object, seen: Set<unknown>): unknown[] {
	const names = Object.getOwnPropertyNames(value).filter((key) => typeof value !== "function" || !["length", "name", "prototype"].includes(key));
	const symbols = Object.getOwnPropertySymbols(value).sort((a, b) => String(a.description).localeCompare(String(b.description)));
	return [...names.sort(), ...symbols].map((key) => [typeof key === "symbol" ? `@@${key.description}` : key, canon((value as Record<PropertyKey, unknown>)[key], seen)]);
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

test("the contracts barrel exports exactly the pinned surface: names, kinds, declarations and runtime values", () => {
	const declared = declaredExports(BARREL);
	const runtime = contracts as Record<string, unknown>;
	const valueNames = [...declared].filter(([, d]) => d.kind !== "type").map(([name]) => name).sort();
	assert.deepEqual(Object.keys(runtime).sort(), valueNames, "the runtime export list and the declared value exports disagree");
	const lines = [...declared.keys()].sort().map((name) => {
		const d = declared.get(name) as Declared;
		const value = d.kind === "type" ? "-" : hash(JSON.stringify(canon(runtime[name])));
		return `${name}\t${d.kind}\t${hash(d.text)}\t${value}`;
	});
	assertGolden("contracts-exports.txt", lines.join("\n"));
});

// cp-8p74 P4: prompts, skills, profiles, tool descriptions and the routing docs name no model; routing.json chooses.
const MODEL_ID = /\b(?:anthropic|openai|xai|google|mistral|deepseek|openrouter)\/[\w.-]+|\b(?:claude|gpt|grok|gemini)-[0-9a-z]|\bClaude (?:Haiku|Sonnet|Opus|Fable)\b/;
/** Lines allowed to keep an id, by exact trimmed text. */
const KEPT = new Set([
	"read each `SKILL.md` at session start (34 gpt-6-sol jobs, about 11.6K tokens", // measured history, not a choice
]);

test("P4: no provider/model id is named in prompts, skills, profiles, tool descriptions or the routing docs", () => {
	const files = (dir: string, ext: RegExp) =>
		readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" }).filter((f) => ext.test(f)).map((f) => join(dir, f));
	const section = (text: string, from: string, to: string) => {
		const start = text.indexOf(from);
		const end = text.indexOf(to, start);
		assert.ok(start >= 0 && end > start, `section ${from} … ${to} not found`);
		return text.slice(start, end);
	};
	const surfaces: Array<[string, string]> = [
		...["AGENTS.md", ...files("prompts", /\.md$/), ...files("skills", /\.md$/), ...files("extensions", /\.ts$/), ...files("src/contracts", /\.ts$/)]
			.map((file): [string, string] => [file, readFileSync(join(REPO_ROOT, file), "utf8")]),
		...files("profiles", /\.md$/).map((file): [string, string] => [file, readFileSync(join(REPO_ROOT, file), "utf8")]),
		["docs/contracts.md", readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8")],
		["docs/routing-rollout.md#matrix", section(readFileSync(join(REPO_ROOT, "docs/routing-rollout.md"), "utf8"), "## The matrix", "Profiles (")],
	];
	const hits = surfaces.flatMap(([file, text]) =>
		text.split("\n").flatMap((line, i) => (MODEL_ID.test(line) && !KEPT.has(line.trim()) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
	);
	assert.deepEqual(hits, [], "omit the model and let data/routing.json decide; never name or suggest an id here");
});
