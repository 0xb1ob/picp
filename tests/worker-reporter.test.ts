/**
 * T5 acceptance: a worker session produces a valid envelope file; invalid
 * shapes are repaired within the cap or surfaced as a failure.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
	ENVELOPE_FILE,
	findEditMatchLines,
	formatRejection,
	GATE_REVIEW_ITEM_MAX,
	GATE_REVIEW_LENIENT_ITEM_MAX,
	LenientGateReviewSchema,
	loadJobContext,
	localChecks,
	REJECTION_FILE,
	VERDICT_FILE,
	VERDICT_RAW_FILE,
	VERDICT_REJECTION_FILE,
} from "../extensions/worker-reporter/index.ts";
import workerReporter from "../extensions/worker-reporter/index.ts";
import { headShaErrors } from "../extensions/worker-reporter/head.ts";
import {
	ANSWER_MAX_BYTES,
	ENVELOPE_REPAIR_MAX_ATTEMPTS,
	MINIMAL_PLAN_SUMMARY,
	type Envelope,
	type EnvelopeRecord,
	GATE_REASONS_MAX_ITEMS,
	GateReviewSchema,
	paths,
	validate,
	type VerdictRecord,
	VerdictRecordSchema,
} from "../src/contracts.ts";
import { type WorkerDialogAnswer, type WorkerDialogRequest, WorkerProcess } from "../src/worker-process.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	type RecordedRequest,
	type ScratchRepo,
	type ScriptStep,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";
import { mkdirSync } from "node:fs";

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
	assert.match(stale?.text ?? "", /cause: stale_anchor — .*Call read/);
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

test("credential guards are blocked at tool_call (N1, N2)", () => {
	const handlers = stubbedHandlers();
	const call = (command: string) =>
		handlers.tool_call?.({ toolName: "bash", input: { command } }) as { block: true; reason: string } | undefined;
	const copy = call('cp -a ~/.pi-command-post/state ~/.pi-command-post/data "$T/.pi-command-post/"');
	assert.equal(copy?.block, true);
	assert.match(copy?.reason ?? "", /never bulk-copies/);
	const auth = call("gh auth status 2>&1");
	assert.equal(auth?.block, true);
	assert.match(auth?.reason ?? "", /gh api user --jq \.login/);
	assert.equal(call("cp ~/.pi/agent/models.json /tmp/a/models.json"), undefined);
	assert.equal(call("cp -a ~/.pi-command-post/state/runs/cp-xlax /tmp/a/"), undefined);
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
// integration: real worker sessions
// ---------------------------------------------------------------------------

interface WorkerFixture {
	provider: MockProvider;
	worker: WorkerProcess;
	runDir: string;
	cleanup: () => Promise<void>;
}

async function startReporterWorker(
	scriptName: string,
	steps: ScriptStep[],
	job: {
		jobId: string;
		kind: "ship" | "research";
		delivery: "pr" | "local" | "pipeline" | "answer";
		role?: "planner" | "implementer" | "gate-reviewer";
		artifactPath?: string;
		/** A pre-made scratch repo (so the report can name its real HEAD); cleaned up with the fixture. */
		repo?: ScratchRepo;
		onDialog?: (request: WorkerDialogRequest) => Promise<WorkerDialogAnswer>;
	},
): Promise<WorkerFixture> {
	const provider = await MockProvider.start();
	const repo = job.repo ?? createScratchRepo({ name: scriptName, withRemote: false });
	const home = createScratchHome();
	const runDir = join(home.path, paths.runDir(job.jobId));
	mkdirSync(runDir, { recursive: true });
	const model = provider.addScript(scriptName, steps);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: [job.role === "gate-reviewer" ? "report_verdict" : "report_result", "read", "write"],
		extensions: [WORKER_REPORTER_EXTENSION],
		env: {
			...agentDir.env,
			CP_JOB_ID: job.jobId,
			CP_KIND: job.kind,
			CP_DELIVERY: job.delivery,
			CP_RUN_DIR: runDir,
			CP_WORKTREE: repo.path,
			CP_ROLE: job.role ?? (job.kind === "ship" ? "implementer" : "planner"),
			...(job.artifactPath ? { CP_ARTIFACT_PATH: job.artifactPath } : {}),
		},
		extraArgs: ["--no-context-files", "--no-session"],
		...(job.onDialog ? { onDialog: job.onDialog } : {}),
	});
	return {
		provider,
		worker,
		runDir,
		cleanup: async () => {
			await worker.shutdown();
			agentDir.cleanup();
			repo.cleanup();
			home.cleanup();
			await provider.stop();
		},
	};
}

