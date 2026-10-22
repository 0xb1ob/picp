import assert from "node:assert/strict";
import { test } from "node:test";
import { CiWatch, ciEventKey, deriveCiEvents, isWatched, type WatchableRecord, type PrObservation, type CiObservation } from "../src/ci-watch.ts";
import { CI_WATCH_INTERVAL_MS, CI_WATCH_MAX_BACKOFF_MS, type Delivery, type JobPhase, type Receipt } from "../src/contracts.ts";
import type { CiRun } from "../src/merge-ask.ts";
import { createScratchHome } from "./harness/index.ts";
import { isGitlabJob, watchChangeRequest } from "../src/forge-runtime.ts";
import type { ForgeObserver } from "../src/forges/adapter.ts";

// Originals stay whole by operator ruling; the retirement follow-up removes the duplicate source declarations.
const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const NEW_HEAD = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
const PR = "https://github.com/0xb1ob/pi-command-post/pull/58";
const NOW = new Date("2026-08-31T18:00:00Z");

function record(overrides: Partial<WatchableRecord> = {}): WatchableRecord {
	return {
		job_id: "cp-4wz",
		branch: "cp-4wz",
		project: "pi-command-post",
		phase: "held" as JobPhase,
		delivery: "pr" as Delivery,
		reported_at: "2026-08-31T17:00:00Z",
		receipts: [{ kind: "pr", status: "open", title: "PR for cp-4wz", url: PR }] as Receipt[],
		...overrides,
	};
}

