/**
 * Regression policy: CI evidence comes only from Actions REST runs and attempt jobs — never the Checks API, the
 * commit-status API or GraphQL statusCheckRollup. The fake runner throws on any other request, response links to
 * prohibited endpoints are never followed, and the acquisition sources carry no prohibited request string.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ActionsCiError, actionsBranchRunsPath, actionsJobsPath, actionsRunsPath, readActionsCi, readOlderBranchRuns, statusRunner } from "../src/actions-ci.ts";
import { CI_READ_NEEDED, CI_UNREADABLE, CI_UNREADABLE_LABEL, ciReadDenied } from "../src/ci-access.ts";
import { ciAccessFindings } from "../src/ci-access-doctor.ts";
import { LAYOUT, SCHEMA_VERSION } from "../src/contracts.ts";
import { ghForeignRuns } from "../src/foreign-ci-watch.ts";
import { checkMainCi, MainCiStore } from "../src/main-ci.ts";
import { type CommandRunner, ghCiRuns } from "../src/merge-ask.ts";
import { CI_UNREADABLE as VIEWER_CI_UNREADABLE } from "../src/viewer/overview-jobs.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const SHA = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const ALLOWED = [
	/^repos\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\{owner\}\/\{repo\})\/actions\/runs\?head_sha=[0-9a-f]{40}(?:&branch=[^&]+)?&per_page=100&page=\d+$/,
	/^repos\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\{owner\}\/\{repo\})\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?per_page=100&page=\d+$/,
	// Only to tell a fresh push (runs on an older sha: superseded) from C7's "no runs at all"; never green evidence.
	/^repos\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\{owner\}\/\{repo\})\/actions\/runs\?branch=[^&]+&per_page=100&page=1$/,
];
const PROHIBITED = /check-runs|check-suites|check_runs|check_suites|\/status(?:es)?\b|statusCheckRollup|\bpr\s+checks\b|graphql/i;

/** The CI acquisition modules; every new CI reader joins this list. */
const ACQUISITION_SOURCES = [
	"src/actions-ci.ts",
	"src/merge-ask.ts",
	"src/ci-watch.ts",
	"src/foreign-ci-watch.ts",
	"src/main-ci.ts",
	"src/integrate.ts",
	"src/integrate-held.ts",
	"src/ci-infra-rerun.ts",
	"src/parked-ci.ts",
	"src/awaiting-merge.ts",
	"src/ci-access-doctor.ts",
	"src/ci-configured.ts",
];

function allowlistedGh(answer: (endpoint: string) => string) {
	const calls: string[] = [];
	const exec: CommandRunner = async (command, args) => {
		const request = [command, ...args].join(" ");
		if (command !== "gh" || args[0] !== "api" || args.length !== 2) throw new Error(`prohibited CI request: ${request}`);
		const endpoint = String(args[1]);
		if (!ALLOWED.some((pattern) => pattern.test(endpoint)) || PROHIBITED.test(endpoint)) throw new Error(`prohibited CI request: ${request}`);
		calls.push(endpoint);
		return answer(endpoint);
	};
	return { exec, calls };
}

test("Actions reader issues only runs and attempt-jobs requests and never follows response metadata links", async () => {
	const api = "https://api.github.com/repos/acme/app";
	const { exec, calls } = allowlistedGh((endpoint) =>
		endpoint.includes("/jobs")
			? JSON.stringify({
					total_count: 1,
					jobs: [{ id: 3, run_id: 7, run_attempt: 1, head_sha: SHA, name: "t", status: "completed", conclusion: "success", check_run_url: `${api}/check-runs/3` }],
				})
			: JSON.stringify({
					total_count: 1,
					workflow_runs: [
						{
							id: 7,
							run_attempt: 1,
							head_sha: SHA,
							status: "completed",
							conclusion: "success",
							jobs_url: `${api}/check-suites/9/check-runs`,
							check_suite_url: `${api}/check-suites/9`,
							statuses_url: `${api}/statuses/${SHA}`,
							url: `${api}/commits/${SHA}/status`,
						},
					],
				}),
	);
	for (const repo of [{ owner: "acme", repo: "app" }, undefined]) {
		calls.length = 0;
		const runs = await readActionsCi({ cwd: "/x", exec, ...(repo ? { repo } : {}), sha: SHA, branch: "main" });
		assert.equal(runs.length, 1);
		assert.equal(calls.length, 2);
		for (const call of calls) assert.ok(!PROHIBITED.test(call), call);
	}
});

