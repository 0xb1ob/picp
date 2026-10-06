/**
 * pi-command-post-autonomy-programme-cur.6.2: growth is a decision, not a
 * drift. One file, three ratchets:
 *
 *   1. no single module exceeds PER_FILE_CAP unless it is grandfathered, and a
 *      grandfathered module is pinned to its 2026-09-24 line count plus a
 *      3% margin, rounded up to the next 10 lines;
 *   2. `package.json` permits only the two viewer runtime dependencies;
 *   3. AGENTS.md, the operator note, and a short list of identifiers for
 *      surfaces that were deliberately deleted (so they cannot quietly come
 *      back) stay capped/banned.
 *
 * Modeled on limen's `test/structure.test.ts`. The margin is there so an
 * ordinary PR never touches this file: raising a ceiling is a deliberate edit
 * with a one-sentence justification in the PR (AGENTS.md, "Size ceilings").
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

// ---------------------------------------------------------------------------
// Caps. Edit these, and only these, to raise a limit.
// ---------------------------------------------------------------------------

/** Any `.ts` module under `src/` or `extensions/` not listed below must stay at or under this. */
const PER_FILE_CAP = 800;

/**
 * Modules already over PER_FILE_CAP. Each is pinned to its 2026-09-24 line
 * count (in the comment) plus 3%, rounded up to the next 10. New entries are
 * not added by editing this list; a module crosses PER_FILE_CAP by growing,
 * which is the thing this test exists to stop.
 */
const GRANDFATHERED: Record<string, number> = {
	"src/pipeline.ts": 2090, // 2021
	"src/integrate.ts": 2050, // 1987
	"src/doctor.ts": 1640, // 1592 (lowered after cp-8knh P2 removed single-mode doctor checks)
	"src/command-post.ts": 1660, // 1576
	"src/awaiting.ts": 1590, // 1542
	"src/gate.ts": 1400, // 1350
	"src/evals.ts": 1240, // 1200
	"src/wakeups.ts": 1190, // 1152
	"src/diff-review.ts": 1160, // 1117
	"src/routing.ts": 1020, // 990
	"src/dispatch.ts": 960, // 928
	"src/ci-watch.ts": 960, // 927
	"src/merge-ask.ts": 840, // 809
	"src/worker-process.ts": 830, // 802
};

/** Runtime dependencies allowed in package.json's `dependencies`. */
const MAX_RUNTIME_DEPENDENCIES = 2;
const RUNTIME_DEPENDENCIES = ["esbuild", "preact"];

/** Mirrors the diet cap on AGENTS.md (tests/contract.test.ts pins the same number). */
const AGENTS_MD_MAX_LINES = 250;

/** Mirrors OPERATOR_NOTE_MAX_LINES in src/operator-note.ts. */
const OPERATOR_NOTE_MAX_LINES = 60;

/**
 * Identifiers for surfaces that were deliberately deleted from src/extensions
 * and must not quietly come back. Case-insensitive substring match against
 * every counted source file. Historical/design docs under docs/ are not
 * scanned — they are allowed to keep talking about what used to exist.
 */
// Fresh grant per fire (docs/contracts.md *Fresh grant per fire*): the S3 opt-in and a shared, reused schedule grant
// are gone for good; tests/schedule-grant.test.ts also pins the fire path itself.
const BANNED_IDENTIFIERS = ["attachconsole", "attach-console", "attach_console", "refire", "approval_quote", "mandate: shared"];

// ---------------------------------------------------------------------------

function filesBelow(path: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const child = join(path, entry.name);
		if (entry.isDirectory()) files.push(...filesBelow(child));
		else if (/\.(?:ts|tsx|css)$/.test(entry.name)) files.push(child);
	}
	return files;
}

function countedFiles(): string[] {
	return [...filesBelow(join(REPO_ROOT, "src")), ...filesBelow(join(REPO_ROOT, "extensions")), ...filesBelow(join(REPO_ROOT, "viewer-app")), join(REPO_ROOT, "scripts/build-viewer.ts")];
}

function lineCount(text: string): number {
	// A file that ends with a trailing newline (every file here does) has one
	// more "" element than lines after split; drop it so a 10-line file counts
	// as 10, not 11.
	return text.split("\n").length - 1;
}

