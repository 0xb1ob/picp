/**
 * Behavior 09, P10d: escalation records and the one-question-per-decision Awaiting rows, through a real pi parent with
 * the command-post extension and a mock model. State is seeded on disk; every raise, answer, withdrawal and listing
 * goes through the parent's own cp_* tools.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, LAYOUT, type FleetRecord, type PipelineRecord, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { FleetStore } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";
import { PipelineStore } from "../../src/pipeline.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type RpcRecord, startPiChild } from "../harness/index.ts";

type Call = { id: string; name: string; args: Record<string, unknown> };
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, args });

/** A scratch home and a real pi parent per prompt; each `turns` entry is one model turn of (parallel) tool calls. */
async function bench(t: TestContext, name: string) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	let prompts = 0;
	t.after(async () => {
		await provider.stop();
		agentDir.cleanup();
		home.cleanup();
	});
	const parent = async (prompt: string, ...turns: Call[][]) => {
		const model = provider.addScript(`${name}-${(prompts += 1)}`, [...turns.map((calls) => ({ kind: "tool_calls" as const, calls })), { kind: "text" as const, text: "done" }]);
		agentDir.writeModels(provider);
		const child = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			await child.prompt(prompt);
			await child.waitForSettled(90_000);
			const ends = new Map(child.eventsOfType("tool_execution_end").map((end) => [String(end.toolCallId), end]));
			const widgets = child.records().filter((record: RpcRecord) => record.type === "extension_ui_request" && record.method === "setWidget");
			return { ends, widgets };
		} finally {
			await child.close();
		}
	};
	return { home: home.path, parent };
}

