import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initPush } from "../src/push/keys.ts";
import { pushDeliveriesFile } from "../src/viewer/push-files.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

type Hook = () => Promise<void>;

async function bench(t: import("node:test").TestContext, holdsLock: boolean, commandPost?: () => unknown) {
	const { registerPushTick } = await import("../extensions/command-post/push-tick.ts");
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initPush({ dataDir: join(home.path, LAYOUT.data), origin: "https://cp.example.com" });
	const hooks = new Map<string, Hook>();
	const post = commandPost ?? (() => ({ home: home.path, escalations: { open: () => [], list: () => [] }, awaiting: { list: () => [] }, finalFixCheckpoints: { listPending: () => [] } }));
	registerPushTick({ on: (name: string, fn: Hook) => hooks.set(name, fn) } as never, { commandPost: post } as never, () => holdsLock);
	return { home: home.path, hooks, ledger: pushDeliveriesFile(join(home.path, LAYOUT.state)) };
}

const settle = async (done: () => boolean, rounds: number) => {
	for (let i = 0; i < rounds && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
};

test("the push sweep ticks only while this session holds the parent lock", async (t) => {
	for (const holdsLock of [false, true]) {
		const { hooks, ledger } = await bench(t, holdsLock);
		await hooks.get("session_start")!();
		await settle(() => existsSync(ledger), holdsLock ? 250 : 5);
		await hooks.get("session_shutdown")!();
		assert.equal(existsSync(ledger), holdsLock, `lock held: ${holdsLock}; the catch-up tick writes the baseline`);
	}
});

test("a throwing command post is caught into one stderr line, never a rejection", async (t) => {
	const lines: string[] = [];
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
	t.after(() => {
		process.stderr.write = write;
	});
	const { hooks } = await bench(t, true, () => {
		throw new Error("no command post");
	});
	await hooks.get("session_start")!();
	await settle(() => lines.some((line) => line.includes("push tick failed")), 250);
	await hooks.get("session_shutdown")!();
	process.stderr.write = write;
	assert.ok(lines.some((line) => line === "pi-command-post: push tick failed: no command post\n"), lines.join(""));
});