test("no file exceeds the per-file cap unless it is grandfathered, and a grandfathered file never grows", () => {
	for (const path of countedFiles()) {
		const rel = relative(REPO_ROOT, path);
		const lines = lineCount(readFileSync(path, "utf8"));
		const pinned = GRANDFATHERED[rel];
		if (pinned === undefined) {
			assert.ok(lines <= PER_FILE_CAP, `${rel} is ${lines} lines, over the ${PER_FILE_CAP}-line per-module cap`);
		} else {
			assert.ok(lines <= pinned, `${rel} is ${lines} lines, over its grandfathered cap of ${pinned} — shrink it, or raise its pin with a one-sentence justification in the PR`);
		}
	}
	for (const rel of Object.keys(GRANDFATHERED)) {
		assert.ok(countedFiles().some((path) => relative(REPO_ROOT, path) === rel), `${rel} is grandfathered but no longer exists — drop it from GRANDFATHERED`);
	}
});

test("package.json permits only the two approved viewer runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), RUNTIME_DEPENDENCIES);
	const count = Object.keys(manifest.dependencies ?? {}).length;
	assert.ok(count <= MAX_RUNTIME_DEPENDENCIES, `package.json has ${count} runtime dependencies: ${Object.keys(manifest.dependencies ?? {}).join(", ")}`);
});

