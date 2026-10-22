import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, isoTimestamp, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";

// A CI notice for a job promoted after it (phase waiting, generation 2) must reach the provider with its
// promotion note; the context hook once dropped the annotated copy by object identity.
test("wake: a CI notice for a promoted job reaches the provider with its promotion note", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("ci-promoted", [{ kind: "text", text: "CI notice read." }]);
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); home.cleanup(); });
	const job: FleetRecord = {
		job_id: "cp-promoted", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting",
		branch: "cp-promoted", worktree: join(home.path, "missing"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, supersessions: 1,
		worker: { pid: process.pid, session_id: "sess", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() },
	};
	await new FleetStore({ home: home.path }).add(job);
	const timestamp = new Date().toISOString();
	const message = {
		role: "custom", customType: "cp-ci", content: "S22_CI_promoted green", display: true, timestamp: Date.now(),
		details: { cp_wakeup: { kind: "ci", job_id: job.job_id, keys: ["a".repeat(40)], issued_at: timestamp } },
	};
	const session = join(home.path, "promoted.jsonl");
	writeFileSync(session, [
		{ type: "session", version: 3, id: "ci-promoted-session", timestamp, cwd: home.path },
		{ type: "message", id: "m0", parentId: null, timestamp, message },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION], sessionFile: session });
	t.after(() => child.close());
	await child.prompt("Read the carried CI notice.");
	await child.waitForSettled(60_000);
	const request = JSON.stringify(provider.requests("ci-promoted").map((r) => r.body.messages));
	assert.match(request, /S22_CI_promoted green/);
	assert.match(request, /was promoted after this CI fact \(now generation 2/);
});
