/** P9f: the operator's relay consumer, driven through the real cp-bridge in an RPC operator over a seeded home. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import type { BridgeRelay } from "../../src/cp-bridge.ts";
import { type DrainRecord, drainFile, formatDrain } from "../../src/drain.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { FleetStore } from "../../src/fleet.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { RELAY_COALESCE_MAX } from "../../src/operator-delivery.ts";
import { OperatorRelayAcks, OperatorRelayOutbox, operatorRelayAcksFile, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { CP_BRIDGE_EXTENSION, MockProvider, type RpcRecord, createAgentDir, createScratchHome, startPiChild, startRpc, waitFor } from "../harness/index.ts";

const receipt = { level: null, reached: [] };
const relay = (patch: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "wake", receipt, paths: [], ...patch });
const OPTIONS = [{ id: "approve", label: "approve", consequence: "proceed", cost: "none" }, { id: "decline", label: "decline", consequence: "hold", cost: "wait" }];
type Delivered = { content: string; details: { relay_ids: string[]; send_id?: string } };

/** Every cp-bridge message that entered the operator's context, in order. */
function delivered(records: readonly RpcRecord[]): Delivered[] {
	return records.filter((r) => r.type === "message_start" && (r.message as { customType?: string })?.customType === "cp-bridge")
		.map((r) => {
			const message = r.message as { content: unknown; details: Delivered["details"] };
			return { content: typeof message.content === "string" ? message.content : JSON.stringify(message.content), details: message.details };
		});
}

