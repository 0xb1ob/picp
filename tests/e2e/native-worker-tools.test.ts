/**
 * Claude/pi worker tool parity (WP4+): native jobs through the real `cp_dispatch` of a pi parent (mock model), with
 * fake-claude as the CLI on CI and only boundary services faked. NP-4a…NP-4c pin the planner role's web tools,
 * NP-6a per-job skills.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { VERDICT_TOOL } from "../../src/drivers/claude-verdict.ts";
import { type ClaudeStep, type ClaudeToolUse, FAKE_NATIVE_MODEL, type RecordedClaudeRequest, toolResults } from "../harness/claude-mock-provider.ts";
import { readRunEvents, REPO_ROOT, type ScriptStep } from "../harness/index.ts";
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
	// Both jobs stay live beside the reviewer; the dispatch order keeps the shared script sequential.
	writeFileSync(join(h.b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true, claude_ship: true, claude_review: true, max_concurrent: 3 }));
	const ship = await h.job("ship");
	const qa = await h.job("research", "local", "qa");
	[ids.ship, ids.qa] = [ship.id, qa.id];
	const ends = await h.run([ship.dispatch("Report blocked."), h.awaitEnvelope(ship.id), qa.dispatch("Name the package."), h.awaitEnvelope(qa.id)]);
	for (const end of ends.filter((each) => each.toolName === "cp_dispatch")) assert.notEqual(end.isError, true, text(end));
	assert.deepEqual([accepted(h.b.home, ship.id), accepted(h.b.home, qa.id)], [1, 1]);
	await h.b.closeParents();
	const routing = JSON.parse(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8")) as { rubric: unknown[] };
	routing.rubric.unshift({ id: "np4c-voter", role: "gate-reviewer", model: FAKE_NATIVE_MODEL, driver: "claude" });
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify(routing));
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_NATIVE_MODEL }),
	}));
	// The voter's native selection resolves `claude` on this process's PATH, not parentEnv's: without fake-claude
	// there, a host with no installed claude (CI) falls back to pi, which cannot serve the native model.
	const path = process.env.PATH;
	process.env.PATH = h.env.PATH;
	t.after(() => void (process.env.PATH = path));
	const panel = await post.qualityPass().runAndWait({ jobId: qa.id, task: "Name the package.", config: { verify: true, voters: 1, threshold: 1 } }).finally(() => {
		process.env.PATH = path;
	});
	const votes = panel?.verify?.votes ?? [];
	assert.deepEqual(votes.map((vote) => [vote.model, vote.sound]), [[FAKE_NATIVE_MODEL, true]], JSON.stringify(votes));
	const modelCalls = h.claude.requests.filter(isModelCall);
	const system = (request: RecordedClaudeRequest) => JSON.stringify(request.body.system ?? "");
	const reviewer = modelCalls.find((request) => system(request).includes("Native reviewer:"));
	const qaFirst = modelCalls.find((request) => !system(request).includes("Native reviewer:") && JSON.stringify(request.body.messages).includes(qa.id));
	const shipFirst = modelCalls.find((request) => JSON.stringify(request.body.messages).includes(ship.id));
	for (const [who, request] of [["implementer", shipFirst], ["reviewer", reviewer]] as const) {
		assert.ok(request, `${who}'s model call`);
		assert.deepEqual(offered(request).filter((name) => WEB.includes(name)), [], `${who}: ${offered(request).join(", ")}`);
	}
	assert.deepEqual(offered(qaFirst).filter((name) => WEB.includes(name)).sort(), WEB, offered(qaFirst).join(", "));
	assert.ok(offered(shipFirst).includes("Edit") && offered(reviewer).includes("Read"), "the built-ins are listed beside the MCP tools");
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: Given cp_dispatch skills ["tdd-x"] on a claude row, When the job runs, Then it runs native (no `ineligible`
//   refusal), its brief names tdd-x/SKILL.md, and its Read returns the skill body. Catches the per-job skills refusal.
test("NP-6a: a native job with a per-job skill reads its SKILL.md", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const body = "---\nname: tdd-x\ndescription: does tdd-x\n---\nnp6 skill body: write the failing test first.\n";
	let skillFile = "";
	const h = await nativeWorkerHome(t, [
		calls({ name: "Read", input: () => ({ file_path: skillFile }) }),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const dir = join(h.b.agent.path, "skills", "tdd-x");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body);
	skillFile = join(realpathSync(dir), "SKILL.md");
	const job = await h.job("research");
	id = job.id;
	const step = job.dispatch("Name the package.");
	const withSkill: ScriptStep = { kind: "tool_calls", calls: step.kind === "tool_calls" ? step.calls.map((call) => ({ ...call, args: { ...(call.args as Record<string, unknown>), skills: ["tdd-x"] } })) : [] };
	const ends = await h.run([withSkill, h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const first = h.claude.requests.find(isModelCall);
	const brief = JSON.stringify(first?.body.messages ?? "");
	assert.ok(brief.includes(skillFile), "the brief names the SKILL.md path");
	assert.match(brief, /Read each SKILL\.md before you start/);
	assert.equal(toolResults(h.claude.requests)[0], body);
	const [run] = await h.runs(id);
	assert.deepEqual([run?.lockdown, run?.denials, run?.report], ["ok", 0, true], JSON.stringify(run));
	assert.equal(accepted(h.b.home, id), 1);
});
