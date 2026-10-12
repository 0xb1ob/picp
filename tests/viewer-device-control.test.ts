/**
 * Remote dashboard PR 1c: the viewer's owner socket for the device CLI. Owner-only files (0700 dir, 0600 record and
 * socket), bounded frames, token check, the pair/list/revoke ops through the one store, the stale-owner checks on both
 * ends — and, across real processes, a single owner and a single winner for one pairing code.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LAYOUT } from "../src/contracts.ts";
import { controlJournalFile } from "../src/viewer/control-files.ts";
import { DEVICE_FRAME_MAX, deviceControlDir, deviceControlRecordFile, deviceControlRequest, deviceControlSocket, startDeviceControl } from "../src/viewer/device-control.ts";
import { DeviceStore } from "../src/viewer/device-store.ts";
import type { DeviceBinding } from "../src/viewer/devices-api.ts";
import { createScratchHome } from "./harness/index.ts";
import { REMOTE_ORIGIN, remoteRig } from "./harness/remote.ts";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const store = new DeviceStore(join(home.path, LAYOUT.data), stateDir);
	const bound: { current: DeviceBinding | null } = { current: { origin: REMOTE_ORIGIN, generation: 1 } };
	return { stateDir, store, bound, routes: { store, binding: () => bound.current } };
}
async function own(t: import("node:test").TestContext, env: ReturnType<typeof scratch>) {
	const out = await startDeviceControl(env.stateDir, env.routes, () => {});
	assert.equal(out.state, "listening", JSON.stringify(out));
	const live = out as Extract<typeof out, { state: "listening" }>;
	t.after(() => live.stop());
	return live;
}
const mode = (path: string) => statSync(path).mode & 0o777;
/** Raw bytes to the owner socket; resolves with everything it said before closing. */
function raw(path: string, data: string): Promise<string> {
	return new Promise((done) => {
		const socket = createConnection(path);
		let text = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => { text += chunk; });
		socket.on("close", () => done(text));
		socket.on("error", () => {});
		socket.once("connect", () => socket.write(data));
	});
}
const ok = (reply: Awaited<ReturnType<typeof deviceControlRequest>>) => {
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply.result as Record<string, unknown>;
};

