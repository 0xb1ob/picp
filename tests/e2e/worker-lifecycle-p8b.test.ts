/**
 * P8b (behavior 04): worker hard bounds, read-only MCP and wedged-call notices through a real CommandPost (or parent
 * pi), real pi workers on a treehouse pool and the mock provider. Outcomes are read from the fleet record, the worker's
 * run log, onHardBound and the parent's notices, never from internals.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_JOB_TOOL_CALL_CAP, DEFAULT_JOB_WALL_CLOCK_SECONDS, type Failure, LAYOUT, paths, WEDGED_TOOL_CALL_SECONDS } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { MCP_CALL_TOOL } from "../../src/worker-mcp.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import {
	type AgentDir,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "P8b e2e needs treehouse on PATH";
const ENV_KEYS = ["CP_JOB_WALL_CLOCK_SECONDS", "CP_JOB_TOOL_CALL_CAP"] as const;

interface Fleet {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	agentDir: AgentDir;
	bounds: Array<{ jobId: string; failure: Failure; notice: string }>;
	intake(slug: string, kind?: "ship" | "research"): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	restart(): Promise<CommandPost>;
}

type Hooks = { after(fn: () => void | Promise<void>): void };

async function fleet(t: Hooks, options: { maxTrees?: number; agentDir?: (provider: MockProvider) => AgentDir } = {}): Promise<Fleet> {
	const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
	for (const key of ENV_KEYS) delete process.env[key];
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	const provider = await MockProvider.start();
	const agentDir = options.agentDir?.(provider) ?? createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const bounds: Fleet["bounds"] = [];
	const make = () =>
		new CommandPost({
			home: home.path,
			packageRoot: REPO_ROOT,
			holdsParentLock: () => true,
			parentEnv: { ...process.env, ...agentDir.env },
			onHardBound: (jobId, failure, _work, notice) => void bounds.push({ jobId, failure, notice }),
		});
	let post = make();
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: options.maxTrees ?? 3 });
	t.after(async () => {
		await post.shutdown();
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	const f: Fleet = {
		home: home.path,
		post,
		provider,
		agentDir,
		bounds,
		async intake(slug, kind = "ship") {
			return (await f.post.ledger().create({ title: slug, project: "demo", delivery: "local", kind, slug })).id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps);
			agentDir.writeModels(provider);
			return model;
		},
		async restart() {
			await post.shutdown();
			post = make();
			f.post = post;
			return post;
		},
	};
	return f;
}

const bash = (command: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command } }] });
const failedRecord = (f: Fleet, jobId: string, timeoutMs: number) =>
	waitFor(() => f.post.fleet.get(jobId), (record) => record?.phase === "failed", { timeoutMs, what: `${jobId} failed` });

test("P8b bounds: dispatch freezes the resolved hard bounds, and a bad worker-bounds.json refuses before any lease", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t, { maxTrees: 8 });
	const model = f.script("p8b-config", Array.from({ length: 8 }, () => ({ kind: "hang" }) as ScriptStep));
	const file = join(f.home, LAYOUT.workerBoundsFile);
	mkdirSync(join(f.home, LAYOUT.data), { recursive: true });
	const setEnv = (wall?: string, cap?: string) => {
		for (const [key, value] of [["CP_JOB_WALL_CLOCK_SECONDS", wall], ["CP_JOB_TOOL_CALL_CAP", cap]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const dispatched = async (slug: string, override: { wallClockSeconds?: number; toolCallCap?: number } = {}) => {
		const jobId = await f.intake(slug);
		const result = await f.post.dispatch({ jobId, task: "Wait.", model, fetch: false, ...override });
		assert.equal("wall_clock_seconds" in result ? result.wall_clock_seconds : undefined, f.post.fleet.require(jobId).bounds?.wall_clock_seconds);
		return f.post.fleet.require(jobId).bounds;
	};
	const refused = async (slug: string, override: { wallClockSeconds?: number; toolCallCap?: number }, pattern: RegExp) => {
		const jobId = await f.intake(slug);
		await assert.rejects(f.post.dispatch({ jobId, task: "Wait.", model, fetch: false, ...override }), (error: Error) => pattern.test(error.message), slug);
		assert.equal(f.post.fleet.get(jobId), undefined, `${slug}: refused before any fleet record`);
		return jobId;
	};

	// Defaults sit past the 30-minute wedge notice; a malformed env value keeps the default.
	assert.deepEqual(await dispatched("defaults"), { wall_clock_seconds: DEFAULT_JOB_WALL_CLOCK_SECONDS, tool_call_cap: DEFAULT_JOB_TOOL_CALL_CAP });
	assert.deepEqual([DEFAULT_JOB_WALL_CLOCK_SECONDS, DEFAULT_JOB_TOOL_CALL_CAP], [5400, 900]);
	assert.ok(DEFAULT_JOB_WALL_CLOCK_SECONDS > WEDGED_TOOL_CALL_SECONDS);
	setEnv("12", "4");
	assert.deepEqual(await dispatched("env"), { wall_clock_seconds: 12, tool_call_cap: 4 });
	setEnv("nope", "0");
	assert.deepEqual(await dispatched("env-typo"), { wall_clock_seconds: DEFAULT_JOB_WALL_CLOCK_SECONDS, tool_call_cap: DEFAULT_JOB_TOOL_CALL_CAP });
	setEnv("99", "99");
	assert.deepEqual(await dispatched("override", { wallClockSeconds: 8, toolCallCap: 3 }), { wall_clock_seconds: 8, tool_call_cap: 3 });
	// Wall clock: explicit override > home file > env > default; the tool cap never reads the file.
	writeFileSync(file, JSON.stringify({ wall_clock_seconds: 1800 }));
	assert.deepEqual(await dispatched("home-file"), { wall_clock_seconds: 1800, tool_call_cap: 99 });
	assert.equal((await dispatched("home-override", { wallClockSeconds: 8 }))?.wall_clock_seconds, 8);

	// A present file that is wrong refuses, naming the file and the field, even beside an override.
	const bodies: unknown[] = [{}, { wall_clok_seconds: 1800 }, ...[0, -5, 1.5, "1800", null].map((value) => ({ wall_clock_seconds: value }))];
	for (const [i, body] of bodies.entries()) {
		writeFileSync(file, JSON.stringify(body));
		await refused(`bad-${i}`, {}, new RegExp(`${file.replaceAll("/", "\\/").replaceAll(".", "\\.")} wall_clock_seconds must be a positive integer`));
	}
	writeFileSync(file, "{nope");
	await refused("bad-json", {}, /worker-bounds\.json is not valid JSON/);
	writeFileSync(file, "[1800]");
	await refused("bad-array", { wallClockSeconds: 8 }, /worker-bounds\.json must be a JSON object/);
	writeFileSync(file, JSON.stringify({ wall_clock_seconds: 1800, allow_dispatch_override: "no" }));
	await refused("bad-flag", {}, /worker-bounds\.json allow_dispatch_override must be true or false, got "no"/);

	// allow_dispatch_override=false enforces the machine value: equal passes, different refuses.
	setEnv("99", "40");
	writeFileSync(file, JSON.stringify({ wall_clock_seconds: 1800, allow_dispatch_override: false }));
	assert.deepEqual(await dispatched("enforced-equal", { wallClockSeconds: 1800, toolCallCap: 40 }), { wall_clock_seconds: 1800, tool_call_cap: 40 });
	await refused("enforced-wall", { wallClockSeconds: 8 }, /wall_clock_seconds override 8 conflicts with enforced machine value 1800 \(\.pi-command-post\/data\/worker-bounds\.json allow_dispatch_override=false\)/);
	await refused("enforced-cap", { toolCallCap: 3 }, /tool_call_cap override 3 conflicts with enforced machine value 40/);
	writeFileSync(file, JSON.stringify({ allow_dispatch_override: false }));
	await refused("flag-only", { wallClockSeconds: 98 }, /conflicts with enforced machine value 99/);
	setEnv(undefined, undefined);
	await refused("flag-only-default", { wallClockSeconds: 98 }, /conflicts with enforced machine value 5400/);
	assert.equal(readFleet(f.home).jobs.length, 7, "only the seven accepted dispatches hold a record");
});

test("P8b bounds: a delivered send starts a fresh wall-clock round, and tool starts carry across it", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t);
	const clockJob = await f.intake("clock-round");
	const clockModel = f.script("p8b-round-clock", [{ kind: "text", text: "Idle." }, { kind: "text", text: "Still idle." }, { kind: "hang" }]);
	const toolJob = await f.intake("tool-round");
	const toolModel = f.script("p8b-round-tools", [bash("echo one"), { kind: "text", text: "Idle." }, { kind: "text", text: "Still idle." }, bash("echo two"), { kind: "hang" }]);
	const spawned = Date.now();
	await f.post.dispatch({ jobId: clockJob, task: "Idle.", model: clockModel, fetch: false, wallClockSeconds: 10 });
	await f.post.dispatch({ jobId: toolJob, task: "Idle.", model: toolModel, fetch: false, toolCallCap: 2, wallClockSeconds: 600 });
	for (const [name, n] of [["p8b-round-clock", 2], ["p8b-round-tools", 3]] as const) {
		await waitFor(() => f.provider.requests(name).length, (count) => count >= n, { timeoutMs: 20_000, what: `${name} idle after its nudge` });
	}
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, spawned + 6_000 - Date.now())));
	const sent = Date.now();
	await f.post.send({ jobId: clockJob, message: "Carry on." });
	await f.post.send({ jobId: toolJob, message: "Carry on." });

	const tools = await failedRecord(f, toolJob, 30_000);
	assert.equal(tools?.failure?.class, "tool_call_cap_exceeded", "the start before the send still counts");
	assert.equal(tools?.failure?.message, "tool_call_cap bound 2 starts exceeded (measured 2 starts)");
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, spawned + 12_000 - Date.now())));
	assert.equal(f.post.fleet.require(clockJob).phase, "waiting", "the spawn round's 10s passed; the new round has not");
	const clock = await failedRecord(f, clockJob, 30_000);
	assert.equal(clock?.failure?.class, "wall_clock_exceeded");
	// The timer rounds up, so a loaded runner can measure one second past the bound.
	assert.match(clock?.failure?.message ?? "", /^wall_clock bound 10s exceeded \(measured 1[01]s\)$/);
	assert.ok(Date.parse(clock?.failure?.at ?? "") - sent >= 9_000, "the round is measured from the delivered send");
});

test("P8b bounds: a bound names the job, bound and work on disk, and the redispatched worker is bounded again", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("bounded-twice");
	const loop = Array.from({ length: 6 }, (_, i) => bash(`echo ${i}`));
	const model = f.script("p8b-twice", [bash("printf 'keep\\n' > leftover.txt"), ...loop, { kind: "hang" }]);
	const dispatched = await f.post.dispatch({ jobId, task: "Loop.", model, fetch: false, toolCallCap: 2, wallClockSeconds: 600 });
	await waitFor(() => f.bounds.length, (n) => n >= 2, { timeoutMs: 60_000, what: "a second bound after bounded recovery" });
	const [first, second] = f.bounds;
	assert.equal(first?.failure.message, "tool_call_cap bound 2 starts exceeded (measured 2 starts)");
	assert.match(first?.notice ?? "", new RegExp(`^HARD BOUND — ${jobId} hit tool_call_cap 2 starts \\(measured 2 starts\\)`));
	assert.match(first?.notice ?? "", /on disk: .*1 uncommitted file/);
	assert.match(first?.notice ?? "", /job recorded failed; worktree left untouched/);
	assert.equal(second?.failure.class, "tool_call_cap_exceeded", "the redispatched worker trips its own cap");
	assert.match(readFileSync(join(f.home, paths.eventsFile(jobId)), "utf8"), /"recovery_attempted".*"action":"redispatch"/);
	assert.equal(readFileSync(join(dispatched.worktree, "leftover.txt"), "utf8"), "keep\n");
});

test("P8b bounds: a legacy record without frozen bounds revives on env bounds, never the home file", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t);
	mkdirSync(join(f.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(f.home, LAYOUT.workerBoundsFile), JSON.stringify({ wall_clock_seconds: 1800 }));
	const jobId = await f.intake("legacy-bounds");
	const model = f.script("p8b-legacy", [{ kind: "hang" }, { kind: "hang" }]);
	await f.post.dispatch({ jobId, task: "Wait.", model, fetch: false });
	assert.equal(f.post.fleet.require(jobId).bounds?.wall_clock_seconds, 1800);
	await waitFor(() => f.provider.requests("p8b-legacy").length, (n) => n >= 1, { timeoutMs: 20_000, what: "first worker request" });
	await f.post.shutdown();
	const fleetFile = join(f.home, LAYOUT.fleetFile);
	const doc = JSON.parse(readFileSync(fleetFile, "utf8")) as { jobs: Array<Record<string, unknown>> };
	for (const job of doc.jobs) delete job.bounds;
	writeFileSync(fleetFile, JSON.stringify(doc));
	process.env.CP_JOB_WALL_CLOCK_SECONDS = "4";
	const post = await f.restart();
	await post.revive(jobId);
	const failed = await failedRecord(f, jobId, 30_000);
	assert.match(failed?.failure?.message ?? "", /^wall_clock bound 4s exceeded \(measured [45]s\)$/);
});

const SERVER = join(REPO_ROOT, "tests/fixtures/mcp-probe-server.mjs");
const mcpCall = (args: Record<string, unknown>): ScriptStep => ({ kind: "tool_calls", calls: [{ name: MCP_CALL_TOOL, args }] });
/** Each finished tool call of a dispatched worker, from its run log. */
function toolEnds(home: string, jobId: string): Array<{ tool: string; isError: boolean; text: string }> {
	return readFileSync(join(home, paths.eventsFile(jobId)), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { payload?: Record<string, unknown> })
		.filter((event) => event.payload?.type === "tool_execution_end")
		.map(({ payload = {} }) => ({ tool: String(payload.toolName), isError: payload.isError === true, text: JSON.stringify(payload.result ?? {}) }));
}

