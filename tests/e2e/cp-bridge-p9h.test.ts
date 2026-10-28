/** P9h: the operator-to-parent bridge (`src/cp-bridge.ts`) driven as a real CpBridge over a real parent pi. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BRIDGE_RECEIPT_LEVELS, LAYOUT, type ThinkingLevel } from "../../src/contracts.ts";
import { type BridgeRelay, CpBridge, CpBridgeError, operatorPiArgs } from "../../src/cp-bridge.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { acquireParentLock } from "../../src/parent-lock.ts";
import { parentFile, parentRow } from "../../src/viewer/sessions.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, type ScriptStep, startRpc, waitFor } from "../harness/index.ts";

type StartOptions = { model?: string; modelExplicit?: boolean; home?: string; thinking?: ThinkingLevel };

/** One mock provider whose scripts are all parent models; every bridge started here is stopped after the test. */
async function fixture(t: TestContext, scripts: Record<string, ScriptStep[]>, parentJson?: string, existing?: string) {
	const home = existing ? { path: existing, cleanup: () => {} } : createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	if (parentJson !== undefined) writeFileSync(join(home.path, LAYOUT.data, "parent.json"), parentJson);
	const provider = await MockProvider.start();
	const models = Object.fromEntries(Object.entries(scripts).map(([name, steps]) => [name, provider.addScript(name, steps, { onExhausted: "repeat" })]));
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const previous = { ...process.env };
	Object.assign(process.env, agent.env);
	const bridges: CpBridge[] = [];
	const relays: BridgeRelay[] = [];
	const homes = [home];
	t.after(async () => {
		for (const bridge of bridges) await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		agent.cleanup(); await provider.stop();
		for (const scratch of homes) scratch.cleanup();
	});
	const first = Object.values(models)[0]!;
	return {
		home: home.path, provider, relays, models,
		newHome: () => { const scratch = createScratchHome(); homes.push(scratch); return scratch.path; },
		bridge: () => { const bridge = new CpBridge(); bridges.push(bridge); bridge.onRelay((relay) => { relays.push(relay); }); return bridge; },
		start: async (bridge: CpBridge, options: StartOptions = {}, sleeps: number[] = []) => bridge.start({
			home: options.home ?? home.path, mode: "multi", model: options.model ?? first, ...(options.modelExplicit ? { modelExplicit: true } : {}),
			...(options.thinking ? { thinking: options.thinking } : {}),
			cwd: options.home ?? home.path, commandPostExtension: COMMAND_POST_EXTENSION, outerRetrySleep: async (ms) => { sleeps.push(ms); },
		}),
		bodies: (name: string) => provider.requests(name).map((request) => JSON.stringify(request.body)),
	};
}

const control = (home: string) => JSON.parse(readFileSync(join(home, LAYOUT.sessions, "cp-parent-control.json"), "utf8")) as { model?: string };
/** Every send settled, then one stats round trip (as S25 does) so pi's own run has closed too. */
const settled = async (bridge: CpBridge) => {
	await waitFor(() => bridge.status().sends, (sends) => sends.every((send) => ["settled", "failed", "undeliverable"].includes(send.state)),
		{ timeoutMs: 20_000, what: "every parent send settled" });
	await bridge.statusWithContext();
};

