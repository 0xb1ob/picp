import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EscalationRelayLedger, escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { isoTimestamp } from "../../src/contracts.ts";
import { join } from "node:path";
import { test } from "node:test";
import { attachParentHost, currentHost, parentHostPaths, type ParentHostClient } from "../../src/parent-host.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";

test("wake S19: a real operator reconnects read-only and delivers a gap escalation once", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const parentModel = provider.addScript("s19-parent", [{ kind: "hang", ms: 3_000 }, { kind: "hang", ms: 3_000 }]);
	const operatorModel = provider.addScript("s19-operator", [
		{ kind: "text", text: "Unseen send received." },
		{ kind: "text", text: "Live send received." },
		{ kind: "text", text: "Live escalation received." },
		{ kind: "text", text: "Gap escalation received." },
	]);
	const agent = createAgentDir({ provider });
	const env = { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const hosts: ParentHostClient[] = [];
	let operator: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => {
		await operator?.close();
		for (const host of hosts) {
			await host.request("stop", undefined, 5_000).catch(() => undefined);
			host.disconnect();
		}
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		agent.cleanup();
		await provider.stop();
		home.cleanup();
	});
	const start = async () => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
		hosts.push(host);
		const started = await host.request("start", { home: home.path, mode: "multi", model: parentModel, modelExplicit: true }) as { pid?: number };
		host.parentPid = started.pid;
		return host;
	};
	const first = await start();
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(join(home.path, ".pi-command-post", "state")));
	await first.onRelay(() => {});
	const send = async (text: string) => {
		const result = await first.request("send", text, 100) as { send_id?: string; pending?: string };
		const id = result.send_id ?? result.pending;
		assert.ok(id, JSON.stringify(result));
		await waitFor(() => outbox.read().entries, (entries) => entries.some((entry) => entry.relay.sendId === id),
			{ timeoutMs: 30_000, what: "real parent send outcome persists" });
		return id;
	};
	const unseenId = await send("Acknowledge the unseen S19 send.");
	operator = startPiChild({ cwd: home.path, model: operatorModel, env, extensions: [CP_BRIDGE_EXTENSION] });
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 1,
		{ timeoutMs: 30_000, what: "unseen real send outcome delivered at attach" });
	await operator.waitForSettled();
	assert.ok(JSON.stringify(provider.requests("s19-operator")[0]!.body).includes(unseenId));
	const seenId = await send("Acknowledge the live S19 send.");
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 2,
		{ timeoutMs: 30_000, what: "live real send outcome delivered" });
	await operator.waitForSettled();
	assert.ok(JSON.stringify(provider.requests("s19-operator")[1]!.body).includes(seenId));
	const liveStore = new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 11_000) });
	const live = await liveStore.raise({ job_ids: ["cp-s19-live"], kind: "product_ambiguity", question: "Live S19 decision",
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [] });
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 3,
		{ timeoutMs: 30_000, what: "live escalation delivered before reconnect" });
	await operator.waitForSettled();
	assert.ok(JSON.stringify(provider.requests("s19-operator")[2]!.body).includes(live.id));
	const status = () => operator!.stderr() + JSON.stringify(operator!.records());
	await waitFor(status, (text) => text.includes("cp-parent: attached"), { timeoutMs: 30_000, what: "initial bridge attachment" });
	const paths = parentHostPaths(home.path, "multi");
	const generation = currentHost(paths).gen;
	process.kill(first.hostPid, "SIGKILL");
	if (first.parentPid) { try { process.kill(first.parentPid, "SIGTERM"); } catch {} }
	await first.closed;
	await waitFor(status, (text) => text.includes("host connection closed"), { timeoutMs: 30_000, what: "bridge detects host close" });
	await new Promise((done) => setTimeout(done, 2_000));
	assert.equal(currentHost(paths).gen, generation, "read-only retries must not create a host");
	const raised = await new EscalationStore({ home: home.path }).raise({
		job_ids: ["cp-s19-gap"], kind: "product_ambiguity", question: "Choose the S19 gap outcome",
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [],
	});
	const second = await start();
	await waitFor(status, (text) => text.includes(`reattached (pid ${second.hostPid})`), { timeoutMs: 45_000, what: "bridge reattaches to replacement host" });
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 4, { timeoutMs: 45_000, what: "gap escalation reaches real operator model" });
	const request = JSON.stringify(provider.requests("s19-operator")[3]!.body);
	assert.ok(request.includes(raised.id), "gap escalation id must reach operator context");
	assert.ok(request.includes("Choose the S19 gap outcome"), "gap escalation question must reach operator context");
	await operator.waitForSettled();
	await new Promise((done) => setTimeout(done, 12_000));
	assert.equal(provider.requests("s19-operator").length, 4, "replay and host watch must not deliver sends or escalations twice");
	assert.equal(currentHost(paths).gen, generation + 1, "bridge must not spawn extra generations");
	assert.ok(outbox.read().entries.filter((entry) => entry.id.startsWith(`esc:${raised.id}`)).length <= 1);
	assert.equal(provider.remaining("s19-operator"), 0);
	assert.equal(provider.remaining("s19-parent"), 0);
});


