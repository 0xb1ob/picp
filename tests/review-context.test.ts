/**
 * R2: the diff reviewer's host-built repository context — whole files read from
 * git objects at the exact fork-point/head SHAs, fail-soft but named.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GitRunner } from "../src/default-base.ts";
import {
	materializeReviewContext,
	REVIEW_CONTEXT_FILE,
	REVIEW_CONTEXT_MANIFEST,
	type ReviewContextEntry,
	type ReviewContextResult,
	reviewContextPointer,
} from "../src/review-context.ts";
import { defaultGit } from "../src/teardown-head.ts";
import { createScratchRepo } from "./harness/index.ts";

interface Fixture {
	headSha: string;
	fork: string;
	scratch: string;
	calls: string[][];
	run(options?: { maxBytes?: number; git?: GitRunner; scratch?: string }): Promise<ReviewContextResult>;
	context(scratch?: string): string;
}

/** A base with `base` files, a pushed `feature` branch writing `branch` files and deleting `deletes`. */
function fixture(t: { after(fn: () => void): void }, base: Record<string, string>, branch: Record<string, string>, deletes: string[] = [], task?: string): Fixture {
	const repo = createScratchRepo({ files: base });
	const scratch = mkdtempSync(join(tmpdir(), "cp-ctx-"));
	t.after(() => {
		repo.cleanup();
		rmSync(scratch, { recursive: true, force: true });
	});
	repo.git("checkout", "--quiet", "-b", "feature");
	for (const [path, content] of Object.entries(branch)) repo.write(path, content);
	for (const path of deletes) repo.git("rm", "--quiet", path);
	repo.commitAll("work");
	repo.git("push", "--quiet", "-u", "origin", "feature");
	if (task !== undefined) writeFileSync(join(scratch, "original-task.md"), task);
	const calls: string[][] = [];
	const headSha = repo.head("feature");
	return {
		headSha,
		fork: repo.head("main"),
		scratch,
		calls,
		run: (options = {}) =>
			materializeReviewContext({
				git: (cwd, args) => (calls.push([...args]), (options.git ?? defaultGit)(cwd, args)),
				clone: repo.path,
				base: "main",
				branch: "feature",
				headSha,
				scratch: options.scratch ?? scratch,
				...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
			}),
		context: (dir = scratch) => readFileSync(join(dir, REVIEW_CONTEXT_FILE), "utf8"),
	};
}

function entry(result: ReviewContextResult, path: string, side: "fork" | "head"): ReviewContextEntry | undefined {
	return result.entries.find((item) => item.path === path && item.side === side);
}

test("(1) a task-named file deleted on the branch is included from the fork and confirmed absent on head", async (t) => {
	const f = fixture(t, { "README.md": "# demo\n", "docs/legacy.md": "legacy fork_only_body\n" }, { "src/a.ts": "export const a = 1;\n" }, ["docs/legacy.md"], "Remove docs/legacy.md and add src/a.ts.\n");
	const result = await f.run();
	assert.equal(result.status, "ok");
	assert.equal(result.fork_point, f.fork);
	assert.equal(result.head_sha, f.headSha);
	// A task-named path that also changed is queued as changed (cp-c1ur N11: changed sources fill the budget first).
	assert.deepEqual(entry(result, "docs/legacy.md", "fork"), { ...entry(result, "docs/legacy.md", "fork"), reason: "changed", state: "included" });
	assert.deepEqual(entry(result, "docs/legacy.md", "head"), { path: "docs/legacy.md", side: "head", reason: "changed", state: "absent" });
	const context = f.context();
	assert.ok(context.includes(`### fork ${f.fork.slice(0, 12)} docs/legacy.md (`));
	assert.ok(context.includes("legacy fork_only_body"));
	assert.deepEqual(JSON.parse(readFileSync(join(f.scratch, REVIEW_CONTEXT_MANIFEST), "utf8")), result);
});

