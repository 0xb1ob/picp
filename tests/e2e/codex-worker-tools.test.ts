/**
 * C5: Codex planner tool parity through the real `cp_dispatch`, `cp_send` and `cp_teardown` of a pi parent (mock parent
 * model), with tests/fixtures/fake-codex.ts and the fake `systemd-run` at the boundary: `gh_read`, the operator's MCP
 * servers, per-job skills and the WP3 child env. Every case checks the synthetic Codex home is untouched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { AUTH_SENTINEL, fakeExecuted, fakePrompts, fakeRpcMethods, fakeScopes, fakeSpawns, fakeThreads, fakeThreadTotal } from "../harness/codex-mock.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");
const PROBE_SERVER = join(import.meta.dirname, "..", "fixtures", "mcp-probe-server.mjs");
const appServers = (h: H) => fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server" && each.argv.some((arg) => arg.startsWith("hooks.PreToolUse=")));
const ofType = (h: H, id: string, type: string) => readRunEvents(h.b.home, id).filter((event) => event.type === type);
const failed = (h: H, id: string) => waitFor(() => h.record(id), (record) => record?.phase === "failed", { timeoutMs: 60_000, what: `${id} failed on its observed exit` });
const allScopesKilled = (h: H) => waitFor(() => fakeScopes(h.state), (scopes) => scopes.filter((each) => each.killed !== undefined || each.collected).length >= scopes.filter((each) => each.started).length,
	{ timeoutMs: 20_000, what: "every started scope killed or collected" });

/** The Codex home is untouched, and no host OPENAI_/CODEX_ key but CODEX_HOME reached an app-server. */
function assertClean(h: H): void {
	assert.deepEqual(h.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(h.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server")) {
		assert.deepEqual(spawn.env.filter((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
	}
}

/** `<agent dir>/mcp.json`: `probe` (delete_* hidden), `off` (disabled), `bad name!` (skipped); returns its log. */
function userMcp(h: H): string {
	const log = join(h.agentDir, "mcp.log");
	const probe = (label: string) => ({ command: process.execPath, args: [PROBE_SERVER, label, log] });
	writeFileSync(join(h.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		probe: { ...probe("probe"), toolExposure: { "delete_*": "hidden" } }, off: { ...probe("off"), enabled: false }, "bad name!": probe("bad"),
	} }));
	return log;
}
const probeCalls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => /^(?:call|resource) /.test(line)) : []);

