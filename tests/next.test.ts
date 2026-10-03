/**
 * cp_next (pi-command-post-autonomy-programme-cur.4.1): one mandate's ready
 * jobs, live workers vs parallelism, caps and the recommended next action.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, isoTimestamp, LAYOUT, WORKER_FORBIDDEN_TOOLS, type FleetRecord } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { cpNext, dedupeNext, formatNext, type NextPorts } from "../src/next.ts";
import { mandateDisplay } from "../src/viewer/mandates-map-view.ts";
import { CommandPost } from "../src/command-post.ts";
import { registerSendStatusTools } from "../extensions/command-post/tools-send-status.ts";
import { registerMandateTools } from "../extensions/command-post/tools-mandate.ts";
import { createScratchHome, REPO_ROOT, type ScratchHome } from "./harness/index.ts";
import { createScratchLedger } from "./harness/index.ts";

function later(ms = 86_400_000): string {
	return isoTimestamp(new Date(Date.now() + ms));
}

function bench(home: ScratchHome): NextPorts {
	const scratch = createScratchLedger({ knownProjects: ["demo"], home: home.path });
	return {
		ledger: scratch.ledger as Ledger,
		fleet: new FleetStore({ home: home.path }),
		mandates: new MandateStore(home.path),
		escalations: new EscalationStore({ home: home.path }),
	};
}

function fleetRecord(overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: "cp-x",
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "waiting",
		worker: {
			pid: 4242,
			session_id: "abc",
			session_file: "/sessions/abc.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-08-27T12:00:00Z",
		},
		worktree: "/wt/cp-x",
		branch: "cp-x",
		dispatched_at: "2026-08-27T12:00:00Z",
		usage: EMPTY_USAGE,
		...overrides,
	};
}

test("no active mandate: cp_next says so instead of guessing", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const result = await cpNext(ports, "demo");
	assert.equal(result.action.kind, "no_mandate");
	assert.equal(result.mandate, undefined);
});

test("two dependent jobs: the second dispatches once the first closes, no operator message", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const first = await ports.ledger.create({ title: "first", project: "demo", delivery: "pr", kind: "ship" });
	const second = await ports.ledger.create({ title: "second", project: "demo", delivery: "pr", kind: "ship" });
	await ports.ledger.addDep(second.id, first.id);

	ports.mandates.issue({
		projects: ["demo"],
		objective: "ship the pair",
		expiry: later(),
		spend_cap: { usd: 100, tokens: 1_000_000 },
		job_cap: 10,
	});

	// Before the first closes, only it is ready and recommended.
	const before = await cpNext(ports, "demo");
	assert.equal(before.action.kind, "dispatch");
	assert.equal(before.action.job_id, first.id);
	assert.deepEqual(
		before.ready.map((j) => j.id),
		[first.id],
	);

	await ports.ledger.close(first.id, "https://example.com/pr/1");

	const after = await cpNext(ports, "demo");
	assert.equal(after.action.kind, "dispatch");
	assert.equal(after.action.job_id, second.id, "the second job dispatches with no operator message");
});

test("spawn cap: cp_next waits when live worker processes reach spawn_cap, dispatches below it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const job = await ports.ledger.create({ title: "capped", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "ship it", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });

	const full = await cpNext({ ...ports, capacity: () => ({ active: 10, cap: 10, held: ["cp-a1"] }) }, "demo");
	assert.equal(full.action.kind, "wait");
	assert.equal(full.action.job_id, undefined);
	assert.match(full.action.reason, /spawn cap 10 reached: 10 live worker processes \(held: cp-a1\)/);
	assert.match(full.action.reason, new RegExp(`${job.id} dispatches when one tears down`));

	const room = await cpNext({ ...ports, capacity: () => ({ active: 9, cap: 10, held: [] }) }, "demo");
	assert.deepEqual([room.action.kind, room.action.job_id], ["dispatch", job.id]);
});

test("spawn cap: every grant's dispatch waits, others included; a pipeline step (gate-reviewer reserve) keeps its recommendation", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const first = await ports.ledger.create({ title: "first", project: "demo", delivery: "pr", kind: "ship" });
	const second = await ports.ledger.create({ title: "second", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "one", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [first.id] });
	ports.mandates.issue({ projects: ["demo"], objective: "two", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [second.id] });
	const capped = { ...ports, capacity: () => ({ active: 10, cap: 10, held: [] }) };

	const both = await cpNext(capped, "demo");
	assert.deepEqual([both.action.kind, ...(both.others ?? []).map((other) => other.action.kind)], ["wait", "wait"], "no grant recommends a refused spawn");

	const piped = await cpNext({ ...capped, pipelines: { get: (id: string) => (id === second.id ? {} : undefined) } as never }, "demo");
	assert.deepEqual([piped.action.kind, piped.action.job_id], ["pipeline", second.id], "the pipeline grant leads; its advance is not refused at spawn_cap");
	assert.deepEqual(piped.others?.map((other) => other.action.kind), ["wait"]);
});

test("spawn cap: the cp_next tool reads the manager's live processes and held job ids", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const job = await ports.ledger.create({ title: "capped", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "ship it", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	await ports.fleet.add(fleetRecord({ job_id: "cp-a1", phase: "held", reported_at: isoTimestamp() }));
	// Nine authors plus one reviewer keyed under cp-a1: ten processes, as the manager's own cap check counts them.
	const active = [...Array.from({ length: 9 }, (_, n) => ({ jobId: `cp-w${n}` })), { jobId: "cp-a1" }];
	const manager = { active, spawnCap: 10 };
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
	registerMandateTools({ on: () => {}, registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool) } as never, {
		commandPost: () => ({ packageRoot: REPO_ROOT, ledger: () => ports.ledger, registry: undefined, fleet: ports.fleet, mandates: ports.mandates, escalations: ports.escalations, pipelines: undefined, manager }),
		setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined,
	} as never);
	const call = async () => (await tools.get("cp_next")!.execute("c", { project: "demo", full: true }, undefined, undefined, { hasUI: false, modelRegistry: undefined })).content[0]!.text;

	assert.match(await call(), new RegExp(`action: wait \u2014 spawn cap 10 reached: 10 live worker processes \\(held: cp-a1\\) \u2014 ${job.id} dispatches`));
	active.pop();
	assert.match(await call(), new RegExp(`action: dispatch ${job.id}`));
});

test("an objective-issue grant without job_ids covers a second same-project job and never invents a mission end on the first close", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const first = await ports.ledger.create({ title: "fix issue #17", project: "demo", delivery: "pr", kind: "ship" });
	const grant = ports.mandates.issue({ projects: ["demo"], objective: "fix issue #17", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	await ports.ledger.close(first.id, "https://example.com/pr/1");
	const takeover = await ports.ledger.create({ title: "second PR for #17", project: "demo", delivery: "pr", kind: "ship" });

	const next = await cpNext(ports, "demo");
	assert.deepEqual([next.mandate?.id, next.action.kind, next.action.job_id], [grant.id, "dispatch", takeover.id]);
	assert.equal(ports.escalations.open().filter((item) => item.kind === "mission_end").length, 0, "no premature mission end");

	// Once the grant has expired, cp_next offers no fresh work under it.
	const lapsed = await cpNext({ ...ports, now: () => new Date(Date.now() + 2 * 86_400_000) }, "demo");
	assert.equal(lapsed.action.kind, "no_mandate");
	assert.equal(lapsed.action.job_id, undefined);
});

/** A saved cron schedule naming `mandateId` (state/schedules.json), the S3 link from a scheduled job to its grant. */
function saveSchedule(home: string, id: string, mandateId: string): void {
	const job = { title: "nightly", kind: "ship", delivery: "pr" };
	const schedule = { id, name: id, project: "demo", mandate_id: mandateId, trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job, enabled: true, created_at: "2026-01-01T00:00:00Z" };
	mkdirSync(join(home, LAYOUT.state), { recursive: true });
	writeFileSync(join(home, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));
}

