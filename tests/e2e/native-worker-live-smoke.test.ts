/**
 * Native driver live smoke, operator-run: skipped unless CP_LIVE_TESTS=1 and `claude` is on PATH. One no-tool turn on
 * the operator's default settings path (claude reads it; picp never does), through the lockdown. Counts only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whichAll } from "../../src/doctor.ts";
import { runClaudeSpike } from "../../src/drivers/claude-spike.ts";
import { LIVE_TESTS_ENABLED } from "../harness/index.ts";

const skip = !LIVE_TESTS_ENABLED ? "set CP_LIVE_TESTS=1 to run live smokes" : whichAll("claude", process.env)[0] ? false : "claude is not on PATH";

test("native live smoke: one no-tool turn on the installed claude passes the lockdown and exits 0", { skip, timeout: 180_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-native-live-"));
	try {
		const result = await runClaudeSpike({
			job: { job_id: "cp-native-live-smoke", kind: "research", role: "planner", delivery: "local", runDir: join(root, "run"), worktree: root, artifactPath: join(root, "a", "r.md") },
			prompt: "Reply with the single word: ok",
			tools: [],
			maxTurns: 1,
			timeoutMs: 150_000,
		});
		const { exit, lockdown, resultSubtype } = result;
		// Exit, verdict and counts only: never names, paths or env from the operator's settings.
		t.diagnostic(JSON.stringify({ exit, verdict: lockdown?.verdict, seen: lockdown?.seen, extra: lockdown?.extra, checkMs: lockdown?.checkMs, resultSubtype }));
		assert.equal(result.spawnedCommand, result.claudePath);
		assert.equal(lockdown?.verdict, "ok");
		assert.deepEqual(exit, { code: 0, signal: null, killedByDriver: false });
		assert.equal(resultSubtype, "success");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
