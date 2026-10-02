/**
 * cp-p6m acceptance: a wake-up describes the fleet as it is when the parent
 * reads it, or it does not describe it at all.
 *
 * The incident these tests encode: an envelope was filed at 12:45:43, a
 * `cp_send` promote archived it a minute later (slot reopened, `reported_at`
 * cleared, phase back to `waiting`, worker alive mid-rebase), and the parent
 * then received a `cp-envelope` carrying that archived envelope's summary,
 * indistinguishable in form from a fresh report. Acting on it meant merging an
 * unrebased PR or tearing down a worker mid-rebase.
 *
 * Everything below is hermetic and dependency-injected. The transport
 * (`pi.sendMessage`) is the extension's; the notifier plays the part the
 * extension plays — stamp, check against the real fleet on disk, send or
 * withhold — and `reviewWakeups` is exactly what the extension's `context`
 * handler runs at delivery time.
 *
 * `node --test tests/wakeups.test.ts`
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { CommandPost } from "../src/command-post.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { join } from "node:path";
import { test } from "node:test";
import { AnsweredOutbox, answeredIdsFromMessage, formatAnsweredNotice } from "../src/answered.ts";
import {
	ANSWERED_MESSAGE_TYPE,
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Delivery,
	type FleetRecord,
	isoTimestamp,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
	VERDICT_MESSAGE_TYPE,
	WAKEUP_LATE_SECONDS,
} from "../src/contracts.ts";
import { type CiWatchTick, ciEventKey } from "../src/ci-watch.ts";
import { MainCiStore } from "../src/main-ci.ts";
import type { CommandRunner } from "../src/merge-ask.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, formatIntake, type IntakeResult } from "../src/intake.ts";
import { RunRegistry } from "../src/runs.ts";
import { reopenEnvelopeSlot } from "../src/supersede.ts";
import {
	checkWakeup,
	formatReplayedCiWakeup,
	formatStaleWakeup,
	REPLAYED_WAKEUP_HEADLINE,
	reviewWakeups,
	STALE_WAKEUP_HEADLINE,
	toolCallKey,
	type StatusJobLike,
	type WakeupCarrier,
	type WakeupFactSources,
	type WakeupMessage,
	type WakeupReplayMemory,
	type WakeupStamp,
	WAKEUP_SOURCE_FAILURE_MEMORY,
	WakeupNotifier,
	wakeupFacts,
	wakeupStampOf,
	verdictKeysFromMessage,
	verdictStamp,
	type ReviewWakeupFacts,
} from "../src/wakeups.ts";
import { createScratchHome, readRunEvents, type ScratchHome } from "./harness/index.ts";

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	/** Every wake-up that actually reached the "session", in order. */
	sent: WakeupMessage[];
	/** Every wake-up that was withheld, with the reason it was withheld. */
	withheld: { stamp: WakeupStamp; reason: string }[];
	/** The parent's send path: stamp, re-check against disk, send or withhold. */
	notify(stamp: Omit<WakeupStamp, "issued_at"> & { issued_at?: string }, content: string, details?: Record<string, unknown>): boolean;
	/** Live status facts for a job, when a test wants a worker to be alive. */
	status: Map<string, StatusJobLike>;
	now: () => Date;
	setNow(at: string): void;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const sent: WakeupMessage[] = [];
	const withheld: { stamp: WakeupStamp; reason: string }[] = [];
	const status = new Map<string, StatusJobLike>();
	let clock = new Date("2026-08-31T12:45:43Z");
	const now = () => clock;
	const intake = new EnvelopeIntake({
		home: home.path,
		fleet,
		runs,
		now,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
	});
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const bench: Bench = {
		home,
		fleet,
		runs,
		intake,
		sent,
		withheld,
		status,
		now,
		setNow(at: string) {
			clock = new Date(at);
		},
		notify(stamp, content, details = {}) {
			const notifier = new WakeupNotifier({
				facts: wakeupFacts({
					record: (jobId) => fleet.get(jobId),
					statusJob: (jobId) => status.get(jobId),
				}),
				send: (message) => sent.push(message),
				now,
				onSuppressed: (suppressed, verdict) => withheld.push({ stamp: suppressed, reason: verdict.reason ?? "" }),
			});
			return notifier.send(stamp, content, details).sent;
		},
	};
	return bench;
}

function facts(bench: Bench) {
	return wakeupFacts({
		record: (jobId) => bench.fleet.get(jobId),
		statusJob: (jobId) => bench.status.get(jobId),
	});
}

function jobRecord(home: string, jobId: string, delivery: Delivery = "pr"): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery,
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home, "wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
}

function writeEnvelopeFile(home: string, jobId: string, envelope: Record<string, unknown>): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(home, paths.envelopeFile(jobId)),
		`${JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1, envelope }, null, 2)}\n`,
	);
}

const SHIPPED = (jobId: string, pr = "https://github.com/o/r/pull/44") => ({
	job_id: jobId,
	kind: "ship" as const,
	status: "done" as const,
	summary: "Diff-gate false positive fixed; PR green on c68f8e2.",
	branch: jobId,
	pr_url: pr,
});

/** The message the parent's session is holding, as pi would hold it. */
function asCarrier(message: WakeupMessage): WakeupCarrier {
	return {
		role: "custom",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: message.details,
		timestamp: Date.parse("2026-08-31T12:45:43Z"),
	};
}

/** The parent reports; the wake-up is stamped from the intake result. */
function envelopeStamp(result: IntakeResult): Omit<WakeupStamp, "issued_at"> {
	return {
		kind: "envelope",
		job_id: result.job_id,
		...(result.generation !== undefined ? { generation: result.generation } : {}),
		...(result.reported_at ? { reported_at: result.reported_at } : {}),
	};
}

// ---------------------------------------------------------------------------
// 1. the incident: an archived envelope's wake-up
// ---------------------------------------------------------------------------

test("a wake-up for an envelope a promote archived is withheld, and never reads as a fresh report", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-fp0"));

	// 12:45:43 — the worker reports. The wake-up is fresh and it is sent.
	writeEnvelopeFile(b.home.path, "cp-fp0", SHIPPED("cp-fp0"));
	const reported = await b.intake.intake("cp-fp0");
	assert.equal(reported.generation, 1);
	assert.ok(reported.reported_at, "the report's own timestamp travels with the news");
	const stamp = envelopeStamp(reported);
	assert.equal(b.notify(stamp, formatIntake(reported), reported as unknown as Record<string, unknown>), true);
	assert.equal(b.sent.length, 1);
	const inFlight = asCarrier(b.sent[0] as WakeupMessage);

	// 12:46:54 — the parent promotes the live worker to rebase and re-verify.
	// The slot reopens: envelope.json is archived, reported_at is cleared, the
	// job is `waiting` again, and the worker is alive inside the rebase.
	b.setNow("2026-08-31T12:46:54Z");
	b.status.set("cp-fp0", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 7 });
	await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-fp0",
		reason: "promoted with a new brief (cp_send)",
		now: b.now,
	});
	const record = b.fleet.require("cp-fp0");
	assert.equal(record.reported_at, undefined);
	assert.equal(record.phase, "waiting");

	// (a) Send time: the same news, emitted a moment too late, is not sent.
	b.setNow("2026-08-31T12:47:30Z");
	assert.equal(b.notify(stamp, formatIntake(reported), {}), false, "a stale envelope wake-up is never sent");
	assert.equal(b.sent.length, 1, "nothing new reached the session");
	assert.match(b.withheld.at(-1)?.reason ?? "", /reopened|archived/);

	// (b) Delivery time: the message that was ALREADY queued — the actual
	// incident, since pi's followUp queue delivered it minutes late — is
	// rewritten before the model ever sees it.
	const review = reviewWakeups([inFlight], facts(b), new Date("2026-08-31T12:47:30Z"));
	assert.equal(review.changed, true);
	assert.equal(review.superseded.length, 1);
	assert.equal(review.superseded[0]?.stamp.generation, 1);
	const delivered = review.messages[0]?.content as string;
	assert.match(delivered, new RegExp(STALE_WAKEUP_HEADLINE));
	assert.match(delivered, /generation 1/);
	assert.match(delivered, /\/watch cp-fp0/);
	assert.ok(
		!delivered.includes("Diff-gate false positive fixed"),
		"the archived envelope's summary is exactly what must not travel",
	);
	assert.ok(!delivered.includes("pull/44"), "and neither is its PR url, which somebody would have merged");
});

test("a wake-up for a job that was already merged, torn down and closed is superseded", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-g1b"));
	writeEnvelopeFile(b.home.path, "cp-g1b", SHIPPED("cp-g1b", "https://github.com/o/r/pull/41"));
	const reported = await b.intake.intake("cp-g1b");
	const message = (() => {
		b.notify(envelopeStamp(reported), formatIntake(reported), {});
		return asCarrier(b.sent[0] as WakeupMessage);
	})();

	// The PR merged and the parent tore the job down turns ago.
	await b.fleet.patch("cp-g1b", { phase: "done", closed_at: "2026-08-31T12:45:52Z" });

	const review = reviewWakeups([message], facts(b), new Date("2026-08-31T12:49:00Z"));
	assert.equal(review.changed, true);
	assert.match(review.superseded[0]?.verdict.reason ?? "", /already done/);
	assert.ok(!(review.messages[0]?.content as string).includes("pull/41"));
});

// ---------------------------------------------------------------------------
// 2. the current generation is untouched
// ---------------------------------------------------------------------------

test("a wake-up for the current generation is delivered verbatim", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-live"));
	writeEnvelopeFile(b.home.path, "cp-live", SHIPPED("cp-live"));
	const reported = await b.intake.intake("cp-live");

	assert.equal(b.notify(envelopeStamp(reported), formatIntake(reported), {}), true);
	const message = asCarrier(b.sent[0] as WakeupMessage);
	assert.match(message.content as string, /cp-live reported done \(ship\/pr\) → hold/);

	const review = reviewWakeups([message], facts(b), new Date("2026-08-31T12:45:44Z"));
	assert.equal(review.changed, false);
	assert.equal(review.superseded.length, 0);
	assert.equal(review.messages[0]?.content, message.content, "a true wake-up is not touched");
	assert.match(review.messages[0]?.content as string, /Diff-gate false positive fixed/);
});

test("the superseding report of the next generation is itself a fresh wake-up", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-two"));
	writeEnvelopeFile(b.home.path, "cp-two", SHIPPED("cp-two"));
	const first = await b.intake.intake("cp-two");
	b.notify(envelopeStamp(first), formatIntake(first), {});

	await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-two",
		reason: "promoted with a new brief (cp_send)",
		now: b.now,
	});
	b.setNow("2026-08-31T12:52:00Z");
	writeEnvelopeFile(b.home.path, "cp-two", SHIPPED("cp-two"));
	const second = await b.intake.intake("cp-two");
	assert.equal(second.generation, 2);

	assert.equal(b.notify(envelopeStamp(second), formatIntake(second), {}), true);
	const messages = b.sent.map(asCarrier);
	assert.match(messages[1]?.content as string, /\[generation 2\]/, "the generation is on the face of the message");

	// Both messages are in the parent's context. Exactly one still describes the
	// job: the first is superseded, the second is the delivery.
	const review = reviewWakeups(messages, facts(b), new Date("2026-08-31T12:52:01Z"));
	assert.equal(review.superseded.length, 1);
	assert.equal(review.superseded[0]?.stamp.generation, 1);
	assert.match(review.messages[0]?.content as string, new RegExp(STALE_WAKEUP_HEADLINE));
	assert.equal(review.messages[1]?.content, messages[1]?.content);
});