test("P8b MCP: dispatched read-only workers reach enabled servers through mcp_call; writers and disabled homes get none", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t, { maxTrees: 6 });
	const log = join(f.agentDir.path, "calls.log");
	const server = (label: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [SERVER, label, log], ...extra });
	const mcpJson = (servers: Record<string, unknown> | string) =>
		writeFileSync(join(f.agentDir.path, "mcp.json"), typeof servers === "string" ? servers : JSON.stringify({ mcpServers: servers }));
	mcpJson({
		probe: server("probe", { exposure: "deferred", toolExposure: { "read_*": "codemode" } }),
		other: server("other"),
		hidden: server("hidden", { exposure: "hidden" }),
		off: server("off", { enabled: false }),
		broken: { args: [] },
	});
	const readOnly = [mcpCall({}), mcpCall({ tool: "mcp__probe__read_thing" }), mcpCall({ tool: "mcp__probe__plain" }),
		mcpCall({ tool: "mcp__probe__delete_thing" }), mcpCall({ tool: "mcp__hidden__read_thing" }),
		{ kind: "tool_calls", calls: [{ name: "report_result", args: {} }] } as ScriptStep, { kind: "hang" } as ScriptStep];
	const dispatch = async (slug: string, profile: string, kind: "ship" | "research", steps: ScriptStep[]) => {
		const jobId = await f.intake(slug, kind);
		await f.post.dispatch({ jobId, task: "Use MCP.", model: f.script(`p8b-mcp-${slug}`, steps), profile, fetch: false });
		await waitFor(() => toolEnds(f.home, jobId).length, (n) => n >= steps.length - 1, { timeoutMs: 60_000, what: `${slug} tool calls` });
		return toolEnds(f.home, jobId);
	};

	for (const profile of ["planner", "qa"]) {
		const ends = await dispatch(`ro-${profile}`, profile, "research", readOnly);
		const [list, read, plain, destructive, hidden, report] = ends;
		assert.equal(list?.isError, false, profile);
		assert.match(list?.text ?? "", /mcp__probe__read_thing.*mcp__other__read_thing|mcp__other__read_thing.*mcp__probe__read_thing/, profile);
		assert.doesNotMatch(list?.text ?? "", /plain|delete_thing|mcp__hidden__/, profile);
		assert.match(read?.text ?? "", /ok:read_thing/, profile);
		assert.equal(plain?.isError, true, profile);
		assert.match(plain?.text ?? "", /not declared read-only by its MCP server \(readOnlyHint\)/, profile);
		assert.match(destructive?.text ?? "", /declared destructive \(destructiveHint\)/, profile);
		assert.match(hidden?.text ?? "", /not a connected MCP tool/, profile);
		assert.equal(report?.tool, "report_result", profile);
		assert.doesNotMatch(report?.text ?? "", /not found/, `${profile}: report_result stays beside mcp_call`);
	}
	const writer = await dispatch("rw-implementer", "implementer", "ship", [mcpCall({}), { kind: "hang" }]);
	assert.deepEqual(writer.map(({ tool, isError }) => ({ tool, isError })), [{ tool: MCP_CALL_TOOL, isError: true }]);
	assert.match(writer[0]?.text ?? "", /not found/);
	const calls = readFileSync(log, "utf8").split("\n");
	assert.equal(calls.filter((line) => line === "call probe read_thing").length, 2, "only the allowed call reaches a server");
	assert.equal(calls.some((line) => / (plain|delete_thing)$/.test(line) || line === "start off"), false);

	// No mcp.json, no enabled server, or an unreadable one: no gateway, and /doctor (operator env) says why.
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = f.agentDir.path;
	t.after(() => {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	});
	const cases = [["ro-missing", null, /MCP: no servers configured/], ["ro-disabled", { off: server("off", { enabled: false }) }, /MCP: 1 configured, none enabled/],
		["ro-invalid", "secret-nope", /MCP: .*mcp\.json is not valid/]] as const;
	for (const [slug, servers, doctorSays] of cases) {
		if (servers === null) rmSync(join(f.agentDir.path, "mcp.json"));
		else mcpJson(servers);
		const [none] = await dispatch(slug, "planner", "research", [mcpCall({}), { kind: "hang" }]);
		assert.equal(none?.isError, true, slug);
		assert.match(none?.text ?? "", /not found/, slug);
		const findings = (await f.post.doctor()).findings.filter((finding) => finding.check.startsWith("mcp."));
		assert.match(findings.map((finding) => finding.what).join("\n"), doctorSays, slug);
		assert.doesNotMatch(JSON.stringify(findings), /nope/, `${slug}: the finding never quotes the file`);
	}
});