test("P9h-bridge-receipts: a send climbs to owner_observed, a transient turn resumes once, compaction waits for settlement and stop is observed", { timeout: 180_000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const f = await fixture(t, { "p9h-receipts": [
		{ kind: "text", text: "P9H reply." },
		{ kind: "error", status: 503, message: "P9H service unavailable" },
		{ kind: "text", text: "P9H resumed." },
		{ kind: "hang", until: gate },
		{ kind: "text", text: "P9H first.", usage: { prompt_tokens: 42000 } },
		{ kind: "text", text: "P9H automatic summary." },
		{ kind: "text", text: "P9H summary." },
	] }, '{"compact_at_tokens":40000}');
	const lock = acquireParentLock({ home: f.home });
	assert.equal(lock.ok, true);
	await assert.rejects(f.start(f.bridge()), (error: unknown) => error instanceof CpBridgeError && /already holds/.test((error as Error).message),
		"a live lock holder refuses the start");
	if (lock.ok) lock.lock.release();

	const sleeps: number[] = [];
	const bridge = f.bridge();
	await f.start(bridge, {}, sleeps);
	const receipt = await bridge.send("P9H ship the widget");
	assert.deepEqual(receipt, { level: "owner_observed", reached: ["injected", "turn_settled", "owner_observed"], reply: "P9H reply.", send_id: receipt.send_id });
	assert.deepEqual(BRIDGE_RECEIPT_LEVELS, ["injected", "turn_settled", "http_accepted", "owner_observed", "turn_failed"]);
	assert.equal(JSON.stringify(receipt).includes("accepted"), false, "http_accepted is never claimed, and no level is named accepted");
	const status = bridge.status();
	assert.equal(status.alive, true);
	assert.equal(typeof status.pid, "number");
	assert.ok(status.sessionFile?.endsWith("cp-parent.jsonl"));
	assert.ok(status.lastReplyAt);

	await new EscalationStore({ home: f.home }).raise({ job_ids: ["cp-job"], kind: "product_ambiguity", question: "which copy?",
		options: [{ id: "approve", label: "approve", consequence: "proceed", cost: "none" }, { id: "decline", label: "decline", consequence: "stop", cost: "sunk" }],
		recommended: "approve", evidence_paths: ["state/runs/cp-job/artifact.md"] });
	assert.deepEqual(bridge.status().openEscalations.map((row) => row.question), ["which copy?"], "open escalations come from the store");
	assert.ok(bridge.status().paths.some((path) => path.endsWith(join("state", "runs", "cp-job", "artifact.md"))), "paths, never bodies");

	const resumed = await bridge.send("P9H transient turn");
	assert.equal(resumed.reply, "P9H resumed.");
	assert.deepEqual(sleeps, [5_000], "one outer-ladder attempt");
	const resume = f.bodies("p9h-receipts")[2]!;
	assert.match(resume, /The previous turn failed with a transient provider error\. Continue where you left off/);
	assert.equal(resume.split("P9H transient turn").length - 1, 1, "the resume never re-sends the original text");

	const pending = await bridge.send("P9H hang", 300);
	assert.equal(pending.pending, pending.send_id);
	await assert.rejects(bridge.compact(), /pending send|settled/, "a manual compact waits for settlement");
	release();
	await waitFor(() => bridge.sendReceipt(pending.send_id!)?.reply, (reply) => reply === "late", { timeoutMs: 20_000, what: "the hung send settled" });
	assert.equal(typeof (await bridge.statusWithContext()).contextTokens, "number", "status reports the parent's context tokens");
	assert.equal(bridge.status().lastCompactAt, undefined, "a small context is never compacted");
	assert.equal((await bridge.send("P9H first turn")).reply, "P9H first.");
	await waitFor(() => bridge.status().lastCompactAt, Boolean, { timeoutMs: 20_000, what: "the automatic compaction after settlement" });
	await bridge.send("P9H next turn");
	assert.ok((await bridge.statusWithContext()).contextTokens! < 40000);
	await settled(bridge);
	assert.equal(typeof (await bridge.compact()).tokensBefore, "number", "a settled parent compacts on request");

	const exit = await bridge.stop();
	assert.equal(exit?.code, 0, "stop observes the parent's close");
	assert.equal(bridge.status().alive, false);
	assert.equal(f.relays.some((relay) => relay.kind === "relaunch"), false, "an observed stop never relaunches");
});