// ---------------------------------------------------------------------------
// 3. reported=false never produces a "reported" wake-up
// ---------------------------------------------------------------------------

test("a job with a live worker and reported=false never produces a wake-up claiming it reported", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-alive"));
	b.status.set("cp-alive", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 52 });

	// Nothing is filed: intake has nothing to accept, so no wake-up exists.
	const nothing = await b.intake.intake("cp-alive");
	assert.equal(nothing.accepted, false);
	assert.equal(b.fleet.require("cp-alive").reported_at, undefined);

	// And a wake-up that claims otherwise — a re-emission, a late delivery, a
	// bug — is refused at both ends of the path.
	const claim: Omit<WakeupStamp, "issued_at"> = {
		kind: "envelope",
		job_id: "cp-alive",
		generation: 1,
		reported_at: "2026-08-31T12:45:43Z",
	};
	assert.equal(b.notify(claim, "cp-alive reported done (ship/pr) → hold\n  All green.", {}), false);
	assert.equal(b.sent.length, 0, "no wake-up claiming a report exists for a job that has not reported");

	const forged: WakeupCarrier = {
		role: "custom",
		customType: "cp-envelope",
		content: "cp-alive reported done (ship/pr) → hold\n  All green.",
		details: { cp_wakeup: { ...claim, issued_at: "2026-08-31T12:45:43Z" } },
	};
	const review = reviewWakeups([forged], facts(b), new Date("2026-08-31T12:47:30Z"));
	assert.equal(review.changed, true);
	assert.match(review.superseded[0]?.verdict.reason ?? "", /archived|nothing is filed/);
	assert.ok(!(review.messages[0]?.content as string).includes("All green."));
});

// ---------------------------------------------------------------------------
// the other unasked wake-ups
// ---------------------------------------------------------------------------

test("an unreported-settle wake-up is withheld once the job has reported", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-nudge"));

	// The settle boundary recorded a spent nudge: true at the time.
	assert.equal(b.notify({ kind: "unreported", job_id: "cp-nudge", generation: 1 }, "cp-nudge: settled without filing an envelope.", {}), true);
	const message = asCarrier(b.sent[0] as WakeupMessage);

	// The worker then reported after all — the promoted, nudged, recovered case.
	writeEnvelopeFile(b.home.path, "cp-nudge", SHIPPED("cp-nudge"));
	await b.intake.intake("cp-nudge");

	assert.equal(b.notify({ kind: "unreported", job_id: "cp-nudge", generation: 1 }, "again", {}), false);
	const review = reviewWakeups([message], facts(b), new Date("2026-08-31T12:50:00Z"));
	assert.equal(review.changed, true);
	assert.match(review.superseded[0]?.verdict.reason ?? "", /has since reported/);
});

test("a wedged-call wake-up is withheld once that call ended or the worker died", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-wedge"));
	b.status.set("cp-wedge", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 12 });
	const stamp: Omit<WakeupStamp, "issued_at"> = {
		kind: "wedged",
		job_id: "cp-wedge",
		keys: [toolCallKey("cp-wedge", 12)],
	};
	assert.equal(b.notify(stamp, "WEDGED TOOL CALL — 1 worker has an open tool call with no output", {}), true);
	const message = asCarrier(b.sent[0] as WakeupMessage);

	// The call returned and the worker moved on to the next one.
	b.status.set("cp-wedge", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 13 });
	assert.equal(b.notify(stamp, "same notice", {}), false);
	assert.match(
		reviewWakeups([message], facts(b), new Date("2026-08-31T13:20:00Z")).superseded[0]?.verdict.reason ?? "",
		/tool call ended/,
	);

	// A dead worker's open call is over, not wedged.
	b.status.set("cp-wedge", { alive: false, run_phase: "working", current_tool: "bash", tool_calls: 12 });
	assert.equal(b.notify(stamp, "same notice", {}), false);
	assert.match(b.withheld.at(-1)?.reason ?? "", /worker for cp-wedge is gone/);
});

test("cp-m44c: a wedged stamp is superseded once the job leaves run_phase working, or has reported", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-settle"));
	b.status.set("cp-settle", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 4 });
	const stamp: WakeupStamp = {
		kind: "wedged",
		job_id: "cp-settle",
		keys: [toolCallKey("cp-settle", 4)],
		issued_at: "2026-08-31T12:45:43Z",
	};

	// A genuine wedge: still alive, still working, same open call, never reported.
	const genuine = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:46:00Z"));
	assert.equal(genuine.state, "fresh");

	// The run settles (a partial settle on timeout, say) while the stamp still
	// claims a mid-call wedge: the run_phase check must catch it even though the
	// tool call key alone would still match.
	b.status.set("cp-settle", { alive: true, run_phase: "idle", current_tool: "bash", tool_calls: 4 });
	const settled = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:46:30Z"));
	assert.equal(settled.state, "superseded");
	assert.match(settled.reason ?? "", /no longer working/);

	// Restore run_phase to working, but the job has since filed an envelope: a
	// job that reported is not mid-call, whatever the open-call key says.
	b.status.set("cp-settle", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 4 });
	await b.fleet.patch("cp-settle", { reported_at: "2026-08-31T12:46:10Z" });
	const reported = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:46:40Z"));
	assert.equal(reported.state, "superseded");
	assert.match(reported.reason ?? "", /already reported/);
});

test("cp-m44c: a wedged stamp with no run_phase reading at all is withheld, not assumed genuine", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-unknown-phase"));
	// No b.status.set(...) at all: the status projection could not be read, so
	// wakeupFacts omits run_phase entirely (it stays undefined), exactly the
	// "unreadable" case the module header now documents.
	const stamp: WakeupStamp = {
		kind: "wedged",
		job_id: "cp-unknown-phase",
		keys: [toolCallKey("cp-unknown-phase", 1)],
		issued_at: "2026-08-31T12:45:43Z",
	};
	const verdict = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:46:00Z"));
	assert.equal(verdict.state, "superseded");
	assert.match(verdict.reason ?? "", /no longer working \(run phase unknown\)/);
});

test("cp-m44c: an unreported stamp with no run_phase reading at all stays fresh, the fail-safe direction", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-unknown-phase-2"));
	// Same missing-facts case as above, on the unreported branch: an unreadable
	// run_phase must not block a genuine "settled without reporting" notice, so
	// the two branches deliberately read the same missing fact in opposite
	// directions. See the module header.
	const stamp: WakeupStamp = { kind: "unreported", job_id: "cp-unknown-phase-2", generation: 1, issued_at: "2026-08-31T12:45:43Z" };
	const verdict = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:46:00Z"));
	assert.equal(verdict.state, "fresh");
});

test("cp-m44c: checkWakeup can never return fresh for both a wedged and an unreported stamp on one job", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-excl"));
	b.status.set("cp-excl", { alive: true, run_phase: "working", current_tool: "bash", tool_calls: 9 });

	const wedgedStamp: WakeupStamp = {
		kind: "wedged",
		job_id: "cp-excl",
		keys: [toolCallKey("cp-excl", 9)],
		issued_at: "2026-08-31T12:45:43Z",
	};
	const unreportedStamp: WakeupStamp = {
		kind: "unreported",
		job_id: "cp-excl",
		generation: 1,
		issued_at: "2026-08-31T12:45:43Z",
	};

	// Mid-call: wedged is fresh, and unreported cannot also be fresh for the same
	// facts because the job is still `working` (unreported requires settled).
	const checkBoth = (at: Date) => ({
		wedged: checkWakeup(wedgedStamp, facts(b), at).state,
		unreported: checkWakeup(unreportedStamp, facts(b), at).state,
	});
	const midCall = checkBoth(new Date("2026-08-31T12:46:00Z"));
	assert.equal(midCall.wedged === "fresh" && midCall.unreported === "fresh", false);

	// After settling with no envelope filed, unreported may be fresh, but wedged
	// must now be superseded by the run_phase check added above.
	b.status.set("cp-excl", { alive: true, run_phase: "idle", current_tool: null, tool_calls: 9 });
	const settled = checkBoth(new Date("2026-08-31T12:47:00Z"));
	assert.equal(settled.wedged === "fresh" && settled.unreported === "fresh", false);

	// After reporting, unreported is superseded (reported) and wedged is also
	// superseded (reported_at set): neither is fresh.
	await b.fleet.patch("cp-excl", { reported_at: "2026-08-31T12:47:10Z" });
	const reported = checkBoth(new Date("2026-08-31T12:47:30Z"));
	assert.equal(reported.wedged === "fresh" && reported.unreported === "fresh", false);
});

test("a CI wake-up is fresh on the head it describes, and superseded once that head moves", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci1"));
	writeEnvelopeFile(b.home.path, "cp-ci1", SHIPPED("cp-ci1", "https://github.com/o/r/pull/58"));
	await b.intake.intake("cp-ci1");

	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const MOVED = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
	// The third facts source (cp-e2d): the head the CI watcher last observed, read
	// from its own state file. A file, never a subprocess — this runs on every
	// provider request.
	let observedHead = HEAD;
	const ciFacts = () =>
		wakeupFacts({
			record: (jobId) => b.fleet.get(jobId),
			statusJob: (jobId) => b.status.get(jobId),
			ciHead: () => observedHead,
		});
	const stamp: WakeupStamp = { kind: "ci", job_id: "cp-ci1", generation: 1, keys: [HEAD], issued_at: "2026-08-31T12:45:43Z" };

	assert.equal(checkWakeup(stamp, ciFacts(), new Date("2026-08-31T12:45:44Z")).state, "fresh");

	// A force-push. "CI is green" was true about a sha that is now history, and a
	// message that still reads as live news is one somebody will merge on.
	observedHead = MOVED;
	const moved = checkWakeup(stamp, ciFacts(), new Date("2026-08-31T12:47:30Z"));
	assert.equal(moved.state, "superseded");
	assert.match(moved.reason ?? "", /the branch moved/);

	// A promote reopened the slot: same rule as every other kind.
	observedHead = HEAD;
	await b.fleet.patch("cp-ci1", { supersessions: 1 });
	assert.match(checkWakeup(stamp, ciFacts(), new Date("2026-08-31T12:47:30Z")).reason ?? "", /slot was reopened/);

	// Torn down: the story is over whatever GitHub says.
	await b.fleet.patch("cp-ci1", { supersessions: undefined, phase: "done", closed_at: "2026-08-31T12:48:00Z" });
	assert.match(checkWakeup(stamp, ciFacts(), new Date("2026-08-31T12:49:00Z")).reason ?? "", /already done/);
});