type Ends = Awaited<ReturnType<Awaited<ReturnType<typeof bench>>["parent"]>>["ends"];
const said = (ends: Ends, id: string) => JSON.stringify(ends.get(id)?.result);
const ok = (ends: Ends, id: string) => assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(ends, id)}`);
const failed = (ends: Ends, id: string, pattern: RegExp) => {
	assert.equal(ends.get(id)?.isError, true, `${id}: ${said(ends, id)}`);
	assert.match(said(ends, id), pattern, id);
};

const OPTIONS = [
	{ id: "approve", label: "approve", consequence: "proceed", cost: "none" },
	{ id: "decline", label: "decline", consequence: "stop", cost: "sunk" },
];
const raise = (id: string, job_ids: string[], kind: string, question: string, over: Record<string, unknown> = {}) =>
	call(id, "cp_escalate", { job_ids, kind, question, options: OPTIONS, recommended: "approve", ...over });
const decide = (id: string, target: string, decision: string, quote: string) => call(id, "cp_decide", { target, decision, basis: { operator_quote: quote } });
const withdraw = (id: string, escalation_id: string | undefined, reason: string) =>
	call(id, "cp_escalate", { action: "withdraw", ...(escalation_id ? { escalation_id } : {}), reason });

test("P10d-escalate: cp_escalate keys one record per question, cp_decide keeps the first quote and decides a linked checkpoint, withdraw and revoke leave nothing answerable", { timeout: 300_000 }, async (t) => {
	const s = await bench(t, "p10d-escalate");
	const checkpoints = new CheckpointStore(s.home);
	for (const jobId of ["cp-ship1", "cp-ship2", "cp-ship3"]) checkpoints.request({ jobId, question: `authorize ${jobId}?` });
	const grant = new MandateStore(s.home).issue({ projects: ["demo"], objective: "p10d", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5, ask_on: [] });
	const spend = (usd: number) => `md-a70d44 spend cap reached (usd ${usd})`;
	const mission = (mandate: string, cost: string) => `${mandate} mission end: landed 2, dropped 0, cost $${cost}`;
	const fresher = [{ id: "stop", label: "stop", consequence: "halt", cost: "sunk" }, { id: "widen", label: "widen", consequence: "new grant", cost: "spend" }];

	let { ends } = await s.parent("File the escalations.", [
		raise("r1", ["cp-job1"], "product_ambiguity", "which copy?"),
		raise("b1", ["cp-job1"], "budget_exhausted", "md-a70d44 job cap reached (3)"),
		raise("m1", ["cp-a", "cp-b"], "mission_end", mission("md-a70d44", "3.10"), { mandate_id: "md-a70d44" }),
		raise("t1", ["cp-a"], "budget_exhausted", "md-a70d44 token cap reached (3000000 non-cached; token_ceiling 100000000)", { mandate_id: "md-a70d44" }),
		raise("u1", ["cp-a"], "budget_exhausted", spend(20), { mandate_id: "md-a70d44" }),
		raise("l1", ["cp-ship1"], "conflicting_acceptance", "ship cp-ship1 anyway?", { checkpoint_job_id: "cp-ship1" }),
		raise("l2", ["cp-ship2"], "conflicting_acceptance", "ship cp-ship2 anyway?", { checkpoint_job_id: "cp-ship2" }),
		raise("p1", ["cp-ship3"], "conflicting_acceptance", "ship cp-ship3 anyway?", { checkpoint_job_id: "cp-ship3" }),
		raise("w1", ["cp-w"], "product_ambiguity", "withdraw me?"),
		raise("x1", ["cp-x"], "product_ambiguity", "answer or withdraw?"),
		raise("c1", ["cp-c"], "product_ambiguity", "approve or decline?"),
		raise("s1", ["cp-s"], "budget_exhausted", `${grant.id} spend cap reached (usd 10)`, { mandate_id: grant.id }),
		raise("sa", ["cp-sa"], "product_ambiguity", `${grant.id} answered before revoke?`, { mandate_id: grant.id }),
	], [
		raise("r2", ["cp-job1"], "product_ambiguity", "which copy?"),
		raise("b2", ["cp-job1"], "budget_exhausted", "md-b81e55 spend cap reached (usd 20)"),
		raise("m2", ["cp-b", "cp-a"], "mission_end", mission("md-a70d44", "3.85"), { mandate_id: "md-a70d44" }),
		raise("m3", ["cp-a", "cp-b"], "mission_end", mission("md-b81e55", "4.00"), { mandate_id: "md-b81e55" }),
		raise("u2", ["cp-a"], "budget_exhausted", spend(25), { mandate_id: "md-a70d44", options: fresher, recommended: "widen", evidence_paths: ["state/mandates/md-a70d44.json"] }),
		call("bare", "cp_escalate", { action: "raise", job_ids: ["cp-a"] }),
	]);
	const store = new EscalationStore({ home: s.home });
	const id = (callId: string) => (ends.get(callId)?.result as { details: { id: string } }).details.id;
	for (const callId of ["r1", "b1", "m1", "t1", "u1", "l1", "l2", "p1", "w1", "x1", "c1", "s1", "sa", "r2", "b2", "m2", "m3", "u2"]) ok(ends, callId);
	failed(ends, "bare", /raise needs job_ids, kind, question, options and recommended/);
	// One subject is one record; a new question for the same job and kind is its own (es-12172b swallowed one).
	assert.equal(id("r2"), id("r1"));
	assert.notEqual(id("b2"), id("b1"));
	assert.equal(store.get(id("b1"))?.question, "md-a70d44 job cap reached (3)", "the older record keeps its own title");
	assert.equal(id("m2"), id("m1"), "a grant's mission end with new numbers stays one record");
	assert.match(String(store.get(id("m1"))?.question), /cost \$3\.85/);
	assert.notEqual(id("m3"), id("m1"), "another grant's question is its own record");
	assert.notEqual(id("u1"), id("t1"), "a USD cap after a token cap on one grant is its own question");
	assert.equal(id("u2"), id("u1"));
	const refreshed = store.get(id("u1"));
	assert.deepEqual([refreshed?.question, refreshed?.options.map((o) => o.id), refreshed?.recommended, refreshed?.evidence_paths], [spend(25), ["stop", "widen"], "widen", ["state/mandates/md-a70d44.json"]]);
	assert.equal(store.list({ jobId: "cp-job1", kind: "product_ambiguity" }).length, 1);

	const [r1, l1, l2, p1, w1, x1, c1, s1, sa, b1] = ["r1", "l1", "l2", "p1", "w1", "x1", "c1", "s1", "sa", "b1"].map(id);
	const prompt = [`${r1}: Proceed with the approved change.`, `${r1} again: A different quote.`, ...[l1, l2, p1, w1, x1, c1, s1, sa].map((es) => `Approve ${es}. Decline ${es}.`)].join("\n");
	({ ends } = await s.parent(prompt, [
		decide("d-r1", r1!, "approve", "Proceed with the approved change."),
		decide("d-l1", l1!, "approve", `Approve ${l1}.`),
		decide("d-sa", sa!, "approve", `Approve ${sa}.`),
		withdraw("wd-l2", l2, "moot"),
		withdraw("wd-w1", w1, "the copy question was settled in the PR"),
		withdraw("wd-blank", b1, "  "),
		withdraw("wd-noid", undefined, "moot"),
		withdraw("wd-unknown", "es-nope00", "moot"),
		decide("race-x-answer", x1!, "approve", `Approve ${x1}.`),
		withdraw("race-x-withdraw", x1, "raced"),
		decide("race-c-approve", c1!, "approve", `Approve ${c1}.`),
		decide("race-c-decline", c1!, "decline", `Decline ${c1}.`),
		decide("race-p-approve", p1!, "approve", `Approve ${p1}.`),
		decide("race-p-decline", p1!, "decline", `Decline ${p1}.`),
	], [
		decide("d-r1-again", r1!, "approve", "A different quote."),
		decide("d-w1", w1!, "approve", `Approve ${w1}.`),
		decide("d-l2", l2!, "approve", `Approve ${l2}.`),
		withdraw("wd-r1", r1, "moot"),
	], [call("revoke", "cp_mandate", { action: "revoke", mandate_id: grant.id })], [
		decide("d-s1", s1!, "approve", `Approve ${s1}.`),
		withdraw("wd-s1", s1, "moot"),
	]));
	for (const callId of ["d-r1", "d-l1", "d-sa", "wd-l2", "wd-w1", "d-r1-again", "revoke"]) ok(ends, callId);

	// The first quote stands across a reload and an identical retry; a linked checkpoint is decided in the same claim.
	const reloaded = new EscalationStore({ home: s.home });
	assert.deepEqual(reloaded.get(r1!)?.basis, { operator_quote: "Proceed with the approved change." });
	assert.deepEqual([checkpoints.get("cp-ship1")?.decision, checkpoints.get("cp-ship1")?.decided_by], ["approved", "operator-quote"]);
	// A withdrawal is never an answer: the record is unanswerable and its linked checkpoint stays pending.
	assert.match(said(ends, "wd-w1"), new RegExp(`${w1} withdrawn: the copy question was settled in the PR .* not an answer`));
	assert.equal((ends.get("wd-w1")?.result as { details: { reason: string } }).details.reason, "the copy question was settled in the PR");
	assert.deepEqual([reloaded.get(l2!)?.status, reloaded.get(l2!)?.answer], ["withdrawn", undefined]);
	failed(ends, "d-w1", /withdrawn/);
	failed(ends, "d-l2", /withdrawn/);
	assert.equal(checkpoints.get("cp-ship2")?.decision, "pending", "withdrawal never decides the linked checkpoint");
	for (const callId of ["wd-blank", "wd-noid"]) failed(ends, callId, /escalation_id and a nonempty reason/);
	failed(ends, "wd-unknown", /no escalation es-nope00/);
	assert.equal(reloaded.get(b1!)?.status, "open", "a refused withdraw writes nothing");
	failed(ends, "wd-r1", /already answered/);
	assert.equal(reloaded.get(r1!)?.status, "answered");
	// Races in one parallel turn: exactly one call wins, and the record (and its linked checkpoint) reads as the winner.
	const winner = (a: string, b: string) => {
		assert.deepEqual([ends.get(a)?.isError === true, ends.get(b)?.isError === true].sort(), [false, true], `${a}/${b}: ${said(ends, a)} ${said(ends, b)}`);
		return ends.get(a)?.isError === true ? b : a;
	};
	const x = reloaded.get(x1!);
	if (winner("race-x-answer", "race-x-withdraw") === "race-x-answer") assert.deepEqual([x?.status, x?.answer], ["answered", "approve"]);
	else assert.deepEqual([x?.status, x?.answer], ["withdrawn", undefined]);
	const contrary = winner("race-c-approve", "race-c-decline");
	failed(ends, contrary === "race-c-approve" ? "race-c-decline" : "race-c-approve", /already answered/);
	assert.equal(reloaded.get(c1!)?.answer, contrary === "race-c-approve" ? "approve" : "decline");
	const linked = winner("race-p-approve", "race-p-decline");
	failed(ends, linked === "race-p-approve" ? "race-p-decline" : "race-p-approve", /already answered/);
	assert.equal(checkpoints.get("cp-ship3")?.decision, linked === "race-p-approve" ? "approved" : "declined");
	// A revoke supersedes only the grant's open records; a superseded record cannot be answered or withdrawn.
	const superseded = reloaded.get(s1!);
	assert.deepEqual([superseded?.status, superseded?.superseded_reason, superseded?.answer], ["superseded", `${grant.id} was revoked`, undefined]);
	assert.ok(superseded?.superseded_at);
	assert.ok(!reloaded.open().some((item) => item.id === s1));
	assert.equal(reloaded.get(sa!)?.status, "answered", "only open records are ever superseded");
	failed(ends, "d-s1", /superseded/);
	failed(ends, "wd-s1", /superseded/);
});

/** A finished research job as the fleet file holds one (`phase: held`, no PR receipt). */
const heldResearch = (jobId: string, delivery: "pipeline" | "pr"): FleetRecord => ({
	job_id: jobId, project: "demo", kind: "research", delivery, origin: DEFAULT_ORIGIN, phase: "held", worktree: `/tmp/${jobId}`, branch: jobId,
	dispatched_at: "2026-09-04T17:00:00Z", reported_at: "2026-09-04T18:00:00Z", usage: { ...EMPTY_USAGE },
	worker: { pid: process.pid, session_id: `sess-${jobId}`, session_file: `/sessions/${jobId}.jsonl`, profile: "planner", role: "planner", model: "mock/planner", started_at: "2026-09-04T17:00:00Z" },
}) as FleetRecord;
const pipeline = (research_id: string, ship_id: string, over: Partial<PipelineRecord> = {}): PipelineRecord => ({
	schema_version: SCHEMA_VERSION, research_id, ship_id, project: "demo", delivery: "pr", state: "awaiting_authorization",
	created_at: "2026-09-04T17:00:00Z", updated_at: "2026-09-04T18:07:00Z", ...over,
});

test("P10d-one-question: a pipeline's decision is asked once, as its checkpoint; links, kinds and states decide which research rows stand", { timeout: 300_000 }, async (t) => {
	const s = await bench(t, "p10d-one");
	const fleet = new FleetStore({ home: s.home });
	for (const id of ["cp-ra", "cp-rb", "cp-rc", "cp-rd", "cp-re", "cp-rf", "cp-rg", "cp-rh", "cp-ri"]) await fleet.add(heldResearch(id, "pipeline"));
	await fleet.add(heldResearch("cp-solo", "pr"));
	const pipelines = new PipelineStore(s.home);
	for (const pair of ["a", "b", "c", "e", "f"]) pipelines.write(pipeline(`cp-r${pair}`, `cp-s${pair}`));
	pipelines.write(pipeline("cp-rg", "cp-sg", { state: "escalated" }));
	pipelines.write(pipeline("cp-rh", "cp-sh", { state: "gating" }));
	pipelines.write(pipeline("cp-ri", "cp-si", { state: "gating" }));
	const ship = new CheckpointStore(s.home);
	const diff = new CheckpointStore(s.home, { kind: "diff" });
	const merge = new CheckpointStore(s.home, { kind: "merge" });
	ship.request({ jobId: "cp-sa", researchId: "cp-ra", question: "Authorize implementation of cp-sa?" });
	ship.request({ jobId: "cp-sb", question: "Authorize implementation of cp-sb?" });
	ship.request({ jobId: "cp-other", question: "Authorize implementation of cp-other?" });
	ship.request({ jobId: "cp-other2", researchId: "cp-different", question: "Authorize implementation of cp-other2?" });
	ship.decide("cp-other2", true, { by: "operator command" });
	for (const job of ["cp-se", "cp-sf"]) {
		diff.request({ jobId: job, researchId: job.replace("cp-s", "cp-r"), question: "accept the diff?" });
		merge.request({ jobId: job, researchId: job.replace("cp-s", "cp-r"), scope: "abcdef123456", question: "merge it?" });
	}
	ship.request({ jobId: "cp-sf", researchId: "cp-rf", question: "Authorize implementation of cp-sf?" });

	const list = async (prompt = "What awaits me?") => {
		const { ends, widgets } = await s.parent(prompt, [call("list", "cp_awaiting", { action: "list" })]);
		ok(ends, "list");
		const ids = (ends.get("list")?.result as { details: { items: { id: string }[] } }).details.items.map((item) => item.id).sort();
		const counts = widgets.map((widget) => /(\d+) decisions? awaiting you/.exec(JSON.stringify(widget.widgetLines))?.[1]).filter(Boolean);
		return { ids, count: Number(counts.at(-1)) };
	};
	const merged = (job: string) => `aw-checkpoint-${job}.merge-abcdef123456`;
	const first = [
		"aw-checkpoint-cp-other", "aw-checkpoint-cp-sa", "aw-checkpoint-cp-sb", "aw-checkpoint-cp-se.diff", merged("cp-se"),
		"aw-checkpoint-cp-sf", "aw-checkpoint-cp-sf.diff", merged("cp-sf"),
		"aw-research-cp-rc", "aw-research-cp-rd", "aw-research-cp-re", "aw-research-cp-rh", "aw-research-cp-ri", "aw-research-cp-solo",
	].sort();
	let seen = await list();
	assert.deepEqual(seen.ids, first);
	assert.equal(seen.count, first.length, "the widget's files-only render counts what cp_awaiting lists");
	// Reading is not answering: a fresh parent (a restart) lists the same rows, and nothing was written.
	seen = await list("Again?");
	assert.deepEqual(seen.ids, first);
	assert.ok(!existsSync(join(s.home, LAYOUT.awaitingFile)), "listing never materialises a row");
	assert.equal(ship.get("cp-sa")?.decision, "pending");

	// The next round offers a checkpoint minted since (it replaces the research row it authorizes) and drops a reanchored
	// pipeline's old row, written the way PipelineRunner.reanchor writes it.
	ship.request({ jobId: "cp-sc", researchId: "cp-rc", question: "Authorize implementation of cp-sc?" });
	pipelines.write(pipeline("cp-ri", "cp-si", { state: "gating", superseded_by: "cp-replacement", updated_at: "2026-09-04T19:00:00Z" }));
	const quote = "Decline aw-checkpoint-cp-sa.";
	const { ends } = await s.parent(quote, [decide("decline", "aw-checkpoint-cp-sa", "decline", quote)], [call("list", "cp_awaiting", { action: "list" })]);
	ok(ends, "decline");
	assert.deepEqual([ship.get("cp-sa")?.decision, ship.get("cp-sa")?.decided_by], ["declined", "operator-quote"]);
	assert.ok(!existsSync(join(s.home, LAYOUT.awaitingFile)), "an authorization never lands in state/awaiting.json");
	const after = (ends.get("list")?.result as { details: { items: { id: string }[] } }).details.items.map((item) => item.id);
	assert.ok(after.includes("aw-checkpoint-cp-sc") && !after.includes("aw-research-cp-rc"), after.join(", "));
	assert.ok(!after.includes("aw-checkpoint-cp-sa") && !after.includes("aw-research-cp-ra"), "a declined plan is not asked again as its research row");
	assert.ok(after.includes("aw-research-cp-solo"), "a standalone research row stands");
	assert.ok(!after.includes("aw-research-cp-ri"), "a reanchored pipeline's old research row is gone on the next snapshot");

	// An unreadable state/pipelines costs a dedup hint, never the listing: the checkpoint's own research_id still links.
	rmSync(join(s.home, LAYOUT.pipelines), { recursive: true, force: true });
	writeFileSync(join(s.home, LAYOUT.pipelines), "not a directory");
	seen = await list("And now?");
	assert.ok(seen.ids.includes("aw-checkpoint-cp-sc") && !seen.ids.includes("aw-research-cp-rc"), seen.ids.join(", "));
	assert.equal(seen.count, seen.ids.length);
});
