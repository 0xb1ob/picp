import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CpBridge } from "../../src/cp-bridge.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { FleetStore } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type ScriptStep, waitFor } from "../harness/index.ts";

async function fixture(t: TestContext, steps: ScriptStep[], raw?: string, timeout = 30_000) {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	if (raw !== undefined) writeFileSync(join(home.path, LAYOUT.data, "parent.json"), raw);
	const provider = await MockProvider.start();
	const model = provider.addScript("s25-parent", steps, { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const previous = { ...process.env };
	Object.assign(process.env, agent.env);
	const bridge = new CpBridge();
	t.after(async () => {
		await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	return { home: home.path, bridge, provider,
		start: () => bridge.start({ home: home.path, mode: "multi", model, cwd: home.path, commandPostExtension: COMMAND_POST_EXTENSION, requestTimeoutMs: timeout }),
		input: () => JSON.stringify(provider.requests("s25-parent").at(-1)?.body),
	};
}

for (const [index, raw, expected] of [[0, undefined, 200000], [1, '{"compact_at_tokens":150000}', 150000], [2, '{}', undefined]] as const) {
	test(`S25 parent: settings ${index} reach bridge status`, { timeout: 60_000 }, async (t) => {
		const f = await fixture(t, [{ kind: "text", text: "Ready." }], raw);
		await f.start();
		assert.equal(f.bridge.status().compactAtTokens, expected);
	});
}

test("S25 parent: compaction carries disk decisions and unsettled sends without operator text", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Initial work finished." }, { kind: "text", text: "Summary." }, { kind: "text", text: "Continued." }], '{}');
	await f.start();
	await f.bridge.send("Begin work.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => ["settled", "failed", "undeliverable"].includes(send.state)), { timeoutMs: 10_000, what: "parent send settled" });
	await f.bridge.statusWithContext();
	const mandate = new MandateStore(f.home).issue({ projects: ["demo"], objective: "ship", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 100000 }, job_cap: 5 });
	const escalation = await new EscalationStore({ home: f.home }).raise({ job_ids: ["cp-held-s25"], kind: "product_ambiguity", question: "Which option?", options: [{ id: "keep", label: "Keep", consequence: "Proceed", cost: "none" }, { id: "stop", label: "Stop", consequence: "Stop", cost: "none" }], recommended: "keep", evidence_paths: [] });
	await new FleetStore({ home: f.home }).add({ job_id: "cp-held-s25", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, branch: "cp-held-s25", worktree: f.home, worker: { pid: 1, session_id: "fixture", session_file: join(f.home, "worker.jsonl"), profile: "implementer", role: "implementer", model: "mock/worker", started_at: isoTimestamp() } });
	await f.bridge.compact("S25 preserve review rationale.");
	const input = f.input();
	for (const id of [mandate.id, escalation.id, "cp-held-s25"]) assert.ok(input.includes(id), id);
	assert.match(input, /S25 preserve review rationale/);
});

test("S25 parent: manual compact excludes drain until completion and cancel remains available", { timeout: 90_000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture(t, [{ kind: "text", text: "Initial." }, { kind: "hang", until: gate }], '{}');
	await f.start(); await f.bridge.send("Begin.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => ["settled", "failed", "undeliverable"].includes(send.state)), { timeoutMs: 10_000, what: "parent send settled" });
	await f.bridge.statusWithContext();
	const compact = f.bridge.compact();
	t.after(() => release());
	await waitFor(() => f.provider.requests("s25-parent").length, (count) => count === 2, { timeoutMs: 10_000, what: "summarizer entered" });
	for (const seconds of [undefined, 30]) await assert.rejects(f.bridge.drain(seconds), /no drain starts until it settles/);
	await f.bridge.drainCancel().catch((error: Error) => assert.doesNotMatch(error.message, /no drain starts until it settles/));
	release();
	await compact;
});


test("S25 parent: start, compact and resume deliver current hidden guidance once", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Initial work." }, { kind: "text", text: "Summary." }, { kind: "text", text: "Continued." }], '{}');
	const orders = join(f.home, LAYOUT.data, "standing-orders.md");
	const memory = join(f.home, LAYOUT.learningsFile);
	writeFileSync(orders, "# Standing orders\n\nS25 original order.\n");
	writeFileSync(memory, "# Learnings\n\n- S25 original memory. <!--P-->\n");
	await f.start();
	assert.equal(f.provider.requests("s25-parent").length, 0, "guidance starts no model turn");
	await f.bridge.send("Begin.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "initial send settled" });
	await f.bridge.statusWithContext();
	assert.match(f.input(), /S25 original order/);
	assert.match(f.input(), /S25 original memory/);
	writeFileSync(orders, "# Standing orders\n\nS25 refreshed order.\n");
	writeFileSync(memory, "# Learnings\n\n- S25 refreshed memory. <!--P-->\n");
	await f.bridge.compact();
	await f.bridge.send("Continue.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "continued send settled" });
	for (const text of ["S25 refreshed order.", "S25 refreshed memory.", "Parent only: Put independent tool calls"]) assert.equal(f.input().split(text).length - 1, 1, text);
	assert.match(f.input(), /15 model rounds/);
	await f.bridge.stop();
	await f.start();
	await f.bridge.send("Resume.");
	for (const text of ["S25 refreshed order.", "S25 refreshed memory.", "Parent only: Put independent tool calls"]) assert.equal(f.input().split(text).length - 1, 1, `resume ${text}`);
});


for (const [tag, summary, outcome] of [
	["success", { kind: "text", text: "Automatic summary." }, "compacted"],
	["failure", { kind: "error", status: 400, message: "S25 summarizer rejected" }, "failed"],
	["timeout", { kind: "hang", ms: 7000 }, "timed_out"],
] as const) {
	test(`S25 parent: automatic ${tag} reaches the daemon log and error relay`, { timeout: 60_000 }, async (t) => {
		const f = await fixture(t, [{ kind: "text", text: "S25 finished work.", usage: { prompt_tokens: 205000 } }, summary], '{"compact_at_tokens":200000}', tag === "timeout" ? 5000 : 30000);
		const relays: string[] = [];
		f.bridge.onRelay((relay) => relays.push(relay.text));
		await f.start();
		await f.bridge.send("Begin automatic control.");
		const log = join(f.home, LAYOUT.state, "daemon.log");
		await waitFor(() => { try { return readFileSync(log, "utf8"); } catch { return ""; } }, (text) => text.includes(`parent context ${outcome}`), { timeoutMs: 15_000, what: `automatic ${outcome}` });
		assert.match(readFileSync(log, "utf8"), /raw=2050\d+ effective=2050\d+ threshold=200000/);
		if (tag === "timeout") assert.ok(relays.some((text) => /timed out:.*retry the compaction once the parent has settled.*rotation or restart can abort running workers/.test(text)));
		if (tag === "failure") assert.ok(relays.some((text) => /parent automatic context control failed:/.test(text)));
	});
}

test("S25 parent: revoking the newest mandate rotates once with its true trigger", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Work finished.", usage: { prompt_tokens: 1000 } }], '{}');
	await f.start();
	const store = new MandateStore(f.home);
	const grant = store.issue({ projects: ["demo"], objective: "ship", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 1, tokens: 1000 }, job_cap: 1 });
	store.revoke(grant.id, { by: "parent" });
	await f.bridge.send("Finish the mission.");
	const log = join(f.home, LAYOUT.state, "daemon.log");
	await waitFor(() => { try { return readFileSync(log, "utf8"); } catch { return ""; } }, (text) => text.includes(`rotated mission=${grant.id}`), { timeoutMs: 15_000, what: "mission rotation" });
	assert.match(readFileSync(log, "utf8"), /trigger="revoked by parent"/);
	await f.bridge.send("Continue after rotation.");
	assert.equal(readFileSync(log, "utf8").split(`rotated mission=${grant.id}`).length - 1, 1);
});
