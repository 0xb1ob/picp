/**
 * Remote dashboard PR 2: the daemon's `device-notify` role — its one-per-home lease, its non-overlapping loop, and the
 * real child delivering a pairing alert's ledger state with no parent running, then exiting on SIGTERM. Only the
 * children this test spawns are signalled, by their own pid.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { acquireSenderLease, deviceNotifyLeaseFile, startDeviceNotifyLoop } from "../src/push/device-notify.ts";
import { readDeviceNotifications } from "../src/viewer/device-notification-files.ts";
import { DeviceStore } from "../src/viewer/device-store.ts";
import { createScratchHome } from "./harness/index.ts";

const SCRIPT = resolve(import.meta.dirname, "../src/push/device-notify.ts");

test("the lease: one holder per home; a dead, reused or torn holder is replaced; release removes only its own", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cp-sender-lease-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const live = new Set([101]);
	const isSender = (pid: number) => live.has(pid);
	const first = acquireSenderLease(dir, 101, isSender);
	assert.ok(first.ok);
	assert.equal(JSON.parse(readFileSync(deviceNotifyLeaseFile(dir), "utf8")).pid, 101);
	assert.deepEqual(acquireSenderLease(dir, 202, isSender), { ok: false, holder: 101 }, "a live sender keeps it");
	live.delete(101);
	const second = acquireSenderLease(dir, 202, isSender);
	assert.ok(second.ok, "its holder is gone (or is no longer this script): stale");
	first.release();
	assert.equal(JSON.parse(readFileSync(deviceNotifyLeaseFile(dir), "utf8")).pid, 202, "a stale holder's release never removes the new lease");
	second.release();
	assert.equal(existsSync(deviceNotifyLeaseFile(dir)), false);
	writeFileSync(deviceNotifyLeaseFile(dir), "{torn");
	assert.ok(acquireSenderLease(dir, 303, isSender).ok, "an unreadable record names no holder");
	assert.equal(JSON.parse(readFileSync(deviceNotifyLeaseFile(dir), "utf8")).pid, 303);
});

test("the loop sweeps at once, then only after each sweep settles (never overlapping), and stop waits out the current one", async () => {
	let running = 0, overlap = false, count = 0;
	let release: () => void = () => {};
	const errors: string[] = [];
	const loop = startDeviceNotifyLoop(async () => {
		count += 1;
		overlap ||= running > 0;
		running += 1;
		if (count === 2) await new Promise<void>((done) => (release = done)); // a slow sweep
		running -= 1;
		if (count === 3) throw new Error("a throwing sweep does not stop the loop");
	}, 5, (error) => errors.push((error as Error).message));
	assert.equal(count, 1, "the first sweep starts immediately");
	// Wait on conditions, not fixed sleeps: a loaded CI runner may be slow to fire 5 ms timers.
	const until = async (ok: () => boolean, why: string): Promise<void> => {
		for (const deadline = Date.now() + 5_000; !ok(); await new Promise((done) => setTimeout(done, 5))) assert.ok(Date.now() < deadline, why);
	};
	await until(() => count === 2, "the second sweep starts after the first settles");
	await new Promise((done) => setTimeout(done, 40));
	assert.equal(count, 2, "nothing starts while a sweep is in flight");
	release();
	await until(() => count >= 4, `the loop survives a throw (${count})`);
	assert.deepEqual(errors, ["a throwing sweep does not stop the loop"], "and reports it, never swallows it");
	await loop.stop();
	const after = count;
	await new Promise((done) => setTimeout(done, 30));
	assert.equal(count, after, "no sweep after stop");
	assert.equal(overlap, false);
});

async function until<T>(read: () => T | undefined, ms = 15_000): Promise<T> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 50))) {
		const value = read();
		if (value !== undefined) return value;
	}
	throw new Error("timed out");
}

test("the real sender records a new pairing's alert with no parent running, refuses a second sender, and exits 0 on SIGTERM", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state), dataDir = join(home.path, LAYOUT.data);
	mkdirSync(stateDir, { recursive: true });
	const store = new DeviceStore(dataDir, stateDir);
	const issued = store.issueCode({ origin: "https://cp.example.test", generation: 1, route: "cli-up" });
	assert.ok(issued.ok);
	const claimed = store.claim({ origin: "https://cp.example.test", generation: 1, code: issued.code, name: "Phone" });
	assert.ok(claimed.ok);
	const env = { PATH: process.env.PATH ?? "", HOME: home.path, CP_HOME: home.path };
	const start = () => {
		const child = spawn(process.execPath, [SCRIPT], { env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
		return { child, exited, stderr: () => stderr };
	};
	const sender = start();
	t.after(() => {
		if (sender.child.exitCode === null) sender.child.kill("SIGKILL");
	});
	const item = await until(() => {
		const read = readDeviceNotifications(stateDir);
		return read.state === "invalid" ? undefined : read.ledger.items.find((entry) => entry.pairing_id === claimed.pairing_id);
	});
	assert.equal(item.state, "unavailable", "push is not set up: an honest open state, not a delivery");
	assert.equal(JSON.parse(readFileSync(deviceNotifyLeaseFile(stateDir), "utf8")).pid, sender.child.pid);
	const second = start();
	assert.equal(await second.exited, 1);
	assert.match(second.stderr(), new RegExp(`another pairing-alert sender \\(pid ${sender.child.pid}\\) holds`));
	sender.child.kill("SIGTERM");
	assert.equal(await sender.exited, 0);
	assert.equal(existsSync(deviceNotifyLeaseFile(stateDir)), false, "its lease is released");
});
