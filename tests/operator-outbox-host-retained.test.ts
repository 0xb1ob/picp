/**
 * Retained from operator-outbox-host.test.ts (P9b): the handoff-to-`message_start` window. The real bridge hands off
 * between runs and pi enters it in the same tick, so only a fake pi holds that window open (testing-migration/p9.md).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import bridgeExtension from "../extensions/cp-bridge/index.ts";
import { layoutForHome } from "../src/contracts.ts";
import { isPidAlive } from "../src/fleet.ts";
import { OperatorRelayAcks, operatorRelayAcksFile, operatorRelayOutboxFile } from "../src/operator-outbox.ts";
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

function scratch(t: { after: (fn: () => Promise<void>) => void }, extra: Record<string, string> = {}) {
	const home = createScratchHome();
	const paths = parentHostPaths(home.path, "multi");
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_PARENT_PI_BIN: FAKE_PARENT, ...extra };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const cleanups: Array<() => Promise<void>> = [];
	t.after(async () => {
		for (const cleanup of cleanups) await cleanup();
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
	const state = join(home.path, layoutForHome("multi", home.path).state);
	return { home, paths, state, cleanups };
}

/** One operator session: the bridge extension with a fake pi that records every message it is handed. */
function operator(home: string, sessionFile: string, cleanups: Array<() => Promise<void>>) {
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const sent: Array<{ customType: string; content: string; details?: unknown }> = [];
	const fire = async (name: string, event: unknown = {}, ctx?: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		sendMessage: (message: { customType: string; content: string; details?: unknown }) => void sent.push(message),
		sendUserMessage: () => {},
	} as never);
	const ctx = {
		hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, getContextUsage: () => undefined,
		sessionManager: { getSessionFile: () => join(home, sessionFile), getEntries: () => [{ type: "message" }] },
	};
	let down = false;
	const shutdown = async () => { if (!down) { down = true; await fire("session_shutdown"); } };
	cleanups.push(shutdown);
	return {
		sent,
		start: () => fire("session_start", {}, ctx),
		/** pi puts each handed-off message into context: `message_start`. */
		enterContext: async () => { for (const message of sent) await fire("message_start", { message }); },
		shutdown,
	};
}

test("a relay handed off to the operator is acked at message_start, not at handoff", { timeout: 180_000 }, async (t) => {
	const { home, state, cleanups } = scratch(t,
		{ FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: "cp-gone", FAKE_PARENT_WAKE_TEXT: "Wake while nobody listened" });
	const first = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await first.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	const onDisk = () => { try { return readFileSync(operatorRelayOutboxFile(state), "utf8"); } catch { return ""; } };
	await until("the wake is in the relay outbox", () => onDisk().includes("Wake while nobody listened"));
	first.disconnect();

	const a = operator(home.path, "operator-a.jsonl", cleanups);
	await a.start();
	const wakes = () => a.sent.filter((message) => message.content.includes("Wake while nobody listened"));
	await until("the wake delivered from disk", () => wakes().length === 1);
	const ids = (wakes()[0]?.details as { relay_ids?: string[] }).relay_ids ?? [];
	assert.equal(ids.length, 1);
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));
	assert.equal(acks.fold().acked.has(ids[0] as string), false, "handed off, not yet in context");
	await a.enterContext();
	assert.ok(acks.fold().acked.has(ids[0] as string), "acked at message_start");
	await a.shutdown();
});
