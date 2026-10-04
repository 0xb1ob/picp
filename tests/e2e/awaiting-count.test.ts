/**
 * cp-awaiting-count-mismatch-4qo: the marker count and /cp-decide list must agree.
 *
 * The marker is derived from awaitingSnapshotSync() which reads from disk
 * (checkpoints, fleet, awaiting.json). When cp_status_block is called, the
 * awaiting rows passed by the caller are rendered in the status block AND
 * persisted to state/awaiting.json, so the marker count reflects the full
 * merged set and matches what /cp-decide will offer.
 *
 * This exercises the persistence path: cp_status_block declares rows to the
 * AwaitingStore, and the marker count equals the number of items the resolver
 * will offer.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { createScratchHome } from "../harness/state.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test(
	"marker count equals the number of items /cp-decide will offer: declared rows only",
	{ timeout: 30_000 },
	async () => {
		const home = createScratchHome();
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });

		// Simulate what cp_status_block does: declare some awaiting rows.
		await post.awaiting.declare({
			type: "approval",
			decision: "cp-x: ship, drop or follow-up?",
			why: "finished research",
			blocks: "cp-x follow-on",
		});
		await post.awaiting.declare({
			type: "design",
			decision: "postgres or sqlite?",
			why: "schema choice",
			blocks: "cp-db implementation",
		});

		// The marker count should equal the merged set (marker = snapshot length).
		const snapshot = post.awaitingSnapshotSync();
		assert.equal(snapshot.length, 2, "marker count matches declared rows");

		// And /cp-decide list should return the same items.
		const list = post.awaiting.list("open");
		assert.equal(list.length, 2, "list count matches marker count");
		assert.deepEqual(
			list.map((item) => item.decision),
			snapshot.map((item) => item.decision),
			"declared rows survive the round trip through persistence",
		);

		home.cleanup();
	},
);

test(
	"marker count equals the number of items /cp-decide will offer: mixed sources",
	{ timeout: 30_000 },
	async () => {
		const home = createScratchHome();
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });

		// Add a pending checkpoint (authorization source).
		post.checkpoints.request({ jobId: "cp-auth", question: "authorize this?" });

		// Add a declared awaiting row (declared source).
		await post.awaiting.declare({
			type: "design",
			decision: "postgres or sqlite?",
			why: "schema choice",
			blocks: "cp-db implementation",
		});

		// The marker count should include both sources (authorization + declared).
		const snapshot = post.awaitingSnapshotSync();
		assert.equal(snapshot.length, 2, "marker includes both authorization and declared");

		// The authorization row is not in awaiting.json (it's a read from checkpoints),
		// but the merged snapshot includes it.
		const declared = post.awaiting.list("open");
		assert.equal(declared.length, 1, "awaiting.json has only the declared row");
		assert.equal(snapshot.length, 2, "but the merged snapshot includes the checkpoint");

		home.cleanup();
	},
);

test(
	"marker count accounts for answered items being pruned",
	{ timeout: 30_000 },
	async () => {
		const home = createScratchHome();
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });

		// Declare three items.
		const item1 = await post.awaiting.declare({
			type: "design",
			decision: "decision 1",
			why: "why 1",
			blocks: "blocks 1",
		});
		await post.awaiting.declare({
			type: "design",
			decision: "decision 2",
			why: "why 2",
			blocks: "blocks 2",
		});
		await post.awaiting.declare({
			type: "design",
			decision: "decision 3",
			why: "why 3",
			blocks: "blocks 3",
		});

		// All three are open.
		let snapshot = post.awaitingSnapshotSync();
		assert.equal(snapshot.length, 3, "all three items are open");

		// Answer one.
		await post.awaiting.answer(item1.id, { answer: "yes", by: "test" });

		// The marker count still includes it (answered items are kept in the file
		// up to AWAITING_KEEP_ANSWERED), but it is not in the open set.
		snapshot = post.awaitingSnapshotSync();
		const openOnly = post.awaiting.list("open");
		assert.equal(openOnly.length, 2, "open set excludes the answered item");
		// The snapshot includes all items relevant to /cp-decide (only open items
		// are offered), so the marker should only count open items.
		const openInSnapshot = snapshot.filter((item) => !item.snoozed);
		assert.equal(openInSnapshot.length, 2, "marker counts only open items, not answered ones");

		home.cleanup();
	},
);