test("schedlater S1: a schedule:/delivery:answer job is the runner's, not cp_next's; a schedule:/delivery:pr one still is", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	await ports.ledger.create({ title: "digest", project: "demo", delivery: "answer", kind: "research", labels: ["schedule:sch-def456"] });
	const pr = await ports.ledger.create({ title: "nightly fix", project: "demo", delivery: "pr", kind: "ship", labels: ["schedule:sch-def456"] });
	const grant = ports.mandates.issue({ projects: ["demo"], objective: "nightly", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, schedule_grant: true });
	saveSchedule(home.path, "sch-def456", grant.id);
	const next = await cpNext(ports, "demo");
	assert.deepEqual([next.action.kind, next.action.job_id, next.ready.map((job) => job.id)], ["dispatch", pr.id, [pr.id]]);
});

test("schedlater S3: cp_next never recommends an unrelated job under a schedule's grant, nor a scheduled job under a project-wide one", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const unrelated = await ports.ledger.create({ title: "unrelated", project: "demo", delivery: "pr", kind: "ship" });
	const scheduled = await ports.ledger.create({ title: "nightly fix", project: "demo", delivery: "pr", kind: "ship", labels: ["schedule:sch-def456"] });
	const other = await ports.ledger.create({ title: "another schedule's fix", project: "demo", delivery: "pr", kind: "ship", labels: ["schedule:sch-aaa111"] });
	const grant = ports.mandates.issue({ projects: ["demo"], objective: "nightly", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, schedule_grant: true });
	saveSchedule(home.path, "sch-def456", grant.id);
	const only = await cpNext(ports, "demo");
	assert.deepEqual([only.mandate?.id, only.action.job_id, only.ready.map((job) => job.id)], [grant.id, scheduled.id, [scheduled.id]], `${unrelated.id} and ${other.id} are not the schedule's`);

	ports.mandates.revoke(grant.id);
	const wide = ports.mandates.issue({ projects: ["demo"], objective: "ship it", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	const projectWide = await cpNext(ports, "demo");
	assert.deepEqual([projectWide.mandate?.id, projectWide.ready.map((job) => job.id)], [wide.id, [unrelated.id]], "a project-wide grant covers no scheduled job");
});

test("a paused mandate stops dispatch; in-flight is not this tool's business", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	await ports.ledger.create({ title: "job", project: "demo", delivery: "pr", kind: "ship" });
	const mandate = ports.mandates.issue({
		projects: ["demo"],
		objective: "ship it",
		expiry: later(),
		spend_cap: { usd: 100, tokens: 1_000_000 },
		job_cap: 10,
	});
	ports.mandates.pause(mandate.id, "operator");

	const result = await cpNext(ports, "demo");
	assert.equal(result.action.kind, "paused");
	assert.match(result.action.reason, /paused/);
});

