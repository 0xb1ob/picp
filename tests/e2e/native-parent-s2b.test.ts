/**
 * Native-Claude parent S2b through the real `CpBridge.start` with the native spawn and the claude mock provider
 * (tests/fixtures/fake-claude.ts stands in for the CLI on CI): in-process diagnostics, steer, crash recovery, the
 * relaunch cap, an operator stop with queued sends, abort as Query.interrupt(), and the startup duties.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { AnsweredOutbox } from "../../src/answered.ts";
import { LAYOUT, layoutForHome } from "../../src/contracts.ts";
import { parentEnv, RELAUNCH_FAIL_CAP } from "../../src/cp-bridge.ts";
import { drainFile } from "../../src/drain.ts";
import { readParentLock } from "../../src/parent-lock.ts";
import { parentSpawnArgs } from "../../src/parent-spawn.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { type WorkerEvent, WorkerProcess } from "../../src/worker-process.ts";
import { type ClaudeStep, FAKE_CLAUDE_MODEL, FAKE_NATIVE_MODEL, toolResults } from "../harness/claude-mock-provider.ts";
import { waitFor } from "../harness/index.ts";
import { alive, claudeChildren, isModelCall, REAL_CLAUDE, type NativeFleet, nativeFleet, recordLines, userTexts } from "../harness/native-parent.ts";

const LINUX = process.platform === "linux" ? false : "reads the claude child from /proc";
const gate = () => {
	let release: () => void = () => {};
	const opened = new Promise<void>((done) => (release = done));
	return { opened, release };
};
const modelCalls = (f: NativeFleet) => f.provider.requests.filter(isModelCall);
const row = (f: NativeFleet, id?: string) => f.bridge.status().sends.find((send) => send.id === id);
const logged = (file: string, body: string) => recordLines(file).filter((line) => line.type === "operator_text" && line.text?.includes(body)).length;
/** The entry on the bridge's own spawn seam (`parentSpawnArgs`, `parentEnv`) for the RPCs no bridge op sends. */
function spawnEntry(t: TestContext, f: NativeFleet, model: string, events: WorkerEvent[] = []): WorkerProcess {
	const sessions = join(f.home, layoutForHome("multi", f.home).sessions);
	mkdirSync(sessions, { recursive: true });
	const proc = WorkerProcess.spawn({ cwd: f.home, model, ...parentSpawnArgs(f.home, join(sessions, "cp-parent.jsonl"), { model }),
		env: parentEnv(f.home, "multi"), replaceEnv: true, requestTimeoutMs: 30_000, autoCancelDialogs: true, onEvent: (event) => events.push(event) });
	t.after(async () => { await proc.shutdown(); });
	return proc;
}
const firstChild = (pid: number) => waitFor(() => claudeChildren(pid)[0], (child) => child !== undefined, { timeoutMs: 30_000, what: "the turn's claude child" });

// Scenario: Given a native parent, When the bridge runs /cp-version, /doctor, /cp-quota status, /cp-drain and its
// cancel, Then get_commands lists them as extension commands and each answers with its notify line in the entry,
// And state/drain.json comes and goes, and no model call is made.
test("native parent S2b: the four diagnostics run in the entry with no model turn", { timeout: 180_000 }, async (t) => {
	const f = await nativeFleet(t, () => []);
	await f.start();
	assert.match((await f.bridge.diagnostic("version")).text, /^picp /);
	const doctor = await f.bridge.diagnostic("doctor");
	assert.match(doctor.text, /^DOCTOR /);
	assert.match((await f.bridge.quota("status")).text, /^QUOTA: /);
	assert.match((await f.bridge.drain(30)).text, /^DRAIN: /);
	assert.equal(existsSync(drainFile(f.home)), true, "/cp-drain wrote the drain record");
	// No live worker, so the drain is already drained: the entry refuses to cancel the restart it prepared, as pi does.
	assert.match((await f.bridge.drainCancel()).text, /^DRAIN: failed: refused: this parent drained/);
	assert.equal(modelCalls(f).length, 0, "no diagnostic became a model turn");
});

