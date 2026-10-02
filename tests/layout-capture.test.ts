/**
 * No module may capture a `LAYOUT` value at import time (spec 2026-09-04).
 *
 * `LAYOUT` stopped being a frozen constant when modes landed: it is filled in
 * by `configureLayout(mode)` at session start, *after* every module has been
 * imported. So a module-level `const X = LAYOUT.data` pins the default
 * layout for the life of the process, and a home configured otherwise (flat,
 * or — formerly — a single-project repository) gets `data/` in the wrong
 * place. That is not a hypothetical: `src/memory.ts`'s `MEMORY_FILES` did
 * exactly this, and a real session left three untracked files at a
 * repository root.
 *
 * The rule is therefore mechanical and checked here rather than remembered:
 * **every `LAYOUT.` read is evaluated inside a function body**, never while the
 * module is being evaluated. "Inside a function" is decided by the TypeScript
 * compiler's own AST rather than by a text heuristic — the first attempt at
 * this guard counted braces and silently missed the very shape that caused the
 * bug, because an object literal in a module-level call is nested but still
 * import-time.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { REPO_ROOT } from "./harness/index.ts";

/** Every `.ts` file under the shipped source roots. */
function sourceFiles(): string[] {
	const roots = [join(REPO_ROOT, "src"), join(REPO_ROOT, "extensions")];
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
				continue;
			}
			if (path.endsWith(".ts")) found.push(path);
		}
	};
	for (const root of roots) walk(root);
	return found.sort();
}

/**
 * A node whose body runs on call, not on import. A **non-static** class
 * property initializer runs at construction, which is also after startup; a
 * `static` one runs at import and is therefore deliberately not deferred.
 */
function deferredEvaluation(node: ts.Node): boolean {
	switch (node.kind) {
		case ts.SyntaxKind.FunctionDeclaration:
		case ts.SyntaxKind.FunctionExpression:
		case ts.SyntaxKind.ArrowFunction:
		case ts.SyntaxKind.MethodDeclaration:
		case ts.SyntaxKind.GetAccessor:
		case ts.SyntaxKind.SetAccessor:
		case ts.SyntaxKind.Constructor:
			return true;
		case ts.SyntaxKind.PropertyDeclaration:
			return !(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static);
		default:
			return false;
	}
}

/** 1-based line numbers of every `LAYOUT.<x>` read evaluated at import time. */
export function importTimeLayoutReads(source: string, fileName = "file.ts"): number[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const hits: number[] = [];
	const visit = (node: ts.Node, deferred: boolean): void => {
		const nowDeferred = deferred || deferredEvaluation(node);
		if (
			!nowDeferred &&
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "LAYOUT"
		) {
			hits.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
		}
		node.forEachChild((child) => visit(child, nowDeferred));
	};
	visit(file, false);
	return hits;
}

test("the scanner finds import-time reads in every shape, and ignores deferred ones", () => {
	assert.deepEqual(importTimeLayoutReads("export const X = LAYOUT.data;\n"), [1]);
	assert.deepEqual(importTimeLayoutReads("export const X = `${LAYOUT.data}/x`;\n"), [1]);
	// The shape that actually shipped the bug: an object literal inside a
	// module-level call. A brace-depth scan misses this; the AST does not.
	assert.deepEqual(
		importTimeLayoutReads('export const F = Object.freeze([\n\t{ key: "a", path: LAYOUT.learningsFile },\n]);\n'),
		[2],
	);
	assert.deepEqual(importTimeLayoutReads("export const A = [LAYOUT.data, LAYOUT.state];\n"), [1, 1]);
	assert.deepEqual(importTimeLayoutReads("class C {\n\tstatic p = LAYOUT.data;\n}\n"), [2], "a static field runs at import");

	assert.deepEqual(importTimeLayoutReads("function f() {\n\treturn LAYOUT.data;\n}\n"), []);
	assert.deepEqual(importTimeLayoutReads("const o = {\n\tget path() {\n\t\treturn LAYOUT.data;\n\t},\n};\n"), []);
	assert.deepEqual(importTimeLayoutReads("export const f = () => LAYOUT.data;\n"), []);
	assert.deepEqual(importTimeLayoutReads("class C {\n\tp = LAYOUT.data;\n\tm() {\n\t\treturn LAYOUT.state;\n\t}\n}\n"), []);
	assert.deepEqual(importTimeLayoutReads("function f(home = LAYOUT.data) {\n\treturn home;\n}\n"), []);
	assert.deepEqual(importTimeLayoutReads("// LAYOUT.data\n/* LAYOUT.state */\n"), []);
	assert.deepEqual(importTimeLayoutReads("export const X = MY_LAYOUT.data;\n"), [], "only the LAYOUT identifier counts");
});

test("no shipped module reads LAYOUT at import time", () => {
	const scanned: string[] = [];
	const offenders: string[] = [];
	for (const file of sourceFiles()) {
		const source = readFileSync(file, "utf8");
		if (!source.includes("LAYOUT.")) continue;
		const name = relative(REPO_ROOT, file);
		// `src/contracts/layout.ts` declares LAYOUT; `layoutFor` and `configureLayout` are
		// its producers, and neither reads a captured value.
		if (name === "src/contracts/layout.ts") continue;
		scanned.push(name);
		for (const line of importTimeLayoutReads(source, name)) offenders.push(`${name}:${line}`);
	}
	assert.ok(scanned.length >= 10, `only scanned ${scanned.length} file(s): ${scanned.join(", ")}`);
	assert.deepEqual(
		offenders,
		[],
		`these read LAYOUT while the module is evaluated, before configureLayout() runs, so they pin the multi layout:\n  ${offenders.join("\n  ")}\n` +
			"Move the read inside a function body or a getter (see src/memory.ts MEMORY_FILES).",
	);
});