test("P8b wedged: the parent announces a silent open tool call once, never a progressing one, and a new silent call again", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "wedged", project: "demo", delivery: "local", kind: "ship" });
	const loud = "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick $i; sleep 1; done";
	// Third call: silent past a tick, loud past a tick, then silent again — the same call is news twice.
	const resumes = "sleep 9; for i in 1 2 3 4 5 6 7; do echo again $i; sleep 1; done; sleep 9";
	const worker = b.provider.addScript("p8b-wedged-worker", [bash("sleep 14"), bash(loud), bash(resumes), { kind: "hang" }]);
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Run the checks.", model: worker } }] }],
		{ CP_WEDGED_TOOL_CALL_SECONDS: "3" });
	assert.equal(ends[0]?.isError, false, JSON.stringify(ends[0]?.result));
	await waitFor(() => toolEnds(b.home, job.id).length, (n) => n >= 3, { timeoutMs: 120_000, what: "all three bash calls returned" });
	await new Promise((resolve) => setTimeout(resolve, 6_000));
	const records = b.parents[0]?.records() ?? [];
	const wakes = records.filter((r) => r.type === "message_start").map((r) => r.message as { customType?: string; content?: unknown })
		.filter((m) => m.customType === "cp-wedged").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
	const notices = records.filter((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("WEDGED"));
	// Silent windows are 6 s or longer against 5 s widget ticks, so each is seen; a repeat tick is not news.
	assert.equal(notices.length, 3, `first call once, third call before and after its output: ${JSON.stringify(notices)}`);
	const silences = notices.map((n) => Number(/silent (\d+)s/.exec(String(n.message))?.[1]));
	assert.ok(silences.every((s) => s >= 3), `every notice is a silence past the threshold, never the loud call: ${silences}`);
	assert.ok(wakes.length >= 1, "the notice also wakes the parent");
	for (const wake of wakes) {
		assert.match(wake, new RegExp(`^\\[demo\\] WEDGED TOOL CALL — 1 worker has an open tool call with no output\\n  ${job.id}: bash open \\d+s, silent \\d+s`));
		assert.match(wake, /Observed, not concluded: .* quiet past 3s\.\nNothing was killed and no phase changed/);
	}
	assert.notEqual(readFleet(b.home).jobs.find((record) => record.job_id === job.id)?.phase, "failed", "surfacing never kills");
});