// Scenario: Given send A's turn waiting on its model call, When send B arrives, Then B joins the running query and
// lands after A's tool batch, in the same turn's next model call (no extra call); And a send arriving while the last
// call streams (no tool batch left) lands in the CLI's own queued turn right after; each lands once and settles.
test("native parent S2b: a mid-turn send joins after the tool batch, else at the end of the turn", { skip: LINUX, timeout: 240_000 }, async (t) => {
	const [first, second] = [gate(), gate()];
	t.after(() => { first.release(); second.release(); });
	const f = await nativeFleet(t, () => [
		{ kind: "tool_use", calls: [{ name: "mcp__cp__cp_next", input: {} }], beforeAnswer: () => first.opened },
		{ kind: "text", text: "steered reply" },
		{ kind: "text", text: "turn C done", beforeAnswer: () => second.opened },
		{ kind: "text", text: "queued turn reply" },
	]);
	const started = await f.start();
	const a = await f.bridge.send("send A starts the turn", 500);
	await waitFor(() => modelCalls(f).length, (n) => n === 1, { timeoutMs: 60_000, what: "A's model call" });
	const b = await f.bridge.send("steer B joins the tool batch", 500);
	assert.ok(b.pending, JSON.stringify(b));
	await waitFor(() => row(f, b.send_id)?.state, (state) => state === "injected", { timeoutMs: 10_000, what: "B handed to the busy parent" });
	assert.equal(logged(started.sessionFile, "steer B joins the tool batch"), 0, "B has not landed before the tool batch ends");
	first.release();
	const settled = (id?: string) => row(f, id)?.state === "settled";
	await waitFor(() => settled(a.send_id) && settled(b.send_id), Boolean, { timeoutMs: 60_000, what: "A and B settled" });
	assert.equal(modelCalls(f).length, 2, "B rode A's turn: no model call of its own");
	// claude 2.1.318 sends a mid-turn message as a system-role note after the tool results (seen on the real CLI).
	const texts = (modelCalls(f)[1]?.body.messages as Array<{ role: string; content: unknown }>).map((message) => JSON.stringify(message.content));
	assert.ok(texts.some((text) => text.includes("steer B joins the tool batch")), "B is in the call after the tool batch");
	assert.equal(logged(started.sessionFile, "steer B joins the tool batch"), 1);
	// One span, as a pi steer: A's receipt carries the reply, B's points at it (P9f-send-batch).
	assert.equal(f.bridge.sendReceipt(a.send_id!)?.reply, "steered reply", JSON.stringify(f.bridge.sendReceipt(a.send_id!)));
	assert.equal(f.bridge.sendReceipt(b.send_id!)?.reply, `answered together with ${a.send_id} — see that reply`, JSON.stringify(f.bridge.sendReceipt(b.send_id!)));

	const c = await f.bridge.send("send C streams its answer", 500);
	await waitFor(() => modelCalls(f).length, (n) => n === 3, { timeoutMs: 60_000, what: "C's model call" });
	const d = await f.bridge.send("steer D waits for the end of the turn", 500);
	await waitFor(() => row(f, d.send_id)?.state, (state) => state === "injected", { timeoutMs: 10_000, what: "D handed to the busy parent" });
	second.release();
	await waitFor(() => settled(c.send_id) && settled(d.send_id), Boolean, { timeoutMs: 60_000, what: "C and D settled" });
	assert.equal(modelCalls(f).length, 4);
	assert.ok(userTexts(modelCalls(f)[3]).some((text) => text.includes("steer D waits for the end of the turn")));
	assert.equal(f.bridge.sendReceipt(d.send_id!)?.reply, "queued turn reply", JSON.stringify(f.bridge.sendReceipt(d.send_id!)));
	assert.equal(logged(started.sessionFile, "steer D waits for the end of the turn"), 1);
});

