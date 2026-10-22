import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, isoTimestamp, LAYOUT, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import {
	COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor,
} from "../harness/index.ts";

test("S21: restart delivers an unobserved death once and discards obsolete fleet notices", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "s21-durable";
	const model = provider.addScript(script, [{ kind: "text", text: "Recovery notice received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup();
		home.cleanup();
		await provider.stop();
	});
	const fleet = new FleetStore({ home: home.path });
	const record = (jobId: string, phase: "failed" | "done"): FleetRecord => ({
		job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase,
		branch: jobId, worktree: join(home.path, "missing"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: 1, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() },
		failure: { class: "crash", message: "legacy crash", at: isoTimestamp() },
	});
	await fleet.add(record("cp-live", "failed"));
	await fleet.add(record("cp-finished", "done"));
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "previous-parent" });
	outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" });
	outbox.enqueue({ id: "death:cp-gone:1", kind: "death", job_id: "cp-gone", keys: ["crash"], content: "S21_OBSOLETE_DEATH" });
	outbox.enqueue({ id: "recovery:finished", kind: "recovery", keys: ["cp-finished", "cp-gone"], content: "S21_OBSOLETE_RECOVERY" });
	outbox.drain(() => {});
	assert.equal(outbox.pending().length, 3, "transport handoff cannot confirm delivery");
	const launch = () => {
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		children.push(child);
		return child;
	};
	const first = launch();
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 10_000, what: "replayed death reaching the model" });
	await waitFor(() => outbox.read().delivered, (rows) => rows.some((row) => row.id === "death:cp-live:1"), { timeoutMs: 15_000, what: "observed death arrival" });
	const text = JSON.stringify(provider.requests(script).map((r) => r.body.messages));
	assert.match(text, /S21_LIVE_DEATH/);
	assert.doesNotMatch(text, /S21_OBSOLETE_DEATH|S21_OBSOLETE_RECOVERY/);
	assert.deepEqual(outbox.pending(), []);
	assert.equal(outbox.read().discarded?.length, 2, "obsolete notices are terminally discarded");
	await first.close();
	const before = provider.requests(script).length;
	const second = launch();
	second.send({ id: "ready", type: "get_commands" });
	await second.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
	await second.prompt("S21 restart inspection");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "restart inspection turn" });
	const restartText = JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages));
	assert.doesNotMatch(restartText, /S21_LIVE_DEATH|S21_OBSOLETE/);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.wakeupsFile), "utf8")).delivered.length, 1);
});
