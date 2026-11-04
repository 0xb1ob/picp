/**
 * N2 spike live smoke, operator-run: skipped unless CP_LIVE_TESTS=1 and `claude` is on PATH. One no-tool turn on the
 * operator's login (claude reads its own settings file; picp never does); records exit, versions, model, usage only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whichAll } from "../../src/doctor.ts";
import { runClaudeSpike } from "../../src/drivers/claude-spike.ts";
import { LIVE_TESTS_ENABLED } from "../harness/index.ts";

const skip = !LIVE_TESTS_ENABLED ? "set CP_LIVE_TESTS=1 to run live smokes" : whichAll("claude", process.env)[0] ? false : "claude is not on PATH";

test("native spike live smoke: one no-tool turn on the installed claude exits 0 and reports its model and usage", { skip, timeout: 180_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-native-live-"));
	try {
		const result = await runClaudeSpike({
			job: { job_id: "cp-native-live-smoke", delivery: "local", runDir: join(root, "run"), worktree: root, artifactPath: join(root, "a", "r.md") },
			prompt: "Reply with the single word: ok",
			userSettings: join(homedir(), ".claude", "settings.json"),
			tools: [],
			maxTurns: 1,
			timeoutMs: 150_000,
		});
		const { exit, claudeVersion, sdkVersion, initModel, resultSubtype, durationMs, coldStartMs, usage, error } = result;
		t.diagnostic(JSON.stringify({ exit, claudeVersion, sdkVersion, initModel, resultSubtype, durationMs, coldStartMs, usage, error }));
		assert.equal(result.spawnedCommand, result.claudePath);
		assert.deepEqual(exit, { code: 0, signal: null, killedByDriver: false });
		assert.equal(resultSubtype, "success");
		assert.ok(initModel);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