// Scenario: Given a native parent mid-turn with its claude child waiting on the model, When the entry is SIGKILLed,
// Then the bridge relaunches it on the same claude session, the new entry kills the orphaned child at boot,
// And the landed send settles through the relaunch.
test("native parent S2b: a kill mid-turn leaves no orphan claude child and the relaunch resumes", { skip: LINUX, timeout: 240_000 }, async (t) => {
	const hang = gate();
	t.after(() => hang.release());
	const f = await nativeFleet(t, () => [
		{ kind: "text", text: "never answered", beforeAnswer: () => hang.opened },
		...["after the crash", "reply three", "reply four"].map((text): ClaudeStep => ({ kind: "text", text })),
	]);
	const started = await f.start();
	const a = await f.bridge.send("send A is in flight at the crash", 500);
	await waitFor(() => modelCalls(f).length, (n) => n === 1, { timeoutMs: 60_000, what: "A's model call" });
	const child = (await firstChild(started.pid!))!;
	const sessionId = recordLines(started.sessionFile).filter((line) => line.type === "session").at(-1)?.session_id;
	process.kill(started.pid!, "SIGKILL");
	await waitFor(() => f.relays.find((relay) => relay.kind === "relaunch"), Boolean, { timeoutMs: 30_000, what: "the relaunch relay" });
	await waitFor(() => f.bridge.status(), (status) => status.alive && status.pid !== started.pid, { timeoutMs: 30_000, what: "the relaunched entry" });
	await waitFor(() => alive(child), (up) => !up, { timeoutMs: 15_000, what: `the orphaned claude child ${child} to be gone` });
	await waitFor(() => row(f, a.send_id)?.state, (state) => state === "settled", { timeoutMs: 120_000, what: "A settled after the relaunch" });
	assert.ok(sessionId);
	assert.equal(recordLines(started.sessionFile).filter((line) => line.type === "session").at(-1)?.session_id, sessionId, "the relaunch resumed the session");
	assert.equal(logged(started.sessionFile, "send A is in flight at the crash"), 1, "A's body was never sent twice");
});

// Scenario: Given the model refuses the credentials on every turn, When RELAUNCH_FAIL_CAP sends fail in a row,
// Then the bridge relays the cap and stops the native parent instead of relaunching it,
// And the entry is gone and the parent lock released.
test("native parent S2b: failed turns reach the relaunch cap and the native parent stops", { timeout: 180_000 }, async (t) => {
	const f = await nativeFleet(t, () => [{ kind: "auth_error" }]);
	const started = await f.start();
	for (let n = 0; n < RELAUNCH_FAIL_CAP; n++) {
		const pending = await f.bridge.send(`cap send ${n}`, 1);
		await waitFor(() => f.relays.filter((relay) => relay.kind === "relaunch" || relay.sendId === pending.send_id), (rows) => rows.length > 0, { timeoutMs: 60_000, what: `send ${n} failed` });
	}
	const cap = await waitFor(() => f.relays.find((relay) => relay.kind === "relaunch"), Boolean, { timeoutMs: 60_000, what: "the cap" });
	assert.match(cap!.text, new RegExp(`parent model failed ${RELAUNCH_FAIL_CAP} turns in a row`));
	await waitFor(() => f.bridge.status().alive, (up) => !up, { timeoutMs: 30_000, what: "the bridge stopped" });
	await waitFor(() => alive(started.pid!), (up) => !up, { timeoutMs: 15_000, what: "the entry to exit" });
	assert.notEqual(readParentLock(f.home).state, "held");
	assert.equal(f.relays.filter((relay) => relay.kind === "relaunch").length, 1, "never relaunched past the cap");
});

