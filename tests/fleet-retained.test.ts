/**
 * P23: the declarations of tests/fleet.test.ts kept verbatim (V2): FleetStore's own API, the fleet schema, the `owned`
 * reconcile option no caller passes, and isPidAlive. tests/e2e/memory.test.ts (P23-fleet-reconcile) holds the rest.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Failure,
	type FleetRecord,
	isoTimestamp,
	LAYOUT,
	paths,
	type RunStatus,
	SCHEMA_VERSION,
	validateFleetFile,
	isScriptFleetRecord,
} from "../src/contracts.ts";
import { FleetStore, isPidAlive, isResumable } from "../src/fleet.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { createScratchHome, readFleet, type ScratchHome } from "./harness/index.ts";
import { withZombie } from "./harness/zombie.ts";

/**
 * A pid that existed and has been reaped. Cheaper than guessing a large number
 * and, unlike a guess, actually true on every platform.
 */
function reapedPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	if (!result.pid || result.pid <= 0) throw new Error("could not obtain a reaped pid for the fixture");
	return result.pid;
}

const DEAD_PID = reapedPid();

function makeRecord(overrides: Partial<FleetRecord> = {}): FleetRecord {
	const jobId = overrides.job_id ?? "cp-job";
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: DEAD_PID,
			session_id: "sess-1",
			session_file: "/nonexistent/sess-1.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "mock/mock-model",
			started_at: isoTimestamp(),
		},
		worktree: "/tmp/worktrees/demo",
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