test("owner-only files; status, pair, list and revoke go through the one store and its audit; refusals are typed", async (t) => {
	const env = scratch(t);
	await own(t, env);
	assert.equal(mode(deviceControlDir(env.stateDir)), 0o700);
	assert.equal(mode(deviceControlRecordFile(env.stateDir)), 0o600);
	assert.equal(mode(deviceControlSocket(env.stateDir)), 0o600);

	assert.deepEqual(ok(await deviceControlRequest(env.stateDir, "status")), { pid: process.pid, running: true, origin: REMOTE_ORIGIN });
	const paired = ok(await deviceControlRequest(env.stateDir, "pair", { level: "view" }));
	assert.match(String(paired.link), /^https:\/\/cp\.example\.test\/pair#[A-Za-z0-9_-]{43}$/);
	assert.equal(paired.level, "view");
	const code = String(paired.link).split("#")[1]!;
	const issued = readFileSync(controlJournalFile(env.stateDir), "utf8").trim().split("\n").map((row) => JSON.parse(row));
	assert.deepEqual(issued.map((line) => [line.event, line.route]), [["code_issued", "cli-pair"]], "one secret-free attempt line names the CLI route");
	assert.equal(JSON.stringify(issued).includes(code), false, "the code never reaches the journal");
	const claimed = env.store.claim({ origin: REMOTE_ORIGIN, generation: 1, code, name: "Phone" });
	assert.ok(claimed.ok);

	const listed = ok(await deviceControlRequest(env.stateDir, "list"));
	assert.deepEqual((listed.devices as Array<{ name: string; level: string }>).map((device) => [device.name, device.level]), [["Phone", "view"]]);
	assert.equal(JSON.stringify(listed).includes(claimed.cookie.split(".")[1]!), false, "no session secret over the socket");
	const revoked = ok(await deviceControlRequest(env.stateDir, "revoke", { target: "phone" }));
	assert.equal(revoked.id, claimed.device.id, "by name, case-insensitively");

	const refused = async (op: string, args: Record<string, unknown> = {}) => {
		const reply = await deviceControlRequest(env.stateDir, op, args);
		return reply.ok ? 200 : reply.status;
	};
	assert.equal(await refused("pair", { route: "cli-up" }), 200, "cp-tunnel up issues on its own route");
	assert.equal(await refused("pair", { route: "loopback-dashboard" }), 400, "a dashboard route is the browser's, never the socket's");
	assert.equal(await refused("pair", { level: "admin" }), 400);
	assert.equal(await refused("pair", { level: "full", extra: 1 }), 400);
	assert.equal(await refused("revoke", { target: "\u0007" }), 400);
	assert.equal(await refused("revoke", { target: "nobody" }), 404);
	assert.equal(await refused("mint"), 400, "unknown op");
	env.bound.current = null;
	assert.equal(await refused("pair"), 409, "no running binding: nothing to pair with");
	assert.equal(ok(await deviceControlRequest(env.stateDir, "status")).running, false);
});

test("frames: a bad token closes unanswered; oversized, non-JSON and wrong-version frames are refused and closed", async (t) => {
	const env = scratch(t);
	const lines: string[] = [];
	const out = await startDeviceControl(env.stateDir, env.routes, (line) => lines.push(line));
	assert.equal(out.state, "listening");
	t.after(() => (out as { stop(): void }).stop());
	const socket = deviceControlSocket(env.stateDir);
	assert.equal(await raw(socket, `${JSON.stringify({ v: 1, token: "0".repeat(64), op: "list" })}\n`), "", "no answer to a stranger");
	assert.deepEqual(lines, ["viewer: device control refused a frame with a bad socket token\n"]);
	const reply = async (data: string) => JSON.parse((await raw(socket, data)).trim()) as { ok: boolean; status: number };
	assert.equal((await reply("x".repeat(DEVICE_FRAME_MAX + 1))).status, 413, "no newline yet, already too big");
	assert.equal((await reply(`${"y".repeat(DEVICE_FRAME_MAX + 1)}\n`)).status, 413);
	assert.equal((await reply("not json\n")).status, 400);
	assert.equal((await reply(`${JSON.stringify({ v: 2, op: "status" })}\n`)).status, 502);
});

test("stale owners: a live owner refuses a second; a socket nothing answers is replaced; stop removes only its own; the client refuses loose or dead records", async (t) => {
	const env = scratch(t);
	const first = await own(t, env);
	const second = await startDeviceControl(env.stateDir, env.routes, () => {});
	assert.deepEqual(second, { state: "refused", reason: `device control already served by pid ${process.pid} on ${deviceControlSocket(env.stateDir)}` });
	assert.ok((await deviceControlRequest(env.stateDir, "status")).ok, "the first owner is untouched");
	first.stop();
	assert.throws(() => statSync(deviceControlSocket(env.stateDir)), /ENOENT/);
	assert.throws(() => statSync(deviceControlRecordFile(env.stateDir)), /ENOENT/);
	assert.deepEqual(await deviceControlRequest(env.stateDir, "status"), { ok: false, status: 503, error: `no device control record at ${deviceControlRecordFile(env.stateDir)}: is the viewer running?` });

	writeFileSync(deviceControlSocket(env.stateDir), "left by a crash");
	const third = await own(t, env);
	assert.equal(third.state, "listening", "a stale socket path is replaced");
	const record = JSON.parse(readFileSync(deviceControlRecordFile(env.stateDir), "utf8")) as { pid: number };
	assert.equal(record.pid, process.pid);
	const dead = await deviceControlRequest(env.stateDir, "status", {}, 1000, () => false);
	assert.deepEqual(dead, { ok: false, status: 503, error: `stale device control record: pid ${process.pid} is not running; start the viewer` });
	chmodSync(deviceControlRecordFile(env.stateDir), 0o644);
	const loose = await deviceControlRequest(env.stateDir, "status");
	assert.equal(loose.ok, false);
	assert.match((loose as { error: string }).error, /is not an owner-only file of this user/);
});

const OWNER_CHILD = `
const { startDeviceControl } = await import(process.env.CP_DC_MODULE);
const out = await startDeviceControl(process.env.CP_DC_STATE, { store: {}, binding: () => null }, () => {});
process.stdout.write(out.state + "\\n");
if (out.state === "listening") { process.stdin.on("end", () => { out.stop(); process.exit(0); }); process.stdin.resume(); }
`;
const CLAIM_CHILD = `
import { request } from "node:http";
const port = Number(process.env.CP_PORT), body = process.env.CP_BODY;
const req = request({ host: "127.0.0.1", port, path: "/api/pair/claim", method: "POST", headers: { host: "127.0.0.1:" + port, origin: process.env.CP_ORIGIN, "content-type": "application/json", "content-length": Buffer.byteLength(body), "cf-connecting-ip": process.env.CP_IP } }, (res) => { res.resume(); res.on("end", () => process.stdout.write(res.statusCode + "\\n")); });
req.end(body);
`;
/** One child node process; resolves with its first stdout line, keeps it running until `close`. */
function child(code: string, env: Record<string, string>) {
	const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
	const exited = new Promise<void>((done) => proc.once("exit", () => done()));
	const first = new Promise<string>((done) => {
		let text = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => { text += chunk; if (text.includes("\n")) done(text.split("\n")[0]!); });
		proc.once("exit", () => done(text.trim() || "exited"));
	});
	return { proc, first, close: () => { proc.stdin.end(); return exited; } };
}

