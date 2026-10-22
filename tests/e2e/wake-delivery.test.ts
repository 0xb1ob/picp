import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EscalationRelayLedger, escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { EMPTY_USAGE, FAILURE_CLASSES, isoTimestamp, LAYOUT, type FleetRecord } from "../../src/contracts.ts";
import { join } from "node:path";
import { test } from "node:test";
import { attachParentHost, currentHost, parentHostPaths, type ParentHostClient } from "../../src/parent-host.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { FleetStore } from "../../src/fleet.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { CommandPost } from "../../src/command-post.ts";
import { checkWakeup, wakeupFacts } from "../../src/wakeups.ts";

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


test("wake S19: host escalation watch suppresses represented decisions, retries read failures and bounds write failures", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s19-watch-parent", [{ kind: "text", text: "Ready." }]);
	const agent = createAgentDir({ provider });
	const env = { ...agent.env, CP_HOST_ESCALATION_TICK_SECONDS: "1" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
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
	await new Promise((done) => setTimeout(done, 2_500));
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
	await new Promise((done) => setTimeout(done, 2_500));
	assert.equal(frames.length, 1, "failed outbox write must not reframe each tick");
	chmodSync(dirname(outbox.file), 0o700);
	await second.request("stop"); await second.closed;
	const delivered = JSON.parse(readFileSync(outbox.file, "utf8"));
	delivered.entries = [];
	writeFileSync(outbox.file, JSON.stringify(delivered));
	// Service-health is due at age 0; with the outbox emptied the backstop would send it as a second request.
	new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi")).note(immediate.id, "bridge");
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
	const record = (jobId: string, phase: "failed" | "done" | "waiting"): FleetRecord => ({
		job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase,
		branch: jobId, worktree: join(home.path, "missing"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: phase === "waiting" ? process.pid : 1, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() },
		failure: { class: "crash", message: "legacy crash", at: isoTimestamp() },
	});
	await fleet.add(record("cp-live", "failed"));
	await fleet.add(record("cp-finished", "done"));
	for (const resumable of [false, true]) {
		const jobId = resumable ? "cp-revivable" : "cp-unsalvageable";
		const dead = record(jobId, "waiting");
		dead.worker.pid = 2147483647;
		if (resumable) {
			dead.worker.session_file = join(home.path, "surviving-session.jsonl");
			writeFileSync(dead.worker.session_file, "");
		}
		await fleet.add(dead);
	}
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "previous-parent" });
	outbox.enqueue({ id: "death:cp-gone:1", kind: "death", job_id: "cp-gone", keys: ["crash"], content: "S21_OBSOLETE_DEATH" });
	outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" });
	const transportOwner = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
	t.after(() => transportOwner.shutdown());
	const facts = wakeupFacts({ record: (jobId) => fleet.get(jobId) });
	assert.throws(() => transportOwner.sweepDurableWakeups((entry) => {
		const verdict = checkWakeup({ kind: entry.kind, job_id: entry.job_id, keys: entry.keys, generation: entry.generation, issued_at: entry.queued_at }, facts);
		if (verdict.state === "superseded") return verdict.reason ?? "stale";
		writeFileSync(join(home.path, "absent-transport", "message"), entry.content);
		return true;
	}), /ENOENT/);
	assert.deepEqual(outbox.pending().map((entry) => entry.id), ["death:cp-live:1"]);
	assert.equal(outbox.read().discarded?.[0]?.id, "death:cp-gone:1");
	outbox.enqueue({ id: "recovery:finished", kind: "recovery", keys: ["cp-finished", "cp-gone"], content: "S21_OBSOLETE_RECOVERY" });
	for (const kind of ["death", "bound"] as const) {
		const jobId = `cp-waiting-${kind}`;
		await fleet.add(record(jobId, "waiting"));
		outbox.enqueue({ id: `${kind}:${jobId}:1`, kind, job_id: jobId, generation: 1, keys: [kind === "death" ? "crash" : "tool_call_cap_exceeded"], content: `S21_OBSOLETE_waiting_${kind}` });
	}
	outbox.enqueue({ id: "recovery:mixed", kind: "recovery", keys: ["cp-live", "cp-finished"], content: "S21_MIXED_RECOVERY" });
	assert.equal(outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" }), false);
	outbox.drain(() => {});
	assert.equal(outbox.pending().length, 5, "transport handoff cannot confirm delivery");
	const launch = () => {
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		children.push(child);
		return child;
	};
	const first = launch();
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 10_000, what: "replayed death reaching the model" });
	await waitFor(() => outbox.read().delivered, (rows) => rows.some((row) => row.id === "death:cp-live:1") && rows.some((row) => row.id === "recovery:mixed"), { timeoutMs: 15_000, what: "observed death and mixed recovery arrivals" });
	await waitFor(() => outbox.pending().length, (n) => n === 0, { timeoutMs: 15_000, what: "startup reconciliation notice arrival" });
	const receivedText = () => JSON.stringify(provider.requests(script).map((r) =>
		(r.body.messages as Array<{ role: string }>).filter((message) => message.role !== "system")));
	await waitFor(() => receivedText().includes("RESTART RECOVERY"), Boolean,
		{ timeoutMs: 15_000, what: "reconciliation reaching the mock model" });
	const text = receivedText();
	assert.match(text, /S21_LIVE_DEATH/);
	assert.match(text, /S21_MIXED_RECOVERY/);
	assert.match(text, /RESTART RECOVERY/);
	assert.match(text, /cp-unsalvageable/);
	assert.match(text, /cp-revivable/);
	assert.match(text, /cp_revive/);
	assert.match(text, /cp_teardown/);
	assert.doesNotMatch(text, /poll/i);
	assert.equal(outbox.read().delivered.filter((row) => row.id.startsWith("recovery:cp-")).length, 1);
	assert.doesNotMatch(text, /S21_OBSOLETE/);
	assert.deepEqual(outbox.pending(), []);
	assert.equal(outbox.read().discarded?.length, 4, "obsolete notices are terminally discarded");
	await first.close();
	const before = provider.requests(script).length;
	const second = launch();
	second.send({ id: "ready", type: "get_commands" });
	await second.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
	await second.prompt("S21 restart inspection");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "restart inspection turn" });
	const restartText = JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages));
	assert.doesNotMatch(restartText, /S21_LIVE_DEATH|S21_OBSOLETE/);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.wakeupsFile), "utf8")).delivered.filter((row: { id: string }) => row.id === "death:cp-live:1").length, 1);
});


