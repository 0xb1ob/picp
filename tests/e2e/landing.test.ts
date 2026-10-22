/**
 * Behavior 05 (docs/testing-migration.md): what a held PR's CI read, CI configuration, infra rerun, /doctor, cp_merged
 * and cp_teardown's git landing proof make of each answer. Real CommandPost, implementer workers and reporter, scratch
 * git; scripted `gh`, and a local https GitLab (REST plus git http-backend) for the GitLab cases.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CI_READ_NEEDED, CI_UNREADABLE_LABEL } from "../../src/ci-access.ts";
import { CommandPost } from "../../src/command-post.ts";
import { detectCiWait } from "../../src/ci-wait.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { CI_EVIDENCE_KEEP, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { MainCiStore } from "../../src/main-ci.ts";
import { formatMerge, readMergeReceipt } from "../../src/merges.ts";
import { loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { formatStatusTable } from "../../src/status.ts";
import { createViewer } from "../../src/viewer/server.ts";
import type { AddressInfo } from "node:net";
import { COMMAND_POST_EXTENSION, argOf, captureSpawns, CP_BRIDGE_EXTENSION, startPiChild, advanceBase, git, readRunEvents, rebaseMergeAndDeleteHead, REPO_ROOT, type ScriptStep, squashMergeAndDeleteHead, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, CANARY, type RunRow, type Reply, type Route, type GhState, run, json, runsBody, setupJob, mergeAndDeleteHead, type GitlabReply, startFakeGitlab, landOnOrigin, startStack, mergedCalls, MERGE, deployJobs, afterMergeRecord } from "./landing-helpers.ts";

test("landing S16: automatic green CI reviews use the current mandate reviewer", { skip: SKIP, timeout: 180_000 }, async (t) => {
 const s = await startStack(t, { continuation: true });
 const live = await s.held("S16 automatic reviewer", 916);
 await s.post.continuation.serialize(live.jobId, async () => {});
 const spawns = captureSpawns(s.post.manager);
 const script = "s16-auto-review";
 const model = s.provider.addScript(script, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["current reviewer"] } }] }]);
 s.agentDir.writeModels(s.provider);
 s.post.mandates.issue({ projects: ["demo"], job_ids: [live.jobId], objective: "review", reviewer_model: model, expiry: isoTimestamp(new Date(Date.now() + 86400000)), spend_cap: { usd: 10, tokens: 1000000 }, job_cap: 10 });
 s.setGh({ integration: true, runs: [run(916, live.head, "completed", "success")] });
 await s.tick(live.jobId);
 await s.post.continuation.serialize(live.jobId, async () => {});
 await s.post.reviewRuns.settled(`${live.jobId}#review-1`);
 assert.ok(s.provider.requests(script).length > 0, "automatic review reaches the mandated model");
 assert.equal(argOf(spawns.at(-1)?.args ?? [], "--model"), model);
 assert.equal(argOf(spawns.at(-1)?.args ?? [], "--thinking"), "high");
 assert.equal(JSON.parse(readFileSync(join(s.home, paths.reviewFile(live.jobId, 1)), "utf8")).verdict, "pass");
 const events = readFileSync(join(s.home, paths.reviewRunDir(live.jobId, 1), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
 assert.deepEqual(events.find((event) => event.type === "reviewer_model_selected")?.payload.source, "mandate");
});

test("landing: legacy unregistered projects retain GitHub observation and refuse a GitLab reference", { skip: SKIP }, async (t) => {
	const s = await startStack(t);
	const github = await s.seed("legacy GitHub delivery");
	const gitlab = await s.seed("legacy GitLab delivery", { prUrl: "https://gitlab.com/g/r/-/merge_requests/5" });
	await s.post.registry.remove("demo");
	s.setGh({ routes: [{ match: "pr view", replies: [json({ number: 5, url: github.prUrl, state: "MERGED", mergedAt: isoTimestamp(), mergeCommit: { oid: "b".repeat(40) }, headRefName: github.branch, headRefOid: "a".repeat(40), baseRefName: "main" })] }] });
	const result = await s.post.recordMerge({ jobId: github.jobId });
	assert.equal(result.receipt.recorded_by, "gh pr view");
	assert.equal(result.receipt.base_branch, "main");
	const before = s.ghCalls().length;
	await assert.rejects(s.post.recordMerge({ jobId: gitlab.jobId }), /unsupported/);
	assert.equal(s.ghCalls().length, before, "an unregistered GitLab MR never falls back to gh");
	assert.equal(readMergeReceipt(s.home, gitlab.jobId), undefined);
	await s.project("unknown", { cloneUrl: "https://git.example.com/o/lab.git" });
	const unknown = await s.seed("unsupported forge", { project: "unknown", prUrl: "https://git.example.com/o/lab/-/merge_requests/7" });
	await assert.rejects(s.post.recordMerge({ jobId: unknown.jobId }), /unsupported/);
	assert.equal(s.ghCalls().length, before, "an unsupported registered forge sends no gh request");
});

test("landing: teardown proves landing on the project's configured trunk instead of main", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const before = git(s.remote, "rev-parse", "main");
	const live = await s.held("configured base proof", 0, { delivery: "local" });
	squashMergeAndDeleteHead(s.repo, live.jobId);
	const landed = advanceBase(s.repo, "docs/trunk.md", "# trunk only\n");
	git(s.remote, "branch", "trunk", landed);
	git(s.remote, "update-ref", "refs/heads/main", before);
	await s.post.registry.update("demo", { base_branch: "trunk" });
	const result = await s.post.tearDown(live.jobId);
	assert.deepEqual([result.torn_down, result.reason, result.landing?.base_branch], [true, "landed_by_git", "trunk"]);
});

test("landing: forge observation failures refuse merge receipts without leaking external replies", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const token = "glpat-s06-canary";
	const s = await startStack(t, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1", CP_E2E_GITLAB_TOKEN: token } });
	const gh = await s.seed("GitHub observation failures");
	const missing = json({ state: "OPEN" });
	for (const [reply, cause] of [
		[{ code: 1, stderr: "gh: not logged in\nprivate second line" }, /unavailable: .*not logged in/],
		[{ stdout: `<html>${token}</html>` }, /invalid:/],
		[missing, /invalid:/],
		[json({ number: 7, url: gh.prUrl, state: "OPEN" }), /as open, not MERGED/],
	] as Array<[Reply, RegExp]>) {
		s.setGh({ routes: [{ match: "pr view", replies: [reply] }] });
		await assert.rejects(s.post.recordMerge({ jobId: gh.jobId, pr: reply === missing ? gh.prUrl!.split("/").pop() : undefined }), (error: Error) => {
			assert.match(error.message, cause);
			assert.doesNotMatch(error.message, /private second line|glpat-s06-canary|<html>/);
			return true;
		});
		assert.equal(readMergeReceipt(s.home, gh.jobId), undefined);
	}
	const lab = await startFakeGitlab(t, s.remote);
	await s.project("lab", { cloneUrl: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_E2E_GITLAB_TOKEN" } });
	const url = `${lab.web}/o/lab/-/merge_requests/7`;
	const gl = await s.seed("GitLab observation failures", { project: "lab", prUrl: url });
	const head = "a".repeat(40);
	const body = { id: 9001, iid: 7, source_project_id: 42, target_project_id: 42, state: "merged", source_branch: gl.branch, target_branch: "main", sha: head, diff_refs: { head_sha: head }, merge_commit_sha: "b".repeat(40), merged_at: isoTimestamp(), web_url: url };
	const refused = async (reply: GitlabReply, cause: RegExp) => {
		lab.mrs[7] = reply;
		const before = lab.asked.length;
		await assert.rejects(s.post.recordMerge({ jobId: gl.jobId }), (error: Error) => {
			assert.match(error.message, cause);
			assert.doesNotMatch(error.message, /glpat-s06-canary|login|rejected|redirect-destination/);
			return true;
		});
		assert.equal(lab.asked.length, before + 1, "one bounded GET; a refused answer is never retried or redirected");
		assert.equal(readMergeReceipt(s.home, gl.jobId), undefined);
	};
	for (const over of [
		{ diff_refs: { head_sha: "e".repeat(40) } }, { merge_commit_sha: "not-a-sha" }, { sha: null, diff_refs: null },
		{ source_branch: "" }, { target_branch: undefined }, { merged_at: "yesterday" },
	]) await refused({ body: { ...body, ...over } }, /invalid:/);
	await refused({ body: [body] }, /invalid:/);
	for (const over of [
		{ iid: 8 }, { iid: "7" }, { web_url: `${lab.web}/o/other/-/merge_requests/7` },
		{ web_url: "https://evil.example.com/o/lab/-/merge_requests/7" }, { web_url: null },
	]) await refused({ body: { ...body, ...over } }, /mismatch:/);
	for (const over of [{ source_project_id: 43 }, { source_project_id: undefined, target_project_id: undefined }]) {
		await refused({ body: { ...body, ...over } }, /unsupported:/);
	}
	await refused({ body: null, raw: `<html>login ${token}</html>` }, /invalid:/);
	for (const status of [401, 403, 404, 429, 500]) await refused({ status, body: { message: `token ${token} rejected` } }, new RegExp(`unavailable: .*HTTP ${status}`));
	await refused({ status: 302, body: null, headers: { location: `${lab.web}/api/v4/projects/redirect-destination/merge_requests/99` } }, /HTTP 302 redirect refused/);
	for (const [state, expected] of [["opened", "open"], ["closed", "closed"], ["locked", "unknown"], ["weird", "unknown"]]) {
		await refused({ body: { ...body, state, merged_at: null, merge_commit_sha: null } }, new RegExp(`as ${expected}, not MERGED`));
	}
	for (const ref of ["https://evil.example.com/o/lab/-/merge_requests/7", `${lab.web}/o/other/-/merge_requests/7`, "https://github.com/o/lab/pull/7", "0", "7; rm -rf /"]) {
		const before = lab.asked.length;
		await assert.rejects(s.post.recordMerge({ jobId: gl.jobId, pr: ref }));
		assert.equal(lab.asked.length, before, "a foreign or malformed reference sends no token or request");
	}
	for (const flags of [{ sha: null }, { should_remove_source_branch: true, force_remove_source_branch: true }]) {
		const job = await s.seed("GitLab fallback head and deleted source", { project: "lab", prUrl: url });
		lab.mrs[7] = { body: { ...body, source_branch: job.branch, ...flags } };
		const receipt = (await s.post.recordMerge({ jobId: job.jobId })).receipt;
		assert.deepEqual([receipt.head_sha, receipt.head_branch], [head, job.branch]);
	}
	await assert.rejects(s.post.recordMerge({ jobId: "../escape" }), /no fleet record/);
	assert.ok(lab.asked.every((request) => request.token === token));
	await s.post.registry.update("lab", { forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_S06_UNSET_TOKEN" } });
	lab.mrs[7] = { status: 401, body: { message: `rejected ${token}` } };
	await assert.rejects(s.post.recordMerge({ jobId: gl.jobId }), (error: Error) => {
		assert.match(error.message, /CP_S06_UNSET_TOKEN is unset/);
		assert.doesNotMatch(error.message, /glpat-s06-canary|rejected/);
		return true;
	});
	assert.equal(lab.asked.at(-1)?.token, undefined);
	await s.project("prefixed", { cloneUrl: `${lab.web}/gitlab/o/lab.git`, forge: { kind: "gitlab", web_base_url: `${lab.web}/gitlab`, token_env: "CP_E2E_GITLAB_TOKEN" } });
	const prefixed = await s.seed("prefix guard", { project: "prefixed", prUrl: `${lab.web}/gitlab/o/lab/-/merge_requests/7` });
	const beforePrefix = lab.asked.length;
	await assert.rejects(s.post.recordMerge({ jobId: prefixed.jobId, pr: `${lab.web}/o/lab/-/merge_requests/7` }), /mismatch/);
	assert.equal(lab.asked.length, beforePrefix, "an MR outside the configured web prefix sends no credential");
});

test("landing: spawn pressure releases the oldest held author and a journal refusal leaves room retryable", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const s = await startStack(t);
	writeFileSync(join(s.home, LAYOUT.budgetsFile), JSON.stringify({ ...s.post.budgets(), spawn_cap: 2 }));
	const older = await s.held("oldest idle author", 301);
	const newer = await s.held("newer idle author", 302);
	const idle = (id: string) => { const m = s.post.manager.get(id); return s.post.fleet.get(id)?.phase === "held" && m?.worker.alive === true && !m.worker.busy; };
	// makeRoom picks the oldest idle author (src/held-release.ts releasable); a send/drive in flight excludes one, so gate on it.
	await waitFor(() => idle(older.jobId) && idle(newer.jobId) && s.post.heldRelease.releasable().join() === [older.jobId, newer.jobId].join(), Boolean, { timeoutMs: 10_000, what: "both held authors releasable, oldest first" });
	const releases = (id: string) => readRunEvents(s.home, id).filter((event) => event.type === "held_released");
	assert.equal(releases(older.jobId).length + releases(newer.jobId).length, 0, "below cap no author is stopped");
	const original = s.post.fleet.get(older.jobId)!;
	const job = await s.post.ledger().create({ title: "fresh work under spawn pressure", project: "demo", kind: "ship", delivery: "local" });
	const model = s.provider.addScript("spawn-pressure", [{ kind: "text", text: "Fresh worker running." }], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const eventsFile = join(s.home, paths.runDir(older.jobId), "events.jsonl");
	const journal = readFileSync(eventsFile, "utf8");
	rmSync(eventsFile);
	mkdirSync(eventsFile);
	try {
		await assert.rejects(s.post.dispatch({ jobId: job.id, task: "Do the fresh work.", model, fetch: false }), /EISDIR/);
		assert.equal(s.provider.requests("spawn-pressure").length, 0, "journal failure never starts the caller");
		assert.equal(s.post.fleet.get(older.jobId)?.worker.pid, original.worker.pid);
	} finally {
		rmSync(eventsFile, { recursive: true });
		writeFileSync(eventsFile, journal);
	}
	s.post.dispatchQueue.enqueue(job.id, { task: "Do the fresh work.", model });
	await s.post.dispatchQueue.drain();
	assert.ok(s.post.fleet.get(job.id), "queue capacity counts a releasable author as free after journal recovery");
	await waitFor(() => s.provider.requests("spawn-pressure"), (requests) => requests.length > 0, { timeoutMs: 60_000, what: "fresh worker actually runs" });
	assert.deepEqual(releases(older.jobId).map((event) => event.payload), [{ for_job: job.id, reason: "spawn cap" }]);
	assert.equal(releases(newer.jobId).length, 0, "the newer author is not the victim");
	assert.deepEqual([s.post.fleet.get(older.jobId)?.phase, s.post.fleet.get(older.jobId)?.worktree, s.post.fleet.get(older.jobId)?.branch], ["held", original.worktree, original.branch]);
	assert.equal((await s.post.send({ jobId: older.jobId, message: "Continue the held job.", mode: "prompt" })).receipt, "delivered");
	await waitFor(() => readRunEvents(s.home, older.jobId), (events) => events.some((event) => event.type === "worker_revived"), { timeoutMs: 60_000, what: "released author resumes its session" });
	const resumedPid = s.post.fleet.get(older.jobId)!.worker.pid;
	await s.post.send({ jobId: older.jobId, message: "Continue once more.", mode: "prompt" });
	assert.equal(s.post.fleet.get(older.jobId)!.worker.pid, resumedPid, "a revived worker is sent to without another restoration");
	const blocked = await s.post.ledger().create({ title: "no idle held author", project: "demo", kind: "ship", delivery: "local" });
	s.post.dispatchQueue.enqueue(blocked.id, { task: "Wait for capacity.", model });
	await s.post.dispatchQueue.drain();
	assert.equal(s.post.fleet.get(blocked.id), undefined, "at cap with no releasable author, dispatch stays queued");
	assert.ok(s.post.dispatchQueue.ids().includes(blocked.id));
});

test("landing: a deploy ledger failure preserves the merge receipt and retries through cp_merged", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	await s.post.registry.setAfterMergeDeploy("demo", { branch: "main", task: "deploy the observed merge", resources: ["host-a"] });
	const job = await s.seed("merge with unavailable ledger");
	s.setGh({ routes: [{ match: "pr view", replies: [json({ number: Number(job.prUrl!.split("/").pop()), url: job.prUrl, state: "MERGED", mergedAt: isoTimestamp(), mergeCommit: { oid: "b".repeat(40) }, headRefName: job.branch, headRefOid: "a".repeat(40), baseRefName: "main" })] }] });
	const ledgerFile = join(s.home, LAYOUT.jobsFile);
	const original = readFileSync(ledgerFile, "utf8");
	writeFileSync(ledgerFile, "{ corrupt ledger");
	try {
		const result = await s.post.recordMerge({ jobId: job.jobId });
		assert.equal(result.recorded, true);
		assert.ok(readMergeReceipt(s.home, job.jobId), "a deploy failure must preserve the observed merge");
		assert.match(result.after_merge ?? "", /after-merge deploy NOT created: .*cp_merged .* retries/);
		assert.match(formatMerge(result), /can now pass without force\. after-merge deploy NOT created:/);
		assert.equal(existsSync(join(s.home, paths.afterMergeFile(job.jobId))), false, "the failed deploy must remain retryable");
	} finally {
		writeFileSync(ledgerFile, original);
	}
	const retry = await s.post.recordMerge({ jobId: job.jobId });
	assert.equal(retry.recorded, false);
	assert.match(retry.after_merge ?? "", /after-merge deploy .* created/);
	assert.equal(s.post.ledger().read().jobs.filter((row) => row.labels.includes(`after-merge:${job.jobId}`)).length, 1);
	assert.equal("after_merge" in await s.post.recordMerge({ jobId: job.jobId }), false);
});


test("landing: Actions deadlines stop a hung request and share the budget across pages", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const s = await startStack(t);
	const { jobId, head } = await s.held("Actions deadline", 381);
	const runsAt = `actions/runs?head_sha=${head}`;
	for (const acrossPages of [false, true]) {
		const first = join(s.home, `first-${acrossPages}`);
		const last = join(s.home, `last-${acrossPages}`);
		s.setGh({ runs: [run(1, head, "completed", "success")], routes: acrossPages
			? [{ match: runsAt, replies: [{ ...runsBody([run(1, head, "completed", "success")]), untilFile: first }] }, { match: "actions/runs/1/attempts/1/jobs", replies: [{ ...json({ total_count: 0, jobs: [] }), untilFile: last }] }]
			: [{ match: runsAt, replies: [{ ...runsBody([]), untilFile: last }] }] });
		const pending = s.integrate(jobId);
		const release = acrossPages ? setTimeout(() => writeFileSync(first, "release"), 9_000) : undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let result: Awaited<typeof pending> | undefined;
		try {
			result = await Promise.race([pending, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 22_000); })]);
		} finally {
			clearTimeout(timer);
			clearTimeout(release);
			writeFileSync(first, "release");
			writeFileSync(last, "release");
			await pending;
		}
		assert.ok(result, acrossPages ? "one total deadline bounds runs plus jobs" : "per-request timeout cancels hung gh");
		assert.equal(result.record.next, "retry", "a deadline never grants merge authority");
		assert.match(result.text, /read transport/, "spent retry budget reports the failed request without another attempt");
		assert.equal(result.calls.filter((call) => call.includes(acrossPages ? "attempts/1/jobs" : runsAt)).length, 1, "spent retry budget starts no further gh request");
		assert.deepEqual(mergedCalls(result.calls), []);
	}
});

test("landing S14: GitLab worker reports hold only on the project's MR and preserve named refusals", { skip: SKIP, timeout: 240_000 }, async (t) => {
	for (const mode of ["verified", "wrong-branch", "fork", "unavailable", "invalid", "foreign-host", "github"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { project: false, env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1", CP_E2E_GITLAB_TOKEN: "s14-fake-token" } });
		const lab = await startFakeGitlab(t, s.remote);
		await s.project("demo", { cloneUrl: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_E2E_GITLAB_TOKEN" } });
		const url = `${lab.web}/o/lab/-/merge_requests/12`;
		const body = { id: 9001, iid: 12, source_project_id: mode === "fork" ? 99 : 42, target_project_id: 42, state: "opened", get source_branch() { return mode === "wrong-branch" ? "someone-else" : s.post.ledger().read().jobs.at(-1)!.id; }, target_branch: "main", sha: s.repo.head("main"), web_url: url };
		lab.mrs[12] = mode === "unavailable" ? { status: 503, body: {} } : mode === "invalid" ? { body: "invalid MR" } : { body };
		const refusal = mode === "wrong-branch" ? /not this job's branch/ : mode === "fork" ? /unsupported:.*fork/ : mode === "foreign-host" ? /mismatch:/ : mode === "github" ? /not a GitLab merge request url/ : undefined;
		const given = mode === "foreign-host" ? "https://gitlab.attacker.example/o/lab/-/merge_requests/12" : mode === "github" ? "https://github.com/example/demo/pull/12" : url;
		const live = await s.held(`GitLab report ${mode}`, 12, { reportUrl: given, refusal });
		const record = s.post.fleet.require(live.jobId);
		assert.equal(s.ghCalls().length, 0);
		if (["foreign-host", "github"].includes(mode)) assert.equal(lab.asked.length, 0);
		else assert.ok(lab.asked.every((request) => request.path.includes("/merge_requests/12") && request.token === "s14-fake-token"));
		if (refusal) return;
		assert.equal(record.receipts?.find((receipt) => receipt.kind === "pr")?.url, url);
		const notes = readRunEvents(s.home, live.jobId).filter((event) => event.type === "pr_url_unverified");
		assert.equal(notes.length, ["unavailable", "invalid"].includes(mode) ? 1 : 0);
		if (notes.length) assert.match(JSON.stringify(notes), /GitLab gave no usable answer/);
	});
});

test("landing S14: unsafe existing PRs refuse before leasing or contacting a worker", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const cases: Array<{ name: string; patch?: Record<string, unknown>; reply?: Reply; ref?: string; expected: RegExp }> = [
		{ name: "merged", patch: { state: "MERGED" }, expected: /is MERGED/ },
		{ name: "closed", patch: { state: "CLOSED" }, expected: /is CLOSED/ },
		{ name: "fork", patch: { isCrossRepository: true }, expected: /from a fork.*push the fork branch to origin/ },
		{ name: "stacked", patch: { baseRefName: "release" }, expected: /targets release, not the project's default base main/ },
		{ name: "other repo", ref: "https://github.com/other/demo/pull/169", expected: /names other\/demo.*origin remote is example\/demo/ },
		{ name: "gh down", reply: { code: 1, stderr: "gh: command not found" }, expected: /gh could not read example\/demo#169.*gh: command not found/ },
		{ name: "invalid", reply: { stdout: "not json" }, expected: /not a readable PR/ },
		{ name: "no github", expected: /no GitHub origin remote/ },
	];
	for (const row of cases) await t.test(row.name, async (t) => {
		const s = await startStack(t, { github: row.name !== "no github" });
		const job = await s.post.ledger().create({ title: `unsafe bound ${row.name}`, project: "demo", kind: "ship", delivery: "pr" });
		const view = { number: 169, url: "https://github.com/example/demo/pull/169", state: "OPEN", isDraft: false, isCrossRepository: false, headRefName: "main", headRefOid: s.repo.head("main"), baseRefName: "main", ...row.patch };
		s.setGh({ routes: [{ match: "pr view 169", replies: [row.reply ?? json(view)] }] });
		const model = s.provider.addScript("unsafe", [{ kind: "text", text: "This worker must not start." }]);
		s.agentDir.writeModels(s.provider);
		await assert.rejects(s.post.dispatch({ jobId: job.id, task: "Finish existing PR.", pr: row.ref ?? "169", model, fetch: false }), row.expected);
		assert.equal(s.post.fleet.get(job.id), undefined);
		assert.equal(s.provider.requests("unsafe").length, 0);
	});
});

test("landing S14: binding an existing PR checks forge facts and preserves checkout history", { skip: SKIP, timeout: 240_000 }, async (t) => {
	for (const mode of ["absent", "behind", "diverged", "other-worktree", "moved", "held-holder", "failed-holder", "done-holder", "own-failed", "wrong-url", "moved-report"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { github: true });
		s.repo.git("switch", "-c", "feat");
		s.repo.write("a.txt", "one\n");
		const c1 = s.repo.commitAll("one");
		s.repo.write("a.txt", "two\n");
		const c2 = s.repo.commitAll("two");
		s.repo.git("push", "origin", "feat");
		const clone = s.post.registry.pathOf("demo");
		git(clone, "fetch", "origin");
		let local: string | undefined;
		if (mode !== "absent" && mode !== "moved") {
			git(clone, "switch", "-c", "feat", c1);
			if (mode === "diverged") {
				writeFileSync(join(clone, "local.txt"), "keep this commit\n");
				git(clone, "add", "local.txt");
				git(clone, "commit", "-m", "local history");
				local = git(clone, "rev-parse", "HEAD");
			}
			git(clone, "switch", "main");
		}
		if (mode === "other-worktree") git(clone, "worktree", "add", join(s.home, "other"), "feat");
		const job = await s.post.ledger().create({ title: `bound checkout ${mode}`, project: "demo", kind: "ship", delivery: "pr" });
		const url = "https://github.com/example/demo/pull/169";
		const view = { number: 169, url, state: "OPEN", isDraft: mode === "absent", isCrossRepository: false, headRefName: "feat", headRefOid: mode === "moved" ? c1 : c2, baseRefName: "main" };
		s.setGh({ routes: [{ match: "pr view 169", replies: mode === "moved-report" ? [json(view), json({ ...view, headRefName: "someone-else" })] : [json(view)] }] });
		const script = `bound-${mode}`;
		const model = s.provider.addScript(script, [{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: job.id, kind: "ship", status: "done", summary: "Bound PR ready.", branch: "feat", pr_url: mode === "wrong-url" ? url.replace("169", "170") : url, head_sha: c2 } }] }, { kind: "text", text: "standing by" }], { onExhausted: "repeat" });
		s.agentDir.writeModels(s.provider);
		const dispatch = () => s.post.dispatch({ jobId: job.id, task: "Finish the bound PR.", pr: mode === "absent" ? "https://github.com/EXAMPLE/Demo/pull/169" : "#169", model, fetch: false });
		if (mode === "own-failed") {
			const old = await s.seed("old own branch", { branch: "feat" });
			const record = s.post.fleet.require(old.jobId);
			await s.post.fleet.patch(old.jobId, { phase: "done", branch: "unrelated-legacy" });
			await s.post.fleet.add({ ...record, job_id: job.id, phase: "failed", failure: { class: "crash", message: "Legacy worker crash.", at: isoTimestamp() } });
		}
		if (mode.endsWith("-holder")) {
			const holder = await s.seed("legacy branch holder", { branch: "feat" });
			if (mode === "failed-holder") await s.post.fleet.patch(holder.jobId, { phase: "failed", failure: { class: "crash", message: "Legacy worker crash.", at: isoTimestamp() } });
			if (mode === "done-holder") await s.post.fleet.patch(holder.jobId, { phase: "done" });
			if (mode !== "done-holder") {
				await assert.rejects(dispatch(), new RegExp(`job ${holder.jobId}.*holds it.*promote that job`));
				assert.equal(s.provider.requests(script).length, 0);
				return;
			}
		}
		if (mode === "other-worktree" || mode === "moved") {
			await assert.rejects(dispatch(), mode === "moved" ? /not the PR head.*PR moved while dispatching/ : /checked out in another worktree/);
			assert.equal(s.provider.requests(script).length, 0);
			return;
		}
		assert.equal((await dispatch()).receipt, "accepted");
		let record = s.post.fleet.require(job.id);
		assert.equal(record?.branch, "feat");
		assert.equal(git(record!.worktree, "rev-parse", "HEAD"), c2);
		assert.equal(git(record!.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "feat");
		if (mode === "absent") assert.equal(git(record!.worktree, "rev-parse", "--abbrev-ref", "feat@{upstream}"), "origin/feat");
		if (local) {
			const refs = git(record!.worktree, "for-each-ref", "--format=%(objectname)", `refs/cp-salvage/${job.id}/`);
			assert.equal(refs, local);
		}
		record = (await waitFor(() => s.post.fleet.get(job.id), (row) => row?.phase === "held" || row?.envelope_correction !== undefined, { timeoutMs: 90_000, what: "bound worker report resolved" }))!;
		if (mode === "wrong-url" || mode === "moved-report") {
			assert.match(record.envelope_correction?.reason ?? "", mode === "wrong-url" ? /not the bound PR/ : /"someone-else", not this job's branch "feat"/);
			assert.equal(record.reported_at, undefined);
			assert.equal(record.phase, "waiting");
			assert.ok(s.ghCalls().every((call) => !call.startsWith("pr list")));
			return;
		}
		assert.equal(record.phase, "held");
		assert.equal(readRunEvents(s.home, job.id).filter((event) => ["pr_url_corrected", "pr_url_unverified"].includes(event.type)).length, 0);
		assert.equal(record.receipts?.find((receipt) => receipt.kind === "pr")?.url, url);
		const prompt = JSON.stringify(s.provider.requests(script)[0]!.body);
		assert.ok(prompt.includes(`Bound to ${url} (${mode === "absent" ? "draft" : "open"}), head feat at ${c2.slice(0, 12)}, base main`));
		for (const text of ["Bound to", "do not open a PR", "merging origin/main into it, never by rebase", "push fast-forward only", "never rewrite or drop existing commits"]) assert.ok(prompt.includes(text), text);
		assert.ok(s.ghCalls().filter((call) => call.startsWith("pr view")).every((call) => call.startsWith("pr view 169 --repo example/demo")));
		assert.ok(s.ghCalls().every((call) => !call.startsWith("pr list")));
	});
});

test("landing S14: worker PR reports resolve against the registered origin and drive the CI watch", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const typo = "https://github.com/typo/demo/pull/151";
	const canonical = "https://github.com/example/demo/pull/151";
	for (const mode of ["corrected", "absent", "mismatch-down", "matching-down"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { github: true });
		if (mode === "absent") s.setGh({ routes: [{ match: "pr list", replies: [json([])] }] });
		if (mode.endsWith("down")) s.setGh({ routes: [{ match: "pr list", replies: [{ code: 1, stderr: "gh: command not found" }] }] });
		const refusal = mode === "absent" ? /no PR is on branch.*example\/demo/ : mode === "mismatch-down" ? /typo\/demo.*example\/demo/ : undefined;
		const live = await s.held(`PR resolution ${mode}`, 151, { reportUrl: mode === "matching-down" ? canonical : typo, refusal });
		const record = s.post.fleet.require(live.jobId);
		if (refusal) {
			assert.equal(record.receipts?.some((receipt) => receipt.kind === "pr") ?? false, false);
			return;
		}
		assert.equal(record.receipts?.find((receipt) => receipt.kind === "pr")?.url, canonical);
		const events = readRunEvents(s.home, live.jobId);
		const event = events.filter((event) => event.type === (mode === "corrected" ? "pr_url_corrected" : "pr_url_unverified"));
		assert.equal(event.length, 1);
		assert.match(JSON.stringify(event[0]), mode === "corrected" ? /pr_url corrected:.*typo.*example/ : /pr_url unverified/);
		const calls = s.ghCalls();
		assert.ok(calls.some((call) => call.startsWith(`pr list --head ${live.jobId} --state all`) && call.includes("--repo example/demo")));
		if (mode === "corrected") {
			s.setGh({ routes: [], runs: [run(151, live.head, "completed", "success")] });
			await s.tick(live.jobId);
			assert.ok(s.ghCalls().some((call) => call.includes("repos/example/demo/pulls/151")));
			assert.ok(s.ghCalls().every((call) => !call.includes("repos/typo/")));
		}
	});
});

test("landing S14: repository permission reports the allowlist and each blocked cause", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const checks = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }];
	const reviews = [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }];
	const rows: Array<{ status?: string; draft?: boolean; decision?: string; mergeable?: string; rules?: unknown; rawRules?: string; baseAdvance?: boolean; requiredUpdate?: boolean; expected: RegExp }> = [
		{ status: "BLOCKED", decision: "REVIEW_REQUIRED", rules: reviews, expected: /permission: pending \(reviews\).*1 approving review/ },
		{ status: "BLOCKED", decision: "CHANGES_REQUESTED", expected: /permission: pending \(reviews\)/ },
		{ status: "BLOCKED", rules: checks, expected: /permission: pending \(checks\).*test/ },
		{ status: "BLOCKED", expected: /permission: pending \(unknown_block\).*cannot read why/ },
		{ status: "UNSTABLE", expected: /permission: pending \(unstable\).*403/ },
		{ status: "UNKNOWN", expected: /permission: retry/ },
		{ status: "CLEAN", mergeable: "UNKNOWN", expected: /permission: retry/ },
		{ expected: /permission: unreadable/ },
		{ status: "", expected: /permission: unreadable/ },
		{ status: "SOME_NEW_VALUE_GH_INVENTED", expected: /permission: unreadable/ },
		{ status: "BLOCKED", decision: "REVIEW_REQUIRED", rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false } }, { type: "pull_request", parameters: { required_approving_review_count: 2 } }], expected: /permission: pending \(reviews\).*2 approving review/ },
		{ status: "BLOCKED", rules: [{ type: "required_status_checks" }], expected: /permission: pending \(checks\)/ },
		{ status: "BLOCKED", rules: [], expected: /permission: pending \(unknown_block\)/ },
		{ status: "BLOCKED", rules: { message: "forbidden" }, expected: /permission: pending \(unknown_block\)/ },
		{ status: "BEHIND", expected: /permission: pending \(behind\)/ },
		{ status: "DIRTY", expected: /permission: pending \(conflict\)/ },
		{ status: "DRAFT", expected: /permission: pending \(draft\)/ },
		{ status: "CLEAN", draft: true, expected: /permission: pending \(draft\)/ },
		{ status: "BLOCKED", rawRules: "not json at all", expected: /permission: pending \(unknown_block\)/ },
		{ status: "BLOCKED", rawRules: "", expected: /permission: pending \(unknown_block\)/ },
		...[true, false, "true"].map((strict) => ({ status: "BLOCKED", baseAdvance: true, requiredUpdate: strict === true, rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: strict } }], expected: /permission: pending \(checks\)/ })),
		{ status: "BLOCKED", baseAdvance: true, rules: [{ type: "required_status_checks" }], expected: /permission: pending \(checks\)/ },
		{ status: "BLOCKED", baseAdvance: true, rules: [{ type: "pull_request", parameters: { strict_required_status_checks_policy: true } }], expected: /permission: pending \(unknown_block\)/ },
		{ status: "BLOCKED", baseAdvance: true, rules: [], expected: /permission: pending \(unknown_block\)/ },
		{ status: "BLOCKED", baseAdvance: true, expected: /permission: pending \(unknown_block\)/ },
	];
	for (const row of rows) await t.test(JSON.stringify(row), async (t) => {
		const s = await startStack(t);
		const live = await s.held("repository permission matrix", 141);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		if (row.baseAdvance) {
			const clone = s.post.registry.pathOf("demo");
			writeFileSync(join(clone, "base-advance.txt"), "The base advanced after this PR.\n");
			for (const args of [["add", "base-advance.txt"], ["commit", "-qm", "advance main"], ["push", "origin", "main"]]) execFileSync("git", args, { cwd: clone, stdio: "pipe" });
		}
		const view = { number: 141, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", isDraft: row.draft ?? false, mergeable: row.mergeable ?? "MERGEABLE", mergeStateStatus: row.status, reviewDecision: row.decision ?? "" };
		s.setGh({ integration: true, runs: [run(141, live.head, "completed", "success")], routes: [
			{ match: "pr view", replies: [json(view)] },
			{ match: "/rules/branches/", replies: row.rawRules !== undefined ? [{ stdout: row.rawRules }] : row.rules ? [json(row.rules)] : [{ code: 1, stderr: "HTTP 403" }] },
		] });
		const result = await s.integrate(live.jobId);
		assert.match(result.text, row.expected, JSON.stringify(row));
		if (row.status === "BLOCKED") assert.ok(result.calls.includes("api repos/{owner}/{repo}/rules/branches/main"));
		if (row.baseAdvance) assert.equal(result.text.includes("rules: main requires up-to-date branches"), row.requiredUpdate === true);
		assert.deepEqual(mergedCalls(result.calls), [], JSON.stringify(row));
	});
	for (const status of ["HAS_HOOKS", "CLEAN"]) await t.test(status, async (t) => {
		const a = await startStack(t);
		const allowed = await a.held(`permitted ${status}`, status === "CLEAN" ? 143 : 142);
		writeWindowPass(a.home, allowed.jobId, allowed.head, "2026-01-01T00:00:00Z");
		a.setGh({ integration: true, permission: status, routes: [], runs: [run(142, allowed.head, "completed", "success")] });
		const result = await a.integrate(allowed.jobId);
		assert.match(result.text, /permission: permitted/);
		assert.equal(mergedCalls(result.calls).length, 1);
	});
});

test(
	"landing: a denied, rate-limited, malformed, partial or capped Actions read never merges and names its cause; a full paged read finds page two's failure",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const s = await startStack(t);
		const { jobId, head } = await s.held("ci reads", 81);
		const runsAt = `actions/runs?head_sha=${head}`;
		const jobsOf = (id: number) => `actions/runs/${id}/attempts/1/jobs`;
		const green = [run(1, head, "completed", "success")];
		/** One advance against `routes`: CI unreadable, so `retry`, nothing merged and none of gh's raw output carried. */
		const unreadable = async (routes: Route[], pattern: RegExp, what: string) => {
			s.setGh({ runs: green, routes });
			const result = await s.integrate(jobId);
			assert.equal(result.record.next, "retry", `${what}: ${result.text}`);
			assert.match(result.record.reason, /could not read CI/, what);
			assert.match(result.text, pattern, `${what}: ${result.text}`);
			assert.ok(!result.text.includes("canary"), `${what}: gh's raw output reached the record`);
			assert.deepEqual(mergedCalls(result.calls), [], what);
			return result;
		};
		const label = `${CI_UNREADABLE_LABEL}; needs ${CI_READ_NEEDED}`;
		const ghDenied = (stderr: string, stdout = JSON.stringify({ message: "Resource not accessible by integration" })): Reply => ({ code: 1, stderr, stdout });

		// A JSON 403/404 is the token's denial, on the runs or a jobs page: the Actions-only label, no retry.
		const denied = await unreadable([{ match: runsAt, replies: [ghDenied(`gh: Resource not accessible by integration (HTTP 403) ${CANARY}`)] }], /denied/, "runs 403");
		assert.ok(denied.record.reason.includes(label), denied.record.reason);
		assert.equal(denied.calls.filter((call) => call.includes(runsAt)).length, 1, "a denial is not retried");
		const deniedJobs = await unreadable([{ match: jobsOf(1), replies: [ghDenied("gh: Not Found (HTTP 404)")] }], /denied/, "jobs 404");
		assert.ok(deniedJobs.record.reason.includes(label), "a denied jobs read is as loud as a denied runs read");
		const watched = await s.tick(jobId);
		assert.ok(watched.errors.some((error) => error.job_id === jobId), JSON.stringify(watched.errors));
		assert.equal(s.post.ciWatch.store.job(jobId)?.last_ci, "unreadable");
		assert.match(formatStatusTable(await s.post.status()), /waiting on: CI unreadable \(token\)/);
		const viewer = createViewer({ home: s.home, stateDir: join(s.home, LAYOUT.state), host: "127.0.0.1", port: 0, log: () => {} });
		await new Promise<void>((resolve) => viewer.listen(0, "127.0.0.1", resolve));
		try {
			const response = await fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/api/jobs`);
			const body = await response.json() as { jobs: Array<{ id: string }> };
			const job = body.jobs.find((row) => row.id === jobId);
			assert.ok(job, "the denied job reaches the viewer API");
			const bundled = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {CiSignal} from "./viewer-app/components/JobSignals.tsx"; export const draw=job=>render(h(CiSignal,{job}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
			const { draw } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.contents).toString("base64")}`) as { draw(job: unknown): string };
			const html = draw(job);
			assert.ok(html.includes(`>${CI_UNREADABLE_LABEL}</span>`), "rendered CI label matches the backend denial");
			assert.ok(html.includes(`needs ${CI_READ_NEEDED}`), "rendered CI advice matches the backend denial");
			assert.doesNotMatch(html, /checks|statuses/i);
		} finally {
			await new Promise<void>((resolve) => viewer.close(() => resolve()));
		}

		// A rate limit, on runs or jobs, is not the token: no label, no retry, and the watch says unknown.
		const limited = await unreadable([{ match: runsAt, replies: [{ code: 1, stderr: `gh: API rate limit exceeded (HTTP 403) ${CANARY}` }] }], /read rate_limited/, "runs rate limit");
		assert.ok(!limited.record.reason.includes(CI_UNREADABLE_LABEL), limited.record.reason);
		await unreadable([{ match: jobsOf(1), replies: [{ code: 1, stderr: "gh: API rate limit exceeded (HTTP 403)" }] }], /read rate_limited/, "jobs rate limit");
		await s.tick(jobId);
		assert.equal(s.post.ciWatch.store.job(jobId)?.last_ci, "unknown");

		// A 502 on a jobs page retries, then fails the whole read: never a run-only green.
		const flaky = await unreadable([{ match: jobsOf(1), replies: [{ code: 1, stderr: "gh: HTTP 502" }] }], /read transport.*status 502; empty body; 3 attempts/, "jobs 502");
		assert.equal(flaky.calls.filter((call) => call.includes(jobsOf(1))).length, 3);
		// An HTML 403 is a proxy page: transport with its status and body, never the token's denial.
		const html403 = await unreadable(
			[{ match: runsAt, replies: [{ code: 1, stderr: "gh: HTTP 403", stdout: "<html><title>Access denied</title></html>" }] }],
			/read transport.*status 403; body "<html><title>Access denied<\/title><\/html>"; 3 attempts/,
			"HTML 403",
		);
		assert.ok(!html403.record.reason.includes(CI_UNREADABLE_LABEL), html403.record.reason);
		// A persisting non-JSON body is one malformed fault: gh's status and a redacted preview, after three attempts.
		const page = await unreadable(
			[{ match: runsAt, replies: [{ stdout: `<!DOCTYPE html>\n<html>${CANARY} Unicorn!</html>` }] }],
			/read malformed.*not JSON; gh exit 0; body "<!DOCTYPE html> <html>\[redacted\] Unicorn!<\/html>"; 3 attempts/,
			"HTML 200",
		);
		assert.equal(page.calls.filter((call) => call.includes(runsAt)).length, 3);
		// A structurally wrong JSON page is not retried.
		const wrong = await unreadable([{ match: runsAt, replies: [json({ workflow_runs: [] })] }], /read malformed.*missing total_count/, "no total_count");
		assert.equal(wrong.calls.filter((call) => call.includes(runsAt)).length, 1);
		// Missing identity, wrong types, another head or a wrong job page are malformed, never skipped.
		const other = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
		const bodies: Reply[] = [
			{ stdout: "not json" },
			json({ total_count: 1, workflow_runs: {} }),
			runsBody([run(1, head, "completed", "success", { id: undefined })]),
			runsBody([run(1, head, "completed", "success", { run_attempt: "1" })]),
			runsBody([run(1, other, "completed", "success")]),
			runsBody([run(1, head, 3 as unknown as string, "success")]),
			json({ total_count: 1, workflow_runs: ["x"] }),
		];
		for (const body of bodies) await unreadable([{ match: runsAt, replies: [body] }], /read malformed/, `runs ${JSON.stringify(body)}`);
		const job = (over: Record<string, unknown>) => json({ total_count: 1, jobs: [{ id: 10, run_id: 1, run_attempt: 1, name: "test", status: "completed", conclusion: "success", steps: [], ...over }] });
		await unreadable([{ match: jobsOf(1), replies: [job({ run_id: 6 })] }], /malformed.*not of the run/, "a job of another run");
		await unreadable([{ match: jobsOf(1), replies: [job({ run_attempt: 2 })] }], /malformed.*not of attempt 1/, "a job of another attempt");
		await unreadable([{ match: jobsOf(1), replies: [job({ head_sha: other })] }], /malformed.*requested head/, "a job on another head");

		// A short read, the API ceiling, a conflicting duplicate or more than ten pages is incomplete, never a subset.
		await unreadable([{ match: runsAt, replies: [runsBody(green, 2)] }], /read incomplete.*read 1 of total_count 2/, "short read");
		await unreadable([{ match: runsAt, replies: [runsBody(green, 1000)] }], /read incomplete.*total_count 1000 past the API ceiling/, "API ceiling");
		const hundred = Array.from({ length: 100 }, (_, i) => run(i + 1, head, "completed", "success"));
		await unreadable(
			[{ match: `${runsAt}&per_page=100&page=1`, replies: [runsBody(hundred, 101)] }, { match: `${runsAt}&per_page=100&page=2`, replies: [runsBody([run(100, head, "completed", "failure")], 101)] }],
			/read incomplete.*conflicting duplicate 100/,
			"conflicting duplicate",
		);
		const pages = Array.from({ length: 10 }, (_, p) => ({
			match: `${runsAt}&per_page=100&page=${p + 1}&`,
			replies: [runsBody(Array.from({ length: 100 }, (_, i) => run(p * 1000 + i + 1, head, "completed", "success")), 999)],
		}));
		await unreadable(pages.map((route) => ({ ...route, match: route.match.slice(0, -1) })), /read incomplete.*more than 10 pages/, "page cap");

		// A null run status is unfinished, never success: wait, nothing merged.
		s.setGh({ runs: [run(1, head, null, null)], routes: [] });
		const nullStatus = await s.integrate(jobId);
		assert.notEqual(nullStatus.record.next, "review", nullStatus.text);
		assert.doesNotMatch(nullStatus.text, /ci: green/);

		// A truncated body recovers on the retry inside the same read.
		s.setGh({ runs: green, routes: [{ match: runsAt, replies: [{ stdout: '{"total_count":1,"workflow_runs":[{"id":1' }, { pass: true }] }] });
		const recovered = await s.integrate(jobId);
		assert.match(recovered.text, /ci: green/, recovered.text);
		assert.equal(recovered.calls.filter((call) => call.includes(runsAt)).length, 2);
		// GitHub's head_sha in upper case is still the pushed head.
		s.setGh({ runs: [run(1, head.toUpperCase(), "completed", "success")], routes: [] });
		const upper = await s.integrate(jobId);
		assert.match(upper.text, /ci: green/, upper.text);

		// 101 runs of one workflow name over two pages, the boundary run repeated, and 101 jobs on run 1: run 101 fails.
		const many = Array.from({ length: 101 }, (_, i) => run(i + 1, head, "completed", i === 100 ? "failure" : "success"));
		const jobs = Array.from({ length: 101 }, (_, i) => ({ id: 1000 + i, name: `job-${i}`, status: "completed", conclusion: "success", steps: [] }));
		s.setGh({ runs: many, jobs: { 1: jobs }, overlap: 1, routes: [] });
		const paged = await s.integrate(jobId);
		assert.match(paged.text, /ci: failed .*\(run 101 https:\/\/github\.com\/example\/demo\/actions\/runs\/101\)/, paged.text);
		const runsPage = (n: number) => `api repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=100&page=${n}`;
		assert.deepEqual(paged.calls.filter((call) => call.includes(`${runsAt}&`)), [runsPage(1), runsPage(2)], "the exact head, gh's placeholders");
		assert.ok(paged.calls.includes("api repos/{owner}/{repo}/actions/runs/1/attempts/1/jobs?per_page=100&page=2"), "attempt-bound jobs, paged");
		assert.equal(paged.calls.filter((call) => call.includes(jobsOf(1))).length, 2, "run 1's jobs are read on both pages");
		assert.deepEqual(mergedCalls(s.ghCalls()), [], "a red or unreadable head was merged");
	},
);

