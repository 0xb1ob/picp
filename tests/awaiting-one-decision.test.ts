/**
 * cp-80cv: one decision is one question.
 *
 * A pipeline's single "should this be implemented?" reached the operator twice
 * — as the derived approval row for the finished research job ("cp-uf00: ship,
 * drop or follow-up?", answered `drop` at 18:07:26) and as the authorization
 * checkpoint minted for its dep-linked ship job ("Authorize implementation of
 * cp-76xa?", declined at 18:07:44). Eighteen seconds apart, same decision.
 *
 * The checkpoint is the one that survives: it is the stronger instrument (only
 * /cp-authorize, /cp-decline or an approve/decline answer in /cp-decide can
 * answer it, and `CheckpointStore.decide` is its single writer), so the derived
 * research row is the one suppressed. Everything below exercises that against
 * the real stores over a scratch home, never a stub of the thing under test.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore, mergeAwaiting, resolveAwaitingResponse, type AwaitingWriters } from "../src/awaiting.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { CommandPost } from "../src/command-post.ts";
import { FleetStore } from "../src/fleet.ts";
import { PipelineStore } from "../src/pipeline.ts";
import type { Checkpoint, FleetRecord, PipelineRecord, StatusJob } from "../src/contracts.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, LAYOUT, SCHEMA_VERSION } from "../src/contracts.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

function checkpoint(overrides: Partial<Checkpoint> & { job_id: string }): Checkpoint {
	return {
		schema_version: SCHEMA_VERSION,
		question: "Authorize implementation of cp-76xa (pi-command-post, delivery pr)?",
		requested_at: "2026-09-04T18:07:00Z",
		decision: "pending",
		...overrides,
	};
}

function heldResearchJob(overrides: Partial<StatusJob> & { job_id: string }): StatusJob {
	return {
		project: "pi-command-post",
		kind: "research",
		delivery: "pipeline",
		origin: "terminal",
		phase: "held",
		title: null,
		br_status: null,
		profile: "planner",
		role: "planner",
		model: "anthropic/claude-sonnet-5",
		run_phase: null,
		current_tool: null,
		current_tool_seconds: null,
		turns: 0,
		tool_calls: 0,
		alive: false,
		pid: 1234,
		session_id: "sess",
		worktree: "/tmp/demo",
		branch: overrides.job_id,
		timestamp: "2026-09-04T18:00:00Z",
		time_source: "dispatched_at",
		age_seconds: 60,
		last_activity_at: null,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 },
		...overrides,
	} as StatusJob;
}

function pipelineRecord(researchId: string, shipId: string): PipelineRecord {
	return {
		schema_version: SCHEMA_VERSION,
		research_id: researchId,
		ship_id: shipId,
		project: "pi-command-post",
		delivery: "pr",
		state: "awaiting_authorization",
		created_at: "2026-09-04T17:00:00Z",
		updated_at: "2026-09-04T18:07:00Z",
	};
}

/** A finished research job as the fleet file holds one (`phase: held`, no PR receipt). */
function heldResearchRecord(jobId: string, delivery: "pipeline" | "pr"): FleetRecord {
	return {
		job_id: jobId,
		project: "pi-command-post",
		kind: "research",
		delivery,
		origin: DEFAULT_ORIGIN,
		phase: "held",
		worktree: `/tmp/${jobId}`,
		branch: jobId,
		dispatched_at: "2026-09-04T17:00:00Z",
		reported_at: "2026-09-04T18:00:00Z",
		usage: { ...EMPTY_USAGE },
		worker: {
			pid: 4242,
			session_id: `sess-${jobId}`,
			session_file: `/sessions/${jobId}.jsonl`,
			profile: "planner",
			role: "planner",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-09-04T17:00:00Z",
		},
	} as FleetRecord;
}

/** Exactly the wiring `extensions/command-post/index.ts#awaitingWriters` uses. */
function liveWriters(store: AwaitingStore, checkpoints: CheckpointStore): AwaitingWriters {
	return {
		decideCheckpoint: (jobId, approved, by) => {
			checkpoints.decide(jobId, approved, { by });
		},
		answerDeclared: async (item, answer, by) => {
			await store.answerResolved(item, { answer, by });
		},
	};
}