function reportCall(args: unknown | ((request: RecordedRequest) => unknown), text?: string): ScriptStep {
	return { kind: "tool_calls", calls: [{ name: "report_result", args }], ...(text ? { text } : {}) };
}

const VALID_SHIP: Envelope = {
	job_id: "cp-ship9",
	kind: "ship",
	status: "done",
	summary: "Implemented the ladder; suite green.",
	branch: "cp-ship9",
	pr_url: "https://github.com/org/repo/pull/9",
};

test("a worker session produces a valid envelope file", { timeout: 90_000 }, async (t) => {
	const repo = createScratchRepo({ name: "report-ok", withRemote: false });
	const shipped = { ...VALID_SHIP, head_sha: repo.head() };
	const fixture = await startReporterWorker("report-ok", [reportCall(shipped)], {
		jobId: "cp-ship9",
		kind: "ship",
		delivery: "pr",
		repo,
	});
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(60_000);

	const record = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.deepEqual(record.envelope, shipped);
	assert.equal(record.job_id, "cp-ship9");
	assert.equal(record.attempt, 1);
	assert.match(record.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	assert.ok(!existsSync(join(fixture.runDir, REJECTION_FILE)));

	// terminate: true — the run ends on the tool call, no extra provider turn.
	assert.equal(fixture.provider.requests("report-ok").length, 1);
});

test("a head_sha that is not worktree HEAD is repaired in-run", { timeout: 90_000 }, async (t) => {
	const repo = createScratchRepo({ name: "report-head", withRemote: false });
	const shipped = { ...VALID_SHIP, head_sha: repo.head() };
	const fixture = await startReporterWorker(
		"report-head",
		[reportCall({ ...VALID_SHIP, head_sha: "f".repeat(40) }), reportCall(shipped)],
		{ jobId: "cp-ship9", kind: "ship", delivery: "pr", repo },
	);
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(60_000);

	const record = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.deepEqual(record.envelope, shipped);
	assert.equal(record.attempt, 2, "attempt 2 is the one filed");
	const repair = JSON.stringify(fixture.provider.requests("report-head")[1]?.body.messages ?? []);
	assert.match(repair, /is not HEAD of your worktree/);
	assert.ok(repair.includes(repo.head()), "the repair prompt names the observed sha");
});

test("an invalid envelope is repaired within the cap", { timeout: 90_000 }, async (t) => {
	const repo = createScratchRepo({ name: "report-repair", withRemote: false });
	const shipped = { ...VALID_SHIP, head_sha: repo.head() };
	const fixture = await startReporterWorker(
		"report-repair",
		[
			// Wrong job + a body-shaped summary: two contract violations at once.
			reportCall({
				job_id: "cp-other",
				kind: "ship",
				status: "done",
				summary: "# Findings\n```\nlots of body\n```",
				branch: "cp-ship9",
				pr_url: "https://github.com/org/repo/pull/9",
			}),
			reportCall(shipped),
		],
		{ jobId: "cp-ship9", kind: "ship", delivery: "pr", repo },
	);
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(60_000);

	const record = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.deepEqual(record.envelope, shipped);
	assert.equal(record.attempt, 2, "the repair attempt is recorded");
	assert.ok(!existsSync(join(fixture.runDir, REJECTION_FILE)));
	assert.equal(fixture.provider.requests("report-repair").length, 2);
});

const PLANNER_BLOCKER = {
	question: "Which store?",
	why: "Schema depends on it.",
	options: ["Postgres", "SQLite"],
	recommended: "SQLite",
	assume_if_unanswered: "SQLite",
};

test("a body-shaped planner blocker is rejected with the repair prompt", { timeout: 90_000 }, async (t) => {
	const valid = {
		job_id: "cp-plan1",
		kind: "research",
		status: "blocked",
		summary: "Need a store decision.",
		blockers: [PLANNER_BLOCKER],
	};
	const fixture = await startReporterWorker(
		"planner-blocker-repair",
		[
			reportCall({
				...valid,
				blockers: [{ ...PLANNER_BLOCKER, why: "# Findings\n```\nthe body\n```" }],
			}),
			reportCall(valid),
		],
		{ jobId: "cp-plan1", kind: "research", delivery: "pipeline", role: "planner" },
	);
	t.after(fixture.cleanup);
	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(60_000);

	const repair = JSON.stringify(fixture.provider.requests("planner-blocker-repair")[1]?.body.messages ?? []);
	assert.match(repair, /report_result rejected \(attempt 1\)/);
	assert.match(repair, /body belongs in the artifact/);
	assert.match(repair, /Fix exactly these points and call report_result again/);
	const record = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.equal(record.envelope.status, "blocked");
	assert.equal(record.attempt, 2);
});

test("repair is bounded: past the cap the job fails as envelope_invalid", { timeout: 120_000 }, async (t) => {
	const bad = {
		job_id: "cp-ship9",
		kind: "ship",
		status: "done",
		summary: "shipped",
		// no branch, and delivery:pr without a pr_url
	};
	const steps: ScriptStep[] = Array.from({ length: ENVELOPE_REPAIR_MAX_ATTEMPTS }, () => reportCall(bad));
	const fixture = await startReporterWorker("report-cap", steps, {
		jobId: "cp-ship9",
		kind: "ship",
		delivery: "pr",
	});
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(90_000);

	assert.ok(!existsSync(join(fixture.runDir, ENVELOPE_FILE)), "no envelope may be recorded");
	const rejection = JSON.parse(readFileSync(join(fixture.runDir, REJECTION_FILE), "utf8")) as {
		attempts: number;
		errors: string[];
	};
	assert.equal(rejection.attempts, ENVELOPE_REPAIR_MAX_ATTEMPTS);
	assert.ok(rejection.errors.some((error) => error.startsWith("branch:")));
	assert.ok(rejection.errors.some((error) => error.startsWith("pr_url:")));
	assert.equal(fixture.provider.requests("report-cap").length, ENVELOPE_REPAIR_MAX_ATTEMPTS);
});

test("blocked reports are first-class", { timeout: 90_000 }, async (t) => {
	const blocked: Envelope = {
		job_id: "cp-res5",
		kind: "research",
		status: "blocked",
		summary: "Cannot proceed: the fixture repo has no test runner.",
		blockers: [
			{
				question: "Which test runner?",
				why: "The plan cannot name a command without it.",
				options: ["node --test", "none"],
				recommended: "node --test",
				assume_if_unanswered: "node --test",
			},
		],
	};
	const fixture = await startReporterWorker("report-blocked", [reportCall(blocked)], {
		jobId: "cp-res5",
		kind: "research",
		delivery: "pipeline",
	});
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("investigate");
	await fixture.worker.waitForSettled(60_000);

	const record = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.equal(record.envelope.status, "blocked");
	assert.deepEqual(record.envelope.blockers, blocked.blockers);
});

test("re-reporting is idempotent, and contradicting a report is refused", { timeout: 120_000 }, async (t) => {
	const repo = createScratchRepo({ name: "report-twice", withRemote: false });
	const shipped = { ...VALID_SHIP, head_sha: repo.head() };
	const fixture = await startReporterWorker(
		"report-twice",
		[
			reportCall(shipped),
			reportCall(shipped),
			reportCall({ ...shipped, pr_url: "https://github.com/org/repo/pull/10" }),
			{ kind: "text", text: "I will stop." },
		],
		{ jobId: "cp-ship9", kind: "ship", delivery: "pr", repo },
	);
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(60_000);
	const first = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;

	await fixture.worker.prompt("report again, identically");
	await fixture.worker.waitForSettled(60_000);
	const second = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.deepEqual(second, first, "identical re-report is a no-op");

	await fixture.worker.prompt("now change the PR url");
	await fixture.worker.waitForSettled(60_000);
	const third = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.deepEqual(third, first, "a contradicting report never overwrites the record");
});

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

test("web egress guard: a web call carrying command-post state is refused, a clean one runs (cp-if9x)", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "webguard", withRemote: false });
	const home = createScratchHome();
	const runDir = join(home.path, paths.runDir("cp-web1"));
	mkdirSync(runDir, { recursive: true });
	// Stands in for pi-web-access: a web_search tool whose body says it ran.
	repo.write(
		"fake-web.ts",
		`import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "web_search",
		label: "Web search",
		description: "Search the web",
		parameters: Type.Object({ query: Type.Optional(Type.String()), queries: Type.Optional(Type.Array(Type.String())) }),
		async execute() {
			return { content: [{ type: "text", text: "SEARCHED" }], details: {} };
		},
	}));
}
`,
	);
	const model = provider.addScript("webguard", [
		{ kind: "tool_calls", calls: [{ name: "web_search", args: { query: "/srv/cp/.pi-command-post/state/x" } }] },
		{ kind: "tool_calls", calls: [{ name: "web_search", args: { query: "node --test-force-exit" } }] },
		{ kind: "text", text: "Done searching." },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["report_result", "web_search"],
		extensions: [WORKER_REPORTER_EXTENSION, join(repo.path, "fake-web.ts")],
		env: {
			...agentDir.env,
			CP_JOB_ID: "cp-web1",
			CP_KIND: "research",
			CP_DELIVERY: "local",
			CP_RUN_DIR: runDir,
			CP_WORKTREE: repo.path,
			CP_ROLE: "planner",
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

	const ends: string[] = [];
	worker.onEvent((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "web_search") ends.push(JSON.stringify(event.result));
	});

	await worker.getState(30_000);
	await worker.prompt("look something up");
	await worker.waitForSettled(60_000);

	assert.equal(ends.length, 2);
	assert.ok(!ends[0]?.includes("SEARCHED"), "the refused web call must never execute");
	assert.match(ends[0] ?? "", /command-post state never leaves the host|\.pi-command-post/);
	assert.ok(ends[1]?.includes("SEARCHED"), "a clean web call runs");
});

