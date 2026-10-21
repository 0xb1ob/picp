/**
 * Behavior 05 (docs/testing-migration.md): what a held PR's CI read, CI configuration, infra rerun, /doctor, cp_merged
 * and cp_teardown's git landing proof make of each answer. Real CommandPost, implementer workers and reporter, scratch
 * git; scripted `gh`, and a local https GitLab (REST plus git http-backend) for the GitLab cases.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CI_READ_NEEDED, CI_UNREADABLE_LABEL } from "../../src/ci-access.ts";
import { CommandPost } from "../../src/command-post.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { CI_EVIDENCE_KEEP, DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import type { ForgeConfig } from "../../src/forge-url.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { formatMerge, readMergeReceipt } from "../../src/merges.ts";
import { formatStatusTable } from "../../src/status.ts";
import { createViewer } from "../../src/viewer/server.ts";
import type { AddressInfo } from "node:net";
import {
	COMMAND_POST_EXTENSION,
	startPiChild,
	advanceBase,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	git,
	MockProvider,
	readFleet,
	readRunEvents,
	rebaseMergeAndDeleteHead,
	REPO_ROOT,
	type ScratchRepo,
	type ScriptStep,
	squashMergeAndDeleteHead,
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
	event?: string;
	triggering_actor?: { login: string };
}
interface Reply {
	untilFile?: string;
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

/** Merge `branch` on origin with a merge commit, then delete it, as a forge's "create a merge commit" does. */
function mergeAndDeleteHead(repo: ScratchRepo, branch: string): string {
	const clone = mkdtempSync(join(tmpdir(), "cp-merge-"));
	try {
		git(clone, "clone", "--quiet", repo.remote as string, "work");
		const work = join(clone, "work");
		git(work, "merge", "--no-ff", "--quiet", "-m", `merge ${branch}`, `origin/${branch}`);
		git(work, "push", "--quiet", "origin", "main");
		git(work, "push", "--quiet", "origin", "--delete", branch);
		return git(work, "rev-parse", "HEAD");
	} finally {
		rmSync(clone, { recursive: true, force: true });
	}
}

interface GitlabReply {
	status?: number;
	body: unknown;
}
/**
 * A local https GitLab: `/api/v4/.../merge_requests/<iid>` answers `mrs[iid]` and logs its PRIVATE-TOKEN; every other
 * path is `git http-backend` over `remote`, served as `/o/lab.git`. Callers skip TLS verification of its throwaway cert.
 */
