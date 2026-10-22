import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";

const issued = "2026-08-31T12:45:43Z";
const head = "a".repeat(40);
type Notice = { kind: string; job?: string; body: string; stamp?: Record<string, unknown>; details?: Record<string, unknown> };

async function carried(t: TestContext, records: Array<Partial<FleetRecord> & { job_id: string }>, notices: Notice[]) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s22-context", [{ kind: "text", text: "S22 context received." }]);
	const agent = createAgentDir({ provider });
	chmodSync(agent.path, 0o700);
	const session = join(home.path, "legacy.jsonl");
	let child: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => { await child?.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const fleet = new FleetStore({ home: home.path });
	for (const record of records) {
		await fleet.add({ project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN,
			phase: "waiting", branch: record.job_id, worktree: home.path, dispatched_at: issued, usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "legacy", session_file: session, profile: "implementer",
				role: "implementer", model, started_at: issued }, ...record });
		mkdirSync(join(home.path, paths.runDir(record.job_id)), { recursive: true });
	}
	const timestamp = isoTimestamp();
	let parentId: string | null = null;
	const rows: unknown[] = [{ type: "session", version: 3, id: "s22-session", timestamp, cwd: home.path }];
	for (const [index, notice] of notices.entries()) {
		const id = `s22-${index}`;
		rows.push({ type: "message", id, parentId, timestamp, message: {
			role: "custom", customType: `cp-${notice.kind}`, content: notice.body, display: true, timestamp: index + 1,
			details: { cp_wakeup: { kind: notice.kind, issued_at: issued, ...(notice.job ? { job_id: notice.job } : {}),
				...notice.stamp }, ...notice.details },
		} });
		parentId = id;
	}
	writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION], sessionFile: session });
	await child.prompt("Inspect the S22 carried notices.");
	await child.waitForSettled(60_000);
	assert.equal(provider.remaining("s22-context"), 0);
	return JSON.stringify((provider.requests("s22-context")[0]?.body.messages as Array<{ role: string }>).filter((m) => m.role !== "system"));
}

