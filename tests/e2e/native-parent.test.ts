/**
 * The Claude CLI parent's spawn seam (S1a) through the real `CpBridge.start` and the operator's `cp_parent start`:
 * `data/parent.json` `driver: "claude"` starts src/drivers/claude-parent.ts; the default still starts pi.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { startViewer, until } from "../harness/dashboard.ts";
import { stopParentHosts, teardownHome } from "../harness/parent-hosts.ts";
import { type ClaudeStep, FAKE_NATIVE_MODEL, startClaudeMockProvider, subscriberEnv, toolResults } from "../harness/claude-mock-provider.ts";
import { alive, isModelCall, NATIVE, nativeFleet, recordLines, scratchHome, userTexts, withEnv } from "../harness/native-parent.ts";
import { layoutForHome } from "../../src/contracts.ts";
import { buildParentArgv, CpBridge, parentSkillPaths } from "../../src/cp-bridge.ts";
import { nativeParentLogFile } from "../../src/viewer/native-parent-log.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { readParentLock } from "../../src/parent-lock.ts";
import { COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, MockProvider, REPO_ROOT, startPiChild, waitFor } from "../harness/index.ts";

const FAKE_PARENT = join(REPO_ROOT, "tests/fixtures/fake-parent.mjs");
const ENTRY = join(PACKAGE_ROOT, "src/drivers/claude-parent.ts");
const LINUX = process.platform === "linux" ? false : "reads the parent's argv from /proc";

/** A scratch home and a bridge on it; the bridge stops before the home is removed. */
function fixture(t: TestContext, parent?: Record<string, unknown>): { home: string; bridge: CpBridge } {
	const home = scratchHome(parent);
	const bridge = new CpBridge();
	t.after(async () => { try { await bridge.stop(); } finally { home.cleanup(); } });
	return { home: home.path, bridge };
}

const cmdline = (pid: number): string[] => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
const promptFile = (home: string) => join(home, layoutForHome("multi", home).sessions, "native-parent-system-prompt.md");
type ViewEntry = { kind: string; who: string; text: string; name: string | null; send_id: string | null; failed: boolean };
type ParentView = { entries: ViewEntry[]; parent: { live: boolean; context: { model: string | null } } };
const parentView = (view: Awaited<ReturnType<typeof startViewer>>) => async () => (await view.get("/api/sessions?view=parent")).body as unknown as ParentView;

// Scenario: Given data/parent.json says driver "claude" and the model is an anthropic/claude-* ref,
// When CpBridge.start runs, Then process.execPath runs claude-parent.ts with --session/--model/--system-prompt-file
// (never pi's --mode rpc), the contract is a 0600 file, get_state answers the boot and no model call is made,
// And stop ends the entry with exit code 0.
test("native parent: driver claude starts the claude-parent entry and its get_state answers the boot", { skip: LINUX, timeout: 30_000 }, async (t) => {
	const provider = await startClaudeMockProvider([]);
	t.after(() => provider.close());
	withEnv(t, subscriberEnv(provider.url));
	const { home, bridge } = fixture(t, { driver: "claude" });
	const started = await bridge.start({ home, mode: "multi", model: FAKE_NATIVE_MODEL, piBin: FAKE_PARENT, requestTimeoutMs: 10_000 });
	assert.equal(started.already, false);
	assert.equal(started.start, "clean");
	assert.equal(bridge.status().alive, true);
	const argv = cmdline(started.pid!);
	assert.deepEqual(argv, [process.execPath, ENTRY, "--session", started.sessionFile, "--model", FAKE_NATIVE_MODEL, "--system-prompt-file", promptFile(home)]);
	assert.equal(argv.includes("--mode"), false, "no pi --mode rpc flag reaches the native entry");
	assert.equal(statSync(promptFile(home)).mode & 0o777, 0o600);
	assert.equal(readFileSync(promptFile(home), "utf8"), `${readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8").trimEnd()}\n`);
	assert.equal(provider.requests.length, 0, "booting the entry calls no model");
	const exit = await bridge.stop();
	assert.equal(exit?.code, 0);
});

