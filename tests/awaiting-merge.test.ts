/** PR1 of awaiting_merge: the parked phase's vocabulary, its validation, and read compatibility (no producer yet). */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	type AwaitingMerge,
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	isQuiescentParked,
	isoTimestamp,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
	validateAwaitingMergeWatchFile,
	validateCiEvidenceFile,
	validateFleetFile,
	validateParkIntent,
	validateStackFollowupsFile,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { overview } from "../src/viewer/overview-view.ts";
import { boardView, jobsView } from "../src/viewer/jobs-view.ts";
import { createScratchHome } from "./harness/index.ts";

const HEAD = "a".repeat(40);
const AT = "2026-10-15T10:00:00Z";

function parking(overrides: Partial<AwaitingMerge> = {}): AwaitingMerge {
	return {
		cycle: 1, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: HEAD, base: "main",
		handed_at: AT, released_at: AT, frozen_seconds: 600, frozen_usage: { ...EMPTY_USAGE, cost_usd: 1.5 }, ...overrides,
	};
}

function parked(overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: "cp-park", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "awaiting_merge",
		worker: { pid: 4242, session_id: "s", session_file: "/nonexistent/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: AT, exited_at: AT, exit_code: 0 },
		worktree: "/tmp/worktrees/recycled", branch: "cp-park", dispatched_at: "2026-10-15T09:50:00Z", reported_at: AT,
		usage: EMPTY_USAGE, awaiting_merge: parking(), ...overrides,
	};
}

const file = (...jobs: unknown[]) => ({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs });

test("a parked record validates; every mixed-resource or mislabelled shape is refused", () => {
	assert.equal(validateFleetFile(file(parked())).ok, true);
	const { awaiting_merge: _drop, ...legacy } = parked({ phase: "held" });
	assert.equal(validateFleetFile(file(legacy)).ok, true, "an old held record without the field still reads");
	assert.equal(validateFleetFile(file(parked({ phase: "done", closed_at: AT }))).ok, true, "history survives closure");
	const live = parked();
	delete live.worker.exited_at;
	for (const [why, bad] of [
		["no parking record", { ...parked(), awaiting_merge: undefined }],
		["live worker", live],
		["held lease", parked({ lease_id: "lease-1" })],
		["checkpoint ref", parked({ checkpoint_ref: "refs/cp-checkpoints/cp-park" })],
		["research job", parked({ kind: "research" })],
		["local delivery", parked({ delivery: "local" })],
		["no envelope", parked({ reported_at: undefined })],
		["branch mismatch", parked({ awaiting_merge: parking({ branch: "other" }) })],
		["short sha", parked({ awaiting_merge: parking({ head_sha: "abc1234" }) })],
		["record on a held job", parked({ phase: "held" })],
	] as const) assert.equal(validateFleetFile(file(bad)).ok, false, why);
});

test("pending CP work takes a parked job out of the quiescent set", () => {
	assert.equal(isQuiescentParked(parked()), true);
	const pending = parked({ awaiting_merge: parking({ pending: { kind: "human_comment", event_id: "IC_1", observed_at: AT } }) });
	assert.equal(validateFleetFile(file(pending)).ok, true);
	assert.equal(isQuiescentParked(pending), false);
	assert.equal(isQuiescentParked(parked({ phase: "held" })), false);
});

test("reconcile leaves a parked job alone: never revivable, failed or probed, even with its session gone", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new FleetStore({ home: home.path });
	await store.add(parked());
	let probed = false;
	const report = await store.reconcile({ isPidAlive: () => { probed = true; return true; } });
	assert.equal(probed, false);
	assert.deepEqual(report.entries.map((e) => [e.outcome, e.phase_after, e.resumable]), [["parked", "awaiting_merge", false]]);
	assert.deepEqual(report.revivable, []);
	assert.deepEqual(report.needs_intake, []);
	assert.equal(store.require("cp-park").phase, "awaiting_merge");
});

