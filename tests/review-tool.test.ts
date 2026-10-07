/**
 * cp-diffgate-cp-review-tool-l65 (Stage B2): the `cp_review` tool surface.
 *
 * Stage B1 made a diff review possible; this is what makes it invocable. The
 * suite is a smoke test in the style of `tests/extension-load.test.ts` and
 * `tests/guards.test.ts`: a real `pi --mode rpc` parent with the command-post
 * extension loaded and the scriptable mock provider as its model, so
 * "registered" means pi actually offered the tool to a model and actually ran
 * it — not that a regex found a string in a file.
 *
 * Four properties, each of which the design can lose while the code still
 * looks right:
 *
 *  1. `cp_review` exists as its own tool, beside `cp_gate` and not as a mode
 *     flag on it (design Constraints §6). Reviewing a plan and reviewing a
 *     diff are different questions asked at different pipeline stages.
 *  2. Its precondition is a dispatch record, not a pipeline record
 *     (Constraints §1) — an unknown job id is refused by the *dispatch* lookup,
 *     and the refusal names `cp_dispatch`.
 *  3. `details.verdict` round-trips through `validate<DiffVerdict>(
 *     DiffVerdictSchema, …)`, enforced in the payload itself rather than hoped
 *     for.
 *  4. Neither `content` nor `details` carries diff text, or the path to the
 *     file that holds it. Stage E's `diff_body_read` guard blocks the parent
 *     *reading* `review-<n>/`; a tool that hands the same bytes (or the path
 *     to them) over willingly would be the same hole with better manners.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type DiffVerdict,
	DiffVerdictSchema,
	isoTimestamp,
	paths,
	SCHEMA_VERSION,
	validate,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/contracts.ts";
import type { DiffReviewResult } from "../src/diff-review.ts";
import { diffReviewToolPayload } from "../extensions/command-post/index.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "./harness/index.ts";

// ---------------------------------------------------------------------------
// Wiring: a real pi parent, a real tool call
// ---------------------------------------------------------------------------

interface ToolSpec {
	function?: { name?: string; description?: string; parameters?: { properties?: Record<string, unknown> } };
	name?: string;
}

function toolNames(tools: readonly ToolSpec[] | undefined): string[] {
	return (tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "").filter((name) => name.length > 0);
}

test(
	"pi registers cp_review beside cp_gate, and an unknown job id is refused by the dispatch lookup",
	{ timeout: 120_000 },
	async (t) => {
		const home = createScratchHome();
		const provider = await MockProvider.start();
		const model = provider.addScript("review-tool-wiring", [
			{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: "cp-review-tool-unknown" } }] },
			{ kind: "text", text: "acknowledged" },
		]);
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: home.path,
			model,
			env: { ...agentDir.env, CP_HOME: home.path },
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
			home.cleanup();
		});

		await child.prompt("review the diff for cp-review-tool-unknown");
		await child.waitForSettled(60_000);

		// 1. Registration, as pi itself reports it to the model: both tools are on
		//    the wire, and they are two tools, not one with a mode.
		const offered = toolNames(provider.requests("review-tool-wiring")[0]?.body.tools as ToolSpec[] | undefined);
		assert.ok(offered.includes("cp_review"), `cp_review not offered to the model; got: ${offered.join(",")}`);
		assert.ok(offered.includes("cp_gate"), `cp_gate disappeared; got: ${offered.join(",")}`);

		const spec = (provider.requests("review-tool-wiring")[0]?.body.tools as ToolSpec[] | undefined)?.find(
			(tool) => (tool.function?.name ?? tool.name) === "cp_review",
		);
		const properties = Object.keys(spec?.function?.parameters?.properties ?? {}).sort();
		// spec 2026-09-05: `action` is start (default) | status — the async surface,
		// not a subject switch. The subject is still the pushed diff and nothing else.
		assert.deepEqual(properties, ["action", "deliver_revise", "job_id", "model"]);

		// cp_gate stays what it was: no diff/mode/subject switch grew onto it.
		const gate = (provider.requests("review-tool-wiring")[0]?.body.tools as ToolSpec[] | undefined)?.find(
			(tool) => (tool.function?.name ?? tool.name) === "cp_gate",
		);
		assert.deepEqual(Object.keys(gate?.function?.parameters?.properties ?? {}).sort(), [
			"action",
			"deliver_revise",
			"job_id",
			"model",
			"replacement_job_id",
		]);

		// 2. The refusal. It comes from the dispatch-record precondition, so it
		//    names cp_dispatch — never a pipeline, which is not consulted at all.
		const ends = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_review");
		assert.equal(ends.length, 1, `expected one cp_review call, got ${ends.length}`);
		const end = ends[0] as { isError?: boolean; result?: unknown };
		assert.equal(end.isError, true, "an unknown job id must come back as a clean tool error");
		const text = JSON.stringify(end.result ?? {});
		assert.match(text, /no dispatch record for cp-review-tool-unknown/);
		assert.match(text, /cp_dispatch/, "the refusal must name the fix");
		assert.doesNotMatch(text, /pipeline/i, "the precondition is a dispatch record, never a pipeline record");

		// Nothing was decided: a refusal is not a verdict, so no review file exists.
		assert.equal(existsSync(join(home.path, paths.reviewFile("cp-review-tool-unknown", 1))), false);
	},
);

test("cp_review is parent-only: a worker profile can never hold it", () => {
	// Same rule as cp_gate. A worker holding it could spawn a reviewer against a
	// sibling job's branch and promote a revise into that job's implementer.
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_review"));
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_gate"), "and the plan gate stays parent-only too");
});

// ---------------------------------------------------------------------------
// The payload: round-trip, and what never travels in it
// ---------------------------------------------------------------------------

const HEAD = "b".repeat(40);

function verdictOf(overrides: Partial<DiffVerdict> = {}): DiffVerdict {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-review-payload",
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["scoped to the brief", "tests cover the new branch"],
		decided_at: isoTimestamp(new Date("2026-01-01T00:00:00Z")),
		head_sha: HEAD,
		diff_stat: { files: 2, truncated: false },
		...overrides,
	};
}

function resultOf(overrides: Partial<DiffReviewResult> = {}): DiffReviewResult {
	return {
		verdict: verdictOf(),
		next: "proceed",
		path: `state/runs/cp-review-payload/${"review-1.json"}`,
		model: "anthropic/claude-opus-5",
		diff: {
			path: "/tmp/home/state/runs/cp-review-payload/review-1/review/diff.md",
			base: "main",
			branch: "cp-review-payload",
			head_sha: HEAD,
			files: 2,
			truncated: false,
			omitted: [],
		},
		...overrides,
	};
}

test("details.verdict round-trips through validate<DiffVerdict>(DiffVerdictSchema, …)", () => {
	const payload = diffReviewToolPayload(resultOf());
	const roundTrip = validate<DiffVerdict>(DiffVerdictSchema, payload.details.verdict);
	assert.ok(roundTrip.ok, roundTrip.ok ? "" : roundTrip.errors.join("; "));
	assert.equal(roundTrip.ok && roundTrip.value.head_sha, HEAD);
	// The ladder's word travels beside the verdict, never inside it: `next` is
	// gate.ts's derivation, not a schema field, and DiffVerdictSchema is closed.
	assert.equal(payload.details.next, "proceed");
	assert.equal(validate(DiffVerdictSchema, { ...verdictOf(), next: "proceed" }).ok, false);
});

test("a verdict that does not satisfy the schema is refused by the tool, not shipped as details", () => {
	// The orchestrator validates what it writes; this is the surface's own check,
	// so a future change to DiffReviewResult cannot quietly hand the parent a
	// payload no schema describes.
	const broken = resultOf({ verdict: { ...verdictOf(), diff_stat: { files: -1, truncated: false } } });
	assert.throws(
		() => diffReviewToolPayload(broken),
		(error: Error) => {
			assert.match(error.message, /cp_review/);
			assert.match(error.message, /DiffVerdictSchema/);
			return true;
		},
	);
});

test("no diff text, and no path to it, travels in content or details", () => {
	const hunk = "@@ -1,3 +1,4 @@\n+const SECRET_FROM_THE_DIFF = 1;";
	const result = resultOf({
		verdict: verdictOf({ verdict: "revise", cause: null, reasons: ["one file lacks a test"], revisions: ["add it"] }),
		next: "revise",
		revise_receipt: "delivered",
		// The reviewer's own observation is uncapped: capPayload bounds only what
		// the verdict carries, so the raw review must not be re-exported around it.
		review: {
			job_id: "cp-review-payload",
			verdict: "revise",
			flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
			reasons: [`the hunk reads ${hunk}`],
			revisions: ["add it"],
		},
	});
	const payload = diffReviewToolPayload(result);
	const serialized = JSON.stringify(payload);

	assert.ok(!serialized.includes(hunk), "diff text reached the tool's payload");
	assert.ok(!serialized.includes("SECRET_FROM_THE_DIFF"), "a fragment of the diff reached the tool's payload");
	assert.ok(
		!serialized.includes(result.diff?.path as string),
		"the materialized diff's path travelled — Stage E's guard blocks reading it, so nothing should hand it over",
	);
	assert.ok(!serialized.includes("diff.md"), "the payload names the diff file");

	// What does travel: the verdict, the cause, the counts, the ladder's next,
	// and the decision file (review-<n>.json, which the guard leaves readable).
	assert.match(payload.content[0]?.text as string, /attempt 1: revise/);
	assert.equal(payload.details.review_file, result.path);
	assert.equal(payload.details.revise_receipt, "delivered");
	assert.equal((payload.details.subject as { files: number }).files, 2);
	assert.equal(payload.details.review, undefined, "the uncapped observation is not part of the interface");
});

test("a stat overflow — decided with no reviewer at all — still produces a valid payload", () => {
	// The orchestrator's model-free branch: no `model`, no `diff` subject. The
	// payload must not assume either exists.
	const result: DiffReviewResult = {
		verdict: verdictOf({
			verdict: "escalate",
			cause: "policy",
			reasons: ["diff spans 400 file(s), over the 200-file review cap"],
			diff_stat: { files: 400, truncated: true },
		}),
		next: "surface",
		path: "state/runs/cp-review-payload/review-1.json",
	};
	const payload = diffReviewToolPayload(result);
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, payload.details.verdict).ok);
	assert.equal(payload.details.model, undefined);
	assert.equal(payload.details.subject, undefined);
	assert.match(payload.content[0]?.text as string, /no reviewer spawned/);
});
