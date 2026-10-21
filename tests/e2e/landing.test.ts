/**
 * Behavior 05, first slice (docs/testing-migration.md): what a held PR's CI read, CI configuration, infra rerun and
 * /doctor make of each Actions answer. Real CommandPost, implementer workers and reporter, scratch git; scripted `gh`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CI_READ_NEEDED, CI_UNREADABLE_LABEL } from "../../src/ci-access.ts";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { formatStatusTable } from "../../src/status.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	REPO_ROOT,
	type ScriptStep,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";

const SKIP = treehouseAvailable() ? false : "the landing e2e needs treehouse on PATH";
const CANARY = "ghp_canary0123456789";

interface RunRow {
	id?: number;
	run_attempt: number | string;
	head_sha: string;
	status: string | number | null;
	conclusion: string | null;
	name: string;
}
interface Reply {
	code?: number | "signal";
	stdout?: string;
	stderr?: string;
	/** Answer as if no route matched. */
	pass?: boolean;
}
/** Replies in order to every call whose joined args contain `match`; the last reply repeats. */
interface Route {
	match: string;
	replies: Reply[];
}
interface GhState {
	prs: Record<string, { number: number; url: string }>;
	runs: RunRow[];
	/** Attempt jobs by run id; absent: one job mirroring the run, with one `npm test` step. */
	jobs?: Record<string, Array<Record<string, unknown>>>;
	/** Page 2 onward starts this many rows early: a boundary shift that repeats the previous page's last run. */
	overlap?: number;
	routes?: Route[];
}

function run(id: number, head: string, status: string | null, conclusion: string | null, over: Partial<RunRow> = {}): RunRow {
	return { id, run_attempt: 1, head_sha: head, status, conclusion, name: "ci", ...over };
}
const json = (value: unknown): Reply => ({ stdout: JSON.stringify(value) });
const runsBody = (rows: unknown[], total = rows.length) => json({ total_count: total, workflow_runs: rows });
const setupJob = (failedStep: string, conclusion = "failure") => {
	const names = ["Set up job", "Checkout", "Set up Node", "Install dependencies", "Install treehouse", "Run suite (typecheck + tests)", "Eval contract check"];
	const at = names.indexOf(failedStep);
	const steps = names.map((name, index) => ({ name, status: "completed", conclusion: index < at ? "success" : index === at ? "failure" : "skipped" }));
	return { id: 1, name: "suite", status: "completed", conclusion, steps };
};