test("cp-80cv: the observed shape — one pipeline, one question, and the standalone row is untouched", () => {
	const rows = mergeAwaiting({
		checkpoints: [checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00" })],
		heldResearch: [
			// The pipeline's research job: finished, no PR receipt — the row that used
			// to be asked alongside the checkpoint.
			heldResearchJob({ job_id: "cp-uf00" }),
			// A standalone research job, dispatched on its own. Its row must still be
			// raised exactly as before: the fix is a dedup, never "drop derived rows".
			heldResearchJob({ job_id: "cp-solo", delivery: "pr" }),
		],
		declared: [],
	});

	assert.deepEqual(
		rows.map((row) => row.id),
		["aw-checkpoint-cp-76xa", "aw-research-cp-solo"],
	);
	assert.equal(rows[0]!.type, "authorization");
	assert.deepEqual(rows[1]!.options, ["ship", "drop", "follow-up"]);
});

test("cp-80cv: the pipeline record links the two jobs when the checkpoint carries no research_id", () => {
	const jobs = [heldResearchJob({ job_id: "cp-uf00" })];

	// A checkpoint file written without `research_id` (before the field, or by
	// another path) still names the ship job, and the pipeline record is what says
	// whose ship job it is.
	const linked = mergeAwaiting({
		checkpoints: [checkpoint({ job_id: "cp-76xa" })],
		pipelines: [pipelineRecord("cp-uf00", "cp-76xa")],
		heldResearch: jobs,
		declared: [],
	});
	assert.deepEqual(
		linked.map((row) => row.id),
		["aw-checkpoint-cp-76xa"],
	);

	// And with neither link, nothing is suppressed: a pending authorization for
	// some *other* job never silences a research row.
	const unrelated = mergeAwaiting({
		checkpoints: [checkpoint({ job_id: "cp-other" })],
		heldResearch: jobs,
		declared: [],
	});
	assert.deepEqual(
		unrelated.map((row) => row.id),
		["aw-checkpoint-cp-other", "aw-research-cp-uf00"],
	);
});

test("cp-80cv: a pipeline that has not reached a checkpoint still raises its research row", () => {
	// The row is suppressed by an authorization, never by being part of a
	// pipeline: a plan that is gated but not yet authorized has no checkpoint, and
	// the operator's "ship, drop or follow-up?" is the only question there is.
	const rows = mergeAwaiting({
		checkpoints: [],
		pipelines: [pipelineRecord("cp-uf00", "cp-76xa")],
		heldResearch: [heldResearchJob({ job_id: "cp-uf00" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		["aw-research-cp-uf00"],
	);
});

/**
 * pi-command-post-p18: why a refused checkpoint ask loses nothing.
 *
 * An overlay is a frozen snapshot — nothing re-derives what is already on
 * screen. So a research row rendered *before* the checkpoint existed is stale,
 * and the mechanism that corrects it is the loop's own next round:
 * `driveAwaitingQuestionnaire` calls `mergeAwaiting` again between rounds, and
 * that call already returns the checkpoint instead of the research row. That is
 * why the fix needs no queue: the question the latch refused is the question
 * the next round offers.
 */
test("pi-command-post-p18: the next round offers the checkpoint the stale overlay could not", () => {
	const heldResearch = [heldResearchJob({ job_id: "cp-uf00" })];
	const pipelines = [pipelineRecord("cp-uf00", "cp-76xa")];

	// Round 1 — the gate has passed but nothing is authorized yet, so the operator
	// is looking at "ship, drop or follow-up?" for the research job.
	const before = mergeAwaiting({ checkpoints: [], pipelines, heldResearch, declared: [] });
	assert.deepEqual(
		before.map((row) => row.id),
		["aw-research-cp-uf00"],
	);

	// A wake-up runs a turn while that overlay is up and `cp_pipeline advance`
	// mints the ship checkpoint. Its ask is refused by the latch and nothing is
	// written — the checkpoint is simply `pending` on disk, as `request` left it.
	const checkpoints = [checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00" })];

	// Round 2 — same pair, re-derived: the stronger instrument is what is offered,
	// and the stale research row is gone. No queue, nothing lost.
	const after = mergeAwaiting({ checkpoints, pipelines, heldResearch, declared: [] });
	assert.deepEqual(
		after.map((row) => row.id),
		["aw-checkpoint-cp-76xa"],
	);
	assert.equal(after[0]!.type, "authorization");
});

test("cp-80cv: end to end over the real stores — one row, and skip still writes nothing", async () => {
	const home = createScratchHome();
	try {
		const awaiting = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		const pipelines = new PipelineStore(home.path);
		pipelines.write(pipelineRecord("cp-uf00", "cp-76xa"));
		checkpoints.request({
			jobId: "cp-76xa",
			researchId: "cp-uf00",
			question: "Authorize implementation of cp-76xa (pi-command-post, delivery pr)?",
			at: "2026-09-04T18:07:00Z",
		});
		const jobs = [heldResearchJob({ job_id: "cp-uf00" })];
		const render = (): ReturnType<typeof mergeAwaiting> => {
			const all = checkpoints.list();
			return mergeAwaiting({
				checkpoints: all.filter((entry) => entry.decision === "pending"),
				answeredCheckpoints: all.filter((entry) => entry.decision !== "pending"),
				pipelines: pipelines.list(),
				heldResearch: jobs,
				declared: awaiting.list(),
			});
		};

		const offered = render();
		assert.deepEqual(
			offered.map((row) => row.id),
			["aw-checkpoint-cp-76xa"],
			"the operator is asked once, and it is the checkpoint",
		);

		// Skip: nothing is written anywhere, and the item reappears unchanged.
		const skipped = await resolveAwaitingResponse({ id: offered[0]!.id, kind: "skip" }, offered[0]!, liveWriters(awaiting, checkpoints));
		assert.equal(skipped.wrote, false);
		assert.ok(!existsSync(awaiting.file), "skip never materialises a row");
		assert.equal(checkpoints.get("cp-76xa")!.decision, "pending", "skip is not a verdict");
		assert.deepEqual(
			render().map((row) => row.id),
			["aw-checkpoint-cp-76xa"],
			"the skipped question comes back, and still only once",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-80cv: declining the survivor goes through the one writer, and asks nothing further", async () => {
	const home = createScratchHome();
	try {
		const awaiting = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		const pipelines = new PipelineStore(home.path);
		pipelines.write(pipelineRecord("cp-uf00", "cp-76xa"));
		checkpoints.request({ jobId: "cp-76xa", researchId: "cp-uf00", question: "Authorize implementation of cp-76xa?" });
		const jobs = [heldResearchJob({ job_id: "cp-uf00" })];
		const render = (): ReturnType<typeof mergeAwaiting> => {
			const all = checkpoints.list();
			return mergeAwaiting({
				checkpoints: all.filter((entry) => entry.decision === "pending"),
				answeredCheckpoints: all.filter((entry) => entry.decision !== "pending"),
				pipelines: pipelines.list(),
				heldResearch: jobs,
				declared: awaiting.list(),
			});
		};

		const item = render()[0]!;
		const result = await resolveAwaitingResponse(
			{ id: item.id, kind: "answer", value: "decline", by: "operator dialog (tui)" },
			item,
			liveWriters(awaiting, checkpoints),
		);
		assert.equal(result.wrote, true);

		// One record of the decision, and it is the checkpoint file.
		const record = checkpoints.get("cp-76xa")!;
		assert.equal(record.decision, "declined");
		assert.equal(record.decided_by, "operator dialog (tui)");
		assert.ok(!existsSync(awaiting.file), "an authorization never lands in state/awaiting.json");

		// And the derived row does not take its place the moment the checkpoint
		// stops being pending: "decline the implementation" and "drop the research"
		// are the same answer, so re-deriving it here would reproduce the defect a
		// few seconds later instead of eighteen. The research job leaves the set the
		// ordinary way, when the parent tears it down.
		assert.deepEqual(render(), []);
	} finally {
		home.cleanup();
	}
});

test("cp-80cv: an answered checkpoint for another job never suppresses a research row", () => {
	// The mirror of the test above: suppression follows the link, not the mere
	// existence of an answered checkpoint somewhere in the home.
	const rows = mergeAwaiting({
		checkpoints: [],
		answeredCheckpoints: [checkpoint({ job_id: "cp-other", decision: "approved", research_id: "cp-different" })],
		heldResearch: [heldResearchJob({ job_id: "cp-uf00" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		["aw-research-cp-uf00"],
	);
});

test("cp-80cv: a diff or merge checkpoint neither creates the suppression nor removes it", () => {
	const jobs = [heldResearchJob({ job_id: "cp-uf00" })];
	const link = [pipelineRecord("cp-uf00", "cp-76xa")];

	// A pending *diff* checkpoint for the same ship job — it carries a
	// `research_id` exactly like the ship one does (PipelineRunner#authorizeDiff)
	// — asks about code that already exists, not about whether to implement the
	// plan. It renders its own row and suppresses nothing.
	const diffOnly = mergeAwaiting({
		checkpoints: [],
		diffCheckpoints: [checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00", question: "accept the diff?" })],
		pipelines: link,
		heldResearch: jobs,
		declared: [],
	});
	assert.deepEqual(
		diffOnly.map((row) => row.id),
		["aw-checkpoint-cp-76xa.diff", "aw-research-cp-uf00"],
	);

	// The same for a pending merge authorization, which is addressed by head sha.
	const mergeOnly = mergeAwaiting({
		checkpoints: [],
		mergeCheckpoints: [
			checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00", scope: "abcdef123456", kind: "merge", question: "merge it?" }),
		],
		pipelines: link,
		heldResearch: jobs,
		declared: [],
	});
	assert.deepEqual(
		mergeOnly.map((row) => row.id),
		["aw-checkpoint-cp-76xa.merge-abcdef123456", "aw-research-cp-uf00"],
	);

	// And with the ship checkpoint alongside them, the suppression is the ship
	// one's: every authorization still renders, and the research row does not.
	const all = mergeAwaiting({
		checkpoints: [checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00" })],
		diffCheckpoints: [checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00", question: "accept the diff?" })],
		mergeCheckpoints: [
			checkpoint({ job_id: "cp-76xa", research_id: "cp-uf00", scope: "abcdef123456", kind: "merge", question: "merge it?" }),
		],
		pipelines: link,
		heldResearch: jobs,
		declared: [],
	});
	assert.deepEqual(
		all.map((row) => row.id),
		["aw-checkpoint-cp-76xa", "aw-checkpoint-cp-76xa.diff", "aw-checkpoint-cp-76xa.merge-abcdef123456"],
	);
});

// ---------------------------------------------------------------------------
// The production wiring: CommandPost, not a hand-rolled render
// ---------------------------------------------------------------------------

test("cp-80cv: the real path asks once — awaitingSnapshotSync and awaitingSnapshot agree", async () => {
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(heldResearchRecord("cp-uf00", "pipeline"));
		await fleet.add(heldResearchRecord("cp-solo", "pr"));
		post.pipelines.write(pipelineRecord("cp-uf00", "cp-76xa"));
		post.checkpoints.request({
			jobId: "cp-76xa",
			researchId: "cp-uf00",
			question: "Authorize implementation of cp-76xa (pi-command-post, delivery pr)?",
			at: "2026-09-04T18:07:00Z",
		});

		// The widget's files-only render (`#shipCheckpoints` + `#pipelineLinks`).
		const sync = post.awaitingSnapshotSync().map((row) => row.id);
		assert.deepEqual(sync, ["aw-checkpoint-cp-76xa", "aw-research-cp-solo"]);

		// And the async one every dialog and marker path uses. The two read the same
		// split and the same links, and asserting they agree is what keeps the call
		// sites from drifting apart.
		const asyncIds = (await post.awaitingSnapshot()).map((row) => row.id);
		assert.deepEqual(asyncIds, sync);

		// The answered half, through the real single writer: the decision leaves the
		// table and the derived row does not take its place.
		post.checkpoints.decide("cp-76xa", false, { by: "operator command" });
		assert.deepEqual(
			post.awaitingSnapshotSync().map((row) => row.id),
			["aw-research-cp-solo"],
		);
		assert.deepEqual(
			(await post.awaitingSnapshot()).map((row) => row.id),
			["aw-research-cp-solo"],
		);
	} finally {
		home.cleanup();
	}
});

test("cp-80cv: an absent or unreadable state/pipelines still asks once, via Checkpoint.research_id", async () => {
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(heldResearchRecord("cp-uf00", "pipeline"));
		post.checkpoints.request({ jobId: "cp-76xa", researchId: "cp-uf00", question: "Authorize implementation of cp-76xa?" });

		// No pipelines directory at all: the checkpoint's own research_id carries
		// the link, so the secondary half is never needed.
		assert.deepEqual(
			post.awaitingSnapshotSync().map((row) => row.id),
			["aw-checkpoint-cp-76xa"],
		);

		// And an unreadable one — a file where the directory should be, so
		// `readdirSync` throws ENOTDIR. `#pipelineLinks` swallows it: a broken
		// secondary link costs a dedup hint, never the listing itself.
		const pipelines = join(home.path, LAYOUT.pipelines);
		rmSync(pipelines, { recursive: true, force: true });
		writeFileSync(pipelines, "not a directory");
		// The store itself still reports the fault; only the render swallows it.
		assert.throws(() => post.pipelines.list());
		assert.deepEqual(
			post.awaitingSnapshotSync().map((row) => row.id),
			["aw-checkpoint-cp-76xa"],
			"the render degrades to the checkpoint's own link instead of failing",
		);
		assert.deepEqual(
			(await post.awaitingSnapshot()).map((row) => row.id),
			["aw-checkpoint-cp-76xa"],
		);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Ineligible held pipeline research (cp-5hqi)
// ---------------------------------------------------------------------------

test("cp-5hqi: escalated held research is absent from snapshot, including after restart", async () => {
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(heldResearchRecord("cp-uf00", "pipeline"));
		post.pipelines.write({ ...pipelineRecord("cp-uf00", "cp-76xa"), state: "escalated" });

		const sync = post.awaitingSnapshotSync().map((row) => row.id);
		assert.ok(!sync.includes("aw-research-cp-uf00"));
		assert.deepEqual(
			(await post.awaitingSnapshot()).map((row) => row.id),
			sync,
		);

		const restarted = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		assert.ok(
			!restarted.awaitingSnapshotSync().map((row) => row.id).includes("aw-research-cp-uf00"),
			"a fresh CommandPost on the same files does not re-derive the row",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-5hqi: reanchor write drops the old id on the next snapshot", async () => {
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(heldResearchRecord("cp-uf00", "pipeline"));
		const old = { ...pipelineRecord("cp-uf00", "cp-76xa"), state: "gating" as const };
		post.pipelines.write(old);
		assert.deepEqual(post.awaitingSnapshotSync().map((row) => row.id), ["aw-research-cp-uf00"]);

		// The write shape PipelineRunner.reanchor already performs (src/pipeline.ts).
		post.pipelines.write({ ...old, superseded_by: "cp-replacement", updated_at: "2026-09-04T19:00:00Z" });
		assert.deepEqual(post.awaitingSnapshotSync().map((row) => row.id), []);
		assert.deepEqual((await post.awaitingSnapshot()).map((row) => row.id), []);
	} finally {
		home.cleanup();
	}
});

test("cp-5hqi: declined ship checkpoint still omits the pipeline row and keeps standalone", async () => {
	// cp-80cv owns this path via answeredCheckpoints / researchIdsUnderAuthorization.
	// Pin it so the new ineligible predicate cannot become the only reason it stays gone.
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(heldResearchRecord("cp-uf00", "pipeline"));
		await fleet.add(heldResearchRecord("cp-solo", "pr"));
		post.pipelines.write(pipelineRecord("cp-uf00", "cp-76xa"));
		post.checkpoints.request({
			jobId: "cp-76xa",
			researchId: "cp-uf00",
			question: "Authorize implementation of cp-76xa (pi-command-post, delivery pr)?",
			at: "2026-09-04T18:07:00Z",
		});
		post.checkpoints.decide("cp-76xa", false, { by: "operator command" });
		assert.deepEqual(post.awaitingSnapshotSync().map((row) => row.id), ["aw-research-cp-solo"]);
		assert.deepEqual((await post.awaitingSnapshot()).map((row) => row.id), ["aw-research-cp-solo"]);
	} finally {
		home.cleanup();
	}
});

test("cp-5hqi: gating without superseded_by still offers the research row", async () => {
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(heldResearchRecord("cp-uf00", "pipeline"));
		post.pipelines.write({ ...pipelineRecord("cp-uf00", "cp-76xa"), state: "gating" });
		assert.deepEqual(post.awaitingSnapshotSync().map((row) => row.id), ["aw-research-cp-uf00"]);
		assert.deepEqual((await post.awaitingSnapshot()).map((row) => row.id), ["aw-research-cp-uf00"]);
	} finally {
		home.cleanup();
	}
});