test("S21: host failure events survive restart with distinct CI causes and one arrival per class", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "s21-host-failures";
	const model = provider.addScript(script, [{ kind: "text", text: "Failure events received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	const post = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
	t.after(async () => {
		for (const child of children) await child.close();
		await post.shutdown();
		agent.cleanup();
		home.cleanup();
		await provider.stop();
	});
	for (const cls of FAILURE_CLASSES) {
		const jobId = `cp-${cls.replaceAll("_", "-")}`;
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "waiting",
			branch: jobId, worktree: join(home.path, jobId), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: 2147483647, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() } });
		if (cls === "spawn_failed") {
			// A legacy pre-event exit is replayed through the real close observer's event entry point.
			post.runs.open(jobId).cp("spawned", {});
			post.runs.open(jobId).cp("process_exit", { code: 2 });
			assert.equal((await post.failures.evaluate(jobId))?.class, cls);
		} else await post.fail(jobId, { class: cls, message: `S21_FAILURE_${cls}`, at: isoTimestamp() });
	}
	const prefix = "watch cause ".repeat(20);
	post.ciWatchFailed(new Error(`${prefix}HTTP 403`));
	post.ciWatchFailed(new Error(`${prefix}HTTP 502`));
	const pending = post.durableWakeups.pending();
	assert.equal(pending.length, FAILURE_CLASSES.length + 2);
	assert.equal(new Set(pending.map((entry) => entry.id)).size, pending.length);
	assert.ok(pending.every((entry) => entry.id.length <= 160));
	assert.ok(pending.some((entry) => entry.id.includes("HTTP 403")));
	assert.ok(pending.some((entry) => entry.id.includes("HTTP 502")));
	await post.shutdown();
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "observer" });
	const first = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(first);
	await waitFor(() => outbox.read().delivered.length, (n) => n === pending.length, { timeoutMs: 30_000, what: "every failure event arriving after restart" });
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 15_000, what: "failure consumer request" });
	const text = JSON.stringify(provider.requests(script).map((r) => (r.body.messages as Array<{ role: string }>).filter((message) => message.role !== "system")));
	for (const cls of FAILURE_CLASSES) {
		const queued = pending.find((entry) => entry.job_id === `cp-${cls.replaceAll("_", "-")}`);
		const row = outbox.read().delivered.find((entry) => entry.id === queued?.id);
		assert.ok(row, `${cls} has one durable arrival`);
		assert.equal(queued?.kind, cls === "wall_clock_exceeded" || cls === "tool_call_cap_exceeded" ? "bound" : "death");
		assert.match(text, new RegExp(cls === "spawn_failed" ? "spawn_failed" : `S21_FAILURE_${cls}`));
	}
	assert.match(text, /on disk:/);
	assert.match(text, /cp_teardown/);
	assert.doesNotMatch(text, /poll/i);
	assert.deepEqual(outbox.pending(), []);
	await first.close();
	const before = provider.requests(script).length;
	const second = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(second);
	await second.prompt("Inspect the restarted parent.");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "second host inspection" });
	assert.doesNotMatch(JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages)), /S21_FAILURE_/);
});