test("CI-wait guard: a sleep-then-poll bash call is refused, a real command is not (cp-kzc)", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "ciwait", withRemote: false });
	const home = createScratchHome();
	const runDir = join(home.path, paths.runDir("cp-ciwait"));
	mkdirSync(runDir, { recursive: true });
	// The shape caught live: 4m30s asleep in a tool call, waiting on GitHub for a
	// fact the parent re-checks itself. If the guard were absent this call would
	// run and the test would time out instead of asserting — which is the point.
	const model = provider.addScript("ciwait", [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "bash",
					args: {
						command: "sleep 300; gh run list --branch cp-ciwait --limit 3 --json conclusion,status,headSha",
					},
				},
			],
		},
		// A legitimate command in the same session still runs: the guard is about
		// one shape, not about bash.
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo LEGIT-RAN" } }] },
		{ kind: "text", text: "I will report the pushed head sha instead." },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["report_result", "bash"],
		extensions: [WORKER_REPORTER_EXTENSION],
		env: {
			...agentDir.env,
			CP_JOB_ID: "cp-ciwait",
			CP_KIND: "ship",
			CP_DELIVERY: "pr",
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

	const results: string[] = [];
	worker.onEvent((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "bash") {
			results.push(JSON.stringify(event.result));
		}
	});

	await worker.getState(30_000);
	await worker.prompt("push and confirm CI is green");
	await worker.waitForSettled(60_000);

	assert.equal(results.length, 2);
	assert.match(results[0] ?? "", /Refused/);
	assert.match(results[0] ?? "", /head_sha/);
	assert.ok(!/"conclusion"/.test(results[0] ?? ""), "the poll must never reach GitHub");
	assert.match(results[1] ?? "", /LEGIT-RAN/, "an ordinary bash call still runs");
});

