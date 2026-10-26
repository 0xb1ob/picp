/** Retained from awaiting_merge PR2: park and resume crash stages and rollback (P18b; the rest is e2e P18-parked). */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingMergeResume, type ParkFacts, Parking, readParkIntent, ResumeError } from "../src/awaiting-merge.ts";
import { EMPTY_USAGE, type FleetRecord, paths } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { readEventLog } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import type { GateOutcome } from "../src/teardown.ts";
import { createScratchHome } from "./harness/index.ts";

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
