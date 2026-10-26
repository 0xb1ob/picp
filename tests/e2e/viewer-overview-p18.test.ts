/**
 * Behavior 18 (P18): the Overview's data — asks, Landed today, failed jobs, main CI, grants, quota, parent health,
 * delivery and Lined up — from `bin/cp-view` on a scratch home over real HTTP, its clock pinned per read.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { EMPTY_USAGE, JOB_STATUSES, LAYOUT } from "../../src/contracts.ts";
import type { Job } from "../../src/ledger.ts";
import { MainCiStore } from "../../src/main-ci.ts";
import { MandateStore } from "../../src/mandate.ts";
import { writeNextSnapshot } from "../../src/next.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import type { BoardResponse, OverviewResponse } from "../../src/viewer/api-types.ts";
import { startViewer } from "../harness/dashboard.ts";
import { createScratchHome } from "../harness/index.ts";

process.env.TZ = "UTC";
const NOW = "2026-09-26T12:00:00Z";
const AT = "2026-09-26T11:00:00Z";
const ask = { type: "open", id: "ask-ab12", created_at: AT, project: "demo", question: "Raise cap?", options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep", source_escalation: "es-1" };

/** A scratch home (or `root` under it) with `bin/cp-view` serving it; every read re-pins the clock to `now`. */
async function viewer(t: TestContext, root = "", now = NOW) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = join(scratch.path, root);
	mkdirSync(home, { recursive: true });
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	const view = await startViewer(t, { home, requireTailnet: false, at: now, env: { TZ: "UTC" } });
	const read = async <T>(path: string) => (view.pin(now), JSON.parse((await view.get(path)).text) as T);
	return { home, put, view, o: () => read<OverviewResponse>("/api/overview"), board: () => read<BoardResponse>("/api/board") };
}

test("P18-overview-asks: asks, parent questions and decided today read the operator journal and escalations without writing", { timeout: 120_000 }, async (t) => {
	const v = await viewer(t);
	v.put(join(LAYOUT.state, "operator/asks.jsonl"), `${JSON.stringify(ask)}\n{"type":`);
	v.put(LAYOUT.escalationsFile, { items: [
		{ id: "es-1", status: "open", question: "Raise cap?", created_at: AT, kind: "budget_exhausted", job_ids: ["cp-a"] },
		{ id: "es-old", status: "withdrawn", question: "Withdrawn?", created_at: AT, job_ids: [] },
		{ id: "es-2", status: "open", question: "Other?", created_at: AT, kind: "product_ambiguity", job_ids: [] },
		...["operator-delegated", "operator-quote", "mandate"].map((by, i) => ({ id: `es-d${i}`, status: "answered", question: "Ship?", created_at: AT, answered_at: AT, answered_by: by,
			answer: "yes", options: [{ id: "yes", label: "Ship it" }], job_ids: [] })),
	] });
	const data = await v.o();
	assert.deepEqual([data.awaiting.count, data.awaiting.items[0]?.options[0]?.reply], [1, "ask-ab12: Keep"], "the torn last ask line is skipped");
	assert.deepEqual(data.parent_questions.map((q) => [q.id, Math.floor(q.age_seconds ?? -1)]), [["es-2", 3600]], "an ask's own escalation is not a parent question");
	assert.deepEqual([data.decided_today.count, data.decided_today.items[0]?.answer], [1, "Ship it"], "only delegated answers count today");
	assert.equal(data.all_questions_delegated, false);
	assert.deepEqual([data.fleet.operator, data.services, data.quota], [{ running: false, pid: null, since: null, held: 0 }, { health: null }, null]);

	v.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-a", project: "demo", phase: "held" }] });
	for (const journal of ["not json\n", `${JSON.stringify(ask)}\n${JSON.stringify(ask)}\n`, "x".repeat(16 * 1024 * 1024 + 1)]) {
		v.put(join(LAYOUT.state, "operator/asks.jsonl"), journal);
		const broken = await v.o();
		assert.deepEqual([broken.availability.asks, broken.awaiting.count, broken.in_flight[0]?.phase], ["unavailable", null, "held"], "a bad journal never hides the fleet");
		assert.ok(broken.warnings.some((w) => w.section === "asks"));
	}

	const fold = await viewer(t);
	const store = new OperatorAsks(join(fold.home, LAYOUT.state, "operator", "asks.jsonl"));
	const input = { project: "demo", question: "Proceed?", options: [{ label: "Yes", consequence: "Continue" }], recommendation: "Yes" };
	store.answer(store.open(input).id, "Yes");
	store.withdraw(store.open(input).id, "No longer needed");
	const open = store.open(input);
	assert.deepEqual((await fold.o()).awaiting.items.map((a) => a.id), [open.id], "asks fold like the operator store");
	assert.deepEqual(store.open().map((a) => a.id), [open.id], "and the viewer wrote nothing");
	fold.put(LAYOUT.escalationsFile, { items: ["2026-09-25T23:59:59Z", "2026-09-26T00:00:00Z"].map((at, i) => ({ id: `es-day${i}`, status: "answered", question: "Proceed?",
		created_at: at, answered_at: at, answered_by: "operator-delegated", answer: "yes" })) });
	const day = await fold.o();
	assert.equal(day.decided_today.count, 1, "the day starts at host midnight");
	assert.equal("time_zone" in day, false, "the server zone never reaches the page");
});