test("N2: bash token output is redacted before the session JSONL and the model see it", { timeout: 90_000 }, async (t) => {
	// Synthetic values only, built at runtime and passed through env: the bash call echoes them.
	const fakePat = ["github", "pat", "Q".repeat(22), "r".repeat(59)].join("_");
	const fakeClassic = `${"gh"}${"p_"}${"Z".repeat(36)}`;
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "redact", withRemote: false });
	const home = createScratchHome();
	const runDir = join(home.path, paths.runDir("cp-redact"));
	mkdirSync(runDir, { recursive: true });
	const sessionDir = join(home.path, "sessions");
	const model = provider.addScript("redact", [
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: 'echo "Token: $CP_TEST_FAKE_PAT"; echo "classic=$CP_TEST_FAKE_CLASSIC"' } }],
		},
		{ kind: "text", text: "done" },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["report_result", "bash"],
		extensions: [WORKER_REPORTER_EXTENSION],
		sessionDir,
		env: {
			...agentDir.env,
			CP_JOB_ID: "cp-redact",
			CP_KIND: "ship",
			CP_DELIVERY: "pr",
			CP_RUN_DIR: runDir,
			CP_WORKTREE: repo.path,
			CP_ROLE: "implementer",
			CP_TEST_FAKE_PAT: fakePat,
			CP_TEST_FAKE_CLASSIC: fakeClassic,
		},
		extraArgs: ["--no-context-files"],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	// tool_execution_update is deliberately not asserted: its streamed partialResult is
	// pre-hook bash output, the documented gap (docs/storage.md Known gaps).
	const ends: string[] = [];
	worker.onEvent((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "bash") ends.push(JSON.stringify(event.result));
	});

	await worker.getState(30_000);
	await worker.prompt("print the token");
	await worker.waitForSettled(60_000);

	const clean = (text: string, what: string) => {
		assert.ok(text.includes("[REDACTED]"), `${what} carries [REDACTED]`);
		assert.ok(!text.includes(fakePat) && !text.includes(fakeClassic), `${what} carries no fake token`);
	};
	assert.equal(ends.length, 1);
	clean(ends[0] ?? "", "tool_execution_end");
	const sessions = (readdirSync(sessionDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
	assert.ok(sessions.length > 0, "a session transcript was written");
	for (const file of sessions) clean(readFileSync(join(sessionDir, file), "utf8"), file);
	assert.equal(provider.requests("redact").length, 2);
	clean(JSON.stringify(provider.requests("redact")[1]?.body.messages ?? null), "the next model request");
	assert.equal(provider.remaining("redact"), 0);
});

