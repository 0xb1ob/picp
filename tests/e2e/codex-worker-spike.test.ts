/**
 * Codex CX-0a…0j (C0) and CX-1d/1g/1h (C1a) through `runCodexSpike` on tests/fixtures/fake-codex.ts. No entry point
 * selects codex yet, so the run core's own entry is the boundary. Each case checks the synthetic Codex home is
 * untouched and no OPENAI_* or CODEX_* key but CODEX_HOME reached an app-server child.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { isPidAlive } from "../../src/fleet.ts";
import { codexHookTrust, codexPermissionProfile, codexSpawnArgs, type CodexSpikeResult, type CodexToolEvent } from "../../src/drivers/codex-spike.ts";
import { resolveCodexContainment } from "../../src/drivers/codex-containment.ts";
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
	fakeScopes,
	fakeSpawns,
	fakeThreadTotal,
	OUTSIDE_SENTINEL,
	spawnSpikeDriver,
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
	const env = { PATH: `${control.bin}:${process.env.PATH ?? ""}`, HOME: control.root, CODEX_HOME: control.codexHome };
	const profile = codexPermissionProfile({ worktree: control.worktree, tmp: join(control.root, "tmp") });
	const args = { hookCommand: `'${process.execPath}' '${HOOK_FAIL}' exit1`, profile };
	const containment = resolveCodexContainment(env);
	const trust = await codexHookTrust("codex", codexSpawnArgs(args), control.worktree, env, containment);
	const rpc = spawnCodexRpc({ command: "codex", args: codexSpawnArgs({ ...args, trust }), cwd: control.worktree, env, containment });
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
		const fx = fixture(t, { knobs: { modelMs: 500 }, turns: [[{ kind: "shell", command: `touch ${sentinel}`, hook: mode }, { kind: "shell", command: "cat README.md" }]] });
		const result = await fx.run(extra);
		assert.equal(existsSync(sentinel), false, mode);
		assert.deepEqual(fakeExecuted(fx.stateDir), [], mode);
		assert.equal(fakeHooks(fx.stateDir)[0]?.status, "failed", mode);
		assert.equal(result.hookFailed, true, mode);
		assert.deepEqual(result.denials.map((d) => d.layer), ["approval"], mode);
		assert.match(result.denials[0]?.reason ?? "", /no hook verdict/);
		assert.equal(result.outcome, "stopped", mode);
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

test("CX-0i: the scope kill ends a command the CLI lists with no osPid, on a stop, an own exit and a killed driver", { timeout: 180_000 }, async (t) => {
	// LS-3d on 0.170.0: the interrupted command has no osPid and `terminate` says true but kills nothing. Only the
	// cgroup scope can end it; without the scope kill each of the three ends below leaves the sleep alive.
	const knobs = { osPid: "omit", terminate: "lie" };
	const turns = [[{ kind: "shell" as const, command: "sleep 300", background: true }, { kind: "hold" as const, marker: "held" }]];
	const held = (fx: CodexFixture) => until(() => existsSync(join(fx.stateDir, "held")) && fakeRpcMethods(fx.stateDir).includes("thread/backgroundTerminals/list"), "the held turn");
	const appServer = (fx: CodexFixture) => fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server").at(-1)?.pid as number;
	const allDead = async (fx: CodexFixture, what: string) => {
		const pids = [...fakePids(fx.stateDir), ...fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server").map((each) => each.pid)];
		await until(() => !pids.some(isPidAlive), `${what}: every command and app-server pid gone`, 10_000);
		await until(() => fakeScopes(fx.stateDir).filter((each) => each.killed !== undefined).length === fakeScopes(fx.stateDir).filter((each) => each.started).length, `${what}: every scope killed`, 10_000);
	};

	const stop = fixture(t, { knobs, turns });
	const abort = new AbortController();
	const running = stop.run({ signal: abort.signal });
	await held(stop);
	abort.abort();
	const stopped = await running;
	assert.equal(stopped.outcome, "interrupted", stopped.error);
	assert.ok(stopped.leftovers.length > 0 && stopped.leftovers.every((each) => each.osPid === undefined && each.terminated), JSON.stringify(stopped.leftovers));
	await allDead(stop, "stop");
	assertClean(stop, stopped);

	const own = fixture(t, { knobs, turns });
	const ownRun = own.run();
	await held(own);
	process.kill(appServer(own), "SIGTERM");
	const exited = await ownRun;
	assert.equal(exited.outcome, "stopped");
	assert.deepEqual(exited.exit, { code: 0, signal: null, killedByDriver: false });
	await allDead(own, "own exit");

	const killed = fixture(t, { knobs, turns });
	const driver = spawnSpikeDriver(killed.options());
	t.after(() => driver.kill("SIGKILL"));
	await held(killed);
	driver.kill("SIGKILL");
	await allDead(killed, "driver SIGKILL");
	assertClean(killed);
});

test("CX-0j: no user scope, no Codex: the run is refused before any app-server starts", { timeout: 60_000 }, async (t) => {
	const fx = fixture(t, { knobs: { containment: "fail" }, turns: [[{ kind: "shell", command: "cat README.md" }]] });
	const result = await fx.run();
	assert.equal(result.outcome, "refused");
	assert.match(result.error ?? "", /could not contain codex app-server.*Failed to connect to user scope bus.*never runs Codex uncontained/s);
	assert.deepEqual(fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server"), []);
	assert.deepEqual(fakeExecuted(fx.stateDir), []);
	assertClean(fx, result);
});

const reportStep = (fx: CodexFixture) => ({ kind: "tool" as const, tool: "report_result", arguments: report(fx) });
const allScopesKilled = (fx: CodexFixture) =>
	until(() => fakeScopes(fx.stateDir).filter((each) => each.killed !== undefined).length === fakeScopes(fx.stateDir).filter((each) => each.started).length, "every scope killed", 10_000);

test("CX-1g: a dead hook and an auto-approved read outside the worktree: the file is not read and the run is killed", { timeout: 120_000 }, async (t) => {
	// E11: a user allow rule runs `cat` with no approval; with picp's hook killed only the kernel profile is left. Without
	// the profile flags the cat runs; with `turn/interrupt` instead of the scope kill the app-server exits with code 0.
	const fx = fixture(t, { turns: [] });
	const outsideFile = join(fx.outside, "secret.txt");
	fx.setScript({ knobs: { autoApprove: ["cat"], modelMs: 1_000 }, turns: [[{ kind: "shell", command: `cat ${outsideFile}`, hook: "kill" }, { kind: "shell", command: "cat README.md" }, reportStep(fx)]] });
	const events: string[] = [];
	const result = await fx.run({ onMessage: (method, params) => events.push(`${method} ${JSON.stringify(params)}`) });
	assert.deepEqual(fakeExecuted(fx.stateDir), []);
	assert.ok(events.some((each) => each.includes("Permission denied")), "the kernel stand-in answered the read");
	const toolResults = join(fx.stateDir, "tool-results.jsonl");
	for (const where of [JSON.stringify(result), ...events, existsSync(toolResults) ? readFileSync(toolResults, "utf8") : ""]) {
		assert.ok(!where.includes(OUTSIDE_SENTINEL), "the outside file's content reached picp");
	}
	assert.equal(result.hookFailed, true);
	assert.equal(result.outcome, "stopped");
	assert.equal(result.exit?.signal, "SIGKILL", JSON.stringify(result.exit));
	assert.match(result.error ?? "", /^Refused: (picp's hook failed|the Codex CLI ran commandExecution without asking picp)/);
	assert.equal(result.report, undefined);
	assert.equal(existsSync(join(fx.runDir, "envelope.json")), false);
	await allScopesKilled(fx);
	assertClean(fx, result);
});

test("CX-1h: a command the CLI ran without asking picp kills the run, and no later step runs", { timeout: 120_000 }, async (t) => {
	const fx = fixture(t, { turns: [] });
	fx.setScript({ knobs: { autoApprove: ["cat"], modelMs: 1_000 }, turns: [[{ kind: "shell", command: "cat README.md" }, { kind: "shell", command: "echo second-step" }, reportStep(fx)]] });
	const result = await fx.run();
	assert.equal(result.bypass, "commandExecution");
	assert.equal(result.outcome, "stopped");
	assert.equal(result.hookFailed, false);
	assert.equal(result.error, "Refused: the Codex CLI ran commandExecution without asking picp; the run was killed.");
	assert.deepEqual(fakeExecuted(fx.stateDir), ["cat README.md"]);
	assert.equal(result.exit?.signal, "SIGKILL", JSON.stringify(result.exit));
	assert.equal(result.report, undefined);
	await allScopesKilled(fx);
	assertClean(fx, result);
});

test("CX-1d: an enabled feature, a differing profile read-back or web search on refuses the run; a clean run holds every flag", { timeout: 120_000 }, async (t) => {
	const step = { kind: "shell" as const, command: "cat README.md" };
	for (const [knobs, why, before] of [
		[{ features: { view_image: true } }, /loaded a surface picp did not pass \(features 1\)/, "thread/start"],
		[{ profileReadback: "extraRoot" }, /the thread's sandbox is not picp's profile/, "turn/start"],
		[{ webSearch: "live" }, /hosted web search reads back live/, "thread/start"],
	] as const) {
		const fx = fixture(t, { knobs, turns: [[step]] });
		const result = await fx.run();
		assert.equal(result.outcome, "refused", JSON.stringify(knobs));
		assert.match(result.error ?? "", why);
		assert.doesNotMatch(result.error ?? "", /view_image|\//, "counts only: no feature name or path");
		const methods = fakeRpcMethods(fx.stateDir);
		assert.ok(!methods.includes(before) && !methods.includes("turn/start"), methods.join(","));
		assert.deepEqual(fakeExecuted(fx.stateDir), []);
		assertClean(fx, result);
	}

	// The clean run also pins E10's cwd rule (a `workdir` outside the worktree is denied at the hook) and `onTool`.
	const fx = fixture(t, { turns: [] });
	fx.setScript({ turns: [[step, { kind: "shell", command: "cat secret.txt", workdir: fx.outside }, reportStep(fx)]] });
	const tools: CodexToolEvent[] = [];
	const result = await fx.run({ onTool: (event) => tools.push(event) });
	assert.equal(result.outcome, "completed", result.error);
	assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal);
	assert.equal(result.lockdown?.extra.features, 0);
	assert.equal(result.report?.job_id, JOB);
	assert.deepEqual(fakeExecuted(fx.stateDir), ["cat README.md"]);
	assert.deepEqual(result.denials.map((d) => d.layer), ["hook"]);
	assert.match(result.denials[0]?.reason ?? "", /runs in its worktree only/);
	const servers = fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server");
	assert.equal(servers.length, 2, "the trust probe and the run");
	for (const server of servers) {
		assert.ok(server.argv.includes('web_search="disabled"'), "D4: hosted web search off on every app-server");
		assert.ok(server.argv.includes('default_permissions="picp_planner"'), "the profile on every app-server");
		for (const feature of ["view_image", "goals", "sleep_tool", "unified_exec_tty"]) assert.ok(server.argv.join(" ").includes(`--disable ${feature}`), feature);
	}
	// C1b B13: the hook-denied `workdir` call gets its pair from picp, since the CLI emits no item for it.
	assert.deepEqual(tools.map((each) => `${each.phase} ${each.name}${each.isError === undefined ? "" : ` ${each.isError}`}`),
		["start bash", "end bash false", "start bash", "end bash true", "start report_result", "end report_result false"]);
	assert.match(tools[3]?.output ?? "", /runs in its worktree only/);
	assertClean(fx, result);
});

test("CX-1m: a patch the CLI only announced does not kill the run; a declined patch is absent; an unasked apply kills", { timeout: 180_000 }, async (t) => {
	// Carry-in 1 (F1): 0.170.0 sends `fileChange inProgress` before it asks. The C1a tripwire killed on it, so (a) failed
	// on `bypass`; the C1b rule kills only on an end other than `declined` (c). (d): a dead hook names the hook.
	const patched = (fx: CodexFixture) => existsSync(join(fx.worktree, "patched.txt"));
	const a = fixture(t, { turns: [] });
	a.setScript({ turns: [[{ kind: "patch", path: "patched.txt", hook: "skip" }, { kind: "shell", command: "cat README.md" }, reportStep(a)]] });
	const tools: CodexToolEvent[] = [];
	const ran = await a.run({ onTool: (event) => tools.push(event) });
	assert.equal(ran.outcome, "completed", ran.error);
	assert.equal(ran.bypass, undefined);
	assert.deepEqual(ran.denials.map((d) => `${d.layer} ${d.tool}`), ["approval apply_patch"]);
	assert.equal(patched(a), false);
	assert.deepEqual(fakeExecuted(a.stateDir), ["cat README.md"]);
	assert.equal(ran.report?.job_id, JOB);
	assert.deepEqual(tools.slice(0, 2).map((each) => `${each.phase} ${each.name} ${each.isError ?? ""}`.trim()), ["start apply_patch", "end apply_patch true"]);
	assertClean(a, ran);

	const b = fixture(t, { turns: [[{ kind: "patch", path: "patched.txt" }, { kind: "message", text: "done" }]] });
	const seen: string[] = [];
	const blocked = await b.run({ onMessage: (method, params) => seen.push(`${method} ${JSON.stringify(params)}`) });
	assert.equal(blocked.outcome, "completed", blocked.error);
	assert.deepEqual(blocked.denials.map((d) => `${d.layer} ${d.tool}`), ["hook apply_patch"]);
	assert.ok(!seen.some((each) => each.includes('"fileChange"')), "no fileChange item for a hook-blocked patch");
	assert.equal(patched(b), false);

	const c = fixture(t, { knobs: { patchApply: "unasked", modelMs: 1_000 }, turns: [[{ kind: "patch", path: "patched.txt", hook: "skip" }, { kind: "shell", command: "cat README.md" }]] });
	const unasked = await c.run();
	assert.equal(unasked.bypass, "fileChange");
	assert.equal(unasked.outcome, "stopped");
	assert.deepEqual(fakeExecuted(c.stateDir), [], "no later step ran");
	await allScopesKilled(c);

	const d = fixture(t, { knobs: { modelMs: 1_000 }, turns: [[{ kind: "patch", path: "patched.txt", hook: "kill" }, { kind: "shell", command: "cat README.md" }]] });
	const dead = await d.run();
	assert.equal(dead.hookFailed, true);
	assert.equal(dead.outcome, "stopped");
	assert.match(dead.error ?? "", /picp's hook failed/);
	assert.doesNotMatch(dead.error ?? "", /fileChange/);
	assert.equal(patched(d), false);
	assertClean(d, dead);
});

test("CX-1k: a codex release dir that is or holds the home or the Codex home refuses the run before any app-server", { timeout: 120_000 }, async (t) => {
	// The release dir is a sandbox read root; one that is the home, sits above it, or sits above the Codex home would open
	// the operator's files (auth.json included) to every command. The fixture's release dir is `<root>/codex-release`.
	const cases = [
		["equals the home", (fx: CodexFixture) => ({ home: join(fx.bin, "..") })],
		["holds the home", (fx: CodexFixture) => ({ home: join(fx.bin, "..", "home") })],
		["holds the Codex home", (fx: CodexFixture) => ({ codexHome: join(fx.bin, "..", "codex-home") })],
	] as const;
	for (const [what, pick] of cases) {
		const fx = fixture(t, { turns: [[{ kind: "shell", command: "cat README.md" }]] });
		const { home, codexHome } = { home: undefined, codexHome: undefined, ...pick(fx) } as { home?: string; codexHome?: string };
		for (const dir of [home, codexHome]) if (dir !== undefined) mkdirSync(dir, { recursive: true });
		const base = fx.options();
		await assert.rejects(
			fx.run({ hostEnv: { ...base.hostEnv, ...(home === undefined ? {} : { HOME: home }) }, ...(codexHome === undefined ? {} : { codexHome }) }),
			new RegExp(`the codex release dir \\(two levels above the real codex binary\\) is or holds the ${what.endsWith("Codex home") ? "Codex home" : "home"};`),
			what,
		);
		assert.deepEqual(fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server"), [], what);
		assert.deepEqual(fakeExecuted(fx.stateDir), [], what);
		assertClean(fx);
	}
});
