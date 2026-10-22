/** Shared fixtures for the landing e2e files: scripted `gh`, a local GitLab, and a real CommandPost stack. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import type { ForgeConfig } from "../../src/forge-url.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { COMMAND_POST_EXTENSION, startPiChild, createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, git, MockProvider, readFleet, REPO_ROOT, type ScratchRepo, type ScriptStep, treehouseAvailable, waitFor } from "../harness/index.ts";

export const SKIP = treehouseAvailable() ? false : "the landing e2e needs treehouse on PATH";
export const CANARY = "ghp_canary0123456789";

export interface RunRow {
	id?: number;
	run_attempt: number | string;
	head_sha: string;
	status: string | number | null;
	conclusion: string | null;
	name: string;
	html_url?: string;
	event?: string;
	triggering_actor?: { login: string };
}
export interface Reply {
	untilFile?: string;
	code?: number | "signal";
	stdout?: string;
	stderr?: string;
	/** Answer as if no route matched. */
	pass?: boolean;
}
/** Replies in order to every call whose joined args contain `match`; the last reply repeats. */
export interface Route {
	match: string;
	replies: Reply[];
}
export interface GhState {
	prs: Record<string, { number: number; url: string }>;
	runs: RunRow[];
	/** Attempt jobs by run id; absent: one job mirroring the run, with one `npm test` step. */
	jobs?: Record<string, Array<Record<string, unknown>>>;
	/** Page 2 onward starts this many rows early: a boundary shift that repeats the previous page's last run. */
	overlap?: number;
	routes?: Route[];
	integration?: boolean;
	permission?: string | null;
	merged?: Record<string, { head: string; commit: string }>;
}

export function run(id: number, head: string, status: string | null, conclusion: string | null, over: Partial<RunRow> = {}): RunRow {
	return { id, run_attempt: 1, head_sha: head, status, conclusion, name: "ci", ...over };
}
export const json = (value: unknown): Reply => ({ stdout: JSON.stringify(value) });
export const runsBody = (rows: unknown[], total = rows.length) => json({ total_count: total, workflow_runs: rows });
export const setupJob = (failedStep: string, conclusion = "failure") => {
	const names = ["Set up job", "Checkout", "Set up Node", "Install dependencies", "Install treehouse", "Run suite (typecheck + tests)", "Eval contract check"];
	const at = names.indexOf(failedStep);
	const steps = names.map((name, index) => ({ name, status: "completed", conclusion: index < at ? "success" : index === at ? "failure" : "skipped" }));
	return { id: 1, name: "suite", status: "completed", conclusion, steps };
};

