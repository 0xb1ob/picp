import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { attachParentHost, currentHost, parentHostPaths, type ParentHostClient } from "../../src/parent-host.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";

test("wake S19: real bridge retries its host transport with capped backoff and probes silent or superseded hosts", { timeout: 600_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const parentModel = provider.addScript("s19-proxy-parent", [{ kind: "text", text: "Ready." }]);
	const operatorModel = provider.addScript("s19-proxy-operator", [{ kind: "text", text: "Ready." }]);
	const agent = createAgentDir({ provider });
	const previous = Object.fromEntries(Object.keys(agent.env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, agent.env);
	let host: ParentHostClient | undefined;
	let operator: ReturnType<typeof startPiChild> | undefined;
	const peers = new Set<Socket>();
	let rejecting = 0;
	let silence = false;
	let disconnectProbe = false;
	let hellos = 0;
	const attempts: number[] = [];
	let tracking = false;
	let connected = 0;
	let maximumConnected = 0;
	const paths = parentHostPaths(home.path, "multi");
	let actualSocket = "";
	const proxy = createServer((socket) => {
		maximumConnected = Math.max(maximumConnected, ++connected);
		socket.on("close", () => connected--);
		peers.add(socket);
		socket.on("close", () => peers.delete(socket));
		socket.on("error", () => socket.destroy());
		if (tracking) attempts.push(Date.now());
		if (rejecting-- > 0) { socket.destroy(); return; }
		const upstream = createConnection(actualSocket);
		peers.add(upstream);
		upstream.on("close", () => { peers.delete(upstream); socket.destroy(); });
		upstream.on("error", () => { upstream.destroy(); socket.destroy(); });
		socket.on("close", () => upstream.destroy());
		upstream.pipe(socket);
		socket.on("data", (data) => {
			if (data.toString().includes('"op":"hello"')) {
				hellos++;
				if (disconnectProbe) { disconnectProbe = false; socket.destroy(); return; }
				if (silence) { silence = false; return; }
			}
			upstream.write(data);
		});
	});
	t.after(async () => {
		chmodSync(paths.dir, 0o700);
		await operator?.close();
		for (const peer of peers) peer.destroy();
		await new Promise<void>((done) => proxy.close(() => done()));
		await host?.request("stop").catch(() => undefined);
		host?.disconnect();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await host.request("start", { home: home.path, mode: "multi", model: parentModel, modelExplicit: true });
	const current = currentHost(paths);
	assert.ok(current.record);
	actualSocket = current.record.socket;
	const proxySocket = join(paths.dir, "s19-proxy.sock");
	await new Promise<void>((done) => proxy.listen(proxySocket, done));
	const recordFile = paths.record(current.gen);
	const original = readFileSync(recordFile, "utf8");
	writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(original), socket: proxySocket }));
	operator = startPiChild({ cwd: home.path, model: operatorModel,
		env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
	await operator.prompt("Acknowledge readiness."); await operator.waitForSettled();
	const status = () => operator!.stderr() + JSON.stringify(operator!.records());
	await waitFor(status, (text) => text.includes("cp-parent: attached"), { timeoutMs: 30_000, what: "bridge attaches through forwarding transport" });
	tracking = true;
	rejecting = 6;
	for (const peer of peers) peer.destroy();
	await waitFor(() => attempts.length, (count) => count >= 7, { timeoutMs: 160_000, what: "six real reconnect refusals followed by success" });
	await waitFor(status, (text) => text.includes("cp-parent: reattached"), { timeoutMs: 10_000, what: "retry loop stops on success" });
	const gaps = attempts.slice(1).map((at, index) => at - attempts[index]!);
	for (const [index, minimum] of [1_900, 3_900, 7_900, 15_900, 29_900, 29_900].entries()) {
		assert.ok(gaps[index]! >= minimum, `backoff gap ${index}: ${gaps[index]}`);
	}
	assert.ok(gaps[5]! < 50_000, `retry delay must cap at 30 seconds: ${gaps[5]}`);
	await new Promise((done) => setTimeout(done, 2_000));
	assert.equal(attempts.length, 7, "successful attachment stops retrying");
	assert.equal(maximumConnected, 1, "reconnect attempts never overlap on the transport");
	assert.equal(currentHost(paths).gen, current.gen, "retries never create a host");
	const silentCount = () => operator!.records().filter((record) => record.type === "extension_ui_request" && String(record.statusText).includes("silent; re-attaching")).length;
	const beforeSilent = silentCount();
	silence = true;
	await waitFor(silentCount, (count) => count > beforeSilent, { timeoutMs: 75_000, what: "silent established host is probed and detached" });
	await waitFor(() => attempts.length, (count) => count >= 8, { timeoutMs: 10_000, what: "silent host reconnects read-only" });
	const beforeSuperseded = silentCount();
	writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(original), socket: proxySocket, pid: process.pid }));
	await waitFor(silentCount, (count) => count > beforeSuperseded, { timeoutMs: 75_000, what: "superseded host is detached despite answering hello" });
	writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(original), socket: proxySocket }));
	await waitFor(() => attempts.length, (count) => count >= 9, { timeoutMs: 10_000, what: "bridge reconnects after supersession" });
	await new Promise((done) => setTimeout(done, 500));
	disconnectProbe = true;
	await waitFor(() => attempts.length, (count) => count >= 10, { timeoutMs: 75_000, what: "host closing during hello rejects its probe and reconnects" });
	await new Promise((done) => setTimeout(done, 500));
	const beforeUnreadable = silentCount();
	const beforeHello = hellos;
	chmodSync(paths.dir, 0o300);
	await waitFor(() => hellos, (count) => count > beforeHello, { timeoutMs: 75_000, what: "answering host is probed while generation directory is unreadable" });
	await new Promise((done) => setTimeout(done, 500));
	chmodSync(paths.dir, 0o700);
	assert.equal(silentCount(), beforeUnreadable, "unreadable host record is not proof of replacement");
	assert.equal(provider.remaining("s19-proxy-operator"), 0);
	writeFileSync(recordFile, original);
});