test("AGENTS.md and the operator note stay under their line caps", () => {
	const agentsLines = lineCount(readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"));
	assert.ok(agentsLines <= AGENTS_MD_MAX_LINES, `AGENTS.md is ${agentsLines} lines, over the ${AGENTS_MD_MAX_LINES}-line cap`);

	const noteSource = readFileSync(join(REPO_ROOT, "src/operator-note.ts"), "utf8");
	const match = /OPERATOR_NOTE = `([\s\S]*?)`;/.exec(noteSource);
	assert.ok(match, "could not find OPERATOR_NOTE template literal in src/operator-note.ts");
	const noteLines = (match[1] as string).split("\n").length;
	assert.ok(noteLines <= OPERATOR_NOTE_MAX_LINES, `operator note is ${noteLines} lines, over the ${OPERATOR_NOTE_MAX_LINES}-line cap`);
});

test("deleted surfaces stay deleted: banned identifiers do not reappear in src/ or extensions/", () => {
	const hits: string[] = [];
	for (const path of countedFiles()) {
		const text = readFileSync(path, "utf8").toLowerCase();
		for (const banned of BANNED_IDENTIFIERS) {
			if (text.includes(banned)) hits.push(`${relative(REPO_ROOT, path)} contains banned identifier "${banned}"`);
		}
	}
	assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// cp-u3i2: one way to name a home path. R1 refuses a literal top-level
// `state`/`data`/`projects` root in a join/resolve (use `LAYOUT.*`/`paths.*`);
// R1b refuses a literal `.pi-command-post` join outside the layout module and
// the contracts-free viewer; R2 names every call that reaches outside the home.
// Known limit: template strings and multi-segment joins are not caught.
// ---------------------------------------------------------------------------

const R1 = /\b(?:join|resolve)\(\s*[A-Za-z_$][\w.$#]*\s*,\s*["'`](?:state|data|projects)(?:\/|["'`])/;
const R1B = /\b(?:join|resolve)\([^)]*["'`]\.pi-command-post(?:\/|["'`])/;
const R2 = /\b(?:homedir|tmpdir)\(/;

/** R1: each test file is a legacy-layout negative fixture (it builds the old layout on purpose, to prove it is ignored). */
const R1_ALLOWED = [
	// Not a fixture: cp-daemon's outer may import only node:* (contracts pull typebox), so it derives its own
	// data/state paths; tests/daemon-files.test.ts pins them equal to layoutForHome("multi", home).
	"src/service/daemon-files.ts",
	"tests/mode.test.ts",
	"tests/quality.test.ts",
	"tests/quota.test.ts",
	"tests/repo-map.test.ts",
	"tests/storage.test.ts",
	"tests/task-references.test.ts",
	"tests/viewer.test.ts",
];
/** R2: the only sanctioned reads of `$HOME`/`$TMPDIR` in runtime code. */
const R2_ALLOWED = [
	"extensions/cp-bridge/index.ts",
	"src/home.ts",
	"src/projects.ts",
	"src/service/units.ts",
	"src/viewer/explorer.ts",
	"src/worker-packages.ts",
];

function sourcesBelow(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const rel = `${root}/${entry.name}`;
		if (entry.isDirectory()) out.push(...sourcesBelow(rel));
		else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) out.push(rel);
	}
	return out;
}

function filesHitting(rule: RegExp, roots: string[], skip: (rel: string) => boolean = () => false): Set<string> {
	const hits = new Set<string>();
	for (const rel of roots.flatMap(sourcesBelow)) {
		if (skip(rel)) continue;
		const code = readFileSync(join(REPO_ROOT, rel), "utf8").split("\n").filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
		if (code.some((line) => rule.test(line))) hits.add(rel);
	}
	return hits;
}

function assertRatchet(name: string, hits: Set<string>, allowed: readonly string[]): void {
	assert.deepEqual([...hits].filter((rel) => !allowed.includes(rel)).sort(), [], `${name}: new literal-path hit(s) — derive the path from LAYOUT/paths (docs/storage.md)`);
	assert.deepEqual(allowed.filter((rel) => !hits.has(rel)), [], `${name}: allowlisted file(s) no longer hit — drop them from the allowlist`);
}

test("storage ratchet R1/R1b/R2: home paths come from LAYOUT, outside-the-home calls are named", () => {
	const runtime = ["src", "extensions", "scripts"];
	assertRatchet("R1", filesHitting(R1, [...runtime, "tests"]), R1_ALLOWED);
	assertRatchet("R1b", filesHitting(R1B, runtime, (rel) => rel === "src/contracts/layout.ts" || rel.startsWith("src/viewer/")), []);
	assertRatchet("R2", filesHitting(R2, runtime), R2_ALLOWED);
});

// cp-txbb: cp-daemon is the one runtime; systemd is one of its backends, named in one module. cp-rrye: the
// dashboard's Start in tmux runs tmux directly, so control-api.ts left this list.
const SYSTEMD = /\b(?:systemctl|loginctl|journalctl)\b/;
const SYSTEMD_ALLOWED = ["src/service/daemon-backend.ts"];

test("systemd ratchet: systemctl/loginctl/journalctl appear only in the backend port (comments exempt)", () => {
	const hits = filesHitting(SYSTEMD, ["src", "extensions", "scripts"]);
	assert.deepEqual([...hits].filter((rel) => !SYSTEMD_ALLOWED.includes(rel)).sort(), [], "systemd tools belong in src/service/daemon-backend.ts (cp-daemon's backend port)");
	assert.deepEqual(SYSTEMD_ALLOWED.filter((rel) => !hits.has(rel)), [], "allowlisted file(s) no longer hit: drop them from SYSTEMD_ALLOWED");
});

// cp-2diz (review 1 of cp-27h0): statements are never joined with `;` to stay under a line cap.
// Scoped to the files the task cites: integrate.ts, src/command-post.ts, human-handoff.ts and the
// extensions/command-post/ modules (tools-dispatch.ts included). Strings and comments are blanked first; type-literal
// members (`{ a: T; b: U }`) and `for (;;)` headers are not statements, so they never match.
const JOINED_STATEMENT = /;\s*(?:(?:const|let|var|if|return|await|import|export|throw)\b|this\.|[A-Za-z_$][\w$]*\s*(?:\(|=(?![=>])|\.))/;
const NO_JOINED_STATEMENTS = ["src/integrate.ts", "src/command-post.ts", "src/human-handoff.ts", "extensions/command-post"];

function joinedStatementLines(text: string): number[] {
	const code = (line: string) => line.replace(/\\./g, "").replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""').replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
	return text.split("\n").flatMap((line, index) => (/^\s*(?:\*|\/\/|\/\*|for\s*\()/.test(line) || !JOINED_STATEMENT.test(code(line)) ? [] : [index + 1]));
}

test("no joined statements: integrate, src/command-post, human-handoff and extensions/command-post keep one statement per line", () => {
	assert.deepEqual(joinedStatementLines('import { A } from "./a.ts"; import { B } from "./b.ts";'), [1], "two imports on one line");
	assert.deepEqual(joinedStatementLines("\tconst x = await f(); if (x) return x; // why"), [1], "a statement and its guard");
	assert.deepEqual(joinedStatementLines("\tconst on = (ctx) => { s = ctx ?? s; relays.started(); };"), [1], "an arrow body");
	assert.deepEqual(joinedStatementLines('\topts: { a?: string; b: number };\n\tfor (let i = 0; i < n; i++) {}\n\tsay("a; b(c)");'), [], "type literals, for headers and strings");
	const files = NO_JOINED_STATEMENTS.flatMap((root) => (root.endsWith(".ts") ? [root] : sourcesBelow(root)));
	const hits = files.flatMap((rel) => joinedStatementLines(readFileSync(join(REPO_ROOT, rel), "utf8")).map((line) => `${rel}:${line}`));
	assert.deepEqual(hits, [], "split joined statements onto their own lines (or extract a helper); never compact to dodge a size cap");
});