/** A scripted `gh` first on the worker's PATH: logs each argv, answers `issue view`, `api` and `repo view`. */
function scriptedGh(t: TestContext, h: H): { path: string; calls: () => string[] } {
	const dir = mkdtempSync(join(tmpdir(), "cp-cx5a-gh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.log");
	const rest = h.env.PATH;
	writeFileSync(join(dir, "gh"), [
		"#!/bin/sh",
		`case "$*" in "--version"|"api user --jq .login") PATH='${rest}' exec gh "$@" ;; esac`,
		`printf '%s\\n' "$*" >> '${log}'`,
		'case "$1 $2" in',
		"\t\"issue view\") printf 'cx5a issue %s body\\n' \"$3\" ;;",
		"\t\"repo view\") echo o/r ;;",
		"\t\"api \"*) printf '[{\"body\":\"cx5a comment from %s\"}]\\n' \"$2\" ;;",
		"\t*) echo \"cx5a gh: unscripted gh $*\" >&2; exit 1 ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o755 });
	return { path: `${dir}:${h.env.PATH}`, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

// Scenario: Given a scripted gh and a parent with a synthetic GH_TOKEN, When a codex planner reads an issue and a PR's
//   comments with gh_read, tries `-R other/x` and Bash `gh`, Then the reads return the scripted bodies, the rest are
//   refused by name, gh ran only the reads (and the repo lookup), and no GH_* key reached the app-server. Job B: a
//   gh_read whose hook dies reaches no gh and fails as a named lockdown stop.
test("CX-5a: a codex planner reads GitHub through gh_read; Bash gh, other repos and a dead hook reach no gh", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_max_concurrent: 2 } });
	const gh = scriptedGh(t, h);
	const [a, b] = [await h.job(), await h.job()];
	h.setScript({ turns: [
		h.reporting(a.id, [
			{ kind: "tool", tool: "gh_read", arguments: { verb: "issue view", number: 7 } },
			{ kind: "tool", tool: "gh_read", arguments: { verb: "api", path: "repos/o/r/pulls/9/comments" } },
			{ kind: "tool", tool: "gh_read", arguments: { verb: "pr view", args: ["-R", "other/x"] } },
			{ kind: "shell", command: "gh issue view 7" },
		]),
		[{ kind: "tool", tool: "gh_read", arguments: { verb: "issue view", number: 8 }, hook: "kill" }, ...h.reporting(b.id)],
	] });
	await h.run([a.dispatch(), h.awaitEnvelope(a.id), h.waitEvent(a.id, "native_run"), b.dispatch(), h.waitEvent(b.id, "native_run")],
		{ PATH: gh.path, GH_TOKEN: "synthetic-gh-token-cx5a" });
	const results = h.lines<{ tool: string; result: { contentItems: Array<{ text: string }>; success: boolean } }>("tool-results.jsonl").filter((each) => each.tool === "gh_read");
	assert.match(results[0]?.result.contentItems[0]?.text ?? "", /cx5a issue 7 body/, JSON.stringify(results));
	assert.match(results[1]?.result.contentItems[0]?.text ?? "", /cx5a comment from repos\/o\/r\/pulls\/9\/comments/);
	assert.equal(results[1]?.result.success, true);
	assert.match(results[2]?.result.contentItems[0]?.text ?? "", /^Refused: gh_read never passes `-R`/);
	assert.equal(results[2]?.result.success, false);
	const [runA] = await h.runs(a.id);
	assert.equal(runA?.lockdown, "ok", JSON.stringify(runA));
	assert.match(JSON.stringify(runA?.denied), /gh_read/, "the Bash gh refusal names gh_read");
	assert.deepEqual(gh.calls().filter((call) => !call.startsWith("repo view")), ["issue view 7", "api repos/o/r/pulls/9/comments"]);
	assert.equal(ofType(h, a.id, "envelope_received").length, 1);
	for (const spawn of appServers(h)) assert.deepEqual(spawn.env.filter((key) => key.startsWith("GH_")), [], JSON.stringify(spawn.env));
	// Job B: the killed hook leaves no verdict, so the call reaches no gh and the run stops by name.
	const [runB] = await h.runs(b.id);
	assert.deepEqual([runB?.hook_failed, runB?.stop], [true, "lockdown"], JSON.stringify(runB));
	assert.equal(gh.calls().filter((call) => call.includes(" 8")).length, 0, "the killed-hook read never ran gh");
	await failed(h, b.id);
	assert.equal(ofType(h, b.id, "envelope_received").length, 0);
	assertClean(h);
});

// Scenario: Given mcp.json with probe (delete_* hidden), off (disabled) and `bad name!`, When a codex planner calls
//   read_thing, delete_thing and reads a resource, Then the tool and the resource reach the server, the hidden tool is
//   refused by name at the hook, the lockdown passes with one server, off never loads and the bad name is skipped.
test("CX-5b: the operator's MCP server reaches a codex planner through the thread config; a hidden tool is refused", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const log = userMcp(h);
	const job = await h.job();
	h.setScript({ turns: [h.reporting(job.id, [
		{ kind: "mcp", server: "probe", tool: "read_thing" },
		{ kind: "mcp", server: "probe", tool: "delete_thing" },
		{ kind: "resource", server: "probe", uri: "probe://one" },
	])] });
	const ends = await h.run([job.dispatch(), h.awaitEnvelope(job.id), h.pause(2), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id } }] }]);
	assert.notEqual(ends.find((end) => end.toolName === "cp_teardown")?.isError, true);
	assert.deepEqual(probeCalls(log), ["call probe read_thing", "resource probe probe://one"]);
	const [run] = await h.runs(job.id);
	assert.equal(run?.lockdown, "ok", JSON.stringify(run));
	assert.equal(run?.bypass, undefined);
	assert.equal((run?.seen as { mcpServers?: number }).mcpServers, 1);
	assert.match(JSON.stringify(run?.denied), /mcp__probe__delete_thing is hidden/);
	const [thread] = fakeThreads(h.state);
	assert.deepEqual(thread?.mcpServers, ["probe"]);
	assert.match(thread?.developerInstructions ?? "", /MCP servers \(from /);
	assert.doesNotMatch(thread?.developerInstructions ?? "", /^- off/m);
	const skipped = ofType(h, job.id, "native_mcp_skipped");
	assert.equal(skipped.length, 1);
	assert.match(JSON.stringify(skipped[0]?.payload), /MCP server bad name! not loaded/);
	assert.ok(ofType(h, job.id, "tool_execution_start").some((event) => (event.payload as { toolName?: string }).toolName === "mcp__probe__read_thing"));
	assert.ok(!fakeSpawns(h.state).some((spawn) => spawn.argv.some((arg) => arg.includes("mcp_servers"))), "no server config on argv");
	await allScopesKilled(h);
	assertClean(h);
});

