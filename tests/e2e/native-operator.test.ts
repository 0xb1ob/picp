/**
 * O2: the Claude CLI operator (data/operator.json driver `claude`) through `runOperator`, its dashboard control and a
 * real viewer.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { layoutForHome } from "../../src/contracts.ts";
import type { BridgeRelay } from "../../src/cp-bridge.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { OperatorRelayOutbox, operatorRelayAcksFile, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { readOperatorSessions } from "../../src/viewer/operator-sessions.ts";
import { newUploadId, writeUpload } from "../../src/viewer/uploads.ts";
import { type ClaudeStep, FAKE_CLAUDE_CLI, toolResults } from "../harness/claude-mock-provider.ts";
import { syntheticPng } from "../harness/images.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { type NativeOperator, nativeOperator } from "../harness/native-operator.ts";
import { userTexts } from "../harness/native-parent.ts";

const DC_MARKER = /\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard(; images=[^\]]+)?\]$/;
const HOOKS_OFF = { FAKE_CLAUDE_HOOKS: "off" };
type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type Message = { role: string; content: string | Block[] };
const relay = (text: string): BridgeRelay => ({ kind: "wake", stale: false, text, receipt: { level: null, reached: [] }, paths: [] });
/** The ack-file line types for relay `id`, in order. */
const acks = (state: string, id: string): string[] => {
	const file = operatorRelayAcksFile(state);
	const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
	return lines.map((line) => JSON.parse(line) as { type: string; id?: string }).filter((line) => line.id === id).map((line) => line.type);
};