test("P9h-bridge-relaunch: a killed parent relaunches its same session once and never replays a send; rotation moves that session", { timeout: 180_000 }, async (t) => {
	const f = await fixture(t, { "p9h-relaunch": [{ kind: "text", text: "P9H answered." }] });
	const bridge = f.bridge();
	const started = await f.start(bridge);
	assert.equal((await bridge.send("P9H mandate once")).reply, "P9H answered.");
	const kill = async (expected: string, count: number) => {
		const pid = bridge.status().pid!;
		process.kill(pid, "SIGKILL");
		await waitFor(() => bridge.status(), (status) => status.alive && status.pid !== pid, { timeoutMs: 60_000, what: "the relaunched parent" });
		const notices = f.relays.filter((relay) => relay.kind === "relaunch");
		assert.equal(notices.length, count, JSON.stringify(notices));
		assert.equal(bridge.status().sessionFile, expected);
		return notices.at(-1)!.text;
	};
	const notice = await kill(started.sessionFile, 1);
	for (const phrase of [/relaunching same session/, /reconcile/, /not replayed/]) assert.match(notice, phrase);
	assert.equal(f.provider.requests("p9h-relaunch").length, 1, "the relaunch sends nothing to the model");
	const after = await bridge.send("P9H after relaunch");
	await waitFor(() => bridge.sendReceipt(after.send_id!)?.reply, (reply) => reply === "P9H answered.", { timeoutMs: 30_000, what: "the send after relaunch answered" });
	assert.equal(f.bodies("p9h-relaunch")[1]!.split("P9H mandate once").length - 1, 1, "the earlier send is history, never replayed");

	const orders = join(f.home, LAYOUT.data, "standing-orders.md");
	writeFileSync(orders, "# Standing orders\n\nP9H operator order.\n");
	await settled(bridge);
	const pid = bridge.status().pid;
	const rotated = await bridge.rotate();
	assert.notEqual(rotated.sessionFile, started.sessionFile);
	assert.equal(bridge.status().pid, pid, "rotation keeps the running parent");
	assert.ok(rotated.archivedFile.includes("cp-parent-"));
	assert.ok(readFileSync(rotated.archivedFile, "utf8").includes('"type":"session"'));
	const delivered = await bridge.send("P9H after rotation");
	assert.equal(bridge.status().sends.find((send) => send.id === delivered.send_id)?.level, "owner_observed");
	assert.equal(f.bodies("p9h-relaunch").at(-1)!.split("P9H operator order.").length - 1, 1, "the edited orders reach the rotated session once");
	assert.equal(readFileSync(orders, "utf8"), "# Standing orders\n\nP9H operator order.\n", "operator edits are never reseeded");
	const viewer = { home: f.home, stateDir: join(f.home, LAYOUT.state) };
	assert.equal(parentFile(viewer), rotated.sessionFile, "the viewer follows the rotated file");
	assert.ok(parentRow(viewer).standing_orders_at);
	assert.ok(parentRow(viewer).last_rotate_at);
	await kill(rotated.sessionFile, 2);
	await bridge.stop();
	assert.equal((await f.start(f.bridge())).sessionFile, rotated.sessionFile, "a later start opens the rotated session");
});

