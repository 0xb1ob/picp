/** Private main-CI contracts; see docs/testing-migration-main-ci-declarations.md. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { actionsJobsPath, actionsRunsPath } from "../src/actions-ci.ts";
import { CI_UNREADABLE, ciReadDenied } from "../src/ci-access.ts";
import type { Mandate } from "../src/contracts.ts";
import { classifyMainTip, MainCiStore, runMainCiTick } from "../src/main-ci.ts";
import type { CiRun, CommandRunner } from "../src/merge-ask.ts";
import { CiRerunStore, classifyInfraFailure, maybeRerunInfra } from "../src/ci-infra-rerun.ts";
import { CI_UNREADABLE as VIEWER_CI_UNREADABLE } from "../src/viewer/overview-jobs.ts";
import { createScratchHome } from "./harness/index.ts";
import { answerActions } from "./harness/actions-api.ts";

const T1 = "1111111111111111111111111111111111111111";
const T2 = "2222222222222222222222222222222222222222";

interface Run {
	status: string;
	conclusion: string | null;
	headSha: string;
	workflowName?: string;
	databaseId?: number;
	attempt?: number;
	event?: string;
	triggeringActor?: string;
}
// cp-oc0m: every run is this machine's own push unless a test says otherwise.
const own = { event: "push", triggeringActor: "me" };
const green = (sha: string, id = 1, over: Partial<Run> = {}): Run => ({ status: "completed", conclusion: "success", headSha: sha, workflowName: "CI", databaseId: id, ...own, ...over });
const failed = (sha: string, id = 2, over: Partial<Run> = {}): Run => ({ status: "completed", conclusion: "failure", headSha: sha, workflowName: "CI", databaseId: id, ...own, ...over });

/** Only the fields `isActive` / `mandatedProjects` read. */
const mandate = (projects: string[], over: Partial<Pick<Mandate, "status" | "expiry">> = {}): Mandate => ({ status: "active", expiry: "2999-01-01T00:00:00.000Z", projects, ...over }) as Mandate;
const mandated = { mandates: () => [mandate(["demo"])], login: async () => "me" };

interface World {
	tip: string;
	runs: Run[] | string;
	fetchFails?: string;
	ghFails?: string;
	logFailed?: string;
	jobs?: unknown;
}

const RUNS_PREFIX = "gh api repos/{owner}/{repo}/actions/runs";

function execFor(world: World, calls: string[] = []): CommandRunner {
	return async (command, args) => {
		const line = `${command} ${args.join(" ")}`;
		calls.push(line);
		if (line === "git fetch origin main") {
			if (world.fetchFails) throw new Error(world.fetchFails);
			return "";
		}
		if (line === "git rev-parse origin/main") return `${world.tip}\n`;
		if (line.startsWith(RUNS_PREFIX)) {
			if (!line.includes("/attempts/")) {
				assert.equal(args[1], `repos/{owner}/{repo}/actions/runs?head_sha=${world.tip}&branch=main&per_page=100&page=1`, "the query is scoped to the fetched tip");
			}
			if (world.ghFails) throw new Error(world.ghFails);
			if (typeof world.runs === "string") return world.runs;
			const jobs = ((world.jobs as { jobs?: Array<Record<string, unknown>> } | undefined)?.jobs ?? []).map((job, index) => ({ id: index + 1, status: "completed", ...job }));
			return answerActions(String(args[1]), world.runs.map((run) => ({ ...run, jobs }))) ?? assert.fail(line);
		}
		if (line.endsWith("--log-failed")) return world.logFailed ?? "";
		throw new Error(`unexpected command: ${line}`);
	};
}

function setup(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clone = join(home.path, "clone");
	mkdirSync(clone, { recursive: true });
	return { home: home.path, clone, store: new MainCiStore({ home: home.path }) };
}


test("readMainTip rejects successful git output that is not a sha", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1, { login: "me" });
	const before = readFileSync(ctx.store.file, "utf8");
	const worlds: World[] = [{ tip: "fatal: bad revision", runs: [green(T2)] }];
	for (const world of worlds) {
		const errors: Array<[string | undefined, string]> = [];
		const out = await runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			...mandated,
			exec: execFor(world),
			onError: (project, message) => errors.push([project, message]),
			notify: () => assert.fail("no notice"),
			send: () => assert.fail("no wake"),
		});
		assert.deepEqual(out, []);
		assert.equal(errors.length, 1);
		assert.equal(errors[0]?.[0], "demo");
	}
	assert.equal(readFileSync(ctx.store.file, "utf8"), before);
});


