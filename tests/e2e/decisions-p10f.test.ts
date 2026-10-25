/**
 * Behavior 09, P10f: Awaiting-you rows and the cp-answered wake-up, through a real pi parent with the command-post
 * extension and a mock model. Fleet, checkpoints, rows, grants and the answered outbox are seeded on disk; rows are
 * declared by cp_status_block, listed and withdrawn by cp_awaiting and answered by cp_decide.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { AnsweredOutbox } from "../../src/answered.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { type AnsweredDecision, type AwaitingItem, DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, LAYOUT, type PipelineRecord, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { FleetStore } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";
import { PipelineStore } from "../../src/pipeline.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, type PiChild, startPiChild, waitFor } from "../harness/index.ts";

type Call = { id: string; name: string; args: unknown };
type Step = { prompt: string; turns?: Call[][] };
const call = (id: string, name: string, args: unknown): Call => ({ id, name, args });
const quote = (id: string, target: string, decision: string, text: string, over: Record<string, unknown> = {}) =>
	call(id, "cp_decide", { target, decision, basis: { operator_quote: text }, ...over });
const byGrant = (id: string, target: string, decision: string, mandate: string, over: Record<string, unknown> = {}) =>
	call(id, "cp_decide", { target, decision, basis: { mandate, clause: "caller claim ignored" }, ...over });
const status = (id: string, awaiting: Record<string, string>[]) => call(id, "cp_status_block", { width: 200, awaiting });
const row = (type: string, decision: string, job_id: string, why = "w", blocks = "b") => ({ type, decision, why, blocks, job_id });
const notesOf = (child: PiChild) =>
	child.records().filter((record) => record.type === "extension_ui_request" && record.method === "notify").map((record) => String(record.message));
const answeredNotes = (notes: string[]) => notes.filter((note) => note.startsWith("DECISION"));

/** A scratch home; `session` runs one real pi parent over its prompts, `idle` boots one that is never prompted. */
async function bench(t: TestContext, name: string) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	let runs = 0;
	t.after(async () => {
		await provider.stop();
		agentDir.cleanup();
		home.cleanup();
	});
	const start = (script: Parameters<MockProvider["addScript"]>[1]) => {
		const model = provider.addScript(`${name}-${(runs += 1)}`, script, { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		return { model: `${name}-${runs}`, child: startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] }) };
	};
	const session = async (steps: Step[], until?: () => boolean) => {
		const { child } = start(steps.flatMap((step) => [...(step.turns ?? []).map((calls) => ({ kind: "tool_calls" as const, calls })), { kind: "text" as const, text: "noted" }]));
		try {
			for (const [index, step] of steps.entries()) {
				await child.prompt(step.prompt);
				await waitFor(() => child.eventsOfType("agent_settled").length, (settled) => settled > index, { timeoutMs: 90_000, what: `${name} prompt ${index + 1}` });
			}
			if (until) await waitFor(until, (done) => done, { timeoutMs: 30_000, what: `${name}: the wake-ups to be confirmed` });
			const ends = new Map(child.eventsOfType("tool_execution_end").map((end) => [String(end.toolCallId), end]));
			return { ends, notes: notesOf(child) };
		} finally {
			await child.close();
		}
	};
	/** Boots a parent and waits for `until` over its notices, or (with no predicate) for one widget tick. */
	const idle = async (until?: (notes: string[]) => boolean) => {
		const { child, model } = start([{ kind: "text", text: "noted" }]);
		try {
			if (until) await waitFor(() => notesOf(child), until, { timeoutMs: 60_000, what: `${name}: the inherited wake-up` });
			else await new Promise((resolve) => setTimeout(resolve, 7_000));
			return { notes: notesOf(child), turns: provider.requests(model).length };
		} finally {
			await child.close();
		}
	};
	return { home: home.path, session, idle };
}

