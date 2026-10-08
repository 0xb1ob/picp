/**
 * cp-daemon P2: the attach-first supervisor (src/service/supervise.ts). Port
 * fakes pin each decision; a real host with the fake parent pins attach-first,
 * the spawn, the stop marker and the exit on SIGKILL. No unit is started.
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { isPidAlive } from "../src/fleet.ts";
import { currentHost, type HostRecord, ParentHostClient, parentHostPaths, readStopMarker } from "../src/parent-host.ts";
import { EXIT_NO_MODEL, type HostClient, hostPorts, supervise, type SupervisePorts } from "../src/service/supervise.ts";
import { createScratchHome, waitFor } from "./harness/index.ts";
import "./harness/fake-parent-tracker.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "fixtures/fake-parent.mjs");

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
		savedModel: () => undefined,
		configuredModel: () => undefined,
		alive: () => false,
		sleep: async (ms) => { sleeps.push(ms); await new Promise((done) => setImmediate(done)); },
		log: (line) => void lines.push(line),
		...overrides,
	};
}

test("no model: a host running no parent and no CP_PARENT_MODEL or saved model exits 78, starting nothing", async () => {
	const client = fakeClient(undefined);
	const p = ports({ attach: async () => client });
	assert.equal(await supervise({ home: "/h" }, p), EXIT_NO_MODEL);
	assert.deepEqual(client.requests, []);
	assert.ok(p.lines.some((line) => /CP_PARENT_MODEL/.test(line)));
});

test("start: CP_PARENT_MODEL wins over the saved model; the saved model is the fallback", async () => {
	for (const [model, saved, expected] of [["env/m", "saved/m", "env/m"], [undefined, "saved/m", "saved/m"]] as const) {
		const client = fakeClient(undefined);
		const p = ports({ attach: async () => client, savedModel: () => saved });
		const run = supervise({ home: "/h", ...(model ? { model } : {}) }, p);
		await new Promise((done) => setImmediate(done));
		assert.deepEqual(client.requests, [["start", { home: "/h", mode: "multi", model: expected }]]);
		client.close();
		assert.equal(await run, 1, "host gone with no drain or stop → exit 1");
	}
});

test("start: a data/parent.json model avoids exit 78 with no env or saved model; the supervisor never sends modelExplicit", async () => {
	for (const [model, saved, expected] of [[undefined, undefined, "file/m"], [undefined, "saved/m", "file/m"], ["env/m", "saved/m", "env/m"]] as const) {
		const client = fakeClient(undefined);
		const p = ports({ attach: async () => client, savedModel: () => saved, configuredModel: () => "file/m" });
		const run = supervise({ home: "/h", ...(model ? { model } : {}) }, p);
		await new Promise((done) => setImmediate(done));
		// No modelExplicit key: CP_PARENT_MODEL is env, so bridge.start lets the file model beat it (tests/cp-bridge.test.ts).
		assert.deepEqual(client.requests, [["start", { home: "/h", mode: "multi", model: expected }]]);
		assert.ok(p.lines.some((line) => line.endsWith("(file/m)")), p.lines.join("\n"));
		client.close();
		assert.equal(await run, 1);
	}
});

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

test("a live foreign lock is retried every 60 s and logged once; any other attach failure exits 1", async () => {
	let tries = 0;
	const p = ports({ attach: async () => { if (++tries < 3) throw new Error("a parent already holds /h/parent.lock (pid 9)"); const c = fakeClient(300); c.close(); return c; } });
	assert.equal(await supervise({ home: "/h" }, p), 1);
	assert.deepEqual(p.sleeps, [60_000, 60_000]);
	assert.equal(p.lines.filter((line) => line.includes("already holds")).length, 1);
	assert.equal(await supervise({ home: "/h" }, ports({ attach: async () => { throw new Error("parent host did not come up"); } })), 1);
});

test("host lost: a drain file or a stop marker for the watched generation waits without spawning, then joins a newer generation", async () => {
	for (const hold of ["drain", "stop"] as const) {
		const first = fakeClient(300);
		const second = fakeClient(301);
		let gen = 1;
		let attaches = 0;
		const p = ports({
			attach: async () => { attaches++; return first; },
			current: () => (gen === 1 ? { gen: 1, record: record(10) } : { gen: 2, record: record(11) }),
			alive: (pid) => pid === 11,
			connect: async (r) => { if (r.pid !== 11) throw new Error("dead"); return second; },
			draining: () => hold === "drain",
			stoppedGen: () => (hold === "stop" ? 1 : undefined),
			sleep: async (ms) => { p.sleeps.push(ms); if (p.sleeps.length === 3) gen = 2; await new Promise((done) => setImmediate(done)); },
		});
		const run = supervise({ home: "/h" }, p);
		await new Promise((done) => setImmediate(done));
		first.close();
		// Wait for the reattach itself, not a fixed 10 ms: a loaded CI runner can take longer for loss → 3 sleeps → connect.
		await waitFor(() => p.lines, (lines) => lines.some((line) => line.includes("attached to newer host generation 2")), { intervalMs: 5, what: `${hold}: reattach to generation 2` });
		assert.deepEqual(p.sleeps, [10_000, 10_000, 10_000], hold);
		assert.equal(attaches, 1, "waiting never attaches (so never spawns)");
		assert.ok(p.lines.some((line) => line.includes("attached to newer host generation 2")), p.lines.join("\n"));
		assert.equal(p.lines.filter((line) => line.includes("waiting without spawning")).length, 1);
		p.draining = () => false;
		p.stoppedGen = () => undefined;
		p.alive = () => false;
		second.close();
		assert.equal(await run, 1, "lost again with no hold: exit 1");
	}
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

test("real host: spawns when none, a second supervisor adds no generation, a stop writes the marker and nothing respawns, SIGKILL exits 1", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const env = { PI_HOME: home.path, FAKE_PARENT_ARGV: join(home.path, "argv") };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const paths = parentHostPaths(home.path, "multi");
	t.after(async () => {
		const { record: host } = currentHost(paths);
		if (host && isPidAlive(host.pid)) process.kill(host.pid, "SIGKILL");
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		home.cleanup();
	});
	const lines: string[] = [];
	let done = false;
	const real = () => hostPorts(home.path, { log: (line) => void lines.push(line), sleep: async (ms) => { if (done) throw new Error("test over"); await new Promise((r) => setTimeout(r, Math.min(ms, 50))); } });
	const until = async (what: string, check: () => boolean) => {
		const deadline = Date.now() + 60_000;
		while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${lines.join("\n")}`); await new Promise((r) => setTimeout(r, 25)); }
	};
	const options = { home: home.path, model: "mock/parent", piBin: FAKE_PARENT };
	const first = supervise(options, real());
	await until("the parent", () => lines.some((line) => line.includes("started parent")));
	assert.equal(currentHost(paths).gen, 1);
	const second = supervise(options, real());
	await until("the second attach", () => lines.some((line) => line.startsWith("attached to host pid")));
	assert.equal(currentHost(paths).gen, 1, "attach first: no second generation");

	const client = await ParentHostClient.connect(currentHost(paths).record!);
	await client.request("stop");
	await client.closed;
	assert.equal(readStopMarker(paths)?.gen, 1, "the stop marker names the stopped generation");
	await until("both to wait", () => lines.filter((line) => line.includes("an operator stop closed generation 1: waiting")).length === 2);
	assert.equal(currentHost(paths).gen, 1, "nothing respawned over a stop");
	done = true;
	// Both handlers attach at once: the supervisors wake in the same 50 ms poll, and one awaited alone leaves the other unhandled.
	await Promise.all([assert.rejects(first, /test over/), assert.rejects(second, /test over/)]);

	// Crash: the next supervisor claims generation 2 and starts the parent; SIGKILL on that host exits 1.
	done = false;
	const third = supervise(options, real());
	await until("gen 2", () => currentHost(paths).gen === 2 && lines.filter((line) => line.includes("started parent")).length === 2);
	process.kill(currentHost(paths).record!.pid, "SIGKILL");
	assert.equal(await third, 1, "a killed host with no drain or stop: exit 1 for systemd");
	assert.equal(currentHost(paths).gen, 2, "the supervisor itself never respawns; systemd restarts it");
});