test(
	"landing: only an authoritative empty workflow list is no CI; every unanswered workflows read keeps its own cause and never reads as none",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const s = await startStack(t);
		const { jobId, head } = await s.held("no ci runs", 82);
		writeWindowPass(s.home, jobId, head, new Date().toISOString());
		/** Zero runs on the head and on the branch: cp_integrate asks the repository which workflows it has. */
		const configured = async (reply: Reply, what: string) => {
			s.setGh({ runs: [], routes: [{ match: "actions/workflows", replies: [reply] }] });
			const result = await s.integrate(jobId);
			const fact = result.record.facts.find((entry) => entry.startsWith("ci configuration: "));
			assert.ok(fact, `${what}: ${result.text}`);
			assert.deepEqual(result.calls.filter((call) => call.includes("actions/workflows")), ["api repos/{owner}/{repo}/actions/workflows"], `${what}: one gh call`);
			return { ...result, fact };
		};
		const unanswered: Array<[string, Reply, string]> = [
			["a 403", { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" }, "unreadable (unauthorized)"],
			["a 401", { code: 1, stderr: "gh: Bad credentials (HTTP 401)" }, "unreadable (unauthorized)"],
			["a network error", { code: 1, stderr: "dial tcp: lookup api.github.com: no such host" }, "unreadable (command_failed)"],
			["an empty stdout from a failed command", { code: 1 }, "unreadable (failed_silently)"],
			["a command killed by a signal", { code: "signal" }, "unreadable (failed_silently)"],
			["exit 0 with no stdout", { stdout: "   \n" }, "unreadable (empty_output)"],
			["output that is not JSON", { stdout: "<html>502 Bad Gateway</html>" }, "unreadable (unparsable)"],
			["JSON that is not an object", { stdout: "[]" }, "unreadable (unparsable)"],
			["an object without the documented fields", { stdout: '{"message":"Not Found"}' }, "unreadable (unparsable)"],
			["a truncated page", json({ total_count: 3, workflows: [] }), "present (workflows_present)"],
			["one workflow", json({ total_count: 1, workflows: [{ id: 7, name: "ci", state: "active" }] }), "present (workflows_present) — the repository has 1 Actions workflow(s)"],
		];
		// Anything but an authoritative empty list may hide red runs: the per-head human checkpoint, never a merge.
		for (const [index, [what, reply, verdict]] of unanswered.entries()) {
			const { record, fact, calls } = await configured(reply, what);
			assert.ok(fact.startsWith(`ci configuration: ${verdict}`) && / — ./.test(fact), `${what}: ${fact}`);
			assert.deepEqual([record.step, record.next], ["authorize", "surface"], `${what} must never read as no CI: ${record.reason}`);
			if (index === 0) assert.match(record.reason, /no CI runs are observable for .*, so cp_integrate cannot verify green on its own/);
			assert.deepEqual(mergedCalls(calls), [], what);
		}
		// "No workflows" goes on to the repository's own merge permission.
		const none = await configured(json({ total_count: 0, workflows: [] }), "an authoritative empty list");
		assert.match(none.fact, /^ci configuration: none \(authoritative_empty\) — .*reports 0 Actions workflows/);
		assert.notEqual(none.record.step, "authorize", none.text);
		assert.ok(none.record.facts.some((fact) => fact.startsWith("permission: permitted")), none.text);
	},
);

test(
	"landing: /doctor ci.<project> reads workflows, then the newest run and its attempt jobs; a refused read is loud and gh output never echoes",
	{ timeout: 300_000 },
	async (t) => {
		const s = await startStack(t, { project: false });
		const names = ["denied", "bare", "ci", "idle", "locked", "garbled", "flaky", "short"];
		// An https `.git` URL and an ssh URL name the same GitHub repository as a bare https one.
		const urls: Record<string, string> = { denied: "https://github.com/o/denied.git", bare: "git@github.com:o/bare.git" };
		for (const name of names) await s.post.registry.register({ name, clone_url: urls[name] ?? `https://github.com/o/${name}`, delivery: "pr" });
		await s.post.registry.register({ name: "lab", clone_url: "https://gitlab.com/o/lab.git", delivery: "pr" });
		const secret = "sentinel-credential-value";
		const sha = "a".repeat(40);
		const job = { id: 3, run_id: 9, run_attempt: 2, head_sha: sha, status: "completed", conclusion: "success" };
		s.setGh({
			routes: [
				{ match: "repos/o/denied/", replies: [{ code: 1, stderr: `HTTP 403: Resource not accessible by personal access token ${secret}` }] },
				{ match: "repos/o/bare/", replies: [json({ total_count: 0, workflows: [] })] },
				{ match: "repos/o/flaky/", replies: [{ code: 1, stderr: `dial tcp: i/o timeout ${secret}` }] },
				{ match: "/actions/workflows", replies: [json({ total_count: 2, workflows: [{}, {}] })] },
				{ match: "repos/o/idle/", replies: [json({ total_count: 0, workflow_runs: [] })] },
				{ match: "repos/o/garbled/", replies: [{ stdout: `<html>${secret}</html>` }] },
				{ match: "repos/o/locked/actions/runs/9/", replies: [{ code: 1, stderr: `HTTP 403: Resource not accessible by integration ${secret}` }] },
				{ match: "repos/o/short/actions/runs/9/", replies: [json({ total_count: 4, jobs: [job] })] },
				{ match: "/actions/runs/9/attempts/2/jobs", replies: [json({ total_count: 1, jobs: [job] })] },
				{ match: "/actions/runs?per_page=1", replies: [json({ total_count: 5, workflow_runs: [{ id: 9, run_attempt: 2, head_sha: sha, status: "completed", conclusion: "success" }] })] },
			],
		});
		const report = await s.post.doctor();
		const workflows = (r: string) => `api repos/o/${r}/actions/workflows`;
		const runs = (r: string) => `api repos/o/${r}/actions/runs?per_page=1&page=1`;
		const jobs = (r: string) => `api repos/o/${r}/actions/runs/9/attempts/2/jobs?per_page=100&page=1`;
		assert.deepEqual(
			s.ghCalls().filter((call) => call.startsWith("api repos/o/")),
			[
				workflows("denied"), workflows("bare"),
				workflows("ci"), runs("ci"), jobs("ci"),
				workflows("idle"), runs("idle"),
				workflows("locked"), runs("locked"), jobs("locked"),
				workflows("garbled"), runs("garbled"),
				workflows("flaky"),
				workflows("short"), runs("short"), jobs("short"),
			],
			"workflows, then the newest run and its attempt jobs, only where there is something to read",
		);
		const by = Object.fromEntries(report.findings.filter((f) => f.check.startsWith("ci.")).map((f) => [f.check, f]));
		for (const name of ["denied", "locked"]) {
			assert.equal(by[`ci.${name}`]?.severity, "warn");
			assert.equal(by[`ci.${name}`]?.what, `${CI_UNREADABLE_LABEL} for o/${name}`, "a denied jobs read is as loud as a denied workflows read");
			assert.match(by[`ci.${name}`]?.fix ?? "", /Actions read \+ Contents read \+ Metadata read \+ Pull requests read; classic: repo/);
			assert.doesNotMatch(by[`ci.${name}`]?.fix ?? "", /Checks|statuses/i, "never advises a grant that does not fix the read");
		}
		assert.deepEqual([by["ci.bare"]?.severity, by["ci.bare"]?.what], ["ok", "no Actions CI configured for o/bare (0 Actions workflows)"]);
		assert.deepEqual([by["ci.ci"]?.severity, by["ci.ci"]?.what], ["ok", "CI readable for o/ci (2 workflow(s); latest run and its 1 job(s) read)"]);
		assert.equal(by["ci.idle"]?.severity, "ok");
		assert.match(by["ci.idle"]?.what ?? "", /no runs yet, so run and job access is untested/, "workflows alone never claim jobs access");
		assert.doesNotMatch(by["ci.idle"]?.what ?? "", /^CI readable/);
		assert.deepEqual([by["ci.garbled"]?.severity, by["ci.garbled"]?.what], ["warn", "CI state unknown for o/garbled: the Actions read failed (malformed)"]);
		assert.equal(by["ci.flaky"]?.severity, "warn");
		assert.match(by["ci.flaky"]?.what ?? "", /CI state unknown/);
		assert.deepEqual([by["ci.short"]?.severity, by["ci.short"]?.what], ["warn", "CI state unknown for o/short: the Actions read failed (incomplete)"]);
		assert.equal(by["ci.lab"], undefined, "a non-GitHub project is not asked");
		assert.doesNotMatch(JSON.stringify(report), new RegExp(secret), "never prints what gh printed");
		// No gh on PATH at all: host.gh says so, and no project gets a ci.* finding.
		const withGh = process.env.PATH;
		process.env.PATH = join(s.home, "empty-bin");
		const blind = await s.post.doctor().finally(() => {
			process.env.PATH = withGh;
		});
		assert.deepEqual(blind.findings.filter((f) => f.check.startsWith("ci.")), [], "no gh: host.gh says so");
	},
);

test(
	"landing: an infra-only CI failure is claimed, then rerun once per head; a test failure, a cancel, a second attempt, a drain or an unreadable claim or job list goes to the parent",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const s = await startStack(t);
		const a = await s.held("infra rerun", 83);
		const b = await s.held("infra rerun refused", 84);
		const claimsFile = join(s.home, LAYOUT.ciRerunsFile);
		const claims = () => (existsSync(claimsFile) ? (JSON.parse(readFileSync(claimsFile, "utf8")) as { entries: Array<Record<string, unknown>> }).entries : []);
		const reruns = () => s.ghCalls().filter((call) => call.startsWith("run rerun"));
		/** One advance of `jobId` with run `id` failed (by default) on `head` and `jobs` as its attempt jobs. */
		const advance = async (jobId: string, failed: RunRow, jobs: Array<Record<string, unknown>>, routes: Route[] = []) => {
			s.setGh({ runs: [failed], jobs: { [String(failed.id)]: jobs }, routes });
			const result = await s.integrate(jobId);
			assert.deepEqual(mergedCalls(result.calls), []);
			return { ...result, fact: result.record.facts.find((entry) => entry.startsWith("ci rerun: ")) ?? "" };
		};
		const red = (over: Partial<RunRow> = {}) => run(41, a.head, "completed", "failure", over);
		const infra = [setupJob("Install treehouse")];

		// Not infra: the suite, the eval check, or a cancelled or timed-out job. Classified, never rerun or claimed.
		for (const step of ["Run suite (typecheck + tests)", "Eval contract check"]) {
			const tests = await advance(a.jobId, red(), [setupJob(step)]);
			assert.match(tests.fact, /^ci rerun: none — run 41: /, tests.text);
		}
		for (const conclusion of ["cancelled", "timed_out"]) assert.match((await advance(a.jobId, red(), [setupJob("Install treehouse", conclusion)])).fact, /^ci rerun: none — run 41: /);
		// A setup-looking build step, an infra job beside a failed suite, or a job with no failed step: not proven infra.
		const build = { id: 2, name: "a", status: "completed", conclusion: "failure", steps: [{ name: "Install build tools", status: "completed", conclusion: "failure" }] };
		const mixed = [setupJob("Install treehouse"), { ...setupJob("Run suite (typecheck + tests)"), id: 2, name: "other" }];
		const stepless = { id: 2, name: "a", status: "completed", conclusion: "failure", steps: [] };
		for (const jobs of [[build], mixed, [stepless]]) assert.match((await advance(a.jobId, red(), jobs)).fact, /^ci rerun: none — run 41: /);
		// A run that concluded cancelled or timed out, or a second attempt, is never rerun automatically.
		for (const conclusion of ["cancelled", "timed_out"]) {
			assert.match((await advance(a.jobId, red({ conclusion }), infra)).fact, new RegExp(`a run concluded ${conclusion}, which is never rerun automatically`));
		}
		const second = await advance(a.jobId, red({ run_attempt: 2 }), infra);
		assert.match(second.fact, /run 41 is on attempt 2: a second failure is the parent's/);
		assert.ok(second.calls.includes("api repos/{owner}/{repo}/actions/runs/41/attempts/2/jobs?per_page=100&page=1"), "the run's own attempt");
		// A draining home reads no CI at all, so it reruns nothing; an unreadable claim file fails closed.
		mkdirSync(dirname(drainFile(s.home)), { recursive: true });
		writeFileSync(drainFile(s.home), JSON.stringify({ state: "draining", started_at: "2026-10-04T15:00:00Z", deadline: "x", timeout_s: 1, jobs: [] }));
		const drained = await advance(a.jobId, red(), infra);
		assert.ok(drained.record.facts.includes("ci: not read — the parent is draining; no process is started"), drained.text);
		assert.deepEqual(drained.calls, []);
		rmSync(drainFile(s.home));
		mkdirSync(dirname(claimsFile), { recursive: true });
		writeFileSync(claimsFile, "{ not json");
		assert.match((await advance(a.jobId, red(), infra)).fact, /unparseable/);
		rmSync(claimsFile);
		// The rerun's own jobs read refused or short: nothing is claimed or rerun.
		const jobsAt = "actions/runs/41/attempts/1/jobs";
		const deniedJobs = await advance(a.jobId, red(), infra, [{ match: jobsAt, replies: [{ pass: true }, { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" }] }]);
		assert.match(deniedJobs.fact, /run 41 jobs unreadable: .*denied/);
		for (const partial of [json({ total_count: 2, jobs: [] }), { stdout: "{}" }, { stdout: "not json" }]) {
			assert.match((await advance(a.jobId, red(), infra, [{ match: jobsAt, replies: [{ pass: true }, partial] }])).fact, /run 41 jobs unreadable/);
		}
		assert.deepEqual([reruns(), claims()], [[], []], "none of those reran or claimed");

		// Infra only: claimed first, then rerun once; the same job and head never again.
		const rerun = await advance(a.jobId, red(), infra);
		assert.equal(rerun.record.next, "wait", rerun.text);
		assert.match(rerun.fact, /^ci rerun: infra-only failure in run 41 \("Install treehouse"\); reran the failed jobs once/);
		assert.match(rerun.record.reason, /Nothing was merged; the new attempt's CI fact resumes this/);
		assert.deepEqual(reruns(), ["run rerun 41 --failed"]);
		const atRerun = s.ghCalls().find((call) => call.startsWith("claims-at-rerun")) ?? "";
		assert.ok(atRerun.includes(a.jobId) && atRerun.includes(a.head), `the claim was on disk before gh run rerun ran: ${atRerun}`);
		assert.deepEqual(claims().map(({ at: _at, ...entry }) => entry), [{ job_id: a.jobId, head_sha: a.head, run_id: 41, step: "Install treehouse" }]);
		const again = await advance(a.jobId, red(), infra);
		assert.match(again.fact, /the one infra rerun for .* was spent at /);
		assert.equal(again.calls.filter((call) => call.includes("actions/runs/41/attempts/1/jobs")).length, 1, "only the CI read asks for jobs");
		assert.deepEqual(reruns(), ["run rerun 41 --failed"], "no second rerun");

		// gh refuses the rerun: the claim stands, the failure goes to the parent, and there is no second try.
		const refusedRun = run(51, b.head, "completed", "failure");
		const refused = await advance(b.jobId, refusedRun, [setupJob("Checkout")], [{ match: "run rerun 51", replies: [{ code: 1, stderr: "HTTP 403: forbidden" }] }]);
		assert.match(refused.fact, /claimed for infra-only run 51 \("Checkout"\) but gh refused \(51: HTTP 403: forbidden\) — the failure goes to the parent/);
		assert.equal(claims().filter((entry) => entry.job_id === b.jobId).length, 1);
		assert.match((await advance(b.jobId, refusedRun, [setupJob("Checkout")])).fact, /was spent at/);
		assert.deepEqual(reruns(), ["run rerun 41 --failed", "run rerun 51 --failed"]);
		for (const step of ["Set up job", "Checkout", "Set up Node", "Install dependencies"]) {
			rmSync(claimsFile, { force: true });
			const setup = await advance(a.jobId, red(), [setupJob(step)]);
			assert.equal(setup.record.next, "wait", setup.text);
			assert.ok(setup.fact.includes(`("${step}"); reran`), setup.fact);
			assert.equal(setup.calls.filter((call) => call === "run rerun 41 --failed").length, 1, step);
		}
	},
);



test(
	"landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const s = await startStack(t);
		await s.post.registry.setAfterMergeDeploy("demo", { branch: "main", task: "copy dist to host-a and restart", resources: ["host-a", "db"] });
		const mergedAt = new Date().toISOString();
		/** What `gh pr view <ref>` answers for a PR from `branch`: merged into main by default. */
		const answer = (ref: string, branch: string, over: Record<string, unknown> = {}, head = "a".repeat(40)) =>
			s.setGh({ routes: [{ match: `pr view ${ref}`, replies: [json({ number: Number(ref.split("/").pop()), url: ref.startsWith("https://") ? ref : `https://github.com/example/demo/pull/${ref}`,
				state: "MERGED", mergedAt, mergeCommit: { oid: MERGE }, headRefName: branch, headRefOid: head, baseRefName: "main", ...over })] }] });
		const nothing = (jobId: string) => assert.equal(existsSync(join(s.home, paths.mergeFile(jobId))), false, `${jobId} has no receipt`);
		const live = await s.held("merge receipt", 91);
		const prStatus = () => s.post.fleet.get(live.jobId)?.receipts?.filter((receipt) => receipt.kind === "pr").map((receipt) => receipt.status);

		// Not merged, merged with no merge commit, another branch's PR, or gh unreachable: nothing is written or changed.
		answer(live.prUrl, live.jobId, { state: "OPEN", mergeCommit: null }, live.head);
		await assert.rejects(s.post.recordMerge({ jobId: live.jobId }), /reports .* as open, not MERGED — nothing is recorded/);
		answer(live.prUrl, live.jobId, { mergeCommit: null }, live.head);
		await assert.rejects(s.post.recordMerge({ jobId: live.jobId }), /merged but names no merge commit/);
		answer(live.prUrl, "someone-elses-branch", {}, live.head);
		await assert.rejects(s.post.recordMerge({ jobId: live.jobId }), /is not this job's delivery/);
		s.setGh({ routes: [{ match: "pr view", replies: [{ code: 1, stderr: "gh: command not found" }] }] });
		await assert.rejects(s.post.recordMerge({ jobId: live.jobId }), (error: Error) => {
			assert.match(error.message, /could not read PR/);
			assert.match(error.message, new RegExp(`cp_teardown ${live.jobId} force`), "force stays the exit for the unprovable case");
			assert.ok(error.message.indexOf("git evidence") < error.message.indexOf("force"), "git evidence is offered first, force last");
			return true;
		});
		nothing(live.jobId);
		assert.deepEqual(prStatus(), ["open"], "a refusal changes nothing");

		// Merged and its head branch deleted: the receipt, the PR marked merged once, one journal event, one deploy job.
		execFileSync("git", ["-C", s.remote, "branch", "-D", live.jobId], { stdio: "ignore" });
		answer(live.prUrl, live.jobId, {}, live.head);
		const result = await s.post.recordMerge({ jobId: live.jobId, strategy: "squash" });
		assert.equal(result.recorded, true);
		assert.deepEqual([result.receipt.merge_commit_sha, result.receipt.head_sha, result.receipt.head_branch_deleted, result.receipt.strategy, result.receipt.bound], [MERGE, live.head, true, "squash", undefined]);
		assert.match(formatMerge(result), new RegExp(`cp_teardown ${live.jobId} can now pass without force`));
		assert.equal(readMergeReceipt(s.home, live.jobId)?.pr_url, live.prUrl);
		assert.deepEqual(prStatus(), ["merged"], "the PR receipt is updated, never duplicated");
		assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "merge_recorded").length, 1);
		const [deploy, ...extra] = deployJobs(s.post, live.jobId);
		assert.ok(deploy && extra.length === 0, "exactly one deploy job");
		for (const label of ["ops:deploy", "resource:host-a", "resource:db", "risk:high", "kind:research", "delivery:local", "project:demo"]) assert.ok(deploy.labels.includes(label), label);
		assert.deepEqual([deploy.blocked_by, deploy.status], [[live.jobId], "open"]);
		const taskFile = join(s.home, paths.afterMergeTaskFile(live.jobId));
		assert.equal(deploy.notes, `task_file: ${taskFile}`);
		const text = readFileSync(taskFile, "utf8");
		for (const fact of [MERGE, live.prUrl, "branch: main", "copy dist to host-a and restart", `deployed ${MERGE.slice(0, 12)}`, "rolled back:"]) assert.ok(text.includes(fact), fact);
		assert.match(result.after_merge ?? "", new RegExp(`after-merge deploy ${deploy.id} created \\(blocked until ${live.jobId} closes; no covering grant — dispatch needs a grant\\): cp_dispatch ${deploy.id} task_file=.* base=main`));
		assert.deepEqual({ ...afterMergeRecord(s.home, live.jobId), recorded_at: undefined }, {
			schema_version: 1, job_id: live.jobId, merge_commit_sha: MERGE, base_branch: "main", status: "created", deploy_job_id: deploy.id, coverage: "none", task_file: taskFile, recorded_at: undefined,
		});
		assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "after_merge_deploy").length, 1);
		assert.equal(s.post.fleet.get(deploy.id), undefined, "created, never dispatched");
		const preview = await s.post.previewDispatch({ jobId: deploy.id, task: "Deploy it." });
		assert.deepEqual([preview.profile, "routing" in preview ? preview.routing.risk : undefined], ["ops", "high"], "a deploy is ops and risk:high, never exempt");

		// Idempotent: a second call reads the receipt back; a pre-forge receipt with no forge block still reads.
		const again = await s.post.recordMerge({ jobId: live.jobId });
		assert.deepEqual([again.recorded, again.receipt.merge_commit_sha, "after_merge" in again], [false, MERGE, false]);
		assert.equal(result.receipt.forge?.provider, "github");
		const { forge: _forge, ...legacy } = result.receipt;
		writeFileSync(join(s.home, paths.mergeFile(live.jobId)), JSON.stringify(legacy));
		assert.equal((await s.post.recordMerge({ jobId: live.jobId })).receipt.head_sha, live.head, "a pre-forge receipt is still valid");
		// A crash before the after-merge record resumes onto the same job; a dropped deploy job still holds the key.
		rmSync(join(s.home, paths.afterMergeFile(live.jobId)));
		assert.match((await s.post.recordMerge({ jobId: live.jobId })).after_merge ?? "", new RegExp(`after-merge deploy ${deploy.id} created`));
		await s.post.ledger().drop(deploy.id, "operator dropped it");
		rmSync(join(s.home, paths.afterMergeFile(live.jobId)));
		await s.post.recordMerge({ jobId: live.jobId });
		assert.equal(deployJobs(s.post, live.jobId).length, 1, "a closed deploy job still holds the key");
		const down = await s.post.tearDown(live.jobId);
		assert.deepEqual([down.torn_down, down.reason], [true, "merged"], JSON.stringify(down.failure));

		// A bound job's receipt names the PR's head branch; a job with no PR receipt must be told which PR.
		const bound = await s.seed("bound job", { branch: "cp-b55w", bound: true });
		answer(bound.prUrl as string, "cp-b55w");
		const boundResult = await s.post.recordMerge({ jobId: bound.jobId });
		assert.deepEqual([boundResult.receipt.head_branch, boundResult.receipt.bound, readMergeReceipt(s.home, bound.jobId)?.bound], ["cp-b55w", true, true]);
		const bare = await s.seed("no pr receipt", { prUrl: false });
		await assert.rejects(s.post.recordMerge({ jobId: bare.jobId }), /carries no PR receipt/);
		answer("77", bare.jobId);
		assert.equal((await s.post.recordMerge({ jobId: bare.jobId, pr: "77" })).recorded, true);
		assert.equal(s.post.fleet.get(bare.jobId)?.receipts?.[0]?.status, "merged", "with no prior receipt there is one to add");
		await assert.rejects(s.post.recordMerge({ jobId: "cp-unknown" }), /no fleet record/);

		// Skipped: another base, no base, a merge before the opt-in; a project with no opt-in is silent.
		for (const [title, over, reason] of [
			["into develop", { baseRefName: "develop" }, /merged into develop, not the deploy branch main/],
			["no base", { baseRefName: undefined }, /names no base branch/],
			["before opt-in", { mergedAt: "2020-01-01T00:00:00Z" }, /before after_merge_deploy was enabled/],
		] as const) {
			const job = await s.seed(title);
			answer(job.prUrl as string, job.branch, over);
			assert.match((await s.post.recordMerge({ jobId: job.jobId })).after_merge ?? "", reason, title);
			assert.deepEqual([afterMergeRecord(s.home, job.jobId).status, deployJobs(s.post, job.jobId).length], ["skipped", 0], title);
			assert.match(afterMergeRecord(s.home, job.jobId).reason, reason);
		}
		await s.post.registry.register({ name: "plain", clone_url: "https://github.com/example/plain", delivery: "pr" });
		const plain = await s.seed("no opt-in", { project: "plain" });
		answer(plain.prUrl as string, plain.branch);
		assert.equal("after_merge" in (await s.post.recordMerge({ jobId: plain.jobId })), false);
		assert.equal(existsSync(join(s.home, paths.afterMergeFile(plain.jobId))), false);

		// Coverage is cp_dispatch's own grant selection: a grant naming the merged job enrolls, its cap refuses,
		// a project-wide grant covers, and one that excludes research does not.
		const issue = (extra: { job_ids?: string[]; job_cap?: number; ask_on?: "risk:high"[]; exclusions?: { job_kinds: "research"[] } } = {}) =>
			s.post.mandates.issue({ projects: ["demo"], objective: "ship and deploy", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: extra.job_cap ?? 10, ...extra });
		const covered = async (title: string, grant: (jobId: string) => { id: string }, line: (grantId: string) => RegExp) => {
			const job = await s.seed(title);
			const issued = grant(job.jobId);
			answer(job.prUrl as string, job.branch);
			assert.match((await s.post.recordMerge({ jobId: job.jobId })).after_merge ?? "", line(issued.id), title);
			const deployId = deployJobs(s.post, job.jobId)[0]?.id as string;
			return { job: job.jobId, grant: issued.id, deployId, record: afterMergeRecord(s.home, job.jobId) };
		};
		const named = await covered("named grant", (jobId) => issue({ job_ids: [jobId] }), (id) => new RegExp(`enrolled in ${id}`));
		assert.deepEqual([s.post.mandates.require(named.grant).job_ids, named.record.coverage, named.record.mandate_id], [[named.job, named.deployId], "enrolled", named.grant]);
		s.post.mandates.revoke(named.grant);
		const capped = await covered("capped grant", (jobId) => issue({ job_ids: [jobId], job_cap: 1 }), () => /no covering grant — dispatch needs a grant \(cannot enroll .*job cap 1 reached\)/);
		assert.deepEqual([capped.record.coverage, s.post.mandates.require(capped.grant).job_ids], ["none", [capped.job]]);
		s.post.mandates.revoke(capped.grant);
		const wide = await covered("project-wide grant", () => issue({ ask_on: ["risk:high"] }), (id) => new RegExp(`covered by project-wide ${id}`));
		assert.equal(wide.record.coverage, "project_wide");
		assert.equal((await s.post.previewDispatch({ jobId: wide.deployId, task: "Deploy it." })).mandate_gate, "would ask: risk:high", "the deploy's dispatch stays risk:high-gated");
		s.post.mandates.revoke(wide.grant);
		const excluded = await covered("research excluded", () => issue({ exclusions: { job_kinds: ["research"] } }), () => /no covering grant — dispatch needs a grant/);
		assert.equal(excluded.record.coverage, "none");
	},
);

test(
	"landing: cp_merged reads a GitLab MR only from the project's own GitLab with its token; a squash, or a fast-forward git sees on the target, is recorded and anything else records nothing",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const token = "glpat-canary-0123456789";
		const s = await startStack(t, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1", CP_E2E_GITLAB_TOKEN: token } });
		const lab = await startFakeGitlab(t, s.remote);
		await s.project("lab", { cloneUrl: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_E2E_GITLAB_TOKEN" } });
		const mrUrl = (iid: number, path = "o/lab") => `${lab.web}/${path}/-/merge_requests/${iid}`;
		/** The MR the fake GitLab answers for `iid`: merged into main from `branch`, no landing commit unless named. */
		const mr = (iid: number, branch: string, over: Record<string, unknown> = {}) => {
			const head = (over.sha as string | undefined) ?? "e".repeat(40);
			lab.mrs[iid] = { body: { id: 9000 + iid, iid, project_id: 42, source_project_id: 42, target_project_id: 42, state: "merged", source_branch: branch, target_branch: "main", sha: head,
				diff_refs: { head_sha: head, base_sha: "d".repeat(40), start_sha: "d".repeat(40) }, merge_commit_sha: null, squash_commit_sha: null, merged_at: "2026-08-31T15:55:07.123Z", web_url: mrUrl(iid), ...over } };
		};
		const refused = async (jobId: string, pattern: RegExp) => {
			await assert.rejects(s.post.recordMerge({ jobId }), (error: Error) => (assert.match(error.message, pattern), assert.doesNotMatch(error.message, new RegExp(token)), true));
			assert.equal(readMergeReceipt(s.home, jobId), undefined, `${jobId} has no receipt`);
		};

		// A squash MR: its squash commit, provider and project; the MR IID is the number; milliseconds are normalised.
		const squash = await s.seed("gitlab squash", { project: "lab", prUrl: mrUrl(7) });
		mr(7, squash.branch, { squash_commit_sha: "f".repeat(40), squash: true });
		const recorded = (await s.post.recordMerge({ jobId: squash.jobId })).receipt;
		assert.deepEqual(
			[recorded.merge_commit_sha, recorded.strategy, recorded.pr_number, recorded.merged_at, recorded.recorded_by, recorded.forge, recorded.head_branch_deleted],
			["f".repeat(40), "squash", 7, "2026-08-31T15:55:07Z", "gitlab api", { provider: "gitlab", project_url: `${lab.web}/o/lab` }, true],
		);
		const recordedEvents = () => readRunEvents(s.home, squash.jobId).filter((event) => event.type === "merge_recorded");
		assert.equal((recordedEvents()[0]?.payload as { provider?: string } | undefined)?.provider, "gitlab");
		assert.deepEqual(lab.asked, [{ path: "/api/v4/projects/o%2Flab/merge_requests/7", token }], "one GET of the project's own MR, its token in PRIVATE-TOKEN");
		assert.deepEqual(s.ghCalls().filter((call) => call.startsWith("pr view")), [], "GitLab is never asked through gh");

		// A crash before the fleet patch is repaired with no second event; a stored receipt for another branch is refused.
		await s.post.fleet.patch(squash.jobId, { receipts: [{ kind: "pr", status: "open", title: "PR", url: mrUrl(7) }] });
		const repaired = await s.post.recordMerge({ jobId: squash.jobId });
		assert.deepEqual([repaired.recorded, repaired.receipt_status_updated, s.post.fleet.get(squash.jobId)?.receipts?.[0]?.status, recordedEvents().length], [false, true, "merged", 1]);
		await s.post.fleet.patch(squash.jobId, { branch: "cp-other" });
		await assert.rejects(s.post.recordMerge({ jobId: squash.jobId }), /discharges nothing here/);

		// A merge commit wins over a squash commit, taken as named (no reachability asked); alone it infers no strategy.
		const both = await s.seed("gitlab merge and squash", { project: "lab", prUrl: mrUrl(10) });
		mr(10, both.branch, { merge_commit_sha: "a".repeat(40), squash_commit_sha: "f".repeat(40) });
		const viaMerge = (await s.post.recordMerge({ jobId: both.jobId })).receipt;
		assert.deepEqual([viaMerge.merge_commit_sha, viaMerge.head_sha, viaMerge.base_branch, viaMerge.strategy], ["a".repeat(40), "e".repeat(40), "main", "squash"]);
		const plainMerge = await s.seed("gitlab merge commit", { project: "lab", prUrl: mrUrl(11) });
		mr(11, plainMerge.branch, { merge_commit_sha: "a".repeat(40) });
		const viaPlain = (await s.post.recordMerge({ jobId: plainMerge.jobId })).receipt;
		assert.deepEqual([viaPlain.merge_commit_sha, viaPlain.strategy], ["a".repeat(40), "unknown"]);

		// A fast-forward MR names no landing commit: its head counts only once git sees it on origin's target.
		const ff = await s.seed("gitlab fast-forward", { project: "lab", prUrl: mrUrl(9) });
		mr(9, ff.branch, { sha: "1".repeat(40) });
		await refused(ff.jobId, /merged but names no merge commit/);
		const tip = advanceBase(s.repo, "docs/ff.md", "# fast-forwarded\n");
		mr(9, ff.branch, { sha: tip });
		const fastForward = await s.post.recordMerge({ jobId: ff.jobId });
		assert.deepEqual([fastForward.receipt.merge_commit_sha, fastForward.receipt.strategy, s.post.fleet.get(ff.jobId)?.receipts?.[0]?.status], [tip, "unknown", "merged"]);

		// An answer naming another project's MR is a mismatch, and nothing is recorded.
		const other = await s.seed("gitlab mismatch", { project: "lab", prUrl: mrUrl(8) });
		mr(8, other.branch, { web_url: mrUrl(8, "o/other") });
		await refused(other.jobId, /could not read PR .*\(mismatch: /);
		assert.ok(lab.asked.every((request) => request.token === token));
	},
);

test(
	"landing: cp_teardown passes a deleted branch as landed_by_git when origin's base holds its content (merge, squash, rebase, a later edit, literal odd paths) and keeps the lease when it does not",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const s = await startStack(t);
		const push = (branch: string, work: string) => `${work} && git add -A && git commit -q -m work && git push -q -u origin ${branch}`;
		const local = (title: string, work: (branch: string) => string) => s.held(title, 0, { delivery: "local", command: work });
		const mainTip = () => git(s.remote, "rev-parse", "refs/heads/main");
		const ancestor = (a: string, b: string) => spawnSync("git", ["-C", s.remote, "merge-base", "--is-ancestor", a, b]).status === 0;
		const landed = async (jobId: string, method: string) => {
			const down = await s.post.tearDown(jobId);
			assert.deepEqual([down.torn_down, down.reason, down.landing?.method], [true, "landed_by_git", method], JSON.stringify(down.failure));
			assert.equal(readRunEvents(s.home, jobId).filter((event) => event.type === "teardown_landing_proven").length, 1);
			return down.landing as NonNullable<typeof down.landing>;
		};

		const unpushed = async (jobId: string, label: string) => {
			const down = await s.post.tearDown(jobId);
			assert.deepEqual([down.torn_down, down.failure?.code], [false, "unpushed"], `${label}: ${JSON.stringify(down)}`);
			assert.match(down.failure?.message ?? "", /survives here only as a stale remote-tracking ref .* and origin\/main does not contain its content/, label);
		};

		// An ordinary merge commit keeps the head an ancestor of the base.
		const merged = await local("merge commit", (b) => push(b, "printf 'm1\\n' > src/merge.ts"));
		mergeAndDeleteHead(s.repo, merged.jobId);
		await landed(merged.jobId, "ancestry");

		const extra = await local("post-squash extra commit", (b) => push(b,
			"printf 'first\\n' > src/post-squash.ts && git add -A && git commit -q -m first && printf 'extra\\n' > src/post-squash-extra.ts"));
		landOnOrigin(s.repo, "printf 'first\\n' > src/post-squash.ts", "only the earlier commit landed");
		git(s.remote, "branch", "-D", extra.jobId);
		await unpushed(extra.jobId, "post-squash extra commit remains unlanded");

		// Two commits squashed into one new sha between unrelated base commits, then a later edit of a touched file:
		// an older base commit at or after the squash is the witness, every changed path (a deletion too) is compared.
		const squashed = await local("multi-commit squash", (b) =>
			push(b, "printf 'b2\\n' > src/b.ts && git commit -qam one && printf 'n1\\n' > src/new.ts && git rm -q src/a.ts"));
		advanceBase(s.repo, "docs/before.md", "# before\n");
		const squash = squashMergeAndDeleteHead(s.repo, squashed.jobId);
		advanceBase(s.repo, "docs/after.md", "# after\n");
		advanceBase(s.repo, "src/b.ts", "b3\n");
		const viaSquash = await landed(squashed.jobId, "path_tree");
		assert.deepEqual([viaSquash.paths, viaSquash.base_sha], [3, mainTip()], "every changed path; the base sha is origin's own");
		assert.notEqual(viaSquash.witness, viaSquash.base_sha);
		assert.ok(ancestor(squash, viaSquash.witness) && ancestor(viaSquash.witness, viaSquash.base_sha), "a reachable witness at or after the squash");

		// A rebase onto a base that moved first replays the head as a new sha.
		const rebased = await local("rebase", (b) => push(b, "printf 'c1\\n' > src/c.ts"));
		advanceBase(s.repo, "docs/first.md", "# first\n");
		const replayed = rebaseMergeAndDeleteHead(s.repo, rebased.jobId);
		assert.notEqual(replayed, rebased.head);
		assert.equal((await landed(rebased.jobId, "path_tree")).witness, replayed);

		// Path names with spaces, newlines and pathspec magic are compared literally: `star*[ab].txt` must not also
		// compare the base's own `starXa.txt`, which the head never had.
		const odd = await local("odd paths", (b) =>
			push(b, "mkdir -p 'dir with space' && printf 'x\\n' > $'dir with space/new\\nline.txt' && printf 'y\\n' > 'star*[ab].txt' && printf 'z\\n' > ':(glob)lead.txt'"));
		advanceBase(s.repo, "starXa.txt", "base only\n");
		squashMergeAndDeleteHead(s.repo, odd.jobId);
		advanceBase(s.repo, "docs/odd.md", "# odd\n");
		assert.equal((await landed(odd.jobId, "path_tree")).paths, 3);

		// A stale tracking ref that held the squash is not the base origin advertises: it keeps the lease.
		const stale = await local("stale tracking ref", (b) => push(b, "printf 's1\\n' > src/stale.ts"));
		const staleSquash = squashMergeAndDeleteHead(s.repo, stale.jobId);
		git(stale.worktree, "fetch", "--quiet", "origin");
		assert.equal(git(stale.worktree, "rev-parse", "refs/remotes/origin/main"), staleSquash, "the worktree's tracking ref holds the squash");
		git(s.remote, "update-ref", "refs/heads/main", `${staleSquash}^`);
		advanceBase(s.repo, "docs/elsewhere.md", "# moved elsewhere\n");
		await unpushed(stale.jobId, "stale tracking ref");

		// One near miss at a time on origin (whitespace, a binary byte, the mode, a symlink, an unlanded delete, half
		// a rename) keeps the lease; only the base that carries every path exactly as HEAD has it lands.
		const exact = "printf 'x = 1;\\n' > src/a.ts && printf '\\000\\001\\002' > img.bin && printf 'echo hi\\n' > run.sh && chmod 755 run.sh && ln -sfn src/a.ts link && rm -f src/b.ts && printf 'b1\\n' > src/moved.ts";
		const near = await local("near misses", (b) => push(b, exact));
		git(s.remote, "branch", "-D", near.jobId);
		for (const [label, miss] of [
			["whitespace", "printf 'x =  1;\\n' > src/a.ts"],
			["binary byte", "printf '\\000\\001\\003' > img.bin"],
			["mode", "chmod 644 run.sh"],
			["symlink as a file", "rm link && printf 'src/a.ts' > link"],
			["delete not landed", "printf 'b1\\n' > src/b.ts"],
			["half a rename", "rm src/moved.ts"],
		] as const) {
			landOnOrigin(s.repo, `${exact} && ${miss}`, label);
			await unpushed(near.jobId, label);
		}
		landOnOrigin(s.repo, `${exact} && printf 'u\\n' > unrelated.md`, "exact, beside an unrelated file");
		assert.equal((await landed(near.jobId, "path_tree")).paths, 6);
	},
);



test("landing S02: only reported held PR deliveries are queried", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch eligibility", 201);
	const original = structuredClone(s.post.fleet.get(live.jobId)!);
	const variants = [
		...(["waiting", "done"] as const).map((phase) => ({ phase })),
		{ phase: "failed" as const, failure: { class: "crash" as const, message: "exit 1", at: isoTimestamp() } },
		...(["local", "pipeline"] as const).map((delivery) => ({ delivery })),
		{ receipts: [] },
		{ receipts: [{ kind: "artifact" as const, status: "written", title: "report" }] },
		...["merged", "landed", "MERGED", " merged "].map((status) => ({ receipts: original.receipts!.map((receipt) => ({ ...receipt, status })) })),
	];
	for (const patch of variants) await t.test(JSON.stringify(patch), async () => {
		const file = join(s.home, LAYOUT.fleetFile);
		const fleet = JSON.parse(readFileSync(file, "utf8"));
		fleet.jobs = fleet.jobs.map((entry: { job_id: string }) => entry.job_id === live.jobId ? { ...original, ...patch } : entry);
		writeFileSync(file, JSON.stringify(fleet));
		const before = s.ghCalls().length;
		const tick = await s.post.ciTick();
		assert.ok(!tick.checked.includes(live.jobId), JSON.stringify(patch));
		assert.ok(!tick.skipped.includes(live.jobId), JSON.stringify(patch));
		assert.equal(s.ghCalls().length, before, "excluded deliveries make no forge request");
	});
	await s.post.fleet.patch(live.jobId, original);
	s.setGh({ runs: [run(201, live.head, "completed", "success")] });
	const tick = await s.post.ciTick();
	assert.equal(tick.observations[0]?.event, "ci_green", "the eligible delivery is queried");
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	const parked = await s.post.awaitingMerge.park(live.jobId, { pr_url: live.prUrl, repo: "example/demo", head_sha: live.head, base: "main", handed_at: isoTimestamp() });
	assert.equal(parked.parked, true);
	const before = s.ghCalls().length;
	assert.deepEqual((await s.post.ciTick()).checked, [], "parked jobs are never ticked by the held watch");
	assert.equal(s.post.ciWatch.head(live.jobId), live.head, "parked rows survive held-watch pruning");
	assert.equal(s.ghCalls().length, before);
	const legacy = await s.seed("legacy slot without an envelope", { prUrl: "https://github.com/example/demo/pull/327" });
	const fleetFile = join(s.home, LAYOUT.fleetFile);
	const fleet = JSON.parse(readFileSync(fleetFile, "utf8"));
	delete fleet.jobs.find((entry: { job_id: string }) => entry.job_id === legacy.jobId).reported_at;
	writeFileSync(fleetFile, JSON.stringify(fleet));
	const unreported = await s.post.ciTick();
	assert.ok(!unreported.checked.includes(legacy.jobId), "a held legacy slot without an envelope stamp is not watched");
	assert.match(unreported.errors[0]?.message ?? "", /reported_at/, "the fleet boundary rejects an unreported held slot before watcher eligibility");
});

test("landing S02: aggregate CI and terminal PR facts preserve the current head", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch aggregate and terminal facts", 202);
	const observe = async (rows: RunRow[], pr?: Record<string, unknown>) => {
		s.setGh({ runs: rows, routes: [
			{ match: "actions/runs?", replies: [runsBody(rows)] },
			...(pr ? [{ match: "repos/example/demo/pulls/202", replies: [json({ number: 202, html_url: live.prUrl, head: { sha: live.head, ref: live.jobId }, ...pr })] }] : []),
		] });
		return s.tick(live.jobId);
	};
	assert.deepEqual((await observe([])).observations, [], "no runs is no verdict");
	assert.deepEqual((await observe([run(202, "a".repeat(40), "completed", "success")])).observations, [], "a superseded green is no verdict");
	assert.deepEqual((await observe([run(202, live.head, "completed", "success"), run(203, live.head, "in_progress", null)])).observations, [], "one unfinished workflow defers the aggregate");
	const green = (await observe([run(202, live.head, "completed", "success"), run(203, live.head, "completed", "skipped")])).observations;
	assert.equal(green.length, 1);
	assert.equal(green[0]?.event, "ci_green");
	assert.equal(green[0]?.head_sha, live.head);
	s.post.confirmCi(green.map((fact) => fact.key));
	assert.deepEqual((await observe([run(202, live.head, "completed", "success"), run(203, live.head, "completed", "skipped")])).observations, [], "confirmed facts wake once");
	const red = (await observe([run(204, live.head, "completed", "failure")])).observations;
	assert.equal(red.length, 1);
	assert.equal(red[0]?.event, "ci_failed");
	assert.equal(red[0]?.workflow, "ci");
	assert.equal(red[0]?.conclusion, "failure");
	const mergedAt = "2026-08-31T17:55:07Z";
	const merged = (await observe([run(204, live.head, "completed", "failure")], { merged: true, state: "closed", merge_commit_sha: "b".repeat(40), merged_at: mergedAt })).observations;
	assert.equal(merged.length, 1, "a merge supersedes CI");
	assert.equal(merged[0]?.event, "pr_merged");
	assert.equal(merged[0]?.merge_commit_sha, "b".repeat(40));
	assert.equal(merged[0]?.merged_at, mergedAt);
	const closed = (await observe([], { merged: false, state: "closed", closed_at: mergedAt })).observations;
	assert.equal(closed.length, 1);
	assert.equal(closed[0]?.event, "pr_closed");
	assert.equal(closed[0]?.closed_at, mergedAt);
});

test("landing S02: Actions refuses historical runs without a database id", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("legacy Actions identity", 326);
	const row = run(326, live.head, "completed", "failure");
	delete row.id;
	s.setGh({ runs: [row], routes: [{ match: "actions/runs?", replies: [runsBody([row])] }] });
	const result = await s.post.ciTick();
	assert.deepEqual(result.observations, [], "a malformed Actions run never becomes a legacy event");
	assert.match(result.errors[0]?.message ?? "", /run without id or run_attempt/);
});

test("landing S02: watch delivery, restart and query cadence survive real forge failures", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch delivery and cadence", 203);
	s.setGh({ runs: [run(203, live.head, "completed", "success")] });
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const advance = (ms: number) => t.mock.timers.tick(ms);
	const row = () => s.post.ciWatch.store.job(live.jobId)!;
	const first = await s.post.ciTick();
	assert.equal(first.observations.length, 1);
	assert.equal(Date.parse(row().next_due_at!) - Date.parse(row().last_checked_at!), 5_000, "settled heads use idle cadence");
	const before = s.ghCalls().length;
	assert.ok((await s.post.ciTick()).skipped.includes(live.jobId));
	assert.equal(s.ghCalls().length, before, "not-due ticks make no request");
	advance(5_000);
	assert.deepEqual((await s.post.ciTick()).observations, [], "queued delivery is not immediately resent");
	advance(601_000);
	const resend = await s.post.ciTick();
	assert.deepEqual(resend.observations.map((fact) => fact.key), first.observations.map((fact) => fact.key), "one resend preserves identity");
	advance(601_000);
	assert.deepEqual((await s.post.ciTick()).observations, [], "never a third send");
	assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "ci_observed").length, 1, "resends never duplicate the journal");
	s.post.confirmCi(first.observations.map((fact) => fact.key));
	const observed = s.post.ciWatch.observedAt(live.jobId);
	for (let failure = 1; failure <= 12; failure++) {
		s.setGh({ routes: [{ match: "repos/example/demo/pulls/203", replies: [{ code: 1, stderr: "network unreachable" }] }] });
		advance(900_000);
		const tick = await s.post.ciTick();
		assert.equal(tick.errors.length, 1);
		assert.equal(row().last_ci, "unknown", "a failed read never keeps stale green");
		assert.equal(s.post.ciWatch.observedAt(live.jobId), observed, "failed queries never refresh an unread head");
		assert.equal(row().head_sha, live.head);
		assert.equal(row().consecutive_failures, failure);
		assert.equal(Date.parse(row().next_due_at!) - Date.parse(row().last_checked_at!), Math.min(900_000, 1_000 * 2 ** (failure - 1)), "errors back off exponentially and cap");
	}
	const legacy = await s.seed("watch legacy missing head", { prUrl: live.prUrl, branch: "cp-missing-branch" });
	const watchFile = join(s.home, LAYOUT.ciWatchFile);
	const memory = JSON.parse(readFileSync(watchFile, "utf8"));
	memory.jobs.push({ ...row(), job_id: legacy.jobId });
	writeFileSync(watchFile, JSON.stringify(memory));
	s.setGh({ routes: [{ match: "repos/example/demo/pulls/203", replies: [json({ state: "open", merged: false })] }] });
	advance(900_000);
	await s.post.ciTick();
	assert.equal(s.post.ciWatch.observedAt(legacy.jobId), observed, "an unresolved head never refreshes the old observation");
	await s.post.fleet.patch(legacy.jobId, { phase: "done" });
	s.setGh({ routes: [{ match: "actions/runs?", replies: [{ code: 1, stderr: "Resource not accessible by personal access token (HTTP 403)" }] }] });
	advance(900_000);
	await s.post.ciTick();
	assert.equal(row().last_ci, "unreadable");
	s.setGh({ runs: [run(203, live.head, "in_progress", null)], routes: [] });
	advance(900_000);
	const beforeOverlap = s.ghCalls().filter((call) => call.includes("/pulls/203")).length;
	const [a, b] = await Promise.all([s.post.ciTick(), s.post.ciTick()]);
	assert.deepEqual(a, b, "overlapping callers share the result");
	assert.equal(s.ghCalls().filter((call) => call.includes("/pulls/203")).length - beforeOverlap, 1, "overlapping ticks query once");
	assert.equal(row().consecutive_failures, 0, "success resets failures");
	assert.equal(Date.parse(row().next_due_at!) - Date.parse(row().last_checked_at!), 1_000, "unfinished heads use base cadence");
	s.setGh({ runs: [run(203, live.head, "completed", "success")], routes: [] });
	advance(900_000);
	await s.post.shutdown();
	const restarted = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => restarted.shutdown());
	assert.deepEqual((await restarted.ciTick()).observations, [], "confirmed arrival survives reconstruction");
	s.setGh({ runs: [run(206, live.head, "completed", "failure")], routes: [] });
	advance(900_000);
	const redArrival = await restarted.ciTick();
	assert.equal(redArrival.observations[0]?.event, "ci_failed");
	restarted.confirmCi(redArrival.observations.map((fact) => fact.key));
	await restarted.shutdown();
	const redRestart = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	try {
		advance(900_000);
		assert.deepEqual((await redRestart.ciTick()).observations, [], "confirmed red attempt survives reconstruction");
	} finally {
		await redRestart.shutdown();
	}
	s.setGh({ runs: [run(203, live.head, "in_progress", null)], routes: [] });
	const savedInterval = process.env.CP_CI_WATCH_SECONDS;
	try {
		for (const value of [undefined, "", "nope", "0", "-5", "120"]) {
			if (value === undefined) delete process.env.CP_CI_WATCH_SECONDS;
			else process.env.CP_CI_WATCH_SECONDS = value;
			advance(900_000);
			const configured = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, holdsParentLock: () => true });
			try {
				await configured.ciTick();
				const state = configured.ciWatch.store.job(live.jobId)!;
				assert.equal(Date.parse(state.next_due_at!) - Date.parse(state.last_checked_at!), value === "120" ? 120_000 : 60_000, `watch interval ${JSON.stringify(value)}`);
			} finally {
				await configured.shutdown();
			}
		}
	} finally {
		if (savedInterval === undefined) delete process.env.CP_CI_WATCH_SECONDS;
		else process.env.CP_CI_WATCH_SECONDS = savedInterval;
	}
	t.mock.timers.reset();
});