test("a stale cp-ci message's body is withheld, and the notice names the job", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci2"));
	writeEnvelopeFile(b.home.path, "cp-ci2", SHIPPED("cp-ci2", "https://github.com/o/r/pull/58"));
	await b.intake.intake("cp-ci2");
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";

	assert.equal(
		b.notify(
			{ kind: "ci", job_id: "cp-ci2", generation: 1, keys: [HEAD] },
			"CI/PR OBSERVED — 1 new fact about a held PR\n  cp-ci2: CI green on d48a81d1f4d3 — CI green on d48a81d",
			{ ci: [{ key: `cp-ci2|${HEAD}|ci_green` }] },
		),
		true,
	);
	const message = b.sent[0] as WakeupMessage;
	assert.equal(message.customType, "cp-ci");
	const carrier = asCarrier(message);

	// The branch moved while the followUp sat in pi's queue — the incident shape,
	// with a CI verdict instead of an envelope.
	const moved = wakeupFacts({
		record: (jobId) => b.fleet.get(jobId),
		ciHead: () => "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00",
	});
	const review = reviewWakeups([carrier], moved, new Date("2026-08-31T12:52:00Z"));
	assert.equal(review.changed, true);
	assert.equal(review.superseded.length, 1);
	const delivered = review.messages[0]?.content as string;
	assert.match(delivered, new RegExp(STALE_WAKEUP_HEADLINE));
	assert.match(delivered, /\/watch cp-ci2/);
	assert.ok(!delivered.includes("CI green on d48a81d"), "a green verdict about a superseded sha must not travel");
});

test("a CI claim is the observation's own: fleet-owned state can never withhold it (pi-command-post-8ok)", async (t) => {
	// A `cp-ci` notice is this home's read of GitHub for one commit. The fleet
	// record is not a reading of the remote — it is the head a worker *said* it
	// pushed — and letting it decide meant a fact GitHub reported could be
	// withheld by a local file. The reachable shape: `CiWatchStore.prune` drops a
	// job's row the moment it leaves the watch set (a merged receipt), so the
	// pr_merged notice already in the parent's queue is re-checked with no
	// observation left at all, and the fleet's older head reads as the current one.
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-own", "pr"));
	const OBSERVED = "d48a81d1f4d3".padEnd(40, "0");
	const FLEET = "bb77cc11dd22".padEnd(40, "0");
	const stamp: WakeupStamp = { kind: "ci", job_id: "cp-own", generation: 1, keys: [OBSERVED], issued_at: "2026-08-31T12:45:43Z" };
	const now = new Date("2026-08-31T12:52:00Z");
	const ciFacts = (sources: Omit<WakeupFactSources, "record">) =>
		wakeupFacts({ record: (jobId) => b.fleet.get(jobId), ...sources });

	// Pruned: the fleet still remembers a different head, recorded later.
	const pruned = ciFacts({ fleetHead: () => FLEET, fleetHeadAt: () => "2026-08-31T12:50:00Z" });
	assert.equal(checkWakeup(stamp, pruned, now).state, "fresh", "only the watcher may contradict the watcher");

	// Broken: a `ciHead` that throws is degraded, not "never observed" — and a
	// degraded source supersedes nothing for the claim it owns.
	const failures: string[] = [];
	const degraded = ciFacts({
		ciHead: () => {
			throw new Error("ci-watch.json unreadable");
		},
		fleetHead: () => FLEET,
		fleetHeadAt: () => "2026-08-31T12:50:00Z",
		onSourceFailure: (source, jobId) => failures.push(`${source}:${jobId}`),
	});
	assert.equal(checkWakeup(stamp, degraded, now).state, "fresh");
	assert.equal(degraded.job("cp-own")?.head_degraded, true, "a throw is a fact, never a silence");
	assert.deepEqual(failures, ["ciHead:cp-own"]);

	// And genuine suppression is untouched: the watcher itself reading a different
	// head still supersedes the notice, whatever the fleet says.
	const moved = ciFacts({
		ciHead: () => FLEET,
		ciHeadObservedAt: () => "2026-08-31T12:51:00Z",
		fleetHead: () => OBSERVED,
		fleetHeadAt: () => "2026-08-31T12:50:00Z",
	});
	const superseded = checkWakeup(stamp, moved, now);
	assert.equal(superseded.state, "superseded");
	assert.match(superseded.reason ?? "", /the branch moved/);
	assert.match(superseded.reason ?? "", new RegExp(FLEET.slice(0, 12)));
});

test("pi-command-post-jua: a second cp-ci message carrying the identical details.ci fact is rewritten as a replay", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci3"));
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const content = "CI/PR OBSERVED — 1 new fact about a held PR\n  cp-ci3: CI green on d48a81d1f4d3 — CI green on d48a81d";
	const greenKey = ciEventKey("cp-ci3", HEAD, "ci_green");
	const stamp = (): Omit<WakeupStamp, "issued_at"> => ({ kind: "ci", job_id: "cp-ci3", generation: 1, keys: [HEAD] });
	const details = { ci: [{ key: greenKey, event: "ci_green", job_id: "cp-ci3", head_sha: HEAD }] };

	b.setNow("2026-08-31T12:45:43Z");
	assert.equal(b.notify(stamp(), content, details), true);
	// A bounded resend (CiWatch's one-resend rule) or a busy session that has not
	// yet run the turn confirming arrival: either way the same fact, with the
	// same details.ci entry, reaches pi's queue a second time.
	b.setNow("2026-08-31T12:55:43Z");
	assert.equal(b.notify(stamp(), content, details), true, "the sender may still repeat: it cannot see the context");

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-08-31T13:00:00Z"));
	assert.equal(review.changed, true);
	assert.match(review.messages[0]?.content as string, /CI\/PR OBSERVED/, "the first delivery is untouched");
	const second = review.messages[1]?.content as string;
	assert.match(second, new RegExp(REPLAYED_WAKEUP_HEADLINE));
	assert.match(second, new RegExp(HEAD.slice(0, 12)));
	assert.doesNotMatch(second, /CI green on d48a81d/, "the repeated CI verdict must not travel a second time");
	assert.equal(review.superseded.length, 1);
});

test("pi-command-post-jua: a repeated cp-ci message with no details.ci is left alone, the conservative fallback", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci3b"));
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const content = "CI/PR OBSERVED — 1 new fact about a held PR\n  cp-ci3b: CI green on d48a81d1f4d3 — CI green on d48a81d";
	const stamp = (): Omit<WakeupStamp, "issued_at"> => ({ kind: "ci", job_id: "cp-ci3b", generation: 1, keys: [HEAD] });

	// No `details.ci` at all — a message that lost its details, or a hand-built
	// stamp. `job_id|head` alone cannot tell a later `pr_merged` from this
	// `ci_green` apart, so nothing here is ever collapsed as a replay.
	b.setNow("2026-08-31T12:45:43Z");
	assert.equal(b.notify(stamp(), content, {}), true);
	b.setNow("2026-08-31T12:55:43Z");
	assert.equal(b.notify(stamp(), content, {}), true);

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-08-31T13:00:00Z"));
	assert.equal(review.changed, false, "with no identity to compare, nothing is rewritten");
	assert.match(review.messages[1]?.content as string, /CI\/PR OBSERVED/, "the second copy still reads as delivered content");
});

test("pi-command-post-jua: cp-ci wake-ups for different heads or different jobs are never treated as replays", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci4"));
	await b.fleet.add(jobRecord(b.home.path, "cp-ci5"));
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const MOVED = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";

	b.setNow("2026-08-31T12:45:43Z");
	b.notify({ kind: "ci", job_id: "cp-ci4", generation: 1, keys: [HEAD] }, "CI green on d48a81d", {});
	b.setNow("2026-08-31T12:46:00Z");
	// Same job, a different head: a force-push, not a replay.
	b.notify({ kind: "ci", job_id: "cp-ci4", generation: 1, keys: [MOVED] }, "CI green on aa11bb2", {});
	b.setNow("2026-08-31T12:46:10Z");
	// A different job on the same head: unrelated facts.
	b.notify({ kind: "ci", job_id: "cp-ci5", generation: 1, keys: [HEAD] }, "CI green on d48a81d", {});

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-08-31T12:47:00Z"));
	assert.equal(review.changed, false, "none of these are the same fact twice");
});

test("pi-command-post-jua: a pr_merged notice for a head already announced green is not collapsed as a replay", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci7"));
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const greenKey = ciEventKey("cp-ci7", HEAD, "ci_green");
	const mergedKey = ciEventKey("cp-ci7", HEAD, "pr_merged");

	b.setNow("2026-08-31T12:45:43Z");
	assert.equal(
		b.notify(
			{ kind: "ci", job_id: "cp-ci7", generation: 1, keys: [HEAD] },
			"CI green on d48a81d1f4d3",
			{ ci: [{ key: greenKey, event: "ci_green", job_id: "cp-ci7", head_sha: HEAD }] },
		),
		true,
	);
	// Same job, same head, a different fact: the PR merged after CI went green.
	b.setNow("2026-08-31T12:50:00Z");
	assert.equal(
		b.notify(
			{ kind: "ci", job_id: "cp-ci7", generation: 1, keys: [HEAD] },
			"PR merged for cp-ci7 at d48a81d1f4d3",
			{ ci: [{ key: mergedKey, event: "pr_merged", job_id: "cp-ci7", head_sha: HEAD }] },
		),
		true,
	);

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-08-31T12:51:00Z"));
	assert.equal(review.changed, false, "a different event on the same head is a different fact, never a replay");
	assert.match(review.messages[0]?.content as string, /CI green on d48a81d1f4d3/);
	assert.match(review.messages[1]?.content as string, /PR merged for cp-ci7/, "the merge notice must survive intact");
});

test("pi-command-post-jua: a batched message repeating one key while carrying a new one is still delivered", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci8"));
	await b.fleet.add(jobRecord(b.home.path, "cp-ci9"));
	const HEAD_A = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const HEAD_B = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
	const keyA = ciEventKey("cp-ci8", HEAD_A, "ci_green");
	const keyB = ciEventKey("cp-ci9", HEAD_B, "ci_green");

	b.setNow("2026-08-31T12:45:43Z");
	// A coalesced tick, no single job (no job_id/keys on the stamp), carrying both
	// facts — the shape `surfaceCi` actually sends when more than one job is due.
	b.notify(
		{ kind: "ci" },
		"CI/PR OBSERVED — 2 new facts\n  cp-ci8: CI green\n  cp-ci9: CI green",
		{ ci: [{ key: keyA, event: "ci_green", job_id: "cp-ci8", head_sha: HEAD_A }, { key: keyB, event: "ci_green", job_id: "cp-ci9", head_sha: HEAD_B }] },
	);
	b.setNow("2026-08-31T12:50:00Z");
	// A second tick repeats cp-ci8's key (unconfirmed resend) but introduces a
	// brand-new fact for a third job: the whole message must still arrive.
	const keyC = ciEventKey("cp-ci-new", HEAD_A, "ci_failed");
	b.notify(
		{ kind: "ci" },
		"CI/PR OBSERVED — 2 new facts\n  cp-ci8: CI green\n  cp-ci-new: CI failed",
		{ ci: [{ key: keyA, event: "ci_green", job_id: "cp-ci8", head_sha: HEAD_A }, { key: keyC, event: "ci_failed", job_id: "cp-ci-new", head_sha: HEAD_A }] },
	);

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-08-31T12:51:00Z"));
	assert.equal(review.changed, false, "a batch carrying any new key is news, not a replay");
	assert.match(review.messages[1]?.content as string, /cp-ci-new: CI failed/, "the new fact in the batch must survive");
});