test("wake S19: host escalation watch suppresses represented decisions, retries read failures and bounds write failures", { timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s19-watch-parent", [{ kind: "text", text: "Ready." }]);
	const agent = createAgentDir({ provider });
	const previous = Object.fromEntries(Object.keys(agent.env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, agent.env);
	const hosts: ParentHostClient[] = [];
	let backstopOperator: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => {
		chmodSync(parentHostPaths(home.path, "multi").dir, 0o700);
		await backstopOperator?.close();
		for (const host of hosts) { await host.request("stop", undefined, 5_000).catch(() => undefined); host.disconnect(); }
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const paths = parentHostPaths(home.path, "multi");
	const store = new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 60_000) });
	const raise = (question: string) => store.raise({ job_ids: ["cp-s19-watch"], kind: "product_ambiguity", question,
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [] });
	const ordinary = await raise("Deliver the unrepresented decision");
	const represented = await raise("Already represented by an operator ask");
	const ledgered = await raise("Already delivered to a session");
	const boxed = await raise("Already present under a suffixed outbox id");
	const asks = new OperatorAsks(join(paths.dir, "operator", "asks.jsonl"));
	asks.open({ project: "demo", question: represented.question, source_escalation: represented.id,
		options: [{ label: "Hold", consequence: "Wait" }], recommendation: "Hold" });
	new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi")).note(ledgered.id, "bridge");
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(paths.dir));
	outbox.enqueue({ kind: "escalation", escalationId: boxed.id, jobId: "cp-s19-watch", stale: false,
		text: boxed.question, receipt: { level: null, reached: [] }, paths: [] }, "seed");
	const seeded = JSON.parse(readFileSync(outbox.file, "utf8"));
	seeded.entries[0].id += "#2";
	writeFileSync(outbox.file, JSON.stringify(seeded));
	const start = async () => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 }); hosts.push(host);
		await host.request("start", { home: home.path, mode: "multi", model, modelExplicit: true }); return host;
	};
	const first = await start();
	const entries = () => outbox.read().entries;
	await waitFor(entries, (items) => items.some((item) => item.id === `esc:${ordinary.id}`), { timeoutMs: 30_000, what: "host directly relays code-raised escalation" });
	const freshStore = new EscalationStore({ home: home.path });
	const freshInput = { job_ids: ["cp-s19-watch"], kind: "product_ambiguity" as const, question: "Fresh grace decision",
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [],
		at: isoTimestamp(new Date(Date.now() + 5_000)) };
	const fresh = await freshStore.raise(freshInput);
	const immediate = await freshStore.raise({ ...freshInput, kind: "service_health", question: "Immediate service decision" });
	await waitFor(entries, (items) => items.some((item) => item.relay.escalationId === immediate.id), { timeoutMs: 15_000, what: "service health bypasses the grace" });
	assert.equal(entries().some((item) => item.relay.escalationId === fresh.id), false, "fresh ordinary escalation stays inside grace");
	await waitFor(entries, (items) => items.some((item) => item.relay.escalationId === fresh.id), { timeoutMs: 15_000, what: "ordinary escalation leaves grace" });
	const relay = entries().find((item) => item.id === `esc:${ordinary.id}`)!.relay;
	assert.equal(relay.kind, "escalation"); assert.equal(relay.escalationId, ordinary.id); assert.equal(relay.jobId, "cp-s19-watch");
	assert.match(relay.text, new RegExp(`^\\[.*\\] ${ordinary.id} \\(product_ambiguity\\) — Deliver the unrepresented decision$`));
	assert.equal(entries().some((item) => item.relay.escalationId === represented.id), false, "open ask suppresses relay");
	assert.equal(entries().some((item) => item.relay.escalationId === ledgered.id), false, "session ledger suppresses relay");
	await first.request("stop"); await first.closed;
	const second = await start();
	const restartedFrames: string[] = [];
	await second.onRelay((relay) => { if (relay.escalationId) restartedFrames.push(relay.escalationId); });
	await new Promise((done) => setTimeout(done, 12_000));
	assert.equal(entries().filter((item) => item.relay.escalationId === ordinary.id).length, 1, "restart must not duplicate an outbox relay");
	assert.equal(entries().filter((item) => item.relay.escalationId === boxed.id).length, 1, "existing outbox id suppresses relay");
	assert.equal(restartedFrames.includes(ordinary.id), false, "restart must not reframe an existing outbox relay");
	assert.equal(restartedFrames.includes(boxed.id), false, "existing outbox id must suppress host frames");
	const failed = await raise("Read faults must be logged then recover");
	for (const file of [store.file, escalationRelayLedgerFile(home.path, "multi"), outbox.file]) {
		const saved = readFileSync(file, "utf8");
		const before = readFileSync(paths.log, "utf8").length;
		writeFileSync(file, "{");
		await waitFor(() => readFileSync(paths.log, "utf8").slice(before), (text) => text.includes("escalation relay watch failed"), { timeoutMs: 25_000, what: `visible read failure for ${file}` });
		writeFileSync(file, saved);
	}
	await waitFor(entries, (items) => items.some((item) => item.relay.escalationId === failed.id), { timeoutMs: 25_000, what: "watch recovers after corrupt reads" });
	const writeFailed = await raise("A refused outbox write is framed only once");
	const frames: string[] = [];
	await second.onRelay((relay) => { if (relay.escalationId === writeFailed.id) frames.push(relay.text); });
	chmodSync(dirname(outbox.file), 0o500);
	await waitFor(() => readFileSync(paths.log, "utf8"), (text) => text.includes("relay outbox write failed"), { timeoutMs: 25_000, what: "visible outbox write failure" });
	await new Promise((done) => setTimeout(done, 12_000));
	assert.equal(frames.length, 1, "failed outbox write must not reframe each tick");
	chmodSync(dirname(outbox.file), 0o700);
	await second.request("stop"); await second.closed;
	const delivered = JSON.parse(readFileSync(outbox.file, "utf8"));
	delivered.entries = [];
	writeFileSync(outbox.file, JSON.stringify(delivered));
	const ancient = await freshStore.raise({ ...freshInput, question: "An undelivered decision still needs the backstop", at: isoTimestamp(new Date(Date.now() - 601_000)) });
	const backstopModel = provider.addScript("s19-backstop-operator", [{ kind: "text", text: "Backstop received." }]);
	agent.writeModels(provider);
	backstopOperator = startPiChild({ cwd: home.path, model: backstopModel,
		env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
	await waitFor(() => provider.requests("s19-backstop-operator"), (requests) => requests.length === 1,
		{ timeoutMs: 30_000, what: "undelivered escalation reaches the real operator backstop" });
	assert.ok(JSON.stringify(provider.requests("s19-backstop-operator")[0]!.body).includes(ancient.id));
	assert.ok(JSON.stringify(provider.requests("s19-backstop-operator")[0]!.body).includes("has been open"));
	await backstopOperator.waitForSettled();
	assert.equal(provider.remaining("s19-backstop-operator"), 0);
});
