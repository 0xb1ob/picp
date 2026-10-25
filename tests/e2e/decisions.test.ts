/**
 * Behavior 09 (P10): decisions a human reads and answers, driven through a real pi parent (command-post) or the
 * operator's cp-bridge session, with a mock model. The consumers are /cp-awaiting, cp_status_block, cp_decide,
 * /cp-ask, the parent-lock gate and cp_parent's ask journal.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, layoutForHome, SCHEMA_VERSION } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { initJobsDocument, readJobsDocument } from "../../src/ledger.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import {
	COMMAND_POST_EXTENSION,
	CP_BRIDGE_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	type PiChild,
	REPO_ROOT,
	type RpcRecord,
	type ScriptStep,
	startPiChild,
} from "../harness/index.ts";

type Home = ReturnType<typeof createScratchHome>;

/** A pi child on `home` whose mock model runs `steps`; torn down after the test. */
async function child(t: TestContext, home: Home, extension: string, steps: ScriptStep[], env: NodeJS.ProcessEnv = {}) {
	const provider = await MockProvider.start();
	const script = `decisions-${Math.random().toString(16).slice(2)}`;
	const model = provider.addScript(script, steps);
	const agentDir = createAgentDir({ provider });
	const pi = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path, ...env }, extensions: [extension] });
	t.after(async () => {
		await pi.close();
		agentDir.cleanup();
		await provider.stop();
	});
	return { pi, provider, script };
}

/** Run one prompt to its settle; the tool ends it produced, by tool call id. */
async function turn(pi: PiChild, message: string): Promise<Map<string, RpcRecord>> {
	const from = pi.records().length;
	await pi.prompt(message);
	await pi.waitFor((r) => r.type === "agent_settled" && pi.records().indexOf(r) >= from, 90_000);
	return new Map(pi.records().slice(from).filter((r) => r.type === "tool_execution_end").map((r) => [String(r.toolCallId), r]));
}

/** Run a slash command; the notifications it raised. */
async function command(pi: PiChild, text: string): Promise<RpcRecord[]> {
	const from = pi.records().length;
	const response = await pi.prompt(text);
	assert.equal(response.success, true, `${text}: ${JSON.stringify(response)}`);
	return pi.records().slice(from).filter((r) => r.type === "extension_ui_request" && r.method === "notify");
}

const said = (end: RpcRecord | undefined) => JSON.stringify(end?.result);

function record(home: string, jobId: string, over: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(),
		worker: { pid: process.pid, session_id: "s", session_file: join(home, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() },
		worktree: join(home, "wt"), branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, ...over,
	};
}

const choice = (jobId: string) => `Ship ${jobId}, drop it, or open a follow-up?`;
const row = (jobId?: string) => ({ type: "approval", decision: choice(jobId ?? "the work"), why: "the work is finished", blocks: `${jobId} close`, ...(jobId ? { job_id: jobId } : {}) });
const DESIGN = { type: "design", decision: "Postgres or sqlite for the data layer?", why: "schema choice", blocks: "the data layer" };