test("intent, watch, stack and CI evidence records enforce their cross-field rules", () => {
	const intent = { schema_version: 1, job_id: "cp-park", cycle: 1, stage: "intent", pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: HEAD, base: "main", created_at: AT, updated_at: AT };
	assert.equal(validateParkIntent(intent).ok, true);
	assert.equal(validateParkIntent({ ...intent, stage: "parked" }).ok, false);

	const pr = { job_id: "cp-park", cycle: 1, pr_url: intent.pr_url, state: "open", head_sha: HEAD, base: "main", approvals: 1, approvals_required: null, cursors: { comments: "Y3Vyc29y" }, observed_at: AT };
	const watch = (...prs: unknown[]) => ({ schema_version: 1, updated_at: AT, prs });
	assert.equal(validateAwaitingMergeWatchFile(watch(pr)).ok, true, "unknown required approvals is null, not zero");
	assert.equal(validateAwaitingMergeWatchFile(watch({ ...pr, state: "merged" })).ok, false, "a merge needs its sha");
	assert.equal(validateAwaitingMergeWatchFile(watch({ ...pr, state: "merged", merge_sha: "b".repeat(40) })).ok, true);
	assert.equal(validateAwaitingMergeWatchFile(watch(pr, pr)).ok, false, "one row per job");

	const edge = { parent_job: "cp-park", child_job: "cp-child", repo: "o/r", parent_branch: "cp-park", child_branch: "cp-child", observed_at: AT };
	const action = { id: `cp-park:cp-child:${HEAD}`, parent_job: "cp-park", child_job: "cp-child", repo: "o/r", child_branch: "cp-child", previous_base: "cp-park", target_base: "main", merge_sha: HEAD, queued_at: AT, status: "pending" };
	const stack = (edges: unknown[], actions: unknown[]) => ({ schema_version: 1, updated_at: AT, edges, actions });
	assert.equal(validateStackFollowupsFile(stack([edge], [action])).ok, true);
	assert.equal(validateStackFollowupsFile(stack([{ ...edge, child_job: "cp-park" }], [])).ok, false);
	assert.equal(validateStackFollowupsFile(stack([], [{ ...action, id: "x" }])).ok, false);
	assert.equal(validateStackFollowupsFile(stack([], [{ ...action, status: "done" }])).ok, false, "settled needs settled_at");
	assert.equal(validateStackFollowupsFile(stack([], [action, action])).ok, false);

	const ci = (observation: object) => ({ schema_version: 1, job_id: "cp-park", repo: "o/r", observations: [{ head_sha: HEAD, result: "success", observed_at: AT, ...observation }] });
	assert.equal(validateCiEvidenceFile(ci({ source: "actions" })).ok, true);
	assert.equal(validateCiEvidenceFile(ci({ source: "forwarded" })).ok, false, "forwarded CI needs its operator quote");
	assert.equal(validateCiEvidenceFile(ci({ source: "forwarded", operator_quote: "CI is green on aaaa" })).ok, true);
	assert.equal(validateCiEvidenceFile(ci({ source: "actions", operator_quote: "x" })).ok, false);
	assert.equal(paths.parkIntentFile("cp-park"), `${LAYOUT.runs}/cp-park/park-intent.json`);
	assert.equal(paths.ciEvidenceFile("cp-park"), `${LAYOUT.runs}/cp-park/ci-evidence.json`);
});

test("viewer: a parked job leaves In flight for With the team, keeps its phase, and the fleet stays readable", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const put = (path: string, value: unknown) => { const full = join(home.path, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, JSON.stringify(value)); };
	const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
	const pending = parked({ job_id: "cp-pend", branch: "cp-pend", awaiting_merge: parking({ branch: "cp-pend", pending: { kind: "changes_requested", event_id: "PRR_1", observed_at: AT } }) });
	put(LAYOUT.fleetFile, file(parked(), pending, { job_id: "cp-held", project: "demo", phase: "held" }));
	const now = Date.parse("2026-10-15T12:00:00Z");
	const data = overview(state, now);
	assert.equal(data.availability.fleet, "ok");
	assert.deepEqual(data.in_flight.map((j) => [j.id, j.phase]), [["cp-pend", "held"], ["cp-held", "held"]], "a pending parked row is CP work");
	assert.deepEqual(data.with_team.map((j) => [j.id, j.head, j.age_seconds, j.frozen_seconds, j.approvals, j.ci]), [["cp-park", HEAD, 7200, 600, null, null]]);
	assert.equal(overview(state, now + 60_000).with_team[0]?.frozen_seconds, 600, "execution time is frozen while team age grows");
	const jobs = jobsView(state, now).jobs;
	assert.equal(jobs.find((j) => j.id === "cp-park")?.phase, "awaiting_merge");
	assert.equal(jobs.find((j) => j.id === "cp-pend")?.phase, "held", "Board and Overview agree: pending is not With the team");
	assert.ok(boardView(state, now).columns.some((c) => c.key === "awaiting_merge"));
});
