/**
 * cp-6fyl PR1 preflight, against the pinned real pi (no mock of pi itself):
 * (a) a `cp-bridge` followUp custom message carrying `details.relay_ids` is
 *     visible, details intact, in `message_start` and `context` — the two hooks
 *     the operator relay outbox acknowledges from — whether sent busy or idle;
 * (b) `agent_before_settle` returning `continue: true` with an appended custom
 *     message forces exactly one more provider request in the same run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MockProvider, createAgentDir, startPiChild } from "./harness/index.ts";

const PROBE = resolve(import.meta.dirname, "fixtures", "relay-preflight-extension.ts");

type ProbeRecord = { hook: string; [key: string]: unknown };

async function probe(t: import("node:test").TestContext, mode: string, script: string, steps: Parameters<MockProvider["addScript"]>[1], settles: number) {
	const dir = mkdtempSync(join(tmpdir(), "cp-relay-preflight-"));
	const provider = await MockProvider.start();
	const model = provider.addScript(script, steps, { onExhausted: "repeat" });
	const agentDir = createAgentDir({ provider });
	const log = join(dir, "probe.jsonl");
	const child = startPiChild({ cwd: dir, model, env: { ...agentDir.env, PROBE_LOG: log, PROBE_MODE: mode }, extensions: [PROBE], tools: [] });
	t.after(async () => { await child.close(); agentDir.cleanup(); await provider.stop(); rmSync(dir, { recursive: true, force: true }); });
	await child.prompt("go");
	for (let n = 1; n <= settles; n += 1) {
		await child.waitFor((record) => record.type === "agent_settled" && child.eventsOfType("agent_settled").length >= n, 60_000);
	}
	const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ProbeRecord);
	return { records, requests: provider.requests(script) };
}

test("preflight (a): a followUp cp-bridge message's relay_ids reach message_start and context, busy and idle", { timeout: 90_000 }, async (t) => {
	const { records, requests } = await probe(t, "followup", "relay-preflight-followup", [{ kind: "text", text: "ok" }], 2);
	for (const id of ["busy-1", "idle-1"]) {
		assert.ok(records.some((r) => r.hook === "message_start" && r.customType === "cp-bridge" && JSON.stringify(r.details) === JSON.stringify({ relay_ids: [id] })),
			`message_start never carried ${id}: ${JSON.stringify(records)}`);
		assert.ok(records.some((r) => r.hook === "context" && JSON.stringify(r.relay_ids).includes(id)), `context never carried ${id}`);
		assert.ok(requests.some((r) => JSON.stringify(r.body.messages).includes(`relay ${id}`)), `the provider never saw relay ${id}`);
	}
	const busyAt = records.findIndex((r) => r.hook === "message_start" && JSON.stringify(r.details ?? null).includes("busy-1"));
	const firstSettled = records.findIndex((r) => r.hook === "agent_settled");
	assert.ok(busyAt < firstSettled, "the busy followUp entered context inside the same run, before it settled");
});

test("preflight (b): agent_before_settle continue:true forces one continuation carrying the appended message", { timeout: 90_000 }, async (t) => {
	const { records, requests } = await probe(t, "settle", "relay-preflight-settle", [
		{ kind: "text", text: "Should I proceed with A or B?" },
		{ kind: "text", text: "NO-ASK" },
	], 1);
	assert.equal(requests.length, 2, "exactly one continuation request");
	assert.match(JSON.stringify(requests[1]?.body.messages), /PROBE: open a cp_parent ask or reply NO-ASK/);
	assert.deepEqual(records.filter((r) => r.hook === "agent_before_settle").map((r) => r.n), [1, 2]);
	assert.equal(records.filter((r) => r.hook === "agent_settled").length, 1, "one settled run");
	// Observed in pi 0.99.1, pinned so PR3 (ask guard) can rely on it: the continuation fires agent_start again,
	// and the appended boundary entry reaches the provider without a message_start of its own.
	assert.equal(records.filter((r) => r.hook === "agent_start").length, 2);
	assert.ok(!records.some((r) => r.hook === "message_start" && r.customType === "cp-ask-guard"));
});
