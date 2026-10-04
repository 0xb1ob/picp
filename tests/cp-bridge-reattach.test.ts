import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import bridgeExtension from "../extensions/cp-bridge/index.ts";
import { EscalationStore } from "../src/escalation.ts";
import { isPidAlive } from "../src/fleet.ts";
import { attachParentHost, currentHost, ParentHostClient, parentHostPaths } from "../src/parent-host.ts";
import { createScratchHome } from "./harness/index.ts";
import "./harness/fake-parent-tracker.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "fixtures/fake-parent.mjs");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(what: string, ready: () => boolean, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
		await sleep(25);
	}
}

test("a killed and restarted host is re-attached read-only: relays resume with no cp_parent call, the gap escalation once", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const paths = parentHostPaths(home.path, "multi");
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_PARENT_PI_BIN: FAKE_PARENT };
	const previous = Object.fromEntries([...Object.keys(env), "FAKE_PARENT_WAKE", "FAKE_PARENT_WAKE_JOB", "FAKE_PARENT_WAKE_TEXT"].map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const emit = async (event: string, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
	t.after(async () => {
		await emit("session_shutdown");
		const { record } = currentHost(paths);
		if (record && isPidAlive(record.pid)) {
			const client = await ParentHostClient.connect(record, 5_000).catch(() => undefined);
			await client?.request("stop").catch(() => undefined);
			if (client) await client.closed;
			if (isPidAlive(record.pid)) process.kill(record.pid, "SIGKILL");
		}
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		home.cleanup();
	});

	// Generation 1: a started parent. A send outcome relays when its wait ran out (HANG, then RELEASE settles it).
	const first = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await first.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	const settledSend = async (label: string): Promise<string> => {
		const hung = await first.request("send", `HANG ${label}`, 300) as { send_id?: string; pending?: string };
		const id = hung.send_id ?? hung.pending;
		assert.ok(id, JSON.stringify(hung));
		await first.request("send", `RELEASE ${label}`);
		return id;
	};
	// This test client is the host's only subscriber while the first send settles: the outcome is relayed (and stamped
	// relayed by host 1), but never reaches the operator session, which attaches afterwards. Settled, unobserved, unseen.
	await first.onRelay(() => {});
	const unseenId = await settledSend("unseen");
	const generation = currentHost(paths).gen;

	const messages: string[] = [];
	const statuses: string[] = [];
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: { content: string }) => void messages.push(message.content),
		sendUserMessage: () => {},
	} as never);
	const ctx = {
		hasUI: true,
		ui: { setStatus: (key: string, line: string) => { if (key === "cp-parent") statuses.push(line); } },
		getContextUsage: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		sessionManager: { getSessionFile: () => join(home.path, "operator.jsonl"), getEntries: () => [{ type: "message" }] },
	};
	const mentions = (needle: string) => messages.filter((text) => text.includes(needle)).length;
	// Open in the store under the id the fake parent's cp_escalate reports; fresh, so the 10 min backstop cannot relay it.
	const store = new EscalationStore({ home: home.path });
	const raiseAs = async (id: string, job: string): Promise<string> => {
		await store.raise({
			job_ids: [job], kind: "product_ambiguity", question: `ship ${job}?`,
			options: [{ id: "hold", label: "Hold", consequence: "No merge", cost: "none" }],
			recommended: "hold", evidence_paths: [],
		});
		const data = store.read();
		data.items[data.items.length - 1]!.id = id;
		writeFileSync(store.file, JSON.stringify(data));
		return id;
	};
	await emit("session_start", ctx);
	await until("attached to generation 1", () => statuses.some((line) => line.startsWith("cp-parent: attached")));
	// cp-6fyl A1: the outcome the host relayed before this session attached is in the relay outbox: delivered at attach.
	await until("the unseen outcome delivered from disk", () => mentions(unseenId) === 1);
	const sendId = await settledSend("seen"); // relayed to the attached session live, still unobserved by it
	await until("the live send outcome relayed", () => mentions(sendId) >= 1);
	// An open escalation the parent raises while attached: relayed live, so the ledger has it before the kill.
	const liveBeforeKill = await raiseAs("es-0001", "cp-job");
	await first.request("send", "ESCALATE");
	await until("the live escalation relayed", () => mentions(`id=${liveBeforeKill}`) >= 1);

	// The host dies; nothing may start a host or parent while the loop retries.
	process.kill(first.hostPid, "SIGKILL");
	await until("close noticed", () => statuses.some((line) => line.startsWith("cp-parent: host connection closed")));
	await sleep(1_800); // past the first 1 s retry and into the second
	assert.equal(currentHost(paths).gen, generation, "the retry loop never spawns a host");
	assert.equal(statuses.some((line) => line.startsWith("cp-parent: reattached")), false);

	// Raised while the bridge had no connection; fresh, so only the reattach replay (not the 10 min backstop) can relay it now.
	const gap = await raiseAs("es-0002", "cp-job-gap");

	// Generation 2, started the way the supervisor does; its parent wakes at start.
	Object.assign(process.env, { FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: "cp-gen2", FAKE_PARENT_WAKE_TEXT: "Wake from the new generation" });
	const second = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await second.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	assert.equal(currentHost(paths).gen, generation + 1);

	await until("reattached", () => statuses.some((line) => line === `cp-parent: reattached (pid ${second.hostPid})`));
	await until("the new generation's wake", () => mentions("Wake from the new generation") >= 1);
	await until("the gap escalation", () => mentions(`id=${gap}`) >= 1);

	// Escalations: the live relay of the same id races the replay (es-0002) or follows its own earlier live relay (es-0001): still one each.
	await second.request("send", "REFRESH"); // raises es-0002 live, twice
	await second.request("send", "ESCALATE"); // raises es-0001 live again
	await sleep(500);
	assert.equal(mentions(`id=${gap}`), 1, JSON.stringify(messages));
	assert.equal(mentions(`id=${liveBeforeKill}`), 1, JSON.stringify(messages));
	// Send outcomes: host 2 re-emits every settled, unobserved one (relaysDue) into the same relay ids; this session already
	// holds both (its own emits in this session file), so neither is shown twice.
	assert.equal(mentions(unseenId), 1, "the outcome delivered at attach is not replayed again");
	assert.equal(mentions(sendId), 1, "the already-seen outcome is not shown again");
	assert.equal(statuses.filter((line) => line.startsWith("cp-parent: reattached")).length, 1);
	assert.equal(currentHost(paths).gen, generation + 1, "no further host generation");
});