test("a synthetic false main-CI send result is reported", async (t) => {
	const ctx = setup(t);
	const sent: string[] = [];
	const errors: string[] = [];
	const tick = (send: boolean) =>
		runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			...mandated,
			exec: execFor({ tip: T1, runs: [failed(T1)] }),
			onError: (_project, message) => errors.push(message),
			notify: () => {},
			send: (_obs, text) => {
				sent.push(text);
				return send;
			},
		});
	await tick(false);
	assert.match(errors[0] ?? "", /not sent/);
});


test("classifyMainTip ignores every run not on the tip", () => {
	assert.equal(classifyMainTip(T2, [green(T1), failed(T1)]).status, "unknown");
	assert.equal(classifyMainTip(T2, [failed(T1), green(T2)]).status, "green");
});


test("cp-oc0m: without an active mandate the tick runs no command at all, not even the login", async (t) => {
	const ctx = setup(t);
	const now = "2026-06-01T00:00:00.000Z";
	const cases: Mandate[][] = [
		[],
		[mandate(["demo"], { status: "revoked" })],
		[mandate(["demo"], { status: "paused" })],
		[mandate(["demo"], { expiry: "2026-05-31T00:00:00.000Z" })],
		[mandate(["other"])],
	];
	for (const mandates of cases) {
		const calls: string[] = [];
		const out = await runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			mandates: () => mandates,
			now: () => now,
			login: async () => assert.fail("no login without a mandated project"),
			exec: execFor({ tip: T1, runs: [failed(T1)] }, calls),
			onError: () => assert.fail("no error"),
			notify: () => assert.fail("no notice"),
			send: () => assert.fail("no wake"),
		});
		assert.deepEqual(out, []);
		assert.deepEqual(calls, []);
	}
});


// Retained by P3 (docs/testing-migration.md): moved verbatim from tests/ci-infra-rerun.test.ts.
const HEAD = "d48a81d1f4d3aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Job = Parameters<typeof classifyInfraFailure>[0][number];

/** The repo's own workflow (.github/workflows/ci.yml) with one failed step, as Actions attempt jobs. */
function view(failed: string, conclusion = "failure"): Job[] {
	const names = ["Set up job", "Checkout", "Set up Node", "Install dependencies", "Install treehouse", "Run suite (typecheck + tests)", "Eval contract check"];
	const at = names.indexOf(failed);
	const steps = names.map((name, index) => ({ name, status: "completed", conclusion: index < at ? "success" : index === at ? "failure" : "skipped" }));
	return [{ name: "suite", conclusion, steps }];
}

/** `view` as the REST attempt-jobs page `gh api …/attempts/<n>/jobs` returns. */
function jobsPage(jobs: Job[]): string {
	return JSON.stringify({ total_count: jobs.length, jobs: jobs.map((job, index) => ({ id: index + 1, run_id: 41, status: "completed", ...job })) });
}


function bench(t: { after(fn: () => void): void }, options: { view?: string; viewStatus?: number; rerunStatus?: number } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CiRerunStore(home.path);
	const calls: string[] = [];
	const claimsAtRerun: number[] = [];
	const run = async (_cwd: string, _bin: string, args: readonly string[]) => {
		calls.push(args[0] === "api" ? `api ${String(args[1]).replace(/\?.*$/, "")}` : args.join(" "));
		if (args[1] === "rerun") {
			claimsAtRerun.push(store.read().entries.length);
			return { status: options.rerunStatus ?? 0, stdout: "", stderr: options.rerunStatus ? "HTTP 403: forbidden" : "" };
		}
		return { status: options.viewStatus ?? 0, stdout: options.view ?? jobsPage(view("Install treehouse")), stderr: options.viewStatus ? "gh: Resource not accessible by integration (HTTP 403)" : "" };
	};
	const failed = (overrides: Partial<CiRun> = {}): CiRun => ({ status: "completed", conclusion: "failure", headSha: HEAD, databaseId: 41, attempt: 1, workflowName: "CI", ...overrides });
	const go = (runs: CiRun[]) => maybeRerunInfra({ jobId: "cp-r1", head: HEAD, runs, cwd: home.path, run, home: home.path, store, now: () => new Date("2026-10-04T15:00:00Z") });
	return { home: home.path, store, calls, claimsAtRerun, failed, go };
}

test("the private rerun guard refuses green and id-less runs", async (t) => {
	const b = bench(t);
	assert.equal(await b.go([b.failed({ conclusion: "success" })]), undefined, "nothing failed: nothing to say");
	const { databaseId: _id, ...noId } = b.failed();
	assert.match((await b.go([noId]))?.fact ?? "", /no id or attempt/);
	assert.deepEqual(b.calls, [], "none of those asked gh anything");
});

// Retained by P3b (docs/testing-migration.md): moved verbatim from tests/actions-ci-policy.test.ts, where P3 had
// moved it from tests/actions-ci.test.ts and tests/ci-access.test.ts.
const SHA = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const REPO = { owner: "acme", repo: "app" };


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

