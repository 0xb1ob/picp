/**
 * The Actions REST transport (src/actions-ci.ts): exact-head runs plus attempt jobs, read in full or not at all.
 * Hermetic: `exec` is a fake keyed on the `gh api` endpoint; nothing spawns a process or reaches the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTIONS_MAX_PAGES,
	ActionsCiError,
	actionsJobsPath,
	actionsRunsPath,
	parseJobsPage,
	parseRunsPage,
	readActionsCi,
	readActionsJobs,
	statusRunner,
} from "../src/actions-ci.ts";
import { ciReadDenied } from "../src/ci-access.ts";
import type { CommandRunner } from "../src/merge-ask.ts";

const SHA = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const OTHER = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
const REPO = { owner: "acme", repo: "app" };

function run(id: number, extra: Record<string, unknown> = {}) {
	return { id, run_attempt: 1, head_sha: SHA, status: "completed", conclusion: "success", name: `wf-${id}`, event: "push", ...extra };
}

function job(id: number, runId: number, extra: Record<string, unknown> = {}) {
	return { id, run_id: runId, run_attempt: 1, head_sha: SHA, name: `job-${id}`, status: "completed", conclusion: "success", steps: [], ...extra };
}

const runsBody = (runs: unknown[], total = runs.length) => JSON.stringify({ total_count: total, workflow_runs: runs });
const jobsBody = (jobs: unknown[], total = jobs.length) => JSON.stringify({ total_count: total, jobs });

/** A fake `gh api`: answers from `routes` (string or thrower), records every endpoint, refuses anything unrouted. */
function fakeGh(routes: Record<string, string | (() => string)>) {
	const calls: string[] = [];
	const exec: CommandRunner = async (command, args) => {
		assert.equal(command, "gh");
		assert.equal(args[0], "api");
		assert.equal(args.length, 2);
		const endpoint = String(args[1]);
		calls.push(endpoint);
		const route = routes[endpoint];
		if (route === undefined) throw new Error(`unrouted gh api ${endpoint}`);
		return typeof route === "function" ? route() : route;
	};
	return { exec, calls };
}

const runsPath = (page = 1) => actionsRunsPath({ repo: REPO, sha: SHA, page });
const jobsPath = (runId: number, attempt = 1, page = 1) => actionsJobsPath({ repo: REPO, runId, attempt, page });

test("paths: exact head, explicit repo or gh placeholders, attempt-bound jobs; malformed ids refused", () => {
	assert.equal(runsPath(), `repos/acme/app/actions/runs?head_sha=${SHA}&per_page=100&page=1`);
	assert.equal(actionsRunsPath({ sha: SHA, branch: "main", page: 2 }), `repos/{owner}/{repo}/actions/runs?head_sha=${SHA}&branch=main&per_page=100&page=2`);
	assert.equal(jobsPath(7, 3, 2), "repos/acme/app/actions/runs/7/attempts/3/jobs?per_page=100&page=2");
	assert.throws(() => actionsRunsPath({ sha: "abc1234", page: 1 }), /malformed head sha/);
	assert.throws(() => actionsRunsPath({ sha: SHA, branch: "a&b", page: 1 }), /malformed branch/);
	assert.throws(() => actionsRunsPath({ repo: { owner: "acme/x", repo: "app" }, sha: SHA, page: 1 }), /malformed repo/);
	assert.throws(() => actionsJobsPath({ runId: 0, attempt: 1, page: 1 }), /refusing/);
});

test("readActionsCi: normalizes runs with identity, event, actor and their attempt's jobs and steps", async () => {
	const { exec, calls } = fakeGh({
		[runsPath()]: runsBody([run(11, { run_attempt: 2, triggering_actor: { login: "bot" } }), run(12, { status: "queued", conclusion: null })]),
		[jobsPath(11, 2)]: jobsBody([job(101, 11, { run_attempt: 2, steps: [{ name: "Run tests", status: "completed", conclusion: "success" }] })]),
		[jobsPath(12)]: jobsBody([]),
	});
	const runs = await readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA });
	assert.deepEqual(calls, [runsPath(), jobsPath(11, 2), jobsPath(12)]);
	assert.deepEqual(runs, [
		{
			status: "completed",
			conclusion: "success",
			headSha: SHA,
			databaseId: 11,
			attempt: 2,
			workflowName: "wf-11",
			event: "push",
			triggeringActor: "bot",
			jobs: [{ id: 101, runId: 11, runAttempt: 2, name: "job-101", status: "completed", conclusion: "success", steps: [{ name: "Run tests", status: "completed", conclusion: "success" }] }],
		},
		{ status: "queued", conclusion: null, headSha: SHA, databaseId: 12, attempt: 1, workflowName: "wf-12", event: "push", jobs: [] },
	]);
});