// Scenario: Given the CX-5b server and a hook that dies, When the model calls an MCP tool (read-only or hidden), Then
//   prompt mode makes the CLI ask picp, picp declines with no verdict, the server gets no call and each job fails as a
//   named lockdown stop with no report. Catches a read-only-hinted tool that asks nobody on a dead hook (M7).
test("CX-5c: an MCP tool call with a dead hook reaches no server", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_max_concurrent: 2 } });
	const log = userMcp(h);
	const [a, b] = [await h.job(), await h.job()];
	h.setScript({ turns: [
		[{ kind: "mcp", server: "probe", tool: "read_thing", hook: "kill" }, { kind: "mcp", server: "probe", tool: "plain" }, ...h.reporting(a.id)],
		[{ kind: "mcp", server: "probe", tool: "delete_thing", hook: "kill" }, ...h.reporting(b.id)],
	] });
	await h.run([a.dispatch(), h.waitEvent(a.id, "native_run"), b.dispatch(), h.waitEvent(b.id, "native_run")]);
	for (const [job, tool] of [[a, "read_thing"], [b, "delete_thing"]] as const) {
		const [run] = await h.runs(job.id);
		assert.deepEqual([run?.hook_failed, run?.stop], [true, "lockdown"], JSON.stringify(run));
		// Prompt mode: the CLI asked picp before the call, and picp declined it with no hook verdict.
		assert.match(JSON.stringify(run?.denied), new RegExp(`mcp__probe__${tool}: Refused: picp's hook failed`), JSON.stringify(run?.denied));
		await failed(h, job.id);
		assert.equal(ofType(h, job.id, "envelope_received").length, 0);
	}
	assert.deepEqual(probeCalls(log), [], "no MCP call reached the server");
	assert.deepEqual(fakeExecuted(h.state), [], "no later step ran");
	assertClean(h);
});

// Scenario: Given cp_dispatch skills ["tdd-x"], When a codex planner cats its SKILL.md, Then the job runs on codex, the
//   prompt names the file, the profile reads the skill dir and the command returns the body (no "Permission denied").
test("CX-5d: a codex planner reads its per-job SKILL.md inside the kernel profile", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const dir = join(h.agentDir, "skills", "tdd-x");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: tdd-x\ndescription: does tdd-x\n---\ncx5d skill body: write the failing test first.\n");
	const real = realpathSync(dir);
	const job = await h.job();
	h.setScript({ turns: [h.reporting(job.id, [{ kind: "shell", command: `cat ${join(real, "SKILL.md")}` }])] });
	const ends = await h.run([job.dispatch({ skills: ["tdd-x"] }), h.awaitEnvelope(job.id), h.pause(2)]);
	const dispatched = ends.find((end) => end.toolName === "cp_dispatch");
	assert.notEqual(dispatched?.isError, true, text(dispatched));
	assert.equal(h.record(job.id)?.worker.driver, "codex");
	const prompt = fakePrompts(h.state)[0]?.text ?? "";
	assert.ok(prompt.includes(join(real, "SKILL.md")), "the brief names the SKILL.md path");
	assert.match(prompt, /Read each SKILL\.md before you start/);
	assert.ok(appServers(h).every((spawn) => spawn.argv.some((arg) => arg.startsWith("permissions.") && arg.includes(`${JSON.stringify(real)}="read"`))), "the skill dir is a read root");
	const [run] = await h.runs(job.id);
	assert.deepEqual([run?.lockdown, run?.denials], ["ok", 0], JSON.stringify(run));
	const transcript = readFileSync(readRunStatus(h.b.home, job.id).transcript_file as string, "utf8");
	assert.match(transcript, /cx5d skill body: write the failing test first/);
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	assertClean(h);
});