function operator(home: string, model: string, agentEnv: NodeJS.ProcessEnv) {
	return startRpc({ cwd: home, env: { ...agentEnv, PI_HOME: home, CP_HOME: home }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
}

function fleetRecord(overrides: Partial<FleetRecord>, at: string): FleetRecord {
	return {
		job_id: "cp-x", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting",
		worker: { pid: 4242, session_id: "abc", session_file: "/sessions/abc.jsonl", profile: "implementer", role: "implementer", model: "anthropic/claude-sonnet-5", started_at: at },
		worktree: "/wt/cp-x", branch: "cp-x", dispatched_at: at, usage: EMPTY_USAGE, ...overrides,
	};
}

test("P9f-relay-recheck: a seeded outbox is rechecked at delivery, retired with reasons, acked at context entry and never handed twice", { timeout: 150_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("p9f-recheck", [{ kind: "text", text: "Relays read." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false } } });
	const rpcs: ReturnType<typeof startRpc>[] = [];
	t.after(async () => { for (const rpc of rpcs) await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: home.path });
	const base = Date.now();
	const at = (seconds: number) => isoTimestamp(new Date(base + seconds * 1_000));
	const queued = at(-60);
	const state = join(home.path, LAYOUT.state);
	const outbox = (when: string) => new OperatorRelayOutbox(operatorRelayOutboxFile(state), () => new Date(when));
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));

	const store = new EscalationStore({ home: home.path });
	const raise = (question: string, job_ids: string[], raisedAt = at(-120)) => store.raise({ job_ids, kind: "product_ambiguity", question, options: OPTIONS, recommended: "approve", at: raisedAt });
	const incident = await raise("approve build?", ["cp-oc0m", "cp-qwn9"]);
	await store.answer(incident.id, { answer: "approve", by: "operator", at: at(-44) });
	const answered = await raise("answered before delivery?", ["cp-oc0m"]);
	await store.answer(answered.id, { answer: "approve", by: "operator", at: at(-30) });
	const open = await raise("still open?", ["cp-oc0m", "cp-qwn9"]);
	const early = await raise("answered before queued?", ["cp-oc0m", "cp-qwn9"]);
	await store.answer(early.id, { answer: "approve", by: "operator", at: at(-65) });
	const sameSecond = await raise("answered the second it was queued?", ["cp-oc0m"]);
	await store.answer(sameSecond.id, { answer: "approve", by: "operator", at: queued });
	const withdrawn = await raise("withdrawn?", ["cp-oc0m"]);
	await store.withdraw(withdrawn.id);
	const same = await raise("named by the send reply?", ["cp-oc0m"]);
	const overdue = await raise("overdue and named by the send reply?", ["cp-oc0m"], at(-660));
	const fleet = new FleetStore({ home: home.path });
	for (const job of [
		{ job_id: "cp-oc0m", phase: "done" as const }, { job_id: "cp-qwn9", dispatched_at: at(23) },
		{ job_id: "cp-zzzz", dispatched_at: at(-600) }, { job_id: "cp-dead", phase: "failed" as const, failure: { class: "crash" as const, message: "exit 1", at: at(-63) } },
		{ job_id: "cp-held", phase: "held" as const, reported_at: at(-63) },
	]) await fleet.add(fleetRecord(job, at(-600)));
	const drain = (started_at: string, survivor: string): DrainRecord => ({ state: "timeout", started_at, deadline: started_at, timeout_s: 5, survivors: [survivor], reported: true, jobs: [] });
	atomicWriteJson(drainFile(home.path), drain(queued, "cp-live-busy"));
	const sends = new ParentSendOutbox({ file: parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl")) });
	const observed = sends.enqueue("go");
	sends.markInjected([observed.id]);
	sends.markLanded([observed.id]);
	sends.settle(observed.id, { reply: "done" });
	sends.markObserved(observed.id);

	const box = outbox(queued);
	const ids = {
		answered: box.enqueue(relay({ kind: "escalation", escalationId: answered.id, text: `P9F-ANSWERED ${answered.id}` }), "h"),
		observed: box.enqueue(relay({ kind: "send", sendId: observed.id, text: "P9F-OBSERVED done" }), "h"),
		handled: box.enqueue(relay({ jobId: "cp-oc0m", jobIds: ["cp-oc0m"], text: `P9F-HANDLED ${incident.id} requests approval to build; cp-qwn9 remains deferred.` }), "h"),
		same: box.enqueue(relay({ kind: "escalation", escalationId: same.id, text: `P9F-SAME ${same.id}` }), "h"),
		send: box.enqueue(relay({ kind: "send", sendId: "ps-20300101000000-abcdef02", text: `P9F-SEND raised ${same.id} and ${overdue.id}` }), "h"),
		foreign: box.enqueue(relay({ text: "P9F-FOREIGN emitted by a dead operator" }), "h"),
		wakes: [
			relay({ jobId: "cp-oc0m", text: `P9F-OPEN ${open.id} requests approval; cp-qwn9 deferred` }),
			relay({ jobId: "cp-oc0m", text: `P9F-EARLY ${early.id} requests approval; cp-qwn9 deferred` }),
			relay({ jobId: "cp-oc0m", text: "P9F-UNKNOWN es-zzzz9999 requests approval; cp-qwn9 deferred" }),
			relay({ jobId: "cp-dead", text: `P9F-FAILED ${incident.id} requests approval` }),
			relay({ jobId: "cp-oc0m", text: `P9F-PROSE ${incident.id} answered; cp-zzzz is still running` }),
			relay({ jobId: "cp-held", text: `P9F-HELD ${incident.id} requests approval` }),
			relay({ jobId: "cp-gone", text: `P9F-GONE ${incident.id} requests approval` }),
			relay({ jobId: "cp-oc0m", text: `P9F-SECOND ${sameSecond.id} requests approval` }),
			relay({ jobId: "cp-oc0m", text: `P9F-WITHDRAWN ${withdrawn.id} requests approval` }),
			relay({ jobId: "cp-oc0m", text: `P9F-MIXED ${incident.id} answered; ${open.id} still waits` }),
			relay({ kind: "error", jobId: "cp-oc0m", text: `P9F-ERROR ${incident.id} requests approval; cp-qwn9 deferred` }),
			relay({ text: formatDrain(drain(queued, "cp-live-busy"), home.path), drainId: `drain:${queued}:timeout` }),
			relay({ text: formatDrain(drain(at(-3_600), "cp-stale-busy"), home.path), drainId: `drain:${at(-3_600)}:timeout` }),
			relay({ text: "DRAIN: drained: safe to restart P9F-MOVED", drainId: `drain:${queued}:drained` }),
			relay({ text: `DRAIN: cancelled P9F-CANCELLED ${incident.id}`, drainId: `drain:${queued}:cancelled` }),
		].map((each) => box.enqueue(each, "h")),
		old: outbox(at(-2 * 3_600)).enqueue(relay({ jobId: "cp-old", text: "P9F-OLD first line\nsecond line with an instruction" }), "h"),
	};
	acks.append([{ type: "emit", id: ids.foreign, owner: "4242.deadbeef", session: "/sessions/old.jsonl", at: queued }]);

	const first = operator(home.path, model, agent.env);
	rpcs.push(first);
	await waitFor(() => delivered(first.records()), (messages) => messages.some((m) => m.details.relay_ids.includes(`esc:${overdue.id}`)),
		{ timeoutMs: 30_000, what: "the outbox and the overdue backstop relay delivered" });
	const messages = delivered(first.records());
	assert.deepEqual(messages[0]?.details, { relay_ids: [ids.send], send_id: "ps-20300101000000-abcdef02" }, "a send outcome goes alone with its send_id");
	const batch = messages[1]!;
	assert.deepEqual(batch.details.relay_ids, [ids.foreign, ...ids.wakes, ids.old], "one coalesced message, oldest first, the stale wake last");
	const full = ["FOREIGN", "OPEN", "EARLY", "UNKNOWN", "FAILED", "PROSE", "HELD", "GONE", "SECOND", "WITHDRAWN", "MIXED", "ERROR", "CANCELLED"];
	for (const tag of [...full.map((each) => `P9F-${each} `), "cp-live-busy"]) {
		assert.ok(batch.content.includes(tag), `fail-open and live relays are delivered in full: ${tag}`);
	}
	assert.match(batch.content, new RegExp(`DRAIN: stale notice drain:${at(-3_600)}:timeout: [^\\n]*nothing to act on\\.`), "a stale drain notice is one line");
	assert.match(batch.content, new RegExp(`DRAIN: stale notice drain:${queued}:drained: the drain started ${queued} is now timeout; [^\\n]*nothing to act on\\.`));
	assert.doesNotMatch(batch.content, /cp-stale-busy|P9F-MOVED/, "the stale drain notices' own wording is gone");
	assert.match(batch.content, /stale — do not act \(older than 60 min; headlines only\):\n- \[wake job=cp-old\] P9F-OLD first line/);
	assert.doesNotMatch(batch.content, /second line with an instruction/, "a 2 h old wake is headline-only");
	assert.doesNotMatch(JSON.stringify(messages), /P9F-ANSWERED|P9F-OBSERVED|P9F-HANDLED|P9F-SAME/, "retired relays never reach the operator");
	const reason = `already handled: ${incident.id} answered ${at(-44)}; cp-oc0m done; cp-qwn9 dispatched ${at(23)}`;
	const retired = [`${ids.answered} (superseded: answered)`, `${ids.observed} (returned in tool result)`, `${ids.handled} (${reason})`, `${ids.same} (named in send reply)`];
	assert.ok(batch.content.endsWith(`\n\nretired: ${retired.join("; ")}`), "every retirement is named on the delivered message");
	assert.match(messages[2]?.content ?? "", new RegExp(overdue.id), "an overdue backstop relay is delivered though the send reply named it");
	assert.doesNotMatch(messages[2]?.content ?? "", /retired:/, "a retirement is named once");
	const status = JSON.stringify(first.records().filter((r) => r.type === "extension_ui_request"));
	assert.ok(status.includes(`4 retired (${retired.join(", ")})`), "the status line names every retirement");
	const fold = acks.fold();
	assert.deepEqual(Object.fromEntries([...fold.discarded].map(([id, line]) => [id, line.reason])), {
		[ids.answered]: "superseded: answered", [ids.observed]: "returned in tool result", [ids.handled]: reason, [ids.same]: "named in send reply",
	});
	await waitFor(() => acks.fold(), (now) => [ids.send, ...batch.details.relay_ids, `esc:${overdue.id}`].every((id) => now.acked.has(id)),
		{ timeoutMs: 10_000, what: "every delivered relay acked at context entry" });
	await first.close();

	rmSync(drainFile(home.path));
	writeFileSync(store.file, "{");
	const next = [
		relay({ text: "P9F-NEXT drained", drainId: `drain:${queued}:drained` }),
		relay({ jobId: "cp-oc0m", text: `P9F-BADSTORE ${incident.id} requests approval` }),
	].map((each) => outbox(queued).enqueue(each, "h"));
	const second = operator(home.path, model, agent.env);
	rpcs.push(second);
	await waitFor(() => delivered(second.records()), (found) => found.length >= 1, { timeoutMs: 30_000, what: "the new relays delivered after a restart" });
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const restarted = delivered(second.records());
	assert.deepEqual(restarted.map((m) => m.details.relay_ids), [next], "a new owner over the same files hands over only the new relays");
	assert.match(restarted[0]!.content, new RegExp(`DRAIN: stale notice drain:${queued}:drained: no drain is on disk any more`));
	assert.ok(restarted[0]!.content.includes("P9F-BADSTORE "), "an unreadable escalation store delivers the wake in full");
	await second.close();

	renameSync(acks.file, `${acks.file}.moved`);
	mkdirSync(acks.file);
	outbox(at(0)).enqueue(relay({ text: "P9F-UNREAD" }), "h");
	const third = operator(home.path, model, agent.env);
	rpcs.push(third);
	await third.waitFor((r) => r.type === "extension_ui_request" && JSON.stringify(r).includes("cp-relays: acks unreadable ("), 30_000);
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	assert.deepEqual(delivered(third.records()), [], "unreadable acks deliver nothing, never treated as empty");
});

test("P9f-relay-turn: relays wait out the operator's turn, informational ones are quiet, and a batch is capped", { timeout: 150_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const model = provider.addScript("p9f-turn", [{ kind: "hang", until: held }, { kind: "text", text: "Relays read." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false } } });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: home.path });
	const rpc = operator(home.path, model, agent.env);
	t.after(async () => { release(); await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const state = join(home.path, LAYOUT.state);
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(state));
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));
	await rpc.waitFor((r) => r.type === "extension_ui_request" && JSON.stringify(r).includes("cp-parent"), 30_000);

	const quiet = ["P9F-INFO-1 HELD PR LANDED — cp-a", "P9F-INFO-2 idle notice"].map((text) => outbox.enqueue(relay({ text, informational: true }), "h"));
	await waitFor(() => acks.fold(), (fold) => quiet.every((id) => fold.acked.has(id)), { timeoutMs: 20_000, what: "informational relays appended and acked on the tick" });
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.equal(provider.requests("p9f-turn").length, 0, "a message of informational relays only starts no turn");

	rpc.send({ type: "prompt", id: "turn", message: "P9F operator turn." });
	await waitFor(() => provider.requests("p9f-turn").length, (n) => n === 1, { timeoutMs: 10_000, what: "the operator's turn in flight" });
	const during = ["P9F-INFO-3 landed", "P9F-ACT-1 cp-c reported done", "P9F-ACT-2 cp-d reported done"]
		.map((text, index) => outbox.enqueue(relay({ text, ...(index === 0 ? { informational: true } : {}) }), "h"));
	await new Promise((resolve) => setTimeout(resolve, 16_000));
	assert.ok(during.every((id) => !acks.fold().emits.has(id)), "nothing is handed over while the operator's turn runs");
	release();
	await waitFor(() => provider.requests("p9f-turn").length, (n) => n === 2, { timeoutMs: 20_000, what: "the coalesced relays trigger one turn" });
	const coalesced = delivered(rpc.records());
	assert.deepEqual(coalesced.map((m) => m.details.relay_ids), [quiet, during], "three relays raised during the turn go out as one message on settle");
	const body = JSON.stringify(provider.requests("p9f-turn")[1]!.body);
	for (const tag of ["P9F-INFO-1", "P9F-INFO-2", "P9F-ACT-1", "P9F-ACT-2"]) assert.ok(body.includes(tag), `the quiet relays are in context: ${tag}`);
	await rpc.waitFor((r) => r.type === "agent_settled", 20_000);

	const wakes = Array.from({ length: RELAY_COALESCE_MAX + 3 }, (_, index) => outbox.enqueue(relay({ text: `P9F-W${index}` }), "h"));
	const send = outbox.enqueue(relay({ kind: "send", sendId: "ps-20300101000000-abcdef01", text: "P9F-REPLY" }), "h");
	await waitFor(() => delivered(rpc.records()).length, (n) => n === 5, { timeoutMs: 45_000, what: "the send, the capped batch and its remainder" });
	assert.deepEqual(delivered(rpc.records()).slice(2).map((m) => m.details), [
		{ relay_ids: [send], send_id: "ps-20300101000000-abcdef01" },
		{ relay_ids: wakes.slice(0, RELAY_COALESCE_MAX) },
		{ relay_ids: wakes.slice(RELAY_COALESCE_MAX) },
	], "a send outcome stays alone; coalescing is capped and the remainder goes on the next pass");
});