test("readActionsCi: zero runs is an observation; two runs with one workflow name both survive", async () => {
	assert.deepEqual(await readActionsCi({ cwd: "/x", exec: fakeGh({ [runsPath()]: runsBody([]) }).exec, repo: REPO, sha: SHA }), []);
	const { exec } = fakeGh({
		[runsPath()]: runsBody([run(1, { name: "ci", conclusion: "failure" }), run(2, { name: "ci" })]),
		[jobsPath(1)]: jobsBody([]),
		[jobsPath(2)]: jobsBody([]),
	});
	const runs = await readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA });
	assert.deepEqual(runs.map((r) => [r.databaseId, r.conclusion]), [[1, "failure"], [2, "success"]]);
});

test("readActionsCi: a null run status is unfinished, never success", async () => {
	const { exec } = fakeGh({ [runsPath()]: runsBody([run(1, { status: null, conclusion: null })]), [jobsPath(1)]: jobsBody([]) });
	const [only] = await readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA });
	assert.equal(only?.status, "unknown");
	assert.equal(only?.conclusion, null);
});

test("pagination: runs and jobs pages are followed to the short page; a boundary duplicate counts once", async () => {
	const first = Array.from({ length: 100 }, (_, i) => run(i + 1));
	const jobsFirst = Array.from({ length: 100 }, (_, i) => job(1000 + i, 1));
	const routes: Record<string, string> = {
		[runsPath(1)]: runsBody(first, 101),
		[runsPath(2)]: runsBody([run(100), run(101)], 101),
		[jobsPath(1, 1, 1)]: jobsBody(jobsFirst, 101),
		[jobsPath(1, 1, 2)]: jobsBody([job(1100, 1)], 101),
	};
	for (let id = 2; id <= 101; id++) routes[jobsPath(id)] = jobsBody([]);
	const runs = await readActionsCi({ cwd: "/x", exec: fakeGh(routes).exec, repo: REPO, sha: SHA });
	assert.equal(runs.length, 101);
	assert.equal(runs[0]?.jobs.length, 101);
});

test("fail closed: a short read, conflicting duplicate, page cap or API ceiling is incomplete, never a subset", async () => {
	const incomplete = async (routes: Record<string, string>) => {
		const error = await readActionsCi({ cwd: "/x", exec: fakeGh(routes).exec, repo: REPO, sha: SHA }).then(
			() => assert.fail("expected a refusal"),
			(caught: unknown) => caught,
		);
		assert.ok(error instanceof ActionsCiError);
		assert.equal(error.category, "incomplete");
	};
	await incomplete({ [runsPath()]: runsBody([run(1)], 2), [jobsPath(1)]: jobsBody([]) });
	const full = Array.from({ length: 100 }, (_, i) => run(i + 1));
	await incomplete({ [runsPath(1)]: runsBody(full, 101), [runsPath(2)]: runsBody([run(100, { conclusion: "failure" })], 101) });
	const capped: Record<string, string> = {};
	for (let page = 1; page <= ACTIONS_MAX_PAGES; page++) {
		capped[runsPath(page)] = runsBody(Array.from({ length: 100 }, (_, i) => run(page * 1000 + i)), 999);
	}
	await incomplete(capped);
	await incomplete({ [runsPath()]: runsBody([run(1)], 1000) });
});

test("fail closed: malformed bodies, missing identity and a mixed head are malformed", async () => {
	const bodies = [
		"not json",
		JSON.stringify({ workflow_runs: [] }),
		JSON.stringify({ total_count: 1, workflow_runs: {} }),
		runsBody([run(1, { id: undefined })]),
		runsBody([run(1, { run_attempt: "1" })]),
		runsBody([run(1, { head_sha: OTHER })]),
		runsBody([run(1, { status: 3 })]),
		runsBody(["x"]),
	];
	for (const body of bodies) {
		await assert.rejects(readActionsCi({ cwd: "/x", exec: fakeGh({ [runsPath()]: body }).exec, repo: REPO, sha: SHA }), (error: unknown) => {
			assert.ok(error instanceof ActionsCiError, body);
			assert.equal(error.category, "malformed", body);
			return true;
		});
	}
});

