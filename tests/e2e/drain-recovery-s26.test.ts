import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, startPiChild } from "../harness/index.ts";

test("S26: real startup repairs a research ledger close lost after teardown", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ knownProjects: ["demo"], home: home.path });
	const job = await scratch.ledger.create({ title: "Research closed before crash", project: "demo", kind: "research", delivery: "pipeline" });
	await scratch.ledger.claim(job.id, "worker");
	const now = isoTimestamp();
	const artifact = join(home.path, paths.artifactDir(job.id), "report.md");
	mkdirSync(join(home.path, paths.artifactDir(job.id)), { recursive: true });
	writeFileSync(artifact, "# Findings\nResearch complete.\n");
	await new FleetStore({ home: home.path }).add({ job_id: job.id, project: "demo", kind: "research", delivery: "pipeline", origin: DEFAULT_ORIGIN,
		phase: "done", reported_at: now, closed_at: isoTimestamp(new Date(Date.now() + 60_000)), closed_reason: "gated", dispatched_at: now,
		branch: job.id, worktree: home.path, usage: EMPTY_USAGE,
		worker: { pid: process.pid, session_id: "closed-before-crash", session_file: join(home.path, "session.jsonl"), profile: "planner", role: "planner", model: "mock/model", started_at: now, exited_at: now } });
	mkdirSync(join(home.path, paths.runDir(job.id)), { recursive: true });
	writeFileSync(join(home.path, paths.envelopeFile(job.id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: job.id, received_at: now, attempt: 1,
		envelope: { job_id: job.id, kind: "research", status: "done", summary: "Findings", artifact_path: artifact } }));
	const provider = await MockProvider.start();
	const model = provider.addScript("s26-close-recovery", [
		{ kind: "tool_calls", calls: [{ name: "cp_job", args: { action: "show", job_id: job.id } }] },
		{ kind: "text", text: "Ledger checked." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("Show the recovered research job.");
	const result = await child.waitFor((r) => r.type === "tool_execution_end" && r.toolName === "cp_job", 20_000);
	assert.match(JSON.stringify(result.result), /"status":"closed"/);
	assert.match(JSON.stringify(result.result), /researched:/);
	assert.ok(JSON.stringify(result.result).includes(artifact));
	const closed = await scratch.ledger.show(job.id);
	assert.equal(closed.status, "closed");
	assert.equal(closed.close_reason, `researched: ${artifact}`);
});


test("S26: startup clears a foreign drain before corrupt fleet reconciliation fails", { timeout: 60_000 }, async (t) => {
	const { existsSync } = await import("node:fs");
	const { LAYOUT } = await import("../../src/contracts.ts");
	const { drainFile } = await import("../../src/drain.ts");
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	writeFileSync(drainFile(home.path), JSON.stringify({ state: "drained", started_at: "2020-01-01T00:00:00Z", finished_at: "2020-01-01T00:00:01Z", deadline: "2020-01-01T00:00:30Z", timeout_s: 30, jobs: [], reported: true }));
	writeFileSync(join(home.path, LAYOUT.fleetFile), "{broken fleet");
	const provider = await MockProvider.start();
	const model = provider.addScript("s26-broken-fleet", [{ kind: "text", text: "Acknowledged." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("/cp-drain status");
	await child.waitFor((r) => r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 20_000);
	assert.equal(existsSync(drainFile(home.path)), false, "startup clears drain even when fleet reconciliation fails");
	assert.match(child.stderr(), /fleet|reconcil/i);
});


test("S26: startup removes completed drains despite failed or duplicate recovery journaling", { timeout: 60_000 }, async (t) => {
	const { existsSync } = await import("node:fs");
	const { LAYOUT } = await import("../../src/contracts.ts");
	const { drainFile } = await import("../../src/drain.ts");
	const { DurableWakeupOutbox } = await import("../../src/wakeup-outbox.ts");
	for (const failure of ["corrupt", "duplicate"]) await t.test(failure, async () => {
		const home = createScratchHome();
		mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
		const started = "2020-01-01T00:00:00Z";
		writeFileSync(drainFile(home.path), JSON.stringify({ state: "drained", started_at: started, finished_at: started, deadline: started, timeout_s: 30, jobs: [], reported: true }));
		if (failure === "corrupt") writeFileSync(join(home.path, LAYOUT.wakeupsFile), "{broken outbox");
		else {
			const outbox = new DurableWakeupOutbox({ home: home.path });
			const id = `recovery:drain:${started}`;
			outbox.enqueue({ id, kind: "recovery", content: "Already delivered recovery" });
			outbox.confirmDelivered([id]);
		}
		const provider = await MockProvider.start();
		const model = provider.addScript("s26-recovery-journal", [{ kind: "text", text: "Acknowledged." }], { onExhausted: "repeat" });
		const agent = createAgentDir({ provider });
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			await child.prompt("/cp-drain status");
			await child.waitFor((r) => r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 20_000);
			assert.equal(existsSync(drainFile(home.path)), false, `cleared despite ${failure} journal`);
			if (failure === "corrupt") assert.match(child.stderr(), /not journaled.*cleared anyway/);
			else assert.equal(child.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes("RESTART AFTER DRAIN")).length, 0);
		} finally { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); }
	});
});