// Scenario: Given data/parent.json with no driver key, When CpBridge.start runs,
// Then the pi parent starts exactly as before: buildParentArgv's `--mode rpc` argv with the command-post extension,
// And no native system-prompt file is written.
test("native parent: the default driver starts pi with today's argv", { timeout: 30_000 }, async (t) => {
	const { home, bridge } = fixture(t, { compact_at_tokens: 100000 });
	const argvFile = join(home, "fake-parent.argv");
	withEnv(t, { FAKE_PARENT_ARGV: argvFile });
	const started = await bridge.start({ home, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, commandPostExtension: COMMAND_POST_EXTENSION, requestTimeoutMs: 10_000 });
	const recorded = (JSON.parse(readFileSync(argvFile, "utf8").trim()) as string[]).slice(2);
	assert.deepEqual(recorded.slice(0, 2), ["--mode", "rpc"]);
	assert.deepEqual(recorded, buildParentArgv({ sessionFile: started.sessionFile, model: "mock/parent", extension: COMMAND_POST_EXTENSION, skills: parentSkillPaths(home) }));
	assert.equal(existsSync(promptFile(home)), false);
});

// Scenario: Given driver "claude", When the start model is not anthropic/claude-*, or parent.json names a non-Claude
// model or an unknown driver, Then CpBridge.start refuses by name before any process starts (no pi, no prompt file),
// And the refused bridge keeps no start options, session file or send outbox (#817 review: refusal before any state).
test("native parent: driver claude refuses a non-Claude model and an unknown driver before spawn", { timeout: 30_000 }, async (t) => {
	const argvFile = join(fixture(t).home, "fake-parent.argv");
	withEnv(t, { FAKE_PARENT_ARGV: argvFile });
	for (const [parent, model, refusal] of [
		[{ driver: "claude" }, "mock/parent", /claude parent driver runs an explicit anthropic\/claude-… model, and mock\/parent is not one/],
		[{ driver: "claude", model: "mock/parent" }, FAKE_NATIVE_MODEL, /parent\.json driver claude runs an explicit anthropic\/claude-… model, not "mock\/parent"/],
		[{ driver: "claud" }, FAKE_NATIVE_MODEL, /parent\.json driver must be "pi" or "claude", not "claud"/],
	] as const) {
		const { home, bridge } = fixture(t, parent);
		await assert.rejects(bridge.start({ home, mode: "multi", model, piBin: FAKE_PARENT, requestTimeoutMs: 10_000 }), refusal);
		assert.equal(bridge.status().alive, false);
		assert.equal(bridge.startOptions(), undefined, "a refused start records no options a host restart would reuse");
		assert.equal(bridge.status().sessionFile, undefined);
		await assert.rejects(bridge.send("hello", 1_000), /parent is not running/);
		assert.equal(existsSync(argvFile), false, "no pi parent was spawned");
		assert.equal(existsSync(promptFile(home)), false);
	}
});