// Scenario: Given send A landed and waiting on the model and send B handed to the busy parent, When the operator
// stops with discardPending, Then B is undeliverable with no confirmed landing, A reached the parent with no reply,
// the claude child is gone, And the next start never delivers B.
test("native parent S2b: stop with discardPending drops the queued send as on pi", { skip: LINUX, timeout: 240_000 }, async (t) => {
	const hang = gate();
	t.after(() => hang.release());
	const f = await nativeFleet(t, () => [
		{ kind: "text", text: "never answered", beforeAnswer: () => hang.opened },
		{ kind: "text", text: "after the stop" },
	]);
	const started = await f.start();
	const a = await f.bridge.send("send A holds the turn", 500);
	await waitFor(() => modelCalls(f).length, (n) => n === 1, { timeoutMs: 60_000, what: "A's model call" });
	const child = (await firstChild(started.pid!))!;
	const b = await f.bridge.send("steer B is dropped by the stop", 500);
	await waitFor(() => row(f, b.send_id)?.state, (state) => state === "injected", { timeoutMs: 10_000, what: "B handed to the busy parent" });
	await f.bridge.stop({ discardPending: true });
	assert.equal(row(f, b.send_id)?.state, "undeliverable");
	assert.match(f.relays.find((relay) => relay.sendId === b.send_id)?.text ?? "", /has no confirmed landing \(parent stopped by the operator\)/);
	assert.match(f.relays.find((relay) => relay.sendId === a.send_id)?.text ?? "", /reached the parent at \S+ but got no reply \(/);
	await waitFor(() => alive(child), (up) => !up, { timeoutMs: 15_000, what: "the claude child to exit with the stop" });
	await f.start();
	assert.equal((await f.bridge.send("after the stop, are you there?", 120_000)).reply, "after the stop");
	assert.ok(modelCalls(f).every((call) => userTexts(call).every((text) => !text.includes("steer B is dropped by the stop"))), "B never reached the model");
});

// Scenario (#824 review 2): Given a CLI that sends no tool_use id with tools/call, When `abort` arrives while a cp_next
// the hook allowed is held before it runs, Then the turn ends `aborted` through Query.interrupt() (the CLI keeps
// "[Request interrupted by user]"), And the next turn's cp_next reports its own id, not the never-run call's queued one.
test("native parent S2b: abort interrupts the query and leaves no stale tool-call id", { skip: LINUX || (REAL_CLAUDE && "holds a call with a fake-claude knob"), timeout: 180_000 }, async (t) => {
	const f = await nativeFleet(t, () => [
		{ kind: "tool_use", calls: [{ name: "mcp__cp__cp_next", input: {} }] },
		{ kind: "tool_use", calls: [{ name: "mcp__cp__cp_next", input: {} }] },
		{ kind: "text", text: "after the abort" },
	], { FAKE_CLAUDE_HOLD_AFTER_ALLOW: "mcp__cp__cp_next", FAKE_CLAUDE_NO_TOOL_META: "1" });
	const events: WorkerEvent[] = [];
	const proc = spawnEntry(t, f, FAKE_NATIVE_MODEL, events);
	await proc.getState(30_000);
	await proc.prompt("hold the turn");
	const held = join(f.home, layoutForHome("multi", f.home).sessions, "native-parent-claude", "config", "fake-claude", "held");
	await waitFor(() => existsSync(held), Boolean, { timeoutMs: 60_000, what: "the allowed cp_next held before it runs" });
	const heldId = readFileSync(held, "utf8");
	const child = (await firstChild(proc.pid!))!;
	assert.equal((await proc.abort()).success, true);
	const settled = () => events.filter((event) => event.type === "agent_settled").length;
	await waitFor(settled, (n) => n === 1, { timeoutMs: 30_000, what: "the aborted turn to settle" });
	const stops = events.flatMap((event) => event.type === "message_end" && (event.message as { role?: string }).role === "assistant" ? [(event.message as { stopReason?: string }).stopReason] : []);
	assert.equal(stops.at(-1), "aborted", JSON.stringify(stops));
	await waitFor(() => alive(child), (up) => !up, { timeoutMs: 15_000, what: "the interrupted turn's claude child to exit" });
	await proc.prompt("call cp_next after the abort");
	await waitFor(settled, (n) => n === 2, { timeoutMs: 60_000, what: "the next turn to settle" });
	assert.ok(userTexts(modelCalls(f)[1]).some((text) => text.includes("[Request interrupted by user]")), "interrupted, not killed: the CLI kept its note");
	const calls = (modelCalls(f)[2]?.body.messages as Array<{ role: string; content: unknown }>).flatMap((message) => message.role === "assistant" && Array.isArray(message.content) ? (message.content as Array<{ type: string; id?: string }>).filter((block) => block.type === "tool_use") : []);
	const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "cp_next");
	assert.equal(ends.length, 1, "the held call never ran");
	assert.notEqual(calls.at(-1)?.id, heldId);
	assert.equal(ends[0]?.toolCallId, calls.at(-1)?.id, `cp_next reports its own tool_use id, never the held call's ${heldId}`);
});

// Scenario (#826 review): Given a native entry launched on --model M, When set_model switches it to M2 and the entry is
// SIGKILLed, Then a relaunch on the same --model M answers get_state with M2 (the session record keeps the switch),
// And a launch on another --model M3 is the newer choice, so get_state reports M3.
test("native parent S2b: a set_model switch survives a kill and relaunch", { timeout: 120_000 }, async (t) => {
	const f = await nativeFleet(t, () => []);
	const modelOf = async (proc: WorkerProcess) => ((await proc.getState(30_000)) as { model?: { id?: string } }).model?.id;
	const first = spawnEntry(t, f, FAKE_NATIVE_MODEL);
	assert.equal(await modelOf(first), FAKE_CLAUDE_MODEL);
	assert.equal((await first.request("set_model", { provider: "anthropic", modelId: "claude-picp-switched" })).success, true);
	process.kill(first.pid!, "SIGKILL");
	await first.closed;
	const second = spawnEntry(t, f, FAKE_NATIVE_MODEL);
	assert.equal(await modelOf(second), "claude-picp-switched", "the relaunch on the same --model keeps the switch");
	await second.shutdown();
	const third = spawnEntry(t, f, "anthropic/claude-picp-third");
	assert.equal(await modelOf(third), "claude-picp-third", "a launch on a new --model wins over the recorded switch");
});