test("pi-command-post-jua: a terminal job's repeated cp-ci fact never reaches the parent as live content", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci-term"));
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const greenKey = ciEventKey("cp-ci-term", HEAD, "ci_green");
	const content = "CI/PR OBSERVED — 1 new fact about a held PR\n  cp-ci-term: CI green on d48a81d1f4d3 — CI green on d48a81d";
	const details = { ci: [{ key: greenKey, event: "ci_green", job_id: "cp-ci-term", head_sha: HEAD }] };

	// Sent while the job is still live: notify accepts it.
	b.setNow("2026-08-31T12:45:43Z");
	assert.equal(b.notify({ kind: "ci", job_id: "cp-ci-term", generation: 1, keys: [HEAD] }, content, details), true);

	// The job is torn down before this conversation is reviewed: the delivery
	// (or a bounded resend, or a lagging confirmation) can still be sitting in
	// pi's queue as a second, identical copy of the same fact.
	await b.fleet.patch("cp-ci-term", { phase: "done", closed_at: "2026-08-31T12:47:00Z" });
	const first = asCarrier(b.sent[0] as WakeupMessage);
	const duplicate = { ...first };

	const review = reviewWakeups([first, duplicate], facts(b), new Date("2026-08-31T12:48:00Z"));
	assert.equal(review.changed, true);
	assert.equal(review.superseded.length, 2, "neither copy is current news once the job is torn down");
	for (const message of review.messages) {
		assert.ok(
			!(message.content as string).includes("CI green on d48a81d"),
			"a terminal job's CI fact must never reach the parent as live content, first copy or duplicate",
		);
	}
	assert.match(review.superseded[0]?.verdict.reason ?? "", /already done/, "the first copy is stale for the terminal reason");
});

test("pi-command-post-jua: a cp-ci stamp naming a superseded generation never reaches the parent twice either", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ci-gen"));
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const greenKey = ciEventKey("cp-ci-gen", HEAD, "ci_green");
	const content = "CI/PR OBSERVED — 1 new fact about a held PR\n  cp-ci-gen: CI green on d48a81d1f4d3 — CI green on d48a81d";
	const details = { ci: [{ key: greenKey, event: "ci_green", job_id: "cp-ci-gen", head_sha: HEAD }] };

	// Sent while the job is on generation 1: notify accepts it.
	b.setNow("2026-08-31T12:45:43Z");
	assert.equal(b.notify({ kind: "ci", job_id: "cp-ci-gen", generation: 1, keys: [HEAD] }, content, details), true);

	// A promote reopens the envelope slot: the job is now on generation 2, and
	// the stamp naming generation 1 describes a slot that no longer exists.
	await b.fleet.patch("cp-ci-gen", { supersessions: 1 });
	const first = asCarrier(b.sent[0] as WakeupMessage);
	const duplicate = { ...first };

	const review = reviewWakeups([first, duplicate], facts(b), new Date("2026-08-31T12:47:00Z"));
	assert.equal(review.changed, true);
	assert.equal(review.superseded.length, 2, "neither copy describes the live generation");
	for (const message of review.messages) {
		assert.ok(
			!(message.content as string).includes("CI green on d48a81d"),
			"a superseded-generation CI fact must never reach the parent as live content, first copy or duplicate",
		);
	}
	assert.match(review.superseded[0]?.verdict.reason ?? "", /slot was reopened/, "the first copy is stale for the generation reason");
});

test("cp-ze1t: a re-sent durable wake-up with the same durable_id is a replay; the first copy is untouched", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-land"));
	await b.fleet.patch("cp-land", { phase: "done" });
	await b.fleet.add(jobRecord(b.home.path, "cp-dead"));
	await b.fleet.markFailed("cp-dead", { class: "crash", message: "worker exited", at: "2026-09-29T07:05:00Z" });
	const landing = { durable_id: "continuation:cp-land:1:done" };
	// The outbox re-sends after its 120 s retry window while pi's follow-up queue
	// still holds the first copy: the send-time check cannot see the context.
	b.setNow("2026-09-29T07:03:45Z");
	assert.equal(b.notify({ kind: "recovery", job_id: "cp-land" }, "HELD PR LANDED — cp-land merged", landing), true);
	b.setNow("2026-09-29T07:05:49Z");
	assert.equal(b.notify({ kind: "recovery", job_id: "cp-land" }, "HELD PR LANDED — cp-land merged", landing), true);
	b.setNow("2026-09-29T07:06:00Z");
	assert.equal(b.notify({ kind: "recovery", job_id: "cp-other" }, "HELD PR LANDED — cp-other merged", { durable_id: "continuation:cp-other:1:done" }), true);
	const deathStamp = { kind: "death" as const, job_id: "cp-dead", keys: ["crash"] };
	assert.equal(b.notify(deathStamp, "WORKER DEATH — cp-dead failed (crash)", { durable_id: "death:cp-dead:1" }), true);
	assert.equal(b.notify(deathStamp, "WORKER DEATH — cp-dead failed (crash)", { durable_id: "death:cp-dead:1" }), true);

	const first = asCarrier(b.sent[0] as WakeupMessage);
	const second = { ...asCarrier(b.sent[1] as WakeupMessage), timestamp: (first.timestamp as number) + 1 };
	const memory: WakeupReplayMemory = new Map();
	const now = new Date("2026-09-29T07:10:00Z");
	for (let round = 0; round < 2; round++) {
		const review = reviewWakeups([first, second], facts(b), now, memory);
		assert.equal(review.superseded.length, 1, `round ${round}: only the re-sent copy is a replay`);
		assert.equal(review.messages[0], first, "the first copy reaches the model unchanged");
		assert.match(review.messages[1]?.content as string, new RegExp(REPLAYED_WAKEUP_HEADLINE));
		assert.doesNotMatch(review.messages[1]?.content as string, /HELD PR LANDED/);
	}
	const compacted = reviewWakeups([second], facts(b), now, memory);
	assert.equal(compacted.superseded.length, 1, "the first copy's token survives compaction in the replay memory");

	const other = { ...asCarrier(b.sent[2] as WakeupMessage), timestamp: (first.timestamp as number) + 2 };
	const mixed = reviewWakeups([first, other], facts(b), now, new Map());
	assert.equal(mixed.changed, false, "a different durable_id is new news");

	const died = asCarrier(b.sent[3] as WakeupMessage);
	const diedAgain = { ...asCarrier(b.sent[4] as WakeupMessage), timestamp: (died.timestamp as number) + 1 };
	const deaths = reviewWakeups([died, diedAgain], facts(b), now, new Map());
	assert.equal(deaths.superseded.length, 1, "a re-sent cp-death is a replay too");
	assert.equal(deaths.messages[0], died);
	assert.match(deaths.messages[1]?.content as string, new RegExp(REPLAYED_WAKEUP_HEADLINE));
});

test("formatReplayedCiWakeup names the job and the head, and reads as a fact, not an instruction", () => {
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const text = formatReplayedCiWakeup({ kind: "ci", job_id: "cp-ci6", generation: 1, keys: [HEAD], issued_at: "2026-08-31T12:45:43Z" });
	assert.match(text, /cp-ci6/);
	assert.match(text, new RegExp(HEAD.slice(0, 12)));
	assert.match(text, /Nothing new happened and nothing was lost/);
});

test("an answered decision is stamped and annotated when late, and never withheld", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-answer"));
	// The job it concerns is long gone; the human's answer is still a fact.
	await b.fleet.patch("cp-answer", { phase: "done", closed_at: "2026-08-31T12:40:00Z" });

	const stamp: Omit<WakeupStamp, "issued_at"> & { issued_at: string } = {
		kind: "answered",
		job_id: "cp-answer",
		keys: ["aw-checkpoint-cp-answer"],
		issued_at: "2026-08-31T12:49:23Z",
	};
	b.setNow("2026-08-31T12:54:00Z");
	assert.equal(b.notify(stamp, "DECISION ANSWERED — a human answered 1 open decision", {}), true);
	const message = b.sent[0] as WakeupMessage;
	assert.match(message.content, /DECISION ANSWERED/);
	assert.match(message.content, /reached you \d+s later/, "lateness is visible, because it was four minutes here");

	const review = reviewWakeups([asCarrier(message)], facts(b), new Date("2026-08-31T13:00:00Z"));
	assert.equal(review.changed, false, "an answer never stops being an answer");
});

test("the staleness stamp composes with cp-nx7's delivery: every coalesced id travels, and sending still delivers nothing", async (t) => {
	const b = benchOf(t);
	const outbox = new AnsweredOutbox({ home: b.home.path, now: b.now });
	outbox.enqueue({
		id: "aw-ship-44",
		type: "approval",
		job_id: "cp-one",
		decision: "ship, drop or follow-up?",
		answer: "ship it",
		answered_by: "operator",
	});
	outbox.enqueue({
		id: "aw-checkpoint-cp-two",
		type: "authorization",
		job_id: "cp-two",
		decision: "authorize implementation?",
		answer: "approved",
		answered_by: "operator",
	});

	// surfaceAnswered, in miniature: one drain, the whole queue coalesced, sent
	// through the same stamping door as every other wake-up.
	outbox.drain((decisions) => {
		b.notify({ kind: "answered", keys: decisions.map((decision) => decision.id) }, formatAnsweredNotice(decisions), {
			answered: decisions,
		});
	});

	const message = b.sent[0] as WakeupMessage;
	assert.equal(b.sent.length, 1, "one message, every id in it — never one per window");
	assert.equal(message.customType, ANSWERED_MESSAGE_TYPE, "the type the arrival observer recognises");
	assert.deepEqual(
		answeredIdsFromMessage(message).sort(),
		["aw-checkpoint-cp-two", "aw-ship-44"],
		"the stamp must not displace the arrival evidence, and must not drop a coalesced id",
	);
	assert.ok(wakeupStampOf(asCarrier(message)), "and the stamp is there too");

	// Sending is not delivering: nothing is stamped until arrival is observed.
	assert.equal(outbox.pending().length, 2);
	assert.equal(outbox.delivered("aw-ship-44"), false);
	assert.deepEqual(outbox.confirmDelivered(answeredIdsFromMessage(message)).sort(), [
		"aw-checkpoint-cp-two",
		"aw-ship-44",
	]);
	assert.equal(outbox.pending().length, 0);
	assert.equal(outbox.delivered("aw-ship-44"), true);
});

// ---------------------------------------------------------------------------
// cp-5mgg: the answer travels once. A second copy of it is a replay, and a
// replayed authorization is an instruction to act twice.
// ---------------------------------------------------------------------------

test("cp-5mgg: a second cp-answered carrying only ids already delivered is rewritten as a replay", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ehsc"));
	const id = "aw-checkpoint-cp-ehsc.merge-f7b8769f0606";
	const content = "DECISION ANSWERED — a human answered 1 open decision";
	const stamp = (): Omit<WakeupStamp, "issued_at"> => ({ kind: "answered", job_id: "cp-ehsc", keys: [id] });

	b.setNow("2026-09-01T15:10:09Z");
	assert.equal(b.notify(stamp(), content, {}), true);
	b.setNow("2026-09-01T15:12:09Z");
	assert.equal(b.notify(stamp(), content, {}), true, "the sender may still repeat: it cannot see the context");
	b.setNow("2026-09-01T15:14:09Z");
	assert.equal(b.notify(stamp(), content, {}), true);

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-09-01T15:15:00Z"));
	assert.equal(review.changed, true);
	assert.match(review.messages[0]?.content as string, /DECISION ANSWERED/, "the first delivery is untouched");
	for (const copy of review.messages.slice(1)) {
		assert.match(copy.content as string, new RegExp(REPLAYED_WAKEUP_HEADLINE));
		assert.match(copy.content as string, /aw-checkpoint-cp-ehsc\.merge-f7b8769f0606/, "named, so it is traceable");
		assert.doesNotMatch(copy.content as string, /DECISION ANSWERED/, "and it no longer reads as fresh news");
	}
	assert.equal(review.superseded.length, 2, "both replays are facts, not silence");
});

