/**
 * The native-Claude parent's spawn seam (S1a) through the real `CpBridge.start` and the operator's `cp_parent start`:
 * `data/parent.json` `driver: "claude"` starts src/drivers/claude-parent.ts; the default still starts pi.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { stopParentHosts, teardownHome } from "../harness/parent-hosts.ts";
import { FAKE_NATIVE_MODEL, startClaudeMockProvider, subscriberEnv } from "../harness/claude-mock-provider.ts";
import { layoutForHome } from "../../src/contracts.ts";
import { buildParentArgv, CpBridge, parentSkillPaths } from "../../src/cp-bridge.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, REPO_ROOT, type ScratchHome, startPiChild, waitFor } from "../harness/index.ts";

const FAKE_PARENT = join(REPO_ROOT, "tests/fixtures/fake-parent.mjs");
const ENTRY = join(PACKAGE_ROOT, "src/drivers/claude-parent.ts");
const LINUX = process.platform === "linux" ? false : "reads the parent's argv from /proc";

function scratchHome(parent?: Record<string, unknown>): ScratchHome {
	const home = createScratchHome();
	const data = join(home.path, layoutForHome("multi", home.path).data);
	mkdirSync(data, { recursive: true });
	if (parent) writeFileSync(join(data, "parent.json"), JSON.stringify(parent));
	return home;
}

/** A scratch home and a bridge on it; the bridge stops before the home is removed. */
function fixture(t: TestContext, parent?: Record<string, unknown>): { home: string; bridge: CpBridge } {
	const home = scratchHome(parent);
	const bridge = new CpBridge();
	t.after(async () => { try { await bridge.stop(); } finally { home.cleanup(); } });
	return { home: home.path, bridge };
}

const cmdline = (pid: number): string[] => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
const promptFile = (home: string) => join(home, layoutForHome("multi", home).sessions, "native-parent-system-prompt.md");

