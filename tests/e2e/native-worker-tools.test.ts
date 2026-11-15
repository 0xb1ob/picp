/**
 * Claude/pi worker parity (WP4+) through the real `cp_dispatch` of a pi parent (mock model), fake-claude as the CLI on
 * CI, only boundary services faked. NP-4*: the planner role's web tools; NP-5*: user MCP servers and the lockdown.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { VERDICT_TOOL } from "../../src/drivers/claude-verdict.ts";
import { type ClaudeStep, type ClaudeToolUse, FAKE_NATIVE_MODEL, type RecordedClaudeRequest, toolResults } from "../harness/claude-mock-provider.ts";
import { readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";
import { NATIVE, nativeWorkerHome, startFakeWeb } from "../harness/native-worker.ts";

const calls = (...uses: ClaudeToolUse[]): ClaudeStep => ({ kind: "tool_use", calls: uses });
const done: ClaudeStep = { kind: "text", text: "Reported." };
const text = (end: { result: { content?: unknown } } | undefined) => JSON.stringify(end?.result.content ?? "");
const researchReport = (id: string, home: string) => ({
	job_id: id, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(home, paths.artifactFile(id)),
	plan_summary: { goal: "Name the package.", approach: ["Read the docs page."], acceptance: ["The name is reported."], risk: "None.", touched: ["README.md"] },
});
const blocked = (id: string) => ({ job_id: id, kind: "ship", status: "blocked", summary: "Parity case done.", blockers: ["the e2e case ends here"] });
const accepted = (home: string, id: string) => readRunEvents(home, id).filter((event) => event.type === "envelope_received").length;
const isModelCall = (request: RecordedClaudeRequest) => request.path.split("?")[0] === "/v1/messages" && Array.isArray(request.body.tools);
const offered = (request: RecordedClaudeRequest | undefined) => ((request?.body.tools ?? []) as Array<{ name: string }>).map((each) => each.name);
const system = (request: RecordedClaudeRequest | undefined) => JSON.stringify(request?.body.system ?? "");
const WEB = ["WebFetch", "WebSearch"];
const PAGE = "np4 fake docs page: the package is demo";
const SEARCH = "np4 search result: demo docs at http://127.0.0.1/docs";

// Scenario: Given a native planner, When it fetches a public page and searches the web, Then the page text and the
//   search results reach it, and the lockdown passes with the web tools declared optional.
test("NP-4a: a planner fetches and searches the web", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const web = await startFakeWeb(t, PAGE);
	const h = await nativeWorkerHome(t, [
		calls({ name: "WebFetch", input: { url: `${web.url}/docs`, prompt: "Name the package." } }, { name: "WebSearch", input: { query: "demo package docs" } }),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	], { settingsEnv: { FAKE_CLAUDE_SEARCH_RESULTS: SEARCH } });
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Name the package from its docs."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const [fetched, searched] = toolResults(h.claude.requests);
	assert.equal(fetched, PAGE);
	assert.equal(searched, SEARCH);
	assert.deepEqual(web.paths, ["/docs"]);
	const [run] = await h.runs(id);
	assert.deepEqual([run?.lockdown, run?.denials, run?.report], ["ok", 0, true], JSON.stringify(run));
	const first = h.claude.requests.find(isModelCall);
	assert.match(JSON.stringify(first?.body.system ?? ""), /Bash, Write, WebSearch, WebFetch\)/, "the addendum names the web tools");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native planner, When a fetch URL carries a job path, a state-dir name or a credential shape, or a
//   search names its worktree, Then each call is refused in webEgressRefusal's wording and nothing left the host.
test("NP-4b: web egress refusals leave no request at the web server", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const web = await startFakeWeb(t, PAGE);
	// Built at runtime: a literal token shape in the source would trip the repo's own credential scans.
	const token = ["ghp", "a".repeat(36)].join("_");
	const h = await nativeWorkerHome(t, [
		calls(
			{ name: "WebFetch", input: { url: `${web.url}/x?p=.pi-command-post`, prompt: "read" } },
			{ name: "WebFetch", input: () => ({ url: `${web.url}/x?p=${h.worktree(id)}`, prompt: "read" }) },
			{ name: "WebFetch", input: { url: `${web.url}/x?t=${token}`, prompt: "read" } },
			{ name: "WebSearch", input: () => ({ query: `${h.worktree(id)} error` }) },
		),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Name the package from its docs."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const denied = await h.denials(id);
	assert.deepEqual(web.paths, [], `a refused call reached the web server; denials ${JSON.stringify(denied)}`);
	assert.equal(denied.count, 4, JSON.stringify(denied));
	const results = toolResults(h.claude.requests).slice(0, 4);
	assert.match(results[0] ?? "", /^\[error\] fetch_content refused: command-post state never leaves the host \(\.pi-command-post\)\./);
	// The worktree may sit under CP_HOME, which is checked first: either names a job path.
	assert.match(results[1] ?? "", /^\[error\] fetch_content refused: it contains the value of CP_(HOME|WORKTREE); job paths never leave the host\./);
	assert.match(results[2] ?? "", /^\[error\] fetch_content refused: it matches a credential shape \(github token\)\./);
	assert.match(results[3] ?? "", /^\[error\] web_search refused: it contains the value of CP_(HOME|WORKTREE); job paths never leave the host\./);
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given an implementer, a qa planner and a gate reviewer on the Claude CLI, When each is first offered its
//   tools, Then only the qa planner is offered WebFetch and WebSearch.
test("NP-4c: web stays planner-role only: implementer and reviewer get none, a qa job gets both", { skip: NATIVE, timeout: 420_000 }, async (t) => {
	const ids = { ship: "", qa: "" };
	const verdict = () => ({ job_id: ids.qa, verdict: "pass", reasons: ["checked"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false } });
	const h = await nativeWorkerHome(t, [
		calls({ name: REPORT_TOOL, input: () => blocked(ids.ship) }),
		done,
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.qa)), content: "# native qa\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(ids.qa, h.b.home) }),
		done,
		calls({ name: VERDICT_TOOL, input: verdict }),
		{ kind: "text", text: "Reviewed." },
	]);
	const ship = await h.job("ship");
	const qa = await h.job("research", "local", "qa");
	[ids.ship, ids.qa] = [ship.id, qa.id];
	const { shipFirst, plannerFirst: qaFirst, reviewer } = await shipPlannerReviewer(t, h, ship, qa);
	for (const [who, request] of [["implementer", shipFirst], ["reviewer", reviewer]] as const) {
		assert.deepEqual(offered(request).filter((name) => WEB.includes(name)), [], `${who}: ${offered(request).join(", ")}`);
	}
	assert.deepEqual(offered(qaFirst).filter((name) => WEB.includes(name)).sort(), WEB, offered(qaFirst).join(", "));
	assert.ok(offered(shipFirst).includes("Edit") && offered(reviewer).includes("Read"), "the built-ins are listed beside the MCP tools");
	assert.equal(h.claude.overrun(), 0);
});

type Home = Awaited<ReturnType<typeof nativeWorkerHome>>;
type Job = Awaited<ReturnType<Home["job"]>>;

/**
 * Dispatches `ship` then `planner` (each awaited, so the shared script stays sequential), then runs one native gate
 * reviewer vote on `planner` through the real quality pass; returns each role's first model call.
 */
