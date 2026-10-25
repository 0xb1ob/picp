/**
 * Behavior 04 (P8c, 04-14..04-17): the spawn cap's gate-reviewer reserve, a silent settle's bounded recovery and the
 * report nudge, driven through a real CommandPost, real pi workers on a treehouse pool and the mock provider.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { FleetRecordSchema, LAYOUT, type MergeReceipt, MINIMAL_PLAN_SUMMARY, paths, SCHEMA_VERSION, validate } from "../../src/contracts.ts";
import { isGateWait } from "../../src/gate.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { formatSettleOutcome, REPORT_NUDGE_TEXT, type SettleOutcome } from "../../src/settle.ts";
import { formatStatusTable } from "../../src/status.ts";
import { assembleStatusBlock } from "../../src/status-block.ts";
import { jobState } from "../../src/status-render.ts";
import { renderFleetWidget } from "../../src/widget.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	REPO_ROOT,
	readRunEvents,
	readRunStatus,
	type RecordedRequest,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "worker-lifecycle-p8c e2e needs treehouse on PATH";

function verdict(jobId: string): ScriptStep {
	return { kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["plan is concrete"],
	} }] };
}

test("P8c reserve: held authors at the spawn cap refuse another author, yet gate reviewers start until the reserve is full and a closed reviewer frees it", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [] }));
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 5 });
	let release = (): void => {};
	t.after(async () => {
		release();
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	const authors: string[] = [];
	for (const slug of ["r1", "r2", "r3"]) {
		const jobId = (await post.ledger().create({ title: slug, project: "demo", delivery: "local", kind: "research", slug })).id;
		const model = provider.addScript(`plan-${slug}`, [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf '# Goal\\n${slug}\\n' > "$CP_ARTIFACT_PATH"` } }] },
			{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: jobId, kind: "research", status: "done", summary: "Plan written.",
				artifact_path: post.artifacts.file(jobId), plan_summary: MINIMAL_PLAN_SUMMARY,
				self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false } } }] },
			{ kind: "text", text: "Reported." },
		], { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		await post.dispatch({ jobId, task: `Plan ${slug}.`, model, fetch: false });
		authors.push(jobId);
	}
	const [r1, r2, r3] = authors as [string, string, string];
	const held = new Promise<void>((resolve) => (release = resolve));
	const gateR1 = provider.addScript("gate-r1", [{ kind: "hang", until: held }, verdict(r1)], { onExhausted: "repeat" });
	const gateR2 = provider.addScript("gate-r2", [verdict(r2)], { onExhausted: "repeat" });
	const freshModel = provider.addScript("fresh", [{ kind: "text", text: "never" }]);
	agentDir.writeModels(provider);
	for (const jobId of authors) await waitFor(() => post.fleet.require(jobId).phase, (phase) => phase === "held", { timeoutMs: 60_000, what: `${jobId} held` });
	assert.deepEqual(authors.map((jobId) => post.manager.get(jobId) !== undefined), [true, true, true], "held planners keep their process");

	writeFileSync(join(home.path, LAYOUT.budgetsFile), JSON.stringify({ schema_version: 1, per_job_tokens: 1_000_000, per_job_cost_usd: 3, warn_ratio: 0.8, spawn_cap: 1 }));
	const fresh = (await post.ledger().create({ title: "fresh", project: "demo", delivery: "local", kind: "ship", slug: "fresh" })).id;
	await assert.rejects(post.dispatch({ jobId: fresh, task: "More work.", model: freshModel, fetch: false }),
		/spawn cap reached \(3\/1 workers\).*Three extra slots are reserved for gate-reviewer/, "an author never takes the reserve");

	const first = await post.gate({ jobId: r1, model: gateR1 });
	assert.ok(isGateWait(first), JSON.stringify(first));
	assert.ok(post.manager.get(first.key), "a gate reviewer starts past the authors' cap");

	const full = await post.gate({ jobId: r2, model: gateR2 });
	assert.equal(isGateWait(full), false, "no reviewer past the reserve");
	const refusal = JSON.parse(readFileSync(join(home.path, paths.gateFile(r2, 1)), "utf8")) as { cause: string; reasons: string[] };
	assert.equal(refusal.cause, "operational");
	assert.match(refusal.reasons.join(" "), /reviewer could not run: review reserve exhausted \(4\/4 workers\)/);
	assert.equal(post.manager.get(r2) !== undefined && post.manager.get(r3) !== undefined, true, "the refusal stops no author");

	release();
	post.reviewRuns.handBack(first.key);
	await post.reviewRuns.settled(first.key);
	await waitFor(() => post.manager.get(first.key), (live) => live === undefined, { timeoutMs: 30_000, what: "the first reviewer's close" });
	const retry = await post.gate({ jobId: r2, model: gateR2 });
	assert.ok(isGateWait(retry), `a closed reviewer frees its reserve slot: ${JSON.stringify(retry)}`);
	post.reviewRuns.handBack(retry.key);
	await post.reviewRuns.settled(retry.key);
});

interface Bench {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	settles: Array<{ jobId: string; outcome: SettleOutcome }>;
	job(slug: string): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	dispatch(jobId: string, model: string): Promise<string>;
	events(jobId: string, type: string): Array<Record<string, unknown>>;
	prompts(script: string): string[];
}

/** A ship/local fleet on a treehouse pool whose unreported settles are collected, as the parent receives them. */
async function bench(t: { after(fn: () => void | Promise<void>): void }): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const settles: Bench["settles"] = [];
	const post = new CommandPost({
		home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env },
		onUnreportedSettle: (jobId, outcome) => settles.push({ jobId, outcome }),
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 5 });
	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	return {
		home: home.path,
		post,
		provider,
		settles,
		async job(slug) {
			return (await post.ledger().create({ title: slug, project: "demo", delivery: "local", kind: "ship", slug })).id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps);
			agentDir.writeModels(provider);
			return model;
		},
		async dispatch(jobId, model) {
			return (await post.dispatch({ jobId, task: `Brief for ${jobId}.`, model, fetch: false })).worktree;
		},
		events(jobId, type) {
			return readRunEvents(home.path, jobId).filter((event) => event.source === "cp" && event.type === type)
				.map((event) => (event.payload ?? {}) as Record<string, unknown>);
		},
		prompts(script) {
			return provider.requests(script).map((request: RecordedRequest) => {
				const users = (request.body.messages ?? []).filter((message) => message.role === "user");
				const content = users.at(-1)?.content;
				if (typeof content === "string") return content;
				return Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : "";
			});
		},
	};
}