test("decisions: /cp-awaiting offers open declared rows with its hints; a merged, done or closed job's row is not offered and the status block refuses one", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initJobsDocument(home.path, "cp");
	const seed = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await seed.registry.register({ name: "demo", clone_url: "https://example.invalid/demo.git", delivery: "local" });
	const live = (await seed.ledger().create({ title: "live job", project: "demo", kind: "ship", delivery: "local" })).id;
	const closed = (await seed.ledger().create({ title: "closing job", project: "demo", kind: "ship", delivery: "local" })).id;
	await seed.shutdown();
	const fleet = new FleetStore({ home: home.path });
	for (const id of [live, closed, "cp-merged", "cp-done"]) await fleet.add(record(home.path, id));
	await fleet.add(record(home.path, "cp-gone", { phase: "done" }));
	const store = () => new AwaitingStore({ home: home.path });
	const idOf = (jobId: string) => store().list().find((item) => item.job_id === jobId)?.id ?? `missing-${jobId}`;
	const quote = "Ship the live job as it stands.";
	const { pi, provider, script } = await child(t, home, COMMAND_POST_EXTENSION, [
		{ kind: "tool_calls", calls: [{ id: "block", name: "cp_status_block", args: { awaiting: [row("cp-merged"), row("cp-done"), row(closed), row(live), DESIGN, row("cp-unknown"), row("cp-gone")] } }] },
		{ kind: "text", text: "rendered" },
		{ kind: "tool_calls", calls: [{ id: "decide", name: "cp_decide", args: () => ({ target: idOf(live), decision: "ship", basis: { operator_quote: quote } }) }] },
		{ kind: "text", text: "closed and answered" },
	]);

	const empty = await command(pi, "/cp-awaiting");
	assert.deepEqual(empty.map((n) => String(n.message)).filter((message) => message.startsWith("Awaiting you")), ["Awaiting you: none"]);
	pi.send({ id: "commands", type: "get_commands" });
	const commands = JSON.stringify((await pi.waitFor((r) => r.type === "response" && r.id === "commands")).data);
	assert.match(commands, /"cp-awaiting"/);
	assert.doesNotMatch(commands, /"cp-decide"|"cp-authorize"/, "the decision overlay commands are retired");

	const first = await turn(pi, "Render the status block.");
	const block = said(first.get("block"));
	for (const jobId of ["cp-merged", "cp-done", closed, live, "cp-unknown"]) assert.ok(block.includes(choice(jobId)), `${jobId} row rendered`);
	assert.ok(block.includes(DESIGN.decision));
	assert.match(block, /cp-gone is already done, so this decision is obsolete/, "a done job's row is a refusal notice, not an open row");
	const refusals = pi.records().filter((r) => r.type === "extension_ui_request" && /Awaiting row refused/.test(String(r.message)));
	assert.deepEqual(refusals.map((r) => String(r.message)), ["Awaiting row refused, not stored: cp-gone is already done, so this decision is obsolete — it is not offered as an open question."]);
	assert.equal(store().list().length, 6, "no row is minted for a decision the world has taken");
	assert.match(JSON.stringify(provider.requests(script)[0]?.body.tools ?? []), /"cp_decide"/);

	await fleet.patch("cp-merged", { receipts: [{ kind: "pr", status: "merged", title: "PR #111", url: "https://github.com/x/y/pull/111" }] });
	await fleet.patch("cp-done", { phase: "done" });
	const closer = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await closer.ledger().close(closed, "superseded by a later job");
	await closer.shutdown();
	const second = await turn(pi, `${quote} Record that answer.`);
	assert.notEqual(second.get("decide")?.isError, true, said(second.get("decide")));
	await fleet.patch(live, { phase: "done" });

	const listing = (await command(pi, "/cp-awaiting")).map((n) => String(n.message)).filter((message) => message.startsWith("Awaiting you"));
	assert.equal(listing.length, 1);
	const lines = String(listing[0]).split("\n");
	assert.equal(lines[0], "Awaiting you:");
	assert.equal(lines.length, 6, "two rows, no context lines, a blank and the two hints");
	const offered = lines.filter((line) => line.startsWith("  - "));
	assert.deepEqual(offered.map((line) => line.includes(DESIGN.decision) || line.includes(choice("cp-unknown"))), [true, true], lines.join("\n"));
	assert.equal(lines.at(-2), "Answer one: cp_decide with a mandate {mandate, clause} or {operator_quote} basis.");
	assert.equal(lines.at(-1), "Full context: /watch <job-id> for the run, /cp-plan <job-id> for the plan or its gate decision.");

	// Obsolete-on-read: nothing was withdrawn, and the recorded answer stays as given.
	const items = store().list();
	assert.equal(items.length, 6);
	assert.deepEqual(items.filter((item) => item.state === "open").map((item) => item.job_id ?? "-").sort(), ["-", "cp-done", "cp-merged", "cp-unknown", closed].sort());
	const answered = items.find((item) => item.job_id === live);
	assert.deepEqual([answered?.state, answered?.answer, answered?.answered_by], ["answered", "ship", "operator-quote"]);
	assert.equal(provider.remaining(script), 0);
});