// ---------------------------------------------------------------------------
// gate-reviewer: report_verdict
// ---------------------------------------------------------------------------

const VALID_VERDICT = {
	job_id: "cp-res7",
	verdict: "pass" as const,
	flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
	reasons: ["File list names every path in Evidence", "Test plan runs as written"],
};

function verdictCall(args: unknown): ScriptStep {
	return { kind: "tool_calls", calls: [{ name: "report_verdict", args }] };
}

test("a gate-reviewer session produces a schema-valid verdict file", { timeout: 90_000 }, async (t) => {
	const fixture = await startReporterWorker("verdict-ok", [verdictCall(VALID_VERDICT)], {
		jobId: "cp-res7",
		kind: "research",
		delivery: "pipeline",
		role: "gate-reviewer",
	});
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("review the artifact");
	await fixture.worker.waitForSettled(60_000);

	const record = JSON.parse(readFileSync(join(fixture.runDir, VERDICT_FILE), "utf8")) as VerdictRecord;
	assert.deepEqual(record.review, VALID_VERDICT);
	assert.equal(record.job_id, "cp-res7");
	assert.equal(record.attempt, 1);
	const validation = validate<VerdictRecord>(VerdictRecordSchema, record);
	assert.ok(validation.ok, validation.ok ? "" : validation.errors.join("; "));
	assert.ok(!existsSync(join(fixture.runDir, ENVELOPE_FILE)), "a reviewer never writes a job envelope");
	assert.ok(!existsSync(join(fixture.runDir, VERDICT_RAW_FILE)), "nothing was clamped, so there is no raw copy");
	assert.equal(fixture.provider.requests("verdict-ok").length, 1, "terminate ends the review");
});