async function startFakeGitlab(t: TestContext, remote: string) {
	const dir = mkdtempSync(join(tmpdir(), "cp-gitlab-"));
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key"), "-out", join(dir, "cert"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
	const mrs: Record<number, GitlabReply> = {};
	const asked: Array<{ path: string; token?: string }> = [];
	const server = createServer({ key: readFileSync(join(dir, "key")), cert: readFileSync(join(dir, "cert")) }, (req, res) => {
		const url = new URL(req.url ?? "/", "https://gitlab.test");
		const iid = /^\/api\/v4\/projects\/[^/]+\/merge_requests\/(\d+)$/.exec(url.pathname)?.[1];
		if (url.pathname.startsWith("/api/")) {
			asked.push({ path: url.pathname, ...(req.headers["private-token"] ? { token: String(req.headers["private-token"]) } : {}) });
			const reply = iid ? mrs[Number(iid)] : undefined;
			res.writeHead(reply?.status ?? (reply ? 200 : 404), { "content-type": "application/json" });
			res.end(JSON.stringify(reply?.body ?? { message: "404 Not found" }));
			return;
		}
		const cgi = spawn("git", ["http-backend"], {
			env: {
				...process.env, GIT_PROJECT_ROOT: dirname(remote), GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "e2e", REMOTE_ADDR: "127.0.0.1",
				PATH_INFO: url.pathname.replace(/^\/o\/lab\.git/, `/${basename(remote)}`), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? "GET",
				CONTENT_TYPE: req.headers["content-type"] ?? "", HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "", GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
			},
		});
		req.pipe(cgi.stdin);
		const chunks: Buffer[] = [];
		cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		cgi.on("close", () => {
			const out = Buffer.concat(chunks);
			const split = out.indexOf("\r\n\r\n");
			const headers = Object.fromEntries(out.subarray(0, split).toString().split("\r\n").map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
			const status = Number(/^\d+/.exec(headers.status ?? "200")?.[0]);
			delete headers.status;
			res.writeHead(status, headers);
			res.end(out.subarray(split + 4));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { web: `https://127.0.0.1:${(server.address() as { port: number }).port}`, mrs, asked };
}

/** Commit what `script` does to a fresh clone of origin's main, and push it there, as another job or a human would. */
function landOnOrigin(repo: ScratchRepo, script: string, message: string): string {
	const clone = mkdtempSync(join(tmpdir(), "cp-land-"));
	try {
		git(clone, "clone", "--quiet", repo.remote as string, "work");
		const work = join(clone, "work");
		execFileSync("bash", ["-c", script], { cwd: work });
		git(work, "add", "-A");
		git(work, "commit", "--quiet", "-m", message);
		git(work, "push", "--quiet", "origin", "main");
		return git(work, "rev-parse", "HEAD");
	} finally {
		rmSync(clone, { recursive: true, force: true });
	}
}

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
  while (r.untilFile && !existsSync(r.untilFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
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
  while (answer.untilFile && !existsSync(answer.untilFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
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
  const runs = all.filter((row) => row.head_sha.toLowerCase() === query("head_sha"));
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

/** Real CommandPost, workers and optional held continuation over a registered scratch project. */
async function startStack(t: TestContext, options: { project?: boolean; env?: Record<string, string>; continuation?: boolean } = {}) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/a.ts": "a1\n", "src/b.ts": "b1\n" } });
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
	const extraEnv = options.env ?? {};
	const savedEnv = Object.fromEntries(Object.keys(extraEnv).map((key) => [key, process.env[key]]));
	Object.assign(process.env, extraEnv);
	const bin = join(home.path, "bin");
	writeFakeGh(bin, stateFile, countsFile, logFile, join(home.path, LAYOUT.ciRerunsFile));
	const saved = { PATH: process.env.PATH, CP_CI_WATCH_SECONDS: process.env.CP_CI_WATCH_SECONDS };
	process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
	process.env.CP_CI_WATCH_SECONDS = "1";
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env }, holdsParentLock: () => true, continuation: options.continuation });
	t.after(async () => {
		process.env.PATH = saved.PATH;
		if (saved.CP_CI_WATCH_SECONDS === undefined) delete process.env.CP_CI_WATCH_SECONDS;
		else process.env.CP_CI_WATCH_SECONDS = saved.CP_CI_WATCH_SECONDS;
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await post.shutdown();
		await provider.stop();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
	});
	/** Register `name` with its own clone of the scratch remote; `cloneUrl` becomes the clone's origin when given. */
	const project = async (name: string, over: { cloneUrl?: string; forge?: ForgeConfig } = {}) => {
		await post.registry.register({ name, clone_url: over.cloneUrl ?? (repo.remote as string), delivery: "pr", ...(over.forge ? { forge: over.forge } : {}) });
		const clone = post.registry.pathOf(name);
		execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
		if (over.cloneUrl) execFileSync("git", ["-C", clone, "remote", "set-url", "origin", over.cloneUrl]);
		const pool = enableTreehouse(clone, { maxTrees: 4 });
		t.after(() => pool.cleanup());
	};
	if (options.project !== false) await project("demo");

	const remoteHead = (branch: string) =>
		execFileSync("git", ["ls-remote", repo.remote as string, `refs/heads/${branch}`], { encoding: "utf8" }).split("\t")[0]?.trim() ?? "";
	/** A fresh job whose implementer runs `command` (default: commit and push), reports and stands by; resolves once held. */
	const held = async (title: string, number: number, over: { delivery?: "local"; command?: (branch: string) => string; repair?: boolean } = {}) => {
		const job = await post.ledger().create({ title, project: "demo", delivery: over.delivery ?? "pr", kind: "ship" });
		const prUrl = `https://github.com/example/demo/pull/${number}`;
		const pr = over.delivery ? {} : { pr_url: prUrl };
		const report: ScriptStep = {
			kind: "tool_calls",
			calls: [{ name: "report_result", args: () => ({ job_id: job.id, kind: "ship", status: "done", summary: "Opened a PR.", branch: job.id, ...pr, head_sha: remoteHead(job.id) }) }],
		};
		const push = `git add -A && git commit -q -m v1 && git push -q -u origin ${job.id}`;
		const command = over.command?.(job.id) ?? `printf 'v1\\n' > change.txt && ${push}`;
		// A red head promotes the implementer once; it re-reports the same head, so the job is held again.
		const steps: ScriptStep[] = [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command } }] },
			report,
			{ kind: "text", text: "standing by" },
			...(over.repair ? [{ kind: "tool_calls" as const, calls: [{ name: "bash", args: { command: `git commit --quiet --allow-empty -m repair && git push --quiet origin ${job.id}` } }] }] : []),
			report,
			{ kind: "text", text: "standing by" },
		];
		const model = provider.addScript(`landing-${job.id}`, steps, { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		gh.prs[job.id] = { number, url: prUrl };
		setGh({});
		const dispatched = await post.dispatch({ jobId: job.id, task: "Change change.txt and open a PR.", model, fetch: false });
		assert.equal(dispatched.receipt, "accepted");
		const record = await waitFor(() => readFleet(home.path).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.phase === "held" && entry.reported_at !== undefined, {
			timeoutMs: 90_000,
			what: `${job.id} held after its envelope`,
		});
		return { jobId: job.id, head: remoteHead(job.id), prUrl, worktree: record?.worktree as string };
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
	/** A held fleet record with no worker or worktree (seeded legacy data): cp_merged reads the record and the clone. */
	const seed = async (title: string, over: { project?: string; prUrl?: string | false; branch?: string; bound?: boolean } = {}) => {
		const job = await post.ledger().create({ title, project: over.project ?? "demo", delivery: "pr", kind: "ship" });
		const prUrl = over.prUrl ?? `https://github.com/example/demo/pull/${50 + post.ledger().read().jobs.length}`;
		const now = isoTimestamp();
		await post.fleet.add({
			job_id: job.id, project: over.project ?? "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: now },
			worktree: join(home.path, "gone", job.id), branch: over.branch ?? job.id,
			...(prUrl ? { receipts: [{ kind: "pr" as const, status: "open", title: `PR for ${job.id}`, url: prUrl }] } : {}),
			...(over.bound && prUrl ? { bound_pr: { number: Number(prUrl.split("/").pop()), url: prUrl, base: "main" } } : {}),
		});
		return { jobId: job.id, prUrl: prUrl || undefined, branch: over.branch ?? job.id };
	};
	let parentSeq = 0;
	const parent = async (prompt: string, steps: ScriptStep[], settled?: () => Promise<void>, direct = false) => {
		const script = `landing-parent-${++parentSeq}`;
		const model = provider.addScript(script, steps, { onExhausted: "repeat" });
		// Recovery notices can request a turn before the operator's quote arrives.
		const startup = provider.addScript(`${script}-startup`, [{ kind: "text", text: "Startup notices observed." }], { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		const child = startPiChild({ cwd: home.path, model: direct ? model : startup, env: { ...agentDir.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			await child.prompt(prompt);
			if (!direct) {
				await waitFor(() => provider.requests(`${script}-startup`).some((request) => JSON.stringify(request.body.messages).includes(prompt.split("\n")[0]!)), Boolean, { timeoutMs: 90_000, what: "operator request reaches parent context" });
				await child.waitForSettled(90_000);
				const [providerId, modelId] = model.split("/");
				child.send({ id: script, type: "set_model", provider: providerId, modelId });
				const switched = await child.waitFor((event) => event.type === "response" && event.id === script);
				assert.equal(switched.success, true, JSON.stringify(switched));
				await child.prompt("Continue the operator request already in context.");
				await waitFor(() => provider.remaining(script), (remaining) => remaining === 0, { timeoutMs: 90_000, what: "operator script consumed" });
			}
			await child.waitForSettled(90_000);
			assert.equal(provider.remaining(script), 0);
			await settled?.();
			return child.eventsOfType("tool_execution_end");
		} finally {
			await child.close();
		}
	};
	return { home: home.path, remote: repo.remote as string, repo, post, provider, gh, setGh, held, seed, project, ghCalls, integrate, tick, parent, parentMessages: () => JSON.stringify(provider.requests().at(-1)?.body.messages ?? []) };
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

const MERGE = "b59fc3a1".repeat(5);
const deployJobs = (post: CommandPost, merged: string) => post.ledger().read().jobs.filter((job) => job.labels.includes(`after-merge:${merged}`));
const afterMergeRecord = (home: string, merged: string) => JSON.parse(readFileSync(join(home, paths.afterMergeFile(merged)), "utf8"));

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
	assert.notEqual(current.key, passed.key);
	assert.equal(s.post.ciWatch.store.job(live.jobId)?.last_ci, "green");
	assert.ok(readRunEvents(s.home, live.jobId).some((event) => event.type === "ci_observed"));
	assert.deepEqual(mergedCalls(s.ghCalls()), [], "observing CI does not merge");
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
		await observe([own(tip, "failure"), run(109, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" } })]);
		assert.deepEqual(rows().map((row) => [row.project, row.red_since_sha, row.login, row.workflow, row.failing]), [["demo", tip, "e2e", "ci", "main regression"]]);
		const latched = readFileSync(file, "utf8");
		await observe([own(tip, "failure")]);
		assert.equal(readFileSync(file, "utf8"), latched, "repeat red preserves the original latch bytes");
		await waitFor(s.parentMessages, (body) => body.includes("MAIN IS RED"), { timeoutMs: 30_000, what: "main red wake reaches parent provider" });
		assert.equal(s.parentMessages().split("MAIN IS RED").length - 1, 1, "repeat red emits one parent wake");
		assert.ok(s.parentMessages().includes(`MAIN IS RED — demo: CI failed on ${tip.slice(0, 12)} (ci) — failing: main regression`));
		assert.ok(s.parentMessages().includes("cp_integrate returns wait for every demo PR except one based on the current main with green CI"));
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
		await waitFor(s.parentMessages, (body) => body.includes("MAIN CI LATCH RELEASED"), { timeoutMs: 30_000, what: "legacy release reaches parent" });
		const foreign = JSON.parse(cleared);
		foreign.projects = [{ project: "demo", red_since_sha: oldTip, red_since_at: isoTimestamp(), login: "other" }];
		writeFileSync(file, JSON.stringify(foreign));
		await observe([run(109, tip, "in_progress", null, { event: "push", triggering_actor: { login: "e2e" } })]);
		assert.deepEqual(rows(), [], "foreign latch releases on inconclusive main CI");
		await waitFor(s.parentMessages, (body) => body.includes(`MAIN CI LATCH RELEASED — demo: red since ${oldTip.slice(0, 12)} no longer counts (latched for other, this machine is e2e). Call cp_integrate for held demo PRs.`), { timeoutMs: 30_000, what: "foreign release notice reaches parent" });
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
		assert.deepEqual(rows().map((row) => row.project), ["other"], "infra rerun does not latch demo");
		await observe([{ ...own(tip, "failure"), run_attempt: 2 }], { jobs: { 106: [setupJob("Install treehouse")] } });
		assert.equal(rows().find((row) => row.project === "demo")?.red_since_sha, tip, "second infra failure latches main");
		assert.equal(s.ghCalls().filter((call) => call === "run rerun 106 --failed").length, 1, "attempt two never reruns again");
		assert.ok(s.ghCalls().includes("api repos/{owner}/{repo}/actions/runs/106/attempts/2/jobs?per_page=100&page=1"));
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
		await waitFor(loginCalls, (count) => count >= beforeFault + 2, { timeoutMs: 30_000, what: "failed login is retried by next tick" });
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
	await manual;
	s.setGh({ routes: [] });
	const repaired = await waitFor(() => s.post.fleet.get(live.jobId), (record) => record?.phase === "held" && (record.supersessions ?? 0) === 1, { timeoutMs: 60_000, what: "same worker repair and second envelope" });
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.deepEqual([repaired?.worker.pid, repaired?.worker.session_id, repaired?.branch, repaired?.worktree], [identity.worker.pid, identity.worker.session_id, identity.branch, identity.worktree]);
	assert.equal(holds.get(live.jobId)?.reason, "QA in progress");
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
	await s.parent("Inspect held repair after restarting the parent.", [{ kind: "text", text: "Startup observed." }]);
	assert.equal(s.post.integrator.get(live.jobId)?.next, "wait", "startup preserves green held repair");
	assert.equal(s.post.integrator.get(live.jobId)?.resolve_attempts, 1, "startup preserves cumulative allowance");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	assert.equal(new CheckpointStore(s.home, { kind: "merge" }).list().length, 0);
	assert.equal(new AwaitingStore({ home: s.home }).list().length, 0);
	holds.release(live.jobId);
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "review", "release still requires review of the repaired head");
	holds.hold(live.jobId, "QA in progress");
	s.setGh({ runs: [run(112, head, "completed", "failure", { run_attempt: 2 })] });
	await s.parent("Inspect the repaired head's failing CI after restart.", [{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId, action: "advance" } }] }, { kind: "text", text: "Restarted parent checked CI." }]);
	assert.match(s.post.integrator.get(live.jobId)?.reason ?? "", /already asked once/, "restarted parent reads the spent allowance before looking for a local worker");
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "surface", "a second red result exhausts the repair allowance");
	assert.equal(s.post.fleet.require(live.jobId).supersessions, 1, "no second promotion");
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
		if (!permitted) await s.post.manager.shutdownAll();
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