test("S21: forty failed reconcile candidates retain distinct bounded notices through RPC restart", { timeout: 110_000 }, async (t) => {
	const provider = await MockProvider.start();
	const script = "s21-long-recovery";
	const model = provider.addScript(script, [{ kind: "text", text: "Recovery inventory received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const ids: string[] = [];
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => { for (const close of cleanup) await close(); agent.cleanup(); await provider.stop(); });
	for (const variant of ["a", "b"]) {
		const home = createScratchHome();
		const post = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
		let child: ReturnType<typeof startPiChild> | undefined;
		cleanup.push(async () => { await child?.close(); await post.shutdown(); home.cleanup(); });
		for (let i = 0; i < 40; i++) {
			const jobId = `cp-recovery-${String(i).padStart(2, "0")}-${"x".repeat(35)}${i === 39 ? variant : ""}`;
			await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "waiting",
				branch: jobId, worktree: join(home.path, jobId), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
				worker: { pid: 2147483647, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() } });
		}
		const { report } = await post.reconcile();
		assert.equal(report.entries.filter((entry) => entry.outcome === "failed").length, 40);
		assert.equal(post.fleet.list().filter((record) => record.phase === "failed").length, 40);
		const pending = post.durableWakeups.pending();
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.kind, "recovery");
		assert.equal(pending[0]?.keys?.length, 40);
		assert.ok((pending[0]?.id.length ?? Infinity) <= 160);
		assert.ok((pending[0]?.content.length ?? Infinity) <= 4000);
		assert.match(pending[0]?.content ?? "", /RESTART RECOVERY — 40 candidate/);
		assert.match(pending[0]?.content ?? "", /\.\.\.and \d+ more/);
		ids.push(pending[0]?.id ?? "");
		await post.shutdown();
		const before = provider.requests(script).length;
		child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		await waitFor(() => JSON.stringify(provider.requests(script).slice(before).map((request) => request.body.messages)).includes("RESTART RECOVERY — 40 candidate"), Boolean,
			{ timeoutMs: 20_000, what: "bounded forty-candidate notice reaching the real parent" });
		await waitFor(() => post.durableWakeups.read().delivered.some((entry) => entry.id === pending[0]?.id), Boolean,
			{ timeoutMs: 15_000, what: "long recovery arrival confirmation" });
		await child.close();
	}
	assert.notEqual(ids[0], ids[1], "sets sharing their first 39 candidates retain distinct durable IDs");
});