test(
	"an over-long reason is clamped and recorded, not rejected — and the original survives",
	{ timeout: 90_000 },
	async (t) => {
	// 450 chars of reason and 401 of revision: complete findings that used to cost
	// a whole extra reviewer turn because pi refused the call before execute() ran.
	const reason = `${"r".repeat(449)}Z`;
	const revision = `${"v".repeat(400)}Z`;
	const fixture = await startReporterWorker(
		"verdict-clamp",
		[
			verdictCall({
				...VALID_VERDICT,
				verdict: "revise",
				reasons: [reason, "Test plan runs as written"],
				revisions: [revision],
			}),
		],
		{ jobId: "cp-res7", kind: "research", delivery: "pipeline", role: "gate-reviewer" },
	);
	t.after(fixture.cleanup);

	const results: string[] = [];
	fixture.worker.onEvent((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "report_verdict") {
			results.push(JSON.stringify(event.result));
		}
	});

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("review the artifact");
	await fixture.worker.waitForSettled(60_000);

	// Accepted on the first attempt: no repair turn, no rejection file.
	const record = JSON.parse(readFileSync(join(fixture.runDir, VERDICT_FILE), "utf8")) as VerdictRecord;
	assert.equal(record.attempt, 1);
	assert.equal(fixture.provider.requests("verdict-clamp").length, 1);
	assert.ok(!existsSync(join(fixture.runDir, VERDICT_REJECTION_FILE)));
	const validation = validate<VerdictRecord>(VerdictRecordSchema, record);
	assert.ok(validation.ok, validation.ok ? "" : validation.errors.join("; "));

	// The record holds the clamped items; the reviewer's own words are next to it.
	assert.equal(record.review.reasons[0]?.length, GATE_REVIEW_ITEM_MAX);
	assert.ok(record.review.reasons[0]?.endsWith("…"));
	assert.equal(record.review.reasons[1], "Test plan runs as written");
	assert.equal(record.review.revisions?.[0]?.length, GATE_REVIEW_ITEM_MAX);
	const raw = JSON.parse(readFileSync(join(fixture.runDir, VERDICT_RAW_FILE), "utf8")) as {
		reasons: string[];
		revisions: string[];
	};
	assert.equal(raw.reasons[0], reason, "the unabridged reason is recoverable in full");
	assert.equal(raw.revisions[0], revision);

	// And the worker is told, so it does not read the record back and re-report.
	assert.match(results[0] ?? "", /clamp|cut to/i);
	assert.ok((results[0] ?? "").includes(VERDICT_RAW_FILE), "the success text names the raw copy");
	},
);

test("a malformed verdict is repaired in-run, without re-reading the artifact", { timeout: 90_000 }, async (t) => {
	const fixture = await startReporterWorker(
		"verdict-repair",
		[
			// revise with no revisions, and the wrong job id: both are contract breaks
			verdictCall({
				job_id: "cp-other",
				verdict: "revise",
				flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
				reasons: ["file list is thin"],
			}),
			verdictCall({
				...VALID_VERDICT,
				verdict: "revise",
				reasons: ["File list omits db/migrations paths named in Evidence"],
				revisions: ["List the exact files under db/migrations the plan touches"],
			}),
		],
		{ jobId: "cp-res7", kind: "research", delivery: "pipeline", role: "gate-reviewer" },
	);
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("review the artifact");
	await fixture.worker.waitForSettled(60_000);

	const record = JSON.parse(readFileSync(join(fixture.runDir, VERDICT_FILE), "utf8")) as VerdictRecord;
	assert.equal(record.review.verdict, "revise");
	assert.equal(record.review.job_id, "cp-res7");
	assert.deepEqual(record.review.revisions, ["List the exact files under db/migrations the plan touches"]);
	assert.equal(record.attempt, 2, "the repair happened in the same run");
	assert.ok(!existsSync(join(fixture.runDir, VERDICT_REJECTION_FILE)));
	// Two provider turns, one worker, one artifact read: the point of the design.
	assert.equal(fixture.provider.requests("verdict-repair").length, 2);
});