type Ends = Awaited<ReturnType<Awaited<ReturnType<typeof bench>>["session"]>>["ends"];
const said = (ends: Ends, id: string) => JSON.stringify(ends.get(id)?.result);
const ok = (ends: Ends, id: string, pattern?: RegExp) => {
	assert.ok(ends.has(id), `${id} never ran`);
	assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(ends, id)}`);
	if (pattern) assert.match(said(ends, id), pattern, id);
};
const failed = (ends: Ends, id: string, pattern: RegExp) => {
	assert.equal(ends.get(id)?.isError, true, `${id}: ${said(ends, id)}`);
	assert.match(said(ends, id), pattern, id);
};
const listed = (ends: Ends, id: string) =>
	(ends.get(id)?.result as { details: { items: (AwaitingItem & { checkpoint_kind?: string; options?: string[] })[] } }).details.items;

const GRANT = { expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 };
const pipeline = (ship_id: string): PipelineRecord => ({
	schema_version: SCHEMA_VERSION, research_id: `${ship_id}-r`, ship_id, project: "demo", delivery: "pr", state: "awaiting_authorization",
	created_at: "2026-09-04T17:00:00Z", updated_at: "2026-09-04T18:07:00Z",
});
const job = (jobId: string, over: Partial<FleetRecord> = {}): FleetRecord => ({
	job_id: jobId, project: "demo", kind: "research", delivery: "pipeline", origin: DEFAULT_ORIGIN, phase: "held", worktree: `/tmp/${jobId}`, branch: jobId,
	dispatched_at: "2026-09-04T17:00:00Z", reported_at: "2026-09-04T18:00:00Z", usage: { ...EMPTY_USAGE },
	worker: { pid: process.pid, session_id: `sess-${jobId}`, session_file: `/sessions/${jobId}.jsonl`, profile: "planner", role: "planner", model: "mock/planner", started_at: "2026-09-04T17:00:00Z" },
	...over,
}) as FleetRecord;
const stored = (over: Partial<AwaitingItem> & { id: string }): AwaitingItem =>
	({ schema_version: SCHEMA_VERSION, type: "approval", decision: "Merge PR #48 (pregenerated answers)", why: "green", blocks: "cp-qd4", state: "open", opened_at: "2026-08-31T13:59:59Z", ...over }) as AwaitingItem;
const answeredRow = (id: string, over: Partial<AwaitingItem> = {}) =>
	stored({ id, state: "answered", answer: "yes", answered_by: "operator dialog (tui)", answered_at: "2026-08-31T14:02:04Z", ...over });
const seedAwaiting = (home: string, items: AwaitingItem[]) => {
	const file = join(home, LAYOUT.awaitingFile);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-08-31T14:00:00Z", items }, null, 2)}\n`);
};