test("landing S02: unavailable gh disables GitHub queries while GitLab remains observable", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1" } });
	const live = await s.held("watch without gh", 204);
	const lab = await startFakeGitlab(t, s.remote);
	await s.project("lab", { cloneUrl: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web } });
	const mrUrl = `${lab.web}/o/lab/-/merge_requests/7`;
	const seeded = await s.seed("watch GitLab", { project: "lab", prUrl: mrUrl });
	const mr = (state: string) => ({ iid: 7, source_project_id: 42, target_project_id: 42, state, source_branch: seeded.branch, target_branch: "main", sha: live.head, web_url: mrUrl, merge_commit_sha: "b".repeat(40), merged_at: "2026-08-31T18:30:00Z" });
	lab.mrs[7] = { body: mr("opened") };
	s.setGh({ routes: [{ match: "repos/example/demo/pulls/204", replies: [{ code: 1, stderr: "spawn gh ENOENT" }] }] });
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const first = await s.post.ciTick();
	assert.match(first.disabled ?? "", /gh is not available/);
	assert.deepEqual(first.checked, [live.jobId, seeded.jobId]);
	assert.deepEqual(first.observations, [], "open GitLab with no CI is not green");
	const calls = s.ghCalls().length;
	lab.mrs[7] = { status: 503, body: { message: "unavailable" } };
	t.mock.timers.tick(900_000);
	const failure = await s.post.ciTick();
	assert.equal(failure.errors[0]?.job_id, seeded.jobId, "GitLab failures stay scoped to their job");
	lab.mrs[7] = { body: mr("closed") };
	t.mock.timers.tick(900_000);
	const closed = await s.post.ciTick();
	assert.equal(closed.observations[0]?.event, "pr_closed");
	lab.mrs[7] = { body: mr("merged") };
	t.mock.timers.tick(900_000);
	const merged = await s.post.ciTick();
	assert.deepEqual(merged.checked, [seeded.jobId]);
	assert.equal(merged.observations[0]?.event, "pr_merged");
	assert.equal(merged.observations[0]?.merge_commit_sha, "b".repeat(40));
	assert.equal(merged.observations[0]?.pr_url, mrUrl);
	assert.equal(s.ghCalls().length, calls, "disabled GitHub stops querying during all subsequent GitLab reads");
	const restarted = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...s.agentDir.env }, holdsParentLock: () => true });
	t.after(() => restarted.shutdown());
	t.mock.timers.tick(900_000);
	const replay = await restarted.ciTick();
	assert.equal(replay.observations[0]?.key, merged.observations[0]?.key, "a fresh public command post re-derives the same unconfirmed GitLab merge identity");
	const afterRestart = s.ghCalls().length;
	s.post.confirmCi(merged.observations.map((fact) => fact.key));
	t.mock.timers.tick(900_000);
	assert.deepEqual((await s.post.ciTick()).observations, [], "GitLab merge arrival wakes once");
	assert.equal(s.ghCalls().length, afterRestart, "the disabled watcher still makes no GitHub query after the separate restart");
	t.mock.timers.reset();
});

