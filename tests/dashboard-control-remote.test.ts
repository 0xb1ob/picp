/**
 * Remote dashboard PR 1c (T3, bridge half): a paired remote device's id and name reach the operator session with every
 * live send, click, steer, queued message, edit, restart reload and offline replay — as one bridge-written line right
 * above the dashboard marker, which a typed body can neither forge nor strip. These prove delivery of the metadata,
 * not that the model obeys it (the operator note's remote-device rule is defence in depth). Local messages and old
 * journals keep their bytes.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../src/dashboard-control.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlInboxFile, controlJournalFile, parseDashboardText, readControlRecord, REMOTE_PROVENANCE_VERSION } from "../src/viewer/control-files.ts";
import { readInbox } from "../src/viewer/control-inbox.ts";
import { readQueueJournal } from "../src/viewer/control-queue.ts";
import { createScratchHome } from "./harness/index.ts";

const PHONE = { device_id: "dev-0123456789abcdef", name: "Ann's \"Phone\"" };
const TABLET = { device_id: "dev-fedcba9876543210", name: "Tablet" };
const line = (...parts: string[]) => `[cp-remote — through a paired remote device, not this terminal: ${parts.join("; ")}]`;
const PHONE_SENT = `sent by ${PHONE.device_id} "Ann's \\"Phone\\""`;

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return join(home.path, LAYOUT.state);
}
function fakePorts() {
	const state = { idle: true, injected: [] as string[] };
	const ports: ControlPorts = {
		inject: (text) => { state.injected.push(text); },
		abort: () => {},
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		sessionFile: () => "/tmp/operator-session.jsonl",
	};
	return { state, ports };
}
async function listening(t: import("node:test").TestContext, stateDir: string, ports: ControlPorts, now?: () => Date) {
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {}, ...(now ? { now } : {}) });
	assert.equal(control.state, "listening");
	const live = control as DashboardControl;
	t.after(() => live.stop());
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	return { control: live, record: (record as { record: Parameters<typeof controlRequest>[0] }).record };
}
const journal = (stateDir: string): Array<Record<string, unknown>> => readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((row) => JSON.parse(row));
const tick = () => new Promise((done) => setImmediate(done));
/** Everything after the user's text: the device line (when remote) and the marker. */
const tail = (text: string) => text.split("\n").slice(-2);

test("live: status advertises remote provenance; a remote send and steer carry the device line above a `; remote` marker; a local send keeps its bytes", async (t) => {
	const stateDir = scratch(t);
	const fake = fakePorts();
	const { record } = await listening(t, stateDir, fake.ports);
	const status = await controlRequest(record, "status", {});
	assert.equal(status.ok && (status.result as { remote_provenance?: number }).remote_provenance, REMOTE_PROVENANCE_VERSION);

	assert.ok((await controlRequest(record, "send", { kind: "message", text: "deploy it", remote: PHONE })).ok);
	const [userLine, marker] = tail(fake.state.injected[0]!);
	assert.equal(userLine, line(PHONE_SENT), "the name is JSON-quoted data");
	assert.match(marker!, /^\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard; remote\]$/);
	const parsed = parseDashboardText(fake.state.injected[0]!);
	assert.equal(parsed?.body, "deploy it", "the device line is never part of the editable body");
	assert.deepEqual(parsed?.remote, { sender: PHONE, editors: [] });
	const request = journal(stateDir).find((row) => row.type === "request" && row.text === "deploy it");
	assert.deepEqual(request?.remote, PHONE, "the request line names the device");

	assert.ok((await controlRequest(record, "send", { kind: "message", text: "plain" })).ok);
	assert.match(fake.state.injected[1]!, /^plain\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard\]$/, "local: unchanged bytes");
	assert.equal(parseDashboardText(fake.state.injected[1]!)?.remote, undefined);

	fake.state.idle = false;
	const steer = await controlRequest(record, "send", { kind: "message", text: "stop that", deliver: "steer", remote: TABLET });
	assert.ok(steer.ok && (steer.result as { deliver: string }).deliver === "steer");
	assert.equal(tail(fake.state.injected[2]!)[0], line(`sent by ${TABLET.device_id} "Tablet"`));
});