test("P10f-rows: Awaiting-you rows are derived, declared, listed, withdrawn and answered once, through cp_status_block, cp_awaiting and cp_decide", { timeout: 600_000 }, async (t) => {
	const s = await bench(t, "p10f-rows");
	const fleet = new FleetStore({ home: s.home });
	const LONG = `cp-${"x".repeat(100)}`;
	await fleet.add(job("cp-0hj"));
	await fleet.add(job(LONG));
	await fleet.add(job("cp-pr", { receipts: [{ kind: "pr", status: "open", title: "p", url: "https://example.com/pr/1" }] }));
	await fleet.add(job("cp-wait", { phase: "waiting" }));
	await fleet.add(job("cp-shipjob", { kind: "ship", delivery: "pr" }));
	await fleet.add(job("cp-question", { delivery: "answer" }));
	await fleet.add(job("cp-board", { delivery: "board" }));
	await fleet.add(job("cp-esc"));
	const pipelines = new PipelineStore(s.home);
	pipelines.write({ ...pipeline("cp-esc-ship"), research_id: "cp-esc", state: "escalated" });
	pipelines.write(pipeline("cp-x"));
	// Gating research is still offered unless a newer plan superseded it.
	await fleet.add(job("cp-sup"));
	await fleet.add(job("cp-gate"));
	pipelines.write({ ...pipeline("cp-sup-ship"), research_id: "cp-sup", state: "gating", superseded_by: "cp-sup2" });
	pipelines.write({ ...pipeline("cp-gate-ship"), research_id: "cp-gate", state: "gating" });
	const ship = new CheckpointStore(s.home);
	const diff = new CheckpointStore(s.home, { kind: "diff" });
	ship.request({ jobId: "cp-ship", question: "act on the plan?", at: "2026-08-30T09:00:00Z" });
	diff.request({ jobId: "cp-ship", question: "accept the diff?", at: "2026-08-30T15:00:00Z" });
	ship.request({ jobId: "diff-x", question: "plan for diff-x?" });
	diff.request({ jobId: "x", question: "diff for x?" });
	ship.request({ jobId: "cp-a", question: "plan?" });
	diff.request({ jobId: "cp-b", question: "diff?" });
	// Two duplicated ids the way a re-render once wrote them, the open/later copy first; a pre-subject row; 55 answers.
	const duplicates = [
		stored({ id: "aw-7eed20da42", job_id: "cp-qd4", opened_at: "2026-08-31T14:02:21Z" }),
		answeredRow("aw-7eed20da42", { job_id: "cp-qd4" }),
		answeredRow("aw-123b695c29", { type: "design", decision: "restart now or later?", why: "second why", blocks: "the fleet", answer: "later", answered_at: "2026-08-31T12:39:40Z" }),
		answeredRow("aw-123b695c29", { type: "design", decision: "restart now or later?", why: "first why", blocks: "the fleet", answer: "later", answered_at: "2026-08-31T12:37:30Z" }),
	];
	const old = stored({ id: "aw-0001d0001d", job_id: "cp-44", decision: "Merge PR #44 once its rebase lands green", opened_at: "2026-08-30T08:00:00Z" });
	const pruned = Array.from({ length: 55 }, (_, i) => answeredRow(`aw-${(0x1000000000 + i).toString(16)}`, { type: "design", decision: `q${i}`, job_id: `cp-q${i}` }));
	seedAwaiting(s.home, [...duplicates, old, ...pruned]);
	const file = join(s.home, LAYOUT.awaitingFile);
	const seeded = readFileSync(file, "utf8");

	// Listing derives and repairs on read, and writes nothing; withdraw refuses derived and answered rows.
	let { ends } = await s.session([{ prompt: "What awaits me?", turns: [
		[call("list", "cp_awaiting", { action: "list" })],
		[call("w-auth", "cp_awaiting", { action: "withdraw", id: "aw-checkpoint-cp-ship" }), call("w-research", "cp_awaiting", { action: "withdraw", id: "aw-research-cp-0hj" }), call("w-answered", "cp_awaiting", { action: "withdraw", id: "aw-7eed20da42" })],
	] }]);
	ok(ends, "list");
	const items = listed(ends, "list");
	const ids = items.map((item) => item.id);
	const offeredResearch = ["aw-research-cp-0hj", "aw-research-cp-gate", `aw-research-${LONG}`];
	assert.deepEqual(ids.filter((id) => id.startsWith("aw-research-")).sort(), offeredResearch, "held research with no PR and no live pipeline only");
	const shipRows = items.filter((item) => item.job_id === "cp-ship");
	assert.deepEqual(shipRows.map((item) => [item.id, item.checkpoint_kind, item.type]), [["aw-checkpoint-cp-ship", "ship", "authorization"], ["aw-checkpoint-cp-ship.diff", "diff", "authorization"]]);
	assert.equal(new Set(shipRows.map((item) => item.decision)).size, 2);
	assert.equal(new Set(shipRows.map((item) => item.blocks)).size, 2);
	assert.equal(shipRows[1]?.why, "accept the diff?");
	for (const item of shipRows) assert.deepEqual(item.options, ["approve", "decline"]);
	assert.ok(ids.includes("aw-checkpoint-diff-x") && ids.includes("aw-checkpoint-x.diff") && ids.includes("aw-checkpoint-cp-a") && ids.includes("aw-checkpoint-cp-b.diff"));
	assert.ok(!ids.includes("aw-checkpoint-cp-a.diff") && !ids.includes("aw-checkpoint-cp-b"), "neither kind raises the other's question");
	assert.deepEqual([...new Set(items.map((item) => item.type))].slice(0, 1), ["authorization"], "authorizations lead");
	assert.ok(ids.indexOf(old.id) < ids.indexOf("aw-research-cp-0hj"), "then oldest first");
	assert.ok(!ids.includes("aw-7eed20da42"), "the answered copy of a duplicated id wins; its open copy cannot keep asking");
	failed(ends, "w-auth", /derived authorization item, not declared .* only through cp_decide/);
	failed(ends, "w-research", /derived approval item from a held research job, not declared .* via cp_decide/);
	failed(ends, "w-answered", /answered/);
	assert.equal(new AwaitingStore({ home: s.home }).get("aw-7eed20da42")?.answer, "yes", "a withdraw never overwrites an answer");
	assert.equal(readFileSync(file, "utf8"), seeded, "listing and refused withdrawals write nothing");

	// Declaring is an upsert by subject: rewording, a new why or blocks, and a job mention update one row in place.
	({ ends } = await s.session([{ prompt: "Render the status block.", turns: [
		[status("st-1", [row("design", "A or B?", "cp-x", "first why"), row("approval", "Ship cp-esc, drop it, or open a follow-up?", "cp-esc"), row("design", "Keep the old queue?", "cp-w")])],
		[status("st-2", [
			row("design", "A or B?", "cp-x", "updated why", "cp-x and the two PRs behind it"),
			row("approval", "Ship PR #44 for cp-44 results", "cp-44"),
			row("approval", "Ship PR #44 for cp-44 to staging", "cp-44"),
			row("approval", "Merge PR #44 when CI goes green on cd178f4", "cp-44"),
			row("approval", "Merge PR #47 (diff-review orchestrator) - ANSWER IN CHAT", "cp-diffgate-orchestrator-03v"),
			row("approval", "Merge PR #58 for cp-gmy?", "cp-gmy"),
			row("design", "A or C?", "cp-x"),
		])],
		[status("st-3", [row("approval", "Merge PR #47 (diff-review orchestrator)", "cp-diffgate-orchestrator-03v"), row("approval", "Merge PR #58 once CI goes green", "cp-gmy")])],
		[call("list2", "cp_awaiting", { action: "list" })],
	] }]));
	for (const id of ["st-1", "st-2", "st-3", "list2"]) ok(ends, id);
	const store = new AwaitingStore({ home: s.home });
	const all = store.list();
	const of = (jobId: string) => all.filter((item) => item.job_id === jobId);
	const [ab, ac] = [of("cp-x").find((item) => item.decision === "A or B?"), of("cp-x").find((item) => item.decision === "A or C?")];
	assert.deepEqual([of("cp-x").length, ab?.why, ab?.blocks], [2, "updated why", "cp-x and the two PRs behind it"]);
	assert.notEqual(ab?.id, ac?.id, "another decision is another row");
	assert.equal(of("cp-44").length, 3, "the reworded pre-subject merge row is one row; two questions about PR #44 are two");
	const merge44 = of("cp-44").find((item) => item.id === old.id);
	assert.deepEqual([merge44?.decision, merge44?.opened_at], ["Merge PR #44 when CI goes green on cd178f4", old.opened_at], "the latest wording, the same question");
	assert.deepEqual(of("cp-44").filter((item) => item.id !== old.id).map((item) => item.decision).sort(), ["Ship PR #44 for cp-44 results", "Ship PR #44 for cp-44 to staging"]);
	assert.deepEqual([of("cp-diffgate-orchestrator-03v").length, of("cp-diffgate-orchestrator-03v")[0]?.decision], [1, "Merge PR #47 (diff-review orchestrator)"]);
	assert.equal(of("cp-gmy").length, 1, "a job mention and a qualifier clause are prose, not the decision");
	assert.equal(all.filter((item) => item.id === "aw-123b695c29")[0]?.why, "first why", "a tie keeps the earlier answer");
	assert.equal(new Set(all.map((item) => item.id)).size, all.length, "the repaired file holds one record per id");
	const onDisk = (JSON.parse(readFileSync(file, "utf8")) as { items: AwaitingItem[] }).items;
	assert.equal(new Set(onDisk.map((item) => item.id)).size, onDisk.length);
	assert.ok(!existsSync(`${file}.tmp`), "the atomic write leaves no temp file");
	const offered = listed(ends, "list2").map((item) => item.id);
	assert.ok(!offered.some((id) => of("cp-esc").some((item) => item.id === id)), "a declared row for escalated research is not offered");
	assert.equal(of("cp-esc")[0]?.state, "open", "and it is not withdrawn either");

	// Answers: each checkpoint kind by its own row, a derived row materialised under the id shown, every answer once.
	const w = of("cp-w")[0]!.id;
	const words = ["Approve the diff.", "Decline the plan.", "Approve diff-x.", "sure, sounds good", "ship", "drop", "B", "A"];
	({ ends } = await s.session([{ prompt: words.join("\n"), turns: [
		[quote("d-diff", "aw-checkpoint-cp-ship.diff", "approve", "Approve the diff.")],
		[quote("d-ship", "aw-checkpoint-cp-ship", "decline", "Decline the plan."), quote("d-diffx", "aw-checkpoint-diff-x", "approve", "Approve diff-x."), quote("d-free", "aw-checkpoint-cp-a", "sure, sounds good", "sure, sounds good")],
		[quote("d-research", "aw-research-cp-0hj", "ship", "ship"), quote("d-long", `aw-research-${LONG}`, "ship", "ship"), quote("d-ab", ab!.id, "B", "B")],
		[
			quote("d-research-again", "aw-research-cp-0hj", "ship", "ship"),
			quote("d-research-other", "aw-research-cp-0hj", "drop", "drop"),
			quote("d-ab-other", ab!.id, "A", "A"),
			quote("d-diff-again", "aw-checkpoint-cp-ship.diff", "decline", "Decline the plan."),
			quote("d-gone", "aw-checkpoint-cp-gone", "approve", "Approve the diff."),
			quote("d-unknown", "aw-research-cp-other", "ship", "ship"),
			call("w-declared", "cp_awaiting", { action: "withdraw", id: w }),
		],
		[call("list3", "cp_awaiting", { action: "list" })],
	] }]));
	for (const id of ["d-diff", "d-ship", "d-diffx", "d-research", "d-long", "d-ab", "w-declared"]) ok(ends, id);
	// An answered row is no longer offered, so any repeat (same or other answer) falls through and is refused.
	for (const id of ["d-research-again", "d-research-other", "d-ab-other", "d-unknown"]) failed(ends, id, /decision must be approve or decline/);
	assert.deepEqual([diff.get("cp-ship")?.decision, ship.get("cp-ship")?.decision], ["approved", "declined"], "two kinds, two records");
	assert.deepEqual([ship.get("diff-x")?.decision, diff.get("x")?.decision], ["approved", "pending"], "diff-x is not x's diff");
	assert.notEqual(ship.file("cp-ship"), diff.file("cp-ship"));
	failed(ends, "d-free", /decision must be approve or decline/);
	assert.equal(ship.get("cp-a")?.decision, "pending", "free text is never a verdict");
	failed(ends, "d-diff-again", /already approved/);
	assert.equal(diff.get("cp-ship")?.decision, "approved");
	failed(ends, "d-gone", /no checkpoint for cp-gone/);
	const after = new AwaitingStore({ home: s.home });
	const research = after.get("aw-research-cp-0hj");
	assert.deepEqual([research?.state, research?.answer, research?.type, research?.job_id], ["answered", "ship", "approval", "cp-0hj"], "materialised under the id offered");
	const long = after.get(`aw-research-${LONG}`);
	assert.ok(long && long.decision.length <= 100, "a long id is stored verbatim; prose is clipped");
	assert.equal(after.list().filter((item) => item.id === ab!.id).length, 1);
	assert.deepEqual([after.get(ab!.id)?.state, after.get(ab!.id)?.answer], ["answered", "B"]);
	assert.equal(after.get(w)?.state, "withdrawn");
	assert.ok(!after.list().some((item) => item.id.startsWith("aw-checkpoint-")), "an authorization never lands in state/awaiting.json");
	assert.equal(after.list().filter((item) => item.state === "answered").length, 50, "an answer prunes answers to the newest 50");
	assert.deepEqual([after.get(old.id)?.state, after.get(of("cp-esc")[0]!.id)?.state], ["open", "open"], "never a pending row");
	const left = listed(ends, "list3").map((item) => item.id);
	for (const gone of ["aw-checkpoint-cp-ship", "aw-checkpoint-cp-ship.diff", "aw-checkpoint-diff-x", "aw-research-cp-0hj", ab!.id, w]) assert.ok(!left.includes(gone), `${gone} is still offered`);
	for (const open of ["aw-checkpoint-x.diff", "aw-checkpoint-cp-a", "aw-checkpoint-cp-b.diff"]) assert.ok(left.includes(open), `${open} was lost`);

	// A restart reads the same answers; re-rendering an answered decision never reopens it.
	({ ends } = await s.session([{ prompt: "Anything left?", turns: [[status("st-4", [row("design", "A or B?", "cp-x", "asked again")])], [call("list4", "cp_awaiting", { action: "list" })]] }]));
	ok(ends, "st-4");
	assert.deepEqual(listed(ends, "list4").map((item) => item.id).sort(), [...left].sort());
	assert.deepEqual([new AwaitingStore({ home: s.home }).get(ab!.id)?.state, new AwaitingStore({ home: s.home }).get(ab!.id)?.answer], ["answered", "B"]);
});

