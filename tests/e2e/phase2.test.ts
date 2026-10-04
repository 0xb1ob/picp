/**
 * MILESTONE m2 — intake to teardown, end to end, on the mock provider.
 *
 * Everything here is the real thing except the model: a real `br` ledger, a
 * real project registry and clone, a real treehouse lease, a real
 * `pi --mode rpc` worker, real git pushes to a fixture remote. Only the
 * model's answers are scripted, which is what makes the whole path
 * deterministic and free.
 *
 * Covered: intake → dispatch (routing, lease, branch, preflight) → scripted
 * worker edits/commits/pushes → envelope intake (held vs teardown-ready) →
 * promote round trip → teardown gates (pass and fail-closed) → crash with a
 * bounded re-dispatch → budget breach escalation.
 *
 * `npm run e2e:phase2`
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type Failure, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { classifyRun, decideRecovery } from "../../src/failures.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { recordRecoveryAttempt } from "../../src/recovery.ts";
import type { IntakeResult } from "../../src/intake.ts";
import { readEventLog } from "../../src/run-artifacts.ts";

import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	git,
	MockProvider,
	readFleet,
	readRunStatus,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "m2 needs treehouse on PATH";

interface Fleet {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	clone: string;
	remote: string;
	reported: IntakeResult[];
	failures: Array<[string, Failure]>;
	intake(title: string, options: { delivery: "pr" | "local"; slug: string }): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	cleanup(): Promise<void>;
}

/**
 * A complete command post in a temp directory: home + br workspace + project
 * registry + cloned project + treehouse pool + mock provider.
 */
async function fleet(
	t: { after(fn: () => void | Promise<void>): void },
	options: { budgets?: { per_job_tokens: number; per_job_cost_usd: number } } = {},
): Promise<Fleet> {
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: "demo",
		files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" },
	});
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });

	// br workspace lives in the home, exactly as it does in a real command post.
	initJobsDocument(home.path, "cp");

	if (options.budgets) {
		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		writeFileSync(
			join(home.path, LAYOUT.budgetsFile),
			JSON.stringify({
				schema_version: SCHEMA_VERSION,
				per_job_tokens: options.budgets.per_job_tokens,
				per_job_cost_usd: options.budgets.per_job_cost_usd,
				warn_ratio: 0.8,
				spawn_cap: 10,
			}),
		);
	}

	const reported: IntakeResult[] = [];
	const failures: Array<[string, Failure]> = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		onReported: (result) => reported.push(result),
		onFailure: (jobId, failure) => failures.push([jobId, failure]),
	});

	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 3 });

	const cleanup = async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// the pool root is removed next anyway
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	};
	t.after(cleanup);

	return {
		home: home.path,
		post,
		provider,
		clone,
		remote: repo.remote as string,
		reported,
		failures,
		async intake(title, { delivery, slug }) {
			const issue = await post.ledger().create({ title, project: "demo", delivery, kind: "ship", slug });
			return issue.id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps);
			agentDir.writeModels(provider);
			return model;
		},
		cleanup,
	};
}

/** HEAD of the job's own worktree, read when the step is served (the commit happens in the step before). */
function worktreeHeadOf(home: string, jobId: string): string {
	const worktree = readFleet(home).jobs.find((j) => j.job_id === jobId)?.worktree;
	assert.ok(worktree, `no worktree recorded for ${jobId}`);
	return execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function shipSteps(home: string, jobId: string, options: { push?: boolean; prUrl?: string } = {}): ScriptStep[] {
	const push = options.push === false ? "" : ` && git push -q -u origin ${jobId}`;
	return [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "bash",
					args: {
						command: `printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x'${push} && git status --porcelain | wc -l`,
					},
				},
			],
			usage: { prompt_tokens: 900, completion_tokens: 100 },
		},
		{
			kind: "tool_calls",
			calls: [
				{
					name: "report_result",
					args: () => ({
						job_id: jobId,
						kind: "ship",
						status: "done",
						summary: "Bumped x to 2 and pushed the branch.",
						branch: jobId,
						head_sha: worktreeHeadOf(home, jobId),
						...(options.prUrl ? { pr_url: options.prUrl } : {}),
					}),
				},
			],
			usage: { prompt_tokens: 1200, completion_tokens: 80 },
		},
	];
}

// ---------------------------------------------------------------------------
// the whole path
// ---------------------------------------------------------------------------

