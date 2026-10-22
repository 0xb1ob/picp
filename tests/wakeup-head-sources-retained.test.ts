import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWakeup, verdictStamp, wakeupFacts, WAKEUP_SOURCE_FAILURE_MEMORY, type ReviewWakeupFacts, type WakeupStamp } from "../src/wakeups.ts";
import { type HeadSourcePost, sourceFailureRecorder, wakeupHeadSources } from "../extensions/command-post/index.ts";

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

test("the failure journal is once per (source, job), and its memory is bounded (pi-command-post-8ok)", () => {
	const limit = 4;
	const journaled: string[] = [];
	const record = sourceFailureRecorder((source, jobId, reason) => journaled.push(`${source}:${jobId}:${reason}`), limit);
	for (let repeat = 0; repeat < 5; repeat += 1) record("fleetHead", "cp-a", new Error("unreadable"));
	assert.deepEqual(journaled, ["fleetHead:cp-a:unreadable"]);
	record("ciHead", "cp-a", new Error("unreadable"));
	assert.equal(journaled.length, 2);
	record("fleetHead", "cp-b", new Error("unreadable"));
	record("ciHead", "cp-b", new Error("unreadable"));
	assert.equal(journaled.length, 4, "four distinct keys, four lines, memory exactly at the cap");
	record("fleetHead", "cp-a", new Error("unreadable"));
	assert.equal(journaled.length, 4, "at the cap the key is still remembered: nothing is re-journaled yet");
	record("fleetHead", "cp-c", new Error("unreadable"));
	assert.equal(journaled.length, 5, "the key that trips the cap is journaled");
	for (let repeat = 0; repeat < 3; repeat += 1) record("fleetHead", "cp-a", new Error("unreadable"));
	assert.equal(journaled.length, 6, "exactly one re-journal after the clear, not one per call");
	assert.equal(journaled.at(-1), "fleetHead:cp-a:unreadable");
	const thrower = sourceFailureRecorder(() => {
		throw new Error("run log unwritable");
	});
	assert.doesNotThrow(() => thrower("ciHead", "cp-a", new Error("boom")));
	const reasons: string[] = [];
	sourceFailureRecorder((_source, _jobId, reason) => reasons.push(reason))("ciHead", "cp-a", new Error("x".repeat(900)));
	assert.equal(reasons[0]?.length, 300);
	assert.ok(Number.isInteger(WAKEUP_SOURCE_FAILURE_MEMORY) && WAKEUP_SOURCE_FAILURE_MEMORY > 0);
});