test("a paused mandate's zero is scoped to it; live workers under other mandates are counted fleet-wide (cpnextcnt-cdy)", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	await ports.ledger.create({ title: "job", project: "demo", delivery: "pr", kind: "ship" });
	const paused = ports.mandates.issue({ projects: ["demo"], objective: "ship it", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	ports.mandates.issue({ projects: ["other"], objective: "elsewhere", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, dispatch_parallelism: 3 });
	ports.mandates.pause(paused.id, "operator");
	await ports.fleet.mutate((jobs) => {
		for (const id of ["cp-ngno", "cp-bkui", "cp-cdn2"]) jobs.push(fleetRecord({ job_id: id, project: "other", branch: id, worktree: `/wt/${id}` }));
	});

	const result = await cpNext(ports, "demo");
	assert.equal(result.action.kind, "paused");
	assert.equal(result.mandate?.live_workers, 0);
	assert.equal(result.fleet_live_workers, 3);
	const text = formatNext(result);
	assert.match(text, new RegExp(`${paused.id}: paused, 0/1 workers working under this mandate`));
	assert.match(text, /fleet: 3 workers working across all mandates/);
});

test("an older paused grant never shadows a newer active one; a token-capped grant tells the parent to raise it itself", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	await ports.ledger.create({ title: "job", project: "demo", delivery: "pr", kind: "ship" });
	const grant = (objective: string, at: string, tokens = 1_000_000) =>
		ports.mandates.issue({ projects: ["demo"], objective, expiry: later(), spend_cap: { usd: 100, tokens }, job_cap: 10, at });
	const old = grant("old", isoTimestamp(new Date(Date.now() - 120_000)), 1_000);
	const revoked = grant("revoked", isoTimestamp(new Date(Date.now() - 90_000)));
	ports.mandates.revoke(revoked.id);
	await ports.fleet.add(fleetRecord({ phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, total_tokens: 90_000_000, cache_read: 89_998_000 } }));

	const capped = await cpNext(ports, "demo");
	assert.equal(capped.mandate?.id, old.id);
	assert.equal(capped.mandate?.tokens, 2_000, "non-cached tokens only");
	assert.equal(capped.action.kind, "paused");
	assert.match(capped.action.reason, /\(token_cap\).*decide it yourself: cp_mandate raise_tokens/);

	const fresh = grant("fresh", isoTimestamp());
	const next = await cpNext(ports, "demo");
	assert.equal(next.mandate?.id, fresh.id, "the active grant wins over the earlier-issued paused one");
	assert.equal(next.action.kind, "dispatch");
});

