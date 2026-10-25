/** Behavior 05 landing e2e: forge observation, S14 PR binding, Actions/CI reads, cp_merged and teardown proof. Fixtures: landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { CI_READ_NEEDED, CI_UNREADABLE_LABEL } from "../../src/ci-access.ts";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { formatMerge, readMergeReceipt } from "../../src/merges.ts";
import { formatStatusTable } from "../../src/status.ts";
import { createViewer } from "../../src/viewer/server.ts";
import type { AddressInfo } from "node:net";
import { argOf, captureSpawns, advanceBase, git, readRunEvents, rebaseMergeAndDeleteHead, REPO_ROOT, squashMergeAndDeleteHead, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, CANARY, type RunRow, type Reply, type Route, run, json, runsBody, setupJob, mergeAndDeleteHead, type GitlabReply, startFakeGitlab, landOnOrigin, startStack, mergedCalls, MERGE, deployJobs, afterMergeRecord } from "./landing-helpers.ts";

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
		const release = acrossPages ? setTimeout(() => writeFileSync(first, "release"), 18_000) : undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let result: Awaited<typeof pending> | undefined;
		try {
			result = await Promise.race([pending, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 44_000); })]);
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
		// A hung runs-list call is capped per call like a jobs call (12 s), so it retries twice inside the 30 s budget.
		assert.equal(result.calls.filter((call) => call.includes(acrossPages ? "attempts/1/jobs" : runsAt)).length, acrossPages ? 1 : 3, "spent retry budget starts no further gh request");
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
		assert.equal(page.calls.filter((call) => call.includes(runsAt)).length, 6, "three attempts, then one fresh observation");
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
		// #420: empty 200s on a jobs page outlast one read's attempts; the same advance reads once more and goes on.
		s.setGh({ runs: green, routes: [{ match: jobsOf(1), replies: [{ stdout: "" }, { stdout: "" }, { stdout: "" }, { pass: true }] }] });
		const emptyOnce = await s.integrate(jobId);
		assert.match(emptyOnce.text, /ci: green/, emptyOnce.text);
		assert.equal(emptyOnce.calls.filter((call) => call.includes(jobsOf(1))).length, 4);
		s.setGh({ runs: green, routes: [{ match: jobsOf(1), replies: [{ stdout: "" }] }] });
		const stillEmpty = await s.integrate(jobId);
		assert.equal(stillEmpty.record.next, "retry", stillEmpty.text);
		assert.match(stillEmpty.text, /transient read run 1: not JSON/, stillEmpty.text);
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