test("landing S02: watcher queries stay nonblocking while workers refuse CI waits", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch nonblocking policy", 205, { before: ["gh run watch 12345 --exit-status", "gh pr checks 61 --watch", "sleep 60; gh run list --branch example --limit 3"] });
	const messages = JSON.stringify(s.provider.requests(`landing-${live.jobId}`).map((request) => request.body.messages));
	assert.match(messages, /A worker never waits for CI/);
	assert.match(messages, /sleep_then_poll/);
	assert.match(messages, /blocking_watch/);
	const replies = s.provider.requests(`landing-${live.jobId}`).at(-1)?.body.messages ?? [];
	assert.equal(replies.filter((message) => message.role === "tool" && JSON.stringify(message.content).includes("blocking_watch")).length, 2);
	s.setGh({ runs: [run(205, live.head, "in_progress", null)], routes: [{ match: "run watch", replies: [json({ number: 205, html_url: live.prUrl, state: "open", merged: false, head: { sha: live.head, ref: live.jobId } })] }] });
	await s.tick(live.jobId);
	for (const command of s.ghCalls()) assert.equal(detectCiWait(`gh ${command}`), undefined, `watcher command: ${command}`);
	for (const command of s.ghCalls()) assert.doesNotMatch(command, /sleep|--watch|run watch|statusCheckRollup/);
	assert.ok(s.ghCalls().some((command) => command.includes("/pulls/205")));
	assert.ok(s.ghCalls().some((command) => command.includes("/actions/runs?head_sha=")));
	assert.ok(s.ghCalls().some((command) => command.includes("/attempts/1/jobs?")));
});

test("landing: CI watch persists arrival and attempt identity, follows pushed heads and prunes finished deliveries", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch attempts and heads", 101);
	const observe = async (rows: RunRow[]) => {
		s.setGh({ runs: rows });
		return s.tick(live.jobId);
	};
	const pending = await observe([run(101, live.head, "in_progress", null)]);
	assert.deepEqual(pending.observations, [], "pending is not a verdict");
	const first = await observe([run(101, live.head, "completed", "failure")]);
	const failed = first.observations.find((fact) => fact.event === "ci_failed");
	assert.ok(failed, "the failed current head is observed");
	assert.equal(failed.run_id, 101);
	assert.deepEqual(s.post.confirmCi([failed.key]), [failed.key]);
	assert.deepEqual(s.post.confirmCi([failed.key]), [], "arrival is idempotent");
	assert.deepEqual((await observe([run(101, live.head, "completed", "failure")])).observations, [], "an arrived attempt is not announced again");
	assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "ci_observed").length, 1, "one journal event per completed attempt");
	assert.deepEqual((await observe([run(101, live.head, "in_progress", null, { run_attempt: 2 })])).observations, [], "a running rerun is not terminal");
	const retry = await observe([run(101, live.head, "completed", "failure", { run_attempt: 2 })]);
	const retried = retry.observations.find((fact) => fact.event === "ci_failed");
	assert.ok(retried, "a new attempt is a new failure even on the same head");
	assert.notEqual(retried.key, failed.key);
	s.post.confirmCi([retried.key]);
	assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "ci_observed").length, 2);
	const green = await observe([run(101, live.head, "completed", "success", { run_attempt: 3 })]);
	const passed = green.observations.find((fact) => fact.event === "ci_green");
	assert.ok(passed, "a green rerun follows a failed attempt");
	s.post.confirmCi([passed.key]);
	assert.deepEqual((await observe([run(101, live.head, "completed", "success", { run_attempt: 3 })])).observations, [], "an arrived green attempt is not announced again");
	const greenAgain = await observe([run(101, live.head, "completed", "success", { run_attempt: 4 })]);
	assert.equal(greenAgain.observations[0]?.event, "ci_green", "a new attempt of an already green head is news");
	s.post.confirmCi(greenAgain.observations.map((fact) => fact.key));
	execFileSync("git", ["-C", live.worktree, "commit", "--quiet", "--allow-empty", "-m", "new head"]);
	execFileSync("git", ["-C", live.worktree, "push", "--quiet", "origin", live.jobId]);
	const head = git(live.worktree, "rev-parse", "HEAD");
	assert.notEqual(head, live.head);
	assert.deepEqual((await observe([run(101, live.head, "completed", "success")])).observations, [], "old green does not bless a pushed head");
	assert.equal(s.post.ciHead(live.jobId), head);
	const moved = await observe([run(102, head, "completed", "success")]);
	const current = moved.observations.find((fact) => fact.event === "ci_green");
	assert.ok(current, "the pushed head gets its own verdict");
	assert.equal(current.head_sha, head);
	assert.ok(current.key.startsWith(`${live.jobId}|${head}|ci_green|`), "pushed-head key includes its current head");
	assert.notEqual(current.key, passed.key);
	assert.equal(s.post.ciWatch.store.job(live.jobId)?.last_ci, "green");
	assert.ok(readRunEvents(s.home, live.jobId).some((event) => event.type === "ci_observed"));
	assert.deepEqual(mergedCalls(s.ghCalls()), [], "observing CI does not merge");
	assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "ci_observed" && JSON.stringify(event).includes("ci_failed")).length, 2, "new green preserves both historical failures without repeating them");
	await s.post.fleet.patch(live.jobId, { phase: "done" });
	await s.post.ciTick();
	assert.equal(s.post.ciWatch.store.job(live.jobId), undefined, "finished deliveries leave the watch");
});


test("landing: operator-forwarded CI requires a quoted current head and never substitutes for native CI", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("forwarded evidence", 103);
	s.setGh({ runs: [run(103, live.head, "in_progress", null)] });
	await s.tick(live.jobId);
	const quote = "CI is green on this head; I checked the Actions tab.";
	const params = { job_id: live.jobId, action: "record_ci", result: "success", head_sha: live.head, operator_quote: quote };
	const calls = [
		{ ...params, operator_quote: "Trust me, it passed." },
		{ ...params, head_sha: "b".repeat(40) },
		{ ...params, url: "https://github.com/example/demo/actions?token=1" },
		params,
		params,
	];
	const results = await s.parent(quote, [
		...calls.map((args): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_integrate", args }] })),
		{ kind: "text", text: "Evidence recorded." },
	]);
	const text = results.map((event) => JSON.stringify(event));
	assert.match(text[0]!, /quote not found/);
	assert.match(text[1]!, /superseded head/);
	assert.match(text[2]!, /plain https url/);
	assert.match(text[3]!, /display only, native CI still gates/);
	const evidence = JSON.parse(readFileSync(join(s.home, paths.ciEvidenceFile(live.jobId)), "utf8"));
	assert.equal(evidence.observations.length, 1, "an identical forwarded result is stored once");
	assert.deepEqual([evidence.observations[0].head_sha, evidence.observations[0].source, evidence.observations[0].operator_quote], [live.head, "forwarded", quote]);
	const advance = await s.integrate(live.jobId);
	assert.equal(advance.record.next, "wait", advance.text);
	assert.deepEqual(mergedCalls(s.ghCalls()), [], "forwarded success cannot merge pending native CI");
	const file = join(s.home, paths.ciEvidenceFile(live.jobId));
	assert.equal(evidence.repo, "example/demo");
	assert.match(evidence.observations[0].observed_at, /^\d{4}-\d{2}-\d{2}T/);
	const unknown = await s.held("forwarded CI without an observed head", 112);
	s.setGh({ runs: [], routes: [{ match: "pulls/112", replies: [{ code: 1, stderr: "PR read unavailable" }] }] });
	const token = "ghp_" + "x".repeat(36);
	const secretQuote = `CI passed, token ${token}.`;
	const guardCalls = [
		{ ...params, job_id: unknown.jobId, head_sha: unknown.head },
		{ ...params, head_sha: "abc1234" },
		{ ...params, operator_quote: secretQuote },
		{ ...params, url: `https://x:${token}@github.com/example/demo` },
	];
	const guards = await s.parent(`${quote}\n${secretQuote}`, [
		...guardCalls.map((args): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_integrate", args }] })),
		{ kind: "text", text: "Validation observed." },
	]);
	for (const [index, pattern] of [/no known current head/, /full 40-hex/, /github token/, /plain https url/].entries()) {
		assert.match(JSON.stringify(guards[index]), pattern, "forwarded evidence rejects invalid input through the tool");
	}
	assert.ok(!JSON.stringify(guards[2]).includes(token), "a secret rejection never echoes the credential");
	assert.ok(!existsSync(join(s.home, paths.ciEvidenceFile(unknown.jobId))), "an unknown head writes no evidence");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).observations.length, 1, "refused observations never append");
	writeFileSync(file, JSON.stringify({ ...evidence, repo: "other/repository" }));
	const repositoryQuote = "CI passed for repository validation.";
	const mismatch = await s.parent(repositoryQuote, [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { ...params, operator_quote: repositoryQuote } }] },
		{ kind: "text", text: "Repository mismatch observed." },
	]);
	assert.match(JSON.stringify(mismatch), /is for other\/repository/, "evidence cannot be rebound to another repository");
	writeFileSync(file, JSON.stringify(evidence));
	const quotes = Array.from({ length: CI_EVIDENCE_KEEP + 1 }, (_, index) => `CI result number ${index}.`);
	const bounded = await s.parent(quotes.join("\n"), [
		...quotes.map((operator_quote): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { ...params, operator_quote, url: "https://github.com/example/demo/actions/runs/103" } }] })),
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { ...params, result: "failure", operator_quote: quotes.at(-1) } }] },
		{ kind: "text", text: "Bounded observations recorded." },
	]);
	assert.ok(bounded.every((event) => /display only/.test(JSON.stringify(event))), "every bounded forwarded write succeeds");
	const history = JSON.parse(readFileSync(file, "utf8")).observations;
	assert.equal(history.length, CI_EVIDENCE_KEEP, "forwarded history is bounded");
	assert.equal(history[0].operator_quote, quotes[2], "oldest observations are discarded");
	assert.deepEqual(history.slice(-2).map((entry: { result: string }) => entry.result), ["success", "failure"], "a changed result is a new observation");
	assert.equal(history.at(-2).url, "https://github.com/example/demo/actions/runs/103");
	const a = live.head;
	const b = "b".repeat(40);
	writeFileSync(file, JSON.stringify({ ...evidence, observations: [
		{ head_sha: a, result: "failure", source: "forwarded", observed_at: "2026-10-15T11:00:00Z", operator_quote: "red." },
		{ head_sha: a, result: "pending", source: "forwarded", observed_at: "2026-10-15T12:00:00Z", operator_quote: "running.", url: "https://x?y" },
		{ head_sha: a, result: "success", source: "actions", observed_at: "2026-10-15T13:00:00Z" },
		{ head_sha: b, result: "success", source: "forwarded", observed_at: "2026-10-15T14:00:00Z", operator_quote: "green." },
	] }));
	const view = async (head: string | null) => {
		const watchFile = join(s.home, LAYOUT.ciWatchFile);
		const watch = JSON.parse(readFileSync(watchFile, "utf8"));
		for (const row of watch.jobs) if (row.job_id === live.jobId) row.head_sha = head;
		writeFileSync(watchFile, JSON.stringify(watch));
		const envelopeFile = join(s.home, paths.envelopeFile(live.jobId));
		const envelope = JSON.parse(readFileSync(envelopeFile, "utf8"));
		envelope.envelope.head_sha = head;
		writeFileSync(envelopeFile, JSON.stringify(envelope));
		const server = createViewer({ home: s.home, stateDir: join(s.home, LAYOUT.state), host: "127.0.0.1", port: 0, log: () => {} });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs`);
			assert.equal(response.status, 200);
			const body = await response.json() as { jobs: Array<{ id: string; ci_forwarded: unknown }> };
			return body.jobs.find((job) => job.id === live.jobId)?.ci_forwarded;
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
	assert.deepEqual(await view(a), { ci: "in_progress", observed_at: "2026-10-15T12:00:00Z", url: null }, "viewer ignores native and other-head evidence and strips unsafe URLs");
	assert.deepEqual(await view(b), { ci: "green", observed_at: "2026-10-15T14:00:00Z", url: null });
	assert.equal(await view("c".repeat(40)), null, "an unseen head has no forwarded evidence");
	assert.equal(await view(null), null, "an unknown head has no forwarded evidence");
	rmSync(file);
	assert.equal(await view(a), null, "a missing file has no forwarded evidence");
});


test("landing: foreign CI stays read-only, follows the base repo's current head and stops after merge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	await s.post.registry.update("demo", { clone_url: "https://github.com/example/demo" });
	const prUrl = "https://github.com/example/demo/pull/104";
	const job = await s.post.ledger().create({ title: "review foreign PR", project: "demo", delivery: "local", kind: "research", externalRef: prUrl, labels: ["schedule:sch-e2e"] });
	const head = "a".repeat(40);
	const next = "b".repeat(40);
	const state = (sha: string, rows: RunRow[], terminal = false) => s.setGh({ runs: rows, routes: [{ match: "pulls/104", replies: [json({ number: 104, html_url: prUrl, state: terminal ? "closed" : "open", merged: terminal, merge_commit_sha: terminal ? MERGE : null, head: { sha, ref: "foreign" } })] }] });
	const tick = async () => {
		for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
			const result = await s.post.foreignCiTick();
			if (result.checked.includes(job.id)) return result;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return assert.fail("foreign PR watch never became due");
	};
	await assert.rejects(s.post.dispatch({ jobId: job.id, task: "review", fetch: false }), /waits for CI/);
	state(head, [run(104, head, "in_progress", null)]);
	assert.deepEqual((await tick()).observations, []);
	state(head, [run(104, head, "completed", "success")]);
	assert.deepEqual((await tick()).observations.map((fact) => fact.event), ["ci_green"]);
	assert.deepEqual((await tick()).observations, [], "foreign facts are reported once");
	state(next, [run(105, next, "in_progress", null)]);
	await assert.rejects(s.post.dispatch({ jobId: job.id, task: "review", fetch: false }), /PR head is now/);
	assert.deepEqual((await tick()).observations.map((fact) => fact.event), ["head_moved"]);
	state(next, [run(105, next, "completed", "failure")]);
	assert.deepEqual((await tick()).observations.map((fact) => [fact.event, fact.head_sha]), [["ci_failed", next]]);
	state(next, [], true);
	assert.deepEqual((await tick()).observations.map((fact) => fact.event), ["pr_merged"]);
	assert.deepEqual((await s.post.foreignCiTick()).checked, [], "terminal PR is no longer queried");
	assert.ok(s.ghCalls().some((call) => call.includes(`repos/example/demo/actions/runs?head_sha=${next}`)), "CI is read from the base repository by head");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	assert.equal(s.post.fleet.get(job.id), undefined, "waiting reviewer never spawned");
});

test("landing: foreign CI selection, failed reads, corrupt memory and reviewer timeout remain visible at dispatch", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	await s.post.registry.update("demo", { clone_url: "https://github.com/example/demo" });
	const create = (title: string, ref: string, labels = ["schedule:sch-e2e"]) => s.post.ledger().create({ title, project: "demo", delivery: "local", kind: "research", externalRef: ref, labels });
	const url = "https://github.com/example/demo/pull/204";
	const head = "a".repeat(40);
	const job = await create("foreign reviewer", url);
	const closed = await create("closed foreign", "https://github.com/example/demo/pull/205");
	await s.post.ledger().close(closed.id, "dropped: fixture closed");
	await create("other repo", "https://github.com/example/other/pull/206");
	await create("issue", "https://github.com/example/demo/issues/207");
	const own = await s.seed("own PR", { prUrl: "https://github.com/example/demo/pull/208" });
	await create("own PR reference", own.prUrl!);
	const file = join(s.home, LAYOUT.foreignCiWatchFile);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{ not json");
	const state = (reply: Reply, rows: RunRow[] = []) => s.setGh({ runs: rows, routes: [{ match: "pulls/204", replies: [reply] }] });
	const pr = (sha = head) => json({ number: 204, html_url: url, state: "open", merged: false, head: { sha, ref: "foreign" } });
	const due = () => {
		const memory = JSON.parse(readFileSync(file, "utf8"));
		for (const row of memory.jobs) delete row.next_due_at;
		writeFileSync(file, JSON.stringify(memory));
	};
	state(pr(), [run(204, head, "in_progress", null)]);
	const selected = await s.post.foreignCiTick().catch((error: Error) => assert.fail(`corrupt memory must recover: ${error.message}`));
	assert.deepEqual(selected.checked, [job.id], "only the open foreign PR in this project's repo is selected");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).jobs.map((row: { job_id: string }) => row.job_id), [job.id], "corrupt memory is replaced with valid selected jobs");
	await s.post.ledger().update(job.id, { status: "deferred" });
	due();
	assert.deepEqual((await s.post.foreignCiTick()).checked, [job.id], "deferred foreign jobs remain selected");
	await s.post.ledger().update(job.id, { status: "open" });
	const bypassModel = s.provider.addScript("foreign-bypass", [{ kind: "text", text: "Unused." }]);
	s.agentDir.writeModels(s.provider);
	for (const bypass of [
		await create("ordinary research", url, []),
		await s.post.ledger().create({ title: "ship is not a foreign reviewer", project: "demo", kind: "ship", delivery: "pr", externalRef: url, labels: ["schedule:sch-e2e"] }),
		await create("review another repo", "https://github.com/example/other/pull/299"),
	]) {
		await assert.rejects(s.post.dispatch({ jobId: bypass.id, task: "review", model: bypassModel, fetch: false }), /origin_mismatch/, "non-reviewers pass the foreign gate and reach normal preflight");
		await s.post.ledger().close(bypass.id, "dropped: gate bypass fixture complete");
	}
	await assert.rejects(s.post.dispatch({ jobId: job.id, task: "review", fetch: false }), /in_progress on aaaaaaaaaaaa/);
	state(pr("HEAD;rm"));
	due();
	assert.ok((await s.post.foreignCiTick()).errors.some((error) => /malformed head sha/.test(error.message)), "malformed forge head is refused at the Actions boundary");
	s.setGh({ routes: [{ match: "pulls/204", replies: [pr()] }, { match: "actions/runs?head_sha=", replies: [{ code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" }] }] });
	due();
	assert.ok((await s.post.foreignCiTick()).errors.some((error) => /Actions CI read denied/.test(error.message)), "unreadable Actions is never an empty run list");
	state({ code: 1, stderr: "gh api failed: HTTP 502" });
	due();
	const failed = await s.post.foreignCiTick();
	assert.equal(failed.errors.length, 1);
	assert.match(failed.errors[0]!.message, /HTTP 502/);
	assert.deepEqual((await s.post.foreignCiTick()).checked, [], "a failed read backs off");
	due();
	assert.deepEqual((await s.post.foreignCiTick()).errors, [], "a repeated cause is announced once");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).jobs[0].failures, 4);
	state(pr(), [run(204, head, "completed", "success")]);
	due();
	const green = await s.post.foreignCiTick();
	assert.deepEqual(green.observations.map((fact) => fact.event), ["ci_green"]);
	assert.match(green.observations[0]!.key, /^foreign\|.*\|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\|ci_green\|[0-9a-f]{12}$/);
	state({ code: 1, stderr: "gh api failed: HTTP 502" });
	await assert.rejects(s.post.dispatch({ jobId: job.id, task: "review", fetch: false }), /PR head is now unknown/);
	const ledgerFile = join(s.home, LAYOUT.jobsFile);
	const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
	ledger.jobs.find((row: { id: string }) => row.id === job.id).created_at = "2020-01-01T00:00:00Z";
	writeFileSync(ledgerFile, JSON.stringify(ledger));
	const model = s.provider.addScript("foreign-timeout", [{ kind: "text", text: "Review received." }], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const clone = s.post.registry.pathOf("demo");
	git(clone, "remote", "set-url", "origin", "https://github.com/example/demo");
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const gitShim = join(s.home, "bin", "git");
	writeFileSync(gitShim, `#!/usr/bin/env node\nconst { spawnSync } = require("child_process");\nconst args = process.argv.slice(2);\nconst raw = args.includes("get-url");\nconst result = spawnSync(${JSON.stringify(realGit)}, [...(raw ? [] : ["-c", ${JSON.stringify(`url.${s.remote}.insteadOf=https://github.com/example/demo`)}]), ...args], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`);
	chmodSync(gitShim, 0o755);
	assert.equal((await s.post.dispatch({ jobId: job.id, task: "review", model, fetch: false })).receipt, "accepted");
	await waitFor(() => s.provider.requests("foreign-timeout"), (requests) => requests.length > 0, { timeoutMs: 60_000, what: "reviewer sees timed-out foreign CI" });
	assert.match(JSON.stringify(s.provider.requests("foreign-timeout")[0]!.body), /CI unknown — not completed within 60 min/);
	assert.match(JSON.stringify(s.provider.requests("foreign-timeout")[0]!.body), /PR head is now unknown/);
	state({ code: 1, stderr: "gh: Not Found (HTTP 404)" });
	due();
	assert.equal((await s.post.foreignCiTick()).stopped.length, 1);
	due();
	assert.deepEqual((await s.post.foreignCiTick()).checked, [], "an unreadable PR is dropped permanently");
	const armed = await create("armed foreign reviewer", "https://github.com/example/demo/pull/209");
	const defaults = loadMandateDefaults(s.home);
	const scheduler = new Scheduler({ home: s.home, ledger: () => s.post.ledger(), mandates: s.post.mandates, runs: s.post.mandates.scheduleRuns, usageJobs: () => [], cloneOf: () => clone, mintContext: () => ({ defaults, ceiling: defaults.token_ceiling! }) });
	const schedule = await scheduler.add({ name: "foreign reviewer", project: "demo", manual: true, title: "Review", kind: "research", delivery: "answer", native: { limits: { parallelism: 1 }, action: { saved_by: "operator-quote", provenance: { channel: "cp_schedule", tool_call_id: "foreign-fixture", quote_sha: "abcdef123456" } } } });
	await s.post.ledger().update(armed.id, { removeLabels: ["schedule:sch-e2e"], addLabels: [`schedule:${schedule.id}`] });
	const legacyJobs = JSON.parse(readFileSync(ledgerFile, "utf8"));
	legacyJobs.jobs.find((row: { id: string }) => row.id === armed.id).created_at = isoTimestamp(new Date(Date.now() - 60_000));
	writeFileSync(ledgerFile, JSON.stringify(legacyJobs));
	const armedModel = s.provider.addScript("foreign-armed", [{ kind: "text", text: "Reviewing current head." }], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "foreign-reviewer", role: "planner", model: armedModel }] }));
	const armState = (conclusion: string | null) => s.setGh({ runs: [run(209, head, conclusion ? "completed" : "in_progress", conclusion)], routes: [{ match: "pulls/209", replies: [json({ number: 209, html_url: armed.external_ref, state: "open", merged: false, head: { sha: head, ref: "foreign" } })] }] });
	armState(null);
	await s.parent("Dispatch the foreign reviewer when its CI completes.", [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: armed.id, task: "Review the foreign PR.", model: armedModel } }] },
		{ kind: "text", text: "Waiting for foreign CI." },
	], async (events, stderr) => {
		assert.ok(existsSync(join(s.home, LAYOUT.armedDispatchFile)), JSON.stringify({ events, job: await s.post.ledger().show(armed.id) }));
		assert.deepEqual(JSON.parse(readFileSync(join(s.home, LAYOUT.armedDispatchFile), "utf8")).entries.map((entry: { job_id: string }) => entry.job_id), [armed.id]);
		assert.equal(s.post.fleet.get(armed.id), undefined, "the public dispatch tool arms without spawning while CI runs");
		assert.equal(s.provider.requests("foreign-armed").length, 0);
		armState("success");
		await waitFor(() => ({ requests: s.provider.requests("foreign-armed"), job: s.post.ledger().read().jobs.find((row) => row.id === armed.id)! }), (value) => value.requests.length === 1 || value.job.status === "closed", { timeoutMs: 60_000, what: "armed reviewer released by real CI timer" });
		await waitFor(() => s.post.ledger().read().jobs.find((row) => row.id === armed.id)!, (row) => row.status === "in_progress", { timeoutMs: 10_000, what: "armed start journals in_progress" });
		assert.match(JSON.stringify(s.provider.requests("foreign-armed")[0]!.body), /CI green on aaaaaaaaaaaa/);
		assert.equal(readRunEvents(s.home, armed.id).filter((event) => event.type === "spawned").length, 1, "one armed dispatch starts once");
		await waitFor(stderr, (text) => text.includes(`foreign PR ${armed.external_ref} CI green on aaaaaaaaaaaa`), { timeoutMs: 10_000, what: "foreign CI notice reaches operator stderr" });
		assert.match(stderr(), /nothing was merged, commented, re-run or woken/);
	});
	await s.post.ledger().close(armed.id, "dropped: armed reviewer fixture complete");
	const batch = [];
	for (let i = 0; i < 21; i++) batch.push(await create(`capped foreign ${i}`, `https://github.com/example/demo/pull/${300 + i}`));
	s.setGh({ runs: [run(300, head, "in_progress", null)], routes: batch.map((row, i) => ({ match: `pulls/${300 + i}`, replies: [json({ number: 300 + i, html_url: row.external_ref, state: "open", merged: false, head: { sha: head, ref: "foreign" } })] })) });
	const capped = await s.post.foreignCiTick();
	assert.deepEqual(capped.checked, batch.slice(0, 20).map((row) => row.id));
	assert.deepEqual(capped.deferred, [batch[20]!.id], "the real default per-tick cap defers the twenty-first PR");
	const offJob = await create("foreign reviewer while gh is unavailable", "https://github.com/example/demo/pull/399");
	s.setGh({ routes: [{ match: "pulls/208", replies: [{ code: 1, stderr: "spawn gh ENOENT" }] }] });
	rmSync(join(s.home, LAYOUT.ciWatchFile), { force: true });
	const disabled = await s.post.ciTick();
	assert.match(s.post.ciWatch.disabled ?? "", /gh is not available/, JSON.stringify(disabled));
	const offModel = s.provider.addScript("foreign-off", [{ kind: "text", text: "Reviewing without CI." }], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	assert.equal((await s.post.dispatch({ jobId: offJob.id, task: "review", model: offModel, fetch: false })).receipt, "accepted");
	await waitFor(() => s.provider.requests("foreign-off"), (requests) => requests.length > 0, { timeoutMs: 60_000, what: "reviewer sees disabled watch" });
	assert.match(JSON.stringify(s.provider.requests("foreign-off")[0]!.body), /CI unknown — the CI watch is off/);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});