test("parallelism 2 dispatches two and refuses a third", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	await ports.ledger.create({ title: "a", project: "demo", delivery: "pr", kind: "ship" });
	await ports.ledger.create({ title: "b", project: "demo", delivery: "pr", kind: "ship" });
	await ports.ledger.create({ title: "c", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({
		projects: ["demo"],
		objective: "ship three",
		expiry: later(),
		spend_cap: { usd: 100, tokens: 1_000_000 },
		job_cap: 10,
		dispatch_parallelism: 2,
	});
	// Ledger tie-breaks same-second creates by (random) id, so read the queue's
	// own order back rather than assuming insertion order.
	const queue = (await ports.ledger.ready({ project: "demo" })).map((j) => j.id);
	const [a, b, c] = queue as [string, string, string];

	// Nothing live yet: recommend dispatching the first ready job.
	const first = await cpNext(ports, "demo");
	assert.equal(first.action.kind, "dispatch");
	assert.equal(first.action.job_id, a);

	// One live worker (dispatch claims it, exactly like the real path): parallelism 2 still has room, recommend the next.
	await ports.ledger.claim(a, a);
	await ports.fleet.mutate((jobs) => {
		jobs.push(fleetRecord({ job_id: a }));
	});
	const second = await cpNext(ports, "demo");
	assert.equal(second.action.kind, "dispatch");
	assert.equal(second.action.job_id, b);

	// Two live workers: parallelism 2 is full, refuse a third.
	await ports.ledger.claim(b, b);
	await ports.fleet.mutate((jobs) => {
		jobs.push(fleetRecord({ job_id: b }));
	});
	const third = await cpNext(ports, "demo");
	assert.equal(third.action.kind, "wait");
	assert.match(third.action.reason, /full/);
	assert.deepEqual(
		third.ready.map((j) => j.id).sort(),
		[c],
	);
});

test("serial: a held delivery frees the working slot for the next job; a working one does not", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const a = (await ports.ledger.create({ title: "a", project: "demo", delivery: "pr", kind: "ship" })).id;
	const b = (await ports.ledger.create({ title: "b", project: "demo", delivery: "pr", kind: "ship" })).id;
	ports.mandates.issue({ projects: ["demo"], objective: "ship two", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	await ports.ledger.claim(a, a);
	const usage = { ...EMPTY_USAGE, total_tokens: 500, cost_usd: 0.25 };
	await ports.fleet.mutate((jobs) => {
		jobs.push(fleetRecord({ job_id: a, phase: "held", reported_at: isoTimestamp(), usage }));
	});
	const heldNext = await cpNext(ports, "demo");
	assert.deepEqual([heldNext.action.kind, heldNext.action.job_id], ["dispatch", b], "a PR waiting on CI is not a working worker");
	assert.equal(heldNext.mandate?.live_workers, 0);
	assert.deepEqual([heldNext.mandate?.tokens, heldNext.mandate?.spend_usd, heldNext.mandate?.jobs_used], [500, 0.25, 1], "held still counts toward spend and jobs");

	await ports.fleet.mutate((jobs) => {
		const record = jobs.find((job) => job.job_id === a) as FleetRecord;
		record.phase = "waiting";
		delete record.reported_at;
	});
	const workingNext = await cpNext(ports, "demo");
	assert.equal(workingNext.action.kind, "wait");
	assert.equal(workingNext.mandate?.live_workers, 1);
});

test("at the job cap cp_next recommends no new dispatch, and the grant stays active for the jobs it counts", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const a = (await ports.ledger.create({ title: "a", project: "demo", delivery: "pr", kind: "ship" })).id;
	await ports.ledger.create({ title: "b", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "one job", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 1 });
	await ports.ledger.claim(a, a);
	await ports.fleet.mutate((jobs) => {
		jobs.push(fleetRecord({ job_id: a, phase: "held", reported_at: isoTimestamp() }));
	});
	const next = await cpNext(ports, "demo");
	assert.deepEqual([next.mandate?.status, next.action.kind], ["active", "wait"]);
	assert.match(next.action.reason, /job cap 1 reached .* no new dispatch/);
});

test("a project-wide grant on a project with history recommends dispatch: earlier usage never fills its caps", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	for (const n of [1, 2, 3, 4]) {
		await ports.fleet.add(fleetRecord({ job_id: `cp-h${n}`, phase: "done", usage: { ...EMPTY_USAGE, total_tokens: 20_000_000, cost_usd: 200 } }));
	}
	const job = await ports.ledger.create({ title: "next", project: "demo", delivery: "pr", kind: "ship" });
	const grant = ports.mandates.issue({ projects: ["demo"], objective: "the project", expiry: later(), spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 3 }, ports.fleet.read().jobs);
	const next = await cpNext(ports, "demo");
	assert.deepEqual([next.mandate?.id, next.mandate?.status, next.action.kind, next.action.job_id], [grant.id, "active", "dispatch", job.id]);
	assert.deepEqual([next.mandate?.spend_usd, next.mandate?.tokens, next.mandate?.jobs_used], [0, 0, 0]);
});