test("cp-5mgg: a wake-up carrying an id nobody has seen is never treated as a replay", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-ehsc"));
	const first = "aw-checkpoint-cp-ehsc.merge-f7b8769f0606";
	const second = "aw-ae4f05546e";
	b.setNow("2026-09-01T15:10:09Z");
	b.notify({ kind: "answered", job_id: "cp-ehsc", keys: [first] }, "DECISION ANSWERED — 1", {});
	b.setNow("2026-09-01T15:10:12Z");
	// A coalesced wake-up that repeats one id and carries one new one is news:
	// dropping it would lose a decision, which is the failure this path exists
	// to prevent. Only an *entirely* redundant copy is a replay.
	b.notify({ kind: "answered", keys: [first, second] }, "DECISIONS ANSWERED — 2", {});

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-09-01T15:11:00Z"));
	assert.equal(review.changed, false, "nothing is rewritten");
	assert.match(review.messages[1]?.content as string, /DECISIONS ANSWERED/);
});

test("cp-5mgg: the replay check reads the ids off a message that lost its details", async (t) => {
	const b = benchOf(t);
	const decisions = [
		{
			schema_version: SCHEMA_VERSION,
			id: "aw-checkpoint-cp-ehsc.merge-f7b8769f0606",
			type: "authorization" as const,
			job_id: "cp-ehsc",
			decision: "merge PR #57?",
			answer: "approved",
			answered_by: "operator dialog (tui)",
			answered_at: "2026-09-01T15:10:09Z",
		},
	];
	const notice = formatAnsweredNotice(decisions);
	// No `keys` on the stamp and no `details.answered`: only the text survived.
	b.setNow("2026-09-01T15:10:09Z");
	b.notify({ kind: "answered" }, notice, {});
	b.setNow("2026-09-01T15:12:09Z");
	b.notify({ kind: "answered" }, notice, {});

	const review = reviewWakeups(b.sent.map(asCarrier), facts(b), new Date("2026-09-01T15:13:00Z"));
	assert.equal(review.changed, true, "the notice names every id by construction, so the copy is still recognisable");
	assert.match(review.messages[1]?.content as string, new RegExp(REPLAYED_WAKEUP_HEADLINE));
});

// ---------------------------------------------------------------------------
// cp-jqk3: an answered wake-up is annotated, never suppressed, for a job
// that has already reached a terminal phase.
// ---------------------------------------------------------------------------

test("an answered stamp for a job that is already done stays fresh and carries a note", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-done"));
	await b.fleet.patch("cp-done", { phase: "done", closed_at: "2026-08-31T12:40:00Z" });

	const stamp: WakeupStamp = { kind: "answered", job_id: "cp-done", issued_at: "2026-08-31T12:45:43Z" };
	const verdict = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:45:44Z"));
	assert.equal(verdict.state, "fresh", "an answer can never be wrong — the regression guard");
	assert.match(verdict.note ?? "", /cp-done is already done/);

	// It is still sent, and the note rides along in the rendered body.
	assert.equal(b.notify(stamp, "DECISION ANSWERED — a human answered 1 open decision", {}), true);
	const message = b.sent[0] as WakeupMessage;
	assert.match(message.content, /DECISION ANSWERED/);
	assert.match(message.content, /cp-done is already done/);
});

test("an answered stamp for a job with no fleet record at all is still fresh and still sent", (t) => {
	const b = benchOf(t);
	const stamp: WakeupStamp = { kind: "answered", job_id: "cp-ghost", issued_at: "2026-08-31T12:45:43Z" };
	const verdict = checkWakeup(stamp, facts(b), new Date("2026-08-31T12:45:44Z"));
	assert.equal(verdict.state, "fresh");
	assert.equal(verdict.note, undefined, "no fleet record means nothing to annotate, not a reason to withhold");

	assert.equal(b.notify(stamp, "DECISION ANSWERED — a human answered 1 open decision", {}), true);
	assert.equal(b.sent.length, 1);
});

test("an answered stamp that is also late carries both annotations, rendered together", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-late-done"));
	await b.fleet.patch("cp-late-done", { phase: "done", closed_at: "2026-08-31T12:40:00Z" });

	const stamp: Omit<WakeupStamp, "issued_at"> & { issued_at: string } = {
		kind: "answered",
		job_id: "cp-late-done",
		issued_at: "2026-08-31T12:00:00Z",
	};
	b.setNow(new Date(Date.parse("2026-08-31T12:00:00Z") + WAKEUP_LATE_SECONDS * 1000).toISOString());
	assert.equal(b.notify(stamp, "DECISION ANSWERED — a human answered 1 open decision", {}), true);
	const message = b.sent[0] as WakeupMessage;
	assert.match(message.content, /cp-late-done is already done/, "the terminal-phase note is present");
	assert.match(message.content, /reached you \d+s later/, "the lateness annotation is present");

	const review = reviewWakeups([asCarrier(message)], facts(b), new Date("2026-08-31T13:10:00Z"));
	assert.equal(review.changed, false, "an answer never stops being an answer, however late or however done");
});

test("cp-0wq7: the fail-closed settle explains its own failure instead of being superseded by it", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-doa"));
	b.status.set("cp-doa", { alive: true, run_phase: "idle", current_tool: null, tool_calls: 0 });
	// What the settle boundary does to a worker whose model call never happened:
	// it marks the job failed itself, and the wake-up is the only thing that
	// carries the provider's error to the operator.
	await b.fleet.patch("cp-doa", {
		phase: "failed",
		failure: {
			class: "model_call_failed",
			message: "the model call failed and the worker never ran a turn: 401 Invalid API key",
			at: "2026-08-31T12:45:43Z",
		},
	});

	const explains = checkWakeup(
		{ kind: "unreported", job_id: "cp-doa", generation: 1, keys: ["model_call_failed"], issued_at: "2026-08-31T12:45:43Z" },
		facts(b),
		new Date("2026-08-31T12:45:50Z"),
	);
	assert.equal(explains.state, "fresh", "a message cannot be superseded by the fact it is delivering");

	// A wake-up that knew nothing about this failure is still superseded by it:
	// the exemption is "this message says why", not "failed is never terminal".
	const older = checkWakeup(
		{ kind: "unreported", job_id: "cp-doa", generation: 1, issued_at: "2026-08-31T12:40:00Z" },
		facts(b),
		new Date("2026-08-31T12:45:50Z"),
	);
	assert.equal(older.state, "superseded");
	assert.match(older.reason ?? "", /already failed/);
});

test("a hard-bound wake-up stays fresh for the failure it just recorded", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-cap"));
	await b.fleet.patch("cp-cap", {
		phase: "failed",
		failure: {
			class: "tool_call_cap_exceeded",
			message: "tool_call_cap bound 3 starts exceeded (measured 3 starts)",
			at: "2026-08-31T12:45:43Z",
		},
	});
	const fresh = checkWakeup(
		{ kind: "bound", job_id: "cp-cap", keys: ["tool_call_cap_exceeded"], issued_at: "2026-08-31T12:45:43Z" },
		facts(b),
		new Date("2026-08-31T12:45:50Z"),
	);
	assert.equal(fresh.state, "fresh");
	const other = checkWakeup(
		{ kind: "bound", job_id: "cp-cap", keys: ["wall_clock_exceeded"], issued_at: "2026-08-31T12:45:43Z" },
		facts(b),
		new Date("2026-08-31T12:45:50Z"),
	);
	assert.equal(other.state, "superseded");
});

test("the terminal-phase exemption does not leak: envelope, wedged and unreported stamps for a done job are still superseded", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-over"));
	writeEnvelopeFile(b.home.path, "cp-over", SHIPPED("cp-over"));
	const reported = await b.intake.intake("cp-over");
	await b.fleet.patch("cp-over", { phase: "done", closed_at: "2026-08-31T12:45:52Z" });

	const envelope = checkWakeup({ ...envelopeStamp(reported), issued_at: "2026-08-31T12:45:43Z" }, facts(b), new Date("2026-08-31T12:49:00Z"));
	assert.equal(envelope.state, "superseded");
	assert.match(envelope.reason ?? "", /already done/);

	const wedged = checkWakeup(
		{ kind: "wedged", job_id: "cp-over", keys: [toolCallKey("cp-over", 3)], issued_at: "2026-08-31T12:45:43Z" },
		facts(b),
		new Date("2026-08-31T12:49:00Z"),
	);
	assert.equal(wedged.state, "superseded");

	const unreported = checkWakeup(
		{ kind: "unreported", job_id: "cp-over", generation: 1, issued_at: "2026-08-31T12:45:43Z" },
		facts(b),
		new Date("2026-08-31T12:49:00Z"),
	);
	assert.equal(unreported.state, "superseded");
});

test("failed script result wakes once; a model failure or torn-down script is stale", () => {
 const stamp: WakeupStamp = { kind: "envelope", job_id: "cp-script", reported_at: "2026-08-31T12:45:43Z", issued_at: "2026-08-31T12:45:44Z" };
 const record = { phase: "failed" as const, executor: "script", reported_at: stamp.reported_at };
 assert.equal(checkWakeup(stamp, wakeupFacts({ record: () => record })).state, "fresh");
 assert.equal(checkWakeup(stamp, wakeupFacts({ record: () => ({ ...record, executor: "model" }) })).state, "superseded");
 assert.equal(checkWakeup(stamp, wakeupFacts({ record: () => ({ ...record, phase: "done" as const }) })).state, "superseded");
});

// ---------------------------------------------------------------------------
// the pieces
// ---------------------------------------------------------------------------

test("checkWakeup: lateness annotates and never supersedes", () => {
	const empty = wakeupFacts({ record: () => undefined });
	const stamp: WakeupStamp = { kind: "answered", issued_at: "2026-08-31T12:00:00Z" };
	const fresh = checkWakeup(stamp, empty, new Date("2026-08-31T12:00:10Z"));
	assert.deepEqual(fresh, { state: "fresh", delay_seconds: 10, late: false });

	const late = checkWakeup(stamp, empty, new Date(Date.parse("2026-08-31T12:00:00Z") + WAKEUP_LATE_SECONDS * 1000));
	assert.equal(late.state, "fresh", "age is never evidence of staleness");
	assert.equal(late.late, true);

	// A clock that ran backwards is not a negative age.
	assert.equal(checkWakeup(stamp, empty, new Date("2026-08-31T11:59:00Z")).delay_seconds, 0);
});

test("a stamp survives the round trip, and an unstamped message is left alone", () => {
	const stamp: WakeupStamp = { kind: "envelope", job_id: "cp-x", generation: 2, issued_at: "2026-08-31T12:00:00Z" };
	assert.deepEqual(wakeupStampOf({ role: "custom", customType: "cp-envelope", details: { cp_wakeup: stamp } }), stamp);
	assert.equal(wakeupStampOf({ role: "user", content: "hi" }), undefined);
	assert.equal(wakeupStampOf({ role: "custom", customType: "cp-envelope", details: {} }), undefined);
	assert.equal(
		wakeupStampOf({ role: "custom", customType: "cp-envelope", details: { cp_wakeup: { kind: "nope", issued_at: "x" } } }),
		undefined,
	);

	// An ordinary message is passed through untouched, object identity and all.
	const plain: WakeupCarrier = { role: "user", content: "what is in flight?" };
	const review = reviewWakeups([plain], wakeupFacts({ record: () => undefined }));
	assert.equal(review.changed, false);
	assert.equal(review.messages[0], plain);
});

