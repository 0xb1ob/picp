import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
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
		const workflowsBefore = s.ghCalls().filter((call) => call.includes("actions/workflows")).length;
		s.setGh({ runs: mode === "unknown" ? [] : [run(1200, mode === "superseded" ? "b".repeat(40) : head, mode === "running" ? "in_progress" : "completed", mode === "running" ? null : mode === "red" ? "failure" : "success", { run_attempt: 2 })] });
		const events = await s.parent(`Render the merge decision: ${mode}.`, [
			{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: { awaiting: mode === "green" ? [] : [{ type: "approval", decision: "Merge PR #51?", why: "delivery", blocks: "delivery", job_id: live.jobId }] } }] },
			{ kind: "text", text: "Status rendered." },
		]);
		assert.equal(s.post.awaiting.list("open").length, mode === "green" ? 1 : 0, `${mode}: only current green evidence raises the decision`);
		assert.equal(s.post.awaiting.list("deferred").length, mode === "green" ? 0 : 1, `${mode}: the decision remains durable`);
		if (mode === "running") assert.match(JSON.stringify(events), /in_progress/);
		if (mode === "running" || mode === "red") assert.equal(s.ghCalls().filter((call) => call.includes("actions/workflows")).length, workflowsBefore, "runs already answer whether CI exists");
		if (mode === "red") assert.match(JSON.stringify(events), /Not asked — CI red/);
		if (mode === "green") assert.match(JSON.stringify(events), /Merge PR #51/, "promoted decision is folded into the render without resupply");
		if (mode === "running") {
			await render(s, "Merge PR #51 when CI goes green", live.jobId);
			assert.equal(s.post.awaiting.read().items.length, 1, "rewording a deferred subject does not mint another row");
		}
		assert.ok(s.ghCalls().some((call) => call.includes(`head_sha=${head}`)), "CI query is scoped to the pushed head");
		assert.ok(s.ghCalls().every((call) => !call.includes("run list")), "merge decisions never query a branch run list");
		if (mode === "running") {
			assert.match(JSON.stringify(events), /Awaiting you: none/);
			assert.match(JSON.stringify(events), /Not asked yet — not ready to merge/);
		}
		assert.ok(s.ghCalls().some((call) => call.includes("runs/1200/attempts/2/jobs")), "CI query reads the actual attempt jobs");
	}
	const identity = s.post.awaiting.read().items[0]!.id;
	s.setGh({ runs: [run(1200, head, "in_progress", null)] });
	await render(s, "Merge PR #51 when CI completes", live.jobId);
	assert.equal(s.post.awaiting.get(identity)?.state, "open", "an open decision is not re-gated");
	const awaitingFile = join(s.home, LAYOUT.awaitingFile);
	const legacy = JSON.parse(readFileSync(awaitingFile, "utf8"));
	Object.assign(legacy.items[0], { state: "answered", answer: "merge", answered_at: isoTimestamp(), answered_by: "operator" });
	writeFileSync(awaitingFile, JSON.stringify(legacy));
	await render(s, "Merge PR #51?", live.jobId);
	assert.equal(s.post.awaiting.get(identity)?.state, "answered", "answered decisions survive restarted CI");
	assert.equal(s.post.awaiting.get(identity)?.answer, "merge");
	assert.equal(s.post.awaiting.read().items.length, 1, "repeated renders preserve one decision identity");
});

async function render(s: Awaited<ReturnType<typeof startStack>>, decision?: string, jobId?: string, type = "approval") {
	const events = await s.parent("Render the requested status.", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: { width: 200, awaiting: decision ? [{ type, decision, why: "delivery", blocks: "delivery", ...(jobId ? { job_id: jobId } : {}) }] : [] } }] },
		{ kind: "text", text: "Rendered." },
	], undefined, true);
	return JSON.stringify(events);
}