test("decisions: /cp-ask keeps the question verbatim, refuses bad arguments before any job exists, and cp_ask needs the parent lock", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	t.after(() => { repo.cleanup(); home.cleanup(); });
	initJobsDocument(home.path, "cp");
	const seed = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await seed.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	await seed.shutdown();
	const titles = () => readJobsDocument(home.path).jobs.map((job) => [job.title, job.labels.includes("delivery:answer")]);
	const { pi } = await child(t, home, COMMAND_POST_EXTENSION, [{ kind: "text", text: "unused" }]);

	for (const [args, refusal] of [["", /usage: \/cp-ask/], ["demo", /needs a question about demo/], ["demo why? --model", /--model needs a model ref/], ["--verbose demo why?", /unknown argument/]] as const) {
		const notices = await command(pi, `/cp-ask ${args}`.trim());
		assert.ok(notices.some((n) => n.notifyType === "error" && refusal.test(String(n.message))), `/cp-ask ${args}: ${JSON.stringify(notices)}`);
	}
	assert.deepEqual(titles(), [], "a refused /cp-ask creates no job");

	await command(pi, "/cp-ask demo Why does --json always notify?");
	const modelled = await command(pi, "/cp-ask demo  which   module owns  the pool? --model mock/absent-model");
	assert.deepEqual(titles(), [["Why does --json always notify?", true], ["which module owns the pool?", true]]);
	assert.match(JSON.stringify(modelled), /mock\/absent-model/, "--model reaches the dispatch");

	const locked = createScratchHome();
	t.after(() => locked.cleanup());
	mkdirSync(join(locked.path, LAYOUT.state), { recursive: true });
	writeFileSync(join(locked.path, LAYOUT.state, "parent.lock"), JSON.stringify({ schema_version: SCHEMA_VERSION, pid: process.pid, home: locked.path, started_at: "2026-09-02T00:00:00Z" }));
	const fenced = await child(t, locked, COMMAND_POST_EXTENSION, [
		{ kind: "tool_calls", calls: [{ id: "ask", name: "cp_ask", args: { project: "demo", question: "Where is the pool?" } }] },
		{ kind: "text", text: "refused" },
	]);
	const ends = await turn(fenced.pi, "Ask where the pool is.");
	assert.equal(ends.get("ask")?.isError, true);
	assert.match(said(ends.get("ask")), /cp_ask needs this home's parent lock/);
});