/** Code only: comments may explain what is prohibited, and guards/detectors are not acquisition sources. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("CI acquisition sources contain no Checks, commit-status or statusCheckRollup request", () => {
	for (const file of ACQUISITION_SOURCES) {
		const lines = code(readFileSync(join(REPO_ROOT, file), "utf8")).split("\n");
		const hits = lines.filter((line) => PROHIBITED.test(line));
		assert.deepEqual(hits, [], `${file} must read CI only through Actions runs/jobs`);
	}
});

// PR3: every native consumer now reads through the Actions transport. A run-list/run-view read sneaking back in, or
// a non-allowlisted request, throws in the fake gh and fails here.
test("native adapters (merge-ask/integrate/watch, foreign watch, main CI) send only allowlisted Actions requests", async () => {
	const answer = (endpoint: string) =>
		endpoint.includes("/jobs")
			? JSON.stringify({ total_count: 1, jobs: [{ id: 3, run_id: 7, name: "t", status: "completed", conclusion: "failure", steps: [] }] })
			: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 7, run_attempt: 2, head_sha: SHA, status: "completed", conclusion: "failure", name: "CI", event: "push", triggering_actor: { login: "me" } }] });
	const { exec, calls } = allowlistedGh(answer);
	assert.equal((await ghCiRuns({ cwd: "/x", exec })(SHA)).length, 1);
	assert.equal((await ghForeignRuns({ cwd: "/x", exec })("acme", "app", SHA)).length, 1);
	const mainExec: CommandRunner = async (command, args, options) => {
		if (command === "git") return args[0] === "rev-parse" ? `${SHA}\n` : "";
		if (args[0] === "run" && args[1] === "view" && args[3] === "--log-failed") return ""; // log text, not CI evidence
		return exec(command, args, options);
	};
	const home = createScratchHome();
	try {
		const obs = await checkMainCi({ project: "demo", cwd: "/x", home: home.path, store: new MainCiStore({ home: home.path }), login: "me", exec: mainExec });
		assert.equal(obs?.event, "main_ci_failed");
	} finally {
		home.cleanup();
	}
	assert.equal(calls.length, 6, "runs plus one attempt-jobs page per adapter");
	assert.ok(calls.every((call) => ALLOWED.some((pattern) => pattern.test(call)) && !PROHIBITED.test(call)), calls.join("\n"));
});

test("the branch-runs read is one allowlisted page, excludes the head, and never reads jobs", async () => {
	const OLD = "a".repeat(40);
	const { exec, calls } = allowlistedGh(() =>
		JSON.stringify({
			total_count: 2,
			workflow_runs: [
				{ id: 1, run_attempt: 1, head_sha: SHA, status: "completed", conclusion: "success" },
				{ id: 2, run_attempt: 1, head_sha: OLD, status: "completed", conclusion: "success" },
			],
		}),
	);
	const older = await readOlderBranchRuns({ cwd: "/x", exec, branch: "cp-x/y", head: SHA });
	assert.deepEqual(older.map((run) => run.headSha), [OLD], "a run on the head itself is never returned");
	assert.deepEqual(calls, ["repos/{owner}/{repo}/actions/runs?branch=cp-x%2Fy&per_page=100&page=1"]);
	assert.throws(() => actionsBranchRunsPath({ branch: "a..b" }), /malformed branch/);
	const { exec: denied } = allowlistedGh(() => { throw new Error("gh: HTTP 403"); });
	await assert.rejects(readOlderBranchRuns({ cwd: "/x", exec: denied, branch: "b", head: SHA }), /Actions CI read denied/);
});

test("CI acquisition sources issue no `gh run list` or `gh run view --json` read", () => {
	for (const file of ACQUISITION_SOURCES) {
		const hits = code(readFileSync(join(REPO_ROOT, file), "utf8")).split("\n").filter((line) => /["']run["'],\s*["']list["']|--json["']?,\s*["']jobs|actions\/runs.*--jq/.test(line));
		assert.deepEqual(hits, [], `${file} must read CI through src/actions-ci.ts`);
	}
});

// PR5: /doctor probes workflows, the newest run and its attempt jobs — nothing else. A Checks or status probe, or
// following a response's URL, throws in the fake gh, and the finding would no longer say "CI readable".
test("/doctor's CI probe sends only allowlisted Actions requests", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(dirname(join(home.path, LAYOUT.projectsFile)), { recursive: true });
	const projects = [{ name: "app", clone_url: "https://github.com/acme/app", delivery: "pr", registered_at: "2026-10-15T00:00:00Z" }];
	writeFileSync(join(home.path, LAYOUT.projectsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-10-15T00:00:00Z", projects }));
	const doctorAllowed = [...ALLOWED, /^repos\/acme\/app\/actions\/workflows$/, /^repos\/acme\/app\/actions\/runs\?per_page=1&page=1$/];
	const api = "https://api.github.com/repos/acme/app";
	const calls: string[] = [];
	const findings = ciAccessFindings(home.path, (command, args) => {
		const endpoint = String(args[1]);
		if (command !== "gh" || args[0] !== "api" || args.length !== 2 || !doctorAllowed.some((p) => p.test(endpoint)) || PROHIBITED.test(endpoint)) {
			throw new Error(`prohibited CI request: ${command} ${args.join(" ")}`);
		}
		calls.push(endpoint);
		const body = endpoint.endsWith("/workflows")
			? { total_count: 1, workflows: [{ id: 1 }] }
			: endpoint.includes("/jobs")
				? { total_count: 1, jobs: [{ id: 3, run_id: 7, run_attempt: 1, head_sha: SHA, status: "completed", conclusion: "success", check_run_url: `${api}/check-runs/3` }] }
				: { total_count: 1, workflow_runs: [{ id: 7, run_attempt: 1, head_sha: SHA, status: "completed", conclusion: "success", check_suite_url: `${api}/check-suites/9`, statuses_url: `${api}/statuses/${SHA}` }] };
		return { status: 0, stdout: JSON.stringify(body), stderr: "" };
	});
	assert.equal(calls.length, 3, calls.join("\n"));
	assert.match(findings[0]?.what ?? "", /^CI readable for acme\/app/);
});

// Retained by P3 (docs/testing-migration.md): moved verbatim from tests/actions-ci.test.ts and tests/ci-access.test.ts.
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

test("ciReadDenied: only a permission refusal of a CI read counts", () => {
	assert.ok(ciReadDenied("gh run list --branch b failed: HTTP 403: Resource not accessible by personal access token"));
	assert.ok(ciReadDenied("HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/runs?branch=b)"));
	assert.ok(ciReadDenied("repos/o/r/actions/runs/9/attempts/2/jobs: Resource not accessible by integration"));
	assert.ok(ciReadDenied("gh run view 9 --json jobs failed: HTTP 403"));
	for (const path of ["repos/o/r/commits/abc/check-runs", "repos/o/r/commits/abc/status", "repos/o/r/statuses/abc"]) {
		assert.equal(ciReadDenied(`${path}: HTTP 403: Resource not accessible by integration`), false, `${path} is not CI evidence`);
	}
	assert.equal(ciReadDenied("gh run list --branch b failed: dial tcp: network is unreachable"), false, "a network fault is unknown");
	assert.equal(ciReadDenied("gh api repos/o/r/pulls/7 failed: HTTP 403"), false, "a PR read is not a CI read");
	assert.equal(VIEWER_CI_UNREADABLE, CI_UNREADABLE, "the viewer reads the value the watcher writes");
});

test("the browser mirrors the backend's Actions-only label and advice, keeping its needs prefix", () => {
	const tsx = readFileSync(join(REPO_ROOT, "viewer-app/components/JobSignals.tsx"), "utf8");
	assert.ok(tsx.includes(`CI_UNREADABLE_LABEL = "${CI_UNREADABLE_LABEL}"`), "label parity");
	assert.ok(tsx.includes(`CI_READ_NEEDED = "needs ${CI_READ_NEEDED}"`), "advice parity");
	assert.doesNotMatch(`${CI_UNREADABLE_LABEL} ${CI_READ_NEEDED}`, /checks|statuses/i);
});
