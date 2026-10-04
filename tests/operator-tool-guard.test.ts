/**
 * N2: the operator session's tool_call guard (extensions/cp-bridge/index.ts). Its turn never sleeps or polls
 * CI inside a call, and it writes only its own files.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import bridgeExtension, { operatorToolRefusal } from "../extensions/cp-bridge/index.ts";
import { layoutForHome } from "../src/contracts.ts";

function scratch(t: { after: (fn: () => void) => void }): { home: string; mode: "multi" } {
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { home: join(dir, ".pi-command-post"), mode: "multi" };
}

test("operator bash: a CI poll loop and an updater sleep loop are refused; one-shot reads and quotes are not", (t) => {
	const target = scratch(t);
	const refuse = (command: string) => operatorToolRefusal("bash", { command }, target.home, () => target);
	for (const command of [
		"for i in $(seq 1 20); do gh run list --branch main --limit 1; sleep 15; done",
		"for i in $(seq 1 60); do sleep 20; jq .state state/update.json; done",
		"sleep 120; gh run list --branch main",
		"gh run watch 123",
	]) {
		const reason = refuse(command);
		assert.ok(reason, `missed: ${command}`);
		assert.match(reason, /cp-bridge wake/);
		assert.match(reason, /state\/update\.json/);
	}
	for (const command of ["gh run list --branch main --limit 3 --json conclusion,status,headSha", "sleep 5", 'grep -rn "sleep 20" operator/', "cat state/update.json"]) {
		assert.equal(refuse(command), undefined, `wrongly refused: ${command}`);
	}
});

test("operator write/edit: only operator/, state/task-files/ and exactly data/standing-orders.md", (t) => {
	const target = scratch(t);
	const layout = layoutForHome(target.mode, target.home);
	const at = (...parts: string[]) => join(target.home, ...parts);
	const decide = (tool: string, path: string, cwd = target.home) => operatorToolRefusal(tool, { path }, cwd, () => target);
	for (const path of [at(layout.operatorWorkspace, "tasks", "x.md"), at(layout.state, "task-files", "brief.md"), at(layout.data, "standing-orders.md")]) {
		assert.equal(decide("write", path), undefined, `wrongly refused: ${path}`);
		assert.equal(decide("edit", path), undefined, `wrongly refused: ${path}`);
	}
	// Relative to the session cwd, as pi resolves it.
	assert.equal(decide("write", join(layout.operatorWorkspace, "scratch", "n.md")), undefined);
	for (const path of [
		at(layout.data, "mandate-defaults.json"),
		at(layout.state, "task-files-x.md"),
		at(layout.state, "fleet.json"),
		at(layout.data, "standing-orders.md.bak"),
		`${at(layout.operatorWorkspace)}/../${layout.data}/learnings.md`,
		at(layout.operatorWorkspace),
		join(target.home, "..", "elsewhere.md"),
	]) {
		const reason = decide("edit", path);
		assert.ok(reason, `missed: ${path}`);
		assert.match(reason, /writes only under/);
	}
	// Other tools are none of this guard's business.
	assert.equal(operatorToolRefusal("read", { path: at(layout.data, "mandate-defaults.json") }, target.home, () => target), undefined);
	// No home: refused with the cause, never silently allowed.
	assert.match(operatorToolRefusal("write", { path: "x.md" }, target.home, () => { throw new Error("no home"); }) ?? "", /no command-post home resolves.*no home/);
});

test("the bridge registers the guard as a blocking tool_call hook", async (t) => {
	const target = scratch(t);
	const previous = { CP_HOME: process.env.CP_HOME, CP_MODE: process.env.CP_MODE, PI_HOME: process.env.PI_HOME };
	Object.assign(process.env, { CP_HOME: target.home, CP_MODE: "multi", PI_HOME: join(target.home, "..", "pi") });
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	const [hook] = handlers.get("tool_call") ?? [];
	assert.ok(hook, "a tool_call hook is registered");
	const ctx = { hasUI: false, cwd: target.home };
	const blocked = (await hook({ toolName: "bash", input: { command: "while true; do sleep 30; done" } }, ctx)) as { block?: boolean; reason?: string } | undefined;
	assert.equal(blocked?.block, true);
	assert.equal(await hook({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
});