test("landing: a real parent's timer latches only its mandated main runs and clears only current-tip green", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	let tip = git(s.remote, "rev-parse", "main");
	const routes: Route[] = [
		{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] },
		{ match: "run view 106 --log-failed", replies: [{ stdout: "test\t✖ main regression" }] },
	];
	const own = (head: string, conclusion: string, login = "e2e", event = "push") => run(login !== "e2e" ? 107 : event === "dynamic" ? 108 : 106, head, "completed", conclusion, { triggering_actor: { login }, event });
	const file = join(s.home, LAYOUT.state, "main-ci.json");
	const rows = (): Array<{ project: string; red_since_sha: string; login: string; workflow?: string; failing?: string }> => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).projects : [];
	const observe = async (runs: RunRow[], extra: Partial<GhState> = {}) => {
		const before = s.ghCalls().filter((call) => call.includes(`head_sha=${tip}`)).length;
		s.setGh({ routes, runs, ...extra });
		await waitFor(() => s.ghCalls().filter((call) => call.includes(`head_sha=${tip}`)).length, (count) => count >= before + 2, { timeoutMs: 30_000, what: "two main CI timer reads" });
	};
	s.setGh({ routes, runs: [] });
	await s.parent("Observe the CI timer.", [{ kind: "text", text: "Observing." }], async () => {
		s.post.mandates.issue({ projects: ["demo"], objective: "main CI e2e", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
		for (const runs of [[], [own(tip, "success")], [run(109, tip, "in_progress", null)], [own("c".repeat(40), "failure")], [own(tip, "failure", "someone")], [own(tip, "failure", "dependabot[bot]")], [own(tip, "failure", "e2e", "dynamic")], [run(109, tip, "completed", "failure", { event: "push" })], [{ ...own(tip, "failure", "someone"), run_attempt: 2 }]]) {
			await observe(runs);
			assert.deepEqual(rows(), [], "green, pending, absent and wrong-head runs never latch");
		}
		await observe([own(tip, "failure")], { routes: [...routes, { match: "actions/runs/106/attempts/1/jobs", replies: [{ code: 1, stderr: "HTTP 403: forbidden" }] }] });
		assert.deepEqual(rows(), [], "unreadable main attempt jobs never create a latch");
		await observe([own(tip, "failure"), run(109, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" } })], { jobs: { 106: [setupJob("Run suite (typecheck + tests)")] } });
		assert.deepEqual(rows().map((row) => [row.project, row.red_since_sha, row.login, row.workflow, row.failing]), [["demo", tip, "e2e", "ci", "main regression"]], "normalized actor, identity, jobs and steps produce the own red latch");
		const earlyClaims = join(s.home, LAYOUT.ciRerunsFile);
		assert.deepEqual(existsSync(earlyClaims) ? JSON.parse(readFileSync(earlyClaims, "utf8")).entries : [], [], "suite failure claims no infra rerun");
		assert.ok(!s.ghCalls().some((call) => call.startsWith("run rerun")), "suite failure never reruns");
		const latched = readFileSync(file, "utf8");
		await observe([own(tip, "failure")]);
		assert.equal(readFileSync(file, "utf8"), latched, "repeat red preserves the original latch bytes");
		const redBody = await waitFor(s.parentMessages, (body) => body.includes("MAIN IS RED"), { timeoutMs: 30_000, what: "main red wake reaches parent provider" }).catch(() => s.parentMessages());
		assert.ok(redBody.includes("MAIN IS RED"), "main red wake reaches parent provider");
		assert.equal(s.parentMessages().split("MAIN IS RED").length - 1, 1, "repeat red emits one parent wake");
		assert.ok(s.parentMessages().includes(`MAIN IS RED — demo: CI failed on ${tip.slice(0, 12)} (ci) — failing: main regression`));
		assert.ok(s.parentMessages().includes("cp_integrate returns wait for every demo PR except one based on the current main with green CI"));
		git(s.post.registry.pathOf("demo"), "remote", "set-url", "origin", join(s.home, "missing-origin.git"));
		try {
			const journal = () => existsSync(join(s.home, LAYOUT.state, "wakeups.json")) ? readFileSync(join(s.home, LAYOUT.state, "wakeups.json"), "utf8") : "";
			const fetchError = await waitFor(journal, (body) => body.includes("main CI (demo)") && body.includes("fetch"), { timeoutMs: 30_000, what: "failed git fetch reaches durable wake journal" }).catch(journal);
			assert.ok(fetchError.includes("main CI (demo)") && fetchError.includes("fetch"), `failed git fetch names project and cause: ${fetchError}`);
			assert.equal(readFileSync(file, "utf8"), latched, "failed git fetch preserves latch bytes");
		} finally {
			git(s.post.registry.pathOf("demo"), "remote", "set-url", "origin", s.remote);
		}
		const oldTip = tip;
		tip = advanceBase(s.repo, "main-change.txt", "main advanced\n");
		await observe([own(tip, "failure")]);
		assert.equal(readFileSync(file, "utf8"), latched, "red on a new main tip preserves the original latch");
		await observe([{ ...own(oldTip, "success"), id: 110 }, own(tip, "failure")]);
		assert.equal(readFileSync(file, "utf8"), latched, "old-tip green cannot replace current-tip red");
		await observe([own("c".repeat(40), "success")]);
		assert.equal(readFileSync(file, "utf8"), latched, "stale green never clears main red");
		await observe([own(tip, "success"), run(109, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" } })]);
		assert.equal(readFileSync(file, "utf8"), latched, "pending current-tip workflow prevents clearing");
		await observe([], { routes: [...routes, { match: "actions/runs?", replies: [{ stdout: "not json" }] }] });
		assert.equal(readFileSync(file, "utf8"), latched, "malformed CI never clears the latch");
		const malformedBody = await waitFor(s.parentMessages, (body) => body.includes("main CI (demo)") && body.includes("malformed"), { timeoutMs: 30_000, what: "malformed main CI read names project and cause" }).catch(() => s.parentMessages());
		assert.ok(malformedBody.includes("main CI (demo)") && malformedBody.includes("malformed"), "malformed main CI read names project and cause");
		await observe([], { routes: [...routes, { match: "actions/runs?", replies: [{ code: 1, stderr: "HTTP 403: forbidden" }] }] });
		assert.equal(readFileSync(file, "utf8"), latched, "denied CI never clears the latch");
		await observe([own(tip, "success"), own(tip, "failure", "someone-else"), own(tip, "failure", "e2e", "dynamic")]);
		await waitFor(rows, (value) => value.length === 0, { timeoutMs: 30_000, what: "own current-tip green clears latch" });
		const cleared = readFileSync(file, "utf8");
		await observe([own(tip, "success")]);
		assert.equal(readFileSync(file, "utf8"), cleared, "repeat green does not rewrite state");
		await waitFor(s.parentMessages, (body) => body.includes(`MAIN IS GREEN AGAIN — demo: CI passed on ${tip.slice(0, 12)}. Call cp_integrate for held demo PRs.`), { timeoutMs: 30_000, what: "green notice reaches parent" });
		const legacyRow = JSON.parse(cleared);
		legacyRow.projects = [{ project: "demo", red_since_sha: oldTip, red_since_at: isoTimestamp() }];
		writeFileSync(file, JSON.stringify(legacyRow));
		await observe([run(109, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" } })]);
		assert.deepEqual(rows(), [], "legacy latch releases even while main CI is inconclusive");
		const legacyBody = await waitFor(s.parentMessages, (body) => body.includes("MAIN CI LATCH RELEASED"), { timeoutMs: 30_000, what: "legacy release reaches parent" }).catch(() => s.parentMessages());
		assert.ok(legacyBody.includes("MAIN CI LATCH RELEASED"), "legacy release reaches parent");
		const foreign = JSON.parse(cleared);
		foreign.projects = [{ project: "demo", red_since_sha: oldTip, red_since_at: isoTimestamp(), login: "other" }];
		writeFileSync(file, JSON.stringify(foreign));
		await observe([run(109, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" } })]);
		assert.deepEqual(rows(), [], "foreign latch releases on inconclusive main CI");
		const releasedNotice = `MAIN CI LATCH RELEASED — demo: red since ${oldTip.slice(0, 12)} no longer counts (latched for other, this machine is e2e). Call cp_integrate for held demo PRs.`;
		const releasedBody = await waitFor(s.parentMessages, (body) => body.includes(releasedNotice), { timeoutMs: 30_000, what: "foreign release notice reaches parent" }).catch(() => s.parentMessages());
		assert.ok(releasedBody.includes(releasedNotice), "foreign release notice reaches parent");
		writeFileSync(file, JSON.stringify(foreign));
		await observe([own(tip, "failure")], { routes: [routes[0]!, { match: "run view 106 --log-failed", replies: [{ stdout: "nothing useful" }] }], jobs: { 106: [{ id: 1060, name: "structure checks", status: "completed", conclusion: "failure", steps: [] }] } });
		assert.equal(rows()[0]?.failing, "structure checks", "missing failure log falls back to the failed job");
		const saved = readFileSync(file, "utf8");
		writeFileSync(file, "{not json");
		s.setGh({ routes, runs: [own(tip, "success")] });
		await waitFor(() => readFileSync(join(s.home, LAYOUT.state, "wakeups.json"), "utf8"), (body) => body.includes("main-ci.json unreadable"), { timeoutMs: 30_000, what: "corrupt main CI journaled by real timer" });
		assert.equal(readFileSync(file, "utf8"), "{not json", "the timer never overwrites corrupt latch data");
		writeFileSync(file, saved);
		const legacy = JSON.parse(saved);
		legacy.projects.push({ ...legacy.projects[0], project: "other" });
		writeFileSync(file, JSON.stringify(legacy));
		await observe([own(tip, "success")]);
		assert.deepEqual(rows().map((row) => row.project), ["other"], "clearing demo preserves another project's latch");
		s.setGh({ routes, runs: [own(tip, "failure")], jobs: { 106: [setupJob("Install treehouse")] } });
		await waitFor(s.ghCalls, (calls) => calls.some((call) => call === "run rerun 106 --failed"), { timeoutMs: 30_000, what: "main infra failure reruns once" });
		await observe([run(106, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" }, run_attempt: 2 })]);
		assert.deepEqual(rows().map((row) => row.project), ["other"], "infra rerun does not latch demo");
		await observe([{ ...own(tip, "failure"), run_attempt: 2 }], { jobs: { 106: [setupJob("Install treehouse")] } });
		assert.equal(rows().find((row) => row.project === "demo")?.red_since_sha, tip, "second infra failure latches main");
		assert.ok(rows().some((row) => row.project === "other"), "latching demo preserves another project's latch");
		assert.equal(s.ghCalls().filter((call) => call === "run rerun 106 --failed").length, 1, "attempt two never reruns again");
		assert.ok(s.ghCalls().includes("api repos/{owner}/{repo}/actions/runs/106/attempts/2/jobs?per_page=100&page=1"));
		const claimAtRerun = s.ghCalls().find((call) => call.startsWith("claims-at-rerun")) ?? "";
		assert.ok(claimAtRerun.includes("main-demo") && claimAtRerun.includes(tip), "main claim is durable before gh reruns");
		await waitFor(s.parentMessages, (body) => body.includes("MAIN CI RERUN") && body.includes("attempt 2: a second failure"), { timeoutMs: 30_000, what: "main rerun and second-attempt notice reach parent" });
		const claimsFile = join(s.home, LAYOUT.ciRerunsFile);
		assert.deepEqual(JSON.parse(readFileSync(claimsFile, "utf8")).entries.map((entry: { job_id: string; head_sha: string; run_id: number; step: string }) => [entry.job_id, entry.head_sha, entry.run_id, entry.step]), [["main-demo", tip, 106, "Install treehouse"]]);
		await observe([own(tip, "success")]);
		tip = advanceBase(s.repo, "main-change.txt", "main advanced again\n");
		await observe([own(tip, "failure")], { jobs: { 106: [setupJob("Install treehouse")] }, routes: [...routes, { match: "run rerun 106", replies: [{ code: 1, stderr: "HTTP 403: forbidden" }] }] });
		assert.equal(rows().find((row) => row.project === "demo")?.red_since_sha, tip, "refused infra rerun latches main");
		assert.equal(JSON.parse(readFileSync(claimsFile, "utf8")).entries.length, 2, "refused rerun keeps its claim");
		assert.equal(s.ghCalls().filter((call) => call === "run rerun 106 --failed").length, 2, "refusal does not earn a retry");
		await waitFor(s.parentMessages, (body) => body.includes("HTTP 403: forbidden"), { timeoutMs: 30_000, what: "rerun refusal reaches parent" });
	});
	assert.deepEqual(mergedCalls(s.ghCalls()), [], "the main CI timer never merges");
});


test("landing: main-red integration holds stale heads and permits only a current green fix-forward under its own mandate", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("main red gate", 120);
	const tip = advanceBase(s.repo, "main-fix.txt", "main changed\n");
	const grant = s.post.mandates.issue({ projects: ["demo"], objective: "main red gate", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	s.setGh({ routes: [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }], runs: [run(120, live.head, "completed", "success")] });
	const file = join(s.home, LAYOUT.state, "main-ci.json");
	const latch = (login?: string) => writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), projects: [{ project: "demo", red_since_sha: tip, red_since_at: isoTimestamp(), failing: "structure", ...(login ? { login } : {}) }] }));
	const absent = await s.integrate(live.jobId);
	assert.doesNotMatch(absent.text, /main is red since/);
	assert.ok(!s.ghCalls().includes("api user --jq .login"), "no latch never resolves main CI scope");
	latch("e2e");
	const stale = await s.integrate(live.jobId);
	assert.equal(stale.record.next, "wait", stale.text);
	assert.match(stale.text, /main is red since .*structure/);
	assert.deepEqual(mergedCalls(stale.calls), []);
	git(live.worktree, "fetch", "origin", "main");
	git(live.worktree, "merge", "--no-edit", "origin/main");
	git(live.worktree, "push", "origin", live.jobId);
	const current = git(live.worktree, "rev-parse", "HEAD");
	for (const runs of [[run(120, live.head, "completed", "success")], [run(121, current, "in_progress", null)]]) {
		s.setGh({ runs });
		const pending = await s.integrate(live.jobId);
		assert.equal(pending.record.next, "wait", pending.text);
		assert.match(pending.text, /main is red since/);
	}
	s.setGh({ routes: [{ match: "actions/runs?", replies: [{ code: 1, stderr: "HTTP 403: forbidden" }] }] });
	const denied = await s.integrate(live.jobId);
	assert.equal(denied.record.next, "wait", denied.text);
	assert.match(denied.text, /main is red since/);
	s.setGh({ routes: [] });
	s.setGh({ runs: [run(121, current, "completed", "success")] });
	const forward = await s.integrate(live.jobId);
	assert.match(forward.text, /fix-forward: head contains origin\/main and CI green/);
	assert.doesNotMatch(forward.record.reason, /main is red since/);
	s.post.mandates.pause(grant.id);
	const paused = await s.integrate(live.jobId);
	assert.match(paused.text, /not enforced — no active mandate covers demo; not blocking/);
	s.post.mandates.resume(grant.id);
	for (const login of ["other", undefined]) {
		latch(login);
		const released = await s.integrate(live.jobId);
		assert.match(released.text, /not blocking/, released.text);
		assert.doesNotMatch(released.record.reason, /main is red since/);
	}
	writeFileSync(file, "{not json");
	const corrupt = await s.integrate(live.jobId);
	assert.match(corrupt.text, /main-ci.json unreadable.*not blocking/);
	assert.equal(readFileSync(file, "utf8"), "{not json");
	latch("e2e");
	const mandates = join(s.home, LAYOUT.mandates);
	rmSync(mandates, { recursive: true, force: true });
	writeFileSync(mandates, "legacy directory replaced by a file");
	try {
		const unreadable = await s.integrate(live.jobId);
		assert.match(unreadable.text, /not enforced.*ENOTDIR.*not blocking/);
	} finally {
		rmSync(mandates);
		mkdirSync(mandates, { recursive: true });
		writeFileSync(s.post.mandates.file(grant.id), JSON.stringify(grant));
	}
});


test("landing: main latch writes refuse corruption introduced during an Actions read", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const tip = git(s.remote, "rev-parse", "main");
	s.post.mandates.issue({ projects: ["demo"], objective: "main CI corruption race", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
	const file = join(s.home, LAYOUT.state, "main-ci.json");
	const journal = join(s.home, LAYOUT.state, "wakeups.json");
	const routes: Route[] = [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }];
	s.setGh({ routes, runs: [] });
	await s.parent("Observe main latch corruption races.", [{ kind: "text", text: "Observing." }], async () => {
		for (const clear of [false, true]) {
			const valid = JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), projects: clear ? [{ project: "demo", red_since_sha: tip, red_since_at: isoTimestamp(), login: "e2e" }] : [] });
			writeFileSync(file, valid);
			const release = join(s.home, `release-main-${clear}`);
			const before = s.ghCalls().filter((call) => call.includes("actions/runs?head_sha=")).length;
			const prior = existsSync(journal) ? readFileSync(journal, "utf8") : "";
			s.setGh({ routes: [...routes, { match: "actions/runs?head_sha=", replies: [{ pass: true, untilFile: release }, { pass: true }] }], runs: [run(124, tip, "completed", clear ? "success" : "failure", { event: "push", triggering_actor: { login: "e2e" } })] });
			await waitFor(() => s.ghCalls().filter((call) => call.includes("actions/runs?head_sha=")).length, (count) => count > before, { timeoutMs: 30_000, what: "main read reaches external barrier" });
			const corrupt = clear ? "not json" : "{";
			writeFileSync(file, corrupt);
			writeFileSync(release, "continue");
			await waitFor(() => ({ body: existsSync(journal) ? readFileSync(journal, "utf8") : "", bytes: readFileSync(file, "utf8") }), ({ body, bytes }) => bytes !== corrupt || (body !== prior && body.includes("not overwritten")), { timeoutMs: 30_000, what: `${clear ? "clear" : "set"} completes its in-flight mutation` });
			assert.equal(readFileSync(file, "utf8"), corrupt, "in-flight latch mutation preserves corrupt bytes");
			s.setGh({ routes, runs: [] });
			writeFileSync(file, valid);
		}
	}, true);
});


test("landing: main CI scope skips inactive grants and login faults preserve latches until the next successful login", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const tip = git(s.remote, "rev-parse", "main");
	const issue = (projects = ["demo"], over = {}) => s.post.mandates.issue({ projects, objective: "main CI scope", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10, ...over });
	const loginCalls = () => s.ghCalls().filter((call) => call === "api user --jq .login").length;
	s.setGh({ routes: [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }], runs: [] });
	for (const state of ["absent", "paused", "revoked", "expired", "other"]) {
		const grant = state === "absent" ? undefined : issue(state === "other" ? ["other"] : ["demo"], state === "expired" ? { at: "2020-01-01T00:00:00Z", expiry: "2021-01-01T00:00:00Z" } : {});
		if (state === "paused") s.post.mandates.pause(grant!.id);
		if (state === "revoked") s.post.mandates.revoke(grant!.id);
		const before = s.ghCalls().length;
		await s.parent(`Observe ${state} main CI scope.`, [{ kind: "text", text: "Observing scope." }], async () => {
			const started = Date.now();
			await waitFor(() => Date.now() - started, (elapsed) => elapsed >= 2_200, { timeoutMs: 10_000, what: "two real CI timer intervals" });
			assert.ok(!s.ghCalls().slice(before).some((call) => call.includes("actions/runs")), `${state} scope reads no main CI`);
		}, true);
		if (grant && state !== "revoked") s.post.mandates.revoke(grant.id);
	}
	issue();
	const file = join(s.home, LAYOUT.state, "main-ci.json");
	const saved = JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), projects: [{ project: "demo", red_since_sha: tip, red_since_at: isoTimestamp(), login: "e2e" }] });
	writeFileSync(file, saved);
	const beforeFault = loginCalls();
	s.setGh({ routes: [{ match: "api user --jq .login", replies: [{ code: 1, stderr: "gh: not logged in" }] }], runs: [] });
	await s.parent("Observe an unreadable main CI login.", [{ kind: "text", text: "Observing login." }], async () => {
		await waitFor(() => loginCalls() >= beforeFault + 2 || s.ghCalls().some((call) => call.includes("actions/runs")), Boolean, { timeoutMs: 30_000, what: "login fault either retries or improperly reads CI" });
		assert.equal(readFileSync(file, "utf8"), saved, "unreadable login preserves latch bytes");
		assert.ok(!s.ghCalls().some((call) => call.includes("actions/runs")), "failed login reads no CI");
	}, true);
	s.setGh({ routes: [{ match: "api user --jq .login", replies: [{ stdout: "not a login" }, { stdout: "e2e" }] }], runs: [run(122, tip, "completed", "success", { event: "push", triggering_actor: { login: "E2E" } })] });
	const before = loginCalls();
	await s.parent("Retry main CI login.", [{ kind: "text", text: "Observing retry." }], async () => {
		await waitFor(() => JSON.parse(readFileSync(file, "utf8")).projects.length, (count) => count === 0, { timeoutMs: 30_000, what: "valid retried login clears own latch case-insensitively" });
		assert.equal(loginCalls() - before, 2, "invalid login retries, successful login is cached");
	}, true);
	const bot = JSON.parse(saved);
	bot.projects[0].login = "dependabot[bot]";
	writeFileSync(file, JSON.stringify(bot));
	s.setGh({ routes: [{ match: "api user --jq .login", replies: [{ stdout: "dependabot[bot]" }] }], runs: [run(123, tip, "completed", "success", { event: "push", triggering_actor: { login: "dependabot[bot]" } })] });
	await s.parent("Observe authenticated bot login.", [{ kind: "text", text: "Observing bot." }], async () => {
		await waitFor(() => JSON.parse(readFileSync(file, "utf8")).projects.length, (count) => count === 0, { timeoutMs: 30_000, what: "bot login is valid when it owns the run" });
		rmSync(s.post.registry.pathOf("demo"), { recursive: true, force: true });
		const beforeMissing = s.ghCalls().length;
		const started = Date.now();
		await waitFor(() => Date.now() - started, (elapsed) => elapsed >= 2_200, { timeoutMs: 10_000, what: "missing clone through real timer" });
		assert.ok(!s.ghCalls().slice(beforeMissing).some((call) => call.includes("actions/runs")), "missing clone reads no CI");
		const journal = join(s.home, LAYOUT.state, "wakeups.json");
		assert.ok(!readFileSync(journal, "utf8").includes("main CI (demo)"), "missing clone creates no project error");
	}, true);
});


test("landing: parked PR timer stores native CI for each observed head without reviving its released worker", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("parked CI", 109);
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	const parked = await s.post.awaitingMerge.park(live.jobId, { pr_url: live.prUrl, repo: "example/demo", head_sha: live.head, base: "main", handed_at: isoTimestamp() });
	assert.equal(parked.parked, true, JSON.stringify(parked));
	const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
	const state = (head: string, runs: RunRow[], response?: Reply, status = "OPEN") => s.setGh({ runs, routes: [
		{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] },
		{ match: "api graphql", replies: [json({ data: { rateLimit: { remaining: 5000 }, p0: { pullRequest: { url: live.prUrl, number: 109, state: status, headRefOid: head, headRefName: live.jobId, baseRefName: "main", mergedAt: status === "MERGED" ? isoTimestamp() : null, mergeCommit: status === "MERGED" ? { oid: MERGE } : null, latestOpinionatedReviews: { nodes: [] }, comments: page, reviews: page }, stacked: { nodes: [] } } } })] },
		...(response ? [{ match: "actions/runs?head_sha=", replies: [response] }] : []),
	] });
	const queries = (head: string) => s.ghCalls().filter((call) => call.includes(`actions/runs?head_sha=${head}`)).length;
	const observations = () => readRunEvents(s.home, live.jobId).filter((event) => event.type === "ci_observed").map((event) => event.payload as { event: string; head_sha: string });
	const watchFile = join(s.home, LAYOUT.awaitingMergeWatchFile);
	state(live.head, [run(109, live.head, "completed", "success")]);
	await s.parent("Observe parked PR CI.", [{ kind: "text", text: "Observing parked CI." }], async () => {
		await waitFor(() => s.post.ciWatch.store.job(live.jobId), (row) => row?.last_ci === "green", { timeoutMs: 30_000, what: "parked green through extension timer" });
		await waitFor(() => existsSync(watchFile) && JSON.parse(readFileSync(watchFile, "utf8")).prs.some((row: { head_sha: string }) => row.head_sha === live.head), Boolean, { timeoutMs: 10_000, what: "green sweep finishes" });
		const greenReads = queries(live.head);
		const greenSweep = readFileSync(watchFile, "utf8");
		await waitFor(() => readFileSync(watchFile, "utf8"), (body) => body !== greenSweep, { timeoutMs: 10_000, what: "another parked sweep before the idle interval" });
		assert.equal(queries(live.head), greenReads, "a settled head is not re-read before the idle interval");
		state(live.head, [], { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" });
		await waitFor(() => s.post.ciWatch.store.job(live.jobId), (row) => row?.last_error?.includes("HTTP 403") === true, { timeoutMs: 30_000, what: "parked denied CI after green" });
		assert.equal(s.post.ciWatch.store.job(live.jobId)?.last_ci, "unreadable", "permission denial replaces prior green");
		assert.equal(s.post.ciWatch.store.job(live.jobId)?.consecutive_failures, 1);
		const faultHead = "c".repeat(40);
		state(faultHead, [], { code: 1, stderr: "upstream gateway failure (HTTP 502)" });
		await waitFor(() => s.post.ciWatch.store.job(live.jobId), (row) => row?.head_sha === faultHead, { timeoutMs: 30_000, what: "parked transient fault" });
		assert.equal(s.post.ciWatch.store.job(live.jobId)?.last_ci, "unknown", "a transient fault is unknown");
		assert.equal(s.post.ciWatch.store.job(live.jobId)?.consecutive_failures, 2, "the observed head is stored before the fault");
		await waitFor(() => s.post.ciWatch.store.job(live.jobId)?.consecutive_failures, (count) => count === 3, { timeoutMs: 30_000, what: "another real transport fault grows the error interval" });
		await waitFor(() => JSON.parse(readFileSync(watchFile, "utf8")).prs.some((row: { head_sha: string }) => row.head_sha === faultHead), Boolean, { timeoutMs: 10_000, what: "fault sweep finishes" });
		const failedReads = queries(faultHead);
		const failedChecked = Date.parse(s.post.ciWatch.store.job(live.jobId)!.last_checked_at!);
		await waitFor(() => JSON.parse(readFileSync(watchFile, "utf8")).last_sweep_at as string, (at) => Date.parse(at) >= failedChecked + 1_250, { timeoutMs: 10_000, what: "parked sweeps exceed the base interval but remain inside error backoff" });
		assert.equal(queries(faultHead), failedReads, "a failing head backs off instead of re-reading every sweep");
		assert.deepEqual(observations().map((entry) => [entry.event, entry.head_sha]), [["ci_green", live.head]], "a fault journals nothing");
		const next = "b".repeat(40);
		state(next, [run(110, next, "in_progress", null)]);
		await waitFor(() => s.post.ciWatch.store.job(live.jobId), (row) => row?.head_sha === next && row.last_ci === "in_progress", { timeoutMs: 30_000, what: "moved parked head pending" });
		state(next, [run(110, next, "completed", "failure")]);
		await waitFor(() => s.post.ciWatch.store.job(live.jobId), (row) => row?.last_ci === "failed", { timeoutMs: 30_000, what: "parked red" });
		await waitFor(observations, (list) => list.length >= 2, { timeoutMs: 10_000, what: "parked red journaled" });
		assert.deepEqual(observations().map((entry) => [entry.event, entry.head_sha]), [["ci_green", live.head], ["ci_failed", next]], "parked terminal transitions are journaled once for their own head");
		assert.equal(s.post.fleet.require(live.jobId).phase, "awaiting_merge");
		assert.equal(s.post.manager.get(live.jobId), undefined, "native CI does not revive the released author");
		for (const [index, repark] of [false, true].entries()) {
			const staleHead = (repark ? "e" : "d").repeat(40);
			const id = 113 + index;
			const untilFile = join(s.home, `release-ci-${id}`);
			const oldReads = queries(staleHead);
			state(staleHead, [run(id, staleHead, "completed", "success")], { ...json({ total_count: 1, workflow_runs: [run(id, staleHead, "completed", "success")] }), untilFile });
			s.setGh({ jobs: { [id]: [{ id: id * 10, name: "test", status: "completed", conclusion: "success", steps: [{ name: "npm test", status: "completed", conclusion: "success" }] }] } });
			await waitFor(() => queries(staleHead), (count) => count > oldReads, { timeoutMs: 30_000, what: "parked CI read reaches external barrier" });
			const beforeSweep = readFileSync(watchFile, "utf8");
			const legacyHandoff = s.post.fleet.require(live.jobId).awaiting_merge!;
			await s.post.awaitingMerge.resume(live.jobId);
			if (!repark) {
				const fleetFile = join(s.home, LAYOUT.fleetFile);
				const original = readFileSync(fleetFile, "utf8");
				const legacy = JSON.parse(original);
				legacy.jobs.find((job: { job_id: string }) => job.job_id === live.jobId).awaiting_merge = legacyHandoff;
				try {
					writeFileSync(fleetFile, JSON.stringify(legacy));
					const rejected = await s.post.awaitingMerge.sweep();
					assert.equal(rejected.observed, 0);
					assert.match(rejected.errors.join("\n"), /violates the fleet contract/, "the public sweep rejects a legacy held parking record before observing CI");
				} finally {
					writeFileSync(fleetFile, original);
				}
			}
			const park = async () => {
				const result = await s.post.awaitingMerge.park(live.jobId, { pr_url: live.prUrl, repo: "example/demo", head_sha: live.head, base: "main", handed_at: isoTimestamp() });
				assert.equal(result.parked, true, JSON.stringify(result));
			};
			if (repark) await park();
			state(live.head, [run(109, live.head, "in_progress", null)]);
			writeFileSync(untilFile, "release");
			await waitFor(() => readFileSync(watchFile, "utf8"), (body) => body !== beforeSweep, { timeoutMs: 30_000, what: "parked sweep completes its delayed observation" });
			assert.ok(!observations().some((entry) => entry.head_sha === staleHead), "resume or re-park drops the old cycle's terminal observation");
			assert.notEqual(s.post.ciWatch.store.job(live.jobId)?.head_sha, staleHead, "a delayed old-cycle read cannot overwrite current CI");
			if (!repark) {
				const heldHead = "f".repeat(40);
				state(heldHead, [run(115, heldHead, "completed", "success")]);
				const heldSweep = readFileSync(watchFile, "utf8");
				await waitFor(() => readFileSync(watchFile, "utf8"), (body) => body !== heldSweep, { timeoutMs: 10_000, what: "parked timer skips a held job" });
				assert.equal(queries(heldHead), 0, "a held job is not read by the parked CI timer");
				await park();
			}
		}
		for (const status of ["CLOSED", "MERGED"]) {
			const head = (status === "CLOSED" ? "1" : "2").repeat(40);
			state(head, [run(116, head, "completed", "success")], undefined, status);
			await waitFor(() => JSON.parse(readFileSync(watchFile, "utf8")).prs, (rows) => rows.some((row: { head_sha: string }) => row.head_sha === head), { timeoutMs: 30_000, what: `parked ${status} snapshot observed` });
			assert.equal(queries(head), 0, "merged and closed snapshots do not read native CI");
		}
	});
	assert.equal(s.post.fleet.require(live.jobId).phase, "done", "the final external merge is observed after CI lifecycle checks");
	assert.equal(s.post.manager.get(live.jobId), undefined, "native CI does not revive the released author");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	assert.ok(readRunEvents(s.home, live.jobId).some((event) => event.type === "ci_observed"));
});


test("landing: held CI repairs the same real worker once while preserving an integration hold", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("held CI repair", 111, { repair: true });
	const peer = await s.held("held CI peer in same project", 113, { command: (branch) => `printf peer > peer.txt && git add peer.txt && git commit -q -m peer && git push -q -u origin ${branch}` });
	await s.post.continuation.serialize(peer.jobId, async () => {});
	await s.post.continuation.serialize(live.jobId, async () => {});
	const identity = s.post.fleet.require(live.jobId);
	const holds = new IntegrationHolds(s.home);
	holds.hold(live.jobId, "QA in progress");
	holds.hold(peer.jobId, "peer QA");
	s.setGh({ runs: [run(111, live.head, "completed", "failure")] });
	const gate = join(s.home, "held-ci-probe-release");
	s.setGh({ routes: [{ match: `pr view ${live.prUrl}`, replies: [{ pass: true }, { untilFile: gate, pass: true }, { pass: true }] }] });
	const beforeCalls = s.ghCalls().length;
	const ticking = s.tick(live.jobId);
	await waitFor(() => s.ghCalls().slice(beforeCalls).filter((call) => call.startsWith(`pr view ${live.prUrl}`)).length >= 2, Boolean, { timeoutMs: 30_000, what: "held CI confirmation reaches forge barrier" });
	const manual = s.post.integrate({ jobId: live.jobId });
	const peerAdvance = s.post.integrate({ jobId: peer.jobId });
	try {
		assert.equal(await Promise.race([peerAdvance.then(() => "advanced"), new Promise<string>((resolve) => setTimeout(() => resolve("queued"), 5_000))]), "queued", "another job in the project waits behind the CI repair");
	} finally {
		writeFileSync(gate, "release");
	}
	assert.equal((await peerAdvance).next, "wait");
	await ticking;
	const manualResult = await manual;
	assert.equal(manualResult.record.resolve_attempts, 1, "the queued manual advance sees the spent repair allowance");
	assert.notEqual(manualResult.next, "resolve", "the queued manual advance cannot promote twice");
	s.setGh({ routes: [] });
	const repaired = await waitFor(() => s.post.fleet.get(live.jobId), (record) => record?.phase === "held" && (record.supersessions ?? 0) === 1, { timeoutMs: 60_000, what: "same worker repair and second envelope" });
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.deepEqual([repaired?.worker.pid, repaired?.worker.session_id, repaired?.branch, repaired?.worktree], [identity.worker.pid, identity.worker.session_id, identity.branch, identity.worktree]);
	assert.equal(holds.get(live.jobId)?.reason, "QA in progress");
	const repairContext = JSON.stringify(s.provider.requests(`landing-${live.jobId}`));
	assert.ok(repairContext.includes("https://github.com/example/demo/actions/runs/111"));
	assert.equal(s.post.integrator.get(live.jobId)?.resolve_attempts, 1);
	const requests = JSON.stringify(s.provider.requests(`landing-${live.jobId}`).map((request) => request.body.messages));
	assert.match(requests, /run 111/);
	assert.match(requests, /integration hold remains active/);
	assert.equal(existsSync(join(s.home, paths.envelopeFile(live.jobId))), true, "repair submits a fresh envelope");
	assert.equal(existsSync(join(s.home, paths.supersededEnvelopeFile(live.jobId, 1))), true, "initial report is archived");
	const head = git(live.worktree, "rev-parse", "HEAD");
	assert.notEqual(head, live.head, "the repaired report carries a newly pushed head");
	s.setGh({ runs: [run(112, head, "completed", "success")] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "wait", "green CI preserves the QA hold");
	assert.equal(s.post.integrator.get(live.jobId)?.resolve_attempts, 1);
	const beforeStartup = s.post.integrator.get(live.jobId)!.updated_at;
	await s.parent("Inspect held repair after restarting the parent.", [{ kind: "text", text: "Startup observed." }], async () => {
		await waitFor(() => s.post.integrator.get(live.jobId)?.updated_at, (at) => at !== beforeStartup, { timeoutMs: 30_000, what: "startup recomputes held repair" });
	});
	assert.notEqual(s.post.integrator.get(live.jobId)?.updated_at, beforeStartup, "startup recomputes the integration record");
	assert.equal(s.post.integrator.get(live.jobId)?.next, "wait", "startup preserves green held repair");
	assert.equal(s.post.integrator.get(live.jobId)?.resolve_attempts, 1, "startup preserves cumulative allowance");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	assert.equal(new CheckpointStore(s.home, { kind: "merge" }).list().length, 0);
	assert.equal(new AwaitingStore({ home: s.home }).list().length, 0);
	holds.release(live.jobId);
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "review", "release still requires review of the repaired head");
	holds.hold(live.jobId, "QA in progress");
	s.setGh({ runs: [run(112, head, "completed", "failure", { run_attempt: 2 })] });
	const beforeAllowanceStartup = s.post.integrator.get(live.jobId)!.updated_at;
	await s.parent("Inspect the repaired head's failing CI after restart.", [{ kind: "text", text: "Startup inspected the red repaired head." }], async () => {
		await waitFor(() => s.post.integrator.get(live.jobId)?.updated_at, (at) => at !== beforeAllowanceStartup, { timeoutMs: 30_000, what: "startup recomputes the spent repair allowance" });
	});
	assert.notEqual(s.post.integrator.get(live.jobId)?.updated_at, beforeAllowanceStartup, "startup recomputes the allowance record without a manual integrate call");
	assert.match(s.post.integrator.get(live.jobId)?.reason ?? "", /already asked once/, "restarted parent reads the spent allowance before looking for a local worker");
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "surface", "a second red result exhausts the repair allowance");
	assert.equal(s.post.fleet.require(live.jobId).supersessions, 1, "no second promotion");
});


test("landing S09: exact head and branch evidence distinguish pending, superseded and absent CI", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["pending", "older", "present", "none", "denied-branch", "malformed-branch", "invalid-branch", "branch-green", "denied-workflows", "network-workflows", "empty-workflows", "malformed-workflows"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 CI boundaries", 301);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const checkpoints = new CheckpointStore(s.home, { kind: "merge" });
		const scope = live.head.slice(0, 12);
		const routes: Route[] = [];
		let rows: RunRow[] = [];
		if (mode === "pending") rows = [run(301, live.head, "in_progress", null)];
		if (mode === "older") rows = [run(301, "b".repeat(40), "completed", "success")];
		if (mode === "older") routes.push({ match: "actions/runs?branch=", replies: [runsBody(rows)] });
		if (mode.endsWith("branch")) routes.push({ match: "actions/runs?branch=", replies: [mode === "denied-branch" ? { code: 1, stderr: "HTTP 403" } : mode === "malformed-branch" ? { stdout: "<html>502</html>" } : runsBody([run(301, "invalid", "completed", "success")])] });
		if (mode === "branch-green") routes.push({ match: "actions/runs?branch=", replies: [runsBody([run(301, live.head, "completed", "success")])] });
		const workflows = mode === "none" || mode.endsWith("branch") ? json({ total_count: 0, workflows: [] }) : mode === "denied-workflows" ? { code: 1, stderr: "HTTP 403" } : mode === "network-workflows" ? { code: 1, stderr: "dial tcp: no such host" } : mode === "empty-workflows" ? { code: 1, stdout: "" } : mode === "malformed-workflows" ? { stdout: "<html>502</html>" } : json({ total_count: 1, workflows: [{ id: 1, name: "ci" }] });
		routes.push({ match: "actions/workflows", replies: [workflows] });
		s.setGh({ integration: true, runs: rows, routes });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, mode === "none" ? "advance" : ["pending", "older"].includes(mode) ? "wait" : "surface", `${mode}: ${result.text}`);
		assert.equal(mergedCalls(result.calls).length, mode === "none" ? 1 : 0, mode);
		if (mode === "pending" || mode === "older") {
			assert.equal(checkpoints.get(live.jobId, { scope }), undefined);
			assert.ok(!result.calls.some((call) => call.includes("actions/workflows")));
		} else if (mode === "none") {
			assert.equal(result.record.record.merge_authority?.kind, "repo_derived");
			assert.equal(checkpoints.get(live.jobId, { scope }), undefined);
			assert.ok(result.record.facts.some((fact) => fact.startsWith("ci configuration: none (authoritative_empty)")));
		} else {
			assert.equal(checkpoints.get(live.jobId, { scope })?.decision, "pending", mode);
			assert.ok(!result.record.facts.some((fact) => fact.startsWith("ci: green")), mode);
			if (mode.endsWith("branch")) assert.ok(result.record.facts.some((fact) => fact.startsWith("ci: branch runs unreadable")), result.text);
			if (mode === "branch-green") assert.ok(!result.calls.some((call) => call.includes("/attempts/")));
			if (mode.endsWith("workflows")) assert.ok(result.record.facts.some((fact) => fact.startsWith("ci configuration: unreadable (")), result.text);
		}
		if (mode === "present") {
			checkpoints.decide(live.jobId, true, { by: "operator command", scope });
			const approved = await s.integrate(live.jobId);
			assert.equal(approved.record.next, "advance", approved.text);
			assert.equal(approved.record.record.merge_authority?.kind, "human_checkpoint");
			assert.ok(approved.calls.some((call) => call.includes(`--match-head-commit ${live.head}`)));
		}
	});
});

