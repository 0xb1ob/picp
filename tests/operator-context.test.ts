import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import bridgeExtension from "../extensions/cp-bridge/index.ts";
import { layoutForHome, LAYOUT } from "../src/contracts.ts";
import { operatorStartContext } from "../src/operator-context.ts";
import { createScratchHome } from "./harness/index.ts";

function scratch(): string {
	return join(mkdtempSync(join(tmpdir(), "cp-opctx-")), ".pi-command-post");
}

test("a fresh main session gets the orders, the learnings and the newest handoff by mtime", () => {
	const home = scratch();
	try {
		const layout = layoutForHome("multi", home);
		const handoffs = join(home, layout.operatorWorkspace, "handoffs");
		mkdirSync(join(home, layout.data), { recursive: true });
		mkdirSync(handoffs, { recursive: true });
		writeFileSync(join(home, layout.data, "standing-orders.md"), "# Standing orders\n- Best result per dollar.\n");
		writeFileSync(join(home, layout.learningsFile), "<!-- header\n- 2000-01-01 not an entry\n-->\n- 2026-09-01 keep me\n");
		// Name order and mtime order disagree: `compact` sorts last but is older.
		writeFileSync(join(handoffs, "main-session-compact-a.md"), "old");
		writeFileSync(join(handoffs, "main-session-2026-09-29.md"), "new");
		utimesSync(join(handoffs, "main-session-compact-a.md"), 1000, 1000);
		const text = operatorStartContext(home, "multi") ?? "";
		assert.match(text, /read-only; preferences, not authorization/);
		assert.match(text, /Best result per dollar/);
		assert.match(text, /keep me/);
		assert.doesNotMatch(text, /not an entry/);
		assert.match(text, /main-session-2026-09-29\.md/);
		assert.doesNotMatch(text, /compact-a/);
	} finally { rmSync(join(home, ".."), { recursive: true, force: true }); }
});

test("an empty home has no start context and building it creates no file", () => {
	const home = scratch();
	try {
		assert.equal(operatorStartContext(home, "multi"), undefined);
		assert.equal(existsSync(home), false);
	} finally { rmSync(join(home, ".."), { recursive: true, force: true }); }
});

test("the bridge sends one hidden cp-operator-context to a fresh session and none to a resumed one", async (t) => {
	const home = createScratchHome();
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "standing-orders.md"), "- Best result per dollar.\n");
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const sent: Array<{ message: { customType: string; content: string; display: boolean }; options: unknown }> = [];
	const emit = async (event: string, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
	t.after(async () => {
		await emit("session_shutdown");
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		home.cleanup();
	});
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: never, options: unknown) => void sent.push({ message, options }),
		sendUserMessage: () => {},
	} as never);
	const session = (entries: unknown[]) => ({ hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home.path, "operator.jsonl"), getEntries: () => entries } });
	await emit("session_start", session([]));
	const contexts = sent.filter((item) => item.message.customType === "cp-operator-context");
	assert.equal(contexts.length, 1);
	assert.equal(contexts[0]!.message.display, false);
	assert.deepEqual(contexts[0]!.options, { triggerTurn: false });
	assert.match(contexts[0]!.message.content, /Best result per dollar/);
	sent.length = 0;
	await emit("session_start", session([{ type: "message" }]));
	assert.equal(sent.filter((item) => item.message.customType === "cp-operator-context").length, 0);
});