/** Merge `branch` on origin with a merge commit, then delete it, as a forge's "create a merge commit" does. */
export function mergeAndDeleteHead(repo: ScratchRepo, branch: string): string {
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

export interface GitlabReply {
	status?: number;
	body: unknown;
	raw?: string;
	headers?: Record<string, string>;
}
/**
 * A local https GitLab: `/api/v4/.../merge_requests/<iid>` answers `mrs[iid]` and logs its PRIVATE-TOKEN; every other
 * path is `git http-backend` over `remote`, served as `/o/lab.git`. Callers skip TLS verification of its throwaway cert.
 */
export async function startFakeGitlab(t: TestContext, remote: string) {
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
			res.writeHead(reply?.status ?? (reply ? 200 : 404), { "content-type": "application/json", ...reply?.headers });
			res.end(reply?.raw ?? JSON.stringify(reply?.body ?? { message: "404 Not found" }));
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
export function landOnOrigin(repo: ScratchRepo, script: string, message: string): string {
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
export function writeFakeGh(bin: string, stateFile: string, countsFile: string, logFile: string, claimsFile: string): void {
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
if (args[0] === "pr" && args[1] === "list") {
  const branch = args[args.indexOf("--head") + 1];
  const pr = state.prs[branch];
  out(pr ? [{ ...pr, headRefOid: heads()[branch] }] : []);
}
if (args[0] === "pr" && args[1] === "view") {
  const branch = branchOf[args[2]] || (state.prs[args[2]] ? args[2] : undefined);
  if (branch && state.merged && state.merged[branch]) {
    const merged = state.merged[branch];
    out({ number: state.prs[branch].number, url: state.prs[branch].url, state: "MERGED", headRefName: branch, headRefOid: merged.head, baseRefName: "main", mergedAt: new Date().toISOString(), mergeCommit: { oid: merged.commit } });
  }
  if (branch) out({ number: state.prs[branch].number, url: state.prs[branch].url, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: state.permission === null ? undefined : state.permission || "CLEAN",
    headRefName: branch, headRefOid: heads()[branch], baseRefName: "main", isDraft: false, autoMergeRequest: null });
}
if (state.integration && args[0] === "api" && path.includes("/rules/branches/")) out([]);
if (state.integration && args[0] === "pr" && args[1] === "update-branch") {
  const branch = branchOf[args[args.length - 1]];
  execFileSync("git", ["fetch", "--quiet", "origin", "main", branch]);
  execFileSync("git", ["checkout", "--quiet", "--detach", "origin/" + branch]);
  // shortcut: merge main to model a changed forge head; use a rebase fixture if ancestry shape becomes acceptance.
  execFileSync("git", ["merge", "--no-edit", "--quiet", "origin/main"]);
  execFileSync("git", ["push", "--quiet", "origin", "HEAD:refs/heads/" + branch]);
  execFileSync("git", ["checkout", "--quiet", "main"]);
  reply({});
}
if (state.integration && args[0] === "pr" && args[1] === "merge") {
  const branch = branchOf[args[2]];
  const head = heads()[branch];
  const bound = args[args.indexOf("--match-head-commit") + 1];
  if (args.includes("--match-head-commit") && bound !== head) reply({ code: 1, stderr: "Head branch was modified" });
  execFileSync("git", ["fetch", "--quiet", "origin", "main", branch]);
  execFileSync("git", ["checkout", "--quiet", "main"]);
  execFileSync("git", ["merge", "--ff-only", "--quiet", "origin/main"]);
  execFileSync("git", ["merge", "--squash", "--quiet", "origin/" + branch]);
  execFileSync("git", ["commit", "--quiet", "-m", "forge squash"]);
  execFileSync("git", ["push", "--quiet", "origin", "main"]);
  state.merged = { ...(state.merged || {}), [branch]: { head, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() } };
  writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  reply({});
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
export async function startStack(t: TestContext, options: { project?: boolean; env?: Record<string, string>; continuation?: boolean; packageRoot?: string; github?: boolean } = {}) {
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
	const post = new CommandPost({ home: home.path, packageRoot: options.packageRoot ?? REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env }, holdsParentLock: () => true, continuation: options.continuation });
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
	if (options.project !== false) await project("demo", options.github ? { cloneUrl: "https://github.com/example/demo" } : {});
	if (options.github) {
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const shim = join(bin, "git");
		writeFileSync(shim, `#!/usr/bin/env node\nconst { spawnSync } = require("child_process");\nconst args = process.argv.slice(2);\nconst result = spawnSync(${JSON.stringify(realGit)}, [...(args.includes("get-url") ? [] : ["-c", ${JSON.stringify(`url.${repo.remote}.insteadOf=https://github.com/example/demo`)}]), ...args], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`);
		chmodSync(shim, 0o755);
	}

	const remoteHead = (branch: string) =>
		execFileSync("git", ["ls-remote", repo.remote as string, `refs/heads/${branch}`], { encoding: "utf8" }).split("\t")[0]?.trim() ?? "";
	/** A fresh job whose implementer runs `command` (default: commit and push), reports and stands by; resolves once held. */
	const held = async (title: string, number: number, over: { delivery?: "local"; command?: (branch: string) => string; repair?: boolean; repairGate?: string; before?: string[]; reportUrl?: string; refusal?: RegExp } = {}) => {
		const job = await post.ledger().create({ title, project: "demo", delivery: over.delivery ?? "pr", kind: "ship" });
		const prUrl = `https://github.com/example/demo/pull/${number}`;
		const pr = over.delivery ? {} : { pr_url: over.reportUrl ?? prUrl };
		const report: ScriptStep = {
			kind: "tool_calls",
			calls: [{ name: "report_result", args: () => ({ job_id: job.id, kind: "ship", status: "done", summary: "Opened a PR.", branch: job.id, ...pr, head_sha: remoteHead(job.id) }) }],
		};
		const push = `git add -A && git commit -q -m v1 && git push -q -u origin ${job.id}`;
		const command = over.command?.(job.id) ?? `printf 'v1\\n' > change.txt && ${push}`;
		// A red head promotes the implementer once; it re-reports the same head, so the job is held again.
		const steps: ScriptStep[] = [
			...(over.before ?? []).map((command): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command } }] })),
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command } }] },
			report,
			{ kind: "text", text: "standing by" },
			...(over.repairGate ? [{ kind: "tool_calls" as const, calls: [{ name: "bash", args: { command: `node -e 'const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(over.repairGate + ".entered")},"entered"); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(over.repairGate)})){clearInterval(timer)}},100)'` } }] }] : []),
			...(over.repair ? [{ kind: "tool_calls" as const, calls: [{ name: "bash", args: { command: `git commit --quiet --allow-empty -m repair && git push --quiet origin ${job.id}` } }] }] : []),
			...(over.refusal ? [] : [report]),
			{ kind: "text", text: "standing by" },
			...(over.repairGate ? [report, { kind: "text" as const, text: "standing by" }] : []),
		];
		const model = provider.addScript(`landing-${job.id}`, steps, { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		gh.prs[job.id] = { number, url: prUrl };
		setGh({});
		const dispatched = await post.dispatch({ jobId: job.id, task: "Change change.txt and open a PR.", model, fetch: false });
		assert.equal(dispatched.receipt, "accepted");
		const record = await waitFor(() => readFleet(home.path).jobs.find((entry) => entry.job_id === job.id), (entry) => over.refusal ? entry?.envelope_correction !== undefined || entry?.phase === "held" : entry?.phase === "held" && entry.reported_at !== undefined, {
			timeoutMs: 90_000,
			what: `${job.id} held after its envelope`,
		});
		if (over.refusal) {
			assert.match(record?.envelope_correction?.reason ?? "", over.refusal);
			assert.equal(record?.reported_at, undefined);
			assert.equal(record?.phase, "waiting");
		}
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
	const parent = async (prompt: string, steps: ScriptStep[], settled?: (events: unknown[], stderr: () => string, child: ReturnType<typeof startPiChild>) => Promise<void>, direct = false) => {
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
			await settled?.(child.eventsOfType("tool_execution_end"), () => `${child.stderr()}\n${JSON.stringify(child.records())}`, child);
			return child.eventsOfType("tool_execution_end");
		} finally {
			await child.close();
		}
	};
	return { home: home.path, remote: repo.remote as string, repo, post, provider, agentDir, gh, setGh, held, seed, project, ghCalls, integrate, tick, parent, parentMessages: () => JSON.stringify(provider.requests().at(-1)?.body.messages ?? []) };
}

export const mergedCalls = (calls: string[]) => calls.filter((call) => call.startsWith("pr merge"));
export const MERGE = "b59fc3a1".repeat(5);
export const deployJobs = (post: CommandPost, merged: string) => post.ledger().read().jobs.filter((job) => job.labels.includes(`after-merge:${merged}`));
export const afterMergeRecord = (home: string, merged: string) => JSON.parse(readFileSync(join(home, paths.afterMergeFile(merged)), "utf8"));