test("m2: intake → dispatch → envelope → promote → unreported head needs force", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("bump x", { delivery: "pr", slug: "bump-x" });
	const model = f.script("m2-ship", [
		...shipSteps(f.home, jobId, { prUrl: "https://github.com/o/r/pull/42" }),
		// promote: a CI fix on the held worker, same model, same worktree
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: `git commit -q --allow-empty -m 'ci fix' && git push -q origin ${jobId}` } }],
		},
		{ kind: "text", text: "CI fix pushed." },
	]);

	// --- dispatch --------------------------------------------------------
	const dispatched = await f.post.dispatch({ jobId, task: "Bump x to 2 in src/app.ts.", model, fetch: false });
	assert.equal(dispatched.state, "dispatched");
	assert.equal(dispatched.receipt, "accepted");
	assert.equal(dispatched.branch, jobId);

	const job = readFleet(f.home).jobs[0];
	assert.equal(job?.phase, "waiting");
	assert.equal(job?.worktree, dispatched.worktree);
	assert.ok(job?.lease_id);
	assert.equal((await f.post.ledger().show(jobId)).status, "in_progress");

	// --- the worker does the job and reports ------------------------------
	const held = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "held",
		{ timeoutMs: 60_000, what: "the envelope to be accepted" },
	);
	assert.ok(held?.reported_at);
	assert.equal(held?.receipts?.find((receipt) => receipt.kind === "pr")?.url, "https://github.com/o/r/pull/42");
	assert.equal(f.reported.at(-1)?.next, "hold", "delivery:pr keeps the worker and the lease");
	assert.equal(f.reported.at(-1)?.summary, "Bumped x to 2 and pushed the branch.");

	// the work is real: the branch is on the fixture remote
	assert.equal(readFileSync(join(dispatched.worktree, "src/app.ts"), "utf8"), "export const x = 2;\n");
	assert.match(git(f.clone, "ls-remote", "--heads", "origin", jobId), new RegExp(jobId));

	// --- teardown is refused while the promote is still pending ----------
	// (a held delivery:pr job is deliberately alive; the operator promotes it)
	// `held` lands on report_result, before the turn settles; `delivered` means
	// idle at send time, so wait for idle (turn-end hooks such as pi-lens widen the gap).
	await waitFor(
		() => readRunStatus(f.home, jobId),
		(status) => status.phase === "idle",
		{ timeoutMs: 60_000, what: "the reporting turn to settle" },
	);
	const promote = await f.post.send({ jobId, message: "CI is red: add an empty commit and push again." });
	assert.equal(promote.receipt, "delivered");
	assert.equal(promote.mode, "prompt");

	await waitFor(
		() => readRunStatus(f.home, jobId),
		(status) => status.tool_calls >= 3 && status.phase === "idle",
		{ timeoutMs: 60_000, what: "the promoted turn to finish" },
	);
	assert.equal(git(dispatched.worktree, "log", "-1", "--pretty=%s"), "ci fix");

	// --- teardown ---------------------------------------------------------
	// The CI fix moved HEAD without a new accepted report. A push alone cannot
	// justify releasing this lease; force is the explicit unverified exit.
	const refused = await f.post.tearDown(jobId);
	// issue #2: the promoted worker is still live and unreported, so that gate answers first.
	assert.equal(refused.failure?.code, "unreported_live_worker");
	assert.equal(refused.lease_returned, false);
	const torn = await f.post.tearDown(jobId, { force: true });
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	assert.equal(torn.reason, undefined);
	assert.equal(torn.lease_returned, true);
	assert.equal(torn.exit_code, 0, "the worker's close was observed");

	const done = readFleet(f.home).jobs[0];
	assert.equal(done?.closed_reason, "forced");
	assert.equal(done?.phase, "done");
	assert.ok(done?.closed_at);
	assert.ok(!/leased/.test(treehouse(f.clone, "status")), "the pool has its worktree back");

	await f.post.ledger().close(jobId, `PR: https://github.com/o/r/pull/42`);
	assert.equal((await f.post.ledger().show(jobId)).status, "closed");
	assert.equal(f.provider.remaining("m2-ship"), 0, "the whole script ran: no hidden turns");
});

// ---------------------------------------------------------------------------
// fail-closed teardown
// ---------------------------------------------------------------------------

