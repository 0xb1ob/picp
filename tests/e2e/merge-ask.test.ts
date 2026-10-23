import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { git, waitFor } from "../harness/index.ts";
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
	for (const decision of ["Merge PR #9?", "Ship cp-s13-jobless (PR #9)?"]) {
		assert.match(await render(s, decision), /job_id/);
		assert.equal(s.post.awaiting.read().items.length, 0, "jobless asks are rejected before any write");
	}
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

function receipt(s: Awaited<ReturnType<typeof startStack>>, jobId: string, extra: Record<string, unknown> = {}) {
	const file = join(s.home, paths.mergeFile(jobId));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId,
		pr_url: "https://github.com/example/demo/pull/51", pr_number: 51,
		merge_commit_sha: "f".repeat(40), head_sha: "a".repeat(40), head_branch: jobId,
		recorded_at: isoTimestamp(), recorded_by: "gh pr view", ...extra }));
}

test("S13: receipt resolution preserves other decisions and reports closure once", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const clone = s.post.registry.pathOf("demo");
	const head = git(clone, "rev-parse", "HEAD");
	const jobs = await Promise.all(["merged", "live", "gone", "answered", "withdrawn"].map((name) => s.seed(`S13 ${name}`)));
	for (const live of jobs) {
		git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${live.branch}`);
		s.setGh({ runs: [run(1301, head, "in_progress", null)] });
		await render(s, "Merge PR #51?", live.jobId);
	}
	const [merged, live, gone, answered, withdrawn] = jobs;
	const awaiting = join(s.home, LAYOUT.awaitingFile);
	const legacy = JSON.parse(readFileSync(awaiting, "utf8"));
	for (const row of legacy.items) {
		if (row.job_id === answered!.jobId) Object.assign(row, { state: "answered", answer: "merge", answered_by: "operator", answered_at: isoTimestamp(), deferred_reason: undefined });
		if (row.job_id === withdrawn!.jobId) Object.assign(row, { state: "withdrawn", deferred_reason: undefined });
	}
	writeFileSync(awaiting, JSON.stringify(legacy));
	const fleetFile = join(s.home, LAYOUT.fleetFile);
	const fleet = JSON.parse(readFileSync(fleetFile, "utf8"));
	fleet.jobs = fleet.jobs.filter((job: { job_id: string }) => job.job_id !== gone!.jobId && job.job_id !== merged!.jobId);
	writeFileSync(fleetFile, JSON.stringify(fleet));
	for (const job of [merged!, answered!, withdrawn!]) receipt(s, job.jobId);
	const checkpoint = join(s.home, paths.checkpointFile(live!.jobId));
	const checkpointBody = JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: live!.jobId,
		question: "authorize S13 follow-up?", requested_at: isoTimestamp(), decision: "pending" });
	mkdirSync(dirname(checkpoint), { recursive: true });
	writeFileSync(checkpoint, checkpointBody);
	const text = await render(s);
	assert.match(text, /Not asked — already merged/);
	assert.match(text, /Not asked — the job is gone/);
	assert.match(text, /Not asked yet — not ready to merge/);
	const decisions = await s.parent("List the remaining decisions.", [
		{ kind: "tool_calls", calls: [{ name: "cp_awaiting", args: { action: "list" } }] },
		{ kind: "text", text: "Listed." },
	], undefined, true);
	assert.match(JSON.stringify(decisions), /authorize S13 follow-up/);
	assert.equal(readFileSync(checkpoint, "utf8"), checkpointBody, "merge rechecks cannot mutate authorization projections");
	assert.equal(s.post.awaiting.read().items.length, 5, "closure deletes no decisions");
	const rows = s.post.awaiting.read().items;
	assert.equal(rows.find((row) => row.job_id === merged!.jobId)?.state, "withdrawn");
	assert.match(rows.find((row) => row.job_id === merged!.jobId)?.deferred_reason ?? "", /already merged as fffffff/);
	assert.equal(rows.find((row) => row.job_id === live!.jobId)?.state, "deferred");
	assert.match(rows.find((row) => row.job_id === live!.jobId)?.deferred_reason ?? "", /in_progress/);
	assert.equal(rows.find((row) => row.job_id === gone!.jobId)?.state, "deferred");
	assert.match(rows.find((row) => row.job_id === gone!.jobId)?.deferred_reason ?? "", /is gone/);
	assert.equal(rows.find((row) => row.job_id === answered!.jobId)?.answer, "merge");
	assert.equal(rows.find((row) => row.job_id === answered!.jobId)?.state, "answered");
	assert.equal(rows.find((row) => row.job_id === withdrawn!.jobId)?.deferred_reason, undefined);
	assert.match(text, /Not asked — already merged \(1\); the row is closed, nothing to approve:/);
	assert.doesNotMatch(await render(s), /Not asked — already merged/);
	await render(s, "Merge PR #51?", answered!.jobId);
	assert.equal(s.post.awaiting.read().items.find((row) => row.job_id === answered!.jobId)?.answer, "merge");
});

test("S13: new and legacy receipt shapes resolve only the matching delivery", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	for (const mode of ["new", "url", "mismatch", "blank", "torn", "numberless", "no-reference"] as const) await t.test(mode, async () => {
		const live = await s.seed(`S13 receipt ${mode}`);
		if (mode !== "new") await render(s, mode === "no-reference" ? "Merge this delivery?" : "Merge PR #51?", live.jobId);
		receipt(s, live.jobId, mode === "url" || mode === "mismatch" ? { pr_number: undefined, pr_url: `https://github.com/example/demo/pull/${mode === "mismatch" ? 52 : 51}` } : mode === "blank" ? { merge_commit_sha: "   " } : mode === "numberless" ? { pr_number: undefined, pr_url: "https://example.invalid/no-number" } : {});
		if (mode === "torn") writeFileSync(join(s.home, paths.mergeFile(live.jobId)), "{ not json");
		if (mode === "new") {
			const fleetFile = join(s.home, LAYOUT.fleetFile);
			const fleet = JSON.parse(readFileSync(fleetFile, "utf8"));
			fleet.jobs = fleet.jobs.filter((job: { job_id: string }) => job.job_id !== live.jobId);
			writeFileSync(fleetFile, JSON.stringify(fleet));
		}
		const text = await render(s, mode === "new" ? "Merge PR #51?" : undefined, mode === "new" ? live.jobId : undefined);
		const row = s.post.awaiting.read().items.find((item) => item.job_id === live.jobId)!;
		const resolved = !["mismatch", "blank", "torn"].includes(mode);
		assert.equal(row.state, resolved ? "withdrawn" : "deferred", `${mode}: receipt evidence controls closure`);
		if (resolved) {
			assert.match(text, /Not asked — already merged/);
			assert.match(text, /already merged as fffffff/);
			if (mode !== "numberless") assert.match(text, /PR #51 already merged/);
			assert.doesNotMatch(await render(s), /Not asked — already merged/);
		}
	});
});

