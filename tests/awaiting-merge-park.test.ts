/** PR2 of awaiting_merge: the park and resume primitives — resource order, crash stages, refusals and rollback. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingMergeResume, type ParkFacts, Parking, readParkIntent, ResumeError } from "../src/awaiting-merge.ts";
import { EMPTY_USAGE, type FleetRecord, paths } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { readEventLog } from "../src/run-artifacts.ts";
import { decideOccupancy } from "../src/preflight.ts";
import { RunRegistry } from "../src/runs.ts";
import { Teardown } from "../src/teardown.ts";
import type { GateOutcome } from "../src/teardown.ts";
import { HeldRelease } from "../src/held-release.ts";
import { Sender } from "../src/send.ts";
import { createScratchHome, type FakeWorker, fakeWorkerManager } from "./harness/index.ts";

const HEAD = "a".repeat(40);
const FACTS: ParkFacts = { pr_url: "https://github.com/o/r/pull/7", repo: "o/r", head_sha: HEAD, base: "main", handed_at: "2026-10-15T10:00:00Z" };

function held(overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: "cp-park", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "held",
		worker: { pid: 4242, session_id: "s", session_file: "/nonexistent/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: "2026-10-15T09:00:00Z" },
		worktree: "/wt/cp-park", branch: "cp-park", dispatched_at: "2026-10-15T09:00:00Z", reported_at: "2026-10-15T10:00:00Z",
		usage: EMPTY_USAGE, lease_id: "lease-1", checkpoint_ref: "refs/cp-checkpoints/cp-park", ...overrides,
	};
}

async function bench(t: { after(fn: () => void): void }, record = held()) {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record);
	const calls: string[] = [];
	const state = { gates: [{ ok: true, reason: "pushed" }] as GateOutcome[], head: HEAD, releaseOk: true, live: true };
	const parking = new Parking({
		home: home.path, fleet, runs, now: () => new Date("2026-10-15T10:30:00Z"),
		manager: {
			get: () => (state.live ? ({ worker: { alive: true } } as never) : undefined),
			shutdown: async () => {
				calls.push("shutdown");
				state.live = false;
			},
		},
		leases: {
			release: async (lease) => {
				calls.push(`release ${lease.path} ${lease.lease_id}`);
				return state.releaseOk ? { ok: true } : { ok: false, error: "treehouse down" };
			},
		},
		gates: async () => {
			calls.push("gates");
			return state.gates.length > 1 ? state.gates.shift()! : state.gates[0]!;
		},
		git: async (_cwd, args) => {
			calls.push(`git ${args.join(" ")}`);
			return { status: 0, stdout: args[0] === "rev-parse" ? `${state.head}\n` : "", stderr: "" };
		},
	});
	const events = (type: string) => readEventLog(home.path, record.job_id).filter((event) => event.source === "cp" && event.type === type);
	return { home: home.path, fleet, runs, calls, state, parking, events };
}

test("park closes the worker, rechecks, drops the checkpoint, returns the lease by id, then commits the parked record", async (t) => {
	const b = await bench(t);
	const result = await b.parking.park("cp-park", FACTS);
	assert.equal(result.parked, true);
	assert.deepEqual(b.calls, [
		"gates", "git rev-parse HEAD", "shutdown", "gates", "git rev-parse HEAD", "git update-ref -d refs/cp-checkpoints/cp-park", "release /wt/cp-park lease-1",
	]);
	const record = b.fleet.require("cp-park");
	assert.equal(record.phase, "awaiting_merge");
	assert.equal(record.lease_id, undefined);
	assert.equal(record.checkpoint_ref, undefined);
	assert.equal(record.awaiting_merge?.cycle, 1);
	assert.equal(record.awaiting_merge?.frozen_seconds, 5400, "dispatch 09:00 to release 10:30");
	assert.equal(readParkIntent(b.home, "cp-park"), undefined);
	assert.equal(b.events("awaiting_merge_parked").length, 1);
	assert.equal((await b.parking.park("cp-park", FACTS)).parked, true, "idempotent on an already parked job");
	assert.equal(b.calls.length, 7, "the repeat touched nothing");
});

test("a gate or head refusal keeps the job held with its lease and leaves a restorable released worker", async (t) => {
	const b = await bench(t);
	b.state.gates = [{ ok: true, reason: "pushed" }, { ok: false, failure: { code: "dirty", message: "dirty", fix: "commit" } }];
	const result = await b.parking.park("cp-park", FACTS);
	assert.equal(result.parked, false);
	assert.equal(!result.parked && result.failure.code, "gate_refused");
	const record = b.fleet.require("cp-park");
	assert.equal(record.phase, "held");
	assert.equal(record.lease_id, "lease-1");
	assert.equal(b.calls.some((call) => call.startsWith("release")), false);
	assert.equal(b.events("held_released").length, 1, "cp_send restores the closed worker");
	assert.equal(readParkIntent(b.home, "cp-park"), undefined);

	const moved = await bench(t);
	moved.state.head = "b".repeat(40);
	const refused = await moved.parking.park("cp-park", FACTS);
	assert.equal(!refused.parked && refused.failure.code, "head_mismatch");
	assert.equal(moved.calls.includes("shutdown"), false, "a moved head never closes the worker");

	const local = await bench(t, held({ delivery: "local" }));
	const notPr = await local.parking.park("cp-park", FACTS);
	assert.equal(!notPr.parked && notPr.failure.code, "not_parkable");
	assert.deepEqual(local.calls, []);
});

test("a failed lease return stops at worker_closed; recovery resumes there without touching the worktree", async (t) => {
	const b = await bench(t);
	b.state.releaseOk = false;
	const first = await b.parking.park("cp-park", FACTS);
	assert.equal(!first.parked && first.failure.code, "lease_return_failed");
	assert.equal(readParkIntent(b.home, "cp-park")?.stage, "worker_closed");
	assert.equal(b.fleet.require("cp-park").phase, "held");

	b.state.releaseOk = true;
	b.calls.length = 0;
	const [recovered] = await b.parking.recover();
	assert.equal(recovered?.parked, true);
	assert.deepEqual(b.calls, ["release /wt/cp-park lease-1"], "no gate, git or worker call on a possibly recycled path");
	assert.equal(b.fleet.require("cp-park").phase, "awaiting_merge");
});

test("teardown refuses a parked job before any git or lease call, even forced", async (t) => {
	const b = await bench(t);
	await b.parking.park("cp-park", FACTS);
	const teardown = new Teardown({
		home: b.home, fleet: b.fleet, runs: b.runs,
		leases: { release: async () => assert.fail("a parked job's lease is not its own") } as never,
		manager: { get: () => undefined } as never,
	});
	const result = await teardown.teardown("cp-park", { force: true } as never);
	assert.equal(result.torn_down, false);
	assert.equal(result.failure?.code, "job_parked");
});

test("a parked job is never re-dispatched under its own id, and is no occupancy for others", async (t) => {
	const b = await bench(t);
	await b.parking.park("cp-park", FACTS);
	const jobs = b.fleet.list();
	const own = decideOccupancy(jobs, { jobId: "cp-park", project: "demo" });
	assert.equal(own.kind, "refuse");
	assert.match(own.kind === "refuse" ? own.fix : "", /cp_send cp-park resumes/);
	assert.equal(decideOccupancy(jobs, { jobId: "cp-other", project: "demo" }).kind, "clear");
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
}

async function resumeBench(t: { after(fn: () => void): void }) {
	const b = await bench(t);
	await b.parking.park("cp-park", FACTS);
	const root = join(b.home, "git");
	mkdirSync(join(root, "seed"), { recursive: true });
	git(root, "init", "--quiet", "--bare", "origin.git");
	const seed = join(root, "seed");
	git(seed, "init", "--quiet");
	git(seed, "commit", "--quiet", "--allow-empty", "-m", "base");
	git(seed, "remote", "add", "origin", join(root, "origin.git"));
	git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
	git(seed, "commit", "--quiet", "--allow-empty", "-m", "team fixup");
	git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/cp-park");
	const tip = git(seed, "rev-parse", "HEAD");
	git(root, "clone", "--quiet", join(root, "origin.git"), "lease");
	const session = join(b.home, "s.jsonl");
	writeFileSync(session, "{}\n");
	await b.fleet.mutate((jobs) => {
		jobs[0]!.worker.session_file = session;
	});
	const lease = { path: join(root, "lease"), lease_id: "lease-2", clone: seed };
	const leaseCalls: string[] = [];
	const spawn = { fail: false, seen: undefined as FleetRecord | undefined };
	const resume = new AwaitingMergeResume({
		fleet: b.fleet, runs: b.runs, clone: () => seed,
		leases: {
			acquire: async () => {
				leaseCalls.push("acquire");
				return lease;
			},
			release: async (returned) => {
				leaseCalls.push(`release ${returned.lease_id}`);
				return { ok: true };
			},
		},
		revive: async (jobId) => {
			spawn.seen = structuredClone(b.fleet.require(jobId));
			if (spawn.fail) throw new Error("spawn refused");
		},
	});
	return { ...b, resume, lease, leaseCalls, spawn, tip };
}

test("resume leases fresh, checks out the remote tip, and revives the same session as held", async (t) => {
	const b = await resumeBench(t);
	const result = await b.resume.resume("cp-park");
	assert.equal(result.worktree, b.lease.path);
	assert.equal(result.head_sha, b.tip);
	assert.match(result.note, /no longer yours/);
	assert.equal(b.spawn.seen?.phase, "held", "revive sees the held record on the new lease");
	assert.equal(b.spawn.seen?.worktree, b.lease.path);
	const record = b.fleet.require("cp-park");
	assert.equal(record.lease_id, "lease-2");
	assert.equal(record.awaiting_merge, undefined);
	assert.equal(git(b.lease.path, "rev-parse", "--abbrev-ref", "HEAD"), "cp-park");
	assert.equal(b.events("awaiting_merge_resumed").length, 1);
	assert.deepEqual(b.leaseCalls, ["acquire"]);
});

test("a refused spawn restores the parked record exactly and returns the new lease", async (t) => {
	const b = await resumeBench(t);
	const before = structuredClone(b.fleet.require("cp-park"));
	b.spawn.fail = true;
	await assert.rejects(b.resume.resume("cp-park"), (error: unknown) => error instanceof ResumeError && error.code === "spawn_failed");
	assert.deepEqual(b.fleet.require("cp-park"), before);
	assert.deepEqual(b.leaseCalls, ["acquire", "release lease-2"]);

	await b.fleet.mutate((jobs) => {
		jobs[0]!.worker.session_file = "/nonexistent/gone.jsonl";
	});
	b.leaseCalls.length = 0;
	await assert.rejects(b.resume.resume("cp-park"), (error: unknown) => error instanceof ResumeError && error.code === "session_missing");
	assert.deepEqual(b.leaseCalls, [], "no lease is taken for a session that cannot resume");
	assert.equal(existsSync(join(b.home, paths.parkIntentFile("cp-park"))), false);
});

// cp_send is the resume path: the parked job leaves awaiting_merge for held on the new lease, the revived worker gets the
// note-led message, and HeldRelease's "released" restore never fires a second revive (worker_revived follows the park's
// held_released). Regression: Sender kept the pre-resume record and could restore the resumed worker as released.
test("cp_send on a parked job resumes its worker on a fresh lease and the job leaves awaiting_merge", async (t) => {
	const b = await resumeBench(t);
	const workers = fakeWorkerManager(b.home, 3);
	t.after(() => workers.manager.shutdownAll());
	let revived: FakeWorker | undefined;
	const resume = new AwaitingMergeResume({
		fleet: b.fleet, runs: b.runs, clone: () => b.lease.clone, leases: { acquire: async () => b.lease, release: async () => ({ ok: true }) },
		revive: async (jobId) => {
			revived = workers.spawn(jobId);
			b.runs.open(jobId).cp("worker_revived", { pid: revived.pid });
		},
	});
	const heldRelease = new HeldRelease({ home: b.home } as never);
	const sender = new Sender({
		fleet: b.fleet, manager: workers.manager, runs: b.runs, home: b.home, resume: (id) => resume.resume(id),
		released: (id) => heldRelease.wasReleased(id), revive: async () => assert.fail("a resumed worker is never restored as released"),
	});
	const result = await sender.send({ jobId: "cp-park", message: "address the team's review" });
	assert.equal(result.receipt, "delivered");
	assert.equal(heldRelease.wasReleased("cp-park"), false);
	assert.match(revived?.sent[0] ?? "", /^\[resumed from awaiting_merge\][^]*\n\naddress the team's review/);
	const record = b.fleet.require("cp-park");
	assert.notEqual(record.phase, "awaiting_merge");
	assert.equal(record.awaiting_merge, undefined);
	assert.equal(record.worktree, b.lease.path);
	assert.equal(record.lease_id, "lease-2");
});