test("P10f-wake: a mandate's answer wakes the parent once under the row's own id; the parent's own quotes, free text and repeats wake nobody", { timeout: 600_000 }, async (t) => {
	const s = await bench(t, "p10f-wake");
	const pipelines = new PipelineStore(s.home);
	for (const jobId of ["cp-w1", "cp-w2", "cp-w3", "cp-w4", "cp-w5", "cp-q1", "cp-q2"]) pipelines.write(pipeline(jobId));
	await new FleetStore({ home: s.home }).add(job("cp-wr"));
	const ship = new CheckpointStore(s.home);
	const diff = new CheckpointStore(s.home, { kind: "diff" });
	for (const jobId of ["cp-w1", "cp-w2", "cp-w4", "cp-w5", "cp-q1", "cp-q2"]) ship.request({ jobId, question: `ship ${jobId}?` });
	diff.request({ jobId: "cp-w2", question: "accept the diff of cp-w2?" });
	const declared = await new AwaitingStore({ home: s.home }).declare({ type: "design", decision: "postgres or sqlite?", why: "schema", blocks: "cp-w3", job_id: "cp-w3" });
	const escalation = await new EscalationStore({ home: s.home }).raise({
		job_ids: ["cp-q3"], kind: "product_ambiguity", question: "which copy?", recommended: "approve",
		options: [{ id: "approve", label: "approve", consequence: "proceed", cost: "none" }],
	});
	const grant = new MandateStore(s.home).issue({ projects: ["demo"], objective: "decide the demo rows", ...GRANT });
	const outbox = () => new AnsweredOutbox({ home: s.home });
	const woken = ["aw-checkpoint-cp-w1", "aw-checkpoint-cp-w2.diff", declared.id, "aw-checkpoint-cp-w4", "aw-research-cp-wr"];

	const prompt = `Decide what you can. Approve cp-q1. ${escalation.id}: approve. sure`;
	let { ends, notes } = await s.session([{ prompt, turns: [
		[byGrant("g-w1", "aw-checkpoint-cp-w1", "approve", grant.id), byGrant("g-w2", "aw-checkpoint-cp-w2.diff", "approve", grant.id)],
		[byGrant("g-w3", declared.id, "sqlite", grant.id), byGrant("g-w4", "cp-w4", "decline", grant.id), byGrant("g-wr", "aw-research-cp-wr", "ship", grant.id)],
		[quote("q-1", "cp-q1", "approve", "Approve cp-q1."), quote("q-es", escalation.id, "approve", `${escalation.id}: approve.`), quote("q-free", "cp-q2", "sure", "sure")],
		[byGrant("g-w1-again", "aw-checkpoint-cp-w1", "decline", grant.id), byGrant("g-w3-again", declared.id, "sqlite", grant.id)],
	] }], () => woken.every((id) => outbox().delivered(id)));
	for (const id of ["g-w1", "g-w2", "g-w3", "g-w4", "g-wr", "q-1", "q-es"]) ok(ends, id);
	failed(ends, "q-free", /decision must be approve or decline/);
	failed(ends, "g-w1-again", /already approved/);
	failed(ends, "g-w3-again", /decision must be approve or decline/);
	assert.deepEqual([ship.get("cp-w2")?.decision, diff.get("cp-w2")?.decision], ["pending", "approved"], "the diff answer is the diff's alone");
	const wakes = answeredNotes(notes);
	const text = wakes.join("\n");
	for (const id of woken) assert.equal(text.split(`  ${id} [`).length - 1, 1, `${id} woke the parent once: ${text}`);
	assert.match(text, /DECISIONS? ANSWERED — decided under mandate md-/);
	assert.doesNotMatch(text, /a human answered/);
	assert.match(text, /aw-checkpoint-cp-w2\.diff \[authorization\] cp-w2: /);
	assert.match(text, new RegExp(`${declared.id} \\[design\\] cp-w3: postgres or sqlite\\? → "sqlite"`));
	assert.match(text, /aw-research-cp-wr \[approval\] cp-wr: .* → "ship"/);
	assert.match(text, /approved means dispatch it, declined means stop and say so/);
	for (const id of ["cp-q1", "cp-q2", escalation.id]) assert.doesNotMatch(text, new RegExp(`${id}[ .]`), `${id} must not wake anybody`);
	assert.deepEqual([ship.get("cp-q1")?.decided_by, new EscalationStore({ home: s.home }).get(escalation.id)?.status], ["operator-quote", "answered"], "a quote is still recorded");
	const file = outbox().read();
	assert.deepEqual(file.pending, []);
	assert.deepEqual(file.delivered.map((entry) => entry.id).sort(), [...woken].sort(), "the parent's own answers are never queued");

	// A restart replays nothing; an unwritable outbox costs the wake-up, never the answer.
	const restarted = await s.idle();
	assert.deepEqual(answeredNotes(restarted.notes), [], "a delivered answer is history, not news");
	rmSync(join(s.home, LAYOUT.answeredFile), { force: true });
	mkdirSync(join(s.home, LAYOUT.answeredFile), { recursive: true });
	({ ends, notes } = await s.session([{ prompt: "Decide cp-w5.", turns: [[byGrant("g-w5", "aw-checkpoint-cp-w5", "approve", grant.id)]] }]));
	ok(ends, "g-w5");
	assert.equal(ship.get("cp-w5")?.decision, "approved");
	assert.ok(notes.some((note) => /answered wake-up failed; answer remains queued/.test(note)), notes.join("\n"));
});