test("parseJobsPage: a job from another run, attempt or head is malformed", () => {
	const at = { runId: 5, attempt: 2, sha: SHA };
	assert.throws(() => parseJobsPage(jobsBody([job(1, 6, { run_attempt: 2 })]), at), /not of the run/);
	assert.throws(() => parseJobsPage(jobsBody([job(1, 5, { run_attempt: 1 })]), at), /not of attempt 2/);
	assert.throws(() => parseJobsPage(jobsBody([job(1, 5, { run_attempt: 2, head_sha: OTHER })]), at), /requested head/);
	assert.equal(parseJobsPage(jobsBody([job(1, 5, { run_attempt: 2 })]), at).items.length, 1);
	assert.equal(parseRunsPage(runsBody([run(1)]), SHA.toUpperCase()).items.length, 1);
});

test("jobs read failure fails the whole observation: no run-only green", async () => {
	for (const [failure, category] of [
		["gh api x failed: HTTP 403: Resource not accessible by personal access token", "denied"],
		["gh api x failed: HTTP 502", "transport"],
		["gh api x failed: HTTP 403: API rate limit exceeded", "rate_limited"],
	] as const) {
		const { exec } = fakeGh({
			[runsPath()]: runsBody([run(1)]),
			[jobsPath(1)]: () => {
				throw new Error(failure);
			},
		});
		await assert.rejects(readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA }), (error: unknown) => {
			assert.ok(error instanceof ActionsCiError);
			assert.equal(error.category, category);
			return true;
		});
	}
});

test("errors: denial stays classifiable as unreadable CI; rate limit does not; raw output never carried", async () => {
	const secret = "ghp_canary0123456789";
	const failing = (message: string) =>
		readActionsCi({
			cwd: "/x",
			exec: fakeGh({
				[runsPath()]: () => {
					throw new Error(message);
				},
			}).exec,
			repo: REPO,
			sha: SHA,
		}).then(
			() => assert.fail("expected a refusal"),
			(error: unknown) => error as ActionsCiError,
		);
	const denied = await failing(`gh api failed: HTTP 404: Not Found ${secret}`);
	assert.equal(denied.category, "denied");
	assert.ok(ciReadDenied(denied.message));
	assert.ok(!denied.message.includes(secret));
	const limited = await failing(`gh api failed: HTTP 403: API rate limit exceeded ${secret}`);
	assert.equal(limited.category, "rate_limited");
	assert.ok(!ciReadDenied(limited.message));
	assert.ok(!limited.message.includes(secret));
	const garbled = await readActionsCi({ cwd: "/x", exec: fakeGh({ [runsPath()]: `{${secret}` }).exec, repo: REPO, sha: SHA }).then(
		() => assert.fail("expected a refusal"),
		(error: unknown) => error as ActionsCiError,
	);
	assert.equal(garbled.category, "malformed");
	assert.ok(!garbled.message.includes(secret));
});

// The "Actions read came back malformed (not JSON)" stalls: a transient non-JSON body or an HTML error page now
// retries inside the tick, and a persisting one is a single fault naming gh's status and a redacted body preview.
test("retry: a truncated body recovers on retry; a persisting one is one malformed fault with status and preview", async () => {
	const pauses: number[] = [];
	const sleep = async (ms: number) => void pauses.push(ms);
	const bodies = [`{"total_count":1,"workflow_runs":[{"id":1`, runsBody([run(1)])];
	const { exec, calls } = fakeGh({ [runsPath()]: () => bodies.shift() ?? "", [jobsPath(1)]: jobsBody([]) });
	assert.equal((await readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA, sleep })).length, 1);
	assert.deepEqual([calls, pauses], [[runsPath(), runsPath(), jobsPath(1)], [250]]);
	const html = "<!DOCTYPE html>\n<html>ghp_canary0123456789 Unicorn!</html>";
	const stuck = fakeGh({ [runsPath()]: html });
	const error = await readActionsCi({ cwd: "/x", exec: stuck.exec, repo: REPO, sha: SHA, sleep }).then(() => assert.fail("expected a refusal"), (caught: unknown) => caught as ActionsCiError);
	assert.equal(error.category, "malformed");
	assert.equal(stuck.calls.length, 3);
	assert.match(error.message, /not JSON; gh exit 0; body "<!DOCTYPE html> <html>\[redacted\] Unicorn!<\/html>"; 3 attempts/);
	assert.ok(!error.message.includes("canary"));
});