test("a superseded notice names the job, the generation and where to look", () => {
	const stamp: WakeupStamp = {
		kind: "envelope",
		job_id: "cp-x",
		generation: 1,
		reported_at: "2026-08-31T12:45:43Z",
		issued_at: "2026-08-31T12:45:43Z",
	};
	const text = formatStaleWakeup(stamp, { state: "superseded", delay_seconds: 107, late: true, reason: "the slot was reopened" });
	assert.match(text, /STALE WAKE-UP/);
	assert.match(text, /cp-envelope for cp-x, generation 1, reported at 2026-08-31T12:45:43Z/);
	assert.match(text, /the slot was reopened/);
	assert.match(text, /\/watch cp-x/);
});

test("a withheld wake-up is a fact in the job's run log, not silence about silence", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-log"));
	writeEnvelopeFile(b.home.path, "cp-log", SHIPPED("cp-log"));
	const reported = await b.intake.intake("cp-log");
	await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-log",
		reason: "promoted with a new brief (cp_send)",
		now: b.now,
	});

	// The extension records what it withheld; this asserts the marker the run
	// log accepts, with no body in it.
	const notifier = new WakeupNotifier({
		facts: facts(b),
		send: () => assert.fail("a stale wake-up must not be sent"),
		now: b.now,
		onSuppressed: (stamp, verdict) => {
			b.runs.open("cp-log").cp("wakeup_suppressed", {
				kind: stamp.kind,
				generation: stamp.generation ?? 0,
				issued_at: stamp.issued_at,
				delay_seconds: verdict.delay_seconds,
				reason: verdict.reason ?? "",
				stage: "send",
			});
		},
	});
	notifier.send(envelopeStamp(reported), formatIntake(reported), {});

	const marker = readRunEvents(b.home.path, "cp-log").find((event) => event.type === "wakeup_suppressed");
	assert.ok(marker, "a wake-up that was withheld must be visible somewhere");
	assert.equal((marker?.payload as { generation?: number }).generation, 1);
	assert.ok(
		!JSON.stringify(marker?.payload).includes("Diff-gate false positive fixed"),
		"no body travels in a marker, not even a withheld one",
	);
});

// ---------------------------------------------------------------------------
// cp-verdict (spec 2026-09-05-async-reviewers): a verdict is a claim about one
// attempt of one surface on one job. It goes stale when that attempt has no
// decision, a later attempt exists, the job is over, or (a diff review) the
// branch head moved.
// ---------------------------------------------------------------------------

function verdictFacts(bench: Bench, reviews: Map<string, ReviewWakeupFacts>) {
	return wakeupFacts({
		record: (jobId) => bench.fleet.get(jobId),
		statusJob: (jobId) => bench.status.get(jobId),
		ciHead: (jobId) => (jobId === "cp-v" ? "b".repeat(40) : undefined),
		// Dated, because an undated observation is not evidence of a later push and
		// no longer withholds a fleet-owned claim (pi-command-post-8ok). The test
		// below is about a head that moved, not about an unreadable clock; the
		// undated case has its own regression.
		ciHeadObservedAt: (jobId) => (jobId === "cp-v" ? "2026-08-31T12:50:00Z" : undefined),
		review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
	});
}

test("verdict: fresh when the attempt is decided and nothing newer exists", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pipeline"));
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [1] }]]);
	const verdict = checkWakeup(
		{ ...verdictStamp("cp-v", "gate", 1), issued_at: isoTimestamp(b.now()) },
		verdictFacts(b, reviews),
		b.now(),
	);
	assert.equal(verdict.state, "fresh");
});

test("verdict: stale when the decision is missing, superseded by a later attempt, or the job is over", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pipeline"));
	const at = isoTimestamp(b.now());
	const missing = checkWakeup(
		{ ...verdictStamp("cp-v", "gate", 1), issued_at: at },
		verdictFacts(b, new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [] }]])),
		b.now(),
	);
	assert.equal(missing.state, "superseded");
	assert.match(missing.reason ?? "", /no decision on disk for gate attempt 1/);

	const later = checkWakeup(
		{ ...verdictStamp("cp-v", "gate", 1), issued_at: at },
		verdictFacts(b, new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [1, 2] }]])),
		b.now(),
	);
	assert.equal(later.state, "superseded");
	assert.match(later.reason ?? "", /gate attempt 2 has since been decided/);

	const pendingLater = checkWakeup(
		{ ...verdictStamp("cp-v", "gate", 1), issued_at: at },
		verdictFacts(b, new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [1], pending: 2 }]])),
		b.now(),
	);
	assert.equal(pendingLater.state, "superseded");
	assert.match(pendingLater.reason ?? "", /gate attempt 2 is in flight/);

	await b.fleet.patch("cp-v", { phase: "done", closed_at: at });
	const over = checkWakeup(
		{ ...verdictStamp("cp-v", "gate", 1), issued_at: at },
		verdictFacts(b, new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [1] }]])),
		b.now(),
	);
	assert.equal(over.state, "superseded");
	assert.match(over.reason ?? "", /already done/);
});

test("verdict: a diff review is a claim about one head; a moved head makes it stale", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pr"));
	const at = isoTimestamp(b.now());
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-v|review", { decided: [1] }]]);
	const same = checkWakeup(
		{ ...verdictStamp("cp-v", "review", 1, "b".repeat(40)), issued_at: at },
		verdictFacts(b, reviews),
		b.now(),
	);
	assert.equal(same.state, "fresh");
	const moved = checkWakeup(
		{ ...verdictStamp("cp-v", "review", 1, "a".repeat(40)), issued_at: at },
		verdictFacts(b, reviews),
		b.now(),
	);
	assert.equal(moved.state, "superseded");
	assert.match(moved.reason ?? "", /branch moved/);
});

test("verdict: a CI observation lagging behind a rebase cannot stale a pass on the current head (pi-command-post-b04)", async (t) => {
	// The cp-cjmu incident, deterministically. The worker rebased, pushed
	// a39e4425b7b4 and reported it; cp_review passed on that same head; and the
	// CI watcher's file still held 3d3355f0c4d2, the head from before the rebase.
	// The verdict was withheld as "the branch moved" and no card ever arrived.
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-cjmu", "pr"));
	const at = isoTimestamp(b.now());
	const REBASED = "a39e4425b7b4".padEnd(40, "0");
	const OLD = "3d3355f0c4d2".padEnd(40, "0");
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-cjmu|review", { decided: [1] }]]);
	// The watcher's reading is OLD, taken at 12:40 — five minutes BEFORE the
	// envelope that recorded the rebased head. That ordering is the whole fact.
	const lagging = (fleetHead?: string) =>
		wakeupFacts({
			record: (jobId) => b.fleet.get(jobId),
			ciHead: () => OLD,
			ciHeadObservedAt: () => "2026-08-31T12:40:00Z",
			...(fleetHead ? { fleetHead: () => fleetHead, fleetHeadAt: () => at } : {}),
			review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
		});
	const stampFor = (head: string): WakeupStamp => ({ ...verdictStamp("cp-cjmu", "review", 1, head), issued_at: at });

	// The fix: the fleet's own record of the pushed head decides, and the
	// watcher's lagging observation does not get a vote.
	const onCurrent = checkWakeup(stampFor(REBASED), lagging(REBASED), b.now());
	assert.equal(onCurrent.state, "fresh", "a pass on the head the fleet is on must reach the parent");

	// The delivery-time half: the card the parent actually reads still carries
	// the verdict, rather than a STALE WAKE-UP notice with the body removed.
	assert.equal(b.notify(verdictStamp("cp-cjmu", "review", 1, REBASED), "REVIEW PASSED — cp-cjmu", {}), true);
	const carrier = asCarrier(b.sent.at(-1) as WakeupMessage);
	const delivered = reviewWakeups([carrier], lagging(REBASED), b.now());
	assert.equal(delivered.changed, false);
	assert.match(delivered.messages[0]?.content as string, /REVIEW PASSED/);

	// And genuine suppression survives: a pass on a head the fleet has moved off
	// is still stale, named against the authoritative head.
	const onOld = checkWakeup(stampFor(OLD), lagging(REBASED), b.now());
	assert.equal(onOld.state, "superseded");
	assert.match(onOld.reason ?? "", /branch moved/);
	assert.match(onOld.reason ?? "", new RegExp(REBASED.slice(0, 12)));

	// With no fleet head on record the watcher is all there is, exactly as before
	// this fix: one reading decides, whatever its age.
	assert.equal(checkWakeup(stampFor(OLD), lagging(), b.now()).state, "fresh");
	assert.equal(checkWakeup(stampFor(REBASED), lagging(), b.now()).state, "superseded");
});

test("verdict: the inverse gap — a push nobody reported still supersedes a pass on the abandoned head (pi-command-post-b04)", async (t) => {
	// The other direction, and the reason provenance cannot be the rule. The
	// fleet only knows the head a worker *reported*: A was reviewed and reported
	// at 12:45, then the worker force-pushed B and the watcher read it at 12:50
	// without any envelope naming it. A verdict about A is then a verdict about a
	// head the PR has moved off, and it must not read as fresh.
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-inv", "pr"));
	const A = "a39e4425b7b4".padEnd(40, "0");
	const B = "bb77cc11dd22".padEnd(40, "0");
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-inv|review", { decided: [1] }]]);
	const facts = (options: { observedAt?: string } = {}) =>
		wakeupFacts({
			record: (jobId) => b.fleet.get(jobId),
			ciHead: () => B,
			ciHeadObservedAt: () => options.observedAt ?? "2026-08-31T12:50:00Z",
			fleetHead: () => A,
			fleetHeadAt: () => "2026-08-31T12:45:43Z",
			review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
		});
	const stamp: WakeupStamp = { ...verdictStamp("cp-inv", "review", 1, A), issued_at: "2026-08-31T12:46:00Z" };
	const now = new Date("2026-08-31T12:51:00Z");

	const moved = checkWakeup(stamp, facts(), now);
	assert.equal(moved.state, "superseded", "the later reading contradicts the reviewed head");
	assert.match(moved.reason ?? "", /branch moved/);
	assert.match(moved.reason ?? "", new RegExp(B.slice(0, 12)));

	// Same two readings, opposite order in time: now the observation is the stale
	// one and the pass on A stands. Nothing about the sources changed — only when
	// each was taken — which is the property this rule is built on.
	assert.equal(checkWakeup(stamp, facts({ observedAt: "2026-08-31T12:44:00Z" }), now).state, "fresh");

	// And a fleet source that THREW is degraded, not absent: it supersedes
	// nothing, so a wiring failure cannot quietly hand the decision back to the
	// lagging observation and withhold the card (finding 2's fail-safe).
	const failures: string[] = [];
	const degraded = wakeupFacts({
		record: (jobId) => b.fleet.get(jobId),
		ciHead: () => B,
		ciHeadObservedAt: () => "2026-08-31T12:50:00Z",
		fleetHead: () => {
			throw new Error("fleet head unreadable");
		},
		review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
		onSourceFailure: (source, jobId) => failures.push(`${source}:${jobId}`),
	});
	assert.equal(checkWakeup(stamp, degraded, now).state, "fresh");
	assert.deepEqual(failures, ["fleetHead:cp-inv"], "a source that threw is reported, never swallowed");
});