test("P18-overview-landed: Landed today is merged plus closed and matches the Board; failures, main CI and receipts stay honest", { timeout: 180_000 }, async (t) => {
	const head = "a".repeat(40);
	const ship = await viewer(t);
	ship.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-a", project: "demo", phase: "held", bounds: { wall_clock_seconds: 100 } }] });
	ship.put(join(LAYOUT.runs, "cp-a/status.json"), { phase: "idle", started_at: AT });
	ship.put(join(LAYOUT.runs, "cp-a/envelope.json"), { envelope: { head_sha: head } });
	ship.put(join(LAYOUT.runs, "cp-a/review-1.json"), { verdict: "pass", head_sha: "b".repeat(40), diff_stat: { truncated: false } });
	ship.put(join(LAYOUT.runs, "cp-a/merge.json"), { job_id: "cp-a", pr_url: "https://github.com/acme/repo/pull/1", merge_commit_sha: head, recorded_at: AT });
	let data = await ship.o();
	assert.deepEqual([data.shipped_today.length, data.in_flight[0]?.review, Math.floor(data.in_flight[0]?.elapsed_seconds ?? -1), data.fleet.workers.live], [0, null, 3600, 1],
		"a receipt with no merged_at is no shipment; a pass on another head is no review");
	ship.put(`${LAYOUT.runs}/cp-a/review-equivalent-${head}.json`, { verdict: "pass", head_sha: head, diff_stat: { truncated: false } });
	ship.put(join(LAYOUT.runs, "cp-a/merge.json"), { job_id: "cp-a", pr_url: "https://github.com/acme/repo/pull/1", merge_commit_sha: head, merged_at: AT });
	data = await ship.o();
	assert.deepEqual([data.in_flight[0]?.review, data.shipped_today.length], ["pass", 1]);
	ship.put(`${LAYOUT.runs}/cp-a/review-equivalent-${head}.json`, { verdict: "pass", head_sha: head, diff_stat: { truncated: true } });
	assert.equal((await ship.o()).in_flight[0]?.review, null, "a truncated pass is not current review evidence");

	const landed = await viewer(t);
	const sha = "c".repeat(40), at = "2026-09-26T10:00:00Z";
	const job = (id: string, status: string, closed_at?: string) => ({ id, title: id, status, labels: ["project:demo", "kind:ship"], ...(closed_at ? { closed_at } : {}) });
	landed.put(".pi-command-post/jobs.json", { jobs: [job("cp-merged", "closed", at), job("cp-closed", "closed", at), job("cp-ledger", "closed", at), job("cp-old", "closed", "2026-09-20T10:00:00Z"),
		job("cp-held", "in_progress")] });
	landed.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-merged", project: "demo", phase: "done", dispatched_at: at, closed_at: at }, { job_id: "cp-closed", project: "demo", phase: "done", dispatched_at: at, closed_at: at },
		{ job_id: "cp-old", project: "demo", phase: "done", dispatched_at: at, closed_at: "2026-09-20T10:00:00Z" }, { job_id: "cp-held", project: "demo", phase: "held", dispatched_at: at }] });
	landed.put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", pr_url: "https://github.com/acme/repo/pull/2", merge_commit_sha: sha, merged_at: at });
	data = await landed.o();
	assert.deepEqual([data.shipped_today.map((j) => j.id), data.closed_today], [["cp-merged"], 2], "a done fleet job and a ledger-only close, never the old one or the held one");
	assert.equal((await landed.board()).jobs.filter((j) => j.phase === "done").length, data.shipped_today.length + (data.closed_today ?? 0), "the Board's Landed column total");
	landed.put(LAYOUT.fleetFile, "{broken");
	assert.equal((await landed.o()).closed_today, null);

	const forge = await viewer(t);
	const mr = "https://git.example.test:8443/code/group/sub/repo/-/merge_requests/12";
	forge.put(LAYOUT.fleetFile, { jobs: ["cp-gl", "cp-git-only", "cp-cred", "cp-http"].map((job_id) => ({ job_id, project: "demo", phase: "done", dispatched_at: at, closed_at: at })) });
	forge.put(join(LAYOUT.runs, "cp-gl/merge.json"), { job_id: "cp-gl", pr_url: mr, merge_commit_sha: sha, merged_at: at, forge: { provider: "gitlab" } });
	forge.put(join(LAYOUT.runs, "cp-cred/merge.json"), { job_id: "cp-cred", pr_url: "https://user:secret@git.example.test/g/r/-/merge_requests/1", merge_commit_sha: sha, merged_at: at });
	forge.put(join(LAYOUT.runs, "cp-http/merge.json"), { job_id: "cp-http", pr_url: "http://git.example.test/g/r/-/merge_requests/1", merge_commit_sha: sha, merged_at: at });
	data = await forge.o();
	assert.deepEqual(data.shipped_today.map((j) => [j.id, j.pr_url]), [["cp-gl", mr]], "a custom-host, nested-group MR receipt is a merge");
	assert.equal(data.closed_today, 3, "git-content-only teardowns and unsafe receipt urls are closed work, not observed merges");
	assert.ok(!JSON.stringify(data).includes("secret"), "a credential-bearing url never reaches the page");

	const failed = await viewer(t);
	const d = "d".repeat(40);
	failed.put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-dead", title: "Died", status: "in_progress", labels: [] }] });
	failed.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-dead", project: "demo", phase: "failed", failure: { at, message: "fleet cause" } },
		{ job_id: "cp-long", project: "demo", phase: "failed", failure: { at, message: `\n${"x".repeat(120)}\nsecond line` } }, { job_id: "cp-held", project: "demo", phase: "held", failure: { at, message: "old 503" } },
		{ job_id: "cp-merged", project: "demo", phase: "done", dispatched_at: at, closed_at: at, usage: { ...EMPTY_USAGE, cost_usd: 1.25, total_tokens: 10 } }] });
	failed.put(join(LAYOUT.runs, "cp-dead/status.json"), { phase: "exited", failure: { at, message: "provider 503: overloaded" } });
	failed.put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", pr_url: "https://github.com/acme/repo/pull/3", merge_commit_sha: d, merged_at: at });
	data = await failed.o();
	assert.deepEqual(data.failed, [{ id: "cp-dead", project: "demo", title: "Died", failure: "provider 503: overloaded" }, { id: "cp-long", project: "demo", title: null, failure: `${"x".repeat(79)}…` }],
		"the run's failure wins; first line, 80 chars; a held job's old failure is not a failed job");
	assert.deepEqual(data.shipped_today.map((j) => [j.id, j.cost_usd]), [["cp-merged", 1.25]]);
	assert.equal((await failed.board()).jobs.find((j) => j.id === "cp-merged")?.cost_usd, 1.25, "the same cost the Jobs list shows");
	assert.deepEqual(data.main_ci, { availability: "missing", red: [] }, "no latch file: no latch, never green");
	const store = new MainCiStore({ home: failed.home, now: () => new Date(at) });
	store.setRed("demo", d, { workflow: "ci", failing: "AssertionError: x" });
	assert.deepEqual((await failed.o()).main_ci, { availability: "ok", red: [{ project: "demo", red_since_sha: d, red_since_at: at, workflow: "ci", failing: "AssertionError: x" }] });
	store.clear("demo");
	assert.deepEqual((await failed.o()).main_ci, { availability: "ok", red: [] });
	failed.put(join(LAYOUT.state, "main-ci.json"), "{broken");
	assert.equal((await failed.o()).main_ci.availability, "unavailable");
	failed.put(join(LAYOUT.state, "main-ci.json"), { schema_version: 1, updated_at: at, projects: [{ project: "demo", red_since_sha: "not a sha", red_since_at: at }] });
	assert.equal((await failed.o()).main_ci.availability, "unavailable", "an off-schema row is unreadable, never a silent no-latch");

	const odd = await viewer(t);
	const invalid = { toString: null };
	odd.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-a", project: "demo", phase: "held", dispatched_at: invalid }, { job_id: "cp-b", project: "demo", phase: "waiting", dispatched_at: invalid }] });
	odd.put(join(LAYOUT.runs, "cp-a/status.json"), { phase: invalid });
	odd.put(join(LAYOUT.runs, "cp-a/merge.json"), { job_id: "cp-a", pr_url: invalid, merge_commit_sha: invalid });
	data = await odd.o();
	assert.deepEqual([data.fleet.workers.unknown, data.in_flight[0]?.elapsed_seconds, data.shipped_today, data.quota], [2, null, [], null], "malformed optional fields stay unknown");
	odd.put(".pi-command-post/jobs.json", { jobs: [...JOB_STATUSES.map((status, i) => ({ id: `cp-s${i}`, title: status, status, labels: ["project:demo"], ...(status === "closed" ? { closed_at: at } : {}) }))] });
	odd.put(LAYOUT.fleetFile, { jobs: [] });
	data = await odd.o();
	assert.equal(data.availability.ledger, "ok", "every contract JOB_STATUSES value, deferred included, keeps the ledger available");
	assert.equal(data.closed_today, 1);
	assert.ok((await odd.board()).jobs.some((j) => j.title === "deferred"), "the deferred job is listed");
});