test("m2: a dirty worktree keeps everything until it is clean", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("leave a mess", { delivery: "local", slug: "messy" });
	f.script("m2-dirty", [
		// A local job commits AND pushes its work, then leaves scratch behind.
		// Until T29's live run this script only left the mess, so a local job with
		// real commits was never torn down here and nobody noticed that the brief
		// and the gate disagreed about what delivery:local owes. delivery decides
		// PR-or-not and hold-or-not; publishing is not optional.
		{
			kind: "tool_calls",
			calls: [
				{
					name: "bash",
					args: {
						command:
							"echo 'local delivery' > delivered.txt && git add delivered.txt && " +
							"git -c user.email=w@w -c user.name=w commit -q -m 'deliver locally' && " +
							"git push -q -u origin HEAD && echo 'scratch work' > notes.txt",
					},
				},
			],
		},
		{
			kind: "tool_calls",
			calls: [
				{
					name: "report_result",
					args: () => ({ job_id: jobId, kind: "ship", status: "done", summary: "Left a note behind.", branch: jobId, head_sha: worktreeHeadOf(f.home, jobId) }),
				},
			],
		},
	]);
	const model = f.provider.addScript("m2-dirty-model", []);
	void model;

	const dispatched = await f.post.dispatch({
		jobId,
		task: "Write notes.txt.",
		model: `mock/m2-dirty`,
		fetch: false,
	});
	assert.equal(dispatched.state, "dispatched");

	const held = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "held",
		{ timeoutMs: 60_000, what: "the envelope" },
	);
	assert.equal(f.reported.at(-1)?.next, "teardown", "delivery:local is ready for teardown at once");
	assert.equal(held?.delivery, "local");

	const refused = await f.post.tearDown(jobId);
	assert.equal(refused.torn_down, false);
	assert.equal(refused.failure?.code, "dirty");
	assert.match(refused.failure?.fix ?? "", /keep the lease/);
	assert.equal(readFleet(f.home).jobs[0]?.phase, "held", "a refusal changes nothing");
	assert.ok(/leased/.test(treehouse(f.clone, "status")), "the lease is kept");

	// clean it up the way an operator would, then retry
	rmSync(join(dispatched.worktree, "notes.txt"));
	const torn = await f.post.tearDown(jobId);
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	// One question for every ship job: is the work durable outside this lease?
	assert.equal(torn.reason, "pushed");
	assert.equal(readFleet(f.home).jobs[0]?.phase, "done");
	assert.ok(
		git(f.clone, "ls-remote", "--heads", "origin", jobId).includes(jobId),
		"a delivery:local job still publishes its branch — projects/ is a cache, not a destination",
	);
});

// ---------------------------------------------------------------------------
// failure taxonomy: crash → bounded re-dispatch
// ---------------------------------------------------------------------------

test("m2: a crashed worker is classified and re-dispatched once", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("survive a crash", { delivery: "local", slug: "crashy" });

	// Since cur.4.2 a first crash is revived automatically, in the same worktree, and
	// that revive races an operator's forced teardown. This test is the operator path
	// (the bound is spent: the one automatic attempt was already used), so spend it.
	recordRecoveryAttempt(f.home, jobId, "crash");

	// First attempt: the worker starts a slow tool and is killed mid-run.
	const firstModel = f.script("m2-crash-1", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 30" } }] },
	]);
	const first = await f.post.dispatch({ jobId, task: "Bump x to 2 in src/app.ts.", model: firstModel, fetch: false });
	const managed = f.post.manager.get(jobId);
	assert.ok(managed, "the manager owns the worker it spawned");
	await waitFor(
		() => readRunStatus(f.home, jobId),
		(status) => status.phase === "working",
		{ timeoutMs: 60_000, what: "the worker to start working" },
	);

	await managed.worker.kill("SIGKILL");
	const failed = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "failed",
		{ timeoutMs: 60_000, what: "the crash to be classified" },
	);
	assert.equal(failed?.failure?.class, "crash");
	// The transition (fleet phase) and the announcer's durable journal write are one
	// atomic step (pi-command-post-autonomy-programme-cur.1.3); onFailure fires after
	// that journal write, which is not instant (it inspects the worktree), so it can
	// still be in flight the instant the phase above is observed as failed.
	await waitFor(
		() => f.failures,
		(list) => list.length > 0,
		{ timeoutMs: 60_000, what: "onFailure to be called" },
	);
	assert.deepEqual(f.failures.map(([id, failure]) => [id, failure.class]), [[jobId, "crash"]]);

	// The log alone reaches the same conclusion, and the ladder allows one retry.
	assert.equal(classifyRun(readEventLog(f.home, jobId), { alive: false })?.class, "crash");
	const recovery = decideRecovery({ class: "crash", role: "implementer", attempts: 0 });
	assert.equal(recovery.action, "retry_same");
	assert.equal(recovery.same_brief, true);

	// The automatic recovery (cur.4.2) had its one crash attempt spent above, so it
	// escalated instead of reviving. Wait until it has, so nothing is still in flight
	// inside the worktree when the operator acts.
	await waitFor(
		() => readEventLog(f.home, jobId),
		(events) => events.some((event) => event.type === "recovery_escalated"),
		{ timeoutMs: 60_000, what: "automatic recovery to hand the crash to the operator" },
	);
	assert.ok(!readEventLog(f.home, jobId).some((event) => event.type === "worker_revived"), "no automatic revive ran");

	// Recovery, as an operator performs it: return the lease (nothing to save),
	// remove the leftover job branch, dispatch the same brief again.
	const forced = await f.post.tearDown(jobId, { force: true });
	assert.equal(forced.torn_down, true);
	git(f.clone, "branch", "-D", jobId);

	const firstLeaseId = failed?.lease_id;
	const secondModel = f.script("m2-crash-2", shipSteps(f.home, jobId, { push: false }));
	const second = await f.post.dispatch({ jobId, task: "Bump x to 2 in src/app.ts.", model: secondModel, fetch: false });
	assert.equal(second.state, "dispatched");
	// The pool may hand back the same slot (it is free again); the LEASE is what
	// must be new, and the fleet must carry the new identity.
	assert.notEqual(readFleet(f.home).jobs[0]?.lease_id, firstLeaseId, "a new attempt holds a new lease");
	assert.equal(second.branch, first.branch, "the branch is still the job id: one job, one branch");

	const held = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "held",
		{ timeoutMs: 60_000, what: "the second attempt to report" },
	);
	assert.equal(held?.failure, undefined, "the replacement record carries no stale failure");
	assert.equal(readFleet(f.home).jobs.length, 1, "one job, one record, whatever the attempt count");
});

