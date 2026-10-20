/**
 * Behavior 01 (docs/testing-migration.md): a red CI fact names exactly the current head's failing run — in the CI
 * watch wake, the held continuation's cp_integrate record and the promote. Real CommandPost, workers, git; fake gh.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { formatCiNotice, type CiObservation } from "../../src/ci-watch.ts";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
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

const SKIP = treehouseAvailable() ? false : "the ci-evidence e2e needs treehouse on PATH";
const OLD = `0123456789ab${"b".repeat(28)}`;

interface RunRow {
	id?: number;
	run_attempt: number;
	/** A literal sha, or `HEAD` for whatever the branch's pushed head is when gh is asked. */
	head_sha: string;
	status: string;
	conclusion: string | null;
	name: string;
}
interface GhJob {
	number: number;
	url: string;
	omitHead?: boolean;
	runs: RunRow[];
	branchRuns?: RunRow[];
}
type GhState = Record<string, GhJob>;

function run(id: number | undefined, head: string, status: string, conclusion: string | null, name = "ci"): RunRow {
	return { ...(id === undefined ? {} : { id }), run_attempt: 1, head_sha: head, status, conclusion, name };
}

/** A `gh` serving PR views, REST pulls and Actions runs/jobs per branch from `state`; anything else exits 1. */
function writeFakeGh(bin: string, stateFile: string, logFile: string): void {
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node
const { execFileSync } = require("child_process");
const { appendFileSync, readFileSync } = require("fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const heads = {};
for (const line of execFileSync("git", ["ls-remote", "--heads", "origin"], { encoding: "utf8" }).split("\\n")) {
  const [sha, ref] = line.split("\\t");
  if (sha && ref) heads[ref.replace("refs/heads/", "")] = sha;
}
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const rows = (branch, list) => (list || []).map((row) => ({ ...row, head_sha: row.head_sha === "HEAD" ? heads[branch] : row.head_sha }));
const all = Object.entries(state).flatMap(([branch, job]) => rows(branch, job.runs));
const path = args[1] || "";
if (args[0] === "pr" && args[1] === "view") {
  const hit = Object.entries(state).find(([branch, job]) => job.url === args[2] || branch === args[2]);
  if (hit) {
    const [branch, job] = hit;
    out({ number: job.number, ...(args[2].startsWith("https://") ? { url: args[2] } : {}), state: "OPEN",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: branch, headRefOid: job.omitHead ? "" : heads[branch],
      baseRefName: "main", isDraft: false, autoMergeRequest: null });
  }
}
if (args[0] === "api" && /\\/pulls\\/\\d+$/.test(path)) {
  const number = Number(path.split("/pulls/")[1]);
  const hit = Object.entries(state).find(([, job]) => job.number === number);
  if (hit) out({ number, html_url: hit[1].url, state: "open", merged: false, head: { ...(hit[1].omitHead ? {} : { sha: heads[hit[0]] }), ref: hit[0] } });
}
if (args[0] === "api" && path.includes("/actions/runs?head_sha=")) {
  const sha = path.split("head_sha=")[1].slice(0, 40);
  const runs = all.filter((row) => row.head_sha === sha);
  out({ total_count: runs.length, workflow_runs: runs });
}
if (args[0] === "api" && path.includes("/actions/runs?branch=")) {
  const branch = decodeURIComponent(path.split("branch=")[1].split("&")[0]);
  const runs = rows(branch, (state[branch] || {}).branchRuns);
  out({ total_count: runs.length, workflow_runs: runs });
}
const jobs = /\\/actions\\/runs\\/(\\d+)\\/attempts\\/(\\d+)\\/jobs\\?/.exec(path);
if (args[0] === "api" && jobs) {
  const row = all.find((entry) => entry.id === Number(jobs[1]));
  const list = row ? [{ id: row.id * 10, run_id: row.id, run_attempt: Number(jobs[2]), name: "test", status: row.status,
    conclusion: row.conclusion, steps: [{ name: "npm test", status: row.status, conclusion: row.conclusion }] }] : [];
  out({ total_count: list.length, jobs: list });
}
process.stderr.write("unexpected gh " + args.join(" ") + "\\n");
process.exit(1);
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
}

/** Real CommandPost (continuation on) over a registered scratch project, treehouse pool and the scripted `gh`. */
async function startStack(t: TestContext) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const reviewer = provider.addScript("ci-evidence-review", [{ kind: "hang" }]);
	agentDir.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.data, "routing.json"),
		JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }),
	);
	const stateFile = join(home.path, "gh-state.json");
	const logFile = join(home.path, "gh-calls.log");
	const gh: GhState = {};
	const setGh = (branch: string, job: GhJob) => {
		gh[branch] = job;
		writeFileSync(stateFile, JSON.stringify(gh));
	};
	writeFileSync(stateFile, "{}");
	const bin = join(home.path, "bin");
	writeFakeGh(bin, stateFile, logFile);
	const saved = { PATH: process.env.PATH, CP_CI_WATCH_SECONDS: process.env.CP_CI_WATCH_SECONDS };
	process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
	process.env.CP_CI_WATCH_SECONDS = "1";
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		continuation: true,
		holdsParentLock: () => true,
	});
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
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 4 });
	t.after(() => pool.cleanup());

	const remoteHead = (branch: string) =>
		execFileSync("git", ["ls-remote", repo.remote as string, `refs/heads/${branch}`], { encoding: "utf8" }).split("\t")[0]?.trim() ?? "";
	const report = (jobId: string, prUrl: string): ScriptStep => ({
		kind: "tool_calls",
		calls: [{ name: "report_result", args: () => ({ job_id: jobId, kind: "ship", status: "done", summary: "Changed and opened a PR.", branch: jobId, pr_url: prUrl, head_sha: remoteHead(jobId) }) }],
	});
	const push = (jobId: string, content: string): ScriptStep => ({
		kind: "tool_calls",
		calls: [{ name: "bash", args: { command: `printf '${content}\\n' > change.txt && git add -A && git commit -q -m '${content}' && git push -q -u origin ${jobId}` } }],
	});
	/** One implementer script for a fresh ledger job; `after(jobId)` are the steps it takes once promoted. */
	const ship = async (title: string, prUrl: string, after: (jobId: string) => ScriptStep[] = () => []) => {
		const job = await post.ledger().create({ title, project: "demo", delivery: "pr", kind: "ship" });
		const script = `ci-evidence-${job.id}`;
		const steps = [push(job.id, "v1"), report(job.id, prUrl), ...after(job.id), { kind: "text", text: "standing by" } as ScriptStep];
		const model = provider.addScript(script, steps, { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		return { jobId: job.id, script, model };
	};
	const dispatch = async (jobId: string, model: string) => {
		const dispatched = await post.dispatch({ jobId, task: "Change change.txt and open a PR.", model, fetch: false });
		assert.equal(dispatched.receipt, "accepted");
		await waitFor(() => readFleet(home.path).jobs.find((job) => job.job_id === jobId), (job) => job?.phase === "held" && job.reported_at !== undefined, {
			timeoutMs: 90_000,
			what: `${jobId} held after its envelope`,
		});
	};
	/** CI watch ticks (the extension timer's call) until `jobId` was checked; its observations for that job. */
	const tickUntilChecked = async (jobId: string, what: string) => {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const tick = await post.ciTick();
			if (tick.checked.includes(jobId)) return { tick, observations: tick.observations.filter((o) => o.job_id === jobId) };
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		assert.fail(`the CI watch never checked ${jobId} (${what})`);
	};
	type Integration = NonNullable<ReturnType<typeof post.integrator.get>>;
	const integration = async (jobId: string, ok: (record: Integration) => boolean, what: string): Promise<Integration> =>
		(await waitFor(() => post.integrator.get(jobId), (record) => record !== undefined && ok(record), { timeoutMs: 90_000, what })) as Integration;
	const promptsTo = (script: string) => provider.requests(script).map((request) => JSON.stringify(request.body.messages ?? []));
	const ghCalls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []);
	return { post, setGh, ship, push, report, dispatch, remoteHead, tickUntilChecked, integration, promptsTo, ghCalls };
}

