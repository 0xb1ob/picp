/**
 * N3c H1: the native busy-send queue's claim. The race (a send queued while the worker awaits admission) has no
 * deterministic entry point in the e2e harness, so it is pinned here on the queue helpers the worker calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimFollowUps, enqueueFollowUp, queuedFollowUps, returnClaim, settleClaim } from "../src/drivers/claude-followup.ts";

test("H1: a send queued during the admission await stays queued for the next turn end; a refusal loses nothing", (t) => {
	const runDir = mkdtempSync(join(tmpdir(), "cp-n3c-queue-"));
	t.after(() => rmSync(runDir, { recursive: true, force: true }));
	enqueueFollowUp(runDir, "first");
	assert.deepEqual(claimFollowUps(runDir), ["first"]);
	enqueueFollowUp(runDir, "during admission");
	settleClaim(runDir);
	assert.deepEqual(queuedFollowUps(runDir), ["during admission"], "the delivery dropped a send it never claimed");
	assert.deepEqual(claimFollowUps(runDir), ["during admission"], "the next turn end delivers it");
	enqueueFollowUp(runDir, "newer");
	returnClaim(runDir);
	assert.deepEqual(queuedFollowUps(runDir), ["during admission", "newer"], "a refused claim goes back first, once");
	assert.deepEqual(claimFollowUps(runDir), ["during admission", "newer"]);
	settleClaim(runDir);
	assert.deepEqual(queuedFollowUps(runDir), []);
});