test("P9h-bridge-model: start precedence, a live switch and rotation settle the parent model without a restart", { timeout: 240_000 }, async (t) => {
	const reply: ScriptStep[] = [{ kind: "text", text: "P9H model reply." }];
	const f = await fixture(t, Object.fromEntries(["p9h-env", "p9h-saved", "p9h-file", "p9h-explicit", "p9h-live", "p9h-next"].map((name) => [name, reply])));
	const m = f.models as Record<string, string>;
	const startWith = async (home: string, options: StartOptions) => {
		const bridge = f.bridge();
		await f.start(bridge, { home, ...options });
		const model = bridge.status().model;
		await bridge.stop();
		return model;
	};
	const parentJson = (home: string, model: string) => writeFileSync(join(home, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 100000, model }));

	const precedence = f.newHome();
	mkdirSync(join(precedence, LAYOUT.sessions), { recursive: true });
	mkdirSync(join(precedence, LAYOUT.data), { recursive: true });
	writeFileSync(join(precedence, LAYOUT.sessions, "cp-parent-control.json"), JSON.stringify({ model: m["p9h-saved"] }));
	assert.equal(await startWith(precedence, { model: m["p9h-env"] }), m["p9h-saved"], "absent a file model, the saved control model wins");
	parentJson(precedence, m["p9h-file"]!);
	assert.equal(await startWith(precedence, { model: m["p9h-env"] }), m["p9h-file"], "the file beats the saved and resolved models");
	assert.equal(await startWith(precedence, { model: m["p9h-explicit"], modelExplicit: true }), m["p9h-saved"], "an explicit start skips the file");
	parentJson(precedence, "not a model");
	assert.equal(await startWith(precedence, { model: m["p9h-env"] }), m["p9h-saved"], "an invalid file model is ignored");

	const bridge = f.bridge();
	await f.start(bridge, { model: m["p9h-env"] });
	const pid = bridge.status().pid;
	assert.deepEqual(await bridge.model(m["p9h-live"]!), { model: m["p9h-live"] });
	assert.equal(bridge.status().pid, pid, "a model switch keeps the running parent");
	assert.equal(bridge.status().alive, true);
	assert.equal((await bridge.send("P9H on the live model")).reply, "P9H model reply.");
	assert.equal(f.provider.requests("p9h-live").length, 1, "the next turn runs on the switched model");
	parentJson(f.home, m["p9h-next"]!);
	await settled(bridge);
	await bridge.rotate();
	assert.equal(bridge.status().model, m["p9h-live"], "a live switch survives rotation over the file");
	await bridge.stop();
	assert.equal(control(f.home).model, m["p9h-live"]);
	rmSync(join(f.home, LAYOUT.data, "parent.json"));
	const next = f.bridge();
	await f.start(next, { model: m["p9h-env"] });
	assert.equal(next.status().model, m["p9h-live"], "the switch persisted for the next start");
	await next.stop();

	const rotating = f.newHome();
	mkdirSync(join(rotating, LAYOUT.data), { recursive: true });
	const rotator = f.bridge();
	await f.start(rotator, { home: rotating, model: m["p9h-env"] });
	const turn = async (text: string) => { await rotator.send(text); await settled(rotator); };
	await turn("P9H before the first rotation");
	parentJson(rotating, m["p9h-next"]!);
	const first = await rotator.rotate();
	assert.equal(rotator.status().model, m["p9h-next"], "rotation applies the configured model");
	assert.equal(control(rotating).model, m["p9h-next"]);
	assert.deepEqual(f.relays.filter((relay) => relay.kind === "error"), []);
	await turn("P9H before the second rotation");
	parentJson(rotating, "mock/p9h-missing");
	const second = await rotator.rotate();
	assert.notEqual(second.sessionFile, first.sessionFile, "the rotation itself completed");
	assert.equal(rotator.status().model, m["p9h-next"], "a refused switch keeps the running model");
	assert.equal(control(rotating).model, m["p9h-next"]);
	const errors = f.relays.filter((relay) => relay.kind === "error");
	assert.equal(errors.length, 1, JSON.stringify(errors));
	assert.match(errors[0]!.text, new RegExp(`^parent rotate kept ${m["p9h-next"]}: set_model mock/p9h-missing rejected: `));
	assert.equal((await rotator.send("P9H after a refused switch")).reply, "P9H model reply.");
	await rotator.stop();

	const explicit = f.newHome();
	mkdirSync(join(explicit, LAYOUT.data), { recursive: true });
	parentJson(explicit, m["p9h-file"]!);
	const pinned = f.bridge();
	await f.start(pinned, { home: explicit, model: m["p9h-explicit"], modelExplicit: true });
	await pinned.send("P9H before the pinned rotation");
	await settled(pinned);
	await pinned.rotate();
	assert.equal(pinned.status().model, m["p9h-explicit"], "an explicit start model survives rotation");
	assert.equal(control(explicit).model, m["p9h-explicit"]);
	await pinned.stop();

	// Thinking (dashboard Settings): rotation applies data/parent.json `thinking`, pi clamps max to the served high;
	// an explicit start level survives rotation. The models serve off..high, as reasoning models.
	const config = f.provider.modelsJson();
	for (const entry of Object.values(config.providers)) {
		for (const row of (entry as { models: Record<string, unknown>[] }).models) {
			row.reasoning = true;
			row.thinkingLevelMap = { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
		}
	}
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify(config));
	const effort = (name: string) => (f.provider.requests(name).at(-1)!.body as { reasoning_effort?: string }).reasoning_effort;
	const thinking = f.newHome();
	mkdirSync(join(thinking, LAYOUT.data), { recursive: true });
	const leveled = f.bridge();
	await f.start(leveled, { home: thinking, model: m["p9h-saved"] });
	await leveled.send("P9H before the thinking rotation");
	await settled(leveled);
	writeFileSync(join(thinking, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 100000, thinking: "max" }));
	const errorsBefore = f.relays.filter((relay) => relay.kind === "error").length;
	await leveled.rotate();
	await leveled.send("P9H after the thinking rotation");
	await settled(leveled);
	assert.equal(effort("p9h-saved"), "high", "rotation applied the file thinking, clamped to the served level");
	assert.equal(f.relays.filter((relay) => relay.kind === "error").length, errorsBefore, "a clamp is no error");
	await leveled.stop();
	const lowStart = f.bridge();
	await f.start(lowStart, { home: thinking, model: m["p9h-saved"], thinking: "low" });
	await lowStart.send("P9H on the explicit level");
	await settled(lowStart);
	await lowStart.rotate();
	await lowStart.send("P9H after the explicit-level rotation");
	await settled(lowStart);
	assert.equal(effort("p9h-saved"), "low", "an explicit start thinking survives rotation over the file");
});

