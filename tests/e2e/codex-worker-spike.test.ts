/**
 * Codex C0 spike CX-0a…0h through `runCodexSpike` on tests/fixtures/fake-codex.ts (no `codex` needed). No product entry
 * point selects codex before C1, so the spike's own entry is the boundary. Each case checks the synthetic Codex home is
 * untouched and no OPENAI_* or CODEX_* key but CODEX_HOME reached an app-server child.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { isPidAlive } from "../../src/fleet.ts";
import { codexHookTrust, codexSpawnArgs, type CodexSpikeResult } from "../../src/drivers/codex-spike.ts";
import { spawnCodexRpc } from "../../src/drivers/codex-rpc.ts";
import {
	AUTH_SENTINEL,
	type CodexFixture,
	codexFixture,
	type FakeCodexScript,
	fakeExecuted,
	fakeHooks,
	fakePids,
	fakeRpcMethods,
	fakeSpawns,
	fakeThreadTotal,
} from "../harness/codex-mock.ts";

const JOB = "cp-codex-spike-e2e";
const HOOK_FAIL = new URL("../fixtures/codex-hook-fail.mjs", import.meta.url).pathname;

const report = (fx: CodexFixture, overrides: Record<string, unknown> = {}) => ({
	job_id: JOB, kind: "research", status: "done", summary: "Codex spike findings filed.", artifact_path: fx.artifactPath,
	plan_summary: { goal: "g", approach: ["a"], acceptance: ["x"], risk: "r", touched: ["t"] }, ...overrides,
});

function fixture(t: { after: (fn: () => void) => void }, script: FakeCodexScript): CodexFixture {
	const fx = codexFixture(t, JOB, script);
	writeFileSync(fx.artifactPath, "# Findings\n\nok\n");
	return fx;
}

/** The invariants every case shares: the Codex home is untouched, and no host OPENAI_/CODEX_ key reached the CLI. */
function assertClean(fx: CodexFixture, result?: CodexSpikeResult): void {
	assert.deepEqual(fx.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(fx.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server")) {
		assert.deepEqual(spawn.env.filter((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
		assert.ok(spawn.env.includes("CODEX_HOME"));
	}
	if (result !== undefined) assert.ok(!JSON.stringify(result).includes(AUTH_SENTINEL));
}

async function until(check: () => boolean, what: string, ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(25);
	}
}

test("CX-0a: one report is filed for this job; another job's report and a different second report are refused", { timeout: 120_000 }, async (t) => {
	const fx = fixture(t, { turns: [] });
	const tool = (args: unknown) => ({ kind: "tool" as const, tool: "report_result", arguments: args });
	fx.setScript({ turns: [[tool(report(fx, { job_id: "cp-someone-else" })), tool(report(fx)), tool(report(fx)), tool(report(fx, { summary: "A different report." })), { kind: "message", text: "done" }]] });
	const result = await fx.run();
	assert.equal(result.outcome, "completed", result.error);
	assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal);
	assert.equal(result.report?.job_id, JOB);
	assert.equal(result.reportRefusals.length, 2, result.reportRefusals.join("\n"));
	assert.match(result.reportRefusals[0] ?? "", /job_id: must be "cp-codex-spike-e2e"/);
	assert.match(result.reportRefusals[1] ?? "", /already filed/);
	const filed = JSON.parse(readFileSync(join(fx.runDir, "envelope.json"), "utf8")) as { envelope: { job_id: string; summary: string } };
	assert.deepEqual([filed.envelope.job_id, filed.envelope.summary], [JOB, "Codex spike findings filed."]);
	assert.equal(result.usage.status, "complete");
	assert.equal(result.ticketMatch.none, 0);
	assert.deepEqual(result.exit, { code: 0, signal: null, killedByDriver: false });
	assertClean(fx, result);
});

test("CX-0b: a denied command does not run, at the hook layer or, with the hook skipped, at the approval layer", { timeout: 120_000 }, async (t) => {
	const fx = fixture(t, { turns: [] });
	const outHook = join(fx.root, "out-hook");
	const outApproval = join(fx.root, "out-approval");
	fx.setScript({ turns: [[
		{ kind: "shell", command: "cat README.md" },
		{ kind: "shell", command: `touch ${outHook}` },
		{ kind: "shell", command: `touch ${outApproval}`, hook: "skip" },
		{ kind: "shell", command: `cat ${join(fx.codexHome, "auth.json")}` },
		{ kind: "shell", command: 'cat "$CODEX_HOME/auth.json"' },
	]] });
	const result = await fx.run();
	assert.equal(result.outcome, "completed", result.error);
	assert.equal(existsSync(outHook), false);
	assert.equal(existsSync(outApproval), false);
	assert.deepEqual(fakeExecuted(fx.stateDir), ["cat README.md"]);
	assert.deepEqual(result.denials.map((d) => d.layer), ["hook", "approval", "hook", "hook"], JSON.stringify(result.denials));
	assert.match(result.denials[1]?.reason ?? "", /^Refused: a native planner's Bash writing to/);
	assert.match(result.denials[3]?.reason ?? "", /Codex home/);
	assert.equal(result.ticketMatch.id, 1);
	assertClean(fx, result);
});

test("CX-0c: a killed, timed-out or unreachable hook lets nothing run, and a failed hook stops the report tool", { timeout: 180_000 }, async (t) => {
	// Control: the fake fails open, so a hook exiting 1 with approvals off does run its command.
	const control = fixture(t, { turns: [[{ kind: "shell", command: "echo control-ran" }]] });
	const env = { PATH: `${join(control.root, "bin")}:${process.env.PATH ?? ""}`, HOME: control.root, CODEX_HOME: control.codexHome };
	const args = { hookCommand: `'${process.execPath}' '${HOOK_FAIL}' exit1` };
	const trust = await codexHookTrust("codex", codexSpawnArgs(args), control.worktree, env);
	const rpc = spawnCodexRpc({ command: "codex", args: codexSpawnArgs({ ...args, trust }), cwd: control.worktree, env });
	const completed = new Promise<void>((done) => rpc.onNotification(({ method }) => method === "turn/completed" && done()));
	await rpc.request("initialize", { clientInfo: { name: "control", version: "0" } });
	const thread = await rpc.request<{ thread: { id: string } }>("thread/start", { cwd: control.worktree, approvalPolicy: "never" });
	await rpc.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "go" }] });
	await completed;
	rpc.closeInput();
	await rpc.exited;
	assert.deepEqual(fakeExecuted(control.stateDir), ["echo control-ran"]);
	assert.equal(fakeHooks(control.stateDir)[0]?.status, "failed");

	for (const [mode, extra] of [["kill", {}], ["stall", { hookTimeoutSec: 1, hookClientTimeoutMs: 5_000 }]] as const) {
		const sentinel = join(control.root, `ran-${mode}`);
		const fx = fixture(t, { turns: [[{ kind: "shell", command: `touch ${sentinel}`, hook: mode }, { kind: "shell", command: "cat README.md" }]] });
		const result = await fx.run(extra);
		assert.equal(existsSync(sentinel), false, mode);
		assert.deepEqual(fakeExecuted(fx.stateDir), [], mode);
		assert.equal(fakeHooks(fx.stateDir)[0]?.status, "failed", mode);
		assert.equal(result.hookFailed, true, mode);
		assert.deepEqual(result.denials.map((d) => d.layer), ["approval"], mode);
		assert.match(result.denials[0]?.reason ?? "", /no hook verdict/);
		assert.equal(result.outcome, "interrupted", mode);
		assertClean(fx, result);
	}

	const missing = fixture(t, { turns: [[{ kind: "shell", command: "cat README.md", hook: "unlink" }]] });
	const gone = await missing.run();
	assert.deepEqual(fakeExecuted(missing.stateDir), []);
	assert.equal(fakeHooks(missing.stateDir)[0]?.status, "blocked");
	assert.match(fakeHooks(missing.stateDir)[0]?.stderr ?? "", /could not reach its worker \(connect: ENOENT\)/);
	assertClean(missing, gone);

	const fx = fixture(t, { turns: [] });
	fx.setScript({ turns: [[{ kind: "tool", tool: "report_result", arguments: report(fx), hook: "kill" }]] });
	const result = await fx.run();
	assert.equal(result.report, undefined);
	assert.equal(existsSync(join(fx.runDir, "envelope.json")), false);
	assert.deepEqual(result.denials.map((d) => d.layer), ["tool_call"]);
	assert.equal(result.hookFailed, true);
	assertClean(fx, result);
});

