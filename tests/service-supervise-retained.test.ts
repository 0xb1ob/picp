/**
 * cp-daemon P2: supervisor units no entry point reaches, moved verbatim from tests/service-supervise.test.ts (P14).
 * A blip needs a dropped connection to a live host; "already running" needs a parent between hello and start.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostRecord } from "../src/parent-host.ts";
import { type HostClient, supervise, type SupervisePorts } from "../src/service/supervise.ts";

function fakeClient(parentPid?: number): HostClient & { requests: unknown[][]; close(): void } {
	let close = () => {};
	const closed = new Promise<void>((done) => { close = done; });
	const requests: unknown[][] = [];
	return { hostPid: 100, parentPid, closed, requests, close: () => close(), disconnect: () => close(), request: async (op, ...args) => { requests.push([op, ...args]); return { pid: 200 }; } };
}

const record = (pid: number): HostRecord => ({ version: 1, pid, socket: "/tmp/x.sock", token: "t", started_at: "now" });

function ports(overrides: Partial<SupervisePorts> = {}): SupervisePorts & { lines: string[]; sleeps: number[] } {
	const lines: string[] = [];
	const sleeps: number[] = [];
	return {
		lines, sleeps,
		attach: async () => fakeClient(300),
		connect: async () => { throw new Error("nothing answers"); },
		current: () => ({ gen: 1 }),
		stoppedGen: () => undefined,
		draining: () => false,
		drainRecord: () => undefined,
		updateInFlight: () => false,
		head: async () => undefined,
		now: () => Date.now(),
		savedModel: () => undefined,
		configuredModel: () => undefined,
		alive: () => false,
		sleep: async (ms) => { sleeps.push(ms); await new Promise((done) => setImmediate(done)); },
		log: (line) => void lines.push(line),
		...overrides,
	};
}

test("start: a parent already running is logged without a model, since it keeps whatever it runs", async () => {
	const client = fakeClient(undefined);
	client.request = async (op, ...args) => { client.requests.push([op, ...args]); return { pid: 200, already: true }; };
	const p = ports({ attach: async () => client, configuredModel: () => "file/m" });
	const run = supervise({ home: "/h", model: "env/m" }, p);
	await new Promise((done) => setImmediate(done));
	assert.ok(p.lines.includes("host pid 100: parent already running pid 200"), p.lines.join("\n"));
	assert.ok(!p.lines.some((line) => line.includes("file/m") || line.includes("env/m")), "no model claimed for a running parent");
	client.close();
	assert.equal(await run, 1);
});

test("a blip reconnects to the same live generation", async () => {
	const first = fakeClient(300);
	const again = fakeClient(300);
	const p = ports({ attach: async () => first, current: () => ({ gen: 4, record: record(10) }), alive: () => true, connect: async () => again });
	const run = supervise({ home: "/h" }, p);
	await new Promise((done) => setImmediate(done));
	first.close();
	await new Promise((done) => setImmediate(done));
	assert.ok(p.lines.some((line) => line === "reconnected to host generation 4"));
	p.alive = () => false;
	again.close();
	assert.equal(await run, 1);
});