test("m2: an unspent crash is revived once, in place, on the same lease", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("survive a crash unattended", { delivery: "local", slug: "revived" });

	// Step 1 hangs in a short tool and is killed (its orphaned sleep holds the pipe open until it ends); the revived worker answers with step 2 onward.
	const model = f.script("m2-revive", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 5" } }] },
		...shipSteps(f.home, jobId, { push: false }),
	]);
	await f.post.dispatch({ jobId, task: "Bump x to 2 in src/app.ts.", model, fetch: false });
	const managed = f.post.manager.get(jobId);
	assert.ok(managed, "the manager owns the worker it spawned");
	await waitFor(
		() => readRunStatus(f.home, jobId),
		(status) => status.phase === "working",
		{ timeoutMs: 60_000, what: "the worker to start working" },
	);
	const leaseId = readFleet(f.home).jobs[0]?.lease_id;
	await managed.worker.kill("SIGKILL");

	// Nobody touches it: no teardown, no dispatch. Same lease, same worktree, same branch.
	const held = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "held",
		{ timeoutMs: 60_000, what: "the automatically revived worker to report" },
	);
	assert.equal(held?.lease_id, leaseId, "a revive keeps the lease");
	assert.equal(held?.failure, undefined, "the revived record carries no stale failure");
	const kinds = readEventLog(f.home, jobId).map((event) => event.type);
	assert.equal(kinds.filter((kind) => kind === "worker_revived").length, 1, "exactly one automatic revive");
	assert.ok(kinds.includes("recovery_attempted"));
});