test("S12: public status distinguishes missing review, missing head and unreadable CI", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const clone = s.post.registry.pathOf("demo");
	const head = git(clone, "rev-parse", "HEAD");
	for (const mode of ["unreviewed", "old-review", "short-review", "stub-review", "headless", "denied", "workflows-none", "workflows-denied", "workflows-unreviewed"] as const) {
		const live = await s.seed(`S12 ${mode}`);
		if (mode !== "headless") git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${live.branch}`);
		if (!["unreviewed", "workflows-unreviewed"].includes(mode)) writeWindowPass(s.home, live.jobId, mode === "old-review" ? "b".repeat(40) : mode === "short-review" ? head.slice(0, 7).toUpperCase() : mode === "stub-review" ? head.slice(0, 6) : head, "2026-01-01T00:00:00Z");
		s.setGh({ runs: mode.startsWith("workflows-") ? [] : [run(1201, head, "completed", "success")], routes: mode === "denied" ? [{ match: "actions/runs?head_sha=", replies: [{ code: 1, stderr: "HTTP 403 forbidden" }] }] : mode.startsWith("workflows-") ? [{ match: "actions/workflows", replies: [mode === "workflows-denied" ? { code: 1, stderr: "HTTP 403 forbidden" } : { stdout: JSON.stringify({ total_count: 0, workflows: [] }) }] }] : [] });
		const text = await render(s, `Ship ${live.jobId} (PR #51)?`, live.jobId);
		const row = s.post.awaiting.read().items.find((item) => item.job_id === live.jobId)!;
		const raised = mode === "short-review" || mode === "workflows-none";
		assert.equal(row.state, raised ? "open" : "deferred", `${mode}: gate outcome`);
		if (mode === "denied" || mode === "workflows-denied") assert.match(text, /read denied|observable/, `${mode}: named failure`);
		if (mode === "headless") assert.match(text, /no pushed head/);
		if (["unreviewed", "old-review", "stub-review", "workflows-unreviewed"].includes(mode)) assert.match(text, /no passing cp_review/);
	}
});