// Scenario: Given a drained record an earlier parent left, a pending durable wake-up, a queued operator answer and a
// cron schedule (added through the native parent) that missed its slot while no parent ran, When the native parent
// starts, Then its session_start drains the wake-up and answered outboxes, sends the cp-recovery notice and ticks the
// schedule runner: each reaches the model as a fleet wake-up and the outboxes are confirmed delivered.
test("native parent S2b: startup duties run on native: outbox drains, cp-recovery notice and the schedule tick", { timeout: 240_000 }, async (t) => {
	const f = await nativeFleet(t, () => [
		{ kind: "tool_use", calls: [{ name: "mcp__cp__cp_schedule", input: { action: "add", name: "nightly", project: "demo", cron: "0 9 * * *", tz: "UTC", title: "nightly fix", kind: "ship", delivery: "pr", operator_quote: "Add the nightly schedule." } }] },
		{ kind: "text", text: "Added." },
		...Array.from({ length: 8 }, (): ClaudeStep => ({ kind: "text", text: "acknowledged" })),
	]);
	await f.start();
	assert.equal((await f.bridge.send("Add the nightly schedule.", 120_000)).reply, "Added.");
	await f.bridge.stop();
	const schedules = join(f.home, LAYOUT.state, "schedules.json");
	const saved = JSON.parse(readFileSync(schedules, "utf8")) as { schedules: Array<{ name: string; last_checked_at?: string }> };
	for (const entry of saved.schedules) entry.last_checked_at = new Date(Date.now() - 3 * 86_400_000).toISOString();
	writeFileSync(schedules, JSON.stringify(saved));
	writeFileSync(drainFile(f.home), JSON.stringify({ state: "drained", started_at: "2020-01-01T00:00:00Z", finished_at: "2020-01-01T00:00:01Z", deadline: "2020-01-01T00:00:30Z", timeout_s: 30, jobs: [], reported: true }));
	const wakeups = new DurableWakeupOutbox({ home: f.home });
	assert.equal(wakeups.enqueue({ id: "native-startup-death", kind: "death", content: "NATIVE_STARTUP_WAKE: a worker died while no parent ran" }), true);
	const answered = new AnsweredOutbox({ home: f.home });
	answered.enqueue({ id: "aw-native-startup", type: "approval", job_id: f.jobId, decision: "NATIVE_STARTUP_DECISION", answer: "hold", answered_by: "operator" });
	await f.start();
	const seen = () => modelCalls(f).flatMap((call) => userTexts(call));
	const has = (texts: string[], type: string, needle: string) => texts.some((text) => text.startsWith(`[fleet wake-up ${type}`) && text.includes(needle));
	const texts = await waitFor(seen, (all) => has(all, "cp-recovery", "RESTART AFTER DRAIN") && has(all, "cp-death", "NATIVE_STARTUP_WAKE")
		&& all.some((text) => text.startsWith("[fleet wake-up cp-answered") && text.includes("NATIVE_STARTUP_DECISION"))
		&& has(all, "cp-schedule", "missed"), { timeoutMs: 120_000, what: "the four startup wake-ups at the model" }).catch((error: Error) => assert.fail(`${error.message}\n${toolResults(f.provider.requests).join("\n")}\n${seen().join("\n---\n")}`));
	assert.ok(texts);
	assert.equal(existsSync(drainFile(f.home)), false, "startup cleared the earlier parent's drain");
	await waitFor(() => wakeups.pending().some((entry) => entry.id === "native-startup-death"), (pending) => !pending, { timeoutMs: 30_000, what: "the durable wake-up confirmed" });
	await waitFor(() => answered.stats().pending, (pending) => pending === 0, { timeoutMs: 30_000, what: "the answer confirmed" });
});