test("P10f-outbox: answers left on disk reach the next parent once, bundled, in a notice that says who answered", { timeout: 600_000 }, async (t) => {
	const s = await bench(t, "p10f-outbox");
	const file = join(s.home, LAYOUT.answeredFile);
	const answer = (id: string, type: AnsweredDecision["type"], by: string, over: Partial<AnsweredDecision> = {}): AnsweredDecision => ({
		schema_version: SCHEMA_VERSION, id, type, decision: `${id}?`, answer: "yes", answered_by: by, answered_at: "2026-09-06T15:37:49Z", ...over,
	});
	const seed = (doc: Record<string, unknown>) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-09-06T15:37:50Z", delivered: [], ...doc }));
	};
	const outbox = () => new AnsweredOutbox({ home: s.home });
	const bootFor = async (ids: string[]) => {
		const run = await s.idle((notes) => answeredNotes(notes).length > 0 && ids.every((id) => outbox().delivered(id)));
		const wakes = answeredNotes(run.notes);
		assert.equal(wakes.length, 1, `one bundled wake-up: ${wakes.join("\n---\n")}`);
		for (const id of ids) assert.equal(wakes[0]!.split(`  ${id} [`).length - 1, 1, `${id} once`);
		assert.deepEqual(outbox().pending(), [], "nothing is owed once arrival was observed");
		assert.equal(run.turns, 0, "with no grant the wake-up starts no parent turn");
		return wakes[0]!;
	};

	// A pre-sends outbox (no `sends` at all) reads as never emitted; one human answer reads as one.
	const one = answer("aw-abc0000001", "design", "operator command", { decision: "one queue or two?", answer: "one" });
	seed({ pending: [one] });
	let notice = await bootFor([one.id]);
	assert.match(notice, /^DECISION ANSWERED — a human answered 1 open decision\n/);
	assert.doesNotMatch(notice, /authorization is a human's permission/);

	// A reservation another process made inside the 120 s retry window is replayed at once, owned or pre-upgrade.
	const sentNow = `${new Date().toISOString().slice(0, 19)}Z`;
	const owned = answer("aw-abc0000002", "design", "operator command");
	const unowned = answer("aw-abc0000003", "design", "operator command");
	seed({ pending: [owned, unowned], sends: [{ id: owned.id, sent_at: sentNow, attempts: 1, owner: "4242.deadbeef" }, { id: unowned.id, sent_at: sentNow, attempts: 1 }] });
	await bootFor([owned.id, unowned.id]);

	// Two humans' answers persisted before any send arrive together; an acknowledged id with a dead reservation does not.
	const LONG = `aw-research-cp-${"y".repeat(60)}`;
	const auth = answer("aw-checkpoint-cp-ship", "authorization", "operator command", { job_id: "cp-ship", decision: "ship the plan?", answer: "approved" });
	const research = answer(LONG, "approval", "operator dialog (tui)", { job_id: LONG.slice("aw-research-".length), decision: "ship, drop or follow-up?", answer: "follow-up" });
	seed({ pending: [auth, research], sends: [{ id: one.id, sent_at: "2026-09-06T15:37:50Z", attempts: 1, owner: "4242.deadbeef" }], delivered: [{ id: one.id, delivered_at: "2026-09-06T15:37:51Z" }] });
	notice = await bootFor([auth.id, research.id]);
	assert.match(notice, /^DECISIONS ANSWERED — a human answered 2 open decisions\n/);
	assert.match(notice, /aw-checkpoint-cp-ship \[authorization\] cp-ship: ship the plan\? → "approved" \(operator command at 2026-09-06T15:37:49Z\)/);
	assert.match(notice, new RegExp(`${LONG} \\[approval\\] cp-y+: ship, drop or follow-up\\? → "follow-up"`), "a long derived id travels whole");
	assert.match(notice, /An authorization is a human's permission to act: cp-ship — approved means dispatch it/);
	assert.doesNotMatch(notice, new RegExp(one.id), "an acknowledged answer is never replayed");

	// A mandate's auto-decision never reads as a human's, alone or beside one.
	const mandate = answer("aw-checkpoint-cp-x", "authorization", "mandate:md-94115f", { job_id: "cp-x", answer: "approved" });
	const human = answer("aw-7d92aa1cce", "design", "operator command", { decision: "one queue or two?", answer: "one" });
	seed({ pending: [mandate, human] });
	notice = await bootFor([mandate.id, human.id]);
	assert.match(notice, /^DECISIONS ANSWERED — 2 open decisions answered\n/);
	assert.doesNotMatch(notice, /a human answered/);
	const alone = answer("aw-checkpoint-cp-y", "authorization", "mandate:md-94115f", { job_id: "cp-y", answer: "approved" });
	seed({ pending: [alone] });
	notice = await bootFor([alone.id]);
	assert.match(notice, /^DECISION ANSWERED — decided under mandate md-94115f\n/);

	// Delivered is history: the next parent, its widget ticks included, emits nothing.
	const restarted = await s.idle();
	assert.deepEqual(answeredNotes(restarted.notes), []);
	assert.deepEqual(outbox().pending(), []);
});

test("P10f-mission: cp_next closing a clean mission end wakes nobody; a messy one waits for the operator, whose quote wakes nobody either", { timeout: 300_000 }, async (t) => {
	const s = await bench(t, "p10f-mission");
	const { ledger } = createScratchLedger({ home: s.home, knownProjects: ["demo"] });
	const mandates = new MandateStore(s.home);
	const clean = await ledger.create({ title: "clean", project: "demo", delivery: "pr", kind: "ship" });
	const messy = await ledger.create({ title: "messy", project: "demo", delivery: "pr", kind: "ship" });
	const cleanGrant = mandates.issue({ projects: ["demo"], objective: clean.id, ...GRANT, job_ids: [clean.id] });
	const messyGrant = mandates.issue({ projects: ["demo"], objective: messy.id, ...GRANT, job_ids: [messy.id] });
	await ledger.close(clean.id, "https://example.com/pr/9");
	await ledger.drop(messy.id, "not needed");

	let { ends, notes } = await s.session([{ prompt: "What next?", turns: [[call("next", "cp_next", { project: "demo" }), call("note", "cp_job", { action: "comment", job_id: messy.id, text: "decision: drop? — answered by operator" })]] }]);
	ok(ends, "next", /landed clean/);
	ok(ends, "note");
	assert.equal((await ledger.show(messy.id)).comments.length, 1, "an audit note is one ledger comment");
	const store = () => new EscalationStore({ home: s.home });
	const ends_ = store().list({ kind: "mission_end" });
	const closed = ends_.find((item) => item.mandate_id === cleanGrant.id);
	const open = ends_.find((item) => item.mandate_id === messyGrant.id);
	assert.deepEqual([closed?.status, closed?.answer, closed?.answered_by], ["answered", "close", `mandate:${cleanGrant.id}`], "the auto close is journaled");
	assert.equal(new MandateStore(s.home).get(cleanGrant.id)?.status, "revoked");
	assert.equal(open?.status, "open", "a messy end is left for a human");
	assert.deepEqual(answeredNotes(notes), [], "cp_next's own close is not echoed back");
	assert.equal(existsSync(join(s.home, LAYOUT.answeredFile)), false, "and nothing is queued for it");

	({ ends, notes } = await s.session([{ prompt: `${open!.id}: close`, turns: [[quote("close", open!.id, "close", `${open!.id}: close`)]] }]));
	ok(ends, "close");
	assert.equal(store().get(open!.id)?.status, "answered");
	assert.deepEqual(answeredNotes(notes), [], "the operator's quote is answered inside the parent's own turn");
	assert.equal(existsSync(join(s.home, LAYOUT.answeredFile)), false);
});