test("P9h-bridge-escalation: a refused cp_escalate is one error notice, never keyed by its call id; a retry in the same turn relays only the escalation", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const job = await createScratchLedger({ home: home.path, knownProjects: ["demo"] }).ledger.create({ title: "P9H question", project: "demo", kind: "research", delivery: "answer" });
	const ask = { job_ids: [job.id], kind: "product_ambiguity", question: "Ship this report?", options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], evidence_paths: [] };
	const refused = { name: "cp_escalate", args: { ...ask, recommended: "nope" } };
	const f = await fixture(t, { "p9h-escalation": [
		{ kind: "tool_calls", calls: [refused] }, { kind: "text", text: "P9H noted." },
		{ kind: "tool_calls", calls: [refused, { name: "cp_escalate", args: { ...ask, recommended: "hold" } }] }, { kind: "text", text: "P9H raised." },
	] }, undefined, home.path);
	const bridge = f.bridge();
	await f.start(bridge);
	await bridge.send("P9H raise it wrong");
	const errors = () => f.relays.filter((relay) => relay.kind === "error");
	const escalations = () => f.relays.filter((relay) => relay.kind === "escalation");
	await waitFor(errors, (rows) => rows.length > 0, { timeoutMs: 20_000, what: "the refusal notice" });
	assert.equal(errors().length, 1, JSON.stringify(f.relays));
	assert.deepEqual(escalations(), [], "a refused call raises nothing");
	assert.equal(f.relays.some((relay) => relay.escalationId?.startsWith("call")), false, "never keyed by the raw tool call id");
	await bridge.send("P9H raise it again");
	const stored = await waitFor(() => new EscalationStore({ home: f.home }).read().items, (items) => items.length === 1, { timeoutMs: 20_000, what: "the escalation stored" });
	await waitFor(escalations, (rows) => rows.length > 0, { timeoutMs: 20_000, what: "the escalation relay" });
	assert.deepEqual(escalations().map((relay) => [relay.escalationId, relay.jobId]), [[stored[0]!.id, job.id]], "one relay, by id");
	await settled(bridge);
	assert.equal(errors().length, 1, "the refused call beside a successful one adds no notice");
});

test("P9h-bridge-operator: the operator main session offers cp_parent and never a fleet tool", { timeout: 60_000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "cp-bridge-p9h-"));
	const rpc = startRpc({ cwd, args: [...operatorPiArgs(PACKAGE_ROOT), "--no-session"] });
	t.after(() => { rpc.close(); rmSync(cwd, { recursive: true, force: true }); });
	rpc.send({ id: "cmds", type: "get_commands" });
	const commands = await rpc.waitFor((record) => record.type === "response" && record.id === "cmds");
	const names = ((commands.data as { commands?: Array<{ name: string }> } | undefined)?.commands ?? []).map((command) => command.name);
	assert.ok(names.includes("cp-bridge"), names.join(","));
	assert.equal(names.includes("cp-version"), false);
	rpc.send({ id: "run", type: "prompt", message: "/cp-bridge" });
	const notify = await rpc.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string");
	const message = String(notify.message);
	assert.match(message, /cp_parent/);
	assert.equal(message.includes("cp_dispatch"), false);
	assert.equal(message.includes("cp_integrate"), false);
});
