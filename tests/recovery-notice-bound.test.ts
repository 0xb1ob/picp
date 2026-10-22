/** Restart recovery with many failed candidates must journal one bounded notice, never none (cp-recovery-notice-bound). */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import { CommandPost } from "../src/command-post.ts";
import { EMPTY_USAGE, type FleetRecord } from "../src/contracts.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { createScratchHome } from "./harness/index.ts";

const failed = (n: number): FleetRecord => ({
	job_id: `cp-recovery-candidate-number-${String(n).padStart(2, "0")}`, project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting",
	worker: { pid: 4242, session_id: "s", session_file: "/nonexistent/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: "2026-10-15T09:00:00Z" },
	worktree: "/wt/x", branch: "x", dispatched_at: "2026-10-15T09:00:00Z", usage: EMPTY_USAGE, lease_id: "lease-1",
});

test("reconcile with 40 failed candidates journals exactly one bounded recovery notice", async (t) => {
	const home = createScratchHome();
	const post = new CommandPost({ home: home.path, packageRoot: PACKAGE_ROOT, holdsParentLock: () => true });
	t.after(() => {
		post.shutdown();
		home.cleanup();
	});
	for (let n = 0; n < 40; n++) await post.fleet.add(failed(n));
	await post.reconcile({ isPidAlive: () => false });
	const notices = post.durableWakeups.pending().filter((entry) => entry.content.startsWith("RESTART RECOVERY"));
	assert.equal(notices.length, 1, "exactly one notice");
	assert.ok(notices[0]!.content.length <= 4000);
	assert.match(notices[0]!.content, /\.\.\.and \d+ more/);
	assert.match(notices[0]!.content, /40 candidate\(s\)/);
});
