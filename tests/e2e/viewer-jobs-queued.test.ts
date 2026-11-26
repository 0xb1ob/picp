/**
 * jobs-queued-time: the Jobs page's queued-at, live wait and server-derived reason, through a real `bin/cp-view` on a
 * scratch home seeded the way the dispatcher, both queues and the schedule runner write it.
 */
import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { nativeSlotRefusal } from "../../src/drivers/claude.ts";
import type { JobResponse, JobsResponse, QueueWait } from "../../src/viewer/api-types.ts";
import { nativeConfigFile } from "../../src/worker-driver.ts";
import { createScratchHome } from "../harness/index.ts";
import { startViewer } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

function seed(home: string) {
	const put = (file: string, value: unknown) => {
		const path = join(home, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, JSON.stringify(value));
		renameSync(`${path}.tmp`, path);
	};
	const job = (id: string, minutes: number, extra: object = {}) => ({ id, title: `Title ${id}`, status: "open",
		labels: ["project:demo", "kind:ship"], blocked_by: [], comments: [], created_at: iso(minutes),
		updated_at: iso(minutes), ...extra });
	const grant = (id: string, status: string, extra: object) => put(join(LAYOUT.mandates, `${id}.json`), { id, status,
		issued_at: iso(180), expiry: "2099-01-01T00:00:00Z", projects: ["demo"], objective: id,
		spend_cap: { usd: 20, tokens: 10_000 }, ...extra });
	const worker = { pid: process.pid, driver: "claude", model: "anthropic/claude-sonnet-5", started_at: iso(70) };
	const running = (id: string, phase: string, extra: object = {}) => ({ job_id: id, project: "demo", kind: "ship",
		delivery: "pr", phase, worker, dispatched_at: iso(70), ...extra });
	return { put, job, grant, running };
}

const facts = (wait: QueueWait | null | undefined) =>
	wait && [wait.kind, wait.reason, wait.queued_at, wait.queued_at_source];
/** The served seconds count from the queued-at against the viewer's clock, pinned at NOON when it started. */
function derived(wait: QueueWait | null | undefined, at: string): void {
	const expected = (NOON - Date.parse(at)) / 1000;
	const seconds = wait?.waiting_seconds ?? -1;
	assert.ok(seconds >= expected && seconds < expected + 300, `${JSON.stringify(wait)} vs ${expected}s`);
}