test("landing S09: repository refusals and draft transitions preserve head authority", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["blocked", "approved-blocked", "unreadable-rules", "unstable", "no-ci-blocked", "auto", "moved", "unreviewed-draft", "stale-draft", "ready", "ready-unreadable-ci", "ready-moved", "ready-undo-refused", "ready-refused", "reminder"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 permission boundaries", 302);
		if (mode !== "unreviewed-draft") writeWindowPass(s.home, live.jobId, mode === "stale-draft" ? "b".repeat(40) : live.head, "2026-01-01T00:00:00Z");
		const view = { number: 302, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", isDraft: false };
		if (mode === "approved-blocked") {
			const approved = new CheckpointStore(s.home, { kind: "merge" });
			const scope = live.head.slice(0, 12);
			approved.request({ jobId: live.jobId, scope, question: "Merge this head?" });
			approved.decide(live.jobId, true, { by: "operator command", scope });
		}
		const changed = { ...view, ...(mode.includes("blocked") || mode === "unreadable-rules" || mode === "reminder" ? { mergeStateStatus: "BLOCKED", reviewDecision: mode === "unreadable-rules" ? "" : "REVIEW_REQUIRED" } : mode === "unstable" ? { mergeStateStatus: "UNSTABLE" } : mode === "auto" ? { autoMergeRequest: {} } : {}), ...(mode.includes("draft") || mode.startsWith("ready") ? { isDraft: true } : {}) };
		const routes: Route[] = [{ match: "pr view", replies: [json(changed), ...(mode === "moved" ? [json({ ...changed, headRefOid: "b".repeat(40) })] : mode === "ready-moved" || mode === "ready-undo-refused" ? [json(changed), json({ ...changed, isDraft: false, headRefOid: "b".repeat(40) })] : mode === "ready-unreadable-ci" ? [json(view)] : mode.startsWith("ready") ? [json(changed), json(view)] : [])] }];
		if (mode.startsWith("ready") && mode !== "ready-refused") routes.push({ match: "pr ready", replies: [{ stdout: "" }] });
		if (mode === "ready-refused") routes.unshift({ match: "pr ready", replies: [{ code: 1, stderr: "GraphQL: forbidden" }] });
		if (mode === "ready-undo-refused") routes.unshift({ match: "pr ready --undo", replies: [{ code: 1, stderr: "HTTP 502" }] });
		if (mode === "unreadable-rules") routes.push({ match: "rules/branches", replies: [{ code: 1, stderr: "HTTP 403" }] });
		if (mode === "no-ci-blocked" || mode === "ready-unreadable-ci") routes.push({ match: "actions/workflows", replies: [mode === "no-ci-blocked" ? json({ total_count: 0, workflows: [] }) : { code: 1, stderr: "HTTP 403" }] });
		s.setGh({ integration: true, runs: mode === "no-ci-blocked" || mode === "ready-unreadable-ci" ? [] : [run(302, live.head, "completed", "success")], routes });
		const result = await s.integrate(live.jobId);
		const expected = mode.endsWith("draft") ? "review" : mode === "moved" || mode === "ready-moved" ? "wait" : mode === "ready" || mode === "ready-unreadable-ci" ? "advance" : "surface";
		assert.equal(result.record.next, expected, `${mode}: ${result.text}`);
		assert.equal(mergedCalls(result.calls).length, 0, mode);
		const rows = new AwaitingStore({ home: s.home }).list();
		if (["blocked", "unreadable-rules", "unstable", "no-ci-blocked", "reminder"].includes(mode)) assert.equal(rows.filter((row) => row.state === "open").length, 1, mode);
		const store = new CheckpointStore(s.home, { kind: "merge" });
		assert.equal(store.get(live.jobId, { scope: live.head.slice(0, 12) })?.decision, mode === "approved-blocked" ? "approved" : undefined, "repository refusals preserve existing authorization and mint none");
		if (mode.endsWith("draft")) {
			assert.equal(result.calls.filter((call) => call.startsWith("pr ready")).length, 0);
			assert.equal(rows.length + s.post.escalations.list({ jobId: live.jobId }).length, 0);
		}
		if (mode === "ready") {
			s.setGh({ routes: [] });
			const merged = await s.integrate(live.jobId);
			assert.equal(merged.record.next, "advance", merged.text);
			assert.equal(mergedCalls(merged.calls).length, 1);
			assert.equal(s.ghCalls().filter((call) => call.startsWith("pr ready")).length, 1);
		}
		if (mode === "ready-moved") {
			assert.match(result.text, /returned to draft/);
			s.setGh({ routes: [{ match: "pr view", replies: [json({ ...view, isDraft: true, headRefOid: "b".repeat(40) })] }] });
			const held = await s.integrate(live.jobId);
			assert.equal(held.record.next, "review", held.text);
			assert.equal(s.ghCalls().filter((call) => call.startsWith("pr ready")).length, 2);
		}
		if (mode === "ready-undo-refused") assert.match(result.text, /undo refused/);
		if (mode === "ready-refused") assert.match(result.text, /ready refused: GraphQL: forbidden/);
		if (mode === "reminder") {
			await s.integrate(live.jobId);
			assert.equal(new AwaitingStore({ home: s.home }).list().length, 1);
			s.setGh({ routes: [] });
			const merged = await s.integrate(live.jobId);
			assert.equal(merged.record.next, "advance", merged.text);
			assert.equal(mergedCalls(merged.calls).length, 1);
			assert.equal(new AwaitingStore({ home: s.home }).list()[0]?.state, "withdrawn");
		}
	});
});

test("landing S09: external PR facts stop or finish without an automated merge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["closed", "foreign", "denied", "merged"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 observed PR facts", 303);
		const view = { number: 303, url: live.prUrl, state: mode === "closed" ? "CLOSED" : mode === "merged" ? "MERGED" : "OPEN", headRefName: mode === "foreign" ? "someone-else" : live.jobId, headRefOid: live.head, baseRefName: "main", mergedAt: "2026-10-01T00:00:00Z", mergeCommit: { oid: live.head } };
		s.setGh({ routes: [{ match: "pr view", replies: [mode === "denied" ? { code: 1, stderr: "HTTP 403: Resource not accessible\nmore" } : json(view)] }] });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, mode === "merged" ? "done" : mode === "denied" ? "retry" : "surface", result.text);
		assert.equal(mergedCalls(result.calls).length, 0);
		if (mode === "merged") {
			assert.equal(result.record.merge?.recorded, true);
			assert.equal(s.post.fleet.require(live.jobId).phase, "done");
			assert.equal(result.record.end_state?.br_closed, true);
			assert.equal(new CheckpointStore(s.home, { kind: "merge" }).get(live.jobId, { scope: live.head.slice(0, 12) }), undefined);
		} else {
			assert.equal(readMergeReceipt(s.home, live.jobId), undefined);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held");
			if (mode === "denied") assert.match(result.text, /403/);
			if (mode === "foreign") assert.match(result.text, /not this job's delivery/);
		}
	});
});

test("landing S09: GitLab integration observes the target and never asks GitHub to merge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["squash", "merge-commit", "open", "unknown", "closed", "foreign", "no-target", "unavailable", "fork", "held", "contradictory-base", "bound"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1", CP_E2E_GITLAB_TOKEN: "S09-local-canary" } });
		const live = await s.held("S09 GitLab facts", 304);
		const lab = await startFakeGitlab(t, s.remote);
		await s.project("lab", { cloneUrl: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_E2E_GITLAB_TOKEN" } });
		git(s.remote, "branch", "develop", live.head);
		const url = `${lab.web}/o/lab/-/merge_requests/7`;
		await s.post.fleet.patch(live.jobId, { project: "lab", receipts: [{ kind: "pr", status: "open", title: "MR", url }], ...(mode === "bound" ? { bound_pr: { number: 7, url, base: "develop" } } : {}) });
		lab.mrs[7] = { status: mode === "unavailable" ? 503 : 200, body: { id: 7, iid: 7, project_id: 42, source_project_id: mode === "fork" ? 43 : 42, target_project_id: 42, state: mode === "open" ? "opened" : mode === "unknown" ? "unknown" : mode === "closed" ? "closed" : "merged", source_branch: mode === "foreign" ? "another-branch" : live.jobId, target_branch: mode === "no-target" ? undefined : "develop", sha: live.head, merge_commit_sha: mode === "merge-commit" ? live.head : null, squash_commit_sha: mode === "merge-commit" ? null : live.head, merged_at: "2026-10-01T00:00:00Z", web_url: url } };
		if (mode === "held") new IntegrationHolds(s.home).hold(live.jobId, "operator pause");
		const before = s.ghCalls().length;
		if (mode === "squash") git(s.remote, "branch", "-D", live.jobId);
		const result = await s.post.integrate({ jobId: live.jobId, ...(mode === "merge-commit" ? { strategy: "squash" as const } : {}) });
		const lands = ["squash", "merge-commit", "contradictory-base", "bound"].includes(mode);
		assert.equal(result.next, lands ? "done" : mode === "held" ? "wait" : mode === "unavailable" || mode === "no-target" ? "retry" : "surface", result.reason);
		assert.deepEqual(s.ghCalls().slice(before), [], "GitLab integration runs no gh command");
		if (lands) {
			assert.equal(result.merge?.receipt?.base_branch, "develop");
			assert.equal(result.merge?.receipt?.strategy, mode === "merge-commit" ? "unknown" : "squash");
			assert.equal(result.merge?.receipt?.merge_commit_sha, live.head);
			assert.equal(result.end_state?.br_closed, true);
			assert.equal(result.merge?.receipt?.forge?.provider, "gitlab");
			assert.equal(result.merge?.receipt?.head_branch_deleted, mode === "squash");
			assert.equal(lab.asked.length, 2);
			const again = await s.post.integrate({ jobId: live.jobId });
			assert.equal(again.next, "done");
			assert.equal(again.merge?.recorded, false);
			assert.equal(lab.asked.length, 2, "receipt fast path reads no forge");
			if (mode === "bound") assert.notEqual(git(s.remote, "show-ref", `refs/heads/${live.jobId}`), "");
			if (mode === "contradictory-base") {
				const wrong = await s.post.integrate({ jobId: live.jobId, base: "main" });
				assert.equal(wrong.next, "surface");
				assert.match(wrong.reason, /landed on develop, not main/);
			}
		} else {
			assert.equal(readMergeReceipt(s.home, live.jobId), undefined);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held");
			const reasons: Record<string, RegExp> = { open: /merge it on GitLab/, unknown: /is unknown/, closed: /closed and was never merged/, foreign: /not this job's delivery/, "no-target": /response names no source or target branch/, unavailable: /could not be read \(unavailable:.*503/, fork: /unsupported:.*fork/, held: /GitLab CI is not read in v1.*integration held/ };
			assert.match(result.reason, reasons[mode]!);
			if (mode === "held") assert.equal(lab.asked.length, 0);
		}
	});
});

test("landing S09: a real repair stays single while active and conflict handoffs follow heads", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const conflict of [false, true]) await t.test(conflict ? "conflict" : "red", async (t) => {
		const s = await startStack(t);
		const gate = join(s.home, "repair-release");
		const live = await s.held("S09 repair lifecycle", 305, { repairGate: gate });
		const view = { number: 305, url: live.prUrl, state: "OPEN", mergeable: conflict ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		s.setGh({ runs: [run(305, live.head, "completed", "failure", { html_url: "https://github.com/example/demo/actions/runs/305" })], routes: [{ match: "pr view", replies: [json(view)] }, { match: "actions/workflows", replies: [json({ total_count: 0, workflows: [] })] }] });
		const first = await s.post.integrate({ jobId: live.jobId });
		assert.equal(first.next, "resolve", first.reason);
		assert.equal(first.step, conflict ? "conflict" : "ci");
		if (!conflict) {
			assert.ok(first.facts.some((fact) => /ci: failed.*run 305 https:\/\/github.com\/example\/demo\/actions\/runs\/305/.test(fact)), first.facts.join("\n"));
			assert.ok(!s.ghCalls().some((call) => call.includes("actions/workflows")));
		}
		assert.equal(first.record.resolve_attempts, 1);
		await waitFor(() => existsSync(`${gate}.entered`), Boolean, { timeoutMs: 30_000, what: "repair waits at its worker barrier" });
		try {
			const requests = s.provider.requests(`landing-${live.jobId}`).length;
			for (const green of [false, true]) {
				s.setGh({ runs: [run(305, live.head, green ? "completed" : "in_progress", green ? "success" : null)] });
				const active = await s.post.integrate({ jobId: live.jobId });
				assert.equal(active.next, "resolve", active.reason);
				assert.match(active.reason, /worker phase waiting|wait for its report/);
				assert.equal(active.record.resolve_attempts, 1);
			}
			assert.equal(s.provider.requests(`landing-${live.jobId}`).length, requests, "active repair receives no second prompt");
			assert.equal(s.post.fleet.require(live.jobId).supersessions, 1);
		} finally { writeFileSync(gate, "release"); }
		await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held", { timeoutMs: 30_000, what: "repair report is accepted" });
		s.setGh({ runs: [run(305, live.head, "completed", "failure")] });
		const exhausted = await s.post.integrate({ jobId: live.jobId });
		assert.equal(exhausted.next, "surface", exhausted.reason);
		assert.equal(s.post.fleet.require(live.jobId).supersessions, 1);
		if (conflict) {
			const quiet = await s.post.integrate({ jobId: live.jobId });
			assert.equal(quiet.next, "wait");
			assert.match(quiet.reason, /until the branch moves/);
			assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "integration_surfaced").length, 1);
			git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "new conflict head");
			git(live.worktree, "push", "--quiet", "origin", live.jobId);
			const moved = git(live.worktree, "rev-parse", "HEAD");
			s.setGh({ routes: [{ match: "pr view", replies: [json({ ...view, headRefOid: moved })] }] });
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "resolve");
			await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held" && record.supersessions === 2, { timeoutMs: 30_000, what: "new conflict head receives one report" });
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "surface");
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "wait");
			assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "integration_surfaced").length, 2);
		}
		const handoff = s.provider.requests(`landing-${live.jobId}`).flatMap((request) => request.body.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).find((text) => text.includes(conflict ? `${live.prUrl} conflicts with` : "CI is red on the pushed head")) ?? "";
		assert.match(handoff, /plain.*git push/);
		assert.match(handoff, new RegExp(`rev-list --count HEAD\\.\\.origin/${live.jobId}`));
		assert.match(handoff, new RegExp(`git merge origin/${live.jobId}`));
		assert.doesNotMatch(handoff, /git reset|git rebase|force-with-lease|advanced on the server/);
		if (conflict) {
			assert.match(handoff, /git fetch origin && git merge origin\/main/);
			assert.match(handoff, /both sides survive/);
		} else {
			assert.match(handoff, /run 305 https:\/\/github.com\/example\/demo\/actions\/runs\/305/);
			assert.match(handoff, new RegExp(`rev-list --count origin/${live.jobId}\\.\\.HEAD`));
		}
		assert.equal(mergedCalls(s.ghCalls()).length, 0);
		assert.equal(new CheckpointStore(s.home, { kind: "merge" }).get(live.jobId, { scope: live.head.slice(0, 12) }), undefined);
	});
});

test("landing S09: public promotion before or during integration waits for a fresh report", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const fallback of [false, true]) for (const during of [false, true]) await t.test(`${fallback ? "checkpoint" : "repository"}/waiting/${during ? "during permission" : "before integration"}`, async (t) => {
		const s = await startStack(t);
		const gate = join(s.home, "public-send-release");
		const live = await s.held("S09 public promotion", 306, { repairGate: gate, repair: true });
		const approve = (head: string) => {
			const store = new CheckpointStore(s.home, { kind: "merge" });
			const scope = head.slice(0, 12);
			store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
			store.decide(live.jobId, true, { by: "operator command", scope });
		};
		if (fallback) approve(live.head);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const forgeGate = join(s.home, "forge-release");
		const view = { number: 306, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: fallback ? undefined : "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		s.setGh({ integration: true, runs: [run(306, live.head, "completed", !fallback && !during ? "failure" : "success")], routes: [{ match: "pr view", replies: during ? [json(view), { ...json(view), untilFile: forgeGate }] : [json(view)] }] });
		const advancing = during ? s.post.integrate({ jobId: live.jobId }) : undefined;
		try {
			if (during) await waitFor(() => s.ghCalls().filter((call) => call.startsWith("pr view")).length, (count) => count >= 2, { timeoutMs: 30_000, what: "permission read waits at forge" });
			await s.post.send({ jobId: live.jobId, message: "Revise and report the current pushed head." });
			await waitFor(() => existsSync(`${gate}.entered`), Boolean, { timeoutMs: 30_000, what: "public send reaches worker gate" });
		} finally { writeFileSync(forgeGate, "release"); }
		try {
			const result = await (advancing ?? s.post.integrate({ jobId: live.jobId }));
			assert.equal(result.next, "resolve", result.reason);
			assert.equal(result.record.resolve_attempts, 0);
			assert.equal(mergedCalls(s.ghCalls()).length, 0);
		} finally {
			writeFileSync(gate, "release");
		}
		await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held", { timeoutMs: 30_000, what: "fresh public report" });
		const moved = git(live.worktree, "rev-parse", "HEAD");
		assert.notEqual(moved, live.head);
		const movedView = { ...view, headRefOid: moved };
		s.setGh({ routes: [{ match: "pr view", replies: [json(movedView)] }], runs: [run(306, moved, "completed", "success")] });
		const unreviewed = await s.post.integrate({ jobId: live.jobId });
		assert.equal(unreviewed.next, "review", unreviewed.reason);
		writeWindowPass(s.home, live.jobId, moved, "2026-01-01T00:00:00Z");
		if (fallback) approve(moved);
		assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "advance");
		assert.ok(s.ghCalls().some((call) => call.includes(`--match-head-commit ${moved}`)));
	});
});

test("landing S09: infra reruns once while second attempts and test failures promote", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["infra", "second", "test"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 infra repair", 307);
		const jobs = [setupJob(mode === "test" ? "Run suite (typecheck + tests)" : "Install treehouse")];
		s.setGh({ runs: [run(307, live.head, "completed", "failure", { run_attempt: mode === "second" ? 2 : 1 })], jobs: { "307": jobs } });
		const first = await s.post.integrate({ jobId: live.jobId });
		assert.equal(first.next, mode === "infra" ? "wait" : "resolve", first.reason);
		if (mode === "infra") {
			assert.match(first.reason, /reran the failed jobs once/);
			assert.equal(s.post.fleet.require(live.jobId).supersessions ?? 0, 0);
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "resolve");
		}
		assert.equal(s.ghCalls().filter((call) => call.startsWith("run rerun")).length, mode === "infra" ? 1 : 0);
		assert.equal(s.post.fleet.require(live.jobId).supersessions, 1);
		assert.equal(mergedCalls(s.ghCalls()).length, 0);
	});
});