test("(2) a unique basename resolves; a duplicate basename is ambiguous with candidates; no match is unresolved", async (t) => {
	const f = fixture(t, { "lib/unique.ts": "u\n", "src/one/util.ts": "1\n", "src/two/util.ts": "2\n" }, { "src/new.ts": "n\n" }, [], "Touch unique.ts, util.ts and nothing.ts.\n");
	const result = await f.run();
	assert.equal(entry(result, "lib/unique.ts", "head")?.reason, "task-named");
	assert.equal(entry(result, "lib/unique.ts", "head")?.state, "included");
	assert.deepEqual(entry(result, "util.ts", "head"), { path: "util.ts", side: "head", reason: "task-named", state: "ambiguous", candidates: ["src/one/util.ts", "src/two/util.ts"] });
	assert.deepEqual(entry(result, "nothing.ts", "head"), { path: "nothing.ts", side: "head", reason: "task-named", state: "unresolved" });
});

test("(3) absolute and ~ path tokens are never resolved or read", async (t) => {
	const f = fixture(t, { "x.ts": "root x\n", "etc/hosts.md": "h\n" }, { "src/new.ts": "n\n" }, [], "Check /etc/hosts.md, ~/x.ts and /abs/x.ts.\n");
	const result = await f.run();
	assert.equal(result.entries.some((item) => item.reason === "task-named"), false, `${JSON.stringify(result.entries)}`);
	assert.equal(f.calls.some((args) => args.some((arg) => arg.includes("x.ts") || arg.includes("hosts"))), false);
	assert.ok(!f.context().includes("root x"));
});