async function shipPlannerReviewer(t: TestContext, h: Home, ship: Job, planner: Job) {
	// Both jobs stay live beside the reviewer.
	writeFileSync(join(h.b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true, claude_ship: true, claude_review: true, max_concurrent: 3 }));
	const ends = await h.run([ship.dispatch("Report blocked."), h.awaitEnvelope(ship.id), planner.dispatch("Name the package."), h.awaitEnvelope(planner.id)]);
	for (const end of ends.filter((each) => each.toolName === "cp_dispatch")) assert.notEqual(end.isError, true, text(end));
	assert.deepEqual([accepted(h.b.home, ship.id), accepted(h.b.home, planner.id)], [1, 1]);
	await h.b.closeParents();
	const routing = JSON.parse(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8")) as { rubric: unknown[] };
	routing.rubric.unshift({ id: "native-voter", role: "gate-reviewer", model: FAKE_NATIVE_MODEL, driver: "claude" });
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify(routing));
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_NATIVE_MODEL }),
	}));
	// The voter resolves `claude` on this process's PATH, not parentEnv's; without fake-claude there a host with no
	// claude (CI) falls back to pi. An unset PATH is a failure here, never the string "undefined" in process.env.
	const voterPath: string | undefined = h.env.PATH;
	assert.ok(voterPath, "the harness env has no PATH, so the native voter could not find fake-claude and would fall back to pi");
	const saved = process.env.PATH;
	const restore = () => void (saved === undefined ? delete process.env.PATH : (process.env.PATH = saved));
	process.env.PATH = voterPath;
	t.after(restore);
	const panel = await post.qualityPass().runAndWait({ jobId: planner.id, task: "Name the package.", config: { verify: true, voters: 1, threshold: 1 } }).finally(restore);
	const votes = panel?.verify?.votes ?? [];
	assert.deepEqual(votes.map((vote) => [vote.model, vote.sound]), [[FAKE_NATIVE_MODEL, true]], JSON.stringify(votes));
	const modelCalls = h.claude.requests.filter(isModelCall);
	const reviewer = modelCalls.find((request) => system(request).includes("Native reviewer:"));
	const plannerFirst = modelCalls.find((request) => !system(request).includes("Native reviewer:") && JSON.stringify(request.body.messages).includes(planner.id));
	const shipFirst = modelCalls.find((request) => JSON.stringify(request.body.messages).includes(ship.id));
	for (const [who, request] of [["implementer", shipFirst], ["planner", plannerFirst], ["reviewer", reviewer]] as const) assert.ok(request, `${who}'s model call`);
	return { shipFirst, plannerFirst, reviewer };
}