test("verdict: with no fleet head on record, only a dated observation may withhold the pass (pi-command-post-8ok)", async (t) => {
	// `headMoved`'s fleet branch used to short-circuit on `fleet.sha === undefined`
	// inside the very expression named `laterPush`, so "there is nothing to be
	// later than" was spelled as "the observation is later". Ignorance is not
	// proof: an undated, uncorroborated reading could withhold a verdict, which is
	// the incident class this whole check exists to prevent.
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-nofleet", "pr"));
	const REVIEWED = "a39e4425b7b4".padEnd(40, "0");
	const OTHER = "bb77cc11dd22".padEnd(40, "0");
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-nofleet|review", { decided: [1] }]]);
	// No `fleetHead` at all: nothing has been reported for this job yet.
	const noFleet = (observedAt?: string) =>
		wakeupFacts({
			record: (jobId) => b.fleet.get(jobId),
			ciHead: () => OTHER,
			...(observedAt ? { ciHeadObservedAt: () => observedAt } : {}),
			review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
		});
	const stamp: WakeupStamp = { ...verdictStamp("cp-nofleet", "review", 1, REVIEWED), issued_at: "2026-08-31T12:46:00Z" };
	const now = new Date("2026-08-31T12:55:00Z");

	// Not provably later: the observation carries no time, and there is no fleet
	// reading to corroborate it. The card travels.
	const undated = checkWakeup(stamp, noFleet(), now);
	assert.equal(undated.state, "fresh", "an undated reading with nothing behind it must not withhold a pass");
	assert.equal(noFleet().job("cp-nofleet")?.fleet_head_sha, undefined, "and the fleet really has nothing on record");

	// Truly later: a dated reading of the remote is evidence of a push nobody
	// reported, and it still supersedes — the inverse-gap protection survives.
	const dated = checkWakeup(stamp, noFleet("2026-08-31T12:50:00Z"), now);
	assert.equal(dated.state, "superseded");
	assert.match(dated.reason ?? "", /branch moved/);
	assert.match(dated.reason ?? "", new RegExp(OTHER.slice(0, 12)));

	// And a dated observation of the reviewed head itself contradicts nothing.
	const same: WakeupStamp = { ...verdictStamp("cp-nofleet", "review", 1, OTHER), issued_at: "2026-08-31T12:46:00Z" };
	assert.equal(checkWakeup(same, noFleet("2026-08-31T12:50:00Z"), now).state, "fresh");

	// The fleet-present cases are unchanged: an undated observation still loses to
	// the reading that owns the claim, rather than to nothing at all.
	const withFleet = wakeupFacts({
		record: (jobId) => b.fleet.get(jobId),
		ciHead: () => OTHER,
		fleetHead: () => REVIEWED,
		fleetHeadAt: () => "2026-08-31T12:45:43Z",
		review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
	});
	assert.equal(checkWakeup(stamp, withFleet, now).state, "fresh", "the owning reading decides when nothing outranks it");
});

test("verdict: the arrival key is read off the message the parent actually received", () => {
	const stamp = { ...verdictStamp("cp-v", "gate", 2), issued_at: "2026-09-05T10:00:00Z" };
	const message = { role: "custom", customType: VERDICT_MESSAGE_TYPE, content: "x", details: { cp_wakeup: stamp } };
	assert.deepEqual(verdictKeysFromMessage(message), ["cp-v|gate|2"]);
	assert.deepEqual(verdictKeysFromMessage({ role: "custom", customType: "cp-envelope", details: {} }), []);
	assert.deepEqual(verdictKeysFromMessage("nonsense"), []);
});

// ---------------------------------------------------------------------------
// jje.2: a replayed cp-verdict / cp-ci is recognised across contexts. A bounded
// resend used to read as fresh news once compaction had dropped the first copy,
// which is how a redelivered notice got a PR torn down (2026-09-25).
// ---------------------------------------------------------------------------

test("jje.2: a resent cp-verdict or cp-ci is a replay in a later context, and a new attempt or head is still news", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pipeline"));
	await b.fleet.add(jobRecord(b.home.path, "cp-c", "pr"));
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [1] }]]);
	const memory: WakeupReplayMemory = new Map();
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	const ci = (head: string) => ({ ci: [{ key: ciEventKey("cp-c", head, "ci_green"), event: "ci_green", job_id: "cp-c", head_sha: head }] });

	b.setNow("2026-08-31T12:45:43Z");
	b.notify(verdictStamp("cp-v", "gate", 1), "VERDICT pass — cp-v gate 1", {});
	b.notify({ kind: "ci", job_id: "cp-c", generation: 1, keys: [HEAD] }, "CI green on d48a81d", ci(HEAD));
	const first = reviewWakeups(b.sent.slice(0, 2).map(asCarrier), verdictFacts(b, reviews), b.now(), memory);
	assert.equal(first.changed, false, "the first copies are the delivery");

	// The bounded resends, reviewed in a context the first copies were compacted out of.
	b.setNow("2026-08-31T12:55:43Z");
	b.notify(verdictStamp("cp-v", "gate", 1), "VERDICT pass — cp-v gate 1", {});
	b.notify({ kind: "ci", job_id: "cp-c", generation: 1, keys: [HEAD] }, "CI green on d48a81d", ci(HEAD));
	const resent = b.sent.slice(2, 4).map(asCarrier);
	assert.equal(reviewWakeups(resent, verdictFacts(b, reviews), b.now()).changed, false, "without the memory this was fresh news — the defect");
	const later = reviewWakeups(resent, verdictFacts(b, reviews), b.now(), memory);
	assert.equal(later.superseded.length, 2);
	for (const message of later.messages) {
		assert.match(message.content as string, new RegExp(REPLAYED_WAKEUP_HEADLINE));
		assert.doesNotMatch(message.content as string, /VERDICT pass|CI green on d48a81d/, "the repeated fact does not travel again");
	}
	// Re-reviewing the context that holds the first copies leaves them delivered.
	assert.equal(reviewWakeups(b.sent.slice(0, 2).map(asCarrier), verdictFacts(b, reviews), b.now(), memory).changed, false);

	// A new attempt and a new head are different facts, and actionable.
	reviews.set("cp-v|gate", { decided: [1, 2] });
	b.notify(verdictStamp("cp-v", "gate", 2), "VERDICT pass — cp-v gate 2", {});
	b.notify({ kind: "ci", job_id: "cp-c", generation: 1, keys: [NEW_CI_HEAD] }, "CI green on aa11bb2", ci(NEW_CI_HEAD));
	assert.equal(reviewWakeups(b.sent.slice(4).map(asCarrier), verdictFacts(b, reviews), b.now(), memory).changed, false);
});

test("Rank 3: stale notices for cp-anu7 and cp-2njd remain non-actionable through context replay", async (t) => {
	const b = benchOf(t);
	for (const jobId of ["cp-anu7", "cp-2njd"]) {
		await b.fleet.add(jobRecord(b.home.path, jobId));
		const message: WakeupCarrier = {
			role: "custom", customType: "cp-envelope", timestamp: 1_000,
			content: `${jobId} reported done: rebase and re-verify the PR`,
			details: { cp_wakeup: { kind: "envelope", job_id: jobId, generation: 1, issued_at: "2026-09-26T08:34:00Z" } },
		};
		// The incident establishes ignored stale warnings, not which transport delivered them.
		for (const input of [[message], reviewWakeups([message], facts(b)).messages]) {
			const reviewed = reviewWakeups(input, facts(b));
			const text = reviewed.messages[0]?.content as string;
			assert.match(text, /STALE WAKE-UP/);
			assert.doesNotMatch(text, /reported done: rebase/);
			assert.match(text, /Do not promote, send instructions, rebase, revive, merge or tear down/);
		}
	}
});

test("Rank 3: a withheld notice cannot regain its body after restart when phase facts change again", () => {
	const message: WakeupCarrier = {
		role: "custom", customType: "cp-unreported", content: "Promote cp-2njd now", timestamp: 1_000,
		details: { cp_wakeup: { kind: "unreported", job_id: "cp-2njd", generation: 1, issued_at: "2026-09-26T08:34:00Z" } },
	};
	const memory: WakeupReplayMemory = new Map();
	const working = wakeupFacts({ record: () => ({ phase: "waiting" }), statusJob: () => ({ alive: true, run_phase: "working", current_tool: "bash", tool_calls: 1 }) });
	assert.match(reviewWakeups([message], working, new Date(), memory).messages[0]?.content as string, /STALE WAKE-UP/);
	const restored: WakeupReplayMemory = new Map(JSON.parse(JSON.stringify([...memory])));
	const settled = wakeupFacts({ record: () => ({ phase: "waiting" }), statusJob: () => ({ alive: true, run_phase: "idle", current_tool: null, tool_calls: 1 }) });
	const replay = reviewWakeups([message], settled, new Date(), restored).messages[0]?.content as string;
	assert.match(replay, /STALE WAKE-UP/);
	assert.doesNotMatch(replay, /Promote cp-2njd now/);
	const current = { ...message, timestamp: 2_000, details: { cp_wakeup: { ...wakeupStampOf(message), issued_at: "2026-09-26T08:35:00Z" } } };
	assert.equal(reviewWakeups([current], settled, new Date(), restored).changed, false, "a newly issued current notice is not the stale one");
});

for (const kind of ["unreported", "ci", "verdict"] as const) {
	test(`Rank 3: ${kind} rollover evicts only the oldest identity and keeps recent notices withheld`, () => {
		const memory: WakeupReplayMemory = new Map();
		const notices: WakeupCarrier[] = Array.from({ length: WAKEUP_SOURCE_FAILURE_MEMORY }, (_, i) => ({
			role: "custom", customType: "cp-unreported", content: `Promote cp-roll-${i} now`, timestamp: 1_000,
			details: { cp_wakeup: { kind: "unreported", job_id: `cp-roll-${i}`, generation: 1, issued_at: "2026-09-26T08:34:00Z" } },
		}));
		const working = wakeupFacts({ record: () => ({ phase: "waiting" }), statusJob: () => ({ alive: true, run_phase: "working", current_tool: "bash", tool_calls: 1 }), review: () => ({ decided: [1] }) });
		assert.equal(reviewWakeups(notices, working, new Date(), memory).superseded.length, notices.length);
		const oldest = memory.keys().next().value!;
		const recent = notices.at(-1)!;
		const overflow: WakeupCarrier = {
			role: "custom", customType: `cp-${kind}`, content: "New event", timestamp: 2_000,
			details: {
				cp_wakeup: { kind, job_id: "cp-overflow", generation: 1, keys: kind === "verdict" ? ["gate", "1"] : ["a".repeat(40)], issued_at: "2026-09-26T08:35:00Z" },
				ci: [{ key: ciEventKey("cp-overflow", "a".repeat(40), "ci_green") }],
			},
		};
		reviewWakeups([overflow], working, new Date(), memory);
		assert.equal(memory.has(oldest), false, "the oldest identity makes room for the new one");
		const restored: WakeupReplayMemory = new Map(JSON.parse(JSON.stringify([...memory])));
		const settled = wakeupFacts({ record: () => ({ phase: "waiting" }), statusJob: () => ({ alive: true, run_phase: "idle", current_tool: null, tool_calls: 1 }) });
		const replay = reviewWakeups([recent], settled, new Date(), restored).messages[0]?.content as string;
		assert.match(replay, /STALE WAKE-UP/);
		assert.doesNotMatch(replay, /Promote cp-roll-\d+ now/);
		assert.equal(memory.size, WAKEUP_SOURCE_FAILURE_MEMORY, "rollover keeps the bounded window full");
		assert.equal(restored.size, WAKEUP_SOURCE_FAILURE_MEMORY, "rechecking does not grow memory");
	});
}