test("m2: a forced teardown racing an automatic revive never claims a lease it did not return (cp-a9fq)", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("tear down mid-revive", { delivery: "local", slug: "raced" });
	const model = f.script("m2-race", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 5" } }] },
		...shipSteps(f.home, jobId, { push: false }),
	]);
	await f.post.dispatch({ jobId, task: "Bump x to 2 in src/app.ts.", model, fetch: false });
	const managed = f.post.manager.get(jobId);
	assert.ok(managed, "the manager owns the worker it spawned");
	await waitFor(() => readRunStatus(f.home, jobId), (status) => status.phase === "working", { timeoutMs: 60_000, what: "the worker to start working" });
	// The overlap, made deterministic: automatic recovery's revive is held at its
	// first step (Reviver.plan) by a gate this test controls, so the revive is
	// provably in flight — claimed, not finished — when the operator forces a
	// teardown. Without cp-a9fq this is exactly the cp-aqzo overlap.
	let openGate!: () => void;
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	let planEntered = false;
	const realReviver = f.post.reviver.bind(f.post);
	f.post.reviver = () => {
		const reviver = realReviver();
		const plan = reviver.plan.bind(reviver);
		reviver.plan = async (...args: Parameters<typeof plan>) => {
			planEntered = true;
			await gate;
			return plan(...args);
		};
		return reviver;
	};
	t.after(() => openGate());

	await managed.worker.kill("SIGKILL");
	await waitFor(() => planEntered, (entered) => entered, { timeoutMs: 60_000, what: "automatic recovery to reach its (gated) revive" });
	assert.equal(f.failures.length, 1, "the crash reached onFailure, which started recovery");
	assert.ok(!readEventLog(f.home, jobId).some((event) => event.type === "worker_revived"), "the revive is in flight, not finished");

	const raced = await f.post.tearDown(jobId, { force: true });
	assert.equal(raced.torn_down, false, JSON.stringify(raced));
	assert.equal(raced.failure?.code, "job_in_flight", "the overlap was exercised and refused");
	assert.equal(raced.lease_returned, false);
	assert.notEqual(readFleet(f.home).jobs[0]?.phase, "done", "a refusal never closes the job beside the revive");
	assert.ok(/leased/.test(treehouse(f.clone, "status")), "the lease is kept");

	// Let the revive finish undisturbed; then the operator's teardown goes through.
	openGate();
	await waitFor(() => readFleet(f.home).jobs[0], (record) => record?.phase === "held", { timeoutMs: 60_000, what: "the revived worker to report" });
	const kinds = readEventLog(f.home, jobId).map((event) => event.type);
	assert.equal(kinds.filter((kind) => kind === "worker_revived").length, 1, "the revive was not cut short");
	const torn = await f.post.tearDown(jobId, { force: true });
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	assert.equal(torn.lease_returned, true);
	// lease_returned:true is a treehouse fact, and nothing is left running in the worktree.
	assert.equal(readFleet(f.home).jobs[0]?.phase, "done");
	assert.ok(!/leased/.test(treehouse(f.clone, "status")), "the pool has its worktree back");
	assert.equal(f.post.manager.get(jobId), undefined, "no worker survives the teardown");
});

// ---------------------------------------------------------------------------
// budgets: escalate, never kill
// ---------------------------------------------------------------------------

test("m2: a budget breach escalates and the worker survives", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t, { budgets: { per_job_tokens: 1000, per_job_cost_usd: 5 } });
	const jobId = await f.intake("burn tokens", { delivery: "local", slug: "burny" });
	const model = f.script("m2-budget", [
		{ kind: "text", text: "first turn", usage: { prompt_tokens: 900, completion_tokens: 200 } },
		{ kind: "text", text: "second turn", usage: { prompt_tokens: 900, completion_tokens: 200 } },
		{ kind: "text", text: "third turn, still reachable", usage: { prompt_tokens: 100, completion_tokens: 20 } },
	]);

	await f.post.dispatch({ jobId, task: "Think about tokens.", model, fetch: false });
	await waitFor(
		() => readRunStatus(f.home, jobId),
		(status) => status.usage.total_tokens > 1000 && status.phase === "idle",
		{ timeoutMs: 60_000, what: "the budget to be blown" },
	);

	// A budget breach escalates to the operator; it never severs the channel
	// (cp-d7y) — the send still reaches the worker.
	// The worker settled without a report, so the parent nudges it once (cp-settle-without-report)
	// and that second run races a bare prompt ("Agent is already processing"): let the nudge run settle.
	await waitFor(
		() => f.post.manager.get(jobId)?.worker.settledCount ?? 0,
		(count) => count >= 2,
		{ timeoutMs: 60_000, what: "the report nudge's run to settle" },
	);
	const sent = await f.post.send({ jobId, message: "keep going" });
	assert.equal(sent.receipt, "delivered", `a breach escalates; it does not block delivery ${JSON.stringify(sent)}`);
	assert.equal(sent.budget?.state, "exceeded", `ratio ${sent.budget?.ratio}`);
	assert.equal(f.post.manager.get(jobId)?.worker.alive, true, "escalation never kills a worker");
	const markers = readEventLog(f.home, jobId)
		.filter((entry) => entry.source === "cp")
		.map((entry) => entry.type);
	assert.ok(markers.includes("budget_exceeded"));

	// The budget test never files a report; ordinary teardown must keep its lease.
	const refused = await f.post.tearDown(jobId);
	assert.equal(refused.failure?.code, "unreported_live_worker", "issue #2: the budget worker survives, live and unreported");
	const torn = await f.post.tearDown(jobId, { force: true });
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	assert.equal(torn.reason, undefined);
	assert.equal(existsSync(join(f.home, paths.runDir(jobId), "status.json")), true, "the run's evidence outlives the job");
});
