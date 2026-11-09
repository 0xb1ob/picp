/** F4: the parent's event-loop stall monitor names the operation that blocked it; native selection loads no SDK. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { nativeConfigFile } from "../../src/worker-driver.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, REPO_ROOT, startPiChild } from "../harness/index.ts";

const SLOW_TOOL = resolve(REPO_ROOT, "tests/fixtures/slow-sync-tool.ts");

// Scenario: a parent tool call blocks the event loop with synchronous work
//   Given a parent holding its home's lock, with the stall monitor running
//   When the model calls a tool that busy-waits for 6.5 s
//   Then state/daemon.log gets a loop_stall line naming that tool, with a delay of at least 5 s
test("loop stall: a deliberately slow sync tool call logs loop_stall with its name", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("slow", [
		{ kind: "tool_calls", calls: [{ name: "slow_sync_probe", args: {} }] },
		{ kind: "text", text: "done" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION, SLOW_TOOL] });
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});
	await child.prompt("run the slow probe");
	await child.waitForSettled(90_000);
	const ends = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "slow_sync_probe");
	assert.equal(ends.length, 1, "the slow tool ran once");
	const log = daemonPaths(home.path).log;
	const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.includes("loop_stall")) : [];
	const named = lines.find((line) => line.includes("tool:slow_sync_probe"));
	assert.ok(named, `a loop_stall line naming the tool in ${log}: ${JSON.stringify(lines)}`);
	assert.match(named, /cp-parent\[\d+\]: loop_stall delay_ms=\d+ lag_max_ms=\d+ lag_p99_ms=\d+ ops=\S*tool:slow_sync_probe/);
	assert.ok(Number(/delay_ms=(\d+)/.exec(named)?.[1]) >= 5_000, named);
});

// Scenario: native selection in the parent never loads the Claude Agent SDK
//   Given the research switch on and a `claude` on PATH that meets the floor
//   When the parent's nativeSelectionRefusal runs (every native dispatch, preview and resume)
//   Then it allows the job and no module it resolves is the SDK (its jiti load stalled the parent 13–16 s)
test("loop stall: native selection resolves claude without loading the Agent SDK", { timeout: 60_000 }, (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cp-f4-native-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.318 (Claude Code)'\n");
	chmodSync(join(bin, "claude"), 0o755);
	const home = join(dir, "home");
	mkdirSync(dirname(nativeConfigFile(home)), { recursive: true });
	writeFileSync(nativeConfigFile(home), JSON.stringify({ claude_research: true }));
	const script = `import { registerHooks } from "node:module";
const seen = [];
registerHooks({ resolve: (specifier, context, next) => { const resolved = next(specifier, context); seen.push(resolved.url); return resolved; } });
const { nativeSelectionRefusal } = await import(${JSON.stringify(pathToFileURL(resolve(REPO_ROOT, "src/drivers/claude.ts")).href)});
const refusal = await nativeSelectionRefusal({ home: ${JSON.stringify(home)}, jobId: "cp-f4", driver: "claude", kind: "research", role: "planner", delivery: "local", jobs: [], env: { PATH: ${JSON.stringify(bin)} } });
console.log(JSON.stringify({ refusal: refusal ?? null, sdk: seen.filter((url) => url.includes("claude-agent-sdk") || url.includes("claude-spike")) }));`;
	const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim().split("\n").at(-1)!);
	assert.deepEqual(out, { refusal: null, sdk: [] });
});
