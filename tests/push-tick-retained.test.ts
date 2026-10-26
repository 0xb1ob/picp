/**
 * Retained from tests/push-tick.test.ts (P22): registerPushTick's catch for a throwing `deps.commandPost()`.
 * No entry point reaches it: the tick starts at session_start, after the command post exists.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { initPush } from "../src/push/keys.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

type Hook = () => Promise<void>;

async function bench(t: import("node:test").TestContext, holdsLock: boolean, commandPost: () => unknown) {
	const { registerPushTick } = await import("../extensions/command-post/push-tick.ts");
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initPush({ dataDir: join(home.path, LAYOUT.data), origin: "https://cp.example.com" });
	const hooks = new Map<string, Hook>();
	registerPushTick({ on: (name: string, fn: Hook) => hooks.set(name, fn) } as never, { commandPost } as never, () => holdsLock);
	return { hooks };
}

const settle = async (done: () => boolean, rounds: number) => {
	for (let i = 0; i < rounds && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
};

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