test("across processes: of five racing viewers exactly one owns the socket, and a CLI in another process reaches it", async (t) => {
	const env = scratch(t);
	const module = pathToFileURL(resolve("src/viewer/device-control.ts")).href;
	const racers = Array.from({ length: 5 }, () => child(OWNER_CHILD, { CP_DC_MODULE: module, CP_DC_STATE: env.stateDir }));
	t.after(async () => { await Promise.all(racers.map((racer) => racer.close())); });
	const results = await Promise.all(racers.map((racer) => racer.first));
	assert.deepEqual(results.filter((state) => state === "listening").length, 1, results.join(", "));
	assert.deepEqual(results.filter((state) => state === "refused").length, 4, results.join(", "));
	const winner = racers[results.indexOf("listening")]!;
	const status = ok(await deviceControlRequest(env.stateDir, "status"));
	assert.equal(status.pid, winner.proc.pid, "the record names the one owner");
	await winner.close();
	assert.throws(() => statSync(deviceControlSocket(env.stateDir)), /ENOENT/, "the owner's stop removed its socket");
});

test("across processes: six clients claiming one code at once through the owner have exactly one winner", async (t) => {
	const env = await remoteRig(t);
	const issued = env.store.issueCode({ origin: REMOTE_ORIGIN, generation: 1, route: "cli-pair" });
	assert.ok(issued.ok);
	const claims = Array.from({ length: 6 }, (_, index) => child(CLAIM_CHILD, { CP_PORT: String(env.remote.port), CP_ORIGIN: REMOTE_ORIGIN, CP_IP: `203.0.113.${index + 1}`, CP_BODY: JSON.stringify({ code: issued.code, name: `Phone ${index + 1}` }) }));
	const statuses = await Promise.all(claims.map((claim) => claim.first));
	await Promise.all(claims.map((claim) => claim.close()));
	assert.equal(statuses.filter((status) => status === "200").length, 1, statuses.join(", "));
	assert.ok(statuses.every((status) => status === "200" || /^4\d\d$/.test(status)), statuses.join(", "));
	const listed = env.store.list();
	assert.ok(listed.ok);
	assert.equal(listed.devices.length, 1, "one device, whatever the interleaving");
});
