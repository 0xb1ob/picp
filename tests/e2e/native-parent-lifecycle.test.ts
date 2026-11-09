/**
 * The Claude CLI parent's lifecycle (S2a) through the real `CpBridge` and src/drivers/claude-parent.ts, with
 * tests/fixtures/fake-claude.ts as `claude` on PATH and the claude mock provider as the model: compact, rotate,
 * model and thinking switches, and context stats across a restart. No network, no login, no installed Claude Code.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type ClaudeStep, FAKE_CLAUDE_MODEL, FAKE_NATIVE_MODEL, installClaudeStub, type RecordedClaudeRequest, startClaudeMockProvider, subscriberEnv } from "../harness/claude-mock-provider.ts";
import { createScratchHome, waitFor } from "../harness/index.ts";
import { layoutForHome } from "../../src/contracts.ts";
import { type BridgeRelay, CpBridge } from "../../src/cp-bridge.ts";
import { readParentLock } from "../../src/parent-lock.ts";

const dataDir = (home: string) => join(home, layoutForHome("multi", home).data);
const sessionsDir = (home: string) => join(home, layoutForHome("multi", home).sessions);
const isModelCall = (request: RecordedClaudeRequest) => request.path.split("?")[0] === "/v1/messages" && Array.isArray(request.body.tools) && (request.body.tools as unknown[]).length > 0;
const userTexts = (request: RecordedClaudeRequest | undefined): string[] => ((request?.body.messages as Array<{ role: string; content: unknown }> | undefined) ?? [])
	.filter((message) => message.role === "user")
	.flatMap((message) => typeof message.content === "string" ? [message.content] : (message.content as Array<{ type?: string; text?: string }>).filter((block) => block.type === "text").map((block) => String(block.text)));
const recordLines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; session_id?: string; tokens?: number | null });
const sessionOf = (file: string) => recordLines(file).filter((line) => line.type === "session").at(-1)?.session_id;

/** A driver-claude home whose parent runs on the claude stub and the mock provider; stops before anything is removed. */
async function nativeParent(t: TestContext, script: ClaudeStep[]) {
	const provider = await startClaudeMockProvider(script);
	const scratch = createScratchHome();
	const home = scratch.path;
	mkdirSync(dataDir(home), { recursive: true });
	writeFileSync(join(dataDir(home), "parent.json"), JSON.stringify({ driver: "claude" }));
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-native-lifecycle-home-"));
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: subscriberEnv(provider.url) }));
	installClaudeStub(join(fakeHome, "bin"));
	const previous = { HOME: process.env.HOME, PATH: process.env.PATH };
	Object.assign(process.env, { HOME: fakeHome, PATH: `${join(fakeHome, "bin")}:${process.env.PATH ?? ""}` });
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => {
		try { await bridge.stop(); } finally {
			for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
			await provider.close();
			scratch.cleanup();
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
	const start = () => bridge.start({ home, mode: "multi", model: FAKE_NATIVE_MODEL, requestTimeoutMs: 30_000, settleTimeoutMs: 60_000 });
	/** One send's reply, once every send is settled and the bridge's after-settle pass is done (control needs both). */
	const send = async (text: string) => {
		const receipt = await bridge.send(text, 60_000);
		assert.equal(receipt.level, "owner_observed", JSON.stringify(receipt));
		await waitFor(() => bridge.status().sends, (sends) => sends.every((row) => row.state === "settled"), { timeoutMs: 20_000, what: "every parent send settled" });
		await bridge.statusWithContext();
		return receipt.reply;
	};
	/** The claude argv of every turn the entry ran, in order (the stub logs each spawn in its config dir). */
	const spawns = () => readFileSync(join(sessionsDir(home), "native-parent-claude", "config", "fake-claude", "spawns.jsonl"), "utf8")
		.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { argv: string[] }).argv);
	const calls = () => provider.requests.filter(isModelCall);
	return { home, provider, bridge, relays, start, send, spawns, calls };
}

