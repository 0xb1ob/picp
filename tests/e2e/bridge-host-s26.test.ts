import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { operatorRelayAcksFile, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { attachParentHost, currentHost, parentHostPaths } from "../../src/parent-host.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { stopParentHosts } from "../harness/parent-hosts.ts";

test("S26: real parent diagnostics and read-only bridge attachment deliver backlog once and suppress escalation replay", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const ledger = createScratchLedger({ home: home.path, knownProjects: ["demo"] }).ledger;
	const job = await ledger.create({ title: "Bridge escalation", project: "demo", kind: "research", delivery: "answer" });
	const parentModel = provider.addScript("s26-host-parent", [
		{ kind: "tool_calls", calls: [{ name: "cp_escalate", args: { job_ids: [job.id], kind: "product_ambiguity", question: "Ship this report?", options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [] } }] },
		{ kind: "text", text: "Question recorded." },
	], { onExhausted: "repeat" });
	const operatorModel = provider.addScript("s26-host-operator", [{ kind: "text", text: "Parent messages acknowledged." }], { onExhausted: "repeat" });
	agent.writeModels(provider);
	const env = { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		await stopParentHosts(home.path);
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const paths = parentHostPaths(home.path, "multi");
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 30_000 });
	t.after(() => host.disconnect());
	await host.request("start", { home: home.path, mode: "multi", model: parentModel, requestTimeoutMs: 15_000 });
	const version = await host.request("version") as { text: string; level: string };
	assert.match(version.text, /^picp /);
	const drain = await host.request("drain", 7) as { text: string; level: string };
	assert.equal(drain.level, "info");
	assert.match(drain.text, /^DRAIN: drained: safe to restart/);
	const cancel = await host.request("drainCancel") as { text: string; level: string };
	assert.equal(cancel.level, "error");
	assert.match(cancel.text, /this parent drained/);
	await host.request("send", "Raise the product question.");
	host.disconnect();
	await host.closed;
	const store = new EscalationStore({ home: home.path });
	const escalation = await waitFor(() => store.read().items[0], Boolean, { timeoutMs: 20_000, what: "real cp_escalate outcome" });
	assert.ok(escalation);
	const generation = currentHost(paths).gen;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const warm = startPiChild({ cwd: home.path, model: operatorModel, env, sessionDir: join(home.path, "sessions") });
	children.push(warm);
	await warm.prompt("Start an operator conversation.");
	await warm.waitForSettled(20_000);
	const template = readFileSync(String((await warm.getState()).sessionFile), "utf8");
	await warm.close();
	let sequence = 0;
	const start = async () => {
		const sessionFile = join(home.path, `operator-${++sequence}.jsonl`);
		writeFileSync(sessionFile, template);
		const child = startPiChild({ cwd: home.path, model: operatorModel, sessionFile, env, extensions: [CP_BRIDGE_EXTENSION] });
		children.push(child);
		await child.prompt("Acknowledge pending parent messages.");
		await child.waitForSettled(20_000);
		return child;
	};
	const first = await start();
	await first.waitFor((r) => r.type === "message_start" && JSON.stringify(r).includes(`[cp-bridge escalation`) && JSON.stringify(r).includes(`id=${escalation.id}`), 20_000);
	assert.equal(currentHost(paths).gen, generation, "session_start attaches without spawning a successor host");
	assert.ok(JSON.stringify(first.records()).includes(`cp-parent: attached (host pid ${currentHost(paths).record!.pid}`), "session_start reports its read-only attachment without a cp_parent tool call");
	const relayFile = escalationRelayLedgerFile(home.path, "multi");
	await first.close();
	// Legacy homes have only the bridge ledger, before durable operator relay acknowledgments existed.
	rmSync(operatorRelayAcksFile(join(home.path, LAYOUT.state)), { force: true });
	rmSync(operatorRelayOutboxFile(join(home.path, LAYOUT.state)), { force: true });
	const aged = store.read();
	aged.items[0]!.created_at = isoTimestamp(new Date(Date.now() - 11 * 60_000));
	writeFileSync(store.file, JSON.stringify(aged));
	const second = await start();
	assert.equal(second.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes(`id=${escalation.id}`)).length, 0);
	assert.ok(JSON.parse(readFileSync(relayFile, "utf8")).items.some((item: { id: string; via: string }) => item.id === escalation.id && item.via === "bridge"));
	await second.close();
	rmSync(relayFile);
	const third = await start();
	const backstop = third.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes(`id=${escalation.id}`));
	assert.equal(backstop.length, 1);
	assert.match(JSON.stringify(backstop[0]), /never relayed to this session/);
});


test("S26: a real operator starts from no host, refreshes attached status after cp_parent start and clears it on stop", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const parentModel = provider.addScript("s26-status-parent", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const model = provider.addScript("s26-status-operator", [
		{ kind: "text", text: "Ready to manage the parent." },
		{ kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "start", home: home.path, mode: "multi", model: parentModel } }] },
		{ kind: "text", text: "Parent started." },
		{ kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "stop" } }] },
		{ kind: "text", text: "Parent stopped." },
	]);
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
	const status = () => child.stderr() + JSON.stringify(child.records().filter((r) => r.type === "extension_ui_request"));
	t.after(async () => { await child.close(); await stopParentHosts(home.path); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("Prepare to manage the parent.");
	await child.waitForSettled(20_000);
	await waitFor(status, (text) => text.includes("cp-parent: not attached"), { timeoutMs: 20_000, what: "read-only startup status with no host" });
	const paths = parentHostPaths(home.path, "multi");
	assert.equal(currentHost(paths).gen, 0, "session_start did not spawn a host");
	const beforeStart = child.records().length;
	await child.prompt("Start the parent.");
	const started = await child.waitFor((r) => r.type === "tool_execution_end" && r.toolName === "cp_parent", 30_000);
	await child.waitFor((r) => child.records().indexOf(r) >= beforeStart && r.type === "agent_settled", 20_000);
	const pid = /started pid=(\d+)/.exec(JSON.stringify(started.result))?.[1];
	assert.ok(pid, JSON.stringify(started.result));
	const hostPid = currentHost(paths).record!.pid;
	assert.ok(status().includes(`cp-parent: attached (host pid ${hostPid}, parent pid ${pid})`), status());
	const before = status().length;
	const beforeStop = child.records().length;
	await child.prompt("Stop the parent.");
	const stopped = await child.waitFor((r) => child.records().indexOf(r) >= beforeStop && r.type === "tool_execution_end" && r.toolName === "cp_parent", 25_000);
	assert.match(JSON.stringify(stopped.result), /stopped/, JSON.stringify(stopped.result));
	await child.waitFor((r) => child.records().indexOf(r) >= beforeStop && r.type === "agent_settled", 20_000);
	await waitFor(() => status().slice(before), (text) => text.includes("cp-parent: not attached"), { timeoutMs: 15_000, what: "stop clears attached status" });
	assert.equal(provider.remaining("s26-status-operator"), 0);
});