test("decisions: cp_parent ask journals open, answer and withdraw append-only; every invalid ask, answer or withdraw is refused before append", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, layoutForHome("multi", home.path).state, "operator", "asks.jsonl");
	const asks = () => new OperatorAsks(file).list();
	const input = { project: "example", question: "Proceed?", options: [{ label: "yes", consequence: "Changes scope" }], recommendation: "yes" };
	const two = [{ label: "approve", consequence: "Plan proceeds" }, { label: "drop", consequence: "Job closes" }];
	const words = "  Yes, proceed.\nWith care.  ";
	const ask = (id: string, args: Record<string, unknown> | (() => Record<string, unknown>)) => ({ id, name: "cp_parent", args: typeof args === "function" ? () => ({ action: "ask", ...args() }) : { action: "ask", ...args } });
	const call = (id: string, action: string, args: () => Record<string, unknown>) => ({ id, name: "cp_parent", args: () => ({ action, ...args() }) });
	let before = "";
	const { pi, provider, script } = await child(t, home, CP_BRIDGE_EXTENSION, [
		{ kind: "tool_calls", calls: [ask("first", { ask: { ...input, source_escalation: "es-example", job_ids: ["cp-example"], evidence_paths: ["report.md"] } })] },
		{ kind: "tool_calls", calls: [call("answer", "ask_answer", () => ((before = readFileSync(file, "utf8")), { id: asks()[0]?.id, answer: words }))] },
		{ kind: "tool_calls", calls: [ask("second", { ask: input })] },
		{ kind: "tool_calls", calls: [call("withdraw", "ask_withdraw", () => ({ id: asks()[1]?.id, reason: "No longer needed" }))] },
		{ kind: "tool_calls", calls: [
			call("again", "ask_answer", () => ({ id: asks()[0]?.id, answer: "again" })),
			call("unknown-answer", "ask_answer", () => ({ id: "ask-unknown", answer: "yes" })),
			call("unknown-withdraw", "ask_withdraw", () => ({ id: "ask-unknown", reason: "gone" })),
			ask("blank", { ask: { ...input, question: " " } }),
			ask("none", { ask: { ...input, options: [] } }),
			ask("six", { ask: { ...input, options: Array(6).fill(input.options[0]) } }),
			ask("sentence", { ask: { ...input, options: two, recommendation: "approve: because the plan is sound" } }),
		] },
		{ kind: "tool_calls", calls: [ask("long", { ask: { ...input, options: [{ label: "yes", consequence: "x".repeat(201) }] } })] },
		{ kind: "tool_calls", calls: [
			call("blank-answer", "ask_answer", () => ({ id: asks()[2]?.id, answer: " " })),
			call("blank-withdraw", "ask_withdraw", () => ({ id: asks()[2]?.id, reason: " " })),
			ask("trimmed", { ask: { ...input, options: two, recommendation: " approve " } }),
		] },
		{ kind: "text", text: "journaled" },
	], { PI_HOME: home.path, CP_MODE: "multi" });

	const ends = await turn(pi, "Record the operator asks.");
	assert.equal(provider.remaining(script), 0);
	for (const id of ["first", "answer", "second", "withdraw", "long", "trimmed"]) assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(ends.get(id))}`);
	assert.match(String(JSON.parse(said(ends.get("first"))).details?.id), /^ask-[a-f0-9]+$/);
	for (const id of ["again", "unknown-answer", "unknown-withdraw", "blank", "none", "six", "sentence", "blank-answer", "blank-withdraw"]) assert.equal(ends.get(id)?.isError, true, `${id} is refused`);
	assert.match(said(ends.get("again")), /not open/);
	assert.match(said(ends.get("unknown-answer")), /unknown operator ask ask-unknown/);
	assert.match(said(ends.get("unknown-withdraw")), /unknown operator ask ask-unknown/);
	assert.match(said(ends.get("sentence")), /recommendation must be exactly one option label \(\\"approve\\", \\"drop\\"\); put the rationale in context/);

	const text = readFileSync(file, "utf8");
	assert.ok(text.startsWith(before) && before.length > 0, "history is appended, never rewritten");
	assert.equal(text.trim().split("\n").length, 6, "three opens, one answer, one withdraw, one trimmed open; nothing refused was journaled");
	const [first, second, long, trimmed] = asks();
	assert.deepEqual([first?.state, first?.answer, first?.source_escalation, first?.job_ids, first?.evidence_paths], ["answered", words, "es-example", ["cp-example"], ["report.md"]]);
	assert.deepEqual([second?.state, second?.reason], ["withdrawn", "No longer needed"]);
	assert.deepEqual([long?.state, long?.options[0]?.consequence], ["open", `${"x".repeat(199)}\u2026`]);
	assert.equal(trimmed?.recommendation, " approve ", "a label after trim is accepted as given");
	assert.deepEqual(new OperatorAsks(file).open().map((item) => item.id), [long?.id, trimmed?.id]);
});