// Scenario: Given a parent env with a browser path, a credentialed proxy, GH_TOKEN, FOO_TOKEN and SSH_AUTH_SOCK, When
//   a codex planner's shell writes $CP_JOB_ID, Then the shell sees the job id (inherit="all"), the app-server carries
//   the WP3 names and none of the credentials, CP_HOME or CP_RUN_DIR, and the dropped proxy is one named event.
test("CX-5e: the codex app-server and its shell get the WP3 child env and no credential", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const out = join(h.b.home, paths.artifactDir(job.id), "id.txt");
	h.setScript({ turns: [h.reporting(job.id, [{ kind: "shell", command: `printf '%s' "$CP_JOB_ID" > ${out}` }])] });
	await h.run([job.dispatch(), h.awaitEnvelope(job.id), h.pause(2)], {
		PLAYWRIGHT_BROWSERS_PATH: "/x", HTTPS_PROXY: "http://user:pass@proxy.invalid:3128", GH_TOKEN: "synthetic-gh-token-cx5e",
		FOO_TOKEN: "synthetic-foo-token", SSH_AUTH_SOCK: "/tmp/cx5e-agent.sock",
	});
	assert.equal(readFileSync(out, "utf8"), job.id);
	assert.ok(appServers(h).length > 0);
	for (const spawn of appServers(h)) {
		for (const key of ["GIT_EDITOR", "CP_JOB_ID", "PLAYWRIGHT_BROWSERS_PATH"]) assert.ok(spawn.env.includes(key), key);
		for (const key of ["GH_TOKEN", "FOO_TOKEN", "HTTPS_PROXY", "SSH_AUTH_SOCK", "CP_HOME", "CP_RUN_DIR"]) assert.equal(spawn.env.includes(key), false, key);
		assert.ok(spawn.argv.includes('shell_environment_policy.inherit="all"'));
	}
	const dropped = ofType(h, job.id, "native_env_dropped");
	assert.equal(dropped.length, 1);
	assert.match(JSON.stringify(dropped[0]?.payload), /HTTPS_PROXY/);
	assertClean(h);
});

// Scenario: Given the CLI lists one more server on the thread than picp passed, When the job starts, Then the lockdown
//   refuses before any turn with counts, and the probe gets no call.
test("CX-5f: a thread-scoped MCP server picp did not pass refuses the run before any turn", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const log = userMcp(h);
	const job = await h.job();
	h.setScript({ knobs: { extraThreadMcpServers: 1 }, turns: [[{ kind: "mcp", server: "probe", tool: "read_thing" }, ...h.reporting(job.id)]] });
	await h.run([job.dispatch(), h.waitEvent(job.id, "native_run")]);
	const [run] = await h.runs(job.id);
	assert.deepEqual([run?.lockdown, run?.stop], ["refused", "lockdown"], JSON.stringify(run));
	assert.equal((run?.extra as { mcpServers?: number }).mcpServers, 1);
	const record = await failed(h, job.id);
	assert.equal(record?.failure?.class, "spawn_failed");
	assert.ok(!fakeRpcMethods(h.state).includes("turn/start"), "no turn started");
	assert.deepEqual(probeCalls(log), []);
	assertClean(h);
});

// Scenario (P1): Given a CLI that runs an MCP tool without the approval picp's prompt mode asks for, When the call
//   completes, Then the tripwire kills the run (`bypass: "mcpToolCall"`), no later step runs, the job fails by name.
test("CX-5g: an MCP tool call completed with no accepted approval kills the run", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	userMcp(h);
	const job = await h.job();
	h.setScript({ knobs: { mcpApproval: "skip" }, turns: [[{ kind: "mcp", server: "probe", tool: "read_thing" }, { kind: "shell", command: "cat README.md" }, ...h.reporting(job.id)]] });
	await h.run([job.dispatch(), h.waitEvent(job.id, "native_run")]);
	const [run] = await h.runs(job.id);
	assert.deepEqual([run?.bypass, run?.stop], ["mcpToolCall", "lockdown"], JSON.stringify(run));
	assert.deepEqual(fakeExecuted(h.state), [], "the shell step never ran");
	await failed(h, job.id);
	assert.equal(ofType(h, job.id, "envelope_received").length, 0);
	assertClean(h);
});

// Scenario (P2): Given an MCP server, When an idle cp_send resumes the thread in a new app-server, Then the resume
//   carries the same thread config, the second call reaches the server and tokens are counted once. Without the
//   config on thread/resume the resumed thread has no server (M13).
test("CX-5h: a resumed codex thread keeps its MCP servers", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const log = userMcp(h);
	const job = await h.job();
	const turn = h.reporting(job.id, [{ kind: "mcp", server: "probe", tool: "read_thing" }]);
	h.setScript({ turns: [turn, turn] });
	await h.run([
		job.dispatch(), h.waitEvent(job.id, "agent_settled", 1),
		{ kind: "tool_calls", calls: [{ name: "cp_send", args: { job_id: job.id, message: "Read the thing once more and report again." } }] },
		h.waitEvent(job.id, "envelope_received", 2), h.waitEvent(job.id, "agent_settled", 2),
	]);
	assert.deepEqual(probeCalls(log), ["call probe read_thing", "call probe read_thing"]);
	assert.deepEqual(fakeThreads(h.state).map((each) => [each.method, each.mcpServers]), [["thread/start", ["probe"]], ["thread/resume", ["probe"]]]);
	const runs = await h.runs(job.id);
	assert.deepEqual(runs.map((run) => run.lockdown), ["ok", "ok"], JSON.stringify(runs));
	const status = readRunStatus(h.b.home, job.id);
	assert.equal(status.usage.total_tokens, fakeThreadTotal(h.state, h.session(job.id).thread_id as string).totalTokens, "tokens counted once");
	assertClean(h);
});