test("landing S09: a missing implementer surfaces without spending the same-head repair", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const gate = join(s.home, "revived-repair");
	const live = await s.held("S09 missing implementer", 308, { repairGate: gate });
	s.setGh({ routes: [{ match: "pr view", replies: [json({ number: 308, url: live.prUrl, state: "OPEN", mergeable: "CONFLICTING", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" })] }] });
	await s.post.shutdown();
	const restarted = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...s.agentDir.env }, holdsParentLock: () => true });
	t.after(() => restarted.shutdown());
	const missing = await restarted.integrate({ jobId: live.jobId });
	assert.equal(missing.next, "surface", missing.reason);
	assert.match(missing.reason, /no live worker/);
	assert.equal(missing.record.resolve_attempts, 0);
	assert.equal(restarted.manager.active.length, 0);
	writeFileSync(gate, "release");
	await restarted.revive(live.jobId);
	const delivered = await restarted.integrate({ jobId: live.jobId });
	assert.equal(delivered.next, "resolve", delivered.reason);
	assert.equal(delivered.record.resolve_attempts, 1);
	assert.equal(mergedCalls(s.ghCalls()).length, 0);
});

test("landing: held repair rejects invalid PR identity, CI, holds, drains and worktree hazards", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("held repair boundary matrix", 121);
	const holds = new IntegrationHolds(s.home);
	const view = { number: 121, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
	const original = s.post.fleet.require(live.jobId);
	const check = async (label: string, expected: string) => {
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, expected, `${label}: ${result.text}`);
		assert.equal(result.record.record.resolve_attempts, 0, label);
		assert.equal(s.post.fleet.require(live.jobId).supersessions, original.supersessions, label);
		assert.deepEqual(mergedCalls(result.calls), [], label);
		assert.ok(existsSync(holds.file(live.jobId)), label);
		return result;
	};
	holds.hold(live.jobId, "boundary QA");
	for (const patch of [{ state: "CLOSED" }, { state: "MERGED" }, { headRefName: "foreign" }, { headRefName: undefined }, { headRefOid: "invalid" }, { headRefOid: undefined }]) {
		s.setGh({ runs: [run(121, live.head, "completed", "failure")], routes: [{ match: "pr view", replies: [json({ ...view, ...patch })] }] });
		await check(JSON.stringify(patch), "wait");
	}
	for (const rows of [[], [run(121, live.head, "in_progress", null)], [run(121, live.head, "completed", "success")], [run(121, "b".repeat(40), "completed", "failure")]]) {
		s.setGh({ runs: rows, routes: [] });
		const result = await check(JSON.stringify(rows), "wait");
		if (rows[0]?.conclusion === "success") {
			assert.match(result.text, /CI green/);
			assert.equal(result.record.head_sha, live.head);
			assert.equal(result.record.pr_url, live.prUrl);
		}
	}
	for (const stdout of ["{", "null", "{}", '[{"conclusion":"failure"}]']) {
		s.setGh({ routes: [{ match: "actions/runs?head_sha=", replies: [{ stdout }] }] });
		await check(`malformed CI ${stdout}`, "wait");
	}
	for (const match of ["pr view", "actions/runs?head_sha="]) {
		s.setGh({ routes: [{ match, replies: [{ code: 1, stderr: "HTTP 403" }] }] });
		await check(`denied ${match}`, "wait");
	}
	s.setGh({ routes: [] });
	for (const body of ["{", "{}", JSON.stringify({ job_id: "foreign", reason: "QA", held_at: isoTimestamp() })]) {
		writeFileSync(holds.file(live.jobId), body);
		const result = await check(body, "wait");
		assert.deepEqual(result.calls, [], "invalid hold starts no process");
	}
	holds.release(live.jobId);
	holds.hold(live.jobId, "boundary QA");
	for (const body of ["{", JSON.stringify({ started_at: isoTimestamp(), jobs: [] })]) {
		writeFileSync(drainFile(s.home), body);
		const result = await check(body, "wait");
		assert.deepEqual(result.calls, [], "drain starts no process");
		assert.ok(result.record.facts.some((fact) => fact.startsWith("ci: not read — ")));
		rmSync(drainFile(s.home));
	}
	s.setGh({ runs: [run(121, live.head, "completed", "failure")], routes: [] });
	for (const phase of ["waiting", "launching", "failed", "done", "unreported", "held"]) {
		const file = join(s.home, LAYOUT.fleetFile);
		const before = readFileSync(file, "utf8");
		const legacy = JSON.parse(before);
		const row = legacy.jobs.find((entry: { job_id: string }) => entry.job_id === live.jobId);
		row.phase = phase;
		if (phase === "held") delete row.reported_at;
		writeFileSync(file, JSON.stringify(legacy));
		try {
			if (["launching", "failed", "unreported", "held"].includes(phase)) {
				await assert.rejects(() => s.integrate(live.jobId), /violates the fleet contract/, phase);
			} else {
				const result = await s.integrate(live.jobId);
				assert.equal(result.record.next, "wait", `${phase}: ${result.text}`);
				assert.deepEqual(mergedCalls(result.calls), [], phase);
			}
		} finally { writeFileSync(file, before); }
	}
	const gitDir = git(live.worktree, "rev-parse", "--absolute-git-dir");
	for (const hazard of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
		const file = join(gitDir, hazard);
		writeFileSync(file, "unfinished");
		try { await check(hazard, "surface"); }
		finally { rmSync(file, { force: true }); }
	}
	const defaultsFile = join(s.home, LAYOUT.mandateDefaultsFile);
	const defaultsBefore = existsSync(defaultsFile) ? readFileSync(defaultsFile, "utf8") : undefined;
	writeFileSync(defaultsFile, JSON.stringify({ deny_projects: ["demo"] }));
	try {
		const refused = await s.integrate(live.jobId);
		assert.equal(refused.record.next, "surface", refused.text);
		assert.match(refused.record.resolve_error ?? "", /project demo is denied/);
		assert.equal(refused.record.record.resolve_attempts, 0);
		assert.equal(holds.get(live.jobId)?.reason, "boundary QA");
	} finally {
		if (defaultsBefore === undefined) rmSync(defaultsFile);
		else writeFileSync(defaultsFile, defaultsBefore);
	}
});


test("landing: held CI revalidates local state after each external read", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("held CI read races", 122);
	const holds = new IntegrationHolds(s.home);
	const view = { number: 122, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
	const envelopeFile = join(s.home, paths.envelopeFile(live.jobId));
	const fleetFile = join(s.home, LAYOUT.fleetFile);
	for (const at of ["ci", "confirm"]) {
		for (const change of ["drain", "invalid-drain", "invalid-hold", "release", "blocked", "unreadable-report", "waiting", "generation", "hazard", "closed", "branch", "head", "unreadable-pr"]) {
			holds.hold(live.jobId, "race QA");
			const fleetBefore = readFileSync(fleetFile, "utf8");
			const envelopeBefore = readFileSync(envelopeFile, "utf8");
			const barrier = join(s.home, `release-${at}-${change}`);
			const gitHazard = join(git(live.worktree, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD");
			const changedView = { ...view, ...(change === "closed" ? { state: "CLOSED" } : change === "branch" ? { headRefName: "foreign" } : change === "head" ? { headRefOid: "b".repeat(40) } : {}) };
			const changedReply: Reply = change === "unreadable-pr" ? { code: 1, stderr: "HTTP 403" } : json(changedView);
			const routes: Route[] = at === "ci"
				? [{ match: "actions/runs?head_sha=", replies: [{ ...runsBody([run(122, live.head, "completed", "failure")]), untilFile: barrier }] }]
				: [{ match: "pr view", replies: [json(view), { ...changedReply, untilFile: barrier }] }];
			s.setGh({ runs: [run(122, live.head, "completed", "failure")], routes });
			const before = s.ghCalls().length;
			const advancing = s.integrate(live.jobId);
			try {
				await waitFor(() => s.ghCalls().slice(before), (calls) => at === "ci" ? calls.some((call) => call.includes("actions/runs?head_sha=")) : calls.filter((call) => call.startsWith("pr view")).length >= 2, { timeoutMs: 30_000, what: `${at}/${change} reaches external barrier` });
				if (change === "drain" || change === "invalid-drain") writeFileSync(drainFile(s.home), change === "drain" ? JSON.stringify({ started_at: isoTimestamp(), jobs: [] }) : "{");
				if (change === "invalid-hold") writeFileSync(holds.file(live.jobId), "{");
				if (change === "release") holds.release(live.jobId);
				if (change === "unreadable-report") writeFileSync(envelopeFile, "{");
				if (change === "blocked") {
					const report = JSON.parse(envelopeBefore);
					report.envelope.status = "blocked";
					report.envelope.blockers = ["QA blocker"];
					writeFileSync(envelopeFile, JSON.stringify(report));
				}
				if (change === "waiting" || change === "generation") {
					const fleet = JSON.parse(fleetBefore);
					const row = fleet.jobs.find((entry: { job_id: string }) => entry.job_id === live.jobId);
					if (change === "waiting") row.phase = "waiting";
					else row.supersessions = (row.supersessions ?? 0) + 1;
					writeFileSync(fleetFile, JSON.stringify(fleet));
				}
				if (change === "hazard") writeFileSync(gitHazard, live.head);
				if (["closed", "branch", "head", "unreadable-pr"].includes(change)) {
					s.setGh({ routes: [{ match: "pr view", replies: [changedReply] }] });
				}
			} finally { writeFileSync(barrier, "release"); }
			try {
				const result = await advancing;
				assert.equal(result.record.next, ["blocked", "unreadable-report", "hazard"].includes(change) ? "surface" : "wait", `${at}/${change}: ${result.text}`);
				assert.equal(result.record.record.resolve_attempts, 0, `${at}/${change}`);
				assert.deepEqual(mergedCalls(result.calls), []);
			} finally {
				writeFileSync(fleetFile, fleetBefore);
				writeFileSync(envelopeFile, envelopeBefore);
				rmSync(drainFile(s.home), { force: true });
				rmSync(gitHazard, { force: true });
				holds.release(live.jobId);
			}
		}
	}
	for (const at of ["ci", "confirm"]) {
		const repair = await s.held(`changed hold reason ${at}`, at === "ci" ? 133 : 134);
		holds.hold(repair.jobId, "old QA reason");
		const barrier = join(s.home, `reason-${at}`);
		const repairView = { ...view, url: repair.prUrl, headRefName: repair.jobId, headRefOid: repair.head };
		const routes: Route[] = at === "ci"
			? [{ match: "actions/runs?head_sha=", replies: [{ ...runsBody([run(133, repair.head, "completed", "failure")]), untilFile: barrier }] }]
			: [{ match: "pr view", replies: [json(repairView), { ...json(repairView), untilFile: barrier }] }];
		s.setGh({ runs: [run(133, repair.head, "completed", "failure")], routes });
		const before = s.ghCalls().length;
		const advancing = s.integrate(repair.jobId);
		try {
			await waitFor(() => s.ghCalls().slice(before), (calls) => at === "ci" ? calls.some((call) => call.includes("actions/runs?head_sha=")) : calls.filter((call) => call.startsWith("pr view")).length >= 2, { timeoutMs: 30_000, what: "changed reason reaches external barrier" });
			holds.hold(repair.jobId, "updated QA reason");
		} finally { writeFileSync(barrier, "release"); }
		const result = await advancing;
		assert.equal(result.record.next, "resolve", result.text);
		assert.match(result.text, /updated QA reason/);
		assert.equal(holds.get(repair.jobId)?.reason, "updated QA reason");
	}
});


test("landing: a reviewed green head merges once, records, tears down and closes from forge facts", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const bound of [false, true]) await t.test(bound ? "bound branch" : "job branch", async (t) => {
	const s = await startStack(t);
	const live = await s.held("integrate entire landing", 123);
	if (bound) await s.post.fleet.patch(live.jobId, { bound_pr: { number: 123, url: live.prUrl, base: "main" } });
	if (bound) await s.post.registry.setAfterMergeDeploy("demo", { branch: "main", task: "deploy this merge", resources: ["host-a"] });
	const jobsFile = join(s.home, LAYOUT.jobsFile);
	const legacyJobs = JSON.parse(readFileSync(jobsFile, "utf8"));
	legacyJobs.jobs.find((job: { id: string }) => job.id === live.jobId).tracker = { connection_id: "retired", item_id: "x-9", linked_at: isoTimestamp() };
	writeFileSync(jobsFile, JSON.stringify(legacyJobs));
	const trackerFile = join(s.home, LAYOUT.data, "trackers.json");
	writeFileSync(trackerFile, "{ retired, malformed");
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	s.setGh({ integration: true, runs: [run(123, live.head, "completed", "success")] });
	const merged = await s.integrate(live.jobId);
	assert.equal(merged.record.next, "advance", merged.text);
	assert.equal(merged.record.record.merge_authority?.kind, "repo_derived");
	assert.equal(mergedCalls(merged.calls).length, 1);
	assert.ok(merged.calls.some((call) => call.includes(`--match-head-commit ${live.head}`)));
	assert.ok(merged.calls.every((call) => !["--admin", "--auto", "--delete-branch"].some((flag) => call.includes(flag))));
	assert.equal(s.post.fleet.require(live.jobId).phase, "held", "the branch survives until teardown");
	assert.notEqual(git(s.post.registry.pathOf("demo"), "ls-remote", "--heads", "origin", live.jobId), "");
	await s.post.shutdown();
	const restarted = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...s.agentDir.env }, holdsParentLock: () => true });
	t.after(() => restarted.shutdown());
	const resumed = await restarted.integrate({ jobId: live.jobId });
	const done = { record: resumed, text: [...resumed.facts, resumed.reason].join("\n") };
	assert.equal(done.record.next, "done", done.text);
	assert.equal(done.record.end_state?.fleet_done, true);
	assert.equal(done.record.end_state?.merge_receipt, true);
	assert.equal(done.record.end_state?.br_closed, true);
	assert.equal(s.post.fleet.require(live.jobId).closed_reason, "gated");
	const afterMergeFacts = done.record.facts.filter((fact) => fact.startsWith("after-merge"));
	assert.equal(afterMergeFacts.length, bound ? 1 : 0);
	if (bound) assert.equal(deployJobs(restarted, live.jobId).length, 1);
	const remoteBranch = git(s.post.registry.pathOf("demo"), "ls-remote", "--heads", "origin", live.jobId);
	assert.equal(remoteBranch.length > 0, bound, "only a job-owned branch is deleted");
	if (bound) assert.match(done.text, /head kept \(bound PR\)/);
	const again = await s.integrate(live.jobId);
	assert.equal(again.record.next, "done", again.text);
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
	assert.equal(again.record.merge?.recorded, false);
	const events = await s.parent("Read the completed integration result.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
		{ kind: "text", text: "Integration is complete." },
	]);
	assert.doesNotMatch(JSON.stringify(events), /tracker|write-back/);
	assert.equal(readFileSync(trackerFile, "utf8"), "{ retired, malformed");
	});
});

test("landing S10: synchronization preserves local work and proves origin before resetting", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["behind", "stale", "dirty", "unpushed", "absorbed", "divergence", "branch-denied", "branch-empty", "base-denied", "base-empty", "merge-base", "diff", "patch-id", "empty-id", "empty-diff", "salvage"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 sync ${mode}`, 910);
		const clone = s.post.registry.pathOf("demo");
		git(clone, "fetch", "origin", live.jobId);
		git(clone, "checkout", "--detach", `origin/${live.jobId}`);
		writeFileSync(join(clone, "change.txt"), "remote update\n");
		git(clone, "commit", "-am", "remote update");
		git(clone, "push", "origin", `HEAD:${live.jobId}`);
		git(clone, "checkout", "main");
		const head = git(clone, "ls-remote", "--heads", "origin", live.jobId).split("\t")[0]!;
		writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(910, head, "completed", "success")] });
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		if (!["behind", "stale", "dirty", "divergence", "branch-denied", "branch-empty"].includes(mode)) {
			writeFileSync(join(live.worktree, "change.txt"), mode === "unpushed" ? "unique local work\n" : "remote update\n");
			git(live.worktree, "commit", "-am", "local version");
		}
		if (mode === "dirty") writeFileSync(join(live.worktree, "change.txt"), "precious uncommitted content\n");
		const local = git(live.worktree, "rev-parse", "HEAD");
		const commonDir = git(live.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const log = join(s.home, "sync-git.jsonl");
		const fault = mode === "divergence" ? "rev-list" : mode === "merge-base" ? "merge-base" : mode === "diff" || mode === "empty-diff" ? "diff" : mode === "patch-id" || mode === "empty-id" ? "patch-id" : mode === "salvage" ? "update-ref" : "";
		const wrapper = join(s.home, "bin", "git");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const fs=require("node:fs");const a=process.argv.slice(2);\nif(process.cwd()===${JSON.stringify(live.worktree)}) {\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+"\\n");\nif(a[0]===${JSON.stringify(fault)}) {process.stderr.write("injected git refusal\\n");process.exit(${mode.startsWith("empty") ? 0 : 128});}\nif(a[0]==="ls-remote" && a.at(-1)===${JSON.stringify(mode.startsWith("base-") ? "main" : live.jobId)} && ${JSON.stringify(["branch-denied", "branch-empty", "base-denied", "base-empty"].includes(mode))}) process.exit(${mode.endsWith("empty") ? 0 : 128});\nif(${JSON.stringify(mode === "stale")} && a[0]==="fetch") {const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});spawnSync(${JSON.stringify(realGit)},["update-ref","-d",${JSON.stringify(`refs/remotes/origin/${live.jobId}`)}]);process.exit(r.status??1);}\n}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const result = await s.integrate(live.jobId);
		const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map((row) => JSON.parse(row));
		const resets = calls.filter((args) => args[0] === "reset");
		const success = ["behind", "stale", "absorbed"].includes(mode);
		assert.deepEqual(resets, success ? [["reset", "--hard", head]] : [], `${mode}: reset requires proof`);
		if (success) {
			assert.equal(result.record.next, "done", result.text);
			assert.match(result.text, /worktree reset to/);
			if (mode === "absorbed") {
				assert.match(result.text, /pre-rebase commit\(s\) were discarded/);
				assert.match(result.text, /kept at refs\/cp-salvage\//);
				const rescue = calls.findIndex((a) => a[0] === "update-ref" && a[1] !== "-d");
				assert.ok(rescue >= 0 && rescue < calls.findIndex((a) => a[0] === "reset"));
				assert.equal(execFileSync(realGit, ["--git-dir", commonDir, "rev-parse", calls[rescue]![1]!], { encoding: "utf8" }).trim(), local);
			} else assert.equal(calls.filter((a) => a[0] === "patch-id" || (a[0] === "update-ref" && a[1] !== "-d")).length, 0);
		} else {
			assert.equal(git(live.worktree, "rev-parse", "HEAD"), local);
			if (mode === "dirty") assert.equal(readFileSync(join(live.worktree, "change.txt"), "utf8"), "precious uncommitted content\n");
			assert.equal(result.record.next, "surface", result.text);
			const reasons: Record<string, RegExp> = { dirty: /worktree is dirty/, unpushed: /could not be proven/, divergence: /could not tell whether/, "base-denied": /origin did not name a tip/, "base-empty": /origin did not name a tip/, "merge-base": /no readable merge base/, diff: /could not be read/, "patch-id": /gave no id/, "empty-id": /gave no id/, "empty-diff": /empty cumulative diff/, salvage: /rescue ref first/ };
			if (reasons[mode]) assert.match(result.text, reasons[mode]!);
			if (mode.startsWith("branch-")) assert.match(result.text, /teardown refused.*unpushed/s);
		}
	});
});
test("landing S10: rescue retention proves reachability and bounds cleanup", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["mixed", "origin-denied", "origin-empty", "listing", "ancestry", "delete", "fetch", "bound", "empty", "outside"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 rescue ${mode}`, 911);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(911, live.head, "completed", "success")] });
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		const clone = s.post.registry.pathOf("demo");
		const base = git(clone, "rev-parse", "HEAD");
		const reachable = "refs/cp-salvage/cp-old/001";
		const orphan = "refs/cp-salvage/cp-old/999";
		if (mode !== "empty") git(clone, "update-ref", reachable, base);
		if (mode === "mixed") git(clone, "update-ref", orphan, live.head);
		if (mode === "bound") for (let index = 2; index <= 101; index++) git(clone, "update-ref", `refs/cp-salvage/cp-old/${String(index).padStart(3, "0")}`, base);
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = join(s.home, "bin", "git");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const a=process.argv.slice(2);\nif(process.cwd()===${JSON.stringify(clone)}) {\nconst m=${JSON.stringify(mode)};if((m==="origin-denied"||m==="origin-empty")&&a[0]==="ls-remote"&&a.at(-1)==="main")process.exit(m==="origin-empty"?0:128);\nif((m==="listing"&&a[0]==="for-each-ref")||(m==="ancestry"&&a[0]==="merge-base"&&a[1]==="--is-ancestor")||(m==="delete"&&a[0]==="update-ref"&&a[1]==="-d")||(m==="fetch"&&a[0]==="fetch"&&a.at(-1)==="main")){process.stderr.write("injected rescue refusal\\n");process.exit(128);}\n}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		if (mode === "outside") writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const a=process.argv.slice(2);\nif(a[0]==="for-each-ref"&&a.includes("refs/cp-salvage/")){console.log(${JSON.stringify([`refs/heads/main ${base}`, `refs/remotes/origin/main ${base}`, `refs/cp-salvage-old/x ${base}`, `refs/cp-salvage/ ${base}`, `refs/cp-salvage/../heads/main ${base}`, `${reachable} ${base}`].join("\n"))});process.exit(0);}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "done", result.text);
		const refs = execFileSync(realGit, ["for-each-ref", "--format=%(refname)", "refs/cp-salvage/"], { cwd: clone, encoding: "utf8" }).trim().split("\n").filter(Boolean);
		if (mode === "outside") {
			const main = spawnSync(realGit, ["rev-parse", "refs/heads/main"], { cwd: clone, encoding: "utf8" });
			assert.deepEqual([main.status, main.stdout.trim()], [0, base], "cleanup must preserve main");
			assert.deepEqual(refs, []);
			return;
		}
		if (mode === "mixed") {
			assert.deepEqual(refs, [orphan]);
			assert.match(result.text, /1 rescue ref\(s\) pruned/);
			assert.match(result.text, /not reachable from main/);
		} else if (mode === "bound") {
			assert.deepEqual(refs, ["refs/cp-salvage/cp-old/101"]);
			assert.match(result.text, /1 further rescue ref\(s\) were not examined/);
		} else if (mode === "empty") {
			assert.deepEqual(refs, []);
			assert.doesNotMatch(result.text, /rescue ref/);
		} else {
			assert.deepEqual(refs, [reachable]);
			assert.match(result.text, mode.startsWith("origin-") ? /origin did not name a tip/ : mode === "listing" ? /could not be listed/ : mode === "ancestry" ? /reachability could not be read/ : mode === "delete" ? /could not be deleted/ : /could not be fetched/);
		}
	});
});
test("landing S10: review evidence authorizes only the reviewed complete head", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["missing", "pass", "equivalent", "moved", "revise", "flagged", "approved", "truncated", "truncated-flag", "moved-flag", "fallback"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 review ${mode}`, 912);
		const old = "b".repeat(40);
		if (!["missing", "fallback"].includes(mode)) {
			writeWindowPass(s.home, live.jobId, ["moved", "moved-flag"].includes(mode) ? old : live.head, "2026-01-01T00:00:00Z");
			const file = join(s.home, paths.reviewFile(live.jobId, 1));
			const verdict = JSON.parse(readFileSync(file, "utf8"));
			if (mode === "revise") Object.assign(verdict, { verdict: "revise", cause: "policy" });
			if (["flagged", "approved", "moved-flag", "truncated-flag"].includes(mode)) Object.assign(verdict, { verdict: "escalate", cause: "flagged" });
			if (mode.startsWith("truncated")) verdict.diff_stat.truncated = true;
			writeFileSync(file, JSON.stringify(verdict));
			if (mode === "equivalent") {
				verdict.equivalent_to = { head_sha: old, attempt: 1 };
				writeFileSync(join(s.home, paths.reviewEquivalenceFile(live.jobId, live.head)), JSON.stringify(verdict));
				rmSync(file);
			}
		}
		if (["approved", "moved-flag", "truncated-flag"].includes(mode)) {
			const checkpoint = new CheckpointStore(s.home, { kind: "diff" });
			checkpoint.request({ jobId: live.jobId, question: "Accept flagged diff?" });
			checkpoint.decide(live.jobId, true, { by: "operator command" });
		}
		if (mode === "fallback") {
			const checkpoint = new CheckpointStore(s.home, { kind: "merge" });
			checkpoint.request({ jobId: live.jobId, scope: live.head.slice(0, 12), question: "Merge this head?" });
			checkpoint.decide(live.jobId, true, { by: "operator command", scope: live.head.slice(0, 12) });
		}
		s.setGh({ integration: true, permission: mode === "fallback" ? null : "CLEAN", runs: [run(912, live.head, "completed", "success")] });
		const result = await s.integrate(live.jobId);
		const permitted = ["pass", "equivalent", "approved"].includes(mode);
		assert.equal(result.record.next, permitted ? "advance" : "review", result.text);
		if (["missing", "fallback"].includes(mode)) {
			assert.match(result.text, /cp_review/);
			assert.match(result.text, /unchanged/);
		}
		assert.equal(mergedCalls(result.calls).length, permitted ? 1 : 0);
		assert.equal(result.record.head_sha, live.head);
		assert.equal(result.calls.filter((call) => call.startsWith("pr update-branch")).length, 0);
	});
});
test("landing S10: unreadable forge and Actions evidence names the cause and makes no mutation", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["rate", "permission", "jobs-denied", "jobs-partial", "jobs-malformed", "missing-gh"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 evidence ${mode}`, 913);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const failure: Reply = mode === "jobs-partial" ? json({ total_count: 2, jobs: [] }) : mode === "jobs-malformed" ? { stdout: "<html>502</html>" } : { code: mode === "missing-gh" ? 127 : 1, stderr: mode === "rate" ? "API rate limit exceeded" : mode === "missing-gh" ? "spawn gh ENOENT" : "HTTP 403: Resource not accessible by personal access token" };
		s.setGh({ integration: true, runs: [run(913, live.head, "completed", "success")], routes: [{ match: mode === "missing-gh" ? "pr view" : mode.startsWith("jobs-") ? "/jobs" : "actions/runs?head_sha=", replies: [failure] }] });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, mode === "missing-gh" ? "surface" : "retry", result.text);
		assert.equal(mergedCalls(result.calls).length, 0);
		assert.equal(result.calls.filter((call) => call.startsWith("pr ready")).length, 0);
		assert.match(result.text, mode === "rate" ? /rate_limited/ : mode === "permission" || mode === "jobs-denied" ? /token lacks Actions read/ : mode === "missing-gh" ? /gh is not available.*proves nothing/ : /could not read CI/);
		if (mode === "rate") assert.doesNotMatch(result.text, /token lacks/);
	});
});
test("landing S10: cleanup failures preserve landed effects and resume", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["delete", "close", "rebase", "merge-unknown"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { continuation: mode !== "rebase" });
		const live = await s.held(`S10 cleanup ${mode}`, 914);
		await s.post.continuation.serialize(live.jobId, async () => {});
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(914, live.head, "completed", "success")] });
		if (mode === "rebase") {
			const gitDir = git(live.worktree, "rev-parse", "--absolute-git-dir");
			mkdirSync(join(gitDir, "rebase-merge"));
			const result = await s.integrate(live.jobId);
			assert.equal(result.record.next, "surface", result.text);
			assert.match(result.text, /rebase is in progress/);
			assert.equal(mergedCalls(result.calls).length, 0);
			rmSync(join(gitDir, "rebase-merge"), { recursive: true });
			return;
		}
		if (mode === "merge-unknown") {
			s.setGh({ integration: true, runs: [run(914, live.head, "completed", "success")], routes: [{ match: "pr merge", replies: [{ code: 1, stderr: "connection reset by peer" }] }] });
			const outcome = await s.post.continuation.trigger({ jobId: live.jobId, event: "startup" });
			assert.equal(outcome.next, "retry", JSON.stringify(outcome));
			const notices = readFileSync(join(s.home, LAYOUT.wakeupsFile), "utf8");
			assert.match(notices, /connection reset by peer/);
			assert.doesNotMatch(notices, /nothing was mutated/i);
			assert.match(notices, /resumes, never starting over/);
			assert.equal(readMergeReceipt(s.home, live.jobId), undefined);
			return;
		}
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = join(s.home, "bin", "git");
		const jobsFile = join(s.home, LAYOUT.jobsFile);
		const jobs = readFileSync(jobsFile, "utf8");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const fs=require("node:fs");const a=process.argv.slice(2);\nif(a[0]==="push"&&a.includes("--delete")) {if(${JSON.stringify(mode === "delete")}){process.stderr.write("protected branch\\n");process.exit(1);}const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});fs.writeFileSync(${JSON.stringify(jobsFile)},"{");process.exit(r.status??1);}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const outcome = await s.post.continuation.trigger({ jobId: live.jobId, event: "startup" });
		assert.equal(outcome.next, "retry", JSON.stringify(outcome));
		const notices = readFileSync(join(s.home, LAYOUT.wakeupsFile), "utf8");
		assert.match(notices, /HELD PR STOPPED/);
		assert.match(notices, mode === "delete" ? /merged and torn down/ : /still open/);
		assert.doesNotMatch(notices, /nothing was mutated/i);
		assert.match(notices, /resumes, never starting over/);
		assert.ok(readMergeReceipt(s.home, live.jobId));
		writeFileSync(jobsFile, jobs);
		rmSync(wrapper);
		const done = await s.integrate(live.jobId);
		assert.equal(done.record.next, "done", done.text);
		assert.equal(s.post.ledger().read().jobs.find((job) => job.id === live.jobId)?.status, "closed");
		assert.equal(mergedCalls(s.ghCalls()).length, 1);
	});
});

test("landing S10: dispatch rejects profiles granting parent integration tools", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const tool of ["cp_integrate", "cp_merged"]) await t.test(tool, async (t) => {
		const packageRoot = mkdtempSync(join(tmpdir(), "cp-profile-package-"));
		t.after(() => rmSync(packageRoot, { recursive: true, force: true }));
		for (const name of ["profiles", "prompts"]) cpSync(join(REPO_ROOT, name), join(packageRoot, name), { recursive: true });
		for (const name of ["extensions", "src"]) symlinkSync(join(REPO_ROOT, name), join(packageRoot, name), "dir");
		const profile = join(packageRoot, "profiles", "implementer.md");
		writeFileSync(profile, readFileSync(profile, "utf8").replace("tools: [", `tools: [${tool}, `));
		const s = await startStack(t, { packageRoot });
		const job = await s.post.ledger().create({ title: `S10 forbidden ${tool}`, project: "demo", delivery: "pr", kind: "ship" });
		const model = s.provider.addScript(`forbidden-${tool}`, [{ kind: "text", text: "done" }], { onExhausted: "repeat" });
		s.agentDir.writeModels(s.provider);
		await assert.rejects(s.post.dispatch({ jobId: job.id, task: "Make a change.", model, fetch: false }), new RegExp(`${tool}.*parent-only tool`));
		assert.equal(s.post.fleet.list().some((entry) => entry.job_id === job.id), false);
	});
});

