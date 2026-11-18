/**
 * Codex C0 live smoke and kill-criteria probes, operator-run: skipped unless CP_LIVE_TESTS=1, `codex` is on PATH and
 * signed in. Each case runs in its own fresh mkdtemp dir, deletes its threads, and prints counts and statuses only.
 * picp passes the operator's Codex home as CODEX_HOME and never opens it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { whichAll } from "../../src/doctor.ts";
import { codexLoginRefusal, defaultCodexHome } from "../../src/drivers/codex-cli.ts";
import { CODEX_METHODS } from "../../src/drivers/codex-protocol.ts";
import { spawnCodexRpc } from "../../src/drivers/codex-rpc.ts";
import {
	buildCodexChildEnv,
	codexHookTrust,
	type CodexSpikeOptions,
	type CodexSpikeResult,
	codexSpawnArgs,
	runCodexSpike,
	SURFACE_FLAGS,
} from "../../src/drivers/codex-spike.ts";
import { LIVE_TESTS_ENABLED } from "../harness/index.ts";

const CODEX = whichAll("codex", process.env)[0];
const skip = !LIVE_TESTS_ENABLED ? "set CP_LIVE_TESTS=1 to run live smokes" : CODEX === undefined ? "codex is not on PATH" : false;
const JOB = "cp-codex-live-smoke";
const BUDGET = Number(process.env.CP_LIVE_TOKEN_BUDGET ?? 400_000);
const HOOK_FAIL = new URL("../fixtures/codex-hook-fail.mjs", import.meta.url).pathname;
let spent = 0;

/** A fresh scratch dir with an empty worktree and a pre-written artifact; removed after the case. */
function scratch(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "cp-codex-live-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const worktree = join(root, "work");
	const artifactPath = join(root, "artifacts", "report.md");
	for (const dir of [worktree, join(root, "artifacts"), join(root, "home"), join(root, "tmp")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(artifactPath, "# Live smoke\n\nok\n");
	const run = (prompt: string, extra: Partial<CodexSpikeOptions> = {}) => runCodexSpike({
		job: { job_id: JOB, kind: "research", role: "planner", delivery: "local", runDir: join(root, "run"), worktree, artifactPath },
		prompt, timeoutMs: 170_000, ...extra,
	});
	return { root, worktree, artifactPath, run };
}

async function live(t: TestContext): Promise<boolean> {
	if (skip !== false) return false;
	const home = mkdtempSync(join(tmpdir(), "cp-codex-login-"));
	try {
		const refusal = await codexLoginRefusal(CODEX as string, { codexHome: defaultCodexHome(), home, pathEnv: process.env.PATH ?? "" });
		if (refusal !== undefined) t.skip(refusal);
		return refusal === undefined;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** Counts and statuses only: never a path under the home, an email, a plan or a token. */
function summary(result: CodexSpikeResult) {
	spent += result.totals?.totalTokens ?? 0;
	assert.ok(spent <= BUDGET, `the live smoke passed its token budget (${spent} > ${BUDGET})`);
	return JSON.stringify({
		outcome: result.outcome, lockdown: result.lockdown?.verdict, seen: result.lockdown?.seen, extra: result.lockdown?.extra, exit: result.exit,
		usage: result.usage, ticketMatch: result.ticketMatch, denials: result.denials.map((d) => d.layer), leftovers: result.leftovers.length,
		hookFailed: result.hookFailed, report: result.report !== undefined, refusals: result.reportRefusals.length, error: result.error?.slice(0, 300),
	});
}

const REPORT = (artifactPath: string) =>
	`call the report_result tool with job_id "${JOB}", kind "research", status "done", summary "live smoke ok", artifact_path "${artifactPath}", ` +
	'plan_summary {"goal":"g","approach":["a"],"acceptance":["x"],"risk":"r","touched":["t"]}';

test("LS-1/LS-2: system skills and the method names exist on the installed codex", { skip, timeout: 120_000 }, async (t) => {
	if (!(await live(t))) return;
	const s = scratch(t);
	const env = buildCodexChildEnv({ home: join(s.root, "home"), tmp: join(s.root, "tmp") }, process.env, defaultCodexHome());
	const rpc = spawnCodexRpc({ command: CODEX as string, args: ["app-server", "--strict-config", ...SURFACE_FLAGS], cwd: s.worktree, env });
	try {
		await rpc.request(CODEX_METHODS.initialize, { clientInfo: { name: "picp-smoke", version: "0" }, capabilities: { experimentalApi: true } });
		rpc.notify(CODEX_METHODS.initialized);
		const skills = await rpc.request<{ data: Array<{ skills: Array<{ name: string; scope: string }> }> }>(CODEX_METHODS.skillsList, { cwds: [s.worktree] });
		const system = skills.data.flatMap((entry) => entry.skills).filter((skill) => skill.scope === "system").map((skill) => skill.name).sort();
		t.diagnostic(`system skills: ${JSON.stringify(system)}; others: ${skills.data.flatMap((e) => e.skills).length - system.length}`);
	} finally {
		rpc.closeInput();
		await rpc.exited;
	}
	const schema = join(s.root, "schema");
	const dump = spawnCodexRpc({ command: CODEX as string, args: ["app-server", "generate-json-schema", "--experimental", "--out", schema], cwd: s.root, env: { PATH: process.env.PATH ?? "", HOME: join(s.root, "home") } });
	dump.closeInput();
	assert.equal((await dump.exited).code, 0);
	const files = readdirSync(join(schema, "v2")).join("\n");
	for (const name of ["SkillsListResponse", "HooksListResponse", "ThreadBackgroundTerminalsTerminateResponse", "ThreadTokenUsageUpdatedNotification", "HookCompletedNotification"]) {
		assert.ok(files.includes(name), name);
	}
});

test("LS-1: one research turn runs pwd, reports, measures usage and leaves no process", { skip, timeout: 200_000 }, async (t) => {
	if (!(await live(t))) return;
	const s = scratch(t);
	const result = await s.run(`Run the shell command \`pwd\` once. Then ${REPORT(s.artifactPath)}. Then stop.`, { deleteThread: true });
	t.diagnostic(summary(result));
	assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal);
	assert.equal(result.report?.job_id, JOB);
	assert.equal(result.usage.status, "complete");
	assert.equal(result.leftovers.filter((each) => !each.gone).length, 0);
});

test("LS-3a (KC1): a guard-denied touch in the scratch dir does not run", { skip, timeout: 200_000 }, async (t) => {
	if (!(await live(t))) return;
	const s = scratch(t);
	const target = join(s.root, "ls3a-denied");
	const result = await s.run(`Run exactly this shell command once: touch ${target}  Then ${REPORT(s.artifactPath)}.`, { deleteThread: true });
	t.diagnostic(summary(result));
	assert.equal(existsSync(target), false, "KC1 fired: a guard-denied command ran");
});

test("LS-3b (KC2): with failing hooks and every approval declined, no command and no tool body runs", { skip, timeout: 400_000 }, async (t) => {
	if (!(await live(t))) return;
	for (const mode of ["exit1", "stall", "selfkill"] as const) {
		const s = scratch(t);
		const target = join(s.root, `ls3b-${mode}`);
		const env = buildCodexChildEnv({ home: join(s.root, "home"), tmp: join(s.root, "tmp") }, process.env, defaultCodexHome());
		const spawn = { hookCommand: `'${process.execPath}' '${HOOK_FAIL}' ${mode}`, hookTimeoutSec: 5 };
		const trust = await codexHookTrust(CODEX as string, codexSpawnArgs(spawn), s.worktree, env);
		const rpc = spawnCodexRpc({ command: CODEX as string, args: codexSpawnArgs({ ...spawn, trust }), cwd: s.worktree, env });
		const seen = { approvals: 0, toolCalls: 0, ran: 0, hooks: [] as string[] };
		rpc.onRequest(CODEX_METHODS.commandApproval, () => (seen.approvals++, { decision: "decline" }));
		rpc.onRequest(CODEX_METHODS.toolCall, () => (seen.toolCalls++, { contentItems: [{ type: "inputText", text: "declined" }], success: false }));
		const done = new Promise<void>((ok) => rpc.onNotification(({ method, params }) => {
			const p = params as { item?: { type?: string; status?: string }; run?: { status?: string } };
			if (method === CODEX_METHODS.hookCompleted) seen.hooks.push(String(p.run?.status));
			if (method === CODEX_METHODS.itemCompleted && p.item?.type === "commandExecution" && (p.item.status === "completed" || p.item.status === "failed")) seen.ran++;
			if (method === CODEX_METHODS.turnCompleted) ok();
		}));
		let threadId: string | undefined;
		try {
			await rpc.request(CODEX_METHODS.initialize, { clientInfo: { name: "picp-smoke", version: "0" }, capabilities: { experimentalApi: true } });
			rpc.notify(CODEX_METHODS.initialized);
			const probe = { type: "function", name: "probe_tool", description: "A probe.", inputSchema: { type: "object", properties: {} } };
			const thread = await rpc.request<{ thread: { id: string } }>(CODEX_METHODS.threadStart, { cwd: s.worktree, approvalPolicy: "untrusted", sandbox: "read-only", dynamicTools: [probe] });
			threadId = thread.thread.id;
			await rpc.request(CODEX_METHODS.turnStart, { threadId, input: [{ type: "text", text: `Run the shell command \`touch ${target}\`, then call probe_tool once, then stop.` }] });
			await Promise.race([done, sleep(150_000)]);
		} finally {
			if (threadId !== undefined) await rpc.request(CODEX_METHODS.threadDelete, { threadId }).catch(() => undefined);
			rpc.closeInput();
			await rpc.exited;
		}
		t.diagnostic(`${mode}: ${JSON.stringify(seen)}`);
		assert.equal(seen.ran, 0, `KC2 fired (${mode}): a command ran after a failed hook`);
		assert.equal(existsSync(target), false, `KC2 fired (${mode}): the sentinel exists`);
	}
});

test("LS-3c (KC4): a resumed run counts only its own usage", { skip, timeout: 400_000 }, async (t) => {
	if (!(await live(t))) return;
	const s = scratch(t);
	const first = await s.run("Reply with the single word: one");
	t.diagnostic(summary(first));
	const second = await s.run("Reply with the single word: two", { resume: { threadId: first.threadId as string }, deleteThread: true });
	t.diagnostic(summary(second));
	assert.equal(second.usage.status, "complete");
	if (second.usage.status === "complete" && first.totals !== undefined && second.totals !== undefined) {
		assert.equal(second.usage.total, second.totals.totalTokens - first.totals.totalTokens, "KC4 fired: usage counted twice across resume");
	}
});

test("LS-3d (KC5): an interrupted sleep does not survive the stop", { skip, timeout: 300_000 }, async (t) => {
	if (!(await live(t))) return;
	const s = scratch(t);
	const nonce = `300.${process.pid}${Date.now() % 100_000}`;
	const abort = new AbortController();
	const running = s.run(`Run the shell command \`sleep ${nonce}\` and wait for it.`, { signal: abort.signal, deleteThread: true });
	await sleep(40_000);
	abort.abort();
	const result = await running;
	t.diagnostic(summary(result));
	const survivors = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((line) => line.includes(nonce));
	t.diagnostic(`leftovers ${result.leftovers.length}, survivors ${survivors.length}`);
	assert.equal(survivors.length, 0, "KC5 fired: a command process survived the stop");
});

test("LS-3e (KC6): without the surface flags the operator's own surface is refused before any turn", { skip, timeout: 200_000 }, async (t) => {
	if (!(await live(t))) return;
	const s = scratch(t);
	const result = await s.run("Reply with the single word: ok", { surfaceFlags: [] });
	t.diagnostic(summary(result));
	assert.equal(result.outcome, "refused", "KC6 fired: an extra loaded surface was not refused");
});