/** Every `(run N` reference in `text`, in order. */
function runRefs(text: string): string[] {
	return [...text.matchAll(/\(run (\d+)/g)].map((match) => match[1] as string);
}

function ciFact(record: { facts: readonly string[] }): string {
	const fact = record.facts.find((entry) => entry.startsWith("ci: "));
	assert.ok(fact, `no ci: fact in ${JSON.stringify(record.facts)}`);
	return fact;
}

function assertNoRunLink(text: string, what: string): void {
	assert.doesNotMatch(text, /actions\/runs\//, `${what} fabricated an Actions run link`);
}

test(
	"ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const stack = await startStack(t);
		const prUrl = "https://github.com/example/demo/pull/61";
		const exact = "(run 6 https://github.com/example/demo/actions/runs/6)";
		const { jobId, script, model } = await stack.ship("red, then fixed", prUrl, (id) => [stack.push(id, "v2"), stack.report(id, prUrl)]);

		// No run on the pushed head yet; the branch's only failure is on an older sha (wrong head).
		stack.setGh(jobId, { number: 61, url: prUrl, runs: [], branchRuns: [run(1, OLD, "completed", "failure")] });
		await stack.dispatch(jobId, model);
		const h1 = stack.remoteHead(jobId);
		const superseded = await stack.integration(jobId, (r) => r.head_sha === h1 && r.facts.some((f) => f.startsWith("ci: ")), "the envelope's CI read");
		assert.match(ciFact(superseded), /^ci: superseded/);
		assert.equal(superseded.next, "wait");
		assert.deepEqual(runRefs([...superseded.facts, superseded.reason].join("\n")), []);
		assert.deepEqual((await stack.tickUntilChecked(jobId, "wrong-head failure only")).observations, []);

		// Green conclusions (skipped, neutral, success) plus one unfinished run: nothing is failing yet.
		const green = [run(2, h1, "completed", "skipped", "lint"), run(3, h1, "completed", "neutral", "docs"), run(4, h1, "completed", "success")];
		stack.setGh(jobId, { number: 61, url: prUrl, runs: [...green, run(5, h1, "in_progress", null, "e2e")] });
		const unfinished = await stack.post.integrate({ jobId });
		assert.match(ciFact(unfinished), /^ci: in_progress/);
		assert.equal(unfinished.next, "wait");
		assert.deepEqual(runRefs([...unfinished.facts, unfinished.reason].join("\n")), []);
		assert.deepEqual((await stack.tickUntilChecked(jobId, "unfinished run")).observations, []);

		// The unfinished run passes and run 6 fails on h1; run 8 (on whatever head is pushed) is the fix's green run.
		stack.setGh(jobId, {
			number: 61,
			url: prUrl,
			runs: [...green, run(5, h1, "completed", "success", "e2e"), run(6, h1, "completed", "failure"), run(8, "HEAD", "completed", "success")],
		});
		const red = await stack.tickUntilChecked(jobId, "current failure");
		assert.equal(red.observations.length, 1, JSON.stringify(red.observations));
		const failed = red.observations[0] as CiObservation;
		assert.deepEqual([failed.event, failed.head_sha, failed.run_id, failed.run_url], ["ci_failed", h1, 6, "https://github.com/example/demo/actions/runs/6"]);
		const wake = formatCiNotice(red.observations);
		assert.ok(wake.includes(exact), wake);
		assert.deepEqual(runRefs(wake), ["6"]);
		const refused = await stack.integration(jobId, (r) => r.head_sha === h1 && r.next === "resolve", "the continuation's CI-failed refusal");
		assert.ok(ciFact(refused).endsWith(exact), ciFact(refused));
		assert.deepEqual(runRefs([...refused.facts, refused.reason].join("\n")), ["6"]);
		const promote = await waitFor(() => stack.promptsTo(script).find((p) => p.includes(exact)), Boolean, { timeoutMs: 60_000, what: "the promote naming run 6" });
		assert.deepEqual([...new Set(runRefs(promote as string))], ["6"]);

		// The promoted implementer pushes a fix: run 6 is now on a superseded head, and nothing may still name it.
		const h2 = await waitFor(() => stack.remoteHead(jobId), (sha) => sha !== h1, { timeoutMs: 60_000, what: "the fix push" });
		const fixed = await stack.integration(jobId, (r) => r.head_sha === h2 && r.facts.some((f) => f.startsWith("ci: ")), "the fixed head's CI read");
		assert.match(ciFact(fixed), /^ci: green/);
		assert.deepEqual(runRefs([...fixed.facts, fixed.reason].join("\n")), []);
		const after = await stack.tickUntilChecked(jobId, "fixed head");
		assert.deepEqual(after.observations.map((o) => [o.event, o.head_sha, o.run_id, o.run_url]), [["ci_green", h2, undefined, undefined]]);
		assert.deepEqual(runRefs(formatCiNotice(after.observations)), []);
		assert.equal(stack.ghCalls().some((args) => args[0] === "pr" && args[1] === "merge"), false, "a red or unreviewed head was merged");
	},
);

test(
	"ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const stack = await startStack(t);
		const gheUrl = "https://ghe.example.com/example/demo/pull/71";
		const branchUrl = "https://github.com/example/demo/pull/72";
		const enterprise = await stack.ship("enterprise-host PR", gheUrl);
		const byBranch = await stack.ship("branch-name PR ref", branchUrl);
		stack.setGh(enterprise.jobId, { number: 71, url: gheUrl, omitHead: true, runs: [] });
		stack.setGh(byBranch.jobId, { number: 72, url: branchUrl, omitHead: true, runs: [] });
		await stack.dispatch(enterprise.jobId, enterprise.model);
		await stack.dispatch(byBranch.jobId, byBranch.model);

		// Absent head: gh names no head commit, so there is no head to read CI for, let alone blame a run on.
		for (const jobId of [enterprise.jobId, byBranch.jobId]) {
			const noHead = await stack.integration(jobId, (r) => r.facts.some((f) => f.includes("no head commit")), `${jobId}: the envelope's no-head read`);
			assert.equal(noHead.next, "retry");
			assert.deepEqual(runRefs([...noHead.facts, noHead.reason].join("\n")), []);
		}

		// A PR ref that is a branch name, not a URL: the failing run is named by id alone.
		stack.setGh(byBranch.jobId, { number: 72, url: branchUrl, runs: [run(17, "HEAD", "completed", "failure")] });
		const named = await stack.post.integrate({ jobId: byBranch.jobId, pr: byBranch.jobId });
		assert.equal(named.next, "resolve");
		assert.ok(ciFact(named).endsWith("(run 17)"), ciFact(named));
		assertNoRunLink([...named.facts, named.reason].join("\n"), "a branch-name PR ref");
		const branchPromote = await waitFor(() => stack.promptsTo(byBranch.script).find((p) => p.includes("(run 17)")), Boolean, { timeoutMs: 60_000, what: "the promote naming run 17" });
		assertNoRunLink(branchPromote as string, "the branch-name promote");

		// A completed failing run without an id is malformed Actions data: unreadable, never a reference.
		stack.setGh(enterprise.jobId, { number: 71, url: gheUrl, runs: [run(undefined, "HEAD", "completed", "failure")] });
		const noId = await stack.post.integrate({ jobId: enterprise.jobId });
		assert.equal(noId.next, "retry");
		assert.match(noId.reason, /could not read CI/);
		assert.deepEqual(runRefs([...noId.facts, noId.reason].join("\n")), []);
		const unreadable = await stack.tickUntilChecked(enterprise.jobId, "run without id");
		assert.deepEqual(unreadable.observations, []);
		assert.ok(unreadable.tick.errors.some((error) => error.job_id === enterprise.jobId), JSON.stringify(unreadable.tick.errors));

		// An enterprise host: the wake, the continuation's refusal and its promote name run 16 with no github.com link.
		stack.setGh(enterprise.jobId, { number: 71, url: gheUrl, runs: [run(16, "HEAD", "completed", "failure")] });
		const red = await stack.tickUntilChecked(enterprise.jobId, "enterprise failure");
		assert.deepEqual(red.observations.map((o) => [o.event, o.run_id, o.run_url]), [["ci_failed", 16, undefined]]);
		const wake = formatCiNotice(red.observations);
		assert.ok(wake.includes("(run 16)"), wake);
		assertNoRunLink(wake, "the enterprise wake");
		const refused = await stack.integration(enterprise.jobId, (r) => r.next === "resolve", "the enterprise CI-failed refusal");
		assert.ok(ciFact(refused).endsWith("(run 16)"), ciFact(refused));
		assertNoRunLink([...refused.facts, refused.reason].join("\n"), "the enterprise refusal");
		const promote = await waitFor(() => stack.promptsTo(enterprise.script).find((p) => p.includes("(run 16)")), Boolean, { timeoutMs: 60_000, what: "the promote naming run 16" });
		assertNoRunLink(promote as string, "the enterprise promote");
		assert.equal(stack.ghCalls().some((args) => args[0] === "pr" && args[1] === "merge"), false, "a red head was merged");
	},
);