const GIT = "git -c user.email=w@w -c user.name=w";
const DONE: ScriptStep = { kind: "text", text: "Done." };
const bash = (command: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command } }] });

test("P8c unreported: a silent settle with work on disk gets two recovery prompts carrying the evidence, then a record; a promote reopens them; a clean or unobservable tree gets the plain nudge", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await bench(t);
	const [work, unpushed, clean, gone] = [await f.job("work"), await f.job("unpushed"), await f.job("clean"), await f.job("gone")];
	const worktree = await f.dispatch(work, f.script("work", [
		bash(`${GIT} commit -q --allow-empty -m base && git push -q -u origin HEAD && ${GIT} commit -q --allow-empty -m one && ` +
			`${GIT} commit -q --allow-empty -m two && for i in $(seq 10 49); do echo $i > f-$i.txt; done && echo wrote`),
		DONE, DONE, DONE, DONE, { kind: "hang" },
	]));
	await f.dispatch(unpushed, f.script("unpushed", [bash(`echo kept > kept.txt && git add kept.txt && ${GIT} commit -q -m kept && echo ok`), DONE, { kind: "hang" }]));
	await f.dispatch(clean, f.script("clean", [DONE, DONE, { kind: "hang" }]));
	await f.dispatch(gone, f.script("gone", [bash('rm -rf "$PWD" && echo removed'), DONE, { kind: "hang" }]));

	await waitFor(() => f.events(work, "recovery_exhausted").length, (n) => n === 1, { timeoutMs: 60_000, what: "the spent recovery" });
	const prompts = f.prompts("work").slice(2);
	assert.equal(prompts.length, 2, "two prompts, sent by the settle boundary itself, then none");
	const [first = "", last = ""] = prompts;
	for (const text of [worktree, `origin has ${work}`, "28 more file(s)", "2 unpushed commit(s)", "still sitting in the worktree", "Do NOT redo it", "report_result exactly once", "blocked"]) {
		assert.ok(first.includes(text), `the first prompt carries ${text}`);
	}
	assert.ok(first.length < 3000 && !first.includes(`Brief for ${work}.`), "a short instruction plus evidence, never a re-brief");
	assert.match(last, /and the last one/);
	assert.deepEqual(f.events(work, "recovery_prompted").map((event) => [event.attempt, event.of, (event.work as { state?: string }).state]), [[1, 2, "dirty"], [2, 2, "dirty"]]);
	const record = f.post.fleet.require(work);
	assert.deepEqual([record.phase, record.failure, record.unreported_settles], ["waiting", undefined, 3], "left waiting for a human, never failed");
	const seen = record.unreported_work;
	assert.deepEqual([seen?.state, seen?.file_count, seen?.files.length, seen?.commits_ahead, seen?.branch_on_origin], ["dirty", 40, 12, 2, true]);
	assert.ok(validate(FleetRecordSchema, record).ok, "the observation is part of the fleet contract");
	const line = formatSettleOutcome(work, f.settles.filter((entry) => entry.jobId === work).at(-1)!.outcome) ?? "";
	assert.ok(line.split("\n").length <= 3);
	for (const pattern of [/uncommitted file/, new RegExp(`cp_send ${work}`), /nothing was deleted/i]) assert.match(line, pattern);
	assert.ok(existsSync(join(worktree, "f-10.txt")) && existsSync(join(worktree, "f-49.txt")), "nothing deleted the work");

	const snapshot = await f.post.status({});
	const row = snapshot.jobs.find((job) => job.job_id === work);
	assert.equal(row && jobState(row).kind, "unreported");
	const table = formatStatusTable(snapshot);
	assert.match(table, /WITH WORK ON DISK/);
	assert.match(table, /40 uncommitted file/);
	assert.doesNotMatch(table, /failed/);
	assert.ok(renderFleetWidget(snapshot, { width: 120 }).some((entry) => entry.text.includes("work on disk")), "the widget names it too");

	await f.post.send({ jobId: work, message: "Commit, push and report what is there." });
	const promoted = f.post.fleet.require(work);
	assert.deepEqual([promoted.unreported_settles, promoted.unreported_work], [undefined, undefined], "a promote clears the count and its observation");
	await waitFor(() => f.events(work, "recovery_prompted").length, (n) => n === 3, { timeoutMs: 30_000, what: "a fresh recovery budget" });
	assert.equal(f.events(work, "recovery_prompted").at(-1)?.attempt, 1);

	await waitFor(() => f.events(unpushed, "recovery_prompted").length, (n) => n === 1, { timeoutMs: 30_000, what: "the unpushed recovery" });
	const kept = f.post.fleet.require(unpushed).unreported_work;
	assert.deepEqual([kept?.state, kept?.file_count, kept?.commits_ahead, kept?.branch_on_origin], ["unpushed", 0, 1, false]);
	await waitFor(() => f.prompts("unpushed").at(-1) ?? "", (text) => text.includes(`origin does NOT have ${unpushed}`), { timeoutMs: 30_000, what: "the unpushed prompt" });

	await waitFor(() => f.events(clean, "settled_without_report").length, (n) => n === 1, { timeoutMs: 30_000, what: "the clean job's record" });
	assert.deepEqual(f.prompts("clean").slice(1), [REPORT_NUDGE_TEXT], "one plain nudge, never a recovery");
	assert.equal(f.post.fleet.require(clean).unreported_work?.state, "clean");
	assert.equal(f.events(clean, "settled_without_report")[0]?.reason, "the nudge to report was already spent");

	await waitFor(() => f.events(gone, "report_nudged").length, (n) => n === 1, { timeoutMs: 30_000, what: "the unobservable job's nudge" });
	const unknown = f.post.fleet.require(gone).unreported_work;
	assert.equal(unknown?.state, "unknown", "an observation that failed is never work");
	assert.match(unknown?.reason ?? "", /does not exist/);
	await waitFor(() => f.prompts("gone").at(-1), (text) => text === REPORT_NUDGE_TEXT, { timeoutMs: 30_000, what: "the plain nudge's request" });
});