test("P18-overview-health: blockers, flat homes, grants, quota, parent liveness, delivery, services and context come from disk", { timeout: 240_000 }, async (t) => {
	const blocked = await viewer(t);
	blocked.put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-a", title: "Waits on a dropped job", status: "open", blocked_by: ["cp-missing", "cp-dropped"], labels: [] },
		{ id: "cp-dropped", status: "closed", close_reason: "dropped: no longer needed", blocked_by: [], labels: [] }] });
	let data = await blocked.o();
	assert.equal(data.blocked.stranded_count, 2);
	assert.deepEqual(data.blocked.items.map((j) => [j.id, j.title, j.blockers.map((b) => b.id)]), [["cp-a", "Waits on a dropped job", ["cp-missing", "cp-dropped"]]]);
	blocked.put(join(LAYOUT.mandates, "md-bad.json"), "{bad");
	assert.equal((await blocked.o()).blocked.stranded_count, null, "corrupt grants cannot claim no stranded dependencies");

	const flat = await viewer(t, ".pi-command-post");
	flat.put("state/fleet.json", { jobs: [{ job_id: "cp-a", project: "demo", phase: "held" }] });
	flat.put("jobs.json", { jobs: [{ id: "cp-b", title: "Blocked on a missing job", status: "open", blocked_by: ["cp-missing"], labels: [] }] });
	data = await flat.o();
	assert.deepEqual([data.in_flight.map((j) => [j.id, j.phase]), data.blocked.items.map((j) => j.id)], [[["cp-a", "held"]], ["cp-b"]], "a flat home is read directly under --home");

	const grants = await viewer(t);
	const mandates = new MandateStore(grants.home);
	const active = mandates.issue({ projects: ["demo"], objective: "Long objective ".repeat(30), expiry: "2026-09-27T12:00:00Z", spend_cap: { usd: 100, tokens: 10000 }, job_cap: 10, at: "2026-09-26T00:00:00Z" });
	for (let i = 0; i < 7; i++) mandates.revoke(mandates.issue({ projects: ["demo"], objective: `Old ${i}`, expiry: "2026-09-27T12:00:00Z", spend_cap: { usd: 10, tokens: 1000 }, job_cap: 2, at: "2026-09-26T00:00:00Z" }).id);
	grants.put(LAYOUT.fleetFile, { schema_version: 1, updated_at: AT, jobs: [{ job_id: "cp-work", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting",
		worker: { pid: 4242, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m", started_at: "2026-09-26T00:00:00Z" }, worktree: "/unused", branch: "cp-work",
		dispatched_at: "2026-09-26T00:00:00Z", usage: { ...EMPTY_USAGE, cost_usd: 1, total_tokens: 100, cache_read: 40 } }] });
	grants.put(join(LAYOUT.runs, "cp-work/status.json"), { phase: "working", usage: { ...EMPTY_USAGE, cost_usd: 2, total_tokens: 200, cache_read: 50 } });
	grants.put(join(LAYOUT.runs, "cp-work/review-1/status.json"), { schema_version: 1, job_id: "cp-work", phase: "idle", turns: 1, tool_calls: 0, usage: { input: 20, output: 10, cache_read: 0,
		cache_write: 0, total_tokens: 30, cost_usd: 0.5 }, started_at: "2026-09-26T00:00:00Z", last_activity_at: "2026-09-26T00:00:00Z", event_count: 1, reported: false });
	data = await grants.o();
	const item = data.mandates.items.find((m) => m.id === active.id)!;
	assert.deepEqual([item.objective, data.mandates.revoked_hidden_count, data.mandates.active_count], [active.objective, 7, 1], "the full objective and the full revoked count");
	assert.deepEqual([item.spend?.tokens, item.spend?.usd], [180, 2.5], "live non-cached tokens plus the reviewer's, live cost plus the reviewer's");
	grants.put(join(LAYOUT.mandates, "md-paused.json"), { id: "md-paused", status: "paused", projects: ["paused-project"], issued_at: "2026-09-25T00:00:00Z", expiry: "2026-09-25T12:00:00Z",
		objective: "Paused", spend_cap: { usd: 10, tokens: 1000 } });
	assert.deepEqual((await grants.o()).mandates.paused_projects, ["paused-project"]);

	const quota = await viewer(t);
	quota.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-a", project: "demo", phase: "waiting", dispatched_at: AT }] });
	const event = (source: string, at: string) => ({ source: "cp", type: "routing_resolved", ts: at, payload: { scope: "M", risk: "high", provenance: { risk: "explicit" },
		quota: { providers: [{ provider: "anthropic", five_hour: 62, seven_day: 86, tight: true }] }, capacity: { source, scores: [{ provider: "anthropic", score: 3 }] } } });
	quota.put(join(LAYOUT.runs, "cp-a/events.jsonl"), `${JSON.stringify(event("fleet", AT))}\n`);
	data = await quota.o();
	assert.equal(data.quota?.providers[0]?.free_slots, null, "fleet capacity scores are no free slots");
	assert.match(data.in_flight[0]?.routing ?? "", /risk:high \(explicit\)/);
	quota.put(join(LAYOUT.runs, "cp-a/events.jsonl"), `${JSON.stringify(event("admin", "2026-09-26T11:01:00Z"))}\n`);
	const q = (await quota.o()).quota!;
	assert.deepEqual([q.historical, q.source_job_id, q.observed_at, q.providers[0]?.free_slots], [true, "cp-a", "2026-09-26T11:01:00Z", 3], "the cache refreshes after the file changes");
	quota.put(join(LAYOUT.runs, "cp-a/events.jsonl"), `${" ".repeat(256 * 1024)}\n${JSON.stringify(event("admin", "2026-09-26T11:02:00Z"))}\n`);
	assert.equal((await quota.o()).quota, null, "evidence past the read bound is no quota");

	const parent = await viewer(t);
	parent.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-script", project: "demo", phase: "held", executor: "script", script_path: "scripts/run.sh" }, { job_id: "cp-unknown", project: "demo", phase: "waiting" }] });
	parent.put(join(LAYOUT.runs, "cp-script/status.json"), { phase: "idle" });
	parent.put(join(LAYOUT.state, "sessions/cp-parent-context.json"), { contextTokens: 23000, lastTurnCostUsd: 0.041 });
	parent.put(".pi-command-post/data/parent.json", { compact_at_tokens: 300000 });
	parent.put(join(LAYOUT.state, "sessions/cp-parent-control.json"), { model: "recorded-model", token: "must-not-leak" });
	data = await parent.o();
	assert.deepEqual([data.fleet.parent.activity, data.fleet.parent.compact_at_tokens, data.fleet.parent.model, data.fleet.operator.running], ["unknown", 300000, "recorded-model", false]);
	const script = data.in_flight.find((j) => j.id === "cp-script");
	assert.deepEqual([data.fleet.workers.live, data.fleet.workers.unknown, script?.script_path, script?.model], [1, 1, "scripts/run.sh", null], "a script's health; an unknown source is unknown");
	assert.doesNotMatch(JSON.stringify(data), /must-not-leak/);
	assert.deepEqual([data.fleet.parent.pid, data.fleet.parent.alive, data.fleet.parent.stale_since], [null, false, null], "no lock file is down, never alive");
	const dead = 2 ** 22 + 1;
	parent.put(join(LAYOUT.state, "parent.lock"), { pid: dead, started_at: "2026-09-26T10:00:00Z", home: parent.home });
	data = await parent.o();
	assert.deepEqual([data.fleet.parent.pid, data.fleet.parent.alive, data.fleet.parent.stale_since], [dead, false, "2026-09-26T10:00:00Z"], "a crashed parent's lock is a fact and names when");
	parent.put(join(LAYOUT.state, "parent.lock"), { pid: process.pid, started_at: "2026-09-26T10:00:00Z", home: parent.home, session_id: "live-holder" });
	data = await parent.o();
	assert.deepEqual([data.fleet.parent.alive, data.fleet.parent.stale_since], [true, null], "process.kill(pid, 0) on a live holder: alive, nothing stale");
	parent.put(LAYOUT.fleetFile, "{broken");
	assert.equal((await parent.o()).fleet.workers.live, null);

	const relay = await viewer(t);
	const entry = (id: string, queued_at: string, kind = "wake") => ({ id, relay: { kind, stale: false, text: "x", receipt: { level: null, reached: [] }, paths: [] }, queued_at, producer: "1.1" });
	const outbox = join(LAYOUT.state, "operator/relay-outbox.json"), acks = join(LAYOUT.state, "operator/relay-acks.jsonl");
	const delivery = async () => {
		const d = (await relay.o()).delivery;
		return { ...d, oldest_age_seconds: d.oldest_age_seconds === null ? null : Math.floor(d.oldest_age_seconds) };
	};
	const none = { unseen: null, oldest_id: null, oldest_kind: null, oldest_age_seconds: null, consumer_seen_at: null, alarm: false };
	assert.deepEqual(await delivery(), { availability: "missing", ...none, unseen: 0 }, "no outbox: nothing relayed, no alarm");
	relay.put(outbox, { schema_version: 1, updated_at: "2026-09-26T11:59:00Z", entries: [entry("esc:es-1", "2026-09-26T11:50:01Z", "escalation"), entry("wake:a", "2026-09-26T11:55:00Z")] });
	assert.deepEqual(await delivery(), { availability: "ok", unseen: 2, oldest_id: "esc:es-1", oldest_kind: "escalation", oldest_age_seconds: 599, consumer_seen_at: null, alarm: false }, "599 s: no alarm");
	relay.put(outbox, { schema_version: 1, updated_at: "2026-09-26T11:59:00Z", entries: [entry("esc:es-1", "2026-09-26T11:50:00Z", "escalation"), entry("wake:a", "2026-09-26T11:55:00Z")] });
	assert.equal((await delivery()).alarm, true, "600 s: alarm");
	relay.put(acks, `${JSON.stringify({ type: "consumer", owner: "o", pid: 1, at: "2026-09-26T11:40:00Z", protocol: 1 })}\n${JSON.stringify({ type: "ack", id: "esc:es-1", at: "2026-09-26T11:56:00Z" })}\n{"type":"ack","id":"wake:`);
	assert.deepEqual(await delivery(), { availability: "ok", unseen: 1, oldest_id: "wake:a", oldest_kind: "wake", oldest_age_seconds: 300, consumer_seen_at: "2026-09-26T11:40:00Z", alarm: false },
		"an acked id is closed; the torn last line is skipped");
	relay.put(acks, `${JSON.stringify({ type: "discard", id: "wake:a", reason: "x", at: "2026-09-26T11:56:00Z" })}\n`);
	assert.equal((await delivery()).unseen, 1, "a discard closes its id too");
	relay.put(acks, "garbage\n");
	assert.deepEqual(await delivery(), { availability: "unavailable", ...none }, "a malformed ack line is unavailable, never 0");
	relay.put(acks, "");
	relay.put(outbox, "{not json");
	assert.deepEqual(await delivery(), { availability: "unavailable", ...none }, "a malformed outbox is unavailable");
	relay.put(join(LAYOUT.state, "health.json"), { schema_version: 1, last_run_at: "2026-09-26T11:59:00Z", checks: { disk: { status: "fail", detail: "3 GiB", since: "2026-09-26T11:30:00Z" },
		gh: { status: "ok", detail: "ok", since: "2026-09-26T11:00:00Z" } } });
	assert.deepEqual((await relay.o()).services, { health: { last_run_at: "2026-09-26T11:59:00Z", failing: [{ check: "disk", detail: "3 GiB", since: "2026-09-26T11:30:00Z" }] } }, "a failing check carries its since");

	const context = await viewer(t);
	context.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-live", project: "demo", phase: "held", model: "anthropic/claude", worker: { session_file: join(context.home, LAYOUT.state, "sessions", "cp-live.jsonl") } },
		{ job_id: "cp-none", project: "demo", phase: "waiting" }] });
	context.put(join(LAYOUT.state, "sessions/cp-live.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude", stopReason: "stop",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } }) + "\n");
	context.put(join(LAYOUT.state, "model-windows.json"), { recorded_at: AT, windows: { "anthropic/claude": 1000 } });
	const flying = (await context.o()).in_flight;
	assert.deepEqual([flying.find((j) => j.id === "cp-live")?.context?.tokens, flying.find((j) => j.id === "cp-live")?.context?.window, flying.find((j) => j.id === "cp-none")?.context], [15, 1000, null],
		"context is the recorded worker session, otherwise null");
});

