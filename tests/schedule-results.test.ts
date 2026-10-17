import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type FleetRecord, LAYOUT, paths } from "../src/contracts.ts";
import type { IntakeResult } from "../src/intake.ts";
import { OperatorAnswers } from "../src/operator-answers.ts";
import { type ResultFacts, type ResultLedgerJob, reportedFacts, resultOwner, ScheduleResults } from "../src/schedule-results.ts";
import { ScheduleRunStore } from "../src/schedule-runs.ts";
import { readAnswers } from "../src/viewer/control-files.ts";
import { policyFromLegacy, type SchedulePolicy } from "../src/viewer/schedule-policy.ts";
import type { ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import { createScratchHome } from "./harness/index.ts";

const at = "2026-07-01T06:00:00Z";
const now = () => new Date("2026-07-01T07:00:00Z");
function policy(job: Partial<{ kind: string; delivery: string; skill: string; description: string }> = {}): SchedulePolicy {
	return policyFromLegacy({ id: "sch-123456", name: "Nightly report", project: "demo", mandate_id: "md-123456", enabled: true, created_at: at, trigger: { type: "manual" }, job: { title: "Nightly report", kind: "research", delivery: "answer", ...job } as never }, {
		seed_mandate_id: "md-123456", channel: "operator_chat", objective: "Nightly report", expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 6,
		allowed_actions: ["plan", "review"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run the nightly report", decided_by: "operator-quote", approved_at: at },
	});
}
const member = (job_id: string) => ({ job_id, role: null, admitted_at: at });
async function bench(t: { after: (fn: () => void) => void }, job: Parameters<typeof policy>[0] = {}, runId = "run-20260701060000-abcdef") {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const runs = new ScheduleRunStore({ home: home.path, active: true });
	const run: ScheduleRun = { schema_version: 1, id: runId, schedule_id: "sch-123456", policy_revision: 1, policy: policy(job), trigger: { via: "slot", at }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: at, deadline_at: "2026-07-01T08:00:00Z", risk_preapproved: [], authority_log: [], cap_notices: [] };
	await runs.createRun(run);
	await runs.attachAnchor(run.id, member("cp-anchor"));
	const stateDir = join(home.path, LAYOUT.state);
	const jobs: ResultLedgerJob[] = [{ id: "cp-anchor", status: "in_progress" }];
	const facts = new Map<string, ResultFacts>();
	const make = (answers: Pick<OperatorAnswers, "postScheduleResult"> = new OperatorAnswers(stateDir, { now }), clock = now) =>
		new ScheduleResults({ runs, answers, ledgerJobs: () => jobs, facts: (id) => facts.get(id), now: clock, log: () => {} });
	return { home, runs, run, stateDir, jobs, facts, make, cards: () => readAnswers(stateDir).answers.filter((item) => item.source) };
}
const accepted = (job_id: string, extra: Partial<IntakeResult> = {}) =>
	({ job_id, accepted: true, already: false, delivery: "answer", status: "done", summary: "Nightly report: 3 findings", generation: 1, ...extra }) as IntakeResult;
const broken = { postScheduleResult: () => { throw new Error("answers journal unwritable: EACCES"); } };

test("an accepted owner envelope posts exactly one card; a reader, a replay and a later tick add none", async (t) => {
	const b = await bench(t);
	await b.runs.admitMember(b.run.id, member("cp-reader"));
	const results = b.make();
	results.accepted(accepted("cp-reader"));
	assert.equal(b.cards().length, 0, "a reader's envelope is not the run's result");
	results.accepted(accepted("cp-anchor", { board_url: "http://127.0.0.1:1/board" }));
	results.accepted(accepted("cp-anchor", { already: true }));
	results.sync();
	const cards = b.cards();
	assert.equal(cards.length, 1);
	assert.deepEqual(cards[0]!.source, { kind: "schedule", schedule_id: "sch-123456", run_id: b.run.id, source_key: `${b.run.id}:cp-anchor:1`, outcome: "completed" });
	assert.match(cards[0]!.answer, /3 findings[\s\S]*http:\/\/127\.0\.0\.1:1\/board/);
	const result = b.runs.run(b.run.id)!.result!;
	assert.equal(result.answer_id, cards[0]!.id);
	assert.equal(result.delivered_at, "2026-07-01T07:00:00Z");
});

test("an unwritable journal keeps the card queued with its named error; a restart posts it once", async (t) => {
	const b = await bench(t);
	b.make(broken).accepted(accepted("cp-anchor", { status: "blocked", summary: "partial: source unreachable" }));
	const pending = b.runs.run(b.run.id)!.result!;
	assert.equal(pending.delivered_at, null);
	assert.match(pending.error ?? "", /EACCES/);
	assert.equal(pending.outcome, "blocked");
	// A new process (restart after teardown) has only the run record: the tick posts it, then never again.
	const restarted = b.make();
	restarted.sync();
	restarted.sync();
	assert.equal(b.cards().length, 1);
	assert.equal(b.runs.run(b.run.id)!.result!.error, undefined);
});

test("a crash after the journal write but before delivery was recorded reuses the first card", async (t) => {
	const b = await bench(t);
	const answers = new OperatorAnswers(b.stateDir, { now });
	let wrote = false;
	b.make({ postScheduleResult: (input) => { answers.postScheduleResult(input); wrote = true; throw new Error("killed before delivered_at"); } }).accepted(accepted("cp-anchor"));
	assert.ok(wrote);
	b.make().sync();
	assert.equal(b.cards().length, 1);
	assert.equal(b.runs.run(b.run.id)!.result!.answer_id, b.cards()[0]!.id);
});

test("a crash before intake queued the card is healed from the owner's envelope on disk", async (t) => {
	const b = await bench(t);
	b.facts.set("cp-anchor", { status: "done", summary: "found on restart", generation: 2, links: [undefined, "https://example.invalid/pr/1"] });
	b.make().sync();
	const result = b.runs.run(b.run.id)!.result!;
	assert.equal(result.source_key, `${b.run.id}:cp-anchor:2`);
	assert.deepEqual(result.links, ["https://example.invalid/pr/1"]);
	assert.equal(b.cards().length, 1);
});

test("a pr run posts at close, not on the PR-opening envelope; a closed partial run needs no artifact", async (t) => {
	const b = await bench(t, { kind: "ship", delivery: "pr" });
	await b.runs.admitMember(b.run.id, member("cp-dropped"));
	b.jobs.push({ id: "cp-dropped", status: "closed", close_reason: "dropped: source gone" });
	const results = b.make();
	results.accepted(accepted("cp-anchor", { delivery: "pr" }));
	results.sync();
	assert.equal(b.cards().length, 0);
	await b.runs.closeRun(b.run.id, "partial", "2026-07-01T06:30:00Z");
	results.sync();
	const cards = b.cards();
	assert.equal(cards.length, 1);
	assert.equal(cards[0]!.source?.outcome, "partial");
	assert.match(cards[0]!.answer, /No result envelope from cp-anchor; run closed partial[\s\S]*cp-dropped \(dropped: source gone\)/);
	assert.equal(cards[0]!.job_id, null);
});

test("closed runs older than the reconcile window never flood Answers", async (t) => {
	const b = await bench(t);
	await b.runs.closeRun(b.run.id, "refused", "2026-07-01T06:30:00Z");
	b.make(undefined, () => new Date("2026-07-08T06:31:00Z")).sync();
	assert.equal(b.cards().length, 0);
	assert.equal(b.runs.run(b.run.id)!.result, undefined);
});

test("one run whose result edit fails does not block the next run's card (PR1 review medium)", async (t) => {
	const b = await bench(t);
	await b.runs.closeRun(b.run.id, "completed", "2026-07-01T06:30:00Z");
	const next: ScheduleRun = { ...structuredClone(b.run), id: "run-20260701061000-fedcba", anchor_job_id: null, members: [] };
	await b.runs.createRun(next);
	await b.runs.closeRun(next.id, "partial", "2026-07-01T06:40:00Z");
	// The first run's edit is refused (a validation failure); the reconcile must still queue and post the second card.
	const runs = { get active() { return b.runs.active; }, runs: () => b.runs.runs(), run: (id: string) => b.runs.run(id), runOfJob: (id: string) => b.runs.runOfJob(id),
		editRun: (id: string, fn: (run: ScheduleRun) => void) => { if (id === b.run.id) throw new Error("invalid run"); return b.runs.editRun(id, fn); } };
	const logged: string[] = [];
	new ScheduleResults({ runs: runs as unknown as ScheduleRunStore, answers: new OperatorAnswers(b.stateDir, { now }), ledgerJobs: () => b.jobs, facts: () => undefined, now, log: (line) => logged.push(line) }).sync();
	assert.deepEqual(b.cards().map((card) => card.source?.run_id), [next.id]);
	assert.ok(logged.some((line) => line.includes(b.run.id) && line.includes("invalid run")), "the bad run is named");
});

test("a skill run's result owner is S1 from the anchor's expanded comment, never the anchor or a reader", async (t) => {
	const b = await bench(t, { skill: "cp-org-pr-review", delivery: "local", description: "org: example-org" });
	await b.runs.admitMember(b.run.id, member("cp-l1"));
	await b.runs.admitMember(b.run.id, member("cp-s1"));
	const results = b.make();
	results.accepted(accepted("cp-anchor"));
	results.accepted(accepted("cp-s1"));
	assert.equal(b.cards().length, 0, "no expanded: comment yet, so no owner");
	b.jobs[0]!.comments = [{ text: "expanded: L1 cp-l1, S1 cp-s1" }];
	results.accepted(accepted("cp-l1"));
	results.accepted(accepted("cp-s1"));
	assert.deepEqual(b.cards().map((card) => card.job_id), ["cp-s1"]);
});

// PR3 review medium: a runner-driven run admits S1 by role and its anchor's marker may lag or name an older S1;
// the admitted role wins, and a marker naming a non-member never makes a stranger the owner.
test("resultOwner picks the S1 admitted by role over the expanded: marker; a marker naming a non-member owns nothing", async (t) => {
	const b = await bench(t, { skill: "cp-org-pr-review", delivery: "local", description: "org: example-org" });
	await b.runs.admitMember(b.run.id, { job_id: "cp-l1", role: "L1", admitted_at: at });
	await b.runs.admitMember(b.run.id, { job_id: "cp-s1", role: "S1", admitted_at: at });
	b.jobs[0]!.comments = [{ text: "expanded: L1 cp-l1, S1 cp-stale" }];
	assert.equal(resultOwner(b.runs.run(b.run.id)!, b.jobs), "cp-s1");
	const legacy = { ...b.runs.run(b.run.id)!, members: [member("cp-anchor"), member("cp-l1")] };
	assert.equal(resultOwner(legacy, b.jobs), null, "cp-stale is not a member");
	assert.equal(resultOwner(legacy, [{ id: "cp-anchor", status: "in_progress", comments: [{ text: "expanded: S1 cp-l1" }] }]), "cp-l1");
	const results = b.make();
	results.accepted(accepted("cp-l1")); results.accepted(accepted("cp-s1"));
	assert.deepEqual(b.cards().map((card) => card.job_id), ["cp-s1"]);
});

test("reportedFacts reads the filed envelope and receipts, never before intake stamped it", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, paths.envelopeFile("cp-anchor"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ envelope: { status: "failed", summary: "source unreachable" } }));
	const record = { job_id: "cp-anchor", supersessions: 1, receipts: [{ kind: "pr", url: "https://example.invalid/pull/2" }] } as unknown as FleetRecord;
	assert.equal(reportedFacts(home.path, record), undefined);
	const facts = reportedFacts(home.path, { ...record, reported_at: at });
	assert.equal(facts?.status, "failed");
	assert.equal(facts?.generation, 2);
	assert.deepEqual(facts?.links, [undefined, "https://example.invalid/pull/2"]);
});