test("P8c unreported: a job that reported, or whose delivery merged, is never prompted after it settles", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await bench(t);
	const [reported, merged] = [await f.job("reported"), await f.job("merged")];
	await f.dispatch(reported, f.script("reported", [
		DONE,
		{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: reported, kind: "ship", status: "blocked", summary: "Waiting on a human.", blockers: ["a human must pick the API"] } }] },
		{ kind: "hang" },
	]));
	let land = (): void => {};
	const landed = new Promise<void>((resolve) => (land = resolve));
	await f.dispatch(merged, f.script("merged", [{ kind: "hang", until: landed }, { kind: "hang" }]));

	await waitFor(() => f.post.fleet.require(reported).phase, (phase) => phase === "held", { timeoutMs: 60_000, what: "the report after one nudge" });
	await waitFor(() => f.provider.requests("reported").length, (n) => n === 2, { timeoutMs: 30_000, what: "the reported turn" });
	await waitFor(() => readRunStatus(f.home, reported).phase, (phase) => phase === "idle", { timeoutMs: 30_000, what: "the settle after the report" });

	const receipt: MergeReceipt = {
		schema_version: SCHEMA_VERSION, job_id: merged, pr_url: "https://github.com/demo/demo/pull/91", merge_commit_sha: "a".repeat(40),
		head_sha: "b".repeat(40), head_branch: merged, recorded_at: "2026-10-25T09:00:00Z", recorded_by: "gh pr view",
	};
	mkdirSync(join(f.home, paths.runDir(merged)), { recursive: true });
	writeFileSync(join(f.home, paths.mergeFile(merged)), `${JSON.stringify(receipt, null, 2)}\n`);
	land();
	await waitFor(() => readRunStatus(f.home, merged).phase, (phase) => phase === "idle", { timeoutMs: 30_000, what: "the merged job's settle" });

	await new Promise((resolve) => setTimeout(resolve, 2_000));
	assert.equal(f.provider.requests("reported").length, 2, "no prompt after the report");
	assert.equal(f.events(reported, "report_nudged").length, 1);
	assert.equal(f.prompts("reported")[1], REPORT_NUDGE_TEXT, "the report followed the one plain nudge");
	const held = f.post.fleet.require(reported);
	assert.ok(held.reported_at, "the report after the nudge is accepted");
	assert.equal(held.unreported_settles, undefined, "and clears the unreported count");
	assert.equal(f.provider.requests("merged").length, 1, "a landed delivery is never prompted");
	assert.equal(f.post.fleet.require(merged).unreported_settles, undefined, "and is not an unreported settle");
	assert.deepEqual(f.settles.map((entry) => entry.jobId), [reported], "only the pre-report settle reached the parent");
});