/** A `gh` answering routes first, then PR views, paged Actions runs and jobs, workflows and reruns; else exit 1. */
function writeFakeGh(bin: string, stateFile: string, countsFile: string, logFile: string, claimsFile: string): void {
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node
const { execFileSync } = require("child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "rerun") {
  const claims = existsSync(${JSON.stringify(claimsFile)}) ? readFileSync(${JSON.stringify(claimsFile)}, "utf8") : "";
  appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["claims-at-rerun", claims]) + "\\n");
}
const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const reply = (r) => {
  if (r.code === "signal") process.kill(process.pid, "SIGKILL");
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code || 0;
  process.exit();
};
const out = (value) => reply({ stdout: JSON.stringify(value) });
const line = args.join(" ");
const counts = existsSync(${JSON.stringify(countsFile)}) ? JSON.parse(readFileSync(${JSON.stringify(countsFile)}, "utf8")) : {};
for (const [index, route] of (state.routes || []).entries()) {
  if (!line.includes(route.match)) continue;
  const n = counts[index] || 0;
  counts[index] = n + 1;
  writeFileSync(${JSON.stringify(countsFile)}, JSON.stringify(counts));
  const answer = route.replies[Math.min(n, route.replies.length - 1)];
  if (answer.pass) break;
  reply(answer);
}
const heads = () => {
  const found = {};
  for (const row of execFileSync("git", ["ls-remote", "--heads", "origin"], { encoding: "utf8" }).split("\\n")) {
    const [sha, ref] = row.split("\\t");
    if (sha && ref) found[ref.replace("refs/heads/", "")] = sha;
  }
  return found;
};
const path = args[1] || "";
const query = (name) => { const m = new RegExp("[?&]" + name + "=([^&]*)").exec(path); return m ? decodeURIComponent(m[1]) : undefined; };
const page = Number(query("page") || 1);
const slice = (list) => list.slice(page === 1 ? 0 : (page - 1) * 100 - (state.overlap || 0), page * 100);
const branchOf = Object.fromEntries(Object.entries(state.prs).map(([branch, pr]) => [pr.url, branch]));
const all = state.runs || [];
if (args[0] === "pr" && args[1] === "view") {
  const branch = branchOf[args[2]] || (state.prs[args[2]] ? args[2] : undefined);
  if (branch) out({ number: state.prs[branch].number, url: state.prs[branch].url, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    headRefName: branch, headRefOid: heads()[branch], baseRefName: "main", isDraft: false, autoMergeRequest: null });
}
if (args[0] === "api" && /\\/pulls\\/\\d+$/.test(path)) {
  const number = Number(path.split("/pulls/")[1]);
  const hit = Object.entries(state.prs).find(([, pr]) => pr.number === number);
  if (hit) out({ number, html_url: hit[1].url, state: "open", merged: false, head: { sha: heads()[hit[0]], ref: hit[0] } });
}
if (args[0] === "api" && path.includes("/actions/runs?head_sha=")) {
  const runs = all.filter((row) => row.head_sha === query("head_sha"));
  out({ total_count: runs.length, workflow_runs: slice(runs) });
}
if (args[0] === "api" && path.includes("/actions/runs?branch=")) out({ total_count: 0, workflow_runs: [] });
const jobs = /\\/actions\\/runs\\/(\\d+)\\/attempts\\/(\\d+)\\/jobs\\?/.exec(path);
if (args[0] === "api" && jobs) {
  const row = all.find((entry) => entry.id === Number(jobs[1]));
  const list = ((state.jobs || {})[jobs[1]] || (row ? [{ id: row.id * 10, name: "test", status: row.status, conclusion: row.conclusion,
    steps: [{ name: "npm test", status: row.status, conclusion: row.conclusion }] }] : [])).map((job) => ({ run_id: Number(jobs[1]), run_attempt: Number(jobs[2]), ...job }));
  out({ total_count: list.length, jobs: slice(list) });
}
if (args[0] === "api" && path.endsWith("/actions/workflows")) out({ total_count: 1, workflows: [{ id: 7, name: "ci", state: "active" }] });
if (args[0] === "run" && args[1] === "rerun") reply({});
process.stderr.write("unexpected gh " + line + "\\n");
process.exit(1);
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
}