test("mission end escalates once", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const only = await ports.ledger.create({ title: "only job", project: "demo", delivery: "pr", kind: "ship" });
	const mandate = ports.mandates.issue({
		projects: ["demo"],
		objective: "ship the one job",
		expiry: later(),
		spend_cap: { usd: 100, tokens: 1_000_000 },
		job_cap: 10,
		job_ids: [only.id],
	});
	await ports.ledger.drop(only.id, "not needed"); // a dropped job is a messy finish: it stays a question

	const first = await cpNext(ports, "demo");
	assert.equal(first.action.kind, "mission_end");
	assert.ok(first.escalation_id);

	const second = await cpNext(ports, "demo");
	assert.equal(second.action.kind, "mission_end");
	assert.equal(second.escalation_id, first.escalation_id, "the same escalation, not a second one");

	const open = ports.escalations.open();
	assert.equal(open.filter((e) => e.kind === "mission_end" && e.job_ids.includes(only.id)).length, 1);
	void mandate;
});

test("a clean named-grant finish closes itself: answered close by the grant, revoked, closed today on Map/Board, never re-asked", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const only = await ports.ledger.create({ title: "only job", project: "demo", delivery: "pr", kind: "ship" });
	const grant = ports.mandates.issue({ projects: ["demo"], objective: "ship the one job", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [only.id] });
	await ports.ledger.close(only.id, "https://example.com/pr/9");

	const first = await cpNext(ports, "demo");
	assert.equal(first.action.kind, "mission_end");
	assert.match(first.action.reason, /landed clean/);
	const record = ports.escalations.get(first.escalation_id ?? "");
	assert.deepEqual([record?.status, record?.answer, record?.answered_by], ["answered", "close", `mandate:${grant.id}`]);
	assert.equal((record?.basis as { mandate?: string } | undefined)?.mandate, grant.id, "the auto decision is journaled with its basis");
	assert.equal(ports.mandates.get(grant.id)?.status, "revoked");
	assert.equal(ports.escalations.open().length, 0, "nothing is asked");

	const display = mandateDisplay(JSON.parse(JSON.stringify(ports.mandates.get(grant.id))), JSON.parse(JSON.stringify(await ports.ledger.list({ all: true }))), JSON.parse(JSON.stringify(ports.escalations.list())), Date.now() + 1_000);
	assert.deepEqual([display.status, typeof display.closed_at], ["revoked", "string"], "Map counts it closed today (still labeled revoked); Board's lane reads it as closed");

	assert.equal((await cpNext(ports, "demo")).action.kind, "no_mandate");
	assert.equal(ports.escalations.list({ kind: "mission_end" }).length, 1, "one terminal record");
});

test("a messy named-grant finish (dropped or failed) stays one open mission end and the grant stays active", async (t) => {
	for (const messy of ["dropped", "failed"]) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const ports = bench(home);
		const only = await ports.ledger.create({ title: `${messy} job`, project: "demo", delivery: "pr", kind: "ship" });
		const grant = ports.mandates.issue({ projects: ["demo"], objective: messy, expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [only.id] });
		if (messy === "dropped") await ports.ledger.drop(only.id, "not needed");
		else {
			await ports.fleet.add(fleetRecord({ job_id: only.id, phase: "failed", failure: { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() } }));
			await ports.ledger.close(only.id, "https://example.com/pr/9");
		}

		const result = await cpNext(ports, "demo");
		assert.equal(result.action.kind, "mission_end", messy);
		assert.equal(ports.escalations.get(result.escalation_id ?? "")?.status, "open", messy);
		assert.equal(ports.mandates.get(grant.id)?.status, "active", messy);
		assert.doesNotMatch(result.action.reason, /landed clean/);
	}
});

test("two mandates on one project: each is evaluated, and each mission end is raised on its own", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const grant = (objective: string, jobIds: string[], ms: number) =>
		ports.mandates.issue({
			projects: ["demo"],
			objective,
			expiry: later(),
			spend_cap: { usd: 100, tokens: 1_000_000 },
			job_cap: 10,
			job_ids: jobIds,
			at: isoTimestamp(new Date(Date.now() - ms)),
		});
	const a = await ports.ledger.create({ title: "a", project: "demo", delivery: "pr", kind: "ship" });
	const b = await ports.ledger.create({ title: "b", project: "demo", delivery: "pr", kind: "ship" });
	const c = await ports.ledger.create({ title: "c", project: "demo", delivery: "pr", kind: "ship" });
	const first = grant("first", [a.id], 60_000);
	const second = grant("second", [b.id], 30_000);
	const third = grant("third", [c.id], 10_000);
	await ports.ledger.drop(a.id, "not needed");
	await ports.ledger.drop(b.id, "not needed");

	const result = await cpNext(ports, "demo");
	assert.deepEqual([result.mandate?.id, result.action.kind, result.action.job_id], [third.id, "dispatch", c.id], "the grant with work to dispatch leads");
	const ends = (result.others ?? []).map((other) => [other.mandate?.id, other.action.kind]);
	assert.deepEqual(ends, [[first.id, "mission_end"], [second.id, "mission_end"]]);
	const open = ports.escalations.open().filter((item) => item.kind === "mission_end");
	assert.deepEqual(open.map((item) => item.mandate_id).sort(), [first.id, second.id].sort(), "one mission end per finished grant");
	assert.deepEqual((result.others ?? []).map((other) => other.escalation_id).sort(), open.map((item) => item.id).sort());
	assert.match(formatNext(result), new RegExp(`${first.id}: every named job is closed[\\s\\S]*${second.id}: every named job is closed`));
});

