/**
 * cp-80cv retained (P10d): the /cp-awaiting skip writer and PipelineStore's own fault on an unreadable state/pipelines
 * have no entry point a mock-model parent reaches; the rest of the file moved to tests/e2e/decisions-p10d.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore, mergeAwaiting } from "../src/awaiting.ts";
import { type AwaitingWriters, resolveAwaitingResponse } from "./harness/awaiting-resolve.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { CommandPost } from "../src/command-post.ts";
import { FleetStore } from "../src/fleet.ts";
import { PipelineStore } from "../src/pipeline.ts";
import type { FleetRecord, PipelineRecord, StatusJob } from "../src/contracts.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, LAYOUT, SCHEMA_VERSION } from "../src/contracts.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

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