const started = (home: string, jobId: string): boolean =>
	existsSync(join(home, paths.eventsFile(jobId))) && readFileSync(join(home, paths.eventsFile(jobId)), "utf8").includes('"tool_execution_start"');

test("P8b wedged: two workers silent in one tick are one notice naming both", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const b = await dispatchS29(t);
	const fifo = join(b.home, "go-silent");
	execFileSync("mkfifo", [fifo]);
	// Both calls print until one write to a shared FIFO releases them, then echo once: one last-output instant.
	const barrier = `exec 3<>${fifo}; (while :; do echo waiting; sleep 0.5; done) & p=$!; read -r _ <&3; kill $p; echo silent-now; sleep 20`;
	const jobs = await Promise.all(["wedged-a", "wedged-b"].map((title) => b.ledger.create({ title, project: "demo", delivery: "local", kind: "ship" })));
	const models = jobs.map((_, i) => b.provider.addScript(`p8b-wedged-${i}`, [bash(barrier), { kind: "hang" }]));
	const ends = await b.run([{ kind: "tool_calls", calls: jobs.map((job, i) => ({ name: "cp_dispatch", args: { job_id: job.id, task: "Run the checks.", model: models[i] } })) }],
		{ CP_WEDGED_TOOL_CALL_SECONDS: "3" });
	assert.deepEqual(ends.map((end) => end.isError), [false, false], JSON.stringify(ends.map((end) => end.result)));
	await waitFor(() => jobs.every((job) => started(b.home, job.id)), Boolean, { timeoutMs: 60_000, what: "both barrier calls opened" });
	writeFileSync(fifo, "go\ngo\n");
	await new Promise((resolve) => setTimeout(resolve, 12_000));
	const notices = (b.parents[0]?.records() ?? []).filter((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("WEDGED"))
		.map((r) => String(r.message));
	assert.equal(notices.length, 1, `one notice for both: ${JSON.stringify(notices)}`);
	assert.match(notices[0] ?? "", /^WEDGED TOOL CALLS — 2 workers have an open tool call with no output\n/);
	for (const job of jobs) assert.match(notices[0] ?? "", new RegExp(`  ${job.id}: bash open \\d+s, silent \\d+s`));
	assert.match(notices[0] ?? "", /Observed, not concluded: .*\nNothing was killed and no phase changed.*\/watch.*\n.*operator decision/);
	assert.ok(!/stalled/.test(notices[0] ?? ""), "never the retired phase word");
});
