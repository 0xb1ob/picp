import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, SCHEMA_VERSION, isoTimestamp, paths, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, readFleet, readRunEvents, startRpc, waitFor } from "../harness/index.ts";
import { startStack, SKIP } from "./landing-helpers.ts";

function envelope(home: string, id: string, extra: object = {}) {
	mkdirSync(join(home, paths.runDir(id)), { recursive: true });
	writeFileSync(join(home, paths.envelopeFile(id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: id, kind: "ship", status: "done", summary: "S27 restart delivery", branch: id, head_sha: "0".repeat(40), pr_url: "https://github.com/demo/demo/pull/42", ...extra } }));
}

async function fixture(t: import("node:test").TestContext) {
	const home = createScratchHome();
	const agent = createAgentDir();
	const store = new FleetStore({ home: home.path });
	t.after(() => { agent.cleanup(); home.cleanup(); });
	const add = async (id: string, extra: Partial<FleetRecord> = {}) => store.add({ job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN,
		phase: "waiting", branch: id, worktree: join(home.path, "wt"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: 2147483600, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() }, ...extra } as FleetRecord);
	const start = async () => {
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session"] });
		t.after(() => rpc.close().then(() => undefined));
		rpc.send({ type: "get_state", id: "ready" });
		await rpc.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
		return rpc;
	};
	return { home: home.path, add, start, jobs: () => readFleet(home.path).jobs };
}

test("S27 intake: startup stamps dead and orphan deliveries once, preserves terminal records and promoted generations", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t);
	for (const id of ["cp-dead", "cp-orphan", "cp-silent", "cp-promoted", "cp-stamped", "cp-failed"]) {
		await f.add(id, id === "cp-promoted" ? { supersessions: 1 } : id === "cp-stamped" ? { phase: "held", reported_at: "2026-01-01T00:00:00Z" } : id === "cp-failed" ? { phase: "failed", failure: { class: "envelope_invalid", message: "already refused", at: isoTimestamp() } } : id === "cp-orphan" ? { worker: { pid: process.pid, session_id: "s", session_file: "/gone.jsonl", profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() } } : {});
		if (id !== "cp-silent") envelope(f.home, id);
	}
	const rpc = await f.start();
	await waitFor(f.jobs, (jobs) => jobs.filter((j) => ["cp-dead", "cp-orphan", "cp-promoted"].includes(j.job_id)).every((j) => j.reported_at), { what: "restart envelope stamping" });
	const jobs = f.jobs();
	for (const id of ["cp-dead", "cp-orphan", "cp-promoted"]) {
		const job = jobs.find((j) => j.job_id === id)!;
		assert.equal(job.phase, "held", id);
		assert.ok(job.receipts?.some((r) => r.kind === "pr"), id);
		assert.ok(job.reported_at, id);
		const events = readRunEvents(f.home, id).filter((event) => event.source === "cp" && event.type === "envelope_received");
		assert.equal(events.length, 1, id);
		assert.equal((events[0]?.payload as { generation: number }).generation, id === "cp-promoted" ? 2 : 1);
	}
	assert.equal(jobs.find((j) => j.job_id === "cp-silent")?.reported_at, undefined);
	assert.equal(jobs.find((j) => j.job_id === "cp-stamped")?.reported_at, "2026-01-01T00:00:00Z");
	assert.equal(jobs.find((j) => j.job_id === "cp-failed")?.phase, "failed");
	const first = jobs.filter((j) => j.reported_at).map((j) => [j.job_id, j.reported_at, j.receipts]);
	rpc.send({ type: "get_messages", id: "wake-transcript" });
	const transcript = await rpc.waitFor((r) => r.type === "response" && r.id === "wake-transcript");
	const wakes = (transcript.data as { messages: Array<{ customType?: string }> }).messages.filter((message) => message.customType === "cp-envelope");
	assert.equal(wakes.length, 3, "one ordinary envelope wake per recovered delivery");
	rpc.endInput(); await rpc.close();
	const second = await f.start();
	assert.deepEqual(f.jobs().filter((j) => j.reported_at).map((j) => [j.job_id, j.reported_at, j.receipts]), first);
	for (const id of ["cp-dead", "cp-orphan", "cp-promoted"]) {
		assert.equal(readRunEvents(f.home, id).filter((event) => event.type === "envelope_received").length, 1, "restart never replays delivery");
	}
	second.endInput(); await second.close();
});