test("18 waiting grants on one project: each other grant is one line, the whole answer stays within 25 lines", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	for (let i = 0; i < 18; i++) ports.mandates.issue({ projects: ["demo"], objective: `topic ${i}`, expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, at: isoTimestamp(new Date(Date.now() - 60_000 + i * 1_000)) });
	const result = await cpNext(ports, "demo");
	assert.equal(result.others?.length, 17);
	const text = formatNext(result);
	assert.ok(text.split("\n").length <= 25, text);
	const other = result.others![0]!;
	assert.match(text, new RegExp(`^${other.mandate!.id}: active 0/1, jobs 0/10 \u2014 wait: nothing ready under this mandate$`, "m"));
});

test("a re-raised mission end refreshes its cost on the same open record", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const only = await ports.ledger.create({ title: "only", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "one", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [only.id] });
	await ports.fleet.add(fleetRecord({ job_id: only.id, phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, total_tokens: 100, cost_usd: 9.23 } }));
	await ports.ledger.drop(only.id, "not needed");

	const before = await cpNext(ports, "demo");
	assert.match(ports.escalations.get(before.escalation_id ?? "")?.question ?? "", /cost \$9\.23$/);
	await ports.fleet.mutate((jobs) => {
		(jobs.find((job) => job.job_id === only.id) as FleetRecord).usage = { ...EMPTY_USAGE, total_tokens: 200, cost_usd: 9.95 };
	});
	const after = await cpNext(ports, "demo");
	assert.equal(after.escalation_id, before.escalation_id, "the stable identity holds");
	assert.equal(after.mandate?.spend_usd, 9.95);
	assert.match(ports.escalations.get(after.escalation_id ?? "")?.question ?? "", /cost \$9\.95$/, "the open record reads what the mandate reads");
	assert.equal(ports.escalations.open().length, 1);
});

for (const answer of ["close", "extend"]) {
	test(`a mission end answered ${answer} is terminal: repeated cp_next never re-asks that grant, a replacement grant asks its own`, async (t) => {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const ports = bench(home);
		const only = await ports.ledger.create({ title: "only", project: "demo", delivery: "pr", kind: "ship" });
		const grant = (objective: string) =>
			ports.mandates.issue({ projects: ["demo"], objective, expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [only.id] });
		const first = grant("one");
		await ports.ledger.drop(only.id, "not needed");
		const raised = await cpNext(ports, "demo");
		await ports.escalations.answer(raised.escalation_id ?? "", { answer, by: "operator-quote" });
		if (answer === "close") ports.mandates.revoke(first.id);

		for (let call = 0; call < 3; call += 1) {
			const again = await cpNext(ports, "demo");
			if (answer === "close") assert.equal(again.action.kind, "no_mandate", "a closed grant is revoked, never evaluated again");
			else {
				assert.deepEqual([again.action.kind, again.escalation_id], ["mission_end", raised.escalation_id]);
				assert.match(again.action.reason, /already answered "extend" .* not re-asked/);
			}
		}
		const ends = ports.escalations.list({ kind: "mission_end" });
		assert.deepEqual(ends.map((item) => [item.id, item.status]), [[raised.escalation_id, "answered"]], "one terminal record, no fresh open one");

		const replacement = grant("two");
		const fresh = await cpNext(ports, "demo");
		const own = [fresh, ...(fresh.others ?? [])].find((result) => result.mandate?.id === replacement.id);
		assert.equal(own?.action.kind, "mission_end");
		assert.notEqual(own?.escalation_id, raised.escalation_id, "a new grant has its own identity");
		assert.equal(ports.escalations.get(own?.escalation_id ?? "")?.status, "open");
	});
}