// Scenario: Given driver claude in data/operator.json, When the human sends from the dashboard, Then the model call
// carries the dashboard marker, and the viewer's operator Full transcript and context ring read the native log.
// Negative control: the native record itself never holds the reply, so a viewer reading it raw shows no reply.
test("NO-1: a dashboard send reaches the Claude CLI operator's model, and the viewer shows its reply and usage", { timeout: 180_000 }, async (t) => {
	const op = await nativeOperator(t, [{ kind: "text", text: "NO1-REPLY all quiet" }]);
	const reply = await op.send("send", { kind: "message", text: "NO1-HELLO status?" });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	const request = await op.seen("NO1-HELLO");
	assert.match(userTexts(request).at(-1)!, DC_MARKER);
	const transcript = await op.view("/api/sessions?view=you&transcript=1", (view) => JSON.stringify(view.entries).includes("NO1-REPLY"), "the reply in the operator transcript");
	assert.ok(JSON.stringify(transcript.entries).includes("NO1-HELLO"));
	assert.ok(transcript.operator_context?.tokens > 0, JSON.stringify(transcript.operator_context));
	const [recorded] = readOperatorSessions(join(op.state, "sessions"));
	assert.match(recorded!.file, /native-operator-\d+\.jsonl$/);
	assert.doesNotMatch(readFileSync(recorded!.file, "utf8"), /NO1-REPLY/, "the record holds no reply: only the mapping shows it");

	// The same first message to a pi operator with the same bridge, for the request-size comparison the report asks for.
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("no1-pi", [{ kind: "text", text: "ok" }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: agent.path });
	const pi = startPiChild({ cwd: home.path, model, extensions: [CP_BRIDGE_EXTENSION], env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi" } });
	t.after(async () => { await pi.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await pi.prompt(userTexts(request).at(-1)!);
	const [piRequest] = await waitFor(() => provider.requests("no1-pi"), (seen) => seen.length > 0, { timeoutMs: 60_000, what: "the pi operator's first request" });
	t.diagnostic(`first model request bytes: Claude CLI ${Buffer.byteLength(JSON.stringify(request.body))}, pi ${Buffer.byteLength(JSON.stringify(piRequest!.body))}`);
});

// Scenario: Given a relay seeded in the operator relay outbox, When the Claude CLI operator is idle, Then the relay
// starts a turn, is emitted and acked once and sits once in the context; one emitted mid-turn rides the next turn.
test("NO-2: an outbox relay starts a turn while idle, is acked once, never handed twice; a mid-turn one rides the next turn", { timeout: 180_000 }, async (t) => {
	let op: NativeOperator | undefined;
	let mid = "";
	// The bridge holds delivery while a run is open (OperatorRelayConsumer#running): it is emitted at the settle.
	const duringTurn = async () => { mid = new OperatorRelayOutbox(operatorRelayOutboxFile(op!.state)).enqueue(relay("NO2-MID during the turn"), "h"); };
	op = await nativeOperator(t, [{ kind: "text", text: "NO2 first read", beforeAnswer: duringTurn }, { kind: "text", text: "NO2 second read" }]);
	const seeded = new OperatorRelayOutbox(operatorRelayOutboxFile(op.state)).enqueue(relay("NO2-SEEDED while idle"), "h");
	const first = await op.seen("NO2-SEEDED");
	assert.ok(!userTexts(first).some((text) => text.includes("NO2-MID")), "the mid-turn relay never joins the running turn's first call");
	const second = await op.seen("NO2-MID");
	assert.notEqual(second, first);
	await waitFor(() => acks(op.state, mid), (types) => types.includes("ack"), { timeoutMs: 30_000, what: "the mid-turn relay's ack" });
	await new Promise((done) => setTimeout(done, 1_500)); // a few relay ticks: a second hand-off would show by now
	for (const id of [seeded, mid]) assert.deepEqual(acks(op.state, id), ["emit", "ack"], `${id}: emitted once, acked once`);
	const history = userTexts(op.calls().at(-1));
	for (const tag of ["NO2-SEEDED", "NO2-MID"]) assert.equal(history.filter((text) => text.includes(tag)).length, 1, `${tag} sits once in the context`);
});

/** NO-3's guarded calls against `paths` (filled once the home exists), then a plain reply. */
const guardScript = (paths: { state: string; settings: string; workspace: string }): ClaudeStep[] => [
	{ kind: "tool_use", calls: [
		{ name: "Write", input: () => ({ file_path: join(paths.state, "x"), content: "NO3 forbidden" }) },
		{ name: "Read", input: () => ({ file_path: paths.settings }) },
		{ name: "mcp__cp__cp_dispatch", input: { job_id: "cp-none" } },
		{ name: "Write", input: () => ({ file_path: join(paths.workspace, "no3.md"), content: "NO3-NOTE" }) },
	] },
	{ kind: "text", text: "NO3 done" },
];

async function guarded(t: TestContext, settingsEnv: Record<string, string> = {}) {
	const paths = { state: "", settings: "", workspace: "" };
	const op = await nativeOperator(t, guardScript(paths), { settingsEnv });
	Object.assign(paths, { state: op.state, settings: op.settings, workspace: join(op.home, layoutForHome("multi", op.home).operatorWorkspace) });
	assert.equal((await op.send("send", { kind: "message", text: "NO3-GO" })).ok, true);
	const results = await waitFor(() => toolResults(op.provider.requests), (seen) => seen.length >= 4, { timeoutMs: 60_000, what: "four tool results" });
	return { paths, results };
}

// Scenario: Given the D2 guards, When the operator's model calls Write into state/, Read of the passed settings file,
// cp_dispatch and Write under the operator workspace, Then the first three are refused and the last one runs.
test("NO-3: Write outside the operator's scope, a settings Read and a fleet tool are denied; a workspace Write runs", { timeout: 180_000 }, async (t) => {
	const { paths, results } = await guarded(t);
	assert.match(results[0]!, /^\[error\] Refused: write \S+: the operator session writes only under /);
	assert.match(results[1]!, /^\[error\] Refused: the operator's Read never touches the Claude settings/);
	assert.equal(results[2], "[error] Refused: mcp__cp__cp_dispatch is not one of the operator's tools.");
	assert.doesNotMatch(results[3]!, /^\[error\]/);
	assert.equal(existsSync(join(paths.state, "x")), false);
	assert.equal(readFileSync(join(paths.workspace, "no3.md"), "utf8"), "NO3-NOTE");
});

// Negative control: with fake-claude's hook callbacks off (an allow-all PreToolUse), NO-3's forbidden Write lands and
// the settings Read returns the file, so NO-3 fails without the operator's guard.
test("NO-3 negative control: with PreToolUse off the forbidden Write lands and the settings file is read", { timeout: 180_000 }, async (t) => {
	const { paths, results } = await guarded(t, HOOKS_OFF);
	assert.equal(readFileSync(join(paths.state, "x"), "utf8"), "NO3 forbidden");
	assert.match(results[1]!, /CLAUDE_CODE_OAUTH_TOKEN/);
});

const QUESTION = "NO4 Should I merge cp-abcd now?";

// Scenario: Given a reply that asks the human in prose with no cp_parent ask, When the CLI stops, Then the Stop hook
// forces one continuation carrying the ask guard's nudge, and the repeated question becomes a card in asks.jsonl.
test("NO-4: a prose question gets one Stop-hook continuation, then a card", { timeout: 180_000 }, async (t) => {
	const op = await nativeOperator(t, [{ kind: "text", text: QUESTION }, { kind: "text", text: QUESTION }]);
	assert.equal((await op.send("send", { kind: "message", text: "NO4-GO" })).ok, true);
	const asks = new OperatorAsks(join(op.state, "operator", "asks.jsonl"));
	const [card] = await waitFor(() => asks.list(), (list) => list.length > 0, { timeoutMs: 60_000, what: "the ask guard's card" });
	assert.match(JSON.stringify(card), /Should I merge cp-abcd now\?/);
	assert.equal(op.calls().length, 2, "one continuation, never a loop");
	assert.match(userTexts(op.calls()[1]).at(-1)!, /^Stop hook feedback:\nYour reply asks the human a question but opened no cp_parent ask/);
});

// Negative control: with fake-claude's hook callbacks off no Stop hook runs: one model call, no nudge, no card.
test("NO-4 negative control: with the Stop hook off there is no continuation and no card", { timeout: 180_000 }, async (t) => {
	const op = await nativeOperator(t, [{ kind: "text", text: QUESTION }, { kind: "text", text: QUESTION }], { settingsEnv: HOOKS_OFF });
	assert.equal((await op.send("send", { kind: "message", text: "NO4-GO" })).ok, true);
	await op.view("/api/sessions?view=you&transcript=1", (view) => JSON.stringify(view.entries).includes("NO4 Should I"), "the reply");
	await new Promise((done) => setTimeout(done, 1_000));
	assert.equal(op.calls().length, 1);
	assert.deepEqual(new OperatorAsks(join(op.state, "operator", "asks.jsonl")).list(), []);
});

const PICKED = "anthropic/claude-sonnet-5";

// Scenario: Given the human typed a model in the dashboard, When the operator's model calls cp_parent model_pick with
// that quote, Then a pick is issued from the operator's own recorded text; a quote the human never typed is refused.
test("NO-5: model_pick resolves the human's quote from the native record and refuses one never typed", { timeout: 180_000 }, async (t) => {
	const pick = (quote: string) => ({ name: "mcp__cp__cp_parent", input: { action: "model_pick", model: PICKED, quote } });
	const op = await nativeOperator(t, [{ kind: "tool_use", calls: [pick(`use ${PICKED} for this one`), pick(`use ${PICKED} for every job`)] }, { kind: "text", text: "NO5 done" }]);
	assert.equal((await op.send("send", { kind: "message", text: `Please use ${PICKED} for this one.` })).ok, true);
	const [issued, never] = await waitFor(() => toolResults(op.provider.requests), (seen) => seen.length >= 2, { timeoutMs: 60_000, what: "both picks answered" });
	assert.doesNotMatch(issued!, /^\[error\]/);
	assert.match(issued!, /omp-[0-9a-f]{32}/);
	assert.match(never!, /^\[error\] .*operator_pick_missing: no message in this operator session contains the quote/);
});

/** The image blocks of the user message carrying `needle` in `request`. */
const imagesOf = (request: { body: Record<string, unknown> }, needle: string): Block[] => ((request.body.messages ?? []) as Message[])
	.filter((message) => message.role === "user" && JSON.stringify(message.content).includes(needle))
	.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "image");

// Scenario: Given an uploaded PNG, When the dashboard sends it with send_images, Then the model call carries it as an
// Anthropic base64 image block. Negative controls: a plain send carries none, and fake-claude refuses pi's own shape.
test("NO-6: send_images reaches the Claude CLI operator's model as an image block", { timeout: 180_000 }, async (t) => {
	const uploads = mkdtempSync(join(tmpdir(), "cp-no6-uploads-"));
	t.after(() => rmSync(uploads, { recursive: true, force: true }));
	const op = await nativeOperator(t, [{ kind: "text", text: "NO6 seen" }, { kind: "text", text: "NO6 plain" }], { env: { CP_UPLOAD_ROOT: uploads } });
	const id = newUploadId("png", new Date());
	writeUpload(uploads, id, syntheticPng(2, 2));
	const sent = await op.send("send_images", { kind: "message", text: "NO6-WHAT", images: [id] });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	const [image] = imagesOf(await op.seen("NO6-WHAT"), "NO6-WHAT");
	assert.deepEqual([image?.source?.type, image?.source?.media_type], ["base64", "image/png"]);
	assert.equal(Buffer.from(image!.source!.data, "base64").subarray(1, 4).toString("latin1"), "PNG");
	assert.equal((await op.send("send", { kind: "message", text: "NO6-PLAIN" })).ok, true);
	assert.deepEqual(imagesOf(await op.seen("NO6-PLAIN"), "NO6-PLAIN"), []);

	// Negative control: pi's own `{ data, mimeType }` image part, as an unconverted engine would send it, is refused.
	const store = mkdtempSync(join(tmpdir(), "cp-no6-fake-"));
	t.after(() => rmSync(store, { recursive: true, force: true }));
	const fake = spawn(process.execPath, [FAKE_CLAUDE_CLI], { env: { ...process.env, CLAUDE_CONFIG_DIR: store }, stdio: ["pipe", "pipe", "inherit"] });
	let out = "";
	fake.stdout.on("data", (chunk) => { out += String(chunk); });
	const exited = new Promise((done) => fake.on("exit", done));
	fake.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } })}\n`);
	await exited;
	const result = out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; is_error?: boolean; result?: string }).find((line) => line.type === "result");
	assert.equal(result?.is_error, true, out);
	assert.match(result?.result ?? "", /^API Error: 400 messages: an image must be a base64 source/);
});

// Scenario: Given a module that calls console.log while each Claude CLI entry loads (before startClaudeSession), When
// the entry runs, Then the line lands on stderr and never on stdout (the parent's RPC channel, the operator's terminal).
// Negative control: with claude-stdout-guard.ts loaded empty, the same line reaches stdout.
test("stdout guard: a console.log before the engine starts never reaches either entry's stdout", { timeout: 60_000 }, () => {
	const preload = (dropGuard: boolean) => `data:text/javascript,${encodeURIComponent(`import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
	const out = next(url, context);
	if (url.endsWith("/src/drivers/claude.ts")) return { ...out, source: 'console.log("GUARD-SENTINEL");\\n' + String(out.source) };
	if (${dropGuard} && url.endsWith("/src/drivers/claude-stdout-guard.ts")) return { ...out, source: "" };
	return out;
} });`)}`;
	for (const entry of ["claude-parent.ts", "claude-operator.ts"]) {
		const run = (dropGuard: boolean) => spawnSync(process.execPath, ["--import", preload(dropGuard), join(import.meta.dirname, "../../src/drivers", entry)], { encoding: "utf8", timeout: 30_000 });
		const guarded = run(false);
		assert.equal(guarded.status, 2, `${entry} should refuse to start without its arguments: ${guarded.stderr}`);
		assert.match(guarded.stderr, /GUARD-SENTINEL/, entry);
		assert.doesNotMatch(guarded.stdout, /GUARD-SENTINEL/, entry);
		assert.match(run(true).stdout, /GUARD-SENTINEL/, `${entry} negative control`);
	}
});