test("verdict repair is bounded, and exhaustion is visible to the parent", { timeout: 120_000 }, async (t) => {
	// NOTE: pi validates tool args against the schema before execute() runs, so a
	// shape error (e.g. empty reasons) never reaches our loop. Our bounded repair
	// covers CROSS-FIELD policy — here: revisions on a non-revise verdict.
	const bad = {
		job_id: "cp-res7",
		verdict: "pass",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["looks fine"],
		revisions: ["you cannot revise on a pass"],
	};
	const steps: ScriptStep[] = Array.from({ length: ENVELOPE_REPAIR_MAX_ATTEMPTS }, () => verdictCall(bad));
	const fixture = await startReporterWorker("verdict-cap", steps, {
		jobId: "cp-res7",
		kind: "research",
		delivery: "pipeline",
		role: "gate-reviewer",
	});
	t.after(fixture.cleanup);

	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("review the artifact");
	await fixture.worker.waitForSettled(90_000);

	assert.ok(!existsSync(join(fixture.runDir, VERDICT_FILE)), "no verdict may be recorded");
	const rejection = JSON.parse(readFileSync(join(fixture.runDir, VERDICT_REJECTION_FILE), "utf8")) as {
		attempts: number;
		errors: string[];
	};
	assert.equal(rejection.attempts, ENVELOPE_REPAIR_MAX_ATTEMPTS);
	assert.ok(rejection.errors.some((error) => error.startsWith("revisions:")));
	// This is what the parent classifies as cause: operational (T20).
	assert.equal(fixture.provider.requests("verdict-cap").length, ENVELOPE_REPAIR_MAX_ATTEMPTS);
});

// ---------------------------------------------------------------------------
// plan envelope files immediately; oversize plan_summary is repaired
// ---------------------------------------------------------------------------

const VALID_PLAN = (artifactPath: string): Envelope => ({
	job_id: "cp-plan1",
	kind: "research",
	status: "done",
	summary: "Plan written; cache in redis.",
	artifact_path: artifactPath,
	plan_summary: MINIMAL_PLAN_SUMMARY,
	self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false },
});

test("a planner envelope files without a console hold", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const artifact = join(home.path, "report.md");
	writeFileSync(artifact, "# Goal\nCache.\n");
	let asked = 0;
	const fixture = await startReporterWorker("plan-files", [reportCall(VALID_PLAN(artifact))], {
		jobId: "cp-plan1",
		kind: "research",
		delivery: "pipeline",
		role: "planner",
		artifactPath: artifact,
		onDialog: async () => {
			asked += 1;
			return { cancelled: true };
		},
	});
	t.after(async () => {
		await fixture.cleanup();
		home.cleanup();
	});
	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("plan");
	await fixture.worker.waitForSettled(60_000);
	assert.equal(asked, 0, "report_result does not open a console review");
	assert.ok(existsSync(join(fixture.runDir, ENVELOPE_FILE)));
	assert.ok(!existsSync(join(fixture.runDir, REJECTION_FILE)));
});

test("an oversize plan_summary is repaired, then filed", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const artifact = join(home.path, "report.md");
	writeFileSync(artifact, "# Goal\nCache.\n");
	const fat = { ...VALID_PLAN(artifact), plan_summary: { ...MINIMAL_PLAN_SUMMARY, goal: "word ".repeat(40).trim() } };
	const fixture = await startReporterWorker(
		"plan-repair",
		[reportCall(fat), reportCall(VALID_PLAN(artifact))],
		{
			jobId: "cp-plan1",
			kind: "research",
			delivery: "pipeline",
			role: "planner",
			artifactPath: artifact,
		},
	);
	t.after(async () => {
		await fixture.cleanup();
		home.cleanup();
	});
	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("plan");
	await fixture.worker.waitForSettled(90_000);
	const record = JSON.parse(readFileSync(join(fixture.runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord;
	assert.equal(record.envelope.plan_summary?.goal, MINIMAL_PLAN_SUMMARY.goal);
	assert.equal(record.attempt, 2);
	assert.equal(fixture.provider.requests("plan-repair").length, 2);
});

test("review: an answer job never asks for review", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "review-answer", withRemote: false });
	t.after(() => {
		home.cleanup();
		repo.cleanup();
	});
	const artifact = join(home.path, "answer.md");
	writeFileSync(artifact, "x".repeat(10));
	const answer: Envelope = {
		job_id: "cp-q1",
		kind: "research",
		status: "done",
		summary: "it is in src/config.ts",
		artifact_path: artifact,
	};
	let asked = 0;
	const fixture = await startReporterWorker("review-answer", [reportCall(answer)], {
		jobId: "cp-q1",
		kind: "research",
		delivery: "answer",
		role: "planner",
		artifactPath: artifact,
		onDialog: async () => {
			asked += 1;
			return { cancelled: true };
		},
	});
	t.after(fixture.cleanup);
	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("answer");
	await fixture.worker.waitForSettled(60_000);
	assert.equal(asked, 0);
	assert.ok(existsSync(join(fixture.runDir, ENVELOPE_FILE)));
});

