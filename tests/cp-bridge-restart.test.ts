import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import bridgeExtension from "../extensions/cp-bridge/index.ts";
import { CpBridgeError } from "../src/cp-bridge.ts";
import { isPidAlive } from "../src/fleet.ts";
import { attachParentHost, currentHost, ParentHostClient, parentHostPaths } from "../src/parent-host.ts";
import { acquireParentLock } from "../src/parent-lock.ts";
import { createScratchHome } from "./harness/index.ts";
import "./harness/fake-parent-tracker.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "fixtures/fake-parent.mjs");
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

for (const stops of [true, false]) {
	test(`cp_parent start while stopping ${stops ? "retries until the old host exits" : "expires naming the lock and pid"}`, { timeout: 90_000 }, async (t) => {
		const home = createScratchHome();
		const paths = parentHostPaths(home.path, "multi");
		const argvFile = join(home.path, "argv");
		const env = { CP_PARENT_PI_BIN: FAKE_PARENT, PI_HOME: home.path, FAKE_PARENT_ARGV: argvFile };
		const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
		Object.assign(process.env, env);
		const clients: ParentHostClient[] = [];
		const shutdown: Array<() => unknown> = [];
		t.after(async () => {
			for (const close of shutdown) await close();
			for (const client of clients) client.disconnect();
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
		const old = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
		clients.push(old);
		const started = await old.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 }) as { pid: number };
		const lock = acquireParentLock({ home: home.path, pid: started.pid });
		assert.ok(lock.ok);
		t.after(() => lock.lock.release());
		const generation = currentHost(paths).gen;
		const trackedBefore = lines(process.env.FAKE_PARENT_PID_FILE!);
		assert.ok(trackedBefore.some((line) => JSON.parse(line).pid === started.pid));
		const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
		bridgeExtension({
			registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
			registerCommand: () => {},
			on: (event: string, handler: () => unknown) => { if (event === "session_shutdown") shutdown.push(handler); },
			sendMessage: () => {},
		} as never);
		const request = ParentHostClient.prototype.request;
		let refusals = 0;
		// Hold open the narrow stop-reply/close race at the response boundary.
		// Attach, parent RPC, generation claims and eventual shutdown remain real.
		t.mock.method(ParentHostClient.prototype, "request", async function (this: ParentHostClient, op: string, ...args: unknown[]) {
			if (op === "start" && this.hostPid === old.hostPid) {
				refusals++;
				assert.equal(currentHost(paths).gen, generation, "no replacement while the old host lives");
				assert.deepEqual(lines(process.env.FAKE_PARENT_PID_FILE!), trackedBefore, "no second parent during retries");
				if (stops && refusals === 3) {
					await request.call(old, "stop");
					await old.closed;
					lock.lock.release();
				}
				throw new CpBridgeError("parent host is stopping");
			}
			return request.call(this, op, ...args);
		});
		const before = Date.now();
		const result = await tools.get("cp_parent")!.execute("start", { action: "start", home: home.path, mode: "multi", model: "mock/parent" });
		const elapsed = Date.now() - before;
		assert.ok(refusals >= 3, "start retried instead of returning the first refusal");
		if (stops) {
			assert.match(result.content[0]!.text, /started pid=/);
			assert.equal(isPidAlive(old.hostPid), false);
			assert.equal(isPidAlive(started.pid), false);
			assert.equal(currentHost(paths).gen, generation + 1, "only one successor host");
			assert.equal(lines(argvFile).length, 2, "one old parent and one successor");
			assert.equal(lines(process.env.FAKE_PARENT_PID_FILE!).length, trackedBefore.length + 1);
		} else {
			assert.ok(elapsed >= 10_000, `start returned before its deadline: ${elapsed}ms`);
			assert.ok(elapsed < 30_000, `start did not stop retrying promptly: ${elapsed}ms`);
			assert.ok(result.content[0]!.text.includes(lock.lock.path), result.content[0]!.text);
			assert.ok(result.content[0]!.text.includes(`pid ${started.pid}`), result.content[0]!.text);
			assert.equal(currentHost(paths).record?.pid, old.hostPid);
			assert.equal(currentHost(paths).gen, generation);
			assert.equal(lines(argvFile).length, 1);
			assert.deepEqual(lines(process.env.FAKE_PARENT_PID_FILE!), trackedBefore);
		}
	});
}

test("session_start attaches read-only: the host's relay backlog arrives with no cp_parent call, and no host is ever spawned", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const idle = createScratchHome();
	const paths = parentHostPaths(home.path, "multi");
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: "cp-backlog", FAKE_PARENT_WAKE_TEXT: "Backlog wake for the attached session" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
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
		idle.cleanup();
	});
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await host.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	host.disconnect(); // nobody subscribed: the wake waits in the host's backlog
	await host.closed;
	const generation = currentHost(paths).gen;
	const messages: string[] = [];
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: { content: string }) => void messages.push(message.content),
		sendUserMessage: () => {},
	} as never);
	const ctx = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home.path, "operator.jsonl") } };
	await emit("session_start", ctx);
	const deadline = Date.now() + 30_000;
	while (!messages.some((text) => text.includes("Backlog wake for the attached session"))) {
		if (Date.now() > deadline) throw new Error(`no backlog relay at session start: ${JSON.stringify(messages)}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(currentHost(paths).gen, generation, "read-only attach: no new host generation");

	// A home with no host: session_start spawns nothing.
	await emit("session_shutdown");
	process.env.CP_HOME = idle.path;
	process.env.PI_HOME = idle.path;
	const other = bridgeExtension as unknown as (pi: unknown) => void;
	const idleHandlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	other({ registerTool: () => {}, registerCommand: () => {}, on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => idleHandlers.set(event, [...(idleHandlers.get(event) ?? []), handler]), sendMessage: () => {}, sendUserMessage: () => {} });
	for (const handler of idleHandlers.get("session_start") ?? []) await handler({}, ctx);
	for (const handler of idleHandlers.get("session_shutdown") ?? []) await handler({}, ctx);
	assert.equal(currentHost(parentHostPaths(idle.path, "multi")).gen, 0, "no host was spawned for a home that had none");
});

test("a failed session_start attach, then a successful cp_parent start, refreshes the cp-parent status line; a stop clears it", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const paths = parentHostPaths(home.path, "multi");
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_PARENT_PI_BIN: FAKE_PARENT };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
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
	const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	const status = new Map<string, string>();
	const ctx = { hasUI: true, ui: { setStatus: (key: string, line: string) => status.set(key, line) }, getContextUsage: () => undefined, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home.path, "operator.jsonl") } };
	await emit("session_start", ctx);
	assert.match(status.get("cp-parent") ?? "", /^cp-parent: not attached/, "no host yet: session_start attach fails");

	const started = await tools.get("cp_parent")!.execute("start", { action: "start", home: home.path, mode: "multi", model: "mock/parent" });
	const pid = /started pid=(\d+)/.exec(started.content[0]!.text)?.[1];
	assert.ok(pid, started.content[0]!.text);
	const hostPid = currentHost(paths).record!.pid;
	assert.equal(status.get("cp-parent"), `cp-parent: attached (host pid ${hostPid}, parent pid ${pid})`);

	await tools.get("cp_parent")!.execute("stop", { action: "stop" });
	const deadline = Date.now() + 10_000;
	while ((status.get("cp-parent") ?? "").startsWith("cp-parent: attached")) {
		if (Date.now() > deadline) throw new Error(`cp-parent still reads attached after stop: ${status.get("cp-parent")}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
});
