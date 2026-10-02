/**
 * pi-command-post-b04, finding 2: the *production* head wiring is tested, not a
 * lookalike built in a test.
 *
 * The two readings `headMoved` compares only exist because
 * `extensions/command-post/index.ts` supplies them, and the old wiring wrapped
 * each lookup in a bare `catch` that returned `undefined`. That value is
 * byte-identical to "this home has no such fact", so a `reportedHeadSha` that
 * started throwing would have silently put the lagging CI observation back in
 * charge of head freshness — the exact defect this fix removes — with nothing
 * anywhere to say so.
 *
 * So the wiring is one exported unit (`wakeupHeadSources`), asserted here
 * against the accessors it must call, and a failing source is asserted to be
 * *observable* (reported) and *fail-safe* (superseding nothing) rather than
 * indistinguishable from silence.
 *
 * `node --test tests/wakeup-head-sources.test.ts`
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CiWatch, type PrObservation, type WatchableRecord } from "../src/ci-watch.ts";
import { CommandPost } from "../src/command-post.ts";
import {
	CI_WATCH_MAX_BACKOFF_MS,
	EMPTY_USAGE,
	isoTimestamp,
	paths,
	type Receipt,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import {
	checkWakeup,
	verdictStamp,
	wakeupFacts,
	WAKEUP_SOURCE_FAILURE_MEMORY,
	type ReviewWakeupFacts,
	type WakeupStamp,
} from "../src/wakeups.ts";
import { type HeadSourcePost, sourceFailureRecorder, wakeupHeadSources } from "../extensions/command-post/index.ts";
import { createScratchHome } from "./harness/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "a39e4425b7b4".padEnd(40, "0");
const OBSERVED = "3d3355f0c4d2".padEnd(40, "0");

test("the extension's head sources call the command post accessors, with no catch of their own", () => {
	const calls: string[] = [];
	const post: HeadSourcePost = {
		ciHead: (jobId) => (calls.push(`ciHead:${jobId}`), OBSERVED),
		ciHeadObservedAt: (jobId) => (calls.push(`ciHeadObservedAt:${jobId}`), "2026-08-31T12:40:00Z"),
		reportedHeadSha: (jobId) => (calls.push(`reportedHeadSha:${jobId}`), HEAD),
		reportedHeadAt: (jobId) => (calls.push(`reportedHeadAt:${jobId}`), "2026-08-31T12:45:43Z"),
	};
	const sources = wakeupHeadSources(post);

	assert.equal(sources.ciHead?.("cp-w"), OBSERVED);
	assert.equal(sources.ciHeadObservedAt?.("cp-w"), "2026-08-31T12:40:00Z");
	assert.equal(sources.fleetHead?.("cp-w"), HEAD, "fleetHead must be the head the job reported");
	assert.equal(sources.fleetHeadAt?.("cp-w"), "2026-08-31T12:45:43Z");
	assert.deepEqual(calls, [
		"ciHead:cp-w",
		"ciHeadObservedAt:cp-w",
		"reportedHeadSha:cp-w",
		"reportedHeadAt:cp-w",
	]);

	// Catch-free by contract: the failure must reach `wakeupFacts`, which is the
	// only place that can tell "it threw" from "it had nothing to say".
	const broken = wakeupHeadSources({
		...post,
		reportedHeadSha: () => {
			throw new Error("envelope unreadable");
		},
	});
	assert.throws(() => broken.fleetHead?.("cp-w"), /envelope unreadable/);
});

test("a head source that throws is reported and supersedes nothing, instead of reading as an absent fact", () => {
	const reported: { source: string; jobId: string; message: string }[] = [];
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-w|review", { decided: [1] }]]);
	const facts = wakeupFacts({
		record: () => ({ phase: "held" as const, reported_at: "2026-08-31T12:45:43Z" }),
		review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
		...wakeupHeadSources({
			ciHead: () => OBSERVED,
			ciHeadObservedAt: () => "2026-08-31T12:50:00Z",
			reportedHeadSha: () => {
				throw new Error("envelope unreadable");
			},
			reportedHeadAt: () => undefined,
		}),
		onSourceFailure: (source, jobId, error) => reported.push({ source, jobId, message: error.message }),
	});

	const stamp: WakeupStamp = { ...verdictStamp("cp-w", "review", 1, HEAD), issued_at: "2026-08-31T12:46:00Z" };
	const verdict = checkWakeup(stamp, facts, new Date("2026-08-31T12:51:00Z"));

	assert.equal(verdict.state, "fresh", "a broken authority must not withhold the card on head grounds");
	assert.deepEqual(
		reported.map((entry) => `${entry.source}:${entry.jobId}`),
		["fleetHead:cp-w"],
		"the failure is a fact somewhere, not a silence",
	);
	assert.match(reported[0]?.message ?? "", /envelope unreadable/);
	assert.equal(facts.job("cp-w")?.fleet_head_degraded, true);
});

test("CommandPost.reportedHeadSha/reportedHeadAt read the envelope the sources are wired to", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await post.fleet.add({
		job_id: "cp-w",
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: "operator",
		phase: "held",
		reported_at: "2026-08-31T12:45:43Z",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home.path, "wt"),
		branch: "cp-w",
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	});
	mkdirSync(join(home.path, paths.runDir("cp-w")), { recursive: true });
	writeFileSync(
		join(home.path, paths.envelopeFile("cp-w")),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			job_id: "cp-w",
			received_at: "2026-08-31T12:45:43Z",
			attempt: 1,
			envelope: { job_id: "cp-w", kind: "ship", status: "done", summary: "s", head_sha: HEAD },
		}),
	);

	const sources = wakeupHeadSources(post);
	assert.equal(sources.fleetHead?.("cp-w"), HEAD);
	assert.equal(sources.fleetHeadAt?.("cp-w"), "2026-08-31T12:45:43Z", "the reading needs the moment it was taken");
	// No CI watch state yet: an absent observation is undefined, never a throw.
	assert.equal(sources.ciHead?.("cp-w"), undefined);
	assert.equal(sources.ciHeadObservedAt?.("cp-w"), undefined);

	// And the other production accessor pair, against the watcher's own file: the
	// head it observed, and the moment it observed it (pi-command-post-8ok).
	post.ciWatch.store.record("cp-w", {
		head_sha: OBSERVED,
		head_observed_at: "2026-08-31T12:40:00Z",
		last_checked_at: "2026-08-31T13:30:00Z",
	});
	assert.equal(sources.ciHead?.("cp-w"), OBSERVED);
	assert.equal(
		sources.ciHeadObservedAt?.("cp-w"),
		"2026-08-31T12:40:00Z",
		"the age of the head, never the age of the last attempt",
	);
});

test("the failure journal is once per (source, job), and its memory is bounded (pi-command-post-8ok)", () => {
	// The production `onSourceFailure`. Journaling once per key is what keeps a
	// broken wiring from writing a line on every provider request — and that memory
	// is keyed by job id, so the bound on the journal left the memory itself
	// growing with the session. Both properties are asserted here, on the unit the
	// extension actually installs.
	const limit = 4;
	const journaled: string[] = [];
	const record = sourceFailureRecorder((source, jobId, reason) => journaled.push(`${source}:${jobId}:${reason}`), limit);

	// Once per key, however many times the same failure recurs.
	for (let repeat = 0; repeat < 5; repeat += 1) record("fleetHead", "cp-a", new Error("unreadable"));
	assert.deepEqual(journaled, ["fleetHead:cp-a:unreadable"]);
	// The two sources are different facts about the same job.
	record("ciHead", "cp-a", new Error("unreadable"));
	assert.equal(journaled.length, 2);

	// The off-by-one boundary: `limit` distinct keys fit, and the key that would
	// make it `limit + 1` clears the memory first — so cardinality never exceeds
	// `limit`, which is what the previous keys being forgotten proves below.
	record("fleetHead", "cp-b", new Error("unreadable"));
	record("ciHead", "cp-b", new Error("unreadable"));
	assert.equal(journaled.length, 4, "four distinct keys, four lines, memory exactly at the cap");
	record("fleetHead", "cp-a", new Error("unreadable"));
	assert.equal(journaled.length, 4, "at the cap the key is still remembered: nothing is re-journaled yet");

	// One key past it clears, and every earlier key is then news exactly once more.
	record("fleetHead", "cp-c", new Error("unreadable"));
	assert.equal(journaled.length, 5, "the key that trips the cap is journaled");
	for (let repeat = 0; repeat < 3; repeat += 1) record("fleetHead", "cp-a", new Error("unreadable"));
	assert.equal(journaled.length, 6, "exactly one re-journal after the clear, not one per call");
	assert.equal(journaled.at(-1), "fleetHead:cp-a:unreadable");

	// A sink that throws must not turn a degraded reading into a thrown one, and a
	// long reason is a reason, never a stack.
	const thrower = sourceFailureRecorder(() => {
		throw new Error("run log unwritable");
	});
	assert.doesNotThrow(() => thrower("ciHead", "cp-a", new Error("boom")));
	const reasons: string[] = [];
	sourceFailureRecorder((_source, _jobId, reason) => reasons.push(reason))("ciHead", "cp-a", new Error("x".repeat(900)));
	assert.equal(reasons[0]?.length, 300);

	// And the production default is a real bound, not an off switch.
	assert.ok(Number.isInteger(WAKEUP_SOURCE_FAILURE_MEMORY) && WAKEUP_SOURCE_FAILURE_MEMORY > 0);
});

test("a long-lagging watcher delivers the verdict eventually, and terminates it definitively (pi-command-post-8ok)", async (t) => {
	// The two halves of finding 3, through the production accessors
	// (`CiWatch.head`/`observedAt`) rather than hand-built stubs, on a fake clock.
	//
	// A worker rebased, pushed HEAD and reported it at 12:45:43; the diff review
	// passed on that same head; the watcher's last successful read was OBSERVED at
	// 12:40. Then `gh` goes away for an hour. Every failed query used to advance
	// the one timestamp that says how old the observation is, so within a minute
	// the pre-rebase head read as the *later* reading and withheld the pass — and
	// it got fresher on every retry, so the card could never arrive.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const PR = "https://github.com/o/r/pull/58";
	const record: WatchableRecord = {
		job_id: "cp-w",
		branch: "cp-w",
		project: "demo",
		phase: "held",
		delivery: "pr",
		reported_at: "2026-08-31T12:45:43Z",
		receipts: [{ kind: "pr", status: "open", title: "PR", url: PR }] as Receipt[],
	};
	let clock = new Date("2026-08-31T12:40:00Z");
	const state: { pr: PrObservation; error?: string } = {
		pr: { merged: false, state: "open", number: 58, url: PR, head_sha: OBSERVED },
	};
	const watch = new CiWatch({
		home: home.path,
		jobs: () => [record],
		pr: async () => {
			if (state.error) throw new Error(state.error);
			return state.pr;
		},
		runs: async () => [],
		now: () => clock,
	});
	await watch.tick();
	assert.equal(watch.observedAt("cp-w"), "2026-08-31T12:40:00Z");

	const reviews = new Map<string, ReviewWakeupFacts>([["cp-w|review", { decided: [1] }]]);
	const facts = () =>
		wakeupFacts({
			record: () => ({ phase: "held" as const, reported_at: "2026-08-31T12:45:43Z" }),
			review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
			...wakeupHeadSources({
				ciHead: (jobId) => watch.head(jobId),
				ciHeadObservedAt: (jobId) => watch.observedAt(jobId),
				reportedHeadSha: () => HEAD,
				reportedHeadAt: () => "2026-08-31T12:45:43Z",
			}),
		});
	const stamp: WakeupStamp = { ...verdictStamp("cp-w", "review", 1, HEAD), issued_at: "2026-08-31T12:46:00Z" };

	// Eventual delivery: query after failing query, for over an hour, the pass on
	// the head the fleet is on stays deliverable.
	state.error = "gh api failed: 500";
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		clock = new Date(clock.getTime() + CI_WATCH_MAX_BACKOFF_MS);
		assert.equal((await watch.tick()).errors.length, 1);
		assert.equal(checkWakeup(stamp, facts(), clock).state, "fresh", `still deliverable after ${attempt} failed queries`);
	}

	// Definitive termination: the moment the watcher actually reads the remote
	// again and finds another head, that reading is genuinely the later one and
	// the pass on the abandoned head is superseded — and stays superseded.
	const MOVED = "cc55dd66ee77".padEnd(40, "0");
	delete state.error;
	state.pr = { ...state.pr, head_sha: MOVED };
	clock = new Date(clock.getTime() + CI_WATCH_MAX_BACKOFF_MS);
	await watch.tick();
	assert.equal(watch.observedAt("cp-w"), isoTimestamp(clock));
	const terminated = checkWakeup(stamp, facts(), clock);
	assert.equal(terminated.state, "superseded");
	assert.match(terminated.reason ?? "", new RegExp(MOVED.slice(0, 12)));
	clock = new Date(clock.getTime() + 10 * CI_WATCH_MAX_BACKOFF_MS);
	assert.equal(checkWakeup(stamp, facts(), clock).state, "superseded", "and it never flips back");
});