const PROBE_SERVER = join(REPO_ROOT, "tests/fixtures/mcp-probe-server.mjs");
const PROBE_TOOLS = ["delete_thing", "odd_thing", "plain", "read_thing", "write_thing"].map((name) => `mcp__probe__${name}`);
const HIDDEN = /^\[error\] Refused: mcp__probe__delete_thing is hidden in \S+mcp\.json\.$/;

/** Writes `mcp.json` in the agent dir every worker inherits (`PI_CODING_AGENT_DIR`); returns the probe log. */
function userMcp(h: Home, servers: (probe: (label: string) => Record<string, unknown>) => Record<string, unknown>): string {
	const log = join(h.b.agent.path, "mcp.log");
	const probe = (label: string) => ({ command: process.execPath, args: [PROBE_SERVER, label, log] });
	writeFileSync(join(h.b.agent.path, "mcp.json"), JSON.stringify({ mcpServers: servers(probe) }));
	return log;
}
const probeCalls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("call ")) : []);
const probeOffered = (request: RecordedClaudeRequest | undefined) => offered(request).filter((name) => /^mcp__(probe|off)__/.test(name)).sort();

// Scenario: Given mcp.json with a stdio server (delete_* hidden) and one enabled: false, When a native implementer,
//   planner and gate reviewer start, Then each is offered every mcp__probe__* tool and no mcp__off__*, read_thing runs
//   on the server, delete_thing is refused as hidden, and the lockdown passes with the server declared optional.
test("NP-5a: every native role reaches the user's MCP servers; hidden tools refused, disabled servers absent", { skip: NATIVE, timeout: 420_000 }, async (t) => {
	const ids = { ship: "", planner: "" };
	const verdict = () => ({ job_id: ids.planner, verdict: "pass", reasons: ["checked"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false } });
	const h = await nativeWorkerHome(t, [
		calls({ name: "mcp__probe__read_thing", input: {} }, { name: "mcp__probe__delete_thing", input: {} }),
		calls({ name: REPORT_TOOL, input: () => blocked(ids.ship) }),
		done,
		calls({ name: "mcp__probe__read_thing", input: {} }),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.planner)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(ids.planner, h.b.home) }),
		done,
		calls({ name: VERDICT_TOOL, input: verdict }),
		{ kind: "text", text: "Reviewed." },
	]);
	const log = userMcp(h, (probe) => ({ probe: { ...probe("probe"), toolExposure: { "delete_*": "hidden" } }, off: { ...probe("off"), enabled: false } }));
	const ship = await h.job("ship");
	const planner = await h.job("research");
	[ids.ship, ids.planner] = [ship.id, planner.id];
	const firsts = await shipPlannerReviewer(t, h, ship, planner);
	for (const [who, request] of Object.entries(firsts)) assert.deepEqual(probeOffered(request), PROBE_TOOLS, `${who}: ${offered(request).join(", ")}`);
	assert.match(system(firsts.plannerFirst), /MCP servers \(from \S+mcp\.json; tools mcp__<server>__<tool>/);
	assert.doesNotMatch(system(firsts.plannerFirst), /- off/);
	const results = toolResults(h.claude.requests);
	assert.equal(results.filter((result) => result === "ok:read_thing").length, 2, results.join("\n"));
	assert.equal(results.filter((result) => HIDDEN.test(result)).length, 1, results.join("\n"));
	assert.deepEqual(probeCalls(log), ["call probe read_thing", "call probe read_thing"]);
	for (const id of [ship.id, planner.id]) assert.equal((await h.runs(id))[0]?.lockdown, "ok", id);
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: Given mcp.json naming a server `picp` beside `probe`, When a native planner runs, Then the user's picp is
//   skipped with one line (stderr and a native_mcp_skipped run event), probe loads, and picp's own report_result is
//   the one accepted: no mcp__picp__* tool of the user's server is offered.
test("NP-5b: a user MCP server named picp is skipped by name; picp's own report_result still lands", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const h = await nativeWorkerHome(t, [
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	userMcp(h, (probe) => ({ picp: probe("picp"), probe: probe("probe") }));
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Name the package."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	assert.equal(accepted(h.b.home, id), 1);
	const skipped = readRunEvents(h.b.home, id).filter((event) => event.type === "native_mcp_skipped").map((event) => (event.payload as { lines: string[] }).lines);
	assert.deepEqual(skipped, [["MCP server picp not loaded: picp is the worker's own server"]]);
	const first = h.claude.requests.find(isModelCall);
	assert.deepEqual(offered(first).filter((name) => name.startsWith("mcp__picp__")).sort(), [REPORT_TOOL, "mcp__picp__gh_read"].sort(), offered(first).join(", "));
	assert.ok(offered(first).includes("mcp__probe__read_thing"), offered(first).join(", "));
	assert.equal((await h.runs(id))[0]?.lockdown, "ok");
});

// Scenario (A9): Given a native planner with web on and a user MCP server, both declared optional to the lockdown,
//   When the CLI's init also lists a tool, an MCP server and a plugin picp never passed, Then the lockdown counts each
//   (tools 1, mcpServers 1, plugins 1), refuses before any tool runs, and the job fails as a named lockdown stop.
//   NP-5a is the control: the same optional web and probe surface without the strays passes.
test("NP-5c: the lockdown still refuses an extra tool, MCP server and plugin while web and user MCP are optional", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	const stray = { tools: ["mcp__stray__run"], mcp_servers: [{ name: "stray", status: "connected" }], plugins: [{ name: "stray", path: "/opt/stray-plugin" }] };
	const h = await nativeWorkerHome(t, [calls({ name: "mcp__probe__read_thing", input: {} }), done], { settingsEnv: { FAKE_CLAUDE_INIT_EXTRA: JSON.stringify(stray) } });
	const log = userMcp(h, (probe) => ({ probe: probe("probe") }));
	const job = await h.job("research");
	const ends = await h.run([job.dispatch("Name the package.")]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const record = await waitFor(() => h.record(job.id), (entry) => entry?.phase === "failed", { timeoutMs: 120_000, what: "the failed native job" });
	assert.equal(record?.failure?.class, "spawn_failed");
	assert.match(record?.failure?.message ?? "", /^native run stopped: the Claude CLI lockdown refused the loaded surface before any tool ran; not nudged\./);
	const run = readRunEvents(h.b.home, job.id).find((event) => event.type === "native_run")?.payload as { lockdown?: string; stop?: string; extra?: Record<string, number> } | undefined;
	assert.deepEqual([run?.lockdown, run?.stop], ["refused", "lockdown"], JSON.stringify(run));
	assert.deepEqual(run?.extra, { tools: 1, mcpServers: 1, skills: 0, plugins: 1, agents: 0, slashCommands: 0, hooks: 0, outputStyle: 0 }, JSON.stringify(run));
	assert.deepEqual(probeCalls(log), [], "no MCP tool ran before the lockdown");
	assert.equal(accepted(h.b.home, job.id), 0);
});