// #515 review low: a legacy operator session carries cp-bridge relay ids a current bridge never writes (numeric, empty)
// and a foreign message's relay_ids; resuming it acks only the well-formed cp-bridge ids at context entry.
test("P9f-relay-legacy-ids: a resumed legacy session acks only its well-formed cp-bridge relay ids", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("p9f-legacy", [{ kind: "text", text: "Read." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false } } });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: home.path });
	const session = join(home.path, "legacy.jsonl");
	const at = isoTimestamp();
	const rows = [
		{ type: "session", version: 3, id: "p9f-legacy", timestamp: at, cwd: home.path },
		{ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "custom", customType: "cp-bridge", content: "P9F-LEGACY relays",
			display: true, timestamp: 1, details: { relay_ids: ["wake:p9f-a", 3, "", null, "wake:p9f-b"] } } },
		{ type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "custom", customType: "cp-other", content: "P9F-FOREIGN",
			display: true, timestamp: 2, details: { relay_ids: ["wake:p9f-foreign"] } } },
	];
	writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		extensions: [CP_BRIDGE_EXTENSION], sessionFile: session });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("P9F resume the legacy session.");
	await child.waitForSettled(30_000);
	assert.ok(JSON.stringify(provider.requests("p9f-legacy")[0]?.body).includes("P9F-LEGACY relays"), "the legacy message is in context");
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(join(home.path, LAYOUT.state)));
	const lines = readFileSync(acks.file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; id?: unknown })
		.filter((line) => line.type === "ack");
	assert.deepEqual(lines.map((line) => line.id), ["wake:p9f-a", "wake:p9f-b"], "only the well-formed cp-bridge ids are acked, once each");
});