test("jobs-queued-time: a waiting job shows its reason, queued-at and live wait; a started one keeps waited",
	{ timeout: 180_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const s = seed(scratch.path);
	// cp-refused is the incident's shape: the schedule runner's dispatch refused on a full Claude CLI, noted and retried.
	const why = nativeSlotRefusal(["cp-run1", "cp-run2"], "cp-refused", 2, "live or being admitted")!.why;
	const full = `refused: cp-refused cannot run on the Claude CLI driver: ${why}`;
	const refused = (minutes: number) =>
		({ at: iso(minutes), author: "schedule-runner", text: `dispatch refused ${iso(minutes)}: ${full}` });
	const scheduled = (id: string) => ["project:demo", "kind:research", `schedule:${id}`];
	const ledger = (over: Record<string, object> = {}) => s.put(".pi-command-post/jobs.json", { jobs: [
		s.job("cp-run1", 90, { status: "in_progress" }), s.job("cp-run2", 90, { status: "in_progress" }),
		s.job("cp-dep", 40, { blocked_by: ["cp-run1"] }), s.job("cp-cli", 60), s.job("cp-grantcap", 35),
		s.job("cp-paused", 25),
		s.job("cp-expired", 20), s.job("cp-nogrant", 45), s.job("cp-backlog", 300, { status: "deferred" }),
		s.job("cp-anchor", 120, { status: "deferred", labels: scheduled("sch-bbbbbb") }),
		s.job("cp-gone", 150, { status: "closed", closed_at: iso(12), close_reason: "done" }),
		s.job("cp-unblocked", 200, { blocked_by: ["cp-gone"] }),
		s.job("cp-refused", 50, { labels: scheduled("sch-aaaaaa"), comments: [refused(30), refused(10)] }),
	].map((job) => ({ ...job, ...over[job.id] })) });
	ledger();
	const fleet = [s.running("cp-run1", "waiting"), s.running("cp-run2", "held", { reported_at: iso(20) })];
	s.put(LAYOUT.fleetFile, { jobs: fleet });
	s.put(join(LAYOUT.runs, "cp-run1", "status.json"), { phase: "working", started_at: iso(70) });
	s.put(nativeConfigFile(""), { claude_ship: true, max_concurrent: 2 });
	const parked = { job_id: "cp-cli", request: {}, queued_at: iso(42), waiting_driver: "claude", attempts: 0 };
	s.put(LAYOUT.dispatchQueueFile, { schema_version: 1, entries: [parked] });
	const review = { kind: "review", job_id: "cp-run2", driver: "claude", text: "waiting for Claude CLI capacity",
		request: {}, queued_at: iso(15) };
	s.put(LAYOUT.nativeWaitFile, { schema_version: 1, entries: [review] });
	s.grant("md-busy", "active", { job_ids: ["cp-run1", "cp-grantcap"], dispatch_parallelism: 1, job_cap: 10 });
	s.grant("md-held", "paused", { job_ids: ["cp-paused"], pause_reason: "token_cap" });
	s.grant("md-old", "expired", { job_ids: ["cp-expired"], expiry: iso(100) });
	const view = await startViewer(t, { home: scratch.path, requireTailnet: false, at: new Date(NOON).toISOString() });
	const jobs = async () => JSON.parse((await view.get("/api/jobs")).text) as JobsResponse;
	const wait = (data: JobsResponse, id: string) => data.jobs.find((job) => job.id === id)?.queue_wait;

	const data = await jobs();
	const slot = "waiting for a Claude CLI slot (2/2)";
	const unstarted = "no grant or mandate covers it, so nothing will start it";
	const expected: Record<string, [string, string, string, string]> = {
		"cp-dep": ["dependency", "blocked by cp-run1", iso(40), "created"],
		"cp-cli": ["cli_slot", slot, iso(42), "dispatch_queue"],
		"cp-refused": ["cli_slot", slot, iso(30), "refused_dispatch"],
		"cp-run2": ["cli_slot", `its review is ${slot}`, iso(15), "native_wait"],
		"cp-grantcap": ["grant_slot", "waiting for a grant slot (1/1 under md-busy)", iso(35), "created"],
		"cp-nogrant": ["no_grant", unstarted, iso(45), "created"],
		"cp-unblocked": ["no_grant", unstarted, iso(12), "unblocked"],
		"cp-paused": ["grant_paused", "the grant md-held is paused (token_cap); nothing starts until it resumes", iso(25),
			"created"],
		"cp-expired": ["grant_expired", `the grant md-old expired ${iso(100)}; nothing will start it`, iso(20), "created"],
		"cp-backlog": ["backlog", "backlog (deferred): not dispatched until cp_job update status=open", iso(300), "created"],
		"cp-anchor": ["anchor", "an anchor job, never dispatched: its schedule run's jobs do the work", iso(120), "created"],
	};
	for (const [id, row] of Object.entries(expected)) {
		assert.deepEqual(facts(wait(data, id)), row, id);
		derived(wait(data, id), row[2]);
	}
	assert.equal(wait(data, "cp-run1"), null, "a running job keeps today's columns and no wait");

	// The served page: the server's reason and stamp label, and a wait the tab's own clock moves on.
	const tab = await view.open("#jobs");
	const cli = /Claude CLI slot \(2\/2\) · queued .*\(entered the dispatch queue\)/;
	const note = await tab.find(".job-wait-reason", (el) => cli.test(el.getAttribute("title") ?? ""));
	const row = note.closest("article")!;
	assert.match(row.querySelector(".job-wait-time")?.textContent ?? "", /^waiting 4[2-6]m$/, row.textContent ?? "");
	tab.shift(15 * 60_000);
	tab.refresh();
	const ticked = (el: Element) =>
		/^waiting (5[7-9]|6[01])m$/.test(el.textContent ?? "") && /cp-cli/.test(el.closest("article")?.textContent ?? "");
	await tab.find(".job-wait-time", ticked);

	// cp-cli and cp-refused start: no wait any more, and the detail keeps how long each waited from its recorded stamp.
	s.put(LAYOUT.dispatchQueueFile, { schema_version: 1, entries: [] });
	ledger({ "cp-cli": { status: "in_progress" }, "cp-refused": { status: "in_progress" } });
	const started = s.running("cp-cli", "waiting", { dispatched_at: iso(5), queued_at: iso(42) });
	s.put(LAYOUT.fleetFile, { jobs: [...fleet, started,
		s.running("cp-refused", "waiting", { kind: "research", delivery: "local", dispatched_at: iso(8) })] });
	const after = await jobs();
	for (const id of ["cp-cli", "cp-refused"]) assert.equal(wait(after, id), null, `${id} left the queue`);
	const detail = async (id: string) => (JSON.parse((await view.get(`/api/job/${id}`)).text) as JobResponse).job;
	const waited = (at: string, source: string, minutes: number) =>
		({ queued_at: at, queued_at_source: source, seconds: minutes * 60 });
	assert.deepEqual((await detail("cp-cli")).waited, waited(iso(42), "dispatch_queue", 37));
	assert.deepEqual((await detail("cp-refused")).waited, waited(iso(30), "refused_dispatch", 22));
	assert.equal((await detail("cp-run1")).waited, null, "no park stamp, no waited line");
	const page = await view.open("#job/cp-cli");
	const shown = await page.waitText(/waited 37m/);
	assert.match(shown, /waited 37m before dispatch · queued .*\(entered the dispatch queue\)/);
});
