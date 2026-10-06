/**
 * cp-wlhu S5: the foreign-PR CI watch, and the cp-pr-review reviewer dispatch
 * gate it feeds (binding decision es-314c8e c). Hermetic: `pr`/`runs` are fakes,
 * `now` is injected, nothing spawns a process or reaches the network.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { detectCiWait } from "../src/ci-wait.ts";
import type { PrObservation } from "../src/ci-watch.ts";
import { CommandPost } from "../src/command-post.ts";
import { LAYOUT, validateForeignCiWatchFile } from "../src/contracts.ts";
import { BlockedDispatchError, type DispatchRequest } from "../src/dispatch.ts";
import { acquireParentLock, releaseParentLock } from "../src/parent-lock.ts";
import {
	ForeignCiWaitError,
	ForeignCiWatch,
	type ForeignCiWatchDeps,
	type ForeignJobRecord,
	foreignPrJobs,
	foreignRunsArgs,
	formatForeignCiNotice,
} from "../src/foreign-ci-watch.ts";
import type { CiRun } from "../src/merge-ask.ts";
import { referencedMaterial } from "../src/task-references.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT } from "./harness/index.ts";

const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const NEW_HEAD = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
const PR = "https://github.com/acme/widgets/pull/7";
const CREATED = "2026-10-06T10:00:00Z";
const repoOf = (project: string): string | undefined => (project === "widgets" ? "acme/widgets" : project === "other" ? "acme/other" : undefined);

function job(overrides: Partial<ForeignJobRecord> = {}): ForeignJobRecord {
	return { id: "cp-r1", status: "open", labels: ["project:widgets", "delivery:local", "kind:research", "schedule:sch-abc123"], external_ref: PR, created_at: CREATED, ...overrides };
}

function bench(t: { after(fn: () => void): void }, jobs: ForeignJobRecord[] = [job()]) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const state: { jobs: ForeignJobRecord[]; own: string[]; pr: PrObservation | undefined; prError?: string; runs: CiRun[]; now: Date } = {
		jobs,
		own: [],
		pr: { merged: false, state: "open", number: 7, url: PR, head_sha: HEAD, head_ref: "feature" },
		runs: [{ status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", databaseId: 11, attempt: 1 }],
		now: new Date("2026-10-06T10:05:00Z"),
	};
	const calls = { pr: 0, runs: [] as string[] };
	const deps: ForeignCiWatchDeps = {
		home: home.path,
		jobs: () => state.jobs,
		ownPrUrls: () => state.own,
		repoOf,
		pr: async () => {
			calls.pr += 1;
			if (state.prError) throw new Error(state.prError);
			return state.pr;
		},
		runs: async (owner, repo, sha) => {
			calls.runs.push(`${owner}/${repo}@${sha}`);
			return state.runs;
		},
		now: () => state.now,
		intervalMs: 1000,
	};
	const later = (ms: number) => {
		state.now = new Date(state.now.getTime() + ms);
	};
	return { home: home.path, watch: new ForeignCiWatch(deps), deps, state, calls, later };
}

test("selection: an open job naming a PR in its project's repo, never a closed job, another repo, or a PR this home shipped", () => {
	const jobs = [
		job(),
		job({ id: "cp-closed", status: "closed" }),
		job({ id: "cp-elsewhere", external_ref: "https://github.com/acme/other/pull/1" }),
		job({ id: "cp-own", external_ref: "https://github.com/acme/widgets/pull/9" }),
		job({ id: "cp-issue", external_ref: "https://github.com/acme/widgets/issues/7" }),
		job({ id: "cp-deferred", status: "deferred", external_ref: "https://github.com/ACME/widgets/pull/8" }),
	];
	const selected = foreignPrJobs(jobs, ["https://github.com/acme/widgets/pull/9"], repoOf);
	assert.deepEqual(selected.map((pr) => pr.job_id), ["cp-r1", "cp-deferred"]);
	assert.deepEqual(selected[0], { job_id: "cp-r1", project: "widgets", url: PR, owner: "acme", repo: "widgets", number: 7 });
});

test("green runs on the head give one ci_green, and the next tick gives nothing; runs are asked of the URL's base repo by head sha", async (t) => {
	const b = bench(t);
	const first = await b.watch.tick();
	assert.deepEqual(first.observations.map((fact) => fact.event), ["ci_green"]);
	assert.match(first.observations[0]!.key, /^foreign\|cp-r1\|d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5\|ci_green\|[0-9a-f]{12}$/);
	assert.deepEqual(b.calls.runs, [`acme/widgets@${HEAD}`]);
	b.later(10 * 60_000);
	const second = await b.watch.tick();
	assert.deepEqual(second.checked, ["cp-r1"], "due again and queried");
	assert.deepEqual(second.observations, [], "the fact was reported once");
	const notice = formatForeignCiNotice(first);
	assert.match(notice, /\[widgets\] cp-r1: foreign PR https:\/\/github\.com\/acme\/widgets\/pull\/7 CI green on d48a81d1f4d3/);
	assert.match(notice, /nothing was merged, commented, re-run or woken/);
});

test("a moved head gives head_moved once, then CI is re-derived for the new head", async (t) => {
	const b = bench(t);
	await b.watch.tick();
	b.state.pr = { ...b.state.pr!, head_sha: NEW_HEAD };
	b.state.runs = [{ status: "in_progress", conclusion: null, headSha: NEW_HEAD, databaseId: 12 }];
	b.later(10 * 60_000);
	const moved = await b.watch.tick();
	assert.deepEqual(moved.observations.map((fact) => fact.event), ["head_moved"]);
	assert.equal(b.watch.store.read().jobs[0]?.last_ci, "in_progress");
	b.state.runs = [{ status: "completed", conclusion: "failure", headSha: NEW_HEAD, workflowName: "ci", databaseId: 12 }];
	b.later(10 * 60_000);
	const failed = await b.watch.tick();
	assert.deepEqual(failed.observations.map((fact) => [fact.event, fact.head_sha]), [["ci_failed", NEW_HEAD]]);
});

test("a merged PR gives pr_merged and is never queried again; an unreadable PR is reported once and dropped", async (t) => {
	const b = bench(t);
	b.state.pr = { ...b.state.pr!, merged: true, merge_commit_sha: "f".repeat(40) };
	const merged = await b.watch.tick();
	assert.deepEqual(merged.observations.map((fact) => fact.event), ["pr_merged"]);
	assert.deepEqual(b.calls.runs, [], "no runs query once the story is over");
	b.later(60 * 60_000);
	const after = await b.watch.tick();
	assert.deepEqual([after.checked, b.calls.pr], [[], 1]);

	const gone = bench(t);
	gone.state.prError = "gh api repos/acme/widgets/pulls/7 failed: gh: Not Found (HTTP 404)";
	const stopped = await gone.watch.tick();
	assert.equal(stopped.stopped.length, 1);
	assert.match(formatForeignCiNotice(stopped), /stopped watching foreign PR .*Not Found/);
	gone.later(60 * 60_000);
	assert.deepEqual((await gone.watch.tick()).checked, []);
});

test("a failing query backs off and names a cause once; the per-tick cap defers the rest", async (t) => {
	const b = bench(t);
	b.state.prError = "gh api failed: HTTP 502";
	const first = await b.watch.tick();
	assert.equal(first.errors.length, 1);
	b.later(60 * 60_000);
	assert.deepEqual((await b.watch.tick()).errors, [], "the same cause is not reported twice");
	assert.equal(b.watch.store.read().jobs[0]?.failures, 2);

	const many = bench(t, [job(), job({ id: "cp-r2", external_ref: "https://github.com/acme/widgets/pull/8" })]);
	const capped = new ForeignCiWatch({ ...many.deps, maxPerTick: 1 });
	const tick = await capped.tick();
	assert.deepEqual([tick.checked, tick.deferred], [["cp-r1"], ["cp-r2"]]);
});

test("the store is a total read: a corrupt file is no memory, and the next write is valid", async (t) => {
	const b = bench(t);
	mkdirSync(dirname(b.watch.store.file), { recursive: true });
	writeFileSync(b.watch.store.file, "{ not json");
	assert.deepEqual(b.watch.store.read().jobs, []);
	await b.watch.tick();
	assert.ok(validateForeignCiWatchFile(JSON.parse(readFileSync(join(b.home, LAYOUT.foreignCiWatchFile), "utf8"))).ok);
});

test("evidence only: the ports are read-only, the module reaches no merge or wake path, and its query never waits", () => {
	const b = bench({ after: () => {} });
	assert.deepEqual(Object.keys(b.deps).sort(), ["home", "intervalMs", "jobs", "now", "ownPrUrls", "pr", "repoOf", "runs"]);
	const source = readFileSync(join(REPO_ROOT, "src/foreign-ci-watch.ts"), "utf8");
	for (const banned of ["./integrate.ts", "./wakeups.ts", "./wakeup-outbox.ts", "sendWakeup", "gh pr merge", "rerun", "comment("]) {
		assert.equal(source.includes(banned), false, `foreign-ci-watch.ts must not reach ${banned}`);
	}
	assert.equal(detectCiWait(["gh", ...foreignRunsArgs("acme", "widgets", HEAD)].join(" ")), undefined);
	assert.throws(() => foreignRunsArgs("acme", "widgets", "HEAD;rm"), /malformed head sha/);
});

test("the reviewer gate waits for CI, then carries its state into the brief; past the timeout it goes ahead with CI unknown", async (t) => {
	const b = bench(t);
	const reviewer = job();
	assert.throws(() => b.watch.gate(reviewer), (error: unknown) => error instanceof ForeignCiWaitError && error instanceof BlockedDispatchError && error.blockers.length === 0 && /waits for CI on https:\/\/github\.com\/acme\/widgets\/pull\/7 to complete \(not observed yet\)/.test(error.message));
	b.state.runs = [{ status: "in_progress", conclusion: null, headSha: HEAD, databaseId: 11 }];
	await b.watch.tick();
	assert.throws(() => b.watch.gate(reviewer), /in_progress on d48a81d1f4d3/);
	assert.match(b.watch.gate(reviewer, new Date("2026-10-06T11:00:00Z"))!.line, /CI unknown — not completed within 60 min of 2026-10-06T10:00:00Z \(last seen: in_progress on d48a81d1f4d3\)/);
	b.state.runs = [{ status: "completed", conclusion: "success", headSha: HEAD, databaseId: 11 }];
	b.later(10 * 60_000);
	await b.watch.tick();
	assert.equal(b.watch.gate(reviewer)!.line, `${PR}: CI green on d48a81d1f4d3 (foreign CI watch, head observed 2026-10-06T10:05:00Z; if the PR head is no longer d48a81d1f4d3, CI for it is unknown).`);

	assert.equal(b.watch.gate(job({ labels: ["project:widgets", "delivery:local", "kind:research"] })), undefined, "no schedule label: not a fan-out reviewer");
	assert.equal(b.watch.gate(job({ labels: ["project:widgets", "delivery:pr", "kind:ship", "schedule:sch-abc123"] })), undefined, "not research");
	assert.equal(b.watch.gate(job({ external_ref: "https://github.com/acme/other/pull/1" })), undefined, "not the project's repo");
	const offHome = createScratchHome();
	t.after(() => offHome.cleanup());
	const off = new ForeignCiWatch({ ...b.deps, home: offHome.path, disabled: () => "gh is not available" });
	assert.match(off.gate(reviewer)!.line, /CI unknown — the CI watch is off \(gh is not available\)/);

	const snapshot = await referencedMaterial({ task: "review it", prefix: "cp", clone: b.home, worktree: b.home, home: b.home, foreignCi: `${PR}: CI unknown — PR merged.` });
	assert.match(snapshot, /### Foreign CI\nhttps:\/\/github\.com\/acme\/widgets\/pull\/7: CI unknown — PR merged\./);
});

test("CommandPost.dispatch arms a waiting reviewer; the armed release (no blockers) re-runs the gate every pass and starts it only once CI completed", async (t) => {
	const home = createScratchHome();
	const lock = acquireParentLock({ home: home.path });
	assert.equal(lock.ok, true);
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(() => {
		post.runs.closeAll();
		releaseParentLock({ home: home.path });
		home.cleanup();
	});
	const created = await createScratchLedger({ home: home.path }).ledger.create({ title: "Review acme/widgets#7", project: "widgets", delivery: "local", kind: "research", labels: ["schedule:sch-abc123"], externalRef: PR });
	(post.registry as { get: (name: string) => unknown }).get = (name) => (name === "widgets" ? { name, clone_url: "https://github.com/acme/widgets.git" } : undefined);
	// Only the spawn is stubbed: CommandPost.dispatch, its gate and the armed release are the real ones.
	const spawned: DispatchRequest[] = [];
	Object.assign(post, { dispatcher: () => ({ dispatch: async (request: DispatchRequest) => (spawned.push(request), { state: "dispatched", job_id: request.jobId }) }) });

	let refusal: unknown;
	await post.dispatch({ jobId: created.id, task: "review it" }).catch((error: unknown) => (refusal = error));
	assert.ok(refusal instanceof ForeignCiWaitError && /waits for CI/.test(refusal.message), String(refusal));
	assert.deepEqual(post.fleet.list(), [], "nothing was taken");
	post.armedDispatches.arm(created.id, { task: "review it" }, refusal.blockers); // what cp_dispatch does with it
	await post.armedDispatches.release();
	await post.armedDispatches.release();
	assert.deepEqual([spawned, post.armedDispatches.ids()], [[], [created.id]], "zero blockers never release vacuously: still armed while CI runs");

	post.foreignCi.store.write([{ job_id: created.id, pr_url: PR, head_sha: HEAD, head_observed_at: "2026-10-06T10:05:00Z", last_ci: "green", failures: 0, announced: [] }]);
	await post.armedDispatches.release();
	assert.deepEqual(post.armedDispatches.ids(), [], "started, so disarmed");
	assert.equal(spawned.length, 1);
	assert.match(spawned[0]!.foreignCi ?? "", /^https:\/\/github\.com\/acme\/widgets\/pull\/7: CI green on d48a81d1f4d3 /);
});