test("retry: an HTML 403 is a transport fault with its status and body, never a token denial; JSON 403 is denied", async () => {
	const sleep = async () => {};
	const failing = (stdout: string) =>
		readActionsCi({
			cwd: "/x",
			exec: fakeGh({ [runsPath()]: () => { throw Object.assign(new Error("gh api x failed: gh: HTTP 403"), { stdout }); } }).exec,
			repo: REPO,
			sha: SHA,
			sleep,
		}).then(() => assert.fail("expected a refusal"), (caught: unknown) => caught as ActionsCiError);
	const html = await failing("<html><title>Access denied</title></html>");
	assert.equal(html.category, "transport");
	assert.match(html.message, /status 403; body "<html><title>Access denied<\/title><\/html>"; 3 attempts/);
	assert.ok(!ciReadDenied(html.message));
	const json = await failing(JSON.stringify({ message: "Resource not accessible by integration" }));
	assert.equal(json.category, "denied");
	assert.ok(ciReadDenied(json.message));
});

test("retry: never past the budget, and a structurally wrong JSON page is not retried", async () => {
	let clock = 0;
	const { exec, calls } = fakeGh({ [runsPath()]: () => ((clock += 900), "<html>") });
	await assert.rejects(readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA, timeoutMs: 1000, now: () => clock, sleep: async () => {} }), /malformed.*not JSON/);
	assert.equal(calls.length, 1, "100 ms left is less than the 250 ms pause");
	const wrong = fakeGh({ [runsPath()]: JSON.stringify({ workflow_runs: [] }) });
	await assert.rejects(readActionsCi({ cwd: "/x", exec: wrong.exec, repo: REPO, sha: SHA, sleep: async () => {} }), /missing total_count/);
	assert.equal(wrong.calls.length, 1);
});

test("budget: one total deadline across pages, each request gets only what remains", async () => {
	let clock = 0;
	const timeouts: number[] = [];
	const exec: CommandRunner = async (_command, args, options) => {
		timeouts.push(options.timeoutMs);
		clock += 600;
		return String(args[1]).includes("/jobs") ? jobsBody([]) : runsBody([run(1), run(2)]);
	};
	await assert.rejects(readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA, timeoutMs: 1000, now: () => clock }), (error: unknown) => {
		assert.ok(error instanceof ActionsCiError);
		assert.equal(error.category, "deadline");
		return true;
	});
	assert.deepEqual(timeouts, [1000, 400]);
});

test("readActionsJobs: one attempt's jobs, all pages, through the same validation", async () => {
	const { exec, calls } = fakeGh({ [jobsPath(9, 3)]: jobsBody([job(1, 9, { run_attempt: 3, conclusion: "failure" })]) });
	const jobs = await readActionsJobs({ cwd: "/x", exec, repo: REPO }, { runId: 9, attempt: 3 });
	assert.deepEqual(calls, [jobsPath(9, 3)]);
	assert.equal(jobs[0]?.conclusion, "failure");
});

test("statusRunner: forwards each request's remaining budget as timeoutMs; a non-zero status throws", async () => {
	const seen: unknown[] = [];
	const exec = statusRunner(async (cwd, bin, args, options) => {
		seen.push({ cwd, bin, args, options });
		return { status: String(args[1]).includes("/jobs") ? 1 : 0, stdout: runsBody([run(1)]), stderr: "HTTP 403" };
	});
	await assert.rejects(readActionsCi({ cwd: "/x", exec, repo: REPO, sha: SHA, timeoutMs: 1000, now: () => 0 }));
	assert.deepEqual(seen, [
		{ cwd: "/x", bin: "gh", args: ["api", runsPath()], options: { timeoutMs: 1000 } },
		{ cwd: "/x", bin: "gh", args: ["api", jobsPath(1)], options: { timeoutMs: 1000 } },
	]);
});
