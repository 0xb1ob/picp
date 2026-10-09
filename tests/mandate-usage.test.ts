/**
 * Live mandate cap crossings (mandate continuation friction, Task 4): one
 * notice per threshold while a worker runs, the worker is never killed, and a
 * paused mandate refuses the next dispatch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../src/command-post.ts";
import { EMPTY_USAGE, type FleetRecord, isoTimestamp } from "../src/contracts.ts";
import { attachWorkerObservers } from "../src/dispatch.ts";
import { MandateError } from "../src/mandate.ts";
import { setMandateDefault } from "../src/mandate-defaults.ts";
import { liveUsageJobs, observeMandateUsage, raiseTokenCap } from "../src/mandate-usage.ts";
import type { WorkerProcess } from "../src/worker-process.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

type Listener = (event: { type: string; [key: string]: unknown }) => void;

function fakeWorker(): { worker: WorkerProcess; emit: (tokens: number, usd?: number, cacheRead?: number) => void } {
	const listeners: Listener[] = [];
	const worker = {
		onEvent(cb: Listener) {
			listeners.push(cb);
			return () => {};
		},
		closed: new Promise(() => {}),
	} as unknown as WorkerProcess;
	const emit = (tokens: number, usd = 0, cacheRead = 0) => {
		const event = {
			type: "message_end",
			message: { role: "assistant", usage: { input: tokens, output: 0, cacheRead, totalTokens: tokens + cacheRead, cost: { total: usd } } },
		};
		for (const listener of listeners) listener(event);
	};
	return { worker, emit };
}

/** The budget_exhausted raise is fire-and-forget from the sweep; let its queued write land. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

function waiting(jobId: string): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "waiting",
		worker: { pid: 1, session_id: "s", session_file: "/none.jsonl", profile: "implementer", role: "implementer", model: "mock", started_at: isoTimestamp() },
		worktree: "/wt",
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }, cap: { usd: number; tokens: number }, jobIds?: string[]) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	const grant = post.mandates.issue({
		projects: ["demo"],
		objective: "ship it",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: cap,
		job_cap: 10,
		...(jobIds ? { job_ids: jobIds } : {}),
	});
	const options = { fleet: post.fleet, runs: post.runs, mandates: post.mandates, journal: (input: Parameters<typeof post.durableWakeups.enqueue>[0]) => void post.durableWakeups.enqueue(input) };
	const attach = (jobId: string) => {
		const { worker, emit } = fakeWorker();
		attachWorkerObservers({ recorder: post.runs.open(jobId), worker, jobId, onUsage: (id, previous, current) => observeMandateUsage(options, id, previous, current) });
		return emit;
	};
	const notices = () => post.durableWakeups.pending().map((entry) => entry.id.split(":").at(-1));
	return { post, grant, options, attach, notices };
}

test("tokens: one 80% warning, one cap-pause notice, never repeated across re-observation or a revived worker", async (t) => {
	const b = benchOf(t, { usd: 20, tokens: 3_000_000 }, ["cp-live"]);
	await b.post.fleet.add(waiting("cp-live"));
	const emit = b.attach("cp-live");

	emit(2_300_000);
	assert.deepEqual(b.notices(), [], "under 80%: nothing");
	emit(200_000);
	assert.deepEqual(b.notices(), ["warn-tokens"]);
	const at = { ...EMPTY_USAGE, total_tokens: 2_500_000 };
	observeMandateUsage(b.options, "cp-live", at, at);
	assert.deepEqual(b.notices(), ["warn-tokens"], "the same cumulative usage says nothing new");

	emit(600_000);
	assert.deepEqual(b.notices(), ["warn-tokens", "token-cap"]);
	const paused = b.post.mandates.require(b.grant.id);
	assert.deepEqual([paused.status, paused.pause_reason, paused.escalations.length], ["paused", "token_cap", 1]);
	assert.match(b.post.durableWakeups.pending()[1]?.content ?? "", /used 3100000 \/ 3000000 non-cached tokens.*\n.*in-flight worker continues.*raise_tokens/s);
	await settle();
	assert.deepEqual(b.post.escalations.list({ kind: "budget_exhausted" }), [], "a token cap under the ceiling never asks the operator");

	// A revived (or bounded-recovery) worker for the same job re-attaches the same observer.
	const revived = b.attach("cp-live");
	revived(10_000);
	const after = { ...EMPTY_USAGE, total_tokens: 3_110_000 };
	observeMandateUsage(b.options, "cp-live", after, after);
	assert.deepEqual(b.notices(), ["warn-tokens", "token-cap"], "no duplicate notice");
	assert.equal(b.post.mandates.require(b.grant.id).escalations.length, 1, "no duplicate budget escalation");

	assert.equal(b.post.fleet.require("cp-live").phase, "waiting", "the in-flight worker is not killed");
	await assert.rejects(
		() => b.post.mandates.assertDispatchAllowed({ jobId: "cp-live", project: "demo", kind: "ship", promotion: true }, b.post.fleet.read().jobs),
		(error: Error) => error instanceof MandateError && /paused \(token_cap\).*raise_tokens/.test(error.message),
	);
});

test("cache reads never count toward the token cap; the notice totals are non-cached", async (t) => {
	const b = benchOf(t, { usd: 20, tokens: 1_000_000 });
	await b.post.fleet.add(waiting("cp-cached"));
	const emit = b.attach("cp-cached");
	emit(100_000, 0, 50_000_000);
	assert.deepEqual(b.notices(), [], "50M cache reads, 100k non-cached: nothing crossed");
	assert.equal(b.post.mandates.require(b.grant.id).status, "active");
	emit(750_000, 0, 10_000_000);
	assert.deepEqual(b.notices(), ["warn-tokens"], "850k non-cached crosses 80% of 1M");
	assert.match(b.post.mandates.show(b.grant.id, liveUsageJobs(b.post.fleet, b.post.runs)), /850000 \/ 1000000 non-cached tokens/);
});

test("the parent raises a token cap itself: the grant resumes, the job continues, and the next round notices afresh", async (t) => {
	const b = benchOf(t, { usd: 20, tokens: 1_000_000 }, ["cp-run"]);
	await b.post.fleet.add(waiting("cp-run"));
	const emit = b.attach("cp-run");
	emit(1_100_000);
	assert.equal(b.post.mandates.require(b.grant.id).pause_reason, "token_cap");

	const raised = raiseTokenCap(b.post.mandates, b.grant.id, { tokens: 2_000_000, reason: "mission needs one more job" }, liveUsageJobs(b.post.fleet, b.post.runs));
	assert.deepEqual([raised.status, raised.pause_reason, raised.spend_cap], ["active", undefined, { usd: 20, tokens: 2_000_000 }]);
	assert.equal(raised.token_raises?.[0]?.reason, "mission needs one more job");
	assert.equal(b.post.fleet.require("cp-run").phase, "waiting", "the in-flight job continues");

	emit(600_000);
	emit(400_000);
	assert.deepEqual(b.notices(), ["token-cap", "warn-tokens@2000000", "token-cap@2000000"]);
	await settle();
	assert.deepEqual(b.post.escalations.list({ kind: "budget_exhausted" }), []);
});

test("at the token ceiling, the cap is the operator's: budget_exhausted is raised once", async (t) => {
	const b = benchOf(t, { usd: 20, tokens: 1_000_000 }, ["cp-top"]);
	setMandateDefault(b.post.home, "token_ceiling", "1000000");
	await b.post.fleet.add(waiting("cp-top"));
	const emit = b.attach("cp-top");
	emit(1_000_000);
	assert.match(b.post.durableWakeups.pending().at(-1)?.content ?? "", /TOKEN CEILING/);
	await settle();
	assert.equal(b.post.escalations.list({ kind: "budget_exhausted" }).length, 1);
	assert.throws(
		() => raiseTokenCap(b.post.mandates, b.grant.id, { tokens: 1_000_001, reason: "one more" }),
		(error: Error) => error instanceof MandateError && /over the home's token_ceiling 1000000/.test(error.message),
	);
});

test("a USD cap is always the operator's, even with tokens to spare", async (t) => {
	const b = benchOf(t, { usd: 1, tokens: 50_000_000 }, ["cp-usd"]);
	await b.post.fleet.add(waiting("cp-usd"));
	b.attach("cp-usd")(1_000, 1.5);
	assert.equal(b.post.mandates.require(b.grant.id).pause_reason, "spend_cap");
	await settle();
	assert.equal(b.post.escalations.list({ kind: "budget_exhausted" }).length, 1);
});

test("usd crosses independently of tokens", async (t) => {
	const b = benchOf(t, { usd: 1, tokens: 50_000_000 });
	await b.post.fleet.add(waiting("cp-usd"));
	const emit = b.attach("cp-usd");
	emit(1_000, 0.85);
	assert.deepEqual(b.notices(), ["warn-usd"]);
	emit(1_000, 0.2);
	assert.deepEqual(b.notices(), ["warn-usd", "cap"]);
});

test("an old grant the parent already capped says nothing; the replacement grant's notices are its own and survive teardown", async (t) => {
	const b = benchOf(t, { usd: 20, tokens: 1_000 });
	await b.post.fleet.add({ ...waiting("cp-old"), phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, total_tokens: 5_000 } });
	b.post.mandates.sweep(undefined, b.post.fleet.read().jobs);
	assert.equal(b.post.mandates.require(b.grant.id).status, "paused", "capped by the ordinary parent sweep");
	const replacement = b.post.mandates.issue(
		{ projects: ["demo"], job_ids: ["cp-new"], objective: "replacement", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 20, tokens: 100_000 }, job_cap: 5 },
		b.post.fleet.read().jobs,
	);
	await b.post.fleet.add(waiting("cp-new"));
	const emit = b.attach("cp-new");
	emit(10_000);
	assert.deepEqual(b.notices(), [], "no false cap notice from the old grant, no warning under 80%");
	emit(75_000);
	assert.deepEqual(b.post.durableWakeups.pending().map((entry) => entry.id), [`mandate-usage:${replacement.id}:warn-tokens`]);
	assert.equal(b.post.durableWakeups.pending()[0]?.keys, undefined, "keyed to the mandate, never staled by a torn-down job");
	emit(1_000);
	assert.equal(b.post.durableWakeups.pending().length, 1, "past the line, a message that crosses nothing writes nothing");
});

test("a project-wide grant issued over history and an in-flight job counts only what accrues after issue, live", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	await post.fleet.add({ ...waiting("cp-hist"), phase: "done", usage: { ...EMPTY_USAGE, total_tokens: 5_000_000, cost_usd: 50 } });
	await post.fleet.add(waiting("cp-live"));
	const options = { fleet: post.fleet, runs: post.runs, mandates: post.mandates, journal: (input: Parameters<typeof post.durableWakeups.enqueue>[0]) => void post.durableWakeups.enqueue(input) };
	const { worker, emit } = fakeWorker();
	attachWorkerObservers({ recorder: post.runs.open("cp-live"), worker, jobId: "cp-live", onUsage: (id, previous, current) => observeMandateUsage(options, id, previous, current) });
	const notices = () => post.durableWakeups.pending().map((entry) => entry.id.split(":").at(-1));
	emit(400_000);

	const grant = post.mandates.issue(
		{ projects: ["demo"], objective: "the project", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 },
		liveUsageJobs(post.fleet, post.runs),
	);
	const baseline = new Map(grant.usage_baseline?.map((entry) => [entry.job_id, entry.tokens]));
	assert.deepEqual([baseline.get("cp-live"), baseline.get("cp-hist")], [400_000, 5_000_000]);
	emit(700_000);
	assert.deepEqual(notices(), [], "700k accrued after issue: under 80%");
	emit(150_000);
	assert.deepEqual(notices(), ["warn-tokens"]);
	const shown = post.mandates.show(grant.id, liveUsageJobs(post.fleet, post.runs));
	assert.match(shown, /; 850000 \/ 1000000 non-cached tokens/);
	assert.match(shown, /job cap: 1 \/ 10/);
	emit(200_000);
	assert.equal(notices().at(-1), "token-cap");
	const paused = post.mandates.require(grant.id);
	assert.deepEqual([paused.status, paused.pause_reason], ["paused", "token_cap"]);
});

test("cp_mandate and cp_decide read the live view, so the baseline and every cap check see the same usage", () => {
	const source = readFileSync(join(REPO_ROOT, "extensions/command-post/tools-mandate.ts"), "utf8");
	assert.match(source, /const jobs = liveUsageJobs\(post\.fleet, post\.runs\);/);
	assert.match(source, /usageJobs: \(\) => liveUsageJobs\(post\.fleet, post\.runs\)/);
	assert.doesNotMatch(source, /post\.fleet\.read\(\)\.jobs/);
});

test("every CommandPost spawn path (dispatch, revive, bounded recovery) shares one observer set", () => {
	const source = readFileSync(join(REPO_ROOT, "src/command-post.ts"), "utf8");
	assert.equal(source.match(/\.\.\.this\.#observers\(\)/g)?.length, 3);
	assert.match(source, /onUsage: \(jobId: string, previous: Usage, current: Usage\) => runAuthority\(this\.mandates\.runContext\(\), jobId\)\.source === "schedule-run" \? observeRunUsage\(/);
	assert.match(source, /: observeMandateUsage\(usage, jobId, previous, current\)/);
	for (const file of ["src/dispatch.ts", "src/revive.ts", "src/recovery.ts"]) {
		assert.match(readFileSync(join(REPO_ROOT, file), "utf8"), /onUsage: this\.#options\.onUsage|onUsage: options\.onUsage/, `${file} forwards onUsage`);
	}
});