test("landing S15 retry: real parent delivery confirms, retries withheld verdicts and expires permanent suppression", { skip: SKIP, timeout: 100_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_VERDICT_DELIVERY_RETRY_SECONDS: "1", CP_REVIEW_SUPPRESSION_SECONDS: "32" } });
	const jobs: Awaited<ReturnType<typeof s.held>>[] = [];
	for (let n = 0; n < 4; n++) {
		const live = await s.held(`S15 retry ${n}`, 161 + n, { command: (branch) => `printf retry > retry-${n}.txt && git add retry-${n}.txt && git commit -q -m retry && git push -q -u origin ${branch}` });
		new IntegrationHolds(s.home).hold(live.jobId, "retry evidence collection");
		jobs.push(live);
	}
	const originals = jobs.map((live) => readFileSync(join(s.home, paths.envelopeFile(live.jobId)), "utf8"));
	const models = jobs.map((live, n) => s.provider.addScript(`s15-retry-${n}`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: () => {
		if (n === 1 || n === 2) {
			const record = JSON.parse(originals[n]!);
			record.envelope.head_sha = "f".repeat(40);
			record.received_at = isoTimestamp(new Date(Date.now() + 3_600_000));
			writeFileSync(join(s.home, paths.envelopeFile(live.jobId)), JSON.stringify(record));
		}
		return { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 retry evidence"] };
	} }] }]));
	const releaseParent = join(s.home, "release-retry-parent");
	const parent = s.provider.addScript("s15-retry-parent", [
		{ kind: "tool_calls", calls: [
			...jobs.slice(0, 3).map((live, n) => ({ name: "cp_review", args: { job_id: live.jobId, model: models[n] } })),
			{ name: "bash", args: { command: `while [ ! -f '${releaseParent}' ]; do sleep 0.1; done` } },
		] },
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: jobs[3]!.jobId, model: models[3] } }] },
		{ kind: "text", text: "Review deliveries observed." },
	], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const child = startPiChild({ cwd: s.home, model: parent, env: { ...s.agentDir.env, CP_HOME: s.home }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => child.close());
	const prompted = child.prompt("Review these three branches and wait while their verdict delivery settles.");
	const events = (n: number) => readRunEvents(s.home, jobs[n]!.jobId);
	const sends = (n: number) => events(n).filter((event) => event.type === "verdict_wakeup_sent");
	const delivered = (n: number) => events(n).filter((event) => event.type === "verdict_wakeup_delivered");
	try {
		await waitFor(() => sends(0).length, (count) => count >= 2, { timeoutMs: 30_000, what: "the busy parent leaves its first verdict unconfirmed through one resend" });
	} finally {
		writeFileSync(releaseParent, "release");
	}
	await prompted;
	await assert.doesNotReject(waitFor(() => sends(1).length, (count) => count >= 2, { timeoutMs: 10_000, what: "real timer retries a withheld verdict" }), "suppression remains eligible for its configured retry window");
	assert.equal((sends(1)[0]!.payload as { sent: boolean }).sent, false);
	assert.equal((sends(1)[1]!.payload as { sent: boolean }).sent, false);
	await assert.doesNotReject(waitFor(() => sends(1).length, (count) => count >= 3, { timeoutMs: 10_000, what: "a second withheld copy never spends resend eligibility" }), "withheld copies preserve resend eligibility");
	await waitFor(() => delivered(3).length, (count) => count >= 1, { timeoutMs: 10_000, what: "the idle parent's immediate confirmation" });
	assert.equal(delivered(3).length, 1, "one arrival confirms a verdict only once");
	await waitFor(() => Date.now(), (now) => now >= Date.parse(sends(3)[0]!.ts) + 6_000, { timeoutMs: 10_000, what: "confirmed verdict's resend deadline passes" });
	assert.equal(sends(3).length, 1, "confirmation removes the key before its first resend");
	await waitFor(() => sends(1).length, (count) => count >= 6, { timeoutMs: 30_000, what: "lagging facts outlast the old five-copy bound" });
	writeFileSync(join(s.home, paths.envelopeFile(jobs[1]!.jobId)), originals[1]!);
	await waitFor(() => delivered(1).length, (count) => count === 1, { timeoutMs: 10_000, what: "withheld retry remains eligible until facts catch up" });
	assert.equal(sends(0).length, 2, "a queued unconfirmed verdict is resent exactly once");
	assert.equal(delivered(3).length, 1);
	assert.equal(sends(3).length, 1, "an immediately confirmed verdict never resends");
	assert.equal((sends(0)[1]!.payload as { resend: boolean }).resend, true);
	assert.ok(sends(1).length >= 7, "withheld copies outlast the old five-copy bound without consuming the successful resend");
	const cutoff = Date.parse(sends(2)[0]!.ts) + 32_000;
	await waitFor(() => Date.now(), (now) => now >= cutoff, { timeoutMs: 40_000, what: "configured suppression lifetime expires" });
	assert.ok(sends(2).every((event) => Date.parse(event.ts) < cutoff), "permanent suppression stops at its lifetime bound");
	assert.ok(Date.parse(sends(2).at(-1)!.ts) >= cutoff - 6_000, "suppressed attempts remain eligible until near the configured cutoff");
	assert.ok(sends(2).length >= 7, "suppressed retries outlast the old five-copy bound");
	const counts = jobs.map((_, n) => sends(n).length);
	writeFileSync(join(s.home, paths.envelopeFile(jobs[2]!.jobId)), originals[2]!);
	const restoredAt = Date.now();
	await waitFor(() => Date.now(), (now) => now >= restoredAt + 6_000, { timeoutMs: 10_000, what: "expired verdict remains dropped after its facts recover" });
	assert.deepEqual(jobs.map((_, n) => sends(n).length), counts, "confirmed and expired verdicts never resend again");
	assert.equal(delivered(2).length, 0);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});

test("landing S15 order: a real verdict wakes the parent before its deadline continuation merges", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "5" } });
	const live = await s.held("S15 verdict ordering", 153);
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(153, live.head, "completed", "success")] });
	const reviewer = s.provider.addScript("s15-order-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 scoped pass"] } }] }]);
	s.agentDir.writeModels(s.provider);
	await s.parent("Review the S15 ordering branch.", [
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: live.jobId, model: reviewer } }] },
		{ kind: "text", text: "Review started." },
	], async () => {
		await waitFor(() => readRunEvents(s.home, live.jobId).some((event) => event.type === "verdict_wakeup_delivered"), Boolean, { timeoutMs: 30_000, what: "real verdict reaches parent context" });
		const file = join(s.home, paths.reviewFile(live.jobId, 1));
		const original = readFileSync(file, "utf8");
		const verdict = JSON.parse(original);
		assert.ok(Date.parse(readRunEvents(s.home, live.jobId).find((event) => event.type === "verdict_wakeup_delivered")!.ts) < Date.parse(verdict.decided_at) + 5_000, "the raw verdict reaches parent context before its deadline continuation");
		assert.equal(existsSync(join(s.home, paths.pendingReviewFile(live.jobId, "review", 1))), false);
		assert.deepEqual(mergedCalls(s.ghCalls()), [], "the verdict arrives while the merge window is open");
		await waitFor(() => mergedCalls(s.ghCalls()).length, (count) => count === 1, { timeoutMs: 45_000, what: "real deadline continuation merges" });
		assert.ok(Date.now() >= Date.parse(verdict.decided_at) + 5_000);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "review_started").length, 1);
		await waitFor(() => JSON.stringify(s.provider.requests("landing-parent-1").map((request) => request.body.messages)).includes("HELD PR LANDED"), Boolean, { timeoutMs: 30_000, what: "completed deadline integration reaches the parent" });
	});
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
	const context = JSON.stringify(s.provider.requests("landing-parent-1").map((request) => request.body.messages));
	const verdictAt = context.indexOf("S15 scoped pass");
	assert.ok(verdictAt >= 0, "the parent receives the actual verdict reason");
	assert.ok(context.includes("HELD PR LANDED"), "the parent receives completed deadline integration");
});

test("landing S15: durable review evidence owns the merge window across parent restarts", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "20" } });
	const live = await s.held("S15 durable review window", 151);
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(151, live.head, "completed", "success")] });
	assert.equal((await s.integrate(live.jobId)).record.next, "review");
	const file = join(s.home, paths.reviewFile(live.jobId, 1));
	const at = new Date().toISOString();
	writeWindowPass(s.home, live.jobId, live.head, at, { diff_stat: { files: 1, truncated: true } });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "a truncated pass cannot arm a window");
	for (const body of ["{", JSON.stringify({ verdict: "pass" })]) {
		writeFileSync(file, body);
		assert.equal((await s.integrate(live.jobId)).record.next, "review", "malformed evidence cannot arm a window");
	}
	const other = "b".repeat(40);
	writeWindowPass(s.home, live.jobId, other, at);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "another head's pass cannot arm this window");
	const fresh = isoTimestamp();
	writeWindowPass(s.home, live.jobId, live.head, fresh);
	const original = readFileSync(file, "utf8");
	const deadline = new Date(Date.parse(fresh) + 20_000).toISOString();
	for (let replay = 0; replay < 2; replay++) {
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "wait", result.text);
		assert.equal(result.record.review_resume_at, deadline);
	}
	const ends = await s.parent("Check the durable S15 review deadline after restart.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId, action: "advance" } }] },
		{ kind: "text", text: "Deadline checked." },
	]);
	assert.ok(JSON.stringify(ends).includes(deadline), "the fresh parent reads the original durable deadline");
	assert.equal(readFileSync(file, "utf8"), original);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	writeWindowPass(s.home, live.jobId, live.head, fresh, { equivalent_to: { head_sha: other, attempt: 1 } });
	rmSync(file);
	const equivalentWait = await s.integrate(live.jobId);
	assert.equal(equivalentWait.record.next, "wait", equivalentWait.text);
	assert.equal(equivalentWait.record.review_resume_at, deadline);
	const expired = new Date(Date.now() - 21_000).toISOString();
	writeWindowPass(s.home, live.jobId, live.head, expired, { equivalent_to: { head_sha: other, attempt: 1 } });
	const ready = await s.integrate(live.jobId);
	assert.equal(ready.record.next, "advance", ready.text);
	assert.equal(ready.record.review_resume_at, undefined, "elapsed equivalent passes do not renew the window");
	const mismatched = await s.held("S15 mismatched equivalence", 152, { command: (branch) => `printf mismatch > mismatch.txt && git add mismatch.txt && git commit -q -m mismatch && git push -q -u origin ${branch}` });
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(152, mismatched.head, "completed", "success")] });
	const wrong = writeWindowPass(s.home, mismatched.jobId, other, new Date().toISOString(), { equivalent_to: { head_sha: mismatched.head, attempt: 1 } });
	writeFileSync(join(s.home, paths.reviewEquivalenceFile(mismatched.jobId, mismatched.head)), JSON.stringify(wrong));
	assert.equal((await s.integrate(mismatched.jobId)).record.review_resume_at, undefined, "mismatched equivalence cannot arm a window");
});

test("landing: the review deadline resumes once and rechecks current gates", { skip: SKIP, timeout: 119_000 }, async (t) => {
	for (const fallback of [false, true]) {
		for (const change of ["hold", "unreadable-hold", "head", "ci", "permission", "none"]) await t.test(`${fallback ? "fallback" : "repository"}/${change}`, async (t) => {
			const s = await startStack(t, { continuation: true, env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "3" } });
			const live = await s.held("review deadline gates", 124);
			await s.post.continuation.serialize(live.jobId, async () => {});
			const reviewedAt = new Date().toISOString();
			writeWindowPass(s.home, live.jobId, live.head, reviewedAt);
			if (fallback) {
				const store = new CheckpointStore(s.home, { kind: "merge" });
				const scope = live.head.slice(0, 12);
				store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
				store.decide(live.jobId, true, { by: "operator command", scope });
			}
			s.setGh({ integration: true, permission: fallback ? null : "CLEAN", runs: [run(124, live.head, "completed", "success")] });
			await s.tick(live.jobId);
			await s.post.continuation.serialize(live.jobId, async () => {});
			assert.equal(s.post.integrator.get(live.jobId)?.next, "wait");
			assert.deepEqual(mergedCalls(s.ghCalls()), []);
			const holds = new IntegrationHolds(s.home);
			if (change === "hold" || change === "unreadable-hold") {
				holds.hold(live.jobId, "hold during review window");
				if (change === "unreadable-hold") writeFileSync(holds.file(live.jobId), "{");
			}
			if (change === "head") {
				git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "push during review window");
				git(live.worktree, "push", "--quiet", "origin", live.jobId);
			}
			if (change === "ci") s.setGh({ runs: [run(124, live.head, "in_progress", null)] });
			if (change === "permission") s.setGh({ permission: "BLOCKED" });
			await waitFor(() => Date.now(), (now) => now >= Date.parse(reviewedAt) + 4_000, { timeoutMs: 10_000, what: "configured review deadline elapses" });
			await s.post.continuation.serialize(live.jobId, async () => {});
			assert.equal(mergedCalls(s.ghCalls()).length, change === "none" ? 1 : 0, `${fallback}/${change}`);
			if (change === "hold" || change === "unreadable-hold") {
				holds.release(live.jobId);
				const result = await s.integrate(live.jobId);
				assert.equal(result.record.next, "advance", result.text);
				assert.equal(result.record.record.merge_authority?.kind, fallback ? "human_checkpoint" : "repo_derived");
			}
		});
	}
});


test("landing: main red gates only the mandated login and permits a green fix-forward", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("main red integration", 125);
	const base = advanceBase(s.repo, "unrelated.txt", "new base\n");
	const store = new MainCiStore({ home: s.home });
	const routes = [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }];
	const grant = s.post.mandates.issue({ projects: ["demo"], objective: "main red integration", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
	store.setRed("demo", base, { login: "e2e" });
	s.setGh({ runs: [run(125, live.head, "completed", "success")], routes: [{ match: "api user --jq .login", replies: [{ code: 1, stderr: "login unavailable" }] }] });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "an unreadable login does not enforce a latch");
	s.setGh({ routes, runs: [run(125, live.head, "completed", "success")] });
	store.setRed("demo", base, { failing: "structure", login: "e2e" });
	for (const rows of [[run(125, live.head, "completed", "success")], [run(125, live.head, "completed", "failure")], []]) {
		s.setGh({ runs: rows });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "wait", result.text);
		assert.match(result.record.reason, /main is red/);
		assert.deepEqual(mergedCalls(result.calls), []);
	}
	s.setGh({ runs: [run(125, live.head, "completed", "success")] });
	store.clear("demo");
	store.setRed("elsewhere", base, { login: "e2e" });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "another project's latch cannot block");
	store.setRed("demo", base, { login: "foreign" });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "a foreign login cannot block");
	store.setRed("demo", base, { login: "e2e" });
	s.post.mandates.revoke(grant.id);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "without a mandate main red is not enforced");
	s.post.mandates.issue({ projects: ["demo"], objective: "fix forward", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
	s.setGh({ routes });
	writeFileSync(store.file, "{broken");
	const corrupt = await s.integrate(live.jobId);
	assert.equal(corrupt.record.next, "review");
	assert.match(corrupt.text, /main-ci.json unreadable/);
	rmSync(store.file);
	store.setRed("demo", live.head, { login: "e2e" });
	store.setRed("demo", base, { login: "e2e" });
	assert.ok((await s.integrate(live.jobId)).record.reason.includes(`main is red since ${live.head.slice(0, 12)}`), "setting the same login twice preserves its first red head");
	git(live.worktree, "fetch", "origin", "main");
	git(live.worktree, "merge", "--no-edit", "origin/main");
	git(live.worktree, "push", "origin", live.jobId);
	const fixedHead = git(live.worktree, "rev-parse", "HEAD");
	s.setGh({ runs: [run(126, fixedHead, "completed", "success")] });
	const fixed = await s.integrate(live.jobId);
	assert.equal(fixed.record.next, "review", fixed.text);
	assert.match(fixed.text, /fix-forward/);
	store.clear("demo");
	assert.equal((await s.integrate(live.jobId)).record.next, "review");
});


test("landing: repository and fallback merges bind the approved head at the forge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const fallback of [false, true]) await t.test(fallback ? "fallback" : "repository", async (t) => {
		const s = await startStack(t);
		const live = await s.held("atomic merge binding", 127);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const view = { number: 127, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: fallback ? undefined : "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		const routes: Route[] = [{ match: "pr view", replies: [json(view)] }];
		s.setGh({ integration: true, runs: [run(127, live.head, "completed", "success")], routes });
		const checkpoints = new CheckpointStore(s.home, { kind: "merge" });
		const scope = live.head.slice(0, 12);
		if (fallback) {
			const missing = await s.integrate(live.jobId);
			assert.equal(missing.record.next, "surface");
			assert.match(missing.text, /evidence is not authorization/);
			assert.equal(checkpoints.get(live.jobId, { scope })?.decision, "pending");
			const pending = await s.integrate(live.jobId);
			assert.match(pending.text, /awaiting a human/);
			const checkpointFile = join(s.home, paths.checkpointFile(live.jobId, "merge", scope));
			const pendingBytes = readFileSync(checkpointFile, "utf8");
			checkpoints.decide(live.jobId, false, { by: "operator command", scope });
			assert.match((await s.integrate(live.jobId)).text, /declined/);
			writeFileSync(checkpointFile, pendingBytes);
			checkpoints.decide(live.jobId, true, { by: "operator command", scope });
		}
		const barrier = join(s.home, "merge-release");
		s.setGh({ routes: [...routes, { match: "pr merge", replies: [{ pass: true, untilFile: barrier }] }] });
		const before = s.ghCalls().length;
		const advancing = s.integrate(live.jobId);
		try {
			await waitFor(() => s.ghCalls().slice(before).some((call) => call.startsWith("pr merge")), Boolean, { timeoutMs: 30_000, what: "merge reaches forge barrier" });
			git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "concurrent push");
			git(live.worktree, "push", "--quiet", "origin", live.jobId);
		} finally { writeFileSync(barrier, "release"); }
		const refused = await advancing;
		assert.equal(refused.record.next, "retry", refused.text);
		assert.match(refused.text, /Head branch was modified/);
		assert.equal(refused.record.record.merge_authority, undefined);
		assert.equal(existsSync(join(s.home, paths.mergeFile(live.jobId))), false);
		assert.equal(s.post.fleet.require(live.jobId).phase, "held");
		const call = mergedCalls(refused.calls)[0]!;
		assert.ok(call.includes(`--match-head-commit ${live.head}`));
		assert.ok(!call.includes("--delete-branch") && !call.includes("--admin") && !call.includes("--auto"));
		const moved = git(live.worktree, "rev-parse", "HEAD");
		s.setGh({ runs: [run(128, moved, "completed", "success")], routes: [{ match: "pr view", replies: [json({ ...view, headRefOid: moved })] }] });
		assert.equal((await s.integrate(live.jobId)).record.next, "review", "old review never covers a pushed head");
		writeWindowPass(s.home, live.jobId, moved, "2026-01-01T00:00:00Z");
		if (fallback) {
			const unapproved = await s.integrate(live.jobId);
			assert.equal(unapproved.record.step, "authorize");
			assert.equal(unapproved.record.next, "surface");
			assert.equal(checkpoints.get(live.jobId, { scope: moved.slice(0, 12) })?.decision, "pending");
			assert.equal(checkpoints.get(live.jobId, { scope })?.decision, "approved");
		}
	});
});


test("landing: stale bases update only for BEHIND or an authoritative strict rule", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["clean", "blocked", "denied-rules", "unknown", "behind", "strict", "current", "unreadable-ancestry", "red", "conflict", "moved", "superseded"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`base policy ${mode}`, 129);
		if (mode !== "current") advanceBase(s.repo, "base-policy.txt", "base changed\n");
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const strict = ["strict", "current", "unreadable-ancestry"].includes(mode);
		const status = ["clean", "red", "moved", "superseded"].includes(mode) ? "CLEAN" : mode === "unknown" ? "UNKNOWN" : mode === "behind" ? "BEHIND" : mode === "conflict" ? "DIRTY" : "BLOCKED";
		const view = { number: 129, url: live.prUrl, state: "OPEN", mergeable: mode === "conflict" ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: status, headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		const routes: Route[] = [{ match: "pr view", replies: [json(view)] }, { match: "/rules/branches/", replies: [mode === "denied-rules" ? { code: 1, stderr: "HTTP 403" } : json(strict ? [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "ci" }] } }] : [])] }];
		if (mode === "unreadable-ancestry") {
			const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
			const wrapper = join(s.home, "bin", "git");
			writeFileSync(wrapper, `#!/usr/bin/env node\nconst { spawnSync } = require("child_process");\nconst args = process.argv.slice(2);\nif (args[0] === "merge-base" && args.includes("--is-ancestor")) process.exit(128);\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`);
			chmodSync(wrapper, 0o755);
		}
		if (mode === "moved") routes[0]!.replies.push(json({ ...view, headRefOid: "b".repeat(40) }));
		const rows = [run(129, mode === "superseded" ? "b".repeat(40) : live.head, "completed", mode === "red" ? "failure" : "success")];
		if (mode === "superseded") routes.push({ match: "actions/runs?branch=", replies: [runsBody(rows)] });
		s.setGh({ integration: true, routes, runs: rows });
		const result = await s.integrate(live.jobId);
		const updates = result.calls.filter((call) => call.startsWith("pr update-branch"));
		if (mode === "behind" || mode === "strict") {
			assert.equal(result.record.step, "fresh", result.text);
			assert.equal(result.record.next, "advance", result.text);
			assert.equal(result.record.head_sha, undefined);
			assert.equal(updates.length, 1);
			assert.deepEqual(mergedCalls(result.calls), []);
			const head = git(s.remote, "rev-parse", live.jobId);
			assert.notEqual(head, live.head);
			s.setGh({ routes: [{ match: "actions/runs?branch=", replies: [runsBody([run(129, live.head, "completed", "success")])] }] });
			const stale = await s.integrate(live.jobId);
			assert.equal(stale.record.next, "wait", stale.text);
			s.setGh({ runs: [run(130, head, "completed", "success")] });
			const unreviewed = await s.integrate(live.jobId);
			assert.equal(unreviewed.record.next, "review", unreviewed.text);
			assert.equal(s.ghCalls().filter((call) => call.startsWith("pr update-branch")).length, 1);
		} else if (mode === "clean") {
			assert.equal(result.record.next, "advance", result.text);
			assert.equal(mergedCalls(result.calls).length, 1);
			assert.ok(mergedCalls(result.calls)[0]!.includes(`--match-head-commit ${live.head}`));
			assert.equal(updates.length, 0);
		} else {
			const expected = mode === "unknown" ? "retry" : ["red", "conflict"].includes(mode) ? "resolve" : ["moved", "superseded"].includes(mode) ? "wait" : "surface";
			assert.equal(result.record.next, expected, result.text);
			assert.equal(updates.length, 0);
			assert.deepEqual(mergedCalls(result.calls), []);
		}
	});
});


test("landing: the operator bridge persists a hold without a parent and a restarted parent reads and releases it", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const operatorHome = mkdtempSync(join(tmpdir(), "cp-s08-operator-"));
	t.after(() => rmSync(operatorHome, { recursive: true, force: true }));
	const s = await startStack(t, { env: { PI_HOME: operatorHome } });
	const live = await s.held("operator bridge hold", 131);
	saveOperatorTarget({ home: s.home, mode: "multi", hostPid: 0, parentPid: 0 });
	const model = s.provider.addScript("s08-bridge", [
		{ kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "integration_hold", job_id: live.jobId, reason: "operator QA" } }] },
		{ kind: "text", text: "Hold written." },
		{ kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "integration_release", job_id: live.jobId } }] },
		{ kind: "text", text: "Hold released." },
	]);
	s.agentDir.writeModels(s.provider);
	const child = startPiChild({ cwd: s.home, model, env: { ...s.agentDir.env, CP_HOME: s.home, PI_HOME: operatorHome }, extensions: [CP_BRIDGE_EXTENSION] });
	t.after(() => child.close());
	await child.prompt("Pause integration for operator QA.");
	await child.waitForSettled(90_000);
	assert.equal(new IntegrationHolds(s.home).get(live.jobId)?.reason, "operator QA");
	s.setGh({ runs: [run(131, live.head, "completed", "success")] });
	const held = await s.integrate(live.jobId);
	assert.equal(held.record.next, "wait", held.text);
	assert.match(held.text, /CI green/);
	const local = await s.seed("local hold validation");
	await s.post.fleet.patch(local.jobId, { delivery: "local" });
	const invalid = [
		{ action: "hold", job_id: local.jobId, reason: "QA" },
		{ action: "release", job_id: local.jobId },
		{ action: "hold", job_id: "missing", reason: "QA" },
		{ action: "release", job_id: "missing" },
		{ action: "hold", job_id: "../escape", reason: "QA" },
		{ action: "hold", job_id: live.jobId, reason: " " },
		{ action: "hold", job_id: live.jobId, reason: "x".repeat(2001) },
	];
	const events = await s.parent("Read the durable integration hold, and validate rejected hold requests.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { action: "status", job_id: live.jobId } }] },
		...invalid.map((args): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_integrate", args }] })),
		{ kind: "text", text: "Validated." },
	]);
	assert.match(JSON.stringify(events[0]), /operator QA/);
	assert.match(JSON.stringify(events[0]), /ci: green/);
	for (const event of events.slice(1)) assert.equal((event as { isError?: boolean }).isError, true, JSON.stringify(event));
	await child.prompt("Release the integration hold.");
	await waitFor(() => s.provider.remaining("s08-bridge"), (remaining) => remaining === 0, { timeoutMs: 90_000, what: "bridge release script consumed" });
	await child.waitForSettled(90_000);
	assert.equal(new IntegrationHolds(s.home).get(live.jobId), undefined);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "release still requires a review");
	const pendingFile = join(s.home, paths.pendingReviewFile(live.jobId, "review", 2));
	const reviews = await s.parent("Check integration while review is already pending.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: () => {
			mkdirSync(dirname(pendingFile), { recursive: true });
			writeFileSync(pendingFile, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: live.jobId, surface: "review", attempt: 2, model: "mock/reviewer", pid: process.pid, started_at: isoTimestamp(), deadline: "2099-01-01T00:00:00Z", handed_back: true, subject: { head_sha: live.head, branch: live.jobId, files: 1, truncated: false } }));
			return { job_id: live.jobId };
		} }] },
		{ kind: "text", text: "Review is pending." },
	]);
	assert.ok(!JSON.stringify(reviews[0]).includes("already in flight"));
	assert.match(JSON.stringify(reviews[1]), /review already in flight/);
	assert.match(JSON.stringify(reviews[1]), /attempt 2/);
	rmSync(pendingFile);
	assert.equal(s.provider.remaining("s08-bridge"), 0);
});


test("landing: a hold arriving during green CI stops both merge authority paths", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const fallback of [false, true]) await t.test(fallback ? "fallback" : "repository", async (t) => {
		const s = await startStack(t);
		const live = await s.held("hold across CI", 132);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		if (fallback) {
			const store = new CheckpointStore(s.home, { kind: "merge" });
			const scope = live.head.slice(0, 12);
			store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
			store.decide(live.jobId, true, { by: "operator command", scope });
		}
		const barrier = join(s.home, "green-ci-release");
		s.setGh({ integration: true, permission: fallback ? null : "CLEAN", runs: [run(132, live.head, "completed", "success")], routes: [{ match: "actions/runs?head_sha=", replies: [{ ...runsBody([run(132, live.head, "completed", "success")]), untilFile: barrier }] }] });
		const advancing = s.integrate(live.jobId);
		const holds = new IntegrationHolds(s.home);
		try {
			await waitFor(() => s.ghCalls().some((call) => call.includes("actions/runs?head_sha=")), Boolean, { timeoutMs: 30_000, what: "green CI reaches external barrier" });
			holds.hold(live.jobId, "QA requested during CI read");
		} finally { writeFileSync(barrier, "release"); }
		const stopped = await advancing;
		assert.equal(stopped.record.next, "wait", stopped.text);
		assert.match(stopped.text, /QA requested during CI read/);
		assert.ok(stopped.record.facts.some((fact) => fact.startsWith("ci: green — ")));
		assert.equal(stopped.record.head_sha, live.head);
		assert.equal(stopped.record.pr_url, live.prUrl);
		assert.deepEqual(mergedCalls(s.ghCalls()), []);
		holds.release(live.jobId);
		s.setGh({ routes: [] });
		const resumed = await s.integrate(live.jobId);
		assert.equal(resumed.record.next, "advance", resumed.text);
		assert.equal(resumed.record.record.merge_authority?.kind, fallback ? "human_checkpoint" : "repo_derived");
	});
});
test("landing: held CI repair checks Sender authority before restoring a worker", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["revoked", "capped", "expired", "expired-released", "missing", "dead"]) {
		const permitted = mode.startsWith("expired");
		const s = await startStack(t);
		const live = await s.held(`held permission ${mode}`, 121, { repair: true });
		const identity = s.post.fleet.require(live.jobId);
		if (mode === "revoked" || mode === "capped" || mode === "expired-released") {
			writeFileSync(join(s.home, LAYOUT.budgetsFile), JSON.stringify({ ...s.post.budgets(), spawn_cap: 1 }));
			await s.held(`occupy released slot ${mode}`, 122);
			assert.equal(s.post.heldRelease.wasReleased(live.jobId), true, "a real dispatch releases the idle held worker");
		}
		const grant = s.post.mandates.issue({ projects: ["demo"], objective: "repair held CI", expiry: isoTimestamp(new Date(Date.now() - 1_000)), at: isoTimestamp(new Date(Date.parse(identity.dispatched_at) - 60_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
		if (mode === "revoked") s.post.mandates.revoke(grant.id);
		if (mode === "capped") s.post.mandates.save({ ...s.post.mandates.require(grant.id), status: "paused", pause_reason: "spend_cap", paused_at: isoTimestamp() });
		new IntegrationHolds(s.home).hold(live.jobId, "permission probe");
		if (mode === "dead") {
			const worker = s.post.manager.get(live.jobId)!.worker;
			process.kill(identity.worker.pid, "SIGKILL");
			await waitFor(() => worker.alive, (alive) => alive === false, { timeoutMs: 10_000, what: "held worker death observed" });
		} else if (!permitted) await s.post.manager.shutdownAll();
		s.setGh({ runs: [run(121, live.head, "completed", "failure")] });
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.equal(result.next, permitted ? "resolve" : "surface", mode);
		assert.equal(result.record.resolve_attempts, permitted ? 1 : 0, mode);
		if (!permitted) {
			assert.match(result.resolve_error ?? "", mode === "revoked" ? /is revoked/ : mode === "capped" ? /is paused \(spend_cap\)/ : /no live worker/, mode);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held", mode);
			assert.equal(JSON.parse(readFileSync(join(s.home, paths.envelopeFile(live.jobId)), "utf8")).envelope.head_sha, live.head, mode);
			assert.equal(s.post.fleet.require(live.jobId).worker.pid, identity.worker.pid, "refusal never revives a worker");
		}
		assert.equal(new IntegrationHolds(s.home).get(live.jobId)?.reason, "permission probe");
		assert.deepEqual(mergedCalls(s.ghCalls()), []);
	}
});

test("landing: unreadable worktree status preserves uncommitted content", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const faults = [
		{ cmd: "status", code: 128, out: "", detail: /git status\) \(exit 128/ },
		{ cmd: "ls-remote", code: 2, out: `process.stdout.write("${"a".repeat(40)}\\trefs/heads/x\\n");`, detail: /teardown refused: dirty/ },
	];
	for (const fault of faults) await t.test(fault.cmd, async (t) => {
		const s = await startStack(t);
		const live = await s.held("preserve unreadable dirty tree", 910);
		const clone = s.post.registry.pathOf("demo");
		git(clone, "fetch", "origin", live.jobId);
		git(clone, "checkout", "--detach", `origin/${live.jobId}`);
		writeFileSync(join(clone, "change.txt"), "remote update\n");
		git(clone, "commit", "-am", "remote update");
		git(clone, "push", "origin", `HEAD:${live.jobId}`);
		git(clone, "checkout", "main");
		const head = git(clone, "ls-remote", "--heads", "origin", live.jobId).split("\t")[0]!;
		writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(910, head, "completed", "success")] });
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		writeFileSync(join(live.worktree, "change.txt"), "precious uncommitted content\n");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = join(s.home, "bin", "git");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");\nconst args=process.argv.slice(2);\nif(process.cwd()===${JSON.stringify(live.worktree)} && args[0]===${JSON.stringify(fault.cmd)}) {${fault.out}process.stderr.write("fatal: unavailable\\n");process.exit(${fault.code});}\nconst r=spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const out = await s.integrate(live.jobId);
		assert.match(JSON.stringify(out.record), fault.detail);
		if (fault.cmd === "ls-remote") assert.equal(out.record.step, "teardown", "an unreachable origin is left alone, never a sync failure");
		assert.equal(readFileSync(join(live.worktree, "change.txt"), "utf8"), "precious uncommitted content\n", `unreadable ${fault.cmd} must never authorize destruction of uncommitted work`);
	});
});