test("S12: legacy deferred decisions distinguish gone jobs and transport failures", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const clone = s.post.registry.pathOf("demo");
	const head = git(clone, "rev-parse", "HEAD");
	const gone = await s.seed("S12 gone");
	git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${gone.branch}`);
	s.setGh({ runs: [run(1202, head, "in_progress", null)] });
	await render(s, "Merge PR #51?", gone.jobId);
	const fleetFile = join(s.home, LAYOUT.fleetFile);
	const fleet = JSON.parse(readFileSync(fleetFile, "utf8"));
	fleet.jobs = fleet.jobs.filter((job: { job_id: string }) => job.job_id !== gone.jobId);
	writeFileSync(fleetFile, JSON.stringify(fleet));
	const text = await render(s);
	assert.match(text, /job .* is gone/);
	assert.match(text, /answer or withdraw/);
	const row = s.post.awaiting.read().items[0]!;
	assert.equal(row.state, "deferred", "gone row survives restart");
	assert.match(row.deferred_reason ?? "", /is gone/);
	assert.equal(s.post.awaiting.read().items.length, 1);
});

test("S12: forge receipt matching and decision wording reach the status consumer", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const mr = "https://gitlab.example.com/group/repo/-/merge_requests/7";
	const live = await s.seed("S12 GitLab", { prUrl: mr });
	for (const decision of ["Merge MR !7", "Merge merge request 7", "Merge !7", "Merge PR #7", "Merge pull request #7", "Merge #7"]) {
		const text = await render(s, decision, live.jobId);
		assert.match(text, /GitLab CI is not read in v1/, decision);
	}
	assert.equal(s.ghCalls().filter((call) => call.includes("actions/")).length, 0, "GitLab never queries Actions");
	await render(s, "Merge MR !8", live.jobId);
	const file = join(s.home, paths.mergeFile(live.jobId));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: live.jobId, pr_url: mr, merge_commit_sha: "f".repeat(40), head_sha: "a".repeat(40), head_branch: live.branch, recorded_at: isoTimestamp(), recorded_by: "gh pr view" }));
	const mergedText = await render(s);
	assert.match(mergedText, /GitLab CI is not read/);
	assert.match(mergedText, /already merged/);
	assert.equal(s.post.awaiting.list("deferred").some((row) => row.decision === "Merge MR !8"), true, "another MR receipt cannot resolve this deferred decision");
	assert.ok(s.post.awaiting.read().items.some((row) => row.state === "withdrawn"), "matching receipt withdraws its decision");
	const gh = await s.seed("S12 GitHub receipt");
	await render(s, "Merge cp-gh (ship !3)?", gh.jobId);
	const ghFile = join(s.home, paths.mergeFile(gh.jobId));
	mkdirSync(dirname(ghFile), { recursive: true });
	writeFileSync(ghFile, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: gh.jobId, pr_url: "https://github.com/example/demo/pull/5", pr_number: 5, merge_commit_sha: "e".repeat(40), head_sha: "a".repeat(40), head_branch: gh.branch, recorded_at: isoTimestamp(), recorded_by: "gh pr view" }));
	assert.match(await render(s), /already merged/);
});

test("S12: plain decisions bypass CI while merge and ship wording remains gated", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.seed("S12 wording");
	for (const decision of ["Merge PR #44 once its rebase lands green", "merge cp-gmy?", "cp-x: is #12 ready to merge?", "Ship cp-x (PR 119), drop it, or open a follow-up?", "Ship PR #117 or hold it?", "cp-x: ship #12 now?"]) {
		const text = await render(s, decision, live.jobId);
		assert.match(text, /no pushed head/, decision);
		assert.equal(s.post.awaiting.list("open").length, 0, `${decision}: never open without a head`);
	}
	for (const decision of ["postgres or sqlite?", "cp-x: ship, drop or follow-up?", "Ship cp-x, drop it, or open a follow-up?", "ship !3"]) {
		await render(s, decision, undefined, decision === "postgres or sqlite?" ? "design" : "approval");
		assert.ok(s.post.awaiting.list("open").some((row) => row.decision === decision), `${decision}: not a merge decision`);
	}
	assert.equal(s.ghCalls().filter((call) => call.includes("actions/")).length, 0, "headless decisions cost no Actions query");
	assert.match(await render(s, "Merge PR #9?"), /job_id/);
});

test("S12: remote head wins and reported head recovers an unreadable remote", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S12 head resolution", 51);
	git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "new remote head");
	git(live.worktree, "push", "--quiet", "origin", live.jobId);
	const current = git(live.worktree, "rev-parse", "HEAD");
	writeWindowPass(s.home, live.jobId, current, "2026-01-01T00:00:00Z");
	s.setGh({ runs: [run(1203, current, "completed", "success")] });
	await render(s, "Merge PR #51?", live.jobId);
	assert.equal(s.post.awaiting.list("open").length, 1, "remote overrides the worker's stale reported head");
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const wrapper = join(s.home, "bin", "git");
	writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const a=process.argv.slice(2);\nif(a[0]==="ls-remote" && a[2]?.startsWith("refs/heads/"))process.exit(128);\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
	chmodSync(wrapper, 0o755);
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	s.setGh({ runs: [run(1204, live.head, "completed", "success")] });
	await render(s, "Merge PR #52?", live.jobId);
	assert.equal(s.post.awaiting.list("open").length, 2, "reported head is used when origin cannot answer");
});

test("S12: missing clone failures stay distinct from a gone job", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.seed("S12 missing clone");
	await render(s, "Merge PR #51?", live.jobId);
	const clone = s.post.registry.pathOf("demo");
	renameSync(clone, `${clone}.missing`);
	try {
		assert.match(await render(s), /has no clone/);
		assert.equal(s.post.awaiting.list("deferred").length, 1);
		assert.doesNotMatch(s.post.awaiting.list("deferred")[0]!.deferred_reason ?? "", /is gone/);
	} finally { renameSync(`${clone}.missing`, clone); }
});


test("S13: legacy jobless deferred decisions name the missing job", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.seed("S13 legacy jobless");
	await render(s, "Merge PR #51?", live.jobId);
	const file = join(s.home, LAYOUT.awaitingFile);
	const legacy = JSON.parse(readFileSync(file, "utf8"));
	delete legacy.items[0].job_id;
	writeFileSync(file, JSON.stringify(legacy));
	const text = await render(s);
	assert.match(text, /this row names no job/);
	assert.equal(s.post.awaiting.list("deferred").length, 1);
	assert.equal(s.post.awaiting.list("open").length, 0);
	assert.equal(s.ghCalls().filter((call) => call.includes("actions/")).length, 0);
});