for (const state of ["active", "paused", "expired", "revoked", "uncovered"] as const) {
	test(`blocked jobs name a blocker under ${state} standing`, async (t) => {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const ports = bench(home);
		const blocker = await ports.ledger.create({ title: "base", project: "demo", delivery: "pr" });
		const dependent = await ports.ledger.create({ title: "follow-up", project: "demo", delivery: "pr" });
		await ports.ledger.addDep(dependent.id, blocker.id);
		const grant = (ids: string[], expiry = later()) => ports.mandates.issue({ projects: ["demo"], objective: "work", job_ids: ids, expiry, at: isoTimestamp(new Date(Date.now() - 60_000)), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
		const owner = grant([dependent.id]);
		if (state !== "uncovered") {
			const baseGrant = grant([blocker.id], state === "expired" ? isoTimestamp(new Date(Date.now() - 1_000)) : later());
			if (state === "paused") ports.mandates.pause(baseGrant.id);
			if (state === "revoked") ports.mandates.revoke(baseGrant.id);
		}
		const result = await cpNext(ports, "demo");
		const own = [result, ...(result.others ?? [])].find((entry) => entry.mandate?.id === owner.id)!;
		assert.equal(own.action.kind, "wait");
		assert.match(own.action.reason, new RegExp(`${dependent.id}.*${blocker.id}`));
		assert.match(own.action.reason, state === "active" ? /waiting on/ : state === "uncovered" ? /no active grant covers it/ : new RegExp(state));
		assert.deepEqual(own.ready, []);
	});
}

for (const answer of ["proceed", "drop", "reopen"] as const) {
	test(`a dropped dependency asks once per pair and ${answer} resolves through the answer store`, async (t) => {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const ports = bench(home);
		const blocker = await ports.ledger.create({ title: "base", project: "demo", delivery: "pr" });
		const dependent = await ports.ledger.create({ title: "follow-up", project: "demo", delivery: "pr" });
		await ports.ledger.addDep(dependent.id, blocker.id);
		await ports.ledger.drop(blocker.id, "no result");
		// Two covering grants must not mint two questions for the same pair.
		for (let i = 0; i < 2; i++) ports.mandates.issue({ projects: ["demo"], objective: `work ${i}`, job_ids: [dependent.id], expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
		const first = await cpNext(ports, "demo");
		assert.equal(first.action.kind, "wait");
		assert.match(formatNext(first), /closed as dropped/);
		await cpNext(ports, "demo");
		const questions = ports.escalations.open();
		assert.equal(questions.length, 1);
		const question = questions[0]!;
		assert.match(question.question, new RegExp(`${dependent.id}.*${blocker.id}.*no result`));
		assert.deepEqual(question.options.map((option) => option.id), ["proceed", "drop", "reopen"]);
		await assert.rejects(ports.escalations.answer(question.id, { answer: "maybe", by: "operator-quote" }), /proceed.*drop.*reopen/);
		await ports.escalations.answer(question.id, { answer, by: "operator-quote" });
		await ports.escalations.answer(question.id, { answer, by: "operator-quote" });
		if (answer === "proceed") {
			assert.deepEqual((await ports.ledger.show(dependent.id)).blocked_by, []);
			assert.equal((await cpNext(ports, "demo")).action.job_id, dependent.id);
		} else if (answer === "drop") {
			assert.equal((await ports.ledger.show(dependent.id)).status, "closed");
			assert.match((await ports.ledger.show(dependent.id)).close_reason ?? "", /dropped:.*no result/);
		} else {
			const reopened = await ports.ledger.show(blocker.id);
			assert.equal(reopened.status, "open");
			assert.equal(reopened.close_reason, undefined);
			assert.ok(reopened.comments.some((comment) => comment.text.includes("no result")), "reopening preserves the dropped history");
			assert.deepEqual(await ports.ledger.blockersOf(dependent.id), [blocker.id]);
		}
		await cpNext(ports, "demo");
		assert.equal(ports.escalations.list({ kind: "scope_expansion" }).length, 1);
	});
}

test("uncovered dropped dependents are named without raising a question", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const blocker = await ports.ledger.create({ title: "base", project: "demo", delivery: "pr" });
	const dependent = await ports.ledger.create({ title: "follow-up", project: "demo", delivery: "pr" });
	await ports.ledger.addDep(dependent.id, blocker.id);
	await ports.ledger.drop(blocker.id, "not doing it");
	const result = await cpNext(ports, "demo");
	assert.equal(result.action.kind, "no_mandate");
	assert.match(formatNext(result), new RegExp(`${dependent.id}.*${blocker.id}.*closed as dropped`));
	assert.deepEqual(ports.escalations.open(), []);
});

test("status block derives dependency standing without a caller-supplied blocked row", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const blocker = await ports.ledger.create({ title: "base", project: "demo", delivery: "pr" });
	const dependent = await ports.ledger.create({ title: "follow-up", project: "demo", delivery: "pr" });
	await ports.ledger.addDep(dependent.id, blocker.id);
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
	registerSendStatusTools({ registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool) } as never,
		{ commandPost: () => post, setLive: () => {}, refreshWidget: () => {} } as never);
	const result = await tools.get("cp_status_block")!.execute("c", {}, undefined, undefined, { hasUI: false, sessionManager: { getSessionId: () => "test" } });
	assert.match(result.content[0]!.text, new RegExp(`Blocked:[\\s\\S]*${dependent.id}.*${blocker.id}.*no active grant covers it`));
	assert.deepEqual(post.escalations.open(), [], "the status read never asks a question");
});

test("two dependents of one dropped blocker get one question each, including concurrent continuation reads", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const blocker = await ports.ledger.create({ title: "base", project: "demo", delivery: "pr" });
	const dependents = [];
	for (const title of ["one", "two"]) {
		const job = await ports.ledger.create({ title, project: "demo", delivery: "pr" });
		dependents.push(job.id);
		await ports.ledger.addDep(job.id, blocker.id);
	}
	await ports.ledger.drop(blocker.id, "not delivered");
	ports.mandates.issue({ projects: ["demo"], objective: "the dependents", job_ids: dependents, expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10 });
	await Promise.all([cpNext(ports, "demo"), cpNext(ports, "demo")]);
	const questions = ports.escalations.open();
	assert.deepEqual(questions.map((item) => item.job_ids[0]).sort(), dependents.sort());
	const rendered = formatNext(await cpNext(ports, "demo"));
	for (const question of questions) assert.match(rendered, new RegExp(`cp_decide ${question.id}`));
});