test("P8c settle: a silent worker is nudged once per brief and then recorded, a run that did work is nudged despite a model error, and a dead-on-arrival worker is failed closed unprompted", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const [quiet, ran, doa] = [await f.job("quiet"), await f.job("ran"), await f.job("doa")];
	await f.dispatch(quiet, f.script("quiet", [DONE, DONE, DONE, DONE, { kind: "hang" }]));
	const rejected: ScriptStep = { kind: "error", status: 400, message: "the request was rejected", type: "invalid_request_error" };
	await f.dispatch(ran, f.script("ran", [bash("echo did-work"), rejected, DONE, { kind: "hang" }]));

	await waitFor(() => f.events(quiet, "settled_without_report").length, (n) => n === 1, { timeoutMs: 30_000, what: "the quiet job's record" });
	assert.deepEqual(f.prompts("quiet").slice(1), [REPORT_NUDGE_TEXT], "the nudge fires once, from the worker's own settle");
	assert.deepEqual(f.settles.filter((entry) => entry.jobId === quiet).map((entry) => entry.outcome.action), ["nudged", "recorded"]);
	const record = f.post.fleet.require(quiet);
	assert.deepEqual([record.phase, record.failure, record.unreported_settles], ["waiting", undefined, 2], "finished work is never failed");
	const line = formatSettleOutcome(quiet, f.settles.filter((entry) => entry.jobId === quiet).at(-1)!.outcome) ?? "";
	assert.match(line, new RegExp(`cp_send ${quiet}`));
	assert.ok(line.split("\n").length <= 3, "an operator line, never a body");

	await waitFor(() => f.events(ran, "report_nudged").length, (n) => n === 1, { timeoutMs: 30_000, what: "the nudge after a model error" });
	assert.deepEqual([f.post.fleet.require(ran).phase, f.post.fleet.require(ran).failure], ["waiting", undefined], "a run that did work is never failed by the boundary");

	const snapshot = await f.post.status({});
	assert.equal(snapshot.jobs.find((job) => job.job_id === quiet)?.unreported_settles, 2, "/status carries the fact");
	const block = assembleStatusBlock(snapshot).text;
	assert.match(block, /unreported/);
	assert.doesNotMatch(block, /failed/);
	assert.match(formatStatusTable(snapshot), /settled without filing an envelope/);
	assert.ok(renderFleetWidget(snapshot, { width: 100 }).some((entry) => entry.text.includes("no envelope filed")), "the widget says what is missing");

	await f.post.send({ jobId: quiet, message: "One more pass, then report." });
	await waitFor(() => f.events(quiet, "report_nudged").length, (n) => n === 2, { timeoutMs: 30_000, what: "the promoted brief's own nudge" });

	await f.dispatch(doa, f.script("doa", [{ kind: "error", status: 401, message: "401 Invalid API key", repeat: 20 }]));
	const failed = await waitFor(() => f.post.fleet.require(doa), (job) => job.phase === "failed", { timeoutMs: 30_000, what: "the dead-on-arrival failure" });
	assert.equal(failed.failure?.class, "model_call_failed");
	assert.match(failed.failure?.message ?? "", /401 Invalid API key/);
	assert.equal(failed.unreported_settles, undefined, "a worker that never ran is not an unreported settle");
	assert.deepEqual([f.events(doa, "report_nudged").length, f.events(doa, "recovery_prompted").length], [0, 0], "never prompted");
	const doaOutcome = await waitFor(() => f.settles.find((entry) => entry.jobId === doa)?.outcome, Boolean, { timeoutMs: 10_000, what: "the outcome line" });
	const doaLine = formatSettleOutcome(doa, doaOutcome!) ?? "";
	for (const pattern of [/dead on arrival/, /401 Invalid API key/, /re-dispatch/]) assert.match(doaLine, pattern);
});