function writeRunStatus(home: string, jobId: string, patch: Partial<RunStatus>): void {
	const status: RunStatus = { ...initialStatus(jobId, { pid: 4242 }), ...patch };
	const file = join(home, paths.statusFile(jobId));
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`);
}

function withHome(t: { after(fn: () => void): void }): ScratchHome {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return home;
}

test("fleet accepts legacy model records and requires exactly one executor handle", () => {
	const model = makeRecord();
	const script = { ...model, delivery: "local", executor: "script", script_path: "scripts/run.sh",
		script_process: { pid: 42, started_at: isoTimestamp() }, worker: undefined };
	const file = (job: unknown) => ({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs: [job] });
	assert.equal(validateFleetFile(file(model)).ok, true);
	assert.equal(validateFleetFile(file({ ...model, executor: "model" })).ok, true);
	assert.equal(validateFleetFile(file(script)).ok, true);
	assert.equal(validateFleetFile(file({ ...script, phase: "launching", script_process: undefined })).ok, true);
	assert.equal(validateFleetFile(file({ ...script, phase: "waiting", script_process: undefined })).ok, false);
	const observed = { exited_at: isoTimestamp(), exit_code: null, signal: null };
	assert.equal(validateFleetFile(file({ ...script, phase: "failed", script_process: undefined, script_observed_exit: observed, reported_at: isoTimestamp(), failure: { class: "spawn_failed", message: "spawn_error", at: isoTimestamp() } })).ok, true);
	assert.equal(validateFleetFile(file({ ...script, phase: "held", script_process: undefined, script_observed_exit: { ...observed, exit_code: 0 }, reported_at: isoTimestamp() })).ok, true);
	assert.equal(validateFleetFile(file({ ...script, phase: "launching", script_process: undefined, script_observed_exit: observed })).ok, false);
	assert.equal(validateFleetFile(file({ ...script, phase: "failed", script_process: undefined, script_observed_exit: observed, failure: { class: "crash", message: "unknown", at: isoTimestamp() } })).ok, false);
	assert.equal(validateFleetFile(file({ ...script, script_observed_exit: observed })).ok, false);
	assert.equal(validateFleetFile(file({ ...model, phase: "launching" })).ok, false);
	assert.equal(isScriptFleetRecord(script), true);
	assert.equal(isScriptFleetRecord(model), false);
	for (const invalid of [
		{ ...script, worker: model.worker }, { ...script, script_process: undefined },
		{ ...model, worker: undefined }, { ...model, script_process: script.script_process },
		{ ...model, executor: "unknown" }, { ...script, delivery: "pr" },
	]) assert.equal(validateFleetFile(file(invalid)).ok, false, JSON.stringify(invalid));
});

test("schedlater S3: a fleet record's schedule_id is a schedule id or absent", () => {
	const file = (job: unknown) => ({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs: [job] });
	assert.equal(validateFleetFile(file(makeRecord({ schedule_id: "sch-abc123" }))).ok, true);
	assert.equal(validateFleetFile(file(makeRecord())).ok, true);
	for (const bad of ["sch-XYZ", "sch-abc12", "abc123", ""]) assert.equal(validateFleetFile(file(makeRecord({ schedule_id: bad }))).ok, false, bad);
});

test("picp-d0p: bound_pr is {number,url,base} or absent, with no extra keys", () => {
	const file = (job: unknown) => ({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs: [job] });
	const bound = { number: 169, url: "https://github.com/o/r/pull/169", base: "main" };
	assert.equal(validateFleetFile(file(makeRecord({ branch: "cp-b55w", bound_pr: bound }))).ok, true);
	assert.equal(validateFleetFile(file(makeRecord({ bound_pr: { ...bound, extra: 1 } as typeof bound }))).ok, false);
	assert.equal(validateFleetFile(file(makeRecord({ bound_pr: { ...bound, number: 0 } }))).ok, false);
});

test("add is atomic, validated and leaves no temp files", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-a" }));

	const fleet = readFleet(home.path);
	assert.deepEqual(
		fleet.jobs.map((job) => job.job_id),
		["cp-a"],
	);
	assert.ok(fleet.updated_at.endsWith("Z"));
	const files = readdirSync(join(home.path, LAYOUT.state));
	assert.deepEqual(files, ["fleet.json"], `temp file left behind: ${files.join(", ")}`);
	assert.ok(readFileSync(join(home.path, LAYOUT.fleetFile), "utf8").endsWith("\n"));

	await assert.rejects(() => store.add(makeRecord({ job_id: "cp-a" })), /already has a record for cp-a/);
});

test("patch merges defined keys; unknown ids are refused", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-a" }));

	const reported = isoTimestamp();
	const patched = await store.patch("cp-a", { phase: "held", reported_at: reported, job_id: "cp-hijack" });
	assert.equal(patched.phase, "held");
	assert.equal(patched.reported_at, reported);
	assert.equal(patched.job_id, "cp-a", "the key is not patchable");
	assert.equal(patched.project, "demo", "untouched fields survive");

	await assert.rejects(() => store.patch("cp-missing", { phase: "done" }), /no fleet record for cp-missing/);
});

test("an invalid mutation is refused and the file on disk is untouched", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-a" }));
	const before = readFileSync(join(home.path, LAYOUT.fleetFile), "utf8");

	// held without reported_at, and failed without a failure: both fail closed.
	await assert.rejects(() => store.patch("cp-a", { phase: "held" }), /requires reported_at/);
	await assert.rejects(() => store.patch("cp-a", { phase: "failed" }), /requires a failure/);
	await assert.rejects(
		() => store.mutate((jobs) => [...jobs, makeRecord({ job_id: "cp-a" })]),
		/duplicate job_id/,
	);

	assert.equal(readFileSync(join(home.path, LAYOUT.fleetFile), "utf8"), before);
});

test("concurrent mutations serialize: no lost updates", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	const ids = ["cp-1", "cp-2", "cp-3", "cp-4", "cp-5"];
	await Promise.all(ids.map((jobId) => store.add(makeRecord({ job_id: jobId }))));

	const fleet = readFleet(home.path);
	assert.deepEqual(fleet.jobs.map((job) => job.job_id).sort(), [...ids].sort());
});

test("list filters on the axes the parent actually queries", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-a", project: "alpha", kind: "ship", delivery: "pr" }));
	await store.add(makeRecord({ job_id: "cp-b", project: "beta", kind: "research", delivery: "pipeline" }));
	await store.add(makeRecord({ job_id: "cp-c", project: "alpha", kind: "ship", delivery: "local" }));

	assert.equal(store.list({ project: "alpha" }).length, 2);
	assert.equal(store.list({ kind: "research" }).length, 1);
	assert.equal(store.list({ delivery: "local" })[0]?.job_id, "cp-c");
	assert.equal(store.list({ phase: ["waiting", "held"] }).length, 3);
	assert.equal(store.list({ phase: "done" }).length, 0);
	assert.equal(store.require("cp-b").project, "beta");
	assert.throws(() => store.require("cp-zzz"), /no fleet record/);
});

test("remove drops a record", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-a" }));
	await store.remove("cp-a");
	assert.equal(store.read().jobs.length, 0);
	await assert.rejects(() => store.remove("cp-a"), /no fleet record/);
});

test("a live worker is untouched: owned is `live`, unowned is `orphan`", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-mine" }));
	await store.add(makeRecord({ job_id: "cp-orphan" }));

	const report = await store.reconcile({ owned: ["cp-mine"], isPidAlive: () => true });
	assert.equal(report.changed, 0);
	const outcomes = Object.fromEntries(report.entries.map((entry) => [entry.job_id, entry.outcome]));
	assert.deepEqual(outcomes, { "cp-mine": "live", "cp-orphan": "orphan" });
	assert.match(report.entries.find((entry) => entry.job_id === "cp-orphan")?.detail ?? "", /unreachable from this session/);
	for (const job of readFleet(home.path).jobs) {
		assert.equal(job.phase, "waiting", "a live pid is a fact; nothing is failed on suspicion");
	}
});

test("an observed close and a classified failure from status.json are believed", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-obs" }));
	await store.add(makeRecord({ job_id: "cp-budget" }));

	writeRunStatus(home.path, "cp-obs", { phase: "exited", exited_at: "2026-01-01T00:00:05Z", exit_code: 137 });
	const budgetFailure: Failure = {
		class: "budget_exceeded",
		message: "per-job token budget breached at 410000 tokens",
		at: "2026-01-01T00:00:09Z",
	};
	writeRunStatus(home.path, "cp-budget", { phase: "idle", failure: budgetFailure });

	// The pid probe would say "alive" and this session claims both jobs; an
	// observed close outranks a live pid and ownership alike.
	const report = await store.reconcile({ owned: ["cp-obs", "cp-budget"], isPidAlive: () => true });
	const byId = Object.fromEntries(report.entries.map((entry) => [entry.job_id, entry]));
	assert.equal(byId["cp-obs"]?.outcome, "failed");
	assert.equal(byId["cp-budget"]?.outcome, "live", "an idle run with a live pid is still live");

	const obs = readFleet(home.path).jobs.find((job) => job.job_id === "cp-obs") as FleetRecord;
	assert.equal(obs.worker.exited_at, "2026-01-01T00:00:05Z");
	assert.equal(obs.worker.exit_code, 137);
	assert.equal(obs.failure?.class, "crash");

	// Same status, but the pid is gone: the recorded class is kept, not flattened.
	const second = await new FleetStore({ home: home.path }).reconcile({ isPidAlive: () => false });
	const budget = readFleet(home.path).jobs.find((job) => job.job_id === "cp-budget") as FleetRecord;
	assert.equal(budget.phase, "failed");
	assert.equal(budget.failure?.class, "budget_exceeded", "the previous parent's classification wins over a guess");
	assert.equal(second.entries.find((entry) => entry.job_id === "cp-obs")?.outcome, "terminal");
	assert.equal(isResumable(budget), false, "budget_exceeded is not recoverable");
});

test("isPidAlive answers about this process, a reaped child and a pid that cannot exist", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(DEAD_PID), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(-1), false);
});

test("isPidAlive: an exited but unreaped (zombie) process is not alive", async (t) => {
	await withZombie(t, (zombie, holder) => {
		assert.equal(isPidAlive(zombie), false);
		assert.equal(isPidAlive(holder), true);
	});
});