// Scenario: Given a native parent with one turn behind it, When cp_parent compact runs with instructions,
// Then the CLI's /compact gets the bridge's instructions, the answer has tokensBefore and estimatedTokensAfter,
// And after a stop and start get_session_stats reports that reading before any turn (gap 4: never null),
// And the next turn resumes the same claude session, whose history is the summary, not the compacted turn.
test("native parent lifecycle: compact runs /compact and the context reading survives a restart", { timeout: 120_000 }, async (t) => {
	const p = await nativeParent(t, [{ kind: "text", text: "first reply" }, { kind: "text", text: "SUMMARY-7 of the earlier turn" }, { kind: "text", text: "after compaction" }]);
	const started = await p.start();
	assert.equal((await p.bridge.statusWithContext()).contextTokens, null, "a fresh session has no reading yet");
	assert.equal(await p.send("hello before compaction"), "first reply");
	const before = (await p.bridge.statusWithContext()).contextTokens;
	assert.ok(typeof before === "number" && before > 0, String(before));
	const session = sessionOf(started.sessionFile);
	const compacted = await p.bridge.compact("keep MARKER-INSTR");
	assert.equal(compacted.tokensBefore, before);
	assert.ok(typeof compacted.estimatedTokensAfter === "number" && compacted.estimatedTokensAfter > 0, JSON.stringify(compacted));
	const summaryCall = JSON.stringify(p.calls()[1]?.body.messages);
	assert.match(summaryCall, /keep MARKER-INSTR/);
	assert.match(summaryCall, /Keep open escalations, holds, standing operator instructions/, "parentCompactInstructions ride along");
	assert.equal(p.spawns().at(-1)?.find((arg) => arg.startsWith("--resume=")), `--resume=${session}`);
	assert.equal((await p.bridge.statusWithContext()).contextTokens, compacted.estimatedTokensAfter);
	await p.bridge.stop();
	const calls = p.calls().length;
	const restarted = await p.start();
	assert.equal(restarted.start, "resumed");
	assert.equal((await p.bridge.statusWithContext()).contextTokens, compacted.estimatedTokensAfter, "the reading is the record's, not null");
	assert.equal(p.calls().length, calls, "reading the stats made no model call");
	assert.equal(await p.send("after the restart"), "after compaction");
	assert.equal(sessionOf(restarted.sessionFile), session);
	const history = userTexts(p.calls().at(-1));
	assert.match(history[0] ?? "", /SUMMARY-7 of the earlier turn/);
	assert.ok(history.every((text) => !text.includes("hello before compaction")), history.join("\n---\n"));
});

// Scenario: Given a native parent with one turn behind it, When cp_parent rotate runs, Then the record is archived,
// a new record is active and the entry keeps the home's lock across pi's shutdown/start of the extension,
// And the next turn starts a fresh claude session (no --resume, no earlier message) whose system prompt carries the
// standing orders as edited before the rotation.
test("native parent lifecycle: rotate archives the record and the next turn starts fresh with the standing orders", { timeout: 120_000 }, async (t) => {
	const p = await nativeParent(t, [{ kind: "text", text: "before rotation" }, { kind: "text", text: "after rotation" }]);
	const started = await p.start();
	assert.equal(await p.send("first session message"), "before rotation");
	const first = sessionOf(started.sessionFile);
	assert.ok(first);
	writeFileSync(join(dataDir(p.home), "standing-orders.md"), "# Standing orders\n\n- ORDER-ROTATE-9: keep replies short.\n");
	const rotated = await p.bridge.rotate();
	assert.notEqual(rotated.sessionFile, started.sessionFile);
	assert.equal(existsSync(started.sessionFile), false, "the old record was renamed");
	assert.equal(sessionOf(rotated.archivedFile), first, "the archive keeps the old session id");
	assert.equal(recordLines(rotated.sessionFile)[0]?.type, "record");
	assert.equal(p.bridge.status().sessionFile, rotated.sessionFile);
	const lock = readParentLock(p.home);
	assert.equal(lock.state === "held" && lock.record.pid, started.pid, "the entry holds the lock after the extension's restart");
	assert.equal((await p.bridge.statusWithContext()).contextTokens, null, "a fresh session has no reading");
	assert.equal(await p.send("second session message"), "after rotation");
	assert.equal(p.spawns().at(-1)?.some((arg) => arg.startsWith("--resume")), false, "the turn after a rotation resumes nothing");
	const next = sessionOf(rotated.sessionFile);
	assert.ok(next && next !== first, `${next} vs ${first}`);
	const call = p.calls().at(-1);
	const texts = userTexts(call);
	assert.ok(texts.some((text) => text.includes("second session message")), texts.join("\n---\n"));
	assert.ok(texts.every((text) => !text.includes("first session message")), texts.join("\n---\n"));
	assert.match(JSON.stringify(call?.body.system), /ORDER-ROTATE-9/);
});