test("CX-0d: an untrusted hook refuses the run before any thread or turn", { timeout: 60_000 }, async (t) => {
	const fx = fixture(t, { knobs: { trust: "ignore" }, turns: [[{ kind: "shell", command: "cat README.md" }]] });
	const result = await fx.run();
	assert.equal(result.outcome, "refused");
	assert.match(result.error ?? "", /picp's hook is not trusted \(untrusted\)/);
	const methods = fakeRpcMethods(fx.stateDir);
	assert.ok(!methods.includes("thread/start") && !methods.includes("turn/start"), methods.join(","));
	assert.deepEqual(fakeExecuted(fx.stateDir), []);
	assertClean(fx, result);
});

test("CX-0e: an extra MCP server, hook, skill or instruction source refuses the run with counts and starts no turn", { timeout: 120_000 }, async (t) => {
	for (const [knob, key] of [["extraMcpServers", "mcpServers"], ["extraHooks", "hooks"], ["extraSkills", "skills"], ["instructionSources", "instructionSources"]] as const) {
		const fx = fixture(t, { knobs: { [knob]: 1 }, turns: [[{ kind: "shell", command: "cat README.md" }]] });
		const result = await fx.run();
		assert.equal(result.outcome, "refused", knob);
		assert.equal(result.lockdown?.extra[key], 1, knob);
		assert.match(result.error ?? "", new RegExp(`${key} 1`), knob);
		assert.doesNotMatch(result.error ?? "", /stray/, knob);
		assert.ok(!fakeRpcMethods(fx.stateDir).includes("turn/start"), knob);
		assertClean(fx, result);
	}
});

test("CX-0f: usage is counted once across a resume, with or without the previous totals", { timeout: 120_000 }, async (t) => {
	const message = { kind: "message" as const, text: "step" };
	const fx = fixture(t, { turns: [[message, message], [message, message], [message]] });
	const first = await fx.run();
	assert.equal(first.usage.status, "complete");
	const second = await fx.run({ resume: { threadId: first.threadId as string, ...(first.totals ? { baseline: first.totals } : {}) } });
	assert.equal(second.usage.status, "complete");
	const stored = fakeThreadTotal(fx.stateDir, first.threadId as string);
	const total = (u: CodexSpikeResult["usage"]) => (u.status === "complete" ? u.total : Number.NaN);
	assert.equal(total(first.usage) + total(second.usage), stored.totalTokens);
	const third = await fx.run({ resume: { threadId: first.threadId as string } });
	assert.deepEqual(third.usage, { status: "complete", input: 60, cache_read: 40, cache_write: 0, output: 10, reasoning: 5, total: 110, cost_unknown: true });

	const off = fixture(t, { knobs: { usage: false }, turns: [[message]] });
	assert.equal((await off.run()).usage.status, "unavailable");
	assertClean(fx, third);
});

test("CX-0g: an aborted turn is interrupted and every reported command process is ended, even when terminate is a no-op", { timeout: 120_000 }, async (t) => {
	for (const knobs of [{}, { terminate: "noop" }]) {
		const fx = fixture(t, { knobs, turns: [[{ kind: "shell", command: "sleep 300", background: true }, { kind: "hold", marker: "held" }]] });
		const abort = new AbortController();
		const running = fx.run({ signal: abort.signal });
		await until(() => existsSync(join(fx.stateDir, "held")) && fakeRpcMethods(fx.stateDir).includes("thread/backgroundTerminals/list"), "the held turn");
		abort.abort();
		const result = await running;
		assert.equal(result.outcome, "interrupted", result.error);
		const methods = fakeRpcMethods(fx.stateDir);
		const tail = methods.slice(methods.indexOf("turn/interrupt"));
		assert.deepEqual(tail.filter((m) => m.startsWith("thread/backgroundTerminals/") || m === "turn/interrupt").slice(0, 3),
			["turn/interrupt", "thread/backgroundTerminals/list", "thread/backgroundTerminals/terminate"]);
		const [pid] = fakePids(fx.stateDir);
		assert.equal(isPidAlive(pid as number), false);
		assert.ok(result.leftovers.length > 0 && result.leftovers.every((each) => each.gone));
		assert.equal(result.leftovers[0]?.terminated, !("terminate" in knobs));
		assertClean(fx, result);
	}
});

test("CX-0h: an app-server that exits 0 on SIGTERM mid-turn is a stop, not a success, and its command pid is gone", { timeout: 120_000 }, async (t) => {
	const fx = fixture(t, { turns: [[{ kind: "shell", command: "sleep 300", background: true }, { kind: "hold", marker: "held" }]] });
	const running = fx.run();
	await until(() => existsSync(join(fx.stateDir, "held")) && fakeRpcMethods(fx.stateDir).includes("thread/backgroundTerminals/list"), "the held turn");
	const server = fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server").at(-1);
	process.kill(server?.pid as number, "SIGTERM");
	const result = await running;
	assert.deepEqual(result.exit, { code: 0, signal: null, killedByDriver: false });
	assert.equal(result.outcome, "stopped");
	assert.equal(result.report, undefined);
	assert.match(result.error ?? "", /exited before turn\/completed/);
	const [pid] = fakePids(fx.stateDir);
	assert.equal(isPidAlive(pid as number), false);
	assertClean(fx, result);
});