// Scenario: Given an operator session whose pi registry does not know anthropic/claude-picp-fake, When cp_parent start
// names it for a default home, Then the pi probe refuses it as today; for a driver "claude" home the same model starts
// the native entry without the probe, And cp_parent model skips the probe there too, and the entry's set_model takes it.
test("native parent: cp_parent start accepts an anthropic/claude model on driver claude without the pi probe", { skip: LINUX, timeout: 90_000 }, async (t) => {
	const native = scratchHome({ driver: "claude" });
	const plain = scratchHome();
	const provider = await MockProvider.start();
	const start = (home: string) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_parent", args: { action: "start", home, mode: "multi", model: FAKE_NATIVE_MODEL } }] });
	const switchModel = { kind: "tool_calls" as const, calls: [{ name: "cp_parent", args: { action: "model", model: FAKE_NATIVE_MODEL } }] };
	const model = provider.addScript("native-parent-start", [start(plain.path), start(native.path), switchModel, { kind: "text", text: "done" }]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({ cwd: native.path, model, env: { ...agentDir.env, CP_PARENT_PI_BIN: FAKE_PARENT }, extensions: [CP_BRIDGE_EXTENSION] });
	let entry: number | undefined;
	const entryAlive = () => { try { return cmdline(entry!).includes(ENTRY); } catch { return false; } };
	// The entry exits on stdin end once its host is stopped; it is killed by pid only if it does not.
	const stopEntry = async () => {
		if (entry === undefined) return;
		await waitFor(entryAlive, (up) => !up, { timeoutMs: 5_000, what: "the native entry to exit with its host" }).catch(() => process.kill(entry!, "SIGKILL"));
	};
	t.after(() => teardownHome(native, () => child.close(), () => stopParentHosts(native.path), stopEntry, () => agentDir.cleanup(), () => provider.stop(), () => plain.cleanup()));
	await child.prompt("Start the parent.");
	await child.waitForSettled();
	const results = child.eventsOfType("tool_execution_end").map((event) => JSON.stringify(event));
	assert.equal(results.length, 3, results.join("\n"));
	assert.match(results[0]!, /cp_parent start refuses anthropic\/claude-picp-fake: not available/);
	const pid = /started clean pid=(\d+)/.exec(results[1]!)?.[1];
	assert.ok(pid, results[1]);
	entry = Number(pid);
	assert.deepEqual(cmdline(entry).slice(0, 2), [process.execPath, ENTRY]);
	assert.doesNotMatch(results[2]!, /not available/, "cp_parent model on a claude home skips pi's registry probe");
	assert.match(results[2]!, /\{\\"model\\":\\"anthropic\/claude-picp-fake\\"\}/, "the entry's set_model takes it (S2a)");
});

// Scenario (POC P1–P6, gap 6): Given driver claude and a no-op script job, When a send dispatches it, Then it settles,
// cp_dispatch runs over MCP, the envelope wakes a turn (cp_escalate reaches the bridge), And the parent view shows the
// send, wake-up, call with result and reply on a live row; a relaunch resumes the session, operator and fleet apart,
// and appends to the same view; stop leaves no entry alive and the lock released.
test("native parent: a send dispatches over MCP, the envelope wakes a turn, and a relaunch resumes the session", { skip: NATIVE, timeout: 240_000 }, async (t) => {
	const escalation = (jobId: string) => ({
		job_ids: [jobId], kind: "product_ambiguity", question: "Keep the no-op result?", recommended: "keep",
		options: [{ id: "keep", label: "Keep", consequence: "it stays", cost: "none" }, { id: "drop", label: "Drop", consequence: "it goes", cost: "none" }],
	});
	const f = await nativeFleet(t, (jobId) => [
		{ kind: "tool_use", calls: [{ name: "mcp__cp__cp_dispatch", input: () => ({ job_id: jobId() }) }] },
		{ kind: "text", text: "dispatched" },
		{ kind: "tool_use", calls: [{ name: "mcp__cp__cp_escalate", input: () => escalation(jobId()) }] },
		{ kind: "text", text: "report received" },
		{ kind: "text", text: "resumed ok" },
	]);
	// P1: a clean boot whose entry holds the home's lock and whose control file names the record.
	const started = await f.start();
	assert.equal(started.start, "clean");
	const first = started.pid!;
	const lock = readParentLock(f.home);
	assert.equal(lock.state === "held" && lock.record.pid, first, "the entry holds state/parent.lock");
	const control = JSON.parse(readFileSync(join(f.home, layoutForHome("multi", f.home).sessions, "cp-parent-control.json"), "utf8")) as { sessionFile?: string };
	assert.equal(control.sessionFile, started.sessionFile);
	// P2: the send lands (its marker is in the operator-texts log) and settles with the model's reply.
	const sent = await f.bridge.send("dispatch the no-op job", 120_000);
	assert.deepEqual([sent.level, sent.reply], ["owner_observed", "dispatched"], JSON.stringify(sent));
	assert.equal(f.bridge.status().sends.find((row) => row.id === sent.send_id)?.state, "settled");
	assert.ok(recordLines(started.sessionFile).some((line) => line.type === "operator_text" && line.text?.includes(`[cp-send ${sent.send_id} `)));
	const offered = (f.provider.requests.find(isModelCall)?.body.tools as Array<{ name: string }>).map((each) => each.name);
	assert.equal(offered.filter((name) => name.startsWith("mcp__cp__cp_")).length, 22, offered.join(", "));
	// The real CLI's inert placeholder may be the one other entry: no shell, read or edit tool reaches the parent.
	assert.deepEqual(offered.filter((name) => !name.startsWith("mcp__cp__cp_") && name !== "DeferredToolPlaceholder"), []);
	assert.match(JSON.stringify(f.provider.requests.find(isModelCall)?.body.system), /Native parent: your tools are the cp_\* tools/);
	// P3: cp_dispatch ran through the extension: the job is in the fleet and its tool result names it.
	assert.equal(f.post.fleet.get(f.jobId)?.delivery, "local");
	assert.doesNotMatch(toolResults(f.provider.requests)[0] ?? "", /^\[error\]/);
	assert.match(toolResults(f.provider.requests)[0] ?? "", new RegExp(f.jobId));
	// P4: the envelope wakes a turn (its summary rides the wake relay); cp_escalate's details become an escalation relay.
	const wake = await waitFor(() => f.relays.find((relay) => relay.kind === "wake" && relay.text.includes("report received")), Boolean, { timeoutMs: 60_000, what: "the envelope wake relay" });
	assert.equal(wake?.jobId, f.jobId);
	assert.match(wake?.text ?? "", new RegExp(`envelope ${f.jobId}`));
	assert.match(f.relays.find((relay) => relay.kind === "escalation")?.escalationId ?? "", /^es-/);
	// The parent view reads the 0600 log beside the record: the send, the wake-up, cp_dispatch with its result, the reply.
	const view = parentView(await startViewer(t, { home: f.home }));
	const shown = await until(view, (body) => body.entries.some((e) => e.who === "cp-envelope"), "the envelope wake-up in the parent view", 30_000);
	assert.equal(statSync(nativeParentLogFile(started.sessionFile)).mode & 0o777, 0o600);
	assert.ok(shown.entries.some((e) => e.kind === "via" && e.send_id === sent.send_id && e.text === "dispatch the no-op job"), JSON.stringify(shown.entries));
	assert.ok(shown.entries.some((e) => e.who === "cp-envelope" && e.text.includes(f.jobId)), "the wake-up is the fleet's, never an operator text");
	const dispatched = shown.entries.find((e) => e.kind === "tool" && e.name === "cp_dispatch");
	assert.match(dispatched?.text ?? "", new RegExp(`^Arguments\\n[\\s\\S]*${f.jobId}[\\s\\S]*\\n\\nResult\\n[\\s\\S]*${f.jobId}`));
	assert.equal(dispatched?.failed, false);
	assert.ok(shown.entries.some((e) => e.kind === "say" && e.who === "Parent → operator" && e.text === "dispatched"));
	assert.deepEqual([shown.parent.live, shown.parent.context.model], [true, FAKE_NATIVE_MODEL], "the row is live on the log's mtime");
	// P5: SIGTERM, then the relaunch resumes the same claude session with turn 1 and the wake-up in its history.
	const sessionId = recordLines(started.sessionFile).filter((line) => line.type === "session").at(-1)?.session_id;
	assert.ok(sessionId, "the record holds the claude session id");
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	process.kill(first, "SIGTERM");
	await waitFor(() => f.relays.find((relay) => relay.kind === "relaunch"), Boolean, { timeoutMs: 30_000, what: "the relaunch relay" });
	const second = (await waitFor(() => f.bridge.status(), (status) => status.alive && status.pid !== first, { timeoutMs: 30_000, what: "the relaunched entry" })).pid!;
	// A send before the relaunch's boot finishes is queued and drained after ready; its outcome then relays by id.
	const queued = await f.bridge.send("are you still there after the restart?", 120_000);
	const resumed = queued.pending
		? (await waitFor(() => f.relays.find((relay) => relay.kind === "send" && relay.sendId === queued.pending), Boolean, { timeoutMs: 120_000, what: "the resumed send's outcome" }))!.receipt
		: queued;
	assert.equal(resumed.reply, "resumed ok", JSON.stringify([resumed, f.relays.map((relay) => [relay.kind, relay.text.slice(0, 200)])]));
	assert.equal(recordLines(started.sessionFile).filter((line) => line.type === "session").at(-1)?.session_id, sessionId);
	const history = userTexts(f.provider.requests.filter(isModelCall).at(-1));
	const operator = history.filter((text) => text.includes("[cp-send "));
	const fleet = history.filter((text) => text.startsWith("[fleet wake-up cp-envelope"));
	assert.ok(operator.some((text) => text.includes("dispatch the no-op job")), history.join("\n---\n"));
	assert.ok(fleet.length >= 1 && fleet.every((text) => !text.includes("[cp-send ")), history.join("\n---\n"));
	assert.ok(operator.every((text) => !text.includes("[fleet wake-up")));
	const relaunched = await until(view, (body) => body.entries.some((e) => e.text === "resumed ok"), "the resumed reply in the parent view", 30_000);
	assert.ok(relaunched.entries.some((e) => e.text === "dispatched"), "the relaunch appends to the same view");
	// P6: stop ends the entry and releases the lock; no entry pid survives.
	await f.bridge.stop();
	await waitFor(() => [first, second].some(alive), (any) => !any, { timeoutMs: 15_000, what: "both entry pids to exit" });
	assert.notEqual(readParentLock(f.home).state, "held");
});

// Scenario (gap 3): Given a native parent mid-turn on send A, When send B is injected while it is busy and the entry
// is killed, Then the relaunch reads get_entries: B, absent from the operator-texts log, is delivered once,
// And A, logged before the kill, settles through its resume nudge instead of a second delivery.
test("native parent: get_entries reconciles an injected send after a kill mid-turn", { skip: NATIVE, timeout: 240_000 }, async (t) => {
	let release: () => void = () => {};
	const gate = new Promise<void>((done) => (release = done));
	let hung = false;
	const f = await nativeFleet(t, () => [
		{ kind: "text", text: "never answered", beforeAnswer: async () => { hung = true; await gate; } },
		...["reply two", "reply three", "reply four", "reply five"].map((text): ClaudeStep => ({ kind: "text", text })),
	]);
	t.after(() => release());
	const started = await f.start();
	const a = await f.bridge.send("send A holds the turn", 500);
	await waitFor(() => hung, Boolean, { timeoutMs: 60_000, what: "send A's model call" });
	const b = await f.bridge.send("send B waits behind it", 500);
	assert.equal(f.bridge.status().sends.find((row) => row.id === b.send_id)?.state, "injected");
	process.kill(started.pid!, "SIGTERM");
	await waitFor(() => f.relays.find((relay) => relay.kind === "relaunch"), Boolean, { timeoutMs: 30_000, what: "the relaunch relay" });
	const settled = (id?: string) => f.bridge.status().sends.find((row) => row.id === id)?.state === "settled";
	await waitFor(() => settled(a.send_id) && settled(b.send_id), Boolean, { timeoutMs: 120_000, what: "both sends to settle after the relaunch" });
	const logged = (id?: string, body?: string) => recordLines(started.sessionFile).filter((line) => line.type === "operator_text" && line.text?.includes(`[cp-send ${id} `) && (!body || line.text.includes(body)));
	assert.equal(logged(b.send_id, "send B waits behind it").length, 1, "B reached the model exactly once");
	assert.equal(logged(a.send_id, "send A holds the turn").length, 1, "A's body was never re-sent");
	assert.ok(logged(a.send_id).length >= 2, "A was answered through its resume nudge");
});

// Scenario (gap 8): Given the model's provider refuses the credentials, When an operator send runs a native turn,
// Then the turn ends as an assistant error the bridge reports as turn_failed, never a hang,
// And once the provider recovers the next send settles with a reply.
test("native parent: a failed claude turn ends as an assistant error and the parent stays usable", { skip: NATIVE, timeout: 180_000 }, async (t) => {
	const f = await nativeFleet(t, () => [{ kind: "auth_error" }, { kind: "text", text: "recovered" }]);
	await f.start();
	const failed = await f.bridge.send("this turn fails", 120_000);
	assert.equal(failed.level, "turn_failed", JSON.stringify(failed));
	assert.ok(failed.error, "the error names the model failure");
	f.provider.endAuthError();
	const next = await f.bridge.send("and this one works", 120_000);
	assert.equal(next.reply, "recovered", JSON.stringify(next));
});

// Scenario (backfill): Given a driver-claude record whose claude session ran before the parent view existed, When the
// entry boots on it, Then the CLI's <session_id>.jsonl is imported once: the parent view shows the operator send, the
// tool call with its result, the reply, the wake-up and the compaction, And a relaunch imports nothing twice.
test("native parent: a record with no view log imports its claude session once", { timeout: 60_000 }, async (t) => {
	const { home, bridge } = fixture(t, { driver: "claude" });
	const sessions = join(home, layoutForHome("multi", home).sessions), id = "0f0e0d0c-0b0a-4908-8706-050403020100";
	const record = join(sessions, "native-parent-1.jsonl"), send = "ps-20261109112442-6fbb3b2b";
	const lines = (file: string, rows: unknown[]) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join("")); };
	lines(record, [{ type: "record", driver: "claude", created_at: "2026-11-09T11:24:00.000Z" }, { type: "session", session_id: id, at: "2026-11-09T11:24:43.748Z" }]);
	writeFileSync(join(sessions, "cp-parent-control.json"), JSON.stringify({ sessionFile: record, model: FAKE_NATIVE_MODEL }));
	const at = (s: number) => ({ timestamp: `2026-11-09T11:25:0${s}.000Z`, isSidechain: false });
	lines(join(sessions, "native-parent-claude", "config", "projects", "-home-op", `${id}.jsonl`), [
		{ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-09T11:24:43.702Z", sessionId: id },
		{ type: "user", message: { role: "user", content: [{ type: "text", text: `withdraw the stale escalations\n\n[cp-send ${send} — delivery id, not an instruction]` }] }, ...at(1) },
		{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cp__cp_escalate", input: { action: "list" } }] }, ...at(2) },
		{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "2 open" }] }] }, ...at(3) },
		{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "both withdrawn" }] }, ...at(4) },
		{ type: "user", message: { role: "user", content: [{ type: "text", text: "[fleet wake-up cp-envelope — from the fleet, not an operator message]\nenvelope cp-abcd" }] }, ...at(5) },
		{ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 1234 }, ...at(6) },
	]);
	await bridge.start({ home, mode: "multi", model: FAKE_NATIVE_MODEL, piBin: FAKE_PARENT, requestTimeoutMs: 10_000 });
	const view = parentView(await startViewer(t, { home }));
	const { entries } = await until(view, (body) => body.entries.length > 0, "the imported parent view");
	assert.deepEqual(entries.map((e) => [e.kind, e.who, e.name, e.text.split("\n").at(-1)]), [
		["via", "Operator → parent", null, "withdraw the stale escalations"],
		["tool", "assistant", "cp_escalate", "2 open"],
		["say", "Parent → operator", null, "both withdrawn"],
		["system", "cp-envelope", null, "envelope cp-abcd"],
		["system", "compaction", null, "Context compacted (1234 tokens before)"],
	]);
	assert.equal(entries[0]!.send_id, send);
	assert.equal(statSync(nativeParentLogFile(record)).mode & 0o777, 0o600);
	await bridge.stop();
	await bridge.start({ home, mode: "multi", model: FAKE_NATIVE_MODEL, piBin: FAKE_PARENT, requestTimeoutMs: 10_000 });
	assert.equal((await view()).entries.length, entries.length, "a relaunch on the same record imports nothing again");
});