test("S27 intake: invalid envelopes quarantine once, fail closed on repeat and never stop a later valid delivery", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t);
	for (const id of ["cp-conflict", "cp-malformed", "cp-missing", "cp-fine"]) await f.add(id);
	envelope(f.home, "cp-conflict", { job_id: "cp-other" });
	envelope(f.home, "cp-malformed");
	writeFileSync(join(f.home, paths.envelopeFile("cp-malformed")), JSON.stringify({ job_id: "cp-malformed" }));
	envelope(f.home, "cp-missing", { artifact_path: join(f.home, "nowhere/plan.md") });
	envelope(f.home, "cp-fine");
	const rpc = await f.start();
	await waitFor(f.jobs, (jobs) => jobs.find((j) => j.job_id === "cp-fine")?.reported_at !== undefined, { what: "valid delivery after invalid artifacts" });
	for (const id of ["cp-conflict", "cp-malformed", "cp-missing"]) {
		const job = f.jobs().find((j) => j.job_id === id)!;
		assert.equal(job.reported_at, undefined, id);
		assert.equal(job.phase, "waiting", id);
		assert.ok(existsSync(join(f.home, paths.invalidEnvelopeFile(id, 1))), id);
	}
	const evidence = JSON.stringify(rpc.records());
	assert.match(evidence, /cp-other/);
	assert.match(evidence, /envelope\.json/);
	assert.match(evidence, /nowhere/);
	rpc.endInput(); await rpc.close();
	envelope(f.home, "cp-conflict", { job_id: "cp-other" });
	const again = await f.start();
	await waitFor(f.jobs, (jobs) => jobs.find((j) => j.job_id === "cp-conflict")?.phase === "failed", { what: "second refusal closes slot" });
	assert.equal(f.jobs().find((j) => j.job_id === "cp-conflict")?.failure?.class, "envelope_invalid");
	assert.equal(f.jobs().find((j) => j.job_id === "cp-conflict")?.reported_at, undefined);
	again.endInput(); await again.close();
});

test("S27 intake: a real settling worker receives one refused-envelope correction with preserved evidence", { timeout: 110_000, skip: SKIP }, async (t) => {
	const s = await startStack(t);
	const job = await s.post.ledger().create({ title: "S27 malformed disk report", project: "demo", kind: "ship", delivery: "pr" });
	const script = `s27-settle-${job.id}`;
	const model = s.provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => {
			envelope(s.home, job.id, { job_id: "cp-other" });
			return { command: "true" };
		} }] },
		{ kind: "text", text: "S27 malformed report left on disk." },
		{ kind: "text", text: "S27 correction received; standing by." },
	]);
	s.agentDir.writeModels(s.provider);
	const dispatched = await s.post.dispatch({ jobId: job.id, task: "Inspect the supplied report fixture.", model, fetch: false });
	assert.equal(dispatched.receipt, "accepted");
	await waitFor(() => s.provider.requests(script), (requests) => requests.length >= 3, { timeoutMs: 30_000, what: "worker correction turn" });
	const correction = JSON.stringify(s.provider.requests(script)[2]?.body);
	assert.match(correction, /REFUSED/);
	assert.match(correction, /cp-other/);
	assert.match(correction, /envelope-invalid-1\.json/);
	assert.ok(existsSync(join(s.home, paths.invalidEnvelopeFile(job.id, 1))));
	await waitFor(() => s.provider.remaining(script), (remaining) => remaining === 0, { what: "correction consumed" });
	await waitFor(() => s.post.fleet.get(job.id)?.unreported_settles, (count) => (count ?? 0) >= 2, { what: "second settle recorded without another nudge" });
	assert.equal(s.provider.requests(script).length, 3, "one correction prompt, no retry loop");
});
