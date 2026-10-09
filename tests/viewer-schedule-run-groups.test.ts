/** P0: the pure run grouping behind the Schedules page, and its pin to the notes the real Scheduler writes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ANCHOR_NOTE, expandedRoles, groupScheduleRuns, SCHEDULE_RUNS, scheduleLands } from "../src/viewer/schedule-run-groups.ts";
import type { Schedule } from "../src/viewer/schedule-core.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const skill = { job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" } } as Schedule;
const plain = { job: { title: "Bump", kind: "ship", delivery: "local" } } as Schedule;
const none = () => ({ board_href: null, pr_url: null });
const job = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: "closed", created_at: at, labels: [], ...extra });
const anchor = (id: string, at: string, extra: Record<string, unknown> = {}) => job(id, at, { notes: "run now from the dashboard (req-1) for sch-aaaaaa (x)", ...extra });

test("a self-review run is one run: anchor + 6 readers + S1 board, one result", () => {
	const readers = [1, 2, 3, 4, 5, 6].map((n) => job(`cp-l${n}`, `2026-09-01T10:0${n}:00Z`, { title: `L${n} [cp-a1]` }));
	const a = anchor("cp-a1", "2026-09-01T10:00:00Z", { comments: [{ text: "expanded: L1 cp-l1, L2 cp-l2, S1 cp-s1" }] });
	const s1 = job("cp-s1", "2026-09-01T10:30:00Z", { status: "open" });
	const g = groupScheduleRuns([a, ...readers, s1], skill, undefined, (id) => ({ board_href: id === "cp-s1" ? "/boards/x/" : null, pr_url: null }));
	assert.equal(g.runs.length, 1);
	assert.deepEqual([g.job_count, g.runs[0]!.jobs_total, g.runs[0]!.jobs_open, g.runs[0]!.status], [8, 8, 1, "open"]);
	assert.deepEqual(g.runs[0]!.result, { kind: "board", job_id: "cp-s1", href: "/boards/x/" });
	assert.deepEqual(g.last_run, { job_id: "cp-a1", at: "2026-09-01T10:00:00Z", via: "dashboard", missed: false });
});

test("the title suffix wins over time; a note-less legacy job of a non-skill schedule is unattributed", () => {
	const a1 = anchor("cp-a1", "2026-09-01T10:00:00Z");
	const a2 = anchor("cp-a2", "2026-09-02T10:00:00Z");
	const late = job("cp-m", "2026-09-02T11:00:00Z", { title: "M [cp-a1]" });
	const g = groupScheduleRuns([a1, a2, late], skill, undefined, none);
	assert.deepEqual(g.runs.map((r) => [r.run_id, r.job_ids]), [["cp-a2", ["cp-a2"]], ["cp-a1", ["cp-a1", "cp-m"]]]);
	const legacy = job("cp-old", "2026-09-02T11:00:00Z");
	assert.deepEqual(groupScheduleRuns([a1, legacy], plain, undefined, none).unattributed, ["cp-old"]);
	assert.deepEqual(groupScheduleRuns([a1, legacy], skill, undefined, none).unattributed, [], "a skill schedule's job joins the latest earlier anchor");
	assert.deepEqual(groupScheduleRuns([legacy], skill, undefined, none).unattributed, ["cp-old"], "no anchor before it");
});

test("legacy `scheduled by sch-…` is an anchor; a missed slot comes from last_fire; the window keeps the latest 5", () => {
	const legacy = job("cp-leg", "2026-09-01T10:00:00Z", { notes: "scheduled by sch-aaaaaa (x)" });
	const g = groupScheduleRuns([legacy], plain, { at: "", slot: "", job_id: "cp-leg", missed: true }, none);
	assert.deepEqual([g.runs[0]!.via, g.runs[0]!.missed], ["slot", true]);
	const many = Array.from({ length: 7 }, (_, n) => anchor(`cp-r${n}`, `2026-09-0${n + 1}T10:00:00Z`));
	const w = groupScheduleRuns(many, plain, undefined, none);
	assert.deepEqual([w.runs.length, w.run_count, w.job_count, w.runs[0]!.run_id], [SCHEDULE_RUNS, 7, 7, "cp-r6"]);
});

test("results: pull request, org-review S1 report, research/local report, ship/local branch, answer", () => {
	const a = anchor("cp-a1", "2026-09-01T10:00:00Z", { comments: [{ text: "expanded: R1 cp-r1, S1 cp-s1" }] });
	const org = { job: { ...skill.job, skill: "cp-org-pr-review" } } as Schedule;
	assert.deepEqual(groupScheduleRuns([a], org, undefined, none).runs[0]!.result, { kind: "report", job_id: "cp-s1", href: "#job/cp-s1" });
	assert.deepEqual(groupScheduleRuns([a], plain, undefined, none).runs[0]!.result, { kind: "branch", job_id: "cp-a1", href: "#job/cp-a1" });
	assert.equal(groupScheduleRuns([a], { job: { ...plain.job, kind: "research" } } as Schedule, undefined, none).runs[0]!.result?.kind, "report");
	assert.equal(groupScheduleRuns([a], { job: { ...plain.job, kind: "research", delivery: "answer" } } as Schedule, undefined, none).runs[0]!.result?.kind, "answer");
	assert.equal(groupScheduleRuns([a], plain, undefined, () => ({ board_href: null, pr_url: "https://github.com/a/b/pull/1" })).runs[0]!.result?.kind, "pull_request");
	assert.equal(groupScheduleRuns([a], { job: { ...plain.job, delivery: "pr" } } as Schedule, undefined, none).runs[0]!.result?.kind, "job");
	assert.deepEqual([skill, org, plain, { job: { ...plain.job, delivery: "pr" } }].map((s) => scheduleLands((s as Schedule).job)), ["board", "report", "branch", "pull_request"]);
});

test("expandedRoles reads the newest expanded: comment", () => {
	assert.deepEqual(expandedRoles([{ text: "expanded: L1 cp-old" }, { text: "note" }, { text: "expanded: L1 cp-l1, L2 cp-l2, S1 cp-s1" }]), { L1: "cp-l1", L2: "cp-l2", S1: "cp-s1" });
	assert.deepEqual(expandedRoles([]), {});
});

test("ANCHOR_NOTE matches the notes the real Scheduler writes for a cron fire, a dashboard run now and a cp_schedule run now", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clock = { now: new Date("2026-07-01T06:00:00Z") };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path, { now: () => clock.now });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => [], cloneOf: () => home.path, now: () => clock.now, startedAt: clock.now, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	const seed = () => mandates.issue({ projects: ["demo"], objective: "triage runs", expiry: "2026-07-03T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 5, at: "2026-07-01T00:00:00Z", schedule_grant: true, allowed_actions: ["plan", "implement"], ask_on: ["plan_approval"] });
	const base = { project: "demo", title: "triage", kind: "research" as const, delivery: "answer" as const };
	const hourly = await scheduler.add({ name: "hourly", mandate_id: seed().id, cron: "0 * * * *", tz: "UTC", ...base });
	const manual = await scheduler.add({ name: "manual", mandate_id: seed().id, manual: true, ...base });
	clock.now = new Date("2026-07-01T07:00:30Z");
	const cronFire = (await scheduler.tick()).find((event) => event.schedule_id === hourly.id);
	const dash = await scheduler.fireNow(manual.id, { via: "dashboard", request_id: "req-1", peer: "127.0.0.1" });
	await ledger.close(dash.job_id!, "done");
	const quote = await scheduler.fireNow(manual.id, { via: "cp_schedule", tool_call_id: "call-1", operator_quote: "run manual now", decided_by: "operator-quote", source_sha: "a".repeat(12) });
	for (const event of [cronFire, dash, quote]) {
		assert.equal(event?.outcome, "fired", event?.reason);
		assert.match((await ledger.show(event!.job_id!)).notes ?? "", ANCHOR_NOTE);
	}
});