function run(overrides: Partial<CiRun> = {}): CiRun {
	return { status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", ...overrides };
}

function pr(overrides: Partial<PrObservation> = {}): PrObservation {
	return { merged: false, state: "open", number: 58, url: PR, head_sha: HEAD, head_ref: "cp-4wz", ...overrides };
}

interface Bench {
	watch: CiWatch;
	home: string;
	state: { jobs: WatchableRecord[]; pr?: PrObservation; runs: CiRun[]; prError?: string; runsError?: string };
	queries: { pr: number; runs: number };
	observed: CiObservation[];
	disabled: string[];
	setNow(at: Date | string): void;
	now(): Date;
}

function benchOf(
	t: { after(fn: () => void | Promise<void>): void },
	options: { jobs?: WatchableRecord[]; retrySeconds?: number } = {},
): Bench {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	let clock = NOW;
	const state: Bench["state"] = { jobs: options.jobs ?? [record()], pr: pr(), runs: [run()] };
	const queries = { pr: 0, runs: 0 };
	const observed: CiObservation[] = [];
	const disabled: string[] = [];
	const watch = new CiWatch({
		home: home.path,
		jobs: () => state.jobs,
		pr: async () => {
			queries.pr += 1;
			if (state.prError) throw new Error(state.prError);
			return state.pr;
		},
		runs: async () => {
			queries.runs += 1;
			if (state.runsError) throw new Error(state.runsError);
			return state.runs;
		},
		now: () => clock,
		intervalMs: CI_WATCH_INTERVAL_MS,
		...(options.retrySeconds !== undefined ? { retrySeconds: options.retrySeconds } : {}),
		onObserved: (_jobId, observation) => observed.push(observation),
		onDisabled: (reason) => disabled.push(reason),
	});
	return {
		watch,
		home: home.path,
		state,
		queries,
		observed,
		disabled,
		now: () => clock,
		setNow(at) {
			clock = typeof at === "string" ? new Date(at) : at;
		},
	};
}

function advance(bench: Bench, ms: number): void {
	bench.setNow(new Date(bench.now().getTime() + ms));
}

test("a job whose envelope slot was reopened by a promote is not watched", () => {
	const reopened = record({ reported_at: undefined });
	delete (reopened as { reported_at?: string }).reported_at;
	assert.equal(isWatched(reopened), false);
});

test("rerunwake-12z: the derived key carries the attempt, and stays historical without a run id", () => {
	const facts = { jobId: "cp-4wz", branch: "cp-4wz", pr: pr(), head: { sha: HEAD } };
	const attempt1 = deriveCiEvents({ ...facts, runs: [run({ conclusion: "failure", databaseId: 77, attempt: 1 })] });
	const attempt2 = deriveCiEvents({ ...facts, runs: [run({ conclusion: "failure", databaseId: 77, attempt: 2 })] });
	assert.equal(attempt1[0]?.event, "ci_failed");
	assert.notEqual(attempt1[0]?.key, attempt2[0]?.key, "a re-run that fails again is a new fact");
	const legacy = deriveCiEvents({ ...facts, runs: [run({ conclusion: "failure" })] });
	assert.equal(legacy[0]?.key, ciEventKey("cp-4wz", HEAD, "ci_failed"), "no run id keeps the old key shape");
});

test("a missing gh disables the watch, says so once, and emits nothing", async (t) => {
	const bench = benchOf(t);
	bench.state.prError = "spawn gh ENOENT";
	const first = await bench.watch.tick();
	assert.ok(first.disabled);
	assert.deepEqual(first.observations, []);
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	const second = await bench.watch.tick();
	assert.ok(second.disabled);
	assert.deepEqual(second.observations, []);
	assert.equal(bench.disabled.length, 1, "an alarm that fires every tick is an alarm nobody reads");
	assert.equal(bench.queries.pr, 1, "a disabled watch stops querying");
});

test("forge PR 3: missing gh stops only the GitHub job; a GitLab MR is still observed, claims no CI while open and wakes once on merge", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const MR = "https://gitlab.example.com/group/sub/repo/-/merge_requests/7";
	const gitlab = record({ job_id: "cp-gl", branch: "cp-gl", project: "gl", receipts: [{ kind: "pr", status: "open", title: "MR for cp-gl", url: MR }] as Receipt[] });
	let state: "open" | "merged" = "open";
	const observer: ForgeObserver = {
		provider: "gitlab",
		readChangeRequest: async () => ({
			ok: true,
			observation: { provider: "gitlab", url: MR, number: 7, state, source_branch: "cp-gl", target_branch: "develop", head_sha: HEAD, ...(state === "merged" ? { squash_commit_sha: NEW_HEAD, merged_at: "2026-08-31T18:30:00Z" } : {}) },
		}),
	};
	let clock = NOW;
	const ghCalls: string[] = [];
	const disabled: string[] = [];
	const watchOf = () =>
		new CiWatch({
			home: home.path,
			jobs: () => [record(), gitlab],
			pr: (job, prUrl) =>
				watchChangeRequest(home.path, job.project, prUrl, async () => {
					ghCalls.push(job.job_id);
					throw new Error("spawn gh ENOENT");
				}, observer),
			runs: async (job) => (isGitlabJob(job) ? [] : assert.fail("runs is never asked once gh is gone")),
			now: () => clock,
			onDisabled: (reason) => disabled.push(reason),
		});
	const watch = watchOf();

	const first = await watch.tick();
	assert.match(first.disabled ?? "", /gh is not available/);
	assert.deepEqual(first.checked, ["cp-4wz", "cp-gl"], "the GitLab job is checked in the same tick gh went missing");
	assert.deepEqual(first.observations, [], "an open MR with no CI read is neither green nor a no-CI claim");

	state = "merged";
	clock = new Date(clock.getTime() + CI_WATCH_MAX_BACKOFF_MS);
	const second = await watch.tick();
	assert.deepEqual(second.checked, ["cp-gl"]);
	assert.deepEqual(second.observations.map((o) => [o.job_id, o.event, o.merge_commit_sha, o.pr_url, o.pr_number]), [["cp-gl", "pr_merged", NEW_HEAD, MR, 7]]);
	assert.deepEqual(ghCalls, ["cp-4wz"], "gh was asked once, then the GitHub job stopped being queried");
	assert.equal(disabled.length, 1);

	clock = new Date(clock.getTime() + CI_WATCH_MAX_BACKOFF_MS * 10);
	const restarted = await watchOf().tick();
	assert.deepEqual(restarted.observations.map((o) => o.key), second.observations.map((o) => o.key), "a restart re-derives the same event identity");
});