test("blocked output remains bounded with many jobs and blockers", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const blockers = [];
	for (let i = 0; i < 5; i++) blockers.push(await ports.ledger.create({ title: `base ${i}`, project: "demo", delivery: "pr" }));
	for (let i = 0; i < 15; i++) {
		const job = await ports.ledger.create({ title: `follow-up ${i}`, project: "demo", delivery: "pr" });
		for (const blocker of blockers) await ports.ledger.addDep(job.id, blocker.id);
	}
	const rendered = formatNext(await cpNext(ports, "demo"));
	assert.match(rendered, /\+2 more blockers/);
	assert.match(rendered, /\+5 more jobs/);
	assert.ok(rendered.length < 5000);
});

test("cp_next is forbidden to workers", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_next"));
});

test("an identical repeated cp_next answer is one line; a changed one is whole again", () => {
	const seen = new Map<string, { text: string; at: string }>();
	assert.equal(dedupeNext(seen, "", "action: wait", "t1"), "action: wait");
	assert.match(dedupeNext(seen, "", "action: wait", "t2"), /unchanged since t1/);
	assert.equal(dedupeNext(seen, "other", "action: wait", "t3"), "action: wait", "another project scope has its own last answer");
	assert.equal(dedupeNext(seen, "", "action: dispatch cp-x", "t4"), "action: dispatch cp-x");
	assert.equal(dedupeNext(seen, "", "action: wait", "t5"), "action: wait", "a change and back is news, not a repeat");
});

test("the cp_next tool: an identical second call is one line, full/compaction/rotation restore it, and a mission end prints the pending curation count", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = bench(home);
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
	const hooks = new Map<string, () => void>();
	registerMandateTools({ on: (event: string, fn: () => void) => hooks.set(event, fn), registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool) } as never, {
		commandPost: () => ({ packageRoot: REPO_ROOT, ledger: () => ports.ledger, registry: undefined, fleet: ports.fleet, mandates: ports.mandates, escalations: ports.escalations, pipelines: undefined, manager: post.manager, curationPlan: () => post.curationPlan() }),
		setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined,
	} as never);
	const call = async (params: Record<string, unknown> = { project: "demo" }) => (await tools.get("cp_next")!.execute("c", params, undefined, undefined, { hasUI: false, modelRegistry: undefined })).content[0]!.text;

	const first = await call();
	assert.match(first, /no active mandate/);
	const second = await call();
	assert.match(second, /^cp_next unchanged since \S+: nothing new/);
	assert.equal(second.split("\n").length, 1, "the repeat is one line");
	assert.equal(await call({ project: "demo", full: true }), first, "full: true is the escape after losing context");
	assert.match(await call(), /unchanged since/);
	hooks.get("session_compact")!();
	assert.equal(await call(), first, "a compaction forgets what was shown");
	assert.match(await call(), /unchanged since/);
	hooks.get("session_start")!();
	assert.equal(await call(), first, "a rotated session forgets what was shown");

	const only = await ports.ledger.create({ title: "only job", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "ship the one job", expiry: later(), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, job_ids: [only.id] });
	await ports.ledger.drop(only.id, "not needed");
	assert.match(await call(), /action: mission_end[\s\S]*\nmemory: 0 pending candidate\(s\) \u2014 cp_memory curate only when above 0$/);
});