// Scenario: operator read roots reach a ship implementer only, never a planner (C8 e)
//   Given the parent's CP_CODEX_READ_ROOTS naming a tool dir, When a codex planner cats a file there and reports,
//   Then its profile never lists the dir and the file is not read; with the variable set to `not json` a second planner
//   still reports. Before C8 the planner's profile read the dir and the junk value stopped its turn.
test("CX-8e: CP_CODEX_READ_ROOTS never reaches a codex planner: no profile entry, no read, junk ignored", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_max_concurrent: 2 } });
	const tools = join(h.root, "tools");
	mkdirSync(tools);
	writeFileSync(join(tools, "tool"), "PLANNER-READ-ROOT-SENTINEL\n");
	const [a, b] = [await h.job(), await h.job()];
	h.setScript({ turns: [h.reporting(a.id, [{ kind: "shell", command: `cat ${join(tools, "tool")}` }]), h.reporting(b.id)] });
	await h.run([a.dispatch(), h.awaitEnvelope(a.id), h.pause(2)], { CP_CODEX_READ_ROOTS: JSON.stringify([tools]) });
	assert.equal(ofType(h, a.id, "envelope_received").length, 1);
	const profiles = appServers(h).flatMap((each) => each.argv).filter((arg) => arg.startsWith("permissions.picp_planner="));
	assert.ok(profiles.length > 0, "the planner profile was passed");
	for (const flag of profiles) assert.ok(!flag.includes(tools) && !flag.includes(realpathSync(tools)), flag);
	assert.doesNotMatch(readFileSync(readRunStatus(h.b.home, a.id).transcript_file as string, "utf8"), /PLANNER-READ-ROOT-SENTINEL/);
	await h.b.closeParents();
	await h.run([b.dispatch(), h.awaitEnvelope(b.id), h.pause(2)], { CP_CODEX_READ_ROOTS: "not json" });
	assert.equal(ofType(h, b.id, "envelope_received").length, 1, "a planner ignores the variable");
	assertClean(h);
});

// Scenario (main-session condition 3, Q3): Given an `ops:pull` job, When it is dispatched on codex explicitly or
//   matched by a codex row, Then the explicit request refuses by name before any lease and the row falls back to pi as
//   ineligible, since the Codex shell has no network and no ssh agent. Catches an ops job silently run without ssh.
test("CX-5i: the ops profile is ineligible for the Codex CLI and falls back to pi by name", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const piModel = h.b.provider.addScript(`cx5i-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF],
		rubric: [{ id: "codex-research", role: "planner", model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex" }] }));
	const ops = await h.b.ledger.create({ title: `cx5i pull ${Math.random()}`, project: "demo", delivery: "local", kind: "research", labels: ["ops:pull"] });
	mkdirSync(join(h.b.home, paths.artifactDir(ops.id)), { recursive: true });
	const dispatch = (args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: ops.id, task: "Report.", queue: false, when_ready: false, ...args } }] });
	const ends = (await h.run([dispatch({ model: FAKE_CODEX_REF, driver: "codex" }), dispatch({ dry_run: true })])).filter((end) => end.toolName === "cp_dispatch");
	assert.equal(ends[0]?.isError, true, text(ends[0]));
	assert.match(text(ends[0]), /cannot run on the Codex CLI driver: profile ops runs no Codex CLI job/);
	assert.equal(existsSync(join(h.b.home, paths.runDir(ops.id))), false, "no run before any lease");
	const decision = (ends[1]?.result.details as { decision?: { driver?: string; requested_driver?: string; driver_reason?: string } } | undefined)?.decision;
	assert.deepEqual([decision?.requested_driver, decision?.driver], ["codex", "pi"], text(ends[1]));
	assert.match(decision?.driver_reason ?? "", /^ineligible: profile ops runs no Codex CLI job/);
	assertClean(h);
});
