/** Behavior 05 landing e2e, part of the split of landing.test.ts; fixtures live in landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { detectCiWait } from "../../src/ci-wait.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { CI_EVIDENCE_KEEP, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { createViewer } from "../../src/viewer/server.ts";
import type { AddressInfo } from "node:net";
import { advanceBase, git, readRunEvents, REPO_ROOT, type ScriptStep, waitFor } from "../harness/index.ts";
import { SKIP, type RunRow, type Reply, type Route, type GhState, run, json, runsBody, setupJob, startFakeGitlab, startStack, mergedCalls, MERGE } from "./landing-helpers.ts";

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