/** Sets `values` on process.env for the test (the bridge's child inherits them); restored after. */
function withEnv(t: TestContext, values: Record<string, string>): void {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

// Scenario: Given data/parent.json says driver "claude" and the model is an anthropic/claude-* ref,
// When CpBridge.start runs, Then process.execPath runs claude-parent.ts with --session/--model/--system-prompt-file
// (never pi's --mode rpc), the contract is a 0600 file, get_state answers the boot and no model call is made,
// And stop ends the entry with exit code 0.
test("native parent: driver claude starts the claude-parent entry and its get_state answers the boot", { skip: LINUX, timeout: 30_000 }, async (t) => {
	const provider = await startClaudeMockProvider([]);
	t.after(() => provider.close());
	withEnv(t, subscriberEnv(provider.url));
	const { home, bridge } = fixture(t, { driver: "claude" });
	const started = await bridge.start({ home, mode: "multi", model: FAKE_NATIVE_MODEL, piBin: FAKE_PARENT, requestTimeoutMs: 10_000 });
	assert.equal(started.already, false);
	assert.equal(started.start, "clean");
	assert.equal(bridge.status().alive, true);
	const argv = cmdline(started.pid!);
	assert.deepEqual(argv, [process.execPath, ENTRY, "--session", started.sessionFile, "--model", FAKE_NATIVE_MODEL, "--system-prompt-file", promptFile(home)]);
	assert.equal(argv.includes("--mode"), false, "no pi --mode rpc flag reaches the native entry");
	assert.equal(statSync(promptFile(home)).mode & 0o777, 0o600);
	assert.equal(readFileSync(promptFile(home), "utf8"), `${readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8").trimEnd()}\n`);
	assert.equal(provider.requests.length, 0, "booting the entry calls no model");
	const exit = await bridge.stop();
	assert.equal(exit?.code, 0);
});

// Scenario: Given data/parent.json with no driver key, When CpBridge.start runs,
// Then the pi parent starts exactly as before: buildParentArgv's `--mode rpc` argv with the command-post extension,
// And no native system-prompt file is written.
test("native parent: the default driver starts pi with today's argv", { timeout: 30_000 }, async (t) => {
	const { home, bridge } = fixture(t, { compact_at_tokens: 100000 });
	const argvFile = join(home, "fake-parent.argv");
	withEnv(t, { FAKE_PARENT_ARGV: argvFile });
	const started = await bridge.start({ home, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, commandPostExtension: COMMAND_POST_EXTENSION, requestTimeoutMs: 10_000 });
	const recorded = (JSON.parse(readFileSync(argvFile, "utf8").trim()) as string[]).slice(2);
	assert.deepEqual(recorded.slice(0, 2), ["--mode", "rpc"]);
	assert.deepEqual(recorded, buildParentArgv({ sessionFile: started.sessionFile, model: "mock/parent", extension: COMMAND_POST_EXTENSION, skills: parentSkillPaths(home) }));
	assert.equal(existsSync(promptFile(home)), false);
});

// Scenario: Given driver "claude", When the start model is not anthropic/claude-*, or parent.json names a non-Claude
// model or an unknown driver, Then CpBridge.start refuses by name before any process starts (no pi, no prompt file).
test("native parent: driver claude refuses a non-Claude model and an unknown driver before spawn", { timeout: 30_000 }, async (t) => {
	const argvFile = join(fixture(t).home, "fake-parent.argv");
	withEnv(t, { FAKE_PARENT_ARGV: argvFile });
	for (const [parent, model, refusal] of [
		[{ driver: "claude" }, "mock/parent", /claude parent driver runs an explicit anthropic\/claude-… model, and mock\/parent is not one/],
		[{ driver: "claude", model: "mock/parent" }, FAKE_NATIVE_MODEL, /parent\.json driver claude runs an explicit anthropic\/claude-… model, not "mock\/parent"/],
		[{ driver: "claud" }, FAKE_NATIVE_MODEL, /parent\.json driver must be "pi" or "claude", not "claud"/],
	] as const) {
		const { home, bridge } = fixture(t, parent);
		await assert.rejects(bridge.start({ home, mode: "multi", model, piBin: FAKE_PARENT, requestTimeoutMs: 10_000 }), refusal);
		assert.equal(bridge.status().alive, false);
		assert.equal(existsSync(argvFile), false, "no pi parent was spawned");
		assert.equal(existsSync(promptFile(home)), false);
	}
});

// Scenario: Given an operator session whose pi registry does not know anthropic/claude-picp-fake,
// When cp_parent start names it for a default home, Then the pi probe refuses it as today,
// And for a home whose parent.json says driver "claude" the same model starts the native entry without the probe.
test("native parent: cp_parent start accepts an anthropic/claude model on driver claude without the pi probe", { skip: LINUX, timeout: 90_000 }, async (t) => {
	const native = scratchHome({ driver: "claude" });
	const plain = scratchHome();
	const provider = await MockProvider.start();
	const start = (home: string) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_parent", args: { action: "start", home, mode: "multi", model: FAKE_NATIVE_MODEL } }] });
	const model = provider.addScript("native-parent-start", [start(plain.path), start(native.path), { kind: "text", text: "done" }]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({ cwd: native.path, model, env: { ...agentDir.env, CP_PARENT_PI_BIN: FAKE_PARENT }, extensions: [CP_BRIDGE_EXTENSION] });
	let entry: number | undefined;
	const entryAlive = () => { try { return cmdline(entry!).includes(ENTRY); } catch { return false; } };
	// The entry exits on stdin end once its host is stopped; it is killed by pid only if it does not.
	const stopEntry = async () => {
		if (entry === undefined) return;
		await waitFor(entryAlive, (up) => !up, { timeoutMs: 5_000, what: "the native entry to exit with its host" }).catch(() => process.kill(entry!, "SIGKILL"));
	};
	t.after(() => teardownHome(native, () => child.close(), () => stopParentHosts(native.path), stopEntry, () => agentDir.cleanup(), () => provider.stop(), () => plain.cleanup()));
	await child.prompt("Start the parent.");
	await child.waitForSettled();
	const results = child.eventsOfType("tool_execution_end").map((event) => JSON.stringify(event));
	assert.equal(results.length, 2, results.join("\n"));
	assert.match(results[0]!, /cp_parent start refuses anthropic\/claude-picp-fake: not available/);
	const pid = /started clean pid=(\d+)/.exec(results[1]!)?.[1];
	assert.ok(pid, results[1]);
	entry = Number(pid);
	assert.deepEqual(cmdline(entry).slice(0, 2), [process.execPath, ENTRY]);
});
