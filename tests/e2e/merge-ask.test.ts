import assert from "node:assert/strict";
import { test } from "node:test";
import { git } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, run, startStack } from "./landing-helpers.ts";

test("S12: status tool gates merge decisions on current CI and review evidence", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.seed("S12 legacy held merge decision");
	const clone = s.post.registry.pathOf("demo");
	git(clone, "push", "origin", `HEAD:refs/heads/${live.branch}`);
	const head = git(clone, "rev-parse", "HEAD");
	writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
	for (const mode of ["running", "red", "unknown", "superseded", "green"] as const) {
		s.setGh({ runs: mode === "unknown" ? [] : [run(1200, mode === "superseded" ? "b".repeat(40) : head, mode === "running" ? "in_progress" : "completed", mode === "running" ? null : mode === "red" ? "failure" : "success")] });
		const events = await s.parent(`Render the merge decision: ${mode}.`, [
			{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: { awaiting: [{ type: "approval", decision: "Merge PR #51?", why: "delivery", blocks: "delivery", job_id: live.jobId }] } }] },
			{ kind: "text", text: "Status rendered." },
		]);
		assert.equal(s.post.awaiting.list("open").length, mode === "green" ? 1 : 0, `${mode}: only current green evidence raises the decision`);
		assert.equal(s.post.awaiting.list("deferred").length, mode === "green" ? 0 : 1, `${mode}: the decision remains durable`);
		if (mode === "running") assert.match(JSON.stringify(events), /in_progress/);
	}
	assert.equal(s.post.awaiting.read().items.length, 1, "repeated renders preserve one decision identity");
});