/** Real CommandPost over a registered scratch project; no held-PR continuation, so every cp_integrate is the test's. */
async function startStack(t: TestContext, options: { project?: boolean } = {}) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	agentDir.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [] }));
	const stateFile = join(home.path, "gh-state.json");
	const countsFile = join(home.path, "gh-counts.json");
	const logFile = join(home.path, "gh-calls.log");
	const gh: GhState = { prs: {}, runs: [] };
	const setGh = (patch: Partial<GhState>) => {
		Object.assign(gh, patch);
		writeFileSync(stateFile, JSON.stringify(gh));
		rmSync(countsFile, { force: true });
	};
	setGh({});
	const bin = join(home.path, "bin");
	writeFakeGh(bin, stateFile, countsFile, logFile, join(home.path, LAYOUT.ciRerunsFile));
	const saved = { PATH: process.env.PATH, CP_CI_WATCH_SECONDS: process.env.CP_CI_WATCH_SECONDS };
	process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
	process.env.CP_CI_WATCH_SECONDS = "1";
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env }, holdsParentLock: () => true });
	t.after(async () => {
		process.env.PATH = saved.PATH;
		if (saved.CP_CI_WATCH_SECONDS === undefined) delete process.env.CP_CI_WATCH_SECONDS;
		else process.env.CP_CI_WATCH_SECONDS = saved.CP_CI_WATCH_SECONDS;
		await post.shutdown();
		await provider.stop();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
	});
	if (options.project !== false) {
		await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
		const clone = post.registry.pathOf("demo");
		execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
		const pool = enableTreehouse(clone, { maxTrees: 4 });
		t.after(() => pool.cleanup());
	}

	const remoteHead = (branch: string) =>
		execFileSync("git", ["ls-remote", repo.remote as string, `refs/heads/${branch}`], { encoding: "utf8" }).split("\t")[0]?.trim() ?? "";
	/** A fresh ledger job whose implementer pushes, reports a PR and stands by; resolves once it is held. */
	const held = async (title: string, number: number) => {
		const job = await post.ledger().create({ title, project: "demo", delivery: "pr", kind: "ship" });
		const prUrl = `https://github.com/example/demo/pull/${number}`;
		const report: ScriptStep = {
			kind: "tool_calls",
			calls: [{ name: "report_result", args: () => ({ job_id: job.id, kind: "ship", status: "done", summary: "Opened a PR.", branch: job.id, pr_url: prUrl, head_sha: remoteHead(job.id) }) }],
		};
		// A red head promotes the implementer once; it re-reports the same head, so the job is held again.
		const steps: ScriptStep[] = [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf 'v1\\n' > change.txt && git add -A && git commit -q -m v1 && git push -q -u origin ${job.id}` } }] },
			report,
			{ kind: "text", text: "standing by" },
			report,
			{ kind: "text", text: "standing by" },
		];
		const model = provider.addScript(`landing-${job.id}`, steps, { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		gh.prs[job.id] = { number, url: prUrl };
		setGh({});
		const dispatched = await post.dispatch({ jobId: job.id, task: "Change change.txt and open a PR.", model, fetch: false });
		assert.equal(dispatched.receipt, "accepted");
		await waitFor(() => readFleet(home.path).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.phase === "held" && entry.reported_at !== undefined, {
			timeoutMs: 90_000,
			what: `${job.id} held after its envelope`,
		});
		return { jobId: job.id, head: remoteHead(job.id), prUrl };
	};
	const ghCalls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((row) => (JSON.parse(row) as string[]).join(" ")) : []);
	/** One cp_integrate advance, re-asked while a promoted implementer re-reports; its gh calls containing `match`. */
	const integrate = async (jobId: string, match = "") => {
		const before = ghCalls().length;
		let record = await post.integrate({ jobId });
		for (const deadline = Date.now() + 60_000; record.step === "start" && record.next === "resolve" && Date.now() < deadline; ) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			record = await post.integrate({ jobId });
		}
		return { record, calls: ghCalls().slice(before).filter((call) => call.includes(match)), text: [...record.facts, record.reason].join("\n") };
	};
	/** CI watch ticks (the extension timer's call) until `jobId` was checked. */
	const tick = async (jobId: string) => {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const result = await post.ciTick();
			if (result.checked.includes(jobId)) return result;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return assert.fail(`the CI watch never checked ${jobId}`);
	};
	return { home: home.path, post, gh, setGh, held, ghCalls, integrate, tick };
}

const mergedCalls = (calls: string[]) => calls.filter((call) => call.startsWith("pr merge"));

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
		for (const name of names) await s.post.registry.register({ name, clone_url: `https://github.com/o/${name}`, delivery: "pr" });
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
		assert.deepEqual([by["ci.garbled"]?.severity, by["ci.garbled"]?.what], ["warn", "CI state unknown for o/garbled: the Actions read failed (malformed)"]);
		assert.equal(by["ci.flaky"]?.severity, "warn");
		assert.match(by["ci.flaky"]?.what ?? "", /CI state unknown/);
		assert.deepEqual([by["ci.short"]?.severity, by["ci.short"]?.what], ["warn", "CI state unknown for o/short: the Actions read failed (incomplete)"]);
		assert.equal(by["ci.lab"], undefined, "a non-GitHub project is not asked");
		assert.doesNotMatch(JSON.stringify(report), new RegExp(secret), "never prints what gh printed");
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
	},
);