test("review: an implementer never asks for review", { timeout: 90_000 }, async (t) => {
	let asked = 0;
	const repo = createScratchRepo({ name: "review-skip", withRemote: false });
	const fixture = await startReporterWorker("review-skip", [reportCall({ ...VALID_SHIP, head_sha: repo.head() })], {
		jobId: "cp-ship9",
		kind: "ship",
		delivery: "pr",
		repo,
		onDialog: async () => {
			asked += 1;
			return { cancelled: true };
		},
	});
	t.after(fixture.cleanup);
	await fixture.worker.getState(30_000);
	await fixture.worker.prompt("do the job");
	await fixture.worker.waitForSettled(60_000);
	assert.equal(asked, 0);
	assert.ok(existsSync(join(fixture.runDir, ENVELOPE_FILE)));
});

test("exactly one terminating tool per role", { timeout: 90_000 }, async (t) => {
	// The tool schemas a worker advertises to the provider ARE its capabilities:
	// what is not offered cannot be called.
	const reviewer = await startReporterWorker("role-reviewer", [{ kind: "text", text: "reviewing" }], {
		jobId: "cp-res7",
		kind: "research",
		delivery: "pipeline",
		role: "gate-reviewer",
	});
	t.after(reviewer.cleanup);
	await reviewer.worker.getState(30_000);
	await reviewer.worker.prompt("what can you do?");
	await reviewer.worker.waitForSettled(60_000);
	const reviewerTools = (reviewer.provider.requests("role-reviewer")[0]?.body.tools ?? []).map((tool) =>
		JSON.stringify(tool),
	);
	assert.ok(reviewerTools.some((tool) => tool.includes("report_verdict")), "reviewer sees report_verdict");
	assert.ok(!reviewerTools.some((tool) => tool.includes("report_result")), "reviewer never sees report_result");

	// s64: `maxLength: 400` and the revise-only rule were expressed only in the
	// schema, and pi rejects an overlong reason before the repair path here can
	// run — 56 of 141 report_verdict calls over two days paid an extra turn for
	// it. The bounds must be in the prose the model actually reads, so assert on
	// `description` and not on the stringified tool: `maxLength: 400` would match
	// there whether or not anyone ever wrote the sentence.
	interface ReviewerToolSpec {
		function?: { name?: string; description?: string };
		name?: string;
		description?: string;
	}
	const verdictSpec = ((reviewer.provider.requests("role-reviewer")[0]?.body.tools ?? []) as ReviewerToolSpec[]).find(
		(tool) => (tool.function?.name ?? tool.name) === "report_verdict",
	);
	const verdictDescription = verdictSpec?.function?.description ?? verdictSpec?.description ?? "";
	assert.match(verdictDescription, /400 characters/, "report_verdict description states the 400-character reason cap");
	assert.match(verdictDescription, /revisions.* only when the verdict is revise/);
	assert.ok(!existsSync(join(reviewer.runDir, ENVELOPE_FILE)));

	const implementer = await startReporterWorker("role-implementer", [{ kind: "text", text: "working" }], {
		jobId: "cp-ship9",
		kind: "ship",
		delivery: "pr",
		role: "implementer",
	});
	t.after(implementer.cleanup);
	await implementer.worker.getState(30_000);
	await implementer.worker.prompt("what can you do?");
	await implementer.worker.waitForSettled(60_000);
	const implementerTools = (implementer.provider.requests("role-implementer")[0]?.body.tools ?? []).map((tool) =>
		JSON.stringify(tool),
	);
	assert.ok(implementerTools.some((tool) => tool.includes("report_result")));
	assert.ok(!implementerTools.some((tool) => tool.includes("report_verdict")), "implementer never sees report_verdict");
	assert.ok(!existsSync(join(implementer.runDir, VERDICT_FILE)));
});