test("P18-overview-lined-up: the Overview tab shows the cp_next snapshot as written, its age, and never invents Nothing queued", { timeout: 120_000 }, async (t) => {
	const now = Date.now();
	const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
	const hhmm = (iso: string) => iso.slice(11, 16);
	const v = await viewer(t, "", new Date(now).toISOString());
	const screen = async () => { const tab = await v.view.open("#overview"); return { tab, text: await tab.waitText(/Lined up/) }; };
	assert.deepEqual((await v.o()).lined_up, { availability: "missing", at: null, project: null, empty_since: null, items: [], unavailable: [] });
	assert.match((await screen()).text, /Lined up · -.*Refreshes on next scheduling pass/s);
	const job = { id: "cp-q1", title: "Queued <b>title</b>", labels: ["project:demo"] } as unknown as Job;
	writeNextSnapshot(v.home, { ready: [job], action: { kind: "wait", reason: "md-a dispatch-parallelism 1 is full" }, lined_up: { jobs: [job], queued: [] } }, ago(30), "demo");
	assert.deepEqual((await v.o()).lined_up.items.map((i) => [i.kind, i.id, i.verdict]), [["job", "cp-q1", "wait"]]);
	const ready = await screen();
	assert.match(ready.text, new RegExp(`Lined up · 1.*snapshot from ${hhmm(ago(30))}, 30m ago · demo only`, "s"));
	const link = ready.tab.$('a[href="#job/cp-q1"]')!;
	assert.ok(link.textContent!.includes("Queued <b>title") && !link.querySelector("b"), "the title is text, never markup");
	assert.match(ready.text, /wait · md-a dispatch-parallelism 1 is full/);
	assert.doesNotMatch(ready.text, /Nothing queued/);
	const empty = { ready: [], action: { kind: "wait" as const, reason: "nothing ready" }, lined_up: { jobs: [], queued: [] } };
	writeNextSnapshot(v.home, empty, ago(120));
	writeNextSnapshot(v.home, empty, ago(60));
	assert.match((await screen()).text, new RegExp(`Lined up · 0.*snapshot from ${hhmm(ago(60))}, 1h ago.*Nothing queued since ${hhmm(ago(120))}`, "s"));
	writeNextSnapshot(v.home, { ready: [], action: { kind: "wait", reason: "draining" } }, ago(60), "demo");
	const unread = await screen();
	assert.equal(unread.tab.$('p.overview-meta[title="not read: draining"]')?.textContent, "demo: not read", "a short muted note; the error is the tooltip");
	assert.doesNotMatch(unread.text, /Nothing queued/, "unread evidence is never nothing queued");
	v.put(join(LAYOUT.state, "next-snapshot.json"), { schema_version: 2, at: ago(60), items: [{ kind: "job", id: "../x", project: "demo", verdict: "wait", reason: "" }], unavailable: [] });
	assert.equal((await v.o()).lined_up.availability, "unavailable", "an unsafe job id makes the snapshot unreadable");
	assert.match((await screen()).text, /Lined up unavailable/);
	v.put(join(LAYOUT.state, "next-snapshot.json"), { schema_version: 1, at: ago(60), items: [{ kind: "bead", id: "bd-7", project: "demo", verdict: "no job", reason: "" }], unavailable: [] });
	assert.equal((await v.o()).lined_up.availability, "missing", "an older snapshot version is not yet written, not an error");
	const older = (await screen()).text;
	assert.match(older, /Lined up · -.*Refreshes on next scheduling pass/s);
	assert.doesNotMatch(older.slice(older.indexOf("Lined up")), /^Lined up (unavailable|unreadable)|Nothing queued/);
});