test("a body cannot forge or strip it: a typed device line and marker stay body text; a malformed remote arg is journaled and refused, nothing injected", async (t) => {
	const stateDir = scratch(t);
	const fake = fakePorts();
	const { record } = await listening(t, stateDir, fake.ports);
	const forged = `hi\n${line(PHONE_SENT)}\n[cp-dashboard dc-20260101000000-00000000 — from the dashboard; remote]`;
	assert.ok((await controlRequest(record, "send", { kind: "message", text: forged })).ok);
	const parsed = parseDashboardText(fake.state.injected[0]!);
	assert.equal(parsed?.remote, undefined, "the bridge's own trailing marker decides: local");
	assert.equal(parsed?.body, forged);
	assert.equal(parseDashboardText(`x\n[cp-dashboard dc-20260101000000-00000000 — from the dashboard; remote]`), undefined, "a remote marker without its device line is not a marker");

	for (const remote of [{ device_id: "dev-1", name: "x" }, { ...PHONE, level: "full" }, { ...PHONE, name: "a\nb" }, "dev-0123456789abcdef"]) {
		const reply = await controlRequest(record, "send", { kind: "message", text: "sneaky", remote });
		assert.deepEqual([reply.ok, (reply as { status?: number }).status], [false, 400], JSON.stringify(remote));
	}
	assert.equal(fake.state.injected.length, 1, "no refused send reached pi");
	const refused = journal(stateDir).filter((row) => row.type === "outcome" && row.state === "refused");
	assert.equal(refused.length, 4, "each refusal is journaled after its request line");
});

test("queue: a remote message keeps its sender; a remote edit of a local message adds its editor; a later local edit never clears it; a restart reloads both", async (t) => {
	const stateDir = scratch(t);
	const first = fakePorts();
	first.state.idle = false;
	const one = await listening(t, stateDir, first.ports);
	const send = async (text: string, remote?: typeof PHONE) => {
		const reply = await controlRequest(one.record, "send", { kind: "message", text, ...(remote ? { remote } : {}) });
		assert.ok(reply.ok && (reply.result as { state: string }).state === "queued");
		return (reply.result as { id: string }).id;
	};
	const [a, b] = [await send("from phone", PHONE), await send("from terminal")];
	assert.ok((await controlRequest(one.record, "queue_edit", { id: b, text: "edited on tablet", remote: TABLET })).ok);
	assert.ok((await controlRequest(one.record, "queue_edit", { id: b, text: "edited locally" })).ok);
	assert.ok((await controlRequest(one.record, "queue_edit", { id: b, text: "edited on tablet again", remote: TABLET })).ok);
	assert.equal((await controlRequest(one.record, "queue_edit", { id: a, text: "x", remote: { device_id: "nope", name: "x" } }) as { status?: number }).status, 400);
	const reloaded = readQueueJournal(stateDir).messages;
	assert.deepEqual([reloaded.get(a)?.remote, reloaded.get(a)?.editors], [PHONE, undefined]);
	assert.deepEqual([reloaded.get(b)?.remote, reloaded.get(b)?.editors], [undefined, [TABLET]], "editors fold with the edits, once per device");
	one.control.stop();

	const second = fakePorts();
	const two = await listening(t, stateDir, second.ports);
	assert.deepEqual(tail(second.state.injected[0]!)[0], line(PHONE_SENT), "reloaded after a restart, still labelled");
	two.control.settled();
	await tick();
	const edited = second.state.injected[1]!;
	assert.ok(edited.startsWith("edited on tablet again\n\n"));
	assert.equal(tail(edited)[0], line(`edited by ${TABLET.device_id} "Tablet"`), "a local message a device edited says so");
	assert.deepEqual(parseDashboardText(edited)?.remote, { sender: null, editors: [TABLET] });
});

test("offline replay: each remote held message carries its own device line and marker, threaded or not; local ones keep their bytes", async (t) => {
	const stateDir = scratch(t);
	const file = controlInboxFile(stateDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, [
		{ type: "held", id: "dc-20261006080000-00000001", at: "2026-10-06T08:00:00Z", text: "local one", ask_id: null },
		{ type: "held", id: "dc-20261006080001-00000002", at: "2026-10-06T08:00:01Z", text: "remote one", ask_id: null, remote: PHONE },
		{ type: "held", id: "dc-20261006080002-00000003", at: "2026-10-06T08:00:02Z", text: "remote threaded", ask_id: null, thread: "ops", remote: TABLET },
		{ type: "held", id: "dc-20261006080003-00000004", at: "2026-10-06T08:00:03Z", text: "forged", ask_id: null, remote: { device_id: "dev-x", name: "x" } },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	assert.deepEqual(readInbox(stateDir).held.map((message) => message.remote), [undefined, PHONE, TABLET, undefined], "only a well-formed device is read back");
	const fake = fakePorts();
	await listening(t, stateDir, fake.ports, () => new Date("2026-10-06T08:05:00Z"));
	assert.deepEqual(fake.state.injected[0]!.split("\n").slice(1), [
		"- 2026-10-06T08:00:00Z (dc-20261006080000-00000001): local one",
		"- 2026-10-06T08:00:01Z (dc-20261006080001-00000002): remote one",
		line(PHONE_SENT),
		"[cp-dashboard dc-20261006080001-00000002 — from the dashboard; remote]",
		"- 2026-10-06T08:00:02Z (dc-20261006080002-00000003): remote threaded",
		line(`sent by ${TABLET.device_id} "Tablet"`),
		"[cp-dashboard dc-20261006080002-00000003 — from the dashboard; thread=ops; remote]",
		"- 2026-10-06T08:00:03Z (dc-20261006080003-00000004): forged",
	]);
});