// Scenario: Given a native parent, When cp_parent model and a Settings thinking change apply between turns,
// Then no model call is made until the next turn, which runs on the new model and effort,
// And a non-Claude model or a level with no native effort (minimal) is refused by name and the old values stay,
// And thinking off runs the next turn with thinking disabled.
test("native parent lifecycle: set_model and set_thinking_level apply on the next turn and a rejection keeps the old", { timeout: 120_000 }, async (t) => {
	const p = await nativeParent(t, ["one", "two", "three", "four"].map((text): ClaudeStep => ({ kind: "text", text })));
	await p.start();
	assert.equal(await p.send("turn one"), "one");
	assert.equal(p.calls().at(-1)?.body.model, FAKE_CLAUDE_MODEL);
	assert.ok(p.spawns().at(-1)?.includes(`--model=${FAKE_CLAUDE_MODEL}`));
	assert.equal(p.spawns().at(-1)?.some((arg) => arg.startsWith("--effort") || arg.startsWith("--thinking")), false);
	const settings = (thinking: string) => writeFileSync(join(dataDir(p.home), "parent.json"), JSON.stringify({ driver: "claude", thinking }));
	const calls = p.calls().length;
	assert.deepEqual(await p.bridge.model("anthropic/claude-picp-next"), { model: "anthropic/claude-picp-next" });
	settings("high");
	await p.bridge.applySettings();
	assert.equal(p.calls().length, calls, "a switch is applied by the next turn, not by a model call");
	assert.equal(await p.send("turn two"), "two");
	assert.equal(p.calls().at(-1)?.body.model, "claude-picp-next");
	assert.ok(p.spawns().at(-1)?.includes("--model=claude-picp-next"));
	assert.ok(p.spawns().at(-1)?.includes("--effort=high"), String(p.spawns().at(-1)));
	assert.deepEqual(p.calls().at(-1)?.body.output_config, { effort: "high" });
	await assert.rejects(p.bridge.model("mock/parent"), /set_model mock\/parent rejected: the Claude CLI driver runs an explicit anthropic\/claude-… model, and mock\/parent is not one/);
	settings("minimal");
	await p.bridge.applySettings();
	const refused = await waitFor(() => p.relays.find((relay) => relay.kind === "error" && relay.text.includes("set_thinking_level minimal rejected")), Boolean, { timeoutMs: 5_000, what: "the thinking refusal relay" });
	assert.match(refused?.text ?? "", /thinking=minimal has no Claude CLI effort/);
	assert.equal(p.bridge.status().model, "anthropic/claude-picp-next");
	assert.equal(await p.send("turn three"), "three");
	assert.equal(p.calls().at(-1)?.body.model, "claude-picp-next");
	assert.ok(p.spawns().at(-1)?.includes("--effort=high"), "the refused level left high in force");
	settings("off");
	await p.bridge.applySettings();
	assert.equal(await p.send("turn four"), "four");
	assert.ok(p.spawns().at(-1)?.includes("--thinking=disabled"));
	assert.equal(p.spawns().at(-1)?.some((arg) => arg.startsWith("--effort")), false);
});