test("S13: persisted review attempts require a readable complete pass and survive gaps", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const clone = s.post.registry.pathOf("demo");
	const head = git(clone, "rev-parse", "HEAD");
	s.setGh({ runs: [run(1302, head, "completed", "success")] });
	for (const mode of ["missing", "revise", "torn", "invalid", "gap", "truncated", "equivalent-truncated", "complete"] as const) await t.test(mode, async () => {
		const live = await s.seed(`S13 review ${mode}`);
		git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${live.branch}`);
		const file = join(s.home, paths.reviewFile(live.jobId, 1));
		mkdirSync(dirname(file), { recursive: true });
		if (mode === "torn") writeFileSync(file, "{ not json");
		else if (mode === "invalid") writeFileSync(file, JSON.stringify({ verdict: "pass", head_sha: head, diff_stat: { files: 1, truncated: false } }));
		else if (mode !== "missing") writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z", {
			...(mode === "gap" ? { attempt: 2 } : {}),
			...(mode === "revise" ? { verdict: "revise", cause: "policy" } : {}),
			...(["truncated", "equivalent-truncated"].includes(mode) ? { diff_stat: { files: 1, truncated: true } } : {}),
			...(mode === "equivalent-truncated" ? { equivalent_to: { head_sha: "b".repeat(40), attempt: 1 } } : {}),
		});
		await render(s, "Ship PR #51?", live.jobId);
		const row = s.post.awaiting.read().items.find((item) => item.job_id === live.jobId)!;
		assert.equal(row.state, ["gap", "complete"].includes(mode) ? "open" : "deferred", `${mode}: only complete readable passes unlock a ship ask`);
		if (!["gap", "complete"].includes(mode)) {
			for (let iteration = 0; iteration < (mode === "missing" ? 10 : 1); iteration++) {
				assert.match(await render(s), /no passing cp_review/, `${mode}: render ${iteration} cannot invent a review`);
				assert.equal(s.post.awaiting.read().items.find((item) => item.job_id === live.jobId)?.state, "deferred");
			}
			writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z", { attempt: 2 });
			await render(s);
			assert.equal(s.post.awaiting.read().items.find((item) => item.job_id === live.jobId)?.state, "open", `${mode}: arriving pass recovers the decision`);
		}
	});
	// A verdict written by a real cp_review run must satisfy the merge-ask reader (writer/reader agreement).
	await t.test("real-writer", async () => {
		const live = await s.held("S13 real review writer", 1330);
		s.setGh({ runs: [run(1330, live.head, "completed", "success")] });
		const reviewer = s.provider.addScript("s13-real-writer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
			job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S13 writer pass"],
		} }] }]);
		s.agentDir.writeModels(s.provider);
		const file = join(s.home, paths.reviewFile(live.jobId, 1));
		await s.parent("Review the S13 writer job.", [
			{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: live.jobId, model: reviewer } }] },
			{ kind: "text", text: "Review started." },
		], async () => { await waitFor(() => existsSync(file), Boolean, { timeoutMs: 30_000, what: "real cp_review writes its verdict" }); });
		await render(s, "Ship PR #1330?", live.jobId);
		assert.equal(s.post.awaiting.read().items.find((item) => item.job_id === live.jobId)?.state, "open", "the reader accepts the real writer's verdict");
	});
});

test("S13: ship decisions wait for current CI and recover from repeated transport failure", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const clone = s.post.registry.pathOf("demo");
	const head = git(clone, "rev-parse", "HEAD");
	for (const mode of ["running", "unknown", "superseded", "denied", "green"] as const) await t.test(mode, async () => {
		const live = await s.seed(`S13 ship ${mode}`);
		git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${live.branch}`);
		writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
		s.setGh({ runs: mode === "unknown" ? [] : [run(1303, mode === "superseded" ? "b".repeat(40) : head, mode === "running" ? "in_progress" : "completed", mode === "running" ? null : "success")], routes: mode === "denied" ? [{ match: "actions/runs?head_sha=", replies: [{ code: 1, stderr: "HTTP 403 rate limited" }] }] : [] });
		await render(s, "Ship PR #51?", live.jobId);
		assert.equal(s.post.awaiting.read().items.find((row) => row.job_id === live.jobId)?.state, mode === "green" ? "open" : "deferred", `${mode}: ship readiness`);
		if (mode === "running") assert.match(s.post.awaiting.read().items.find((row) => row.job_id === live.jobId)?.deferred_reason ?? "", /in_progress/, "running ship names unfinished CI");
		if (mode === "denied") {
			for (let iteration = 0; iteration < 10; iteration++) {
				assert.match(await render(s), /read rate_limited/);
				assert.equal(s.post.awaiting.read().items.find((row) => row.job_id === live.jobId)?.state, "deferred", `unreadable render ${iteration}`);
			}
			s.setGh({ runs: [run(1303, head, "completed", "success")], routes: [] });
			await render(s);
			assert.equal(s.post.awaiting.read().items.find((row) => row.job_id === live.jobId)?.state, "open", "CI evidence recovers the durable decision");
		}
	});
	const text = await render(s, "Merge PR #51?", "cp-s13-unknown");
	assert.match(text, /CI not checked: job cp-s13-unknown is gone/);
	assert.equal(s.post.awaiting.read().items.find((row) => row.job_id === "cp-s13-unknown")?.state, "deferred", "new unknown job never raises an ask");
});