test("Rank 3: extension reload and parent restart retain replay identity but deliver unobserved facts", async (t) => {
	const b = benchOf(t);
	const jobId = "cp-reload";
	await b.fleet.add(jobRecord(b.home.path, jobId));
	const posts: CommandPost[] = [];
	const open = () => {
		const post = new CommandPost({ home: b.home.path, packageRoot: PACKAGE_ROOT });
		posts.push(post);
		return createWakeupSurfaces({} as ExtensionAPI, createSessionState(), { commandPost: () => post, repaintWidget: () => {} });
	};
	t.after(async () => { for (const post of posts) await post.shutdown(); });
	const head = "a".repeat(40);
	const message: WakeupCarrier = {
		role: "custom", customType: "cp-ci", content: "CI green: act on the held PR", timestamp: 1_000,
		details: {
			cp_wakeup: { kind: "ci", job_id: jobId, keys: [head], issued_at: "2026-09-26T08:34:00Z" },
			ci: [{ key: ciEventKey(jobId, head, "ci_green"), event: "ci_green", job_id: jobId, head_sha: head }],
		},
	};
	const original = open();
	assert.equal(original.reviewWakeupsInContext([message]), undefined, "first observed delivery is unchanged");
	for (const surface of [original, open(), open()]) {
		const replay = surface.reviewWakeupsInContext([{ ...message, timestamp: 2_000 }]);
		assert.match(replay?.[0]?.content as string, /REPLAYED WAKE-UP/);
		assert.doesNotMatch(replay?.[0]?.content as string, /CI green: act/);
		assert.equal(surface.reviewWakeupsInContext([message]), undefined, "the original context entry stays intact");
	}
	const unseen = { ...message, timestamp: 3_000, details: {
		cp_wakeup: { kind: "ci", job_id: jobId, keys: [head], issued_at: "2026-09-26T08:35:00Z" },
		ci: [{ key: ciEventKey(jobId, head, "pr_merged"), event: "pr_merged", job_id: jobId, head_sha: head }],
	} };
	assert.equal(open().reviewWakeupsInContext([unseen]), undefined, "unobserved current event survives restart");
	const stale: WakeupCarrier = { role: "custom", customType: "cp-envelope", content: "Archived report body", details: {
		cp_wakeup: { kind: "envelope", job_id: jobId, generation: 1, issued_at: "2026-09-26T08:34:00Z" },
	} };
	assert.match(open().reviewWakeupsInContext([stale])?.[0]?.content as string, /STALE WAKE-UP/);
	await b.fleet.patch(jobId, { reported_at: "2026-09-26T08:36:00Z" });
	const stillWithheld = open().reviewWakeupsInContext([stale]);
	assert.match(stillWithheld?.[0]?.content as string, /already withheld/);
	assert.doesNotMatch(stillWithheld?.[0]?.content as string, /Archived report body/);
	const persisted = readFileSync(join(b.home.path, LAYOUT.state, "wakeup-replay.json"), "utf8");
	assert.doesNotMatch(persisted, /CI green: act|Archived report body/, "only identities persist, never bodies");
});

test("Rank 3: replay persistence failures are visible and never restore a stale body", async (t) => {
	const b = benchOf(t);
	const post = new CommandPost({ home: b.home.path, packageRoot: PACKAGE_ROOT });
	t.after(() => post.shutdown());
	mkdirSync(join(b.home.path, LAYOUT.state, "wakeup-replay.json"), { recursive: true }); // Neither readable as JSON nor replaceable by a file.
	const warnings: string[] = [];
	const state = createSessionState();
	state.live = { hasUI: true, ui: { notify: (text: string) => { warnings.push(text); } } } as unknown as ExtensionContext;
	const surface = createWakeupSurfaces({} as ExtensionAPI, state, { commandPost: () => post, repaintWidget: () => {} });
	const message: WakeupCarrier = { role: "custom", customType: "cp-envelope", content: "Superseded report body", details: {
		cp_wakeup: { kind: "envelope", job_id: "cp-gone", generation: 1, issued_at: "2026-09-26T08:34:00Z" },
	} };
	const reviewed = surface.reviewWakeupsInContext([message]);
	assert.match(reviewed?.[0]?.content as string, /STALE WAKE-UP/);
	assert.doesNotMatch(reviewed?.[0]?.content as string, /Superseded report body/);
	assert.equal(warnings.length, 2, "both read and write failures are reported");
	assert.ok(warnings.every((text) => text.includes("wakeup-replay.json")));
	surface.reviewWakeupsInContext([message]);
	assert.equal(warnings.length, 2, "repeated failures do not flood the operator");
});

const NEW_CI_HEAD = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";

test("jje.2: a redelivery with an identical stamp is still a replay in a later context; the first entry stays delivered", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pipeline"));
	await b.fleet.add(jobRecord(b.home.path, "cp-c", "pr"));
	const reviews = new Map<string, ReviewWakeupFacts>([["cp-v|gate", { decided: [1] }]]);
	const memory: WakeupReplayMemory = new Map();
	const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
	b.setNow("2026-08-31T12:45:43Z");
	b.notify(verdictStamp("cp-v", "gate", 1), "VERDICT pass — cp-v gate 1", {});
	b.notify({ kind: "ci", job_id: "cp-c", generation: 1, keys: [HEAD] }, "CI green on d48a81d", {
		ci: [{ key: ciEventKey("cp-c", HEAD, "ci_green"), event: "ci_green", job_id: "cp-c", head_sha: HEAD }],
	});
	// The same messages, byte for byte (stamp and issued_at unchanged), as two context entries.
	const entry = (message: WakeupMessage, timestamp: number) => ({ ...asCarrier(message), timestamp });
	const firsts = b.sent.map((message) => entry(message, 1_000));
	const redelivered = b.sent.map((message) => entry(message, 2_000));
	assert.equal(reviewWakeups(firsts, verdictFacts(b, reviews), b.now(), memory).changed, false, "the first delivery is news");
	assert.equal(reviewWakeups(firsts, verdictFacts(b, reviews), b.now(), memory).changed, false, "and stays delivered on every later request");
	const later = reviewWakeups(redelivered, verdictFacts(b, reviews), b.now(), memory);
	assert.equal(later.superseded.length, 2, "an identical stamp does not make a second entry a first delivery");
	for (const message of later.messages) {
		assert.match(message.content as string, new RegExp(REPLAYED_WAKEUP_HEADLINE));
		assert.doesNotMatch(message.content as string, /VERDICT pass|CI green on d48a81d/);
	}
});

// k52: the origin/main half of the CI-watch tick, through the real `surfaceCi` wiring.
const MAIN_T1 = "1111111111111111111111111111111111111111";
const MAIN_T2 = "2222222222222222222222222222222222222222";

async function mainCiPost(t: { after(fn: () => void | Promise<void>): void }) {
	const b = benchOf(t);
	const post = new CommandPost({ home: b.home.path, packageRoot: PACKAGE_ROOT });
	t.after(() => post.shutdown());
	await post.registry.register({ name: "demo", clone_url: "https://example.invalid/demo.git" });
	mkdirSync(post.registry.pathOf("demo"), { recursive: true });
	const sent: Array<{ customType: string; content: string; details: Record<string, any> }> = [];
	const pi = { sendMessage: (message: (typeof sent)[number]) => sent.push(message) } as unknown as ExtensionAPI;
	return { b, post, sent, pi };
}

test("k52: one surfaceCi pass on a latched-red project sends exactly one kind:'ci' wake carrying details.main_ci", async (t) => {
	const { b, post, sent, pi } = await mainCiPost(t);
	const store = new MainCiStore({ home: b.home.path });
	store.setRed("demo", MAIN_T1, { failing: "old" });
	post.ciTick = async (): Promise<CiWatchTick> => ({ observations: [], checked: [], skipped: [], errors: [] });
	let runs: unknown[] = [{ status: "completed", conclusion: "success", headSha: MAIN_T2, workflowName: "CI", databaseId: 1 }];
	const exec: CommandRunner = async (command, args) => {
		const line = `${command} ${args.join(" ")}`;
		if (line === "git fetch origin main") return "";
		if (line === "git rev-parse origin/main") return `${MAIN_T2}\n`;
		if (line.startsWith("gh run list --branch main")) return JSON.stringify(runs);
		if (line.endsWith("--log-failed")) return "tests\tstep\t2026-01-01T00:00:00Z AssertionError: x\n";
		throw new Error(`unexpected command: ${line}`);
	};
	const surface = createWakeupSurfaces(pi, createSessionState(), { commandPost: () => post, repaintWidget: () => {}, mainCi: { exec } });
	await surface.surfaceCi();
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.customType, "cp-ci");
	assert.equal(sent[0]?.details.cp_wakeup.kind, "ci");
	assert.equal(sent[0]?.details.cp_wakeup.job_id, undefined);
	assert.equal(sent[0]?.details.main_ci.event, "main_ci_green");
	assert.equal(sent[0]?.details.main_ci.sha, MAIN_T2);
	assert.match(sent[0]?.content ?? "", /MAIN IS GREEN AGAIN — demo/);
	assert.equal(store.entry("demo"), undefined);
	await surface.surfaceCi();
	assert.equal(sent.length, 1, "transition-only through the real wiring");
	// Main goes red on T2: exactly one new wake naming the project, sha12 and failing line.
	runs = [{ status: "completed", conclusion: "failure", headSha: MAIN_T2, workflowName: "CI", databaseId: 2 }];
	await surface.surfaceCi();
	await surface.surfaceCi();
	assert.equal(sent.length, 2);
	assert.equal(sent[1]?.details.main_ci.event, "main_ci_failed");
	assert.match(sent[1]?.content ?? "", /demo/);
	assert.match(sent[1]?.content ?? "", new RegExp(MAIN_T2.slice(0, 12)));
	assert.match(sent[1]?.content ?? "", /AssertionError: x/);
	assert.equal(store.entry("demo")?.red_since_sha, MAIN_T2);
});

test("k52: a throwing main tick never blocks the held-PR wake, and is journaled through ciWatchFailed", async (t) => {
	const { b, post, sent, pi } = await mainCiPost(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-held"));
	const head = "a".repeat(40);
	post.ciTick = async (): Promise<CiWatchTick> => ({
		observations: [{ key: ciEventKey("cp-held", head, "ci_green"), event: "ci_green", job_id: "cp-held", branch: "cp-held", head_sha: head, reason: "CI green" }],
		checked: ["cp-held"],
		skipped: [],
		errors: [],
	});
	const failed: unknown[] = [];
	post.ciWatchFailed = (error: unknown) => {
		failed.push(error);
	};
	const surface = createWakeupSurfaces(pi, createSessionState(), {
		commandPost: () => post,
		repaintWidget: () => {},
		mainCi: {
			tick: async () => {
				throw new Error("main boom");
			},
		},
	});
	await surface.surfaceCi();
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.details.cp_wakeup.kind, "ci");
	assert.equal(sent[0]?.details.cp_wakeup.job_id, "cp-held");
	assert.ok(sent[0]?.details.ci);
	assert.equal(sent[0]?.details.main_ci, undefined);
	assert.equal(failed.length, 1);
	assert.match(String((failed[0] as Error).message), /main boom/);
});