test("(4) a budget smaller than the second file omits it whole: whole sections only", async (t) => {
	const first = `${"a".repeat(99)}\n`;
	const second = `${"b".repeat(199)}\n`;
	const f = fixture(t, { "README.md": "# demo\n" }, { "a.txt": first, "b.txt": second });
	const result = await f.run({ maxBytes: 150 });
	assert.deepEqual([entry(result, "a.txt", "head")?.state, entry(result, "b.txt", "head")?.state], ["included", "omitted-budget"]);
	assert.equal(entry(result, "b.txt", "head")?.bytes, 200);
	assert.equal(entry(result, "a.txt", "fork")?.state, "absent");
	assert.equal(result.used_bytes, 100);
	const context = f.context();
	assert.ok(context.includes(first));
	assert.ok(!context.includes("bbbb"), "no part of the omitted file is written");
	assert.equal(context.match(/^### /gm)?.length, 1);
});

test("(5) a failing cat-file is unreadable; a failing merge-base is unavailable with no context.md", async (t) => {
	const f = fixture(t, { "README.md": "# demo\n" }, { "src/a.ts": "a\n" });
	const failing = (command: string): GitRunner => async (cwd, args) => (args[0] === command && args[1] !== "-s" ? { status: 128, stdout: "", stderr: `fatal: ${command} broke\nmore` } : defaultGit(cwd, args));
	const unreadable = await f.run({ git: failing("cat-file") });
	assert.equal(unreadable.status, "ok");
	assert.deepEqual(entry(unreadable, "src/a.ts", "head"), { path: "src/a.ts", side: "head", reason: "changed", state: "unreadable", error: "fatal: cat-file broke" });

	const scratch = mkdtempSync(join(tmpdir(), "cp-ctx-none-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const unavailable = await f.run({ git: failing("merge-base"), scratch });
	assert.equal(unavailable.status, "unavailable");
	assert.match(unavailable.error ?? "", /fatal: merge-base broke$/);
	assert.deepEqual(unavailable.entries, []);
	assert.equal(existsSync(join(scratch, REVIEW_CONTEXT_FILE)), false);
	assert.equal(JSON.parse(readFileSync(join(scratch, REVIEW_CONTEXT_MANIFEST), "utf8")).status, "unavailable");
	assert.match(reviewContextPointer(unavailable), /^Repository context unavailable: .*fatal: merge-base broke\. Judge from the diff and task only, and report the limit\.$/);
});

test("(6) a blob containing NUL is binary and never written", async (t) => {
	const f = fixture(t, { "README.md": "# demo\n" }, { "img.bin": "PNG\0\x01binary_marker" });
	const result = await f.run();
	assert.deepEqual(entry(result, "img.bin", "head"), { path: "img.bin", side: "head", reason: "changed", state: "binary", bytes: 18 });
	assert.ok(!f.context().includes("binary_marker"));
});

test("(7) order and sha256 are stable across runs", async (t) => {
	const f = fixture(t, { "README.md": "# demo\n", "src/b.ts": "b\n" }, { "src/a.ts": "a\n", "src/b.ts": "b2\n", "AGENTS.md": "rules\n" }, [], "See README.md.\n");
	const other = mkdtempSync(join(tmpdir(), "cp-ctx-again-"));
	t.after(() => rmSync(other, { recursive: true, force: true }));
	writeFileSync(join(other, "original-task.md"), "See README.md.\n");
	const first = await f.run();
	const second = await f.run({ scratch: other });
	assert.deepEqual(second, first);
	assert.equal(f.context(other), f.context());
	assert.deepEqual(first.entries.map((item) => `${item.reason}:${item.side}:${item.path}`), [
		"changed:head:AGENTS.md",
		"changed:head:src/a.ts",
		"changed:head:src/b.ts",
		"changed:fork:AGENTS.md",
		"changed:fork:src/a.ts",
		"changed:fork:src/b.ts",
		"task-named:head:README.md",
	]);
	assert.match(entry(first, "src/a.ts", "head")?.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("(8) consumers are capped at 5 per changed path, sorted, and test files are not grepped for", async (t) => {
	const base: Record<string, string> = { "src/core.ts": "export const core = 1;\n" };
	for (let i = 1; i <= 7; i += 1) base[`src/use-${i}.ts`] = `import { core } from "./core.ts";\n`;
	const f = fixture(t, base, { "src/core.ts": "export const core = 2;\n", "tests/core.test.ts": "x\n" });
	const result = await f.run();
	assert.deepEqual(result.entries.filter((item) => item.reason === "consumer").map((item) => item.path), [1, 2, 3, 4, 5].map((i) => `src/use-${i}.ts`));
	assert.deepEqual(f.calls.filter((args) => args[0] === "grep").map((args) => args[4]), ["core.ts"]);
});

test("(9) the pointer names both SHAs and says absent is not omitted", async (t) => {
	const f = fixture(t, { "README.md": "# demo\n" }, { "src/a.ts": "a\n" });
	const pointer = reviewContextPointer(await f.run());
	assert.ok(pointer.includes(`Fork point ${f.fork.slice(0, 12)}, head ${f.headSha.slice(0, 12)}.`));
	assert.match(pointer, /read context-manifest\.json first, then only the context\.md sections you need/);
	assert.match(pointer, /`absent` means git confirmed the path does not exist at that sha/);
	assert.match(pointer, /`omitted-budget`\/`unreadable`\/`unresolved` mean unknown — never treat them as absent\./);
});

test("(10) cp-c1ur N11: changed sources fill the budget before large task-named fixtures; no duplicate fork side", async (t) => {
	// Pins the rqx3 manifest: two ~94 KB task-named fixtures took the budget, changed sources went omitted-budget,
	// an unchanged file was emitted twice with one sha256, and picp invariants showed `absent` in another repo.
	const fixtureBody = `${"f".repeat(39_999)}\n`;
	const f = fixture(
		t,
		{ "tests/fixtures/big.json": fixtureBody, "lib/core.py": "core = 1\n" },
		{ "src/run.py": `${"r".repeat(99)}\n` },
		[],
		"Use tests/fixtures/big.json and lib/core.py.\n",
	);
	// Room for run.py plus either big.json or core.py: the large fixture is the one deferred.
	const result = await f.run({ maxBytes: 40_105 });
	assert.equal(entry(result, "src/run.py", "head")?.state, "included");
	assert.equal(entry(result, "tests/fixtures/big.json", "head")?.state, "omitted-budget");
	assert.equal(entry(result, "lib/core.py", "head")?.state, "included");
	assert.equal(entry(result, "lib/core.py", "fork"), undefined, "an unchanged path's fork side is its head side");
	assert.equal(result.entries.some((item) => item.reason === "invariant"), false, "invariants missing from the tree are not listed");
});