test("S22: envelope generations and terminal phases filter carried reports before the provider", { timeout: 110_000 }, async (t) => {
	const text = await carried(t, [
		{ job_id: "cp-promoted", phase: "waiting", supersessions: 1 },
		{ job_id: "cp-done", phase: "done", reported_at: issued },
		{ job_id: "cp-live", reported_at: issued },
		{ job_id: "cp-next", supersessions: 1, reported_at: issued },
		{ job_id: "cp-unreported", phase: "waiting" },
		{ job_id: "cp-script", phase: "failed", executor: "script", reported_at: issued, worker: undefined,
			script_path: "scripts/legacy.sh", script_process: { pid: process.pid, started_at: issued },
			failure: { class: "script_exit", message: "legacy script failed", at: issued } } as unknown as FleetRecord,
		{ job_id: "cp-model", phase: "failed", reported_at: issued,
			failure: { class: "model_call_failed", message: "legacy model failed", at: issued } },
	], [
		{ kind: "envelope", job: "cp-promoted", body: "S22_ARCHIVED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-done", body: "S22_CLOSED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-live", body: "S22_CURRENT_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-next", body: "S22_OLD_GENERATION", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-next", body: "S22_NEXT_REPORT", stamp: { generation: 2, reported_at: issued } },
		{ kind: "envelope", job: "cp-unreported", body: "S22_FABRICATED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "unreported", job: "cp-live", body: "S22_OBSOLETE_SETTLE", stamp: { generation: 1 } },
		{ kind: "wedged", job: "cp-done", body: "S22_CLOSED_WEDGE" },
		{ kind: "unreported", job: "cp-done", body: "S22_CLOSED_SETTLE" },
		{ kind: "envelope", job: "cp-script", body: "S22_SCRIPT_FAILURE", stamp: { reported_at: issued } },
		{ kind: "envelope", job: "cp-model", body: "S22_MODEL_FAILURE", stamp: { reported_at: issued } },
	]);
	assert.deepEqual(["ARCHIVED_REPORT", "CLOSED_REPORT", "OLD_GENERATION", "FABRICATED_REPORT", "OBSOLETE_SETTLE",
		"CLOSED_WEDGE", "CLOSED_SETTLE", "MODEL_FAILURE"].filter((body) => text.includes(`S22_${body}`)), []);
	assert.deepEqual(["CURRENT_REPORT", "NEXT_REPORT", "SCRIPT_FAILURE"].filter((body) => text.includes(`S22_${body}`)),
		["CURRENT_REPORT", "NEXT_REPORT", "SCRIPT_FAILURE"]);
	assert.doesNotMatch(text, /S22_ARCHIVED_REPORT|S22_CLOSED_REPORT/);
});

test("S22: CI replay identity preserves new jobs heads events and mixed batches", { timeout: 110_000 }, async (t) => {
	const ci = (job: string, sha: string, event: string) => ({ key: `${job}|${sha}|${event}`, job_id: job, head_sha: sha, event });
	const green = ci("cp-ci", head, "ci_green");
	const text = await carried(t, [{ job_id: "cp-ci" }, { job_id: "cp-other" }, { job_id: "cp-terminal", phase: "done" }], [
		{ kind: "ci", job: "cp-ci", body: "S22_CI_FIRST", stamp: { keys: [head] }, details: { ci: [green] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_DUPLICATE", stamp: { keys: [head] }, details: { ci: [green] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_NO_DETAILS_ONE", stamp: { keys: [head] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_NO_DETAILS_TWO", stamp: { keys: [head] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_NEW_HEAD", stamp: { keys: ["b".repeat(40)] }, details: { ci: [ci("cp-ci", "b".repeat(40), "ci_green")] } },
		{ kind: "ci", job: "cp-other", body: "S22_CI_OTHER_JOB", stamp: { keys: [head] }, details: { ci: [ci("cp-other", head, "ci_green")] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_MERGED", stamp: { keys: [head] }, details: { ci: [ci("cp-ci", head, "pr_merged")] } },
		{ kind: "ci", body: "S22_CI_MIXED", details: { ci: [green, ci("cp-other", head, "ci_failed")] } },
		{ kind: "ci", job: "cp-terminal", body: "S22_TERMINAL_FIRST", stamp: { keys: [head] }, details: { ci: [ci("cp-terminal", head, "ci_green")] } },
		{ kind: "ci", job: "cp-terminal", body: "S22_TERMINAL_COPY", stamp: { keys: [head] }, details: { ci: [ci("cp-terminal", head, "ci_green")] } },
	]);
	const expected = ["CI_FIRST", "CI_NO_DETAILS_ONE", "CI_NO_DETAILS_TWO", "CI_NEW_HEAD", "CI_OTHER_JOB", "CI_MERGED", "CI_MIXED"];
	assert.deepEqual(expected.filter((body) => text.includes(`S22_${body}`)), expected);
	for (const body of ["CI_DUPLICATE", "TERMINAL_FIRST", "TERMINAL_COPY"]) assert.ok(!text.includes(`S22_${body}`), body);
});


test("S22: answer replay preserves coalesced unseen decisions and text-only legacy identities", { timeout: 110_000 }, async (t) => {
	const decision = "aw-checkpoint-cp-answer";
	const text = await carried(t, [{ job_id: "cp-answer", phase: "done" }], [
		{ kind: "answered", job: "cp-answer", body: "S22_ANSWER_FIRST", stamp: { keys: [decision] } },
		{ kind: "answered", job: "cp-answer", body: "S22_ANSWER_COPY", stamp: { keys: [decision] } },
		{ kind: "answered", body: "S22_ANSWER_MIXED", stamp: { keys: [decision, "aw-unseen"] } },
		{ kind: "answered", body: "DECISION ANSWERED — S22_TEXT_FIRST\n  aw-legacy: approved" },
		{ kind: "answered", body: "DECISION ANSWERED — S22_TEXT_COPY\n  aw-legacy: approved" },
		{ kind: "answered", job: "cp-missing", body: "S22_ANSWER_MISSING", stamp: { keys: ["aw-missing"] } },
	]);
	for (const body of ["ANSWER_FIRST", "ANSWER_MIXED", "TEXT_FIRST", "ANSWER_MISSING"]) assert.ok(text.includes(`S22_${body}`), body);
	for (const body of ["ANSWER_COPY", "TEXT_COPY"]) assert.ok(!text.includes(`S22_${body}`), body);
});
