/**
 * Worker-reporter units kept verbatim from tests/worker-reporter.test.ts: pure helpers (rejection text, edit-failure
 * causes, miss counting, guards, local checks, verdict clamping) and the recursion guard, which no dispatched worker
 * can reach. Real-worker reporting is e2e in tests/e2e/worker-reporter-p8f.test.ts ([p8f](../docs/testing-migration/p8f.md)).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clampVerdictItems,
	classifyEditFailure,
	createMissCounter,
	enrichAnchorEditFailure,
	enrichEditFailure,
	enrichSilentBashFailure,
	findEditMatchLines,
	formatRejection,
	GATE_REVIEW_ITEM_MAX,
	GATE_REVIEW_LENIENT_ITEM_MAX,
	LenientGateReviewSchema,
	loadJobContext,
	localChecks,
} from "../extensions/worker-reporter/index.ts";
import workerReporter from "../extensions/worker-reporter/index.ts";
import { headShaErrors } from "../extensions/worker-reporter/head.ts";
import {
	ANSWER_MAX_BYTES,
	type Envelope,
	GATE_REASONS_MAX_ITEMS,
	GateReviewSchema,
	paths,
	validate,
} from "../src/contracts.ts";
import { WorkerProcess } from "../src/worker-process.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------

const BASE_ENV = {
	CP_JOB_ID: "cp-job1",
	CP_KIND: "ship",
	CP_DELIVERY: "pr",
	CP_RUN_DIR: "/tmp/runs/cp-job1",
	CP_ROLE: "implementer",
};

test("job identity comes from the environment and fails closed", () => {
	const context = loadJobContext({ ...BASE_ENV, CP_WORKTREE: "/wt", CP_ARTIFACT_PATH: "/a/report.md" });
	assert.equal(context.job_id, "cp-job1");
	assert.equal(context.kind, "ship");
	assert.equal(context.delivery, "pr");
	assert.equal(context.worktree, "/wt");
	assert.equal(context.artifactPath, "/a/report.md");
	assert.equal(context.role, "implementer");

	assert.throws(() => loadJobContext({}), /CP_JOB_ID, CP_KIND, CP_DELIVERY, CP_RUN_DIR, CP_ROLE/);
	assert.throws(() => loadJobContext({ ...BASE_ENV, CP_KIND: "chore" }), /CP_KIND must be one of/);
	assert.throws(() => loadJobContext({ ...BASE_ENV, CP_DELIVERY: "slack" }), /CP_DELIVERY must be one of/);
	assert.throws(() => loadJobContext({ ...BASE_ENV, CP_ROLE: "reviewer" }), /CP_ROLE must be one of/);
});

test("rejection text names the fixes and the remaining budget", () => {
	const text = formatRejection(["summary: too long"], 1, 2, "report_result");
	assert.match(text, /report_result rejected \(attempt 1\)/);
	assert.match(text, /- summary: too long/);
	assert.match(text, /2 attempts left/);
	assert.match(formatRejection(["x"], 2, 1, "report_result"), /1 attempt left/);
	assert.match(formatRejection(["x"], 3, 0, "report_verdict"), /No attempts left/);
});

test("edit failures are diagnosed by cause, not left for the worker to guess", () => {
	assert.equal(
		classifyEditFailure("Could not find the exact text in foo.ts. The old text must match exactly.")?.cause,
		"no_match",
	);
	assert.equal(classifyEditFailure("Could not find edits[1] in foo.ts. The oldText must match exactly.")?.cause, "no_match");
	assert.equal(
		classifyEditFailure("Found 3 occurrences of the text in foo.ts. The text must be unique.")?.cause,
		"not_unique",
	);
	assert.equal(
		classifyEditFailure("edits[0] and edits[1] overlap in foo.ts. Merge them into one edit.")?.cause,
		"overlap",
	);
	assert.equal(classifyEditFailure("Operation aborted"), undefined);
});

test("a not-found edit points at the nearest real line instead of leaving the worker to re-read blind", () => {
	const content = "line one\nlet x = 1;\nline three\n";
	// The first line of oldText still matches; only the (unseen) second line
	// drifted — exactly the stale-read shape this is meant to catch.
	const error = enrichEditFailure(
		"Could not find the exact text in foo.ts. The old text must match exactly including all whitespace and newlines.",
		{ path: "foo.ts", oldText: "let x = 1;\nlet y = 2;", newText: "let x = 3;" },
		(path) => {
			assert.equal(path, "foo.ts");
			return content;
		},
	);
	assert.match(error, /cause: no_match/);
	assert.match(error, /Nearest line — 2: let x = 1;/);
});

test("a not-unique edit lists every line it matched, not just the count", () => {
	const content = "a\nfoo();\nb\nfoo();\nc\n";
	const error = enrichEditFailure(
		"Found 2 occurrences of the text in foo.ts. The text must be unique. Please provide more context to make it unique.",
		{ path: "foo.ts", oldText: "foo();", newText: "bar();" },
		() => content,
	);
	assert.match(error, /cause: not_unique/);
	assert.match(error, /Matches at lines 2, 4\./);
});

test("an overlap failure is passed through unenriched — the built-in message already names both indices", () => {
	const error = enrichEditFailure(
		"edits[0] and edits[1] overlap in foo.ts. Merge them into one edit or target disjoint regions.",
		{ path: "foo.ts", edits: [{ oldText: "a", newText: "b" }] },
		() => "",
	);
	assert.match(error, /cause: overlap/);
});

test("an unreadable file still gets the cause and hint, just no near-miss line", () => {
	const error = enrichEditFailure(
		"Could not find the exact text in foo.ts. The old text must match exactly including all whitespace and newlines.",
		{ path: "foo.ts", oldText: "x", newText: "y" },
		() => {
			throw new Error("ENOENT");
		},
	);
	assert.match(error, /cause: no_match/);
	assert.doesNotMatch(error, /Nearest line/);
});

test("replace/insert failures get a cause and next move, like edit", () => {
	const stale = enrichAnchorEditFailure(
		'[E_STALE_ANCHOR] 1 stale anchor in README.md: "ReUA". The file changed since read. Call read() on README.md for fresh anchors.',
	);
	assert.equal(stale?.cause, "stale_anchor");
	assert.equal(stale?.path, "README.md");
	assert.match(stale?.text ?? "", /cause: stale_anchor — the file changed since read/);
	const unserved = enrichAnchorEditFailure('[E_STALE_ANCHOR] "EFen" is not owned in this session. Call read() on the target file first.');
	assert.equal(unserved?.cause, "stale_anchor");
	assert.match(unserved?.text ?? "", /cause: stale_anchor — this anchor was never served/);
	assert.match(unserved?.text ?? "", /mistyped/);
	assert.doesNotMatch(unserved?.text.split("cause:")[1] ?? "", /file changed since read/);
	assert.equal(enrichAnchorEditFailure('[E_BAD_REF] Invalid anchor "x".')?.cause, "bad_anchor");
	const invalid = enrichAnchorEditFailure('Validation failed for tool "insert":\n  - lines: required');
	assert.equal(invalid?.cause, "bad_arguments");
	assert.equal(invalid?.path, undefined);
	assert.equal(enrichAnchorEditFailure("Operation aborted"), undefined);
});

test("miss counter: identical = same scope and cause (not same input); scopes never pool; resets clear runs", () => {
	const counter = createMissCounter();
	const a = { path: "a.ts" };
	const b = { path: "b.ts" };
	assert.equal(counter.miss(a, "no_match"), undefined);
	assert.equal(counter.miss(b, "no_match"), undefined); // other path has its own count
	assert.equal(counter.miss(a, "no_match"), undefined);
	assert.match(counter.miss(a, "no_match") ?? "", /Identical no_match failure #3 on a\.ts.*read a\.ts again/);
	assert.equal(counter.miss(b, "no_match"), undefined);
	// a different cause restarts the run
	assert.equal(counter.miss(a, "not_unique"), undefined);
	// a reset restarts it too
	counter.miss(a, "not_unique");
	counter.reset("a.ts");
	assert.equal(counter.miss(a, "not_unique"), undefined);
	// anchor-scoped (path unknown) runs never pool across anchors, and a miss with no scope is not counted
	for (let i = 0; i < 5; i++) assert.equal(counter.miss({}, "bad_arguments"), undefined);
	counter.miss({ anchor: "AAAA" }, "bad_arguments");
	counter.miss({ anchor: "BBBB" }, "bad_arguments");
	assert.equal(counter.miss({ anchor: "AAAA" }, "bad_arguments"), undefined);
	assert.match(counter.miss({ anchor: "AAAA" }, "bad_arguments") ?? "", /#3 on the target file/);
	// reset(path) clears anchor-scoped runs too (their anchors are stale after a re-read); reset() clears all
	counter.miss({ anchor: "AAAA" }, "bad_arguments");
	counter.reset("any.ts");
	assert.equal(counter.miss({ anchor: "AAAA" }, "bad_arguments"), undefined);
	counter.miss(b, "no_match");
	counter.reset();
	assert.equal(counter.miss(b, "no_match"), undefined);
});

// Real inputs, from the run-log corpus: the replace/insert schema is anchors only, no `path`.
const REPLACE_INPUT = { remove_from: "MMvt", remove_to: "MMvt", replacement_lines: "x" };
const INSERT_INPUT = { anchor: "MMvt", direction: "after", lines: "x" };
const STALE = (file: string) =>
	`[E_STALE_ANCHOR] 1 stale anchor in ${file}: "ReUA". The file changed since read. Call read() on ${file} for fresh anchors.`;
const INVALID = 'Validation failed for tool "replace":\n  - replacement_lines: must have required properties replacement_lines';

function stubbedHandlers(): Record<string, (event: unknown) => unknown> {
	const keys = ["CP_JOB_ID", "CP_KIND", "CP_DELIVERY", "CP_RUN_DIR", "CP_ROLE"];
	const saved = keys.map((key) => process.env[key]);
	Object.assign(process.env, {
		CP_JOB_ID: "cp-stub",
		CP_KIND: "ship",
		CP_DELIVERY: "pr",
		CP_RUN_DIR: mkdtempSync(join(tmpdir(), "wr-handler-")),
		CP_ROLE: "implementer",
	});
	const handlers: Record<string, (event: unknown) => unknown> = {};
	try {
		workerReporter({
			on: (name: string, fn: (event: unknown) => unknown) => {
				handlers[name] = fn;
			},
			registerTool: () => {},
		} as never);
	} finally {
		keys.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])));
	}
	return handlers;
}

function stubbedToolResultHandler() {
	const handlers = stubbedHandlers();
	return (toolName: string, input: Record<string, unknown>, text: string, isError = true): string | undefined => {
		const out = handlers.tool_result?.({ toolName, input, isError, content: [{ type: "text", text }] }) as
			| { content: Array<{ text: string }> }
			| undefined;
		return out?.content[0]?.text;
	};
}

test("credential guards are blocked at tool_call (N1, N2, N5)", () => {
	const handlers = stubbedHandlers();
	const call = (command: string) =>
		handlers.tool_call?.({ toolName: "bash", input: { command } }) as { block: true; reason: string } | undefined;
	const copy = call('cp -a ~/.pi-command-post/state ~/.pi-command-post/data "$T/.pi-command-post/"');
	assert.equal(copy?.block, true);
	assert.match(copy?.reason ?? "", /never bulk-copies/);
	const auth = call("gh auth status 2>&1");
	assert.equal(auth?.block, true);
	assert.match(auth?.reason ?? "", /gh api user --jq \.login/);
	const search = call("grep -rlE 'EXAMPLE_API_KEY=' ~/.pi-command-post ~/.config ~/.pi");
	assert.equal(search?.block, true);
	assert.match(search?.reason ?? "", /printenv NAME/);
	assert.equal(call("cp ~/.pi/agent/models.json /tmp/a/models.json"), undefined);
	assert.equal(call("cp -a ~/.pi-command-post/state/runs/cp-xlax /tmp/a/"), undefined);
	assert.equal(call("rg -n API_KEY src/"), undefined);
});

test("tool_result handler: bash token shapes are redacted, success or error", () => {
	// Built at runtime: no literal token shape lives in source.
	const fake = ["github", "pat", "A".repeat(22), "b".repeat(59)].join("_");
	const result = stubbedToolResultHandler();
	assert.equal(result("bash", { command: "gh-ish" }, `Token: ${fake}`, false), "Token: [REDACTED]");
	const failed = result("bash", { command: "x" }, `oops ${fake}\n\nCommand exited with code 1`) ?? "";
	assert.match(failed, /Command exited with code 1/);
	assert.match(failed, /\[REDACTED\]/);
	assert.ok(!failed.includes(fake));
	const silent = result("bash", { command: `curl -H "x: ${fake}" host` }, "(no output)\n\nCommand exited with code 1") ?? "";
	assert.match(silent, /Command: curl -H "x: \[REDACTED\]" host/);
	assert.ok(!silent.includes(fake));
	assert.equal(result("bash", { command: "echo hi" }, "hi", false), undefined);
});

test("tool_result handler: replace/insert are enriched, and the 3rd identical miss on a file appends the re-read line", () => {
	assert.ok(!("path" in REPLACE_INPUT) && !("path" in INSERT_INPUT));
	const result = stubbedToolResultHandler();
	assert.match(result("replace", REPLACE_INPUT, STALE("README.md")) ?? "", /cause: stale_anchor/);
	const second = result("insert", INSERT_INPUT, STALE("README.md")) ?? "";
	assert.match(second, /cause: stale_anchor/);
	assert.doesNotMatch(second, /Identical/);
	assert.match(result("replace", REPLACE_INPUT, STALE("README.md")) ?? "", /cause: stale_anchor[\s\S]*Identical stale_anchor failure #3 on README\.md\. Stop retrying: read README\.md again/);
	// edit failures share the same per-path count
	const edit = { path: "src/x.ts", oldText: "nope", newText: "y" };
	const miss = "Could not find the exact text in src/x.ts. The old text must match exactly.";
	assert.doesNotMatch(result("edit", edit, miss) ?? "", /Identical/);
	assert.doesNotMatch(result("edit", edit, miss) ?? "", /Identical/);
	assert.match(result("edit", edit, miss) ?? "", /cause: no_match[\s\S]*Identical no_match failure #3 on src\/x\.ts/);
});

test("tool_result handler: misses on different files are not pooled; an input path is preferred", () => {
	const result = stubbedToolResultHandler();
	// path-less errors on three different anchors (different files) never reach 3
	for (const anchor of ["AAAA", "BBBB", "CCCC"]) {
		assert.doesNotMatch(result("replace", { ...REPLACE_INPUT, remove_from: anchor }, INVALID) ?? "", /Identical/);
	}
	// if an input names a path it wins over the one inside the error text
	const named = { ...REPLACE_INPUT, path: "named.ts" };
	result("replace", named, STALE("other.md"));
	result("replace", named, STALE("different.md"));
	assert.match(result("replace", named, STALE("third.md")) ?? "", /#3 on named\.ts/);
});

test("tool_result handler: a successful read resets the run, including the path-less fallback", () => {
	const result = stubbedToolResultHandler();
	result("replace", REPLACE_INPUT, STALE("README.md"));
	result("replace", REPLACE_INPUT, STALE("README.md"));
	assert.equal(result("read", { path: "README.md" }, "file text", false), undefined);
	assert.doesNotMatch(result("replace", REPLACE_INPUT, STALE("README.md")) ?? "", /Identical/);
	// anchor-scoped run (error names no file)
	result("replace", REPLACE_INPUT, INVALID);
	result("replace", REPLACE_INPUT, INVALID);
	result("read", { path: "anything.ts" }, "file text", false);
	assert.doesNotMatch(result("replace", REPLACE_INPUT, INVALID) ?? "", /Identical/);
});

test("tool_result handler: successes and unrelated results are left untouched", () => {
	const result = stubbedToolResultHandler();
	assert.equal(result("replace", REPLACE_INPUT, "Replaced lines", false), undefined);
	assert.equal(result("insert", INSERT_INPUT, "Inserted", false), undefined);
	assert.equal(result("edit", { path: "a.ts" }, "Operation aborted"), undefined);
	assert.equal(result("replace", REPLACE_INPUT, "Operation aborted"), undefined);
	assert.equal(result("grep", {}, "boom"), undefined);
	// a success clears runs: two misses, one good replace, then a miss starts over
	result("replace", REPLACE_INPUT, STALE("README.md"));
	result("replace", REPLACE_INPUT, STALE("README.md"));
	result("replace", REPLACE_INPUT, "Replaced lines", false);
	assert.doesNotMatch(result("replace", REPLACE_INPUT, STALE("README.md")) ?? "", /Identical/);
});

test("a replace batch reports the cause once; sibling E_OP_ABORTED lines do not restate it or count as misses", () => {
	const result = stubbedToolResultHandler();
	const cause = '[E_STALE_ANCHOR] "EFen" is not owned in this session. Call read() on the target file first.';
	assert.match(result("replace", REPLACE_INPUT, cause) ?? "", /never served/);
	const sibling = '[E_OP_ABORTED] Batch 3 aborted: [replace] Call Nr 1 errored [E_STALE_ANCHOR]. Nothing was written; the whole batch was discarded.';
	const first = result("replace", REPLACE_INPUT, sibling) ?? "";
	const second = result("replace", { ...REPLACE_INPUT, remove_from: "ssPB" }, sibling) ?? "";
	assert.equal(first, second);
	assert.match(first, /\[E_OP_ABORTED\] Batch 3 discarded/);
	assert.doesNotMatch(first, /E_STALE_ANCHOR/);
	assert.doesNotMatch(second, /Identical/);
	const primary = "[E_OP_ABORTED] Batch 4 aborted: the file changed after the batch started. Call read for fresh anchors and retry.";
	assert.equal(result("replace", REPLACE_INPUT, primary), undefined, "the first statement of a batch's own abort is kept");
	const restated = "[E_OP_ABORTED] Batch 4 aborted: the file changed after the batch started. Nothing was written; the whole batch was discarded.";
	const again = result("replace", REPLACE_INPUT, restated) ?? "";
	assert.match(again, /Batch 4 discarded/);
	assert.doesNotMatch(again, /file changed after/);
});

test("an E_OP_ABORTED line with no batch id is never deduped onto another operation", () => {
	const result = stubbedToolResultHandler();
	const unknown = "[E_OP_ABORTED] aborted with no batch id: [replace] Call Nr 1 errored [E_STALE_ANCHOR]. Nothing was written.";
	const other = "[E_OP_ABORTED] a different operation failed. Call Nr 2 errored [E_BAD_SHAPE].";
	assert.equal(result("replace", REPLACE_INPUT, unknown), undefined);
	assert.equal(result("insert", INSERT_INPUT, other), undefined);
	assert.equal(result("replace", { ...REPLACE_INPUT, remove_from: "ssPB" }, unknown), undefined);
});

test("a successful edit, replace, or insert clears remembered abort batches", () => {
	const result = stubbedToolResultHandler();
	const successes: Array<[string, Record<string, unknown>, string]> = [
		["replace", REPLACE_INPUT, "Replaced lines"],
		["insert", INSERT_INPUT, "Inserted"],
		["edit", { path: "src/x.ts", oldText: "a", newText: "b" }, "edited"],
	];
	for (const [batch, [tool, input, text]] of successes.map((success, i) => [`${i + 9}`, success] as const)) {
		const primary = `[E_OP_ABORTED] Batch ${batch} aborted: the file changed after the batch started. Call read for fresh anchors and retry.`;
		const restated = `[E_OP_ABORTED] Batch ${batch} aborted: the file changed after the batch started. Nothing was written; the whole batch was discarded.`;
		assert.equal(result("replace", REPLACE_INPUT, primary), undefined);
		assert.match(result("replace", REPLACE_INPUT, restated) ?? "", new RegExp(`Batch ${batch} discarded`));
		assert.equal(result(tool, input, text, false), undefined);
		assert.equal(result("replace", REPLACE_INPUT, primary), undefined, `${tool} success lets batch ${batch} be stated again`);
	}
	const stuck = "[E_OP_ABORTED] Batch 12 aborted: the file changed after the batch started. Nothing was written; the whole batch was discarded.";
	const stated = "[E_OP_ABORTED] Batch 12 aborted: the file changed after the batch started. Call read for fresh anchors and retry.";
	assert.equal(result("replace", REPLACE_INPUT, stated), undefined);
	assert.equal(result("read", { path: "src/x.ts" }, "file text", false), undefined);
	assert.match(result("replace", REPLACE_INPUT, stuck) ?? "", /Batch 12 discarded/);
});

test("a bash non-zero exit with no output names the command that failed", () => {
	const silent = "(no output)\n\nCommand exited with code 1";
	assert.equal(
		enrichSilentBashFailure(silent, { command: "git diff --quiet" }),
		`${silent}\n\nCommand: git diff --quiet`,
	);
	const long = enrichSilentBashFailure(silent, { command: `echo ${"x".repeat(1000)}` });
	assert.match(long, /Command: echo x+… \[truncated\]$/);
	assert.ok(long.length < silent.length + 400);
	// Output present, or no command to name: unchanged.
	const noisy = "fatal: not a git repository\n\nCommand exited with code 128";
	assert.equal(enrichSilentBashFailure(noisy, { command: "git status" }), noisy);
	assert.equal(enrichSilentBashFailure(silent, {}), silent);
});

test("findEditMatchLines falls back to the first non-blank line, then a short prefix, when there is no exact hit", () => {
	const content = "before\n  let total = compute(a, b);\nafter\n";
	const hits = findEditMatchLines(content, "let total = compute(a, b, c);\nreturn total;");
	assert.deepEqual(hits, [{ line: 2, text: "let total = compute(a, b);" }]);
	assert.deepEqual(findEditMatchLines("nothing here", "totally absent text that matches nothing at all"), []);
});

test("local checks protect the artifact and research porcelain", () => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "checks", withRemote: false });
	try {
		const artifact = join(home.path, "report.md");
		const context = {
			job_id: "cp-res1",
			kind: "research" as const,
			delivery: "pipeline" as const,
			role: "planner" as const,
			runDir: join(home.path, "run"),
			worktree: repo.path,
			mayAskOperator: false,
		};
		const envelope: Envelope = {
			job_id: "cp-res1",
			kind: "research",
			status: "done",
			summary: "found it",
			artifact_path: artifact,
		};

		assert.match(localChecks(envelope, context).join(";"), /does not exist/);
		writeFileSync(artifact, "");
		assert.match(localChecks(envelope, context).join(";"), /is empty/);
		writeFileSync(artifact, "# findings\n");
		assert.deepEqual(localChecks(envelope, context), []);

		// cp-c1ur N7: intake stats in the parent's cwd and needs a regular file; refuse here, while the slot is open.
		assert.match(localChecks({ ...envelope, artifact_path: "report.md" }, context).join(";"), /must be absolute/);
		const dir = join(home.path, "report-dir");
		mkdirSync(dir);
		assert.match(localChecks({ ...envelope, artifact_path: dir }, context).join(";"), /not a regular file/);

		// A predeclared path is the only acceptable path.
		assert.match(
			localChecks(envelope, { ...context, artifactPath: "/elsewhere/report.md" }).join(";"),
			/must be the predeclared path/,
		);

		// Research must leave the tree clean.
		repo.write("stray.txt", "oops");
		assert.match(localChecks(envelope, context).join(";"), /leave the tree clean/);

		// Blocked reports skip the checks: they exist to explain failure.
		assert.deepEqual(localChecks({ ...envelope, status: "blocked", blockers: ["x"] }, context), []);
	} finally {
		repo.cleanup();
		home.cleanup();
	}
});

test("headShaErrors: ship/done needs the worktree HEAD; others untouched", () => {
	const a = "a".repeat(40);
	const b = "b".repeat(40);
	let calls = 0;
	const observe = (result: { sha: string } | { error: string } = { sha: a }) => () => {
		calls += 1;
		return result;
	};
	const ship: Envelope = { job_id: "cp-ship9", kind: "ship", status: "done", summary: "s", branch: "cp-ship9" };
	const research: Envelope = { job_id: "cp-res1", kind: "research", status: "done", summary: "s" };

	const missing = headShaErrors(ship, "/leases/1/repo", observe());
	assert.equal(missing.length, 1);
	assert.ok(missing[0]?.includes(a));

	const mismatch = headShaErrors({ ...ship, head_sha: b }, "/leases/1/repo", observe());
	assert.equal(mismatch.length, 1);
	assert.ok(mismatch[0]?.includes(a) && mismatch[0].includes(b) && mismatch[0].includes("/leases/1/repo"));

	assert.deepEqual(headShaErrors({ ...ship, head_sha: a }, "/leases/1/repo", observe()), []);

	calls = 0;
	assert.deepEqual(headShaErrors(research, "/leases/1/repo", observe()), []);
	assert.deepEqual(headShaErrors({ ...ship, status: "blocked", head_sha: b }, "/leases/1/repo", observe()), []);
	assert.equal(calls, 0, "no git call when there is nothing to check");

	assert.equal(headShaErrors({ ...research, head_sha: b }, "/leases/1/repo", observe()).length, 1);

	const failed = headShaErrors(ship, "/leases/1/repo", observe({ error: "fatal: not a git repository" }));
	assert.equal(failed.length, 1);
	assert.match(failed[0] ?? "", /cannot verify.*fatal: not a git repository/);
});

test("localChecks compares a ship report against the real worktree HEAD", () => {
	const repo = createScratchRepo({ name: "head-check", withRemote: false });
	try {
		const context = {
			job_id: "cp-ship9",
			kind: "ship" as const,
			delivery: "local" as const,
			role: "implementer" as const,
			runDir: "/tmp/run",
			worktree: repo.path,
			mayAskOperator: false,
		};
		const ship: Envelope = { job_id: "cp-ship9", kind: "ship", status: "done", summary: "s", branch: "cp-ship9" };
		assert.deepEqual(localChecks({ ...ship, head_sha: repo.head() }, context), []);
		assert.match(localChecks({ ...ship, head_sha: "0".repeat(40) }, context).join(";"), /is not HEAD of your worktree/);
		assert.match(localChecks(ship, context).join(";"), /head_sha: required/);
		assert.match(localChecks(ship, { ...context, worktree: join(repo.path, "no-such-dir") }).join(";"), /cannot verify/);
	} finally {
		repo.cleanup();
	}
});

test("cp-u3o4: an answer over the bound is refused repairably; at the bound it is accepted", () => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "answer", withRemote: false });
	try {
		const artifact = join(home.path, "answer.md");
		const context = {
			job_id: "cp-q1",
			kind: "research" as const,
			delivery: "answer" as const,
			role: "planner" as const,
			runDir: join(home.path, "run"),
			worktree: repo.path,
			mayAskOperator: false,
		};
		const envelope: Envelope = {
			job_id: "cp-q1",
			kind: "research",
			status: "done",
			summary: "it is in src/config.ts",
			artifact_path: artifact,
		};

		// Exactly at the bound is fine: the bound is a ceiling, not a target.
		writeFileSync(artifact, "x".repeat(ANSWER_MAX_BYTES));
		assert.deepEqual(localChecks(envelope, context), []);

		// One byte over is refused, and the refusal is something a worker can act
		// on: tighten it, or say the honest answer is a plan.
		writeFileSync(artifact, "x".repeat(ANSWER_MAX_BYTES + 1));
		const errors = localChecks(envelope, context).join(";");
		assert.match(errors, /answer bound/);
		assert.match(errors, /glanceable/);

		// And the bound is the Q&A delivery's alone: a research artifact of any
		// size is still a research artifact.
		assert.deepEqual(localChecks(envelope, { ...context, delivery: "pipeline" }), []);
	} finally {
		repo.cleanup();
		home.cleanup();
	}
});

test("report_verdict advertises a lenient item bound and keeps every other bound of the contract", () => {
	const base = {
		job_id: "cp-res7",
		verdict: "pass" as const,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
	};
	const lenient = (payload: unknown) => validate(LenientGateReviewSchema, payload).ok;

	// The whole point: pi validates `parameters` before execute() runs, so a
	// 450-char reason has to get past the schema to be clampable at all.
	assert.ok(!validate(GateReviewSchema, { ...base, reasons: ["x".repeat(GATE_REVIEW_ITEM_MAX + 1)] }).ok);
	assert.ok(lenient({ ...base, reasons: ["x".repeat(GATE_REVIEW_ITEM_MAX + 1)] }));
	assert.ok(lenient({ ...base, reasons: ["x".repeat(GATE_REVIEW_LENIENT_ITEM_MAX)] }));
	// Past the lenient bound it is an artifact body, not a long finding.
	assert.ok(!lenient({ ...base, reasons: ["x".repeat(GATE_REVIEW_LENIENT_ITEM_MAX + 1)] }));

	// Nothing else moved: revisions stays optional, and the item counts,
	// non-empty reasons and closed object of the contract all still hold.
	assert.ok(lenient({ ...base, reasons: ["fine"] }));
	assert.ok(!lenient({ ...base, reasons: [] }));
	assert.ok(!lenient({ ...base, reasons: [""] }));
	assert.ok(!lenient({ ...base, reasons: Array(GATE_REASONS_MAX_ITEMS + 1).fill("a") }));
	assert.ok(!lenient({ ...base, reasons: ["a"], surprise: true }));
});

test("clampVerdictItems hard-cuts over-long items to the strict cap and leaves the rest alone", () => {
	const long = `${"x".repeat(500)}TAIL`;
	const clamped = clampVerdictItems({
		job_id: "cp-res7",
		verdict: "revise",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: [long, "short"],
		revisions: ["y".repeat(GATE_REVIEW_ITEM_MAX + 1)],
	});
	assert.equal(clamped.clamped, true);
	const value = clamped.payload as { reasons: string[]; revisions: string[] };
	assert.equal(value.reasons[0]?.length, GATE_REVIEW_ITEM_MAX);
	assert.ok(value.reasons[0]?.endsWith("…"), "a cut item never reads as a finished sentence");
	assert.equal(value.reasons[1], "short", "an item under the cap is untouched");
	assert.equal(value.revisions[0]?.length, GATE_REVIEW_ITEM_MAX);
	assert.ok(validate(GateReviewSchema, clamped.payload).ok, "the clamped payload satisfies the strict contract");

	// Exactly at the cap is not over it, and an unchanged payload is handed back
	// as-is so nothing downstream writes a raw copy of a verdict it never touched.
	const atCap = {
		job_id: "cp-res7",
		verdict: "pass",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["z".repeat(GATE_REVIEW_ITEM_MAX)],
	};
	const untouched = clampVerdictItems(atCap);
	assert.equal(untouched.clamped, false);
	assert.equal(untouched.payload, atCap);
	assert.deepEqual(clampVerdictItems("not an object"), { payload: "not an object", clamped: false });
});

// ---------------------------------------------------------------------------
// integration: kept because no dispatched worker is ever offered a parent-only tool
// ---------------------------------------------------------------------------

test("recursion guard: parent-only tools are blocked inside a worker", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "guard", withRemote: false });
	const home = createScratchHome();
	const runDir = join(home.path, paths.runDir("cp-guard1"));
	mkdirSync(runDir, { recursive: true });
	// A hostile/naive extension that hands the worker a dispatch tool.
	repo.write(
		"fake-dispatch.ts",
		`import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "cp_dispatch",
		label: "Dispatch",
		description: "Dispatch a worker",
		parameters: Type.Object({ job_id: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: "DISPATCHED" }], details: {} };
		},
	}));
}
`,
	);
	const model = provider.addScript("guard", [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: "cp-other" } }] },
		{ kind: "text", text: "I cannot dispatch." },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["report_result", "cp_dispatch"],
		extensions: [WORKER_REPORTER_EXTENSION, join(repo.path, "fake-dispatch.ts")],
		env: {
			...agentDir.env,
			CP_JOB_ID: "cp-guard1",
			CP_KIND: "ship",
			CP_DELIVERY: "local",
			CP_RUN_DIR: runDir,
			CP_WORKTREE: repo.path,
			CP_ROLE: "implementer",
		},
		extraArgs: ["--no-context-files", "--no-session"],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	const blocked: string[] = [];
	worker.onEvent((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "cp_dispatch") {
			blocked.push(JSON.stringify(event.result));
		}
	});

	await worker.getState(30_000);
	await worker.prompt("dispatch a helper");
	await worker.waitForSettled(60_000);

	assert.equal(blocked.length, 1);
	assert.ok(!blocked[0]?.includes("DISPATCHED"), "the dispatch tool must never execute");
	assert.match(blocked[0] ?? "", /parent-only tool/);
});