test("S13: integration rejects direct and equivalent partial reviews until a complete later pass", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S13 partial reviews", 1310);
	s.setGh({ runs: [run(1310, live.head, "completed", "success")] });
	for (const equivalent of [false, true]) await t.test(equivalent ? "equivalent" : "direct", async () => {
		if (equivalent) renameSync(join(s.home, paths.reviewFile(live.jobId, 1)), join(s.home, "direct-partial.json"));
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z", {
			diff_stat: { files: 1, truncated: true },
			...(equivalent ? { equivalent_to: { head_sha: "b".repeat(40), attempt: 1 } } : {}),
		});
		const events = await s.parent("Check integration readiness.", [
			{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
			{ kind: "text", text: "Checked." },
		], undefined, true);
		assert.match(JSON.stringify(events), /"next":"review"/, `${equivalent}: partial reviews cannot authorize integration`);
	});
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z", { attempt: 2 });
	const events = await s.parent("Check the complete review.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
		{ kind: "text", text: "Checked." },
	], undefined, true);
	assert.doesNotMatch(JSON.stringify(events), /"next":"review"/, "later complete pass counts on the same head");
	assert.match(JSON.stringify(events), /"step":"merge"/, "complete pass reaches the forge merge step");
});

test("S13: workflow command failures never become positive absence of CI", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const clone = s.post.registry.pathOf("demo");
	const head = git(clone, "rev-parse", "HEAD");
	for (const mode of ["none", "unauthorized", "command_failed"] as const) await t.test(mode, async () => {
		const live = await s.seed(`S13 workflows ${mode}`);
		git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${live.branch}`);
		writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
		s.setGh({ runs: [], routes: [{ match: "actions/workflows", replies: [mode === "none" ? { stdout: JSON.stringify({ total_count: 0, workflows: [] }) } : { code: 1, stderr: mode === "unauthorized" ? "HTTP 403 Resource not accessible" : "spawn gh ENOENT" }] }] });
		await render(s, "Merge PR #51?", live.jobId);
		assert.equal(s.post.awaiting.read().items.find((row) => row.job_id === live.jobId)?.state, mode === "none" ? "open" : "deferred", `${mode}: only positive workflow absence unblocks CI`);
	});
	// cp_integrate renders the workflow classification; swapping unauthorized and command_failed must fail here.
	for (const [n, mode] of (["unauthorized", "command_failed"] as const).entries()) await t.test(`${mode} cause`, async () => {
		const live = await s.held(`S13 workflows cause ${mode}`, 1340 + n);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		s.setGh({ runs: [], routes: [{ match: "actions/workflows", replies: [{ code: 1, stderr: mode === "unauthorized" ? "HTTP 403 Resource not accessible" : "spawn gh ENOENT" }] }] });
		const events = await s.parent("Check integration readiness.", [
			{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
			{ kind: "text", text: "Checked." },
		], undefined, true);
		const text = JSON.stringify(events);
		assert.match(text, new RegExp(`ci configuration: unreadable \\(${mode}\\)`), `${mode}: rendered cause`);
		assert.match(text, mode === "unauthorized" ? /gh cannot read this repository's workflows/ : /could not ask this repository for its workflows/, `${mode}: rendered reason`);
	});
});
