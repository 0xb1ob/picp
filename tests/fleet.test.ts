/**
 * T8 acceptance: the fleet store is atomic and single-writer, and reconcile
 * makes state/fleet.json match observed reality — including the headline case,
 * `kill -9` a worker, restart the parent, fleet reflects reality.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type EnvelopeRecord,
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
import { FleetError, FleetStore, isPidAlive, isResumable, type ReconcileReport, summarizeReconcile } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readFleet,
	REPO_ROOT,
	type ScratchHome,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";
import { withZombie } from "./harness/zombie.ts";
import { startRpc } from "./harness/rpc.ts";

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

const PROFILES_DIR = join(REPO_ROOT, "profiles");

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

function writeEnvelope(home: string, jobId: string): void {
	const record: EnvelopeRecord = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		received_at: isoTimestamp(),
		attempt: 1,
		envelope: { job_id: jobId, kind: "ship", status: "done", summary: "shipped it", branch: jobId },
	};
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(join(home, paths.envelopeFile(jobId)), `${JSON.stringify(record, null, 2)}\n`);
}

function withHome(t: { after(fn: () => void): void }): ScratchHome {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return home;
}

// ---------------------------------------------------------------------------
// store mechanics
// ---------------------------------------------------------------------------

test("a missing fleet.json reads as an empty fleet and is not created", (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	const fleet = store.read();
	assert.equal(fleet.jobs.length, 0);
	assert.equal(fleet.schema_version, SCHEMA_VERSION);
	assert.equal(store.exists, false, "reading must never create state");
	assert.equal(existsSync(join(home.path, LAYOUT.fleetFile)), false);
});

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

test("script reconcile intakes durable result before probing pid and never revives an unknown exit", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	const script = (jobId: string) => ({ ...makeRecord({ job_id: jobId, delivery: "local" }), executor: "script", worker: undefined, script_path: "scripts/run.sh", script_process: { pid: DEAD_PID, started_at: isoTimestamp() } }) as unknown as FleetRecord;
	await store.add(script("cp-result"));
	await store.add(script("cp-unknown"));
	const file = join(home.path, paths.scriptResultFile("cp-result"));
	mkdirSync(join(home.path, paths.runDir("cp-result")), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: "cp-result", result: { job_id: "cp-result", status: "done", exit_code: 0, signal: null, timed_out: false, reason: "success", summary: "script exited 0", artifact_path: join(home.path, paths.artifactFile("cp-result")) } }));
	const report = await store.reconcile({ isPidAlive: () => false });
	assert.deepEqual(report.needs_intake, ["cp-result"]);
	assert.equal(store.require("cp-result").phase, "waiting");
	assert.equal(store.require("cp-unknown").phase, "failed");
	assert.equal(report.revivable.length, 0);
	assert.equal(isResumable(store.require("cp-unknown")), false);
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

test("a corrupt or future-versioned fleet.json is refused, never guessed at", (t) => {
	const home = withHome(t);
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	const file = join(home.path, LAYOUT.fleetFile);

	writeFileSync(file, "{ not json");
	assert.throws(() => new FleetStore({ home: home.path }).read(), /not valid JSON/);

	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION + 1, updated_at: isoTimestamp(), jobs: [] }));
	assert.throws(() => new FleetStore({ home: home.path }).read(), /Upgrade pi-command-post/);

	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "yesterday", jobs: [] }));
	assert.throws(() => new FleetStore({ home: home.path }).read(), FleetError);
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

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

test("reconcile on a home with no fleet.json creates nothing", async (t) => {
	const home = withHome(t);
	const report = await new FleetStore({ home: home.path }).reconcile();
	assert.deepEqual(report.entries, []);
	assert.equal(report.checked, 0);
	assert.equal(existsSync(join(home.path, LAYOUT.fleetFile)), false);
	assert.equal(summarizeReconcile(report), "fleet: nothing to reconcile");
});

test("a dead worker with no envelope and no surviving session fails with a crash class", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	// No session file on disk at all: cp-8km widened `waiting` to `revivable`
	// when the session survives, so this test now pins the OTHER branch —
	// nothing to revive from — rather than repeating that case.
	await store.add(makeRecord({ job_id: "cp-dead", worker: { ...makeRecord().worker, session_file: join(home.path, "never-written.jsonl") } }));

	const report = await store.reconcile({ isPidAlive: () => false });
	assert.equal(report.changed, 1);
	const entry = report.entries[0];
	assert.equal(entry?.outcome, "failed");
	assert.equal(entry?.phase_after, "failed");
	assert.equal(entry?.pid_alive, false);
	assert.equal(entry?.resumable, false);

	const record = readFleet(home.path).jobs[0] as FleetRecord;
	assert.equal(record.phase, "failed");
	assert.equal(record.failure?.class, "crash");
	assert.match(record.failure?.message ?? "", /pid no longer exists/);
	assert.equal(record.worker.exited_at, undefined, "no close was observed, so none is stamped");
	assert.equal(isResumable(record), false);
	assert.match(summarizeReconcile(report), /cp-dead failed/);
});

test("cp-8km (option A): a waiting job with a surviving session is revivable, not failed", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	const sessionFile = join(home.path, "s.jsonl");
	await store.add(makeRecord({ job_id: "cp-crashed-early", worker: { ...makeRecord().worker, session_file: sessionFile } }));
	writeFileSync(sessionFile, "{}\n");

	const report = await store.reconcile({ isPidAlive: () => false });
	// The phase never moves (still `waiting`), so this is exactly the case
	// `report.revivable` exists for — `changed` alone would miss it.
	assert.equal(report.changed, 0);
	assert.deepEqual(report.revivable, ["cp-crashed-early"]);
	const entry = report.entries[0];
	assert.equal(entry?.outcome, "revivable");
	assert.equal(entry?.phase_after, "waiting");
	assert.equal(entry?.pid_alive, false);
	assert.equal(entry?.resumable, true);
	assert.match(entry?.detail ?? "", /before any envelope/);

	const record = readFleet(home.path).jobs[0] as FleetRecord;
	assert.equal(record.phase, "waiting", "a crash before any envelope is not thrown away — it is revivable");
	assert.equal(record.failure, undefined);
	assert.match(summarizeReconcile(report), /cp-crashed-early revivable \(resumable\)/);
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

test("a held job survives a dead worker while its session file survives", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	const sessionFile = join(home.path, "held.jsonl");
	writeFileSync(sessionFile, "{}\n");
	await store.add(
		makeRecord({
			job_id: "cp-held",
			phase: "held",
			reported_at: isoTimestamp(),
			worker: { ...makeRecord().worker, session_file: sessionFile },
		}),
	);
	await store.add(
		makeRecord({ job_id: "cp-lost", phase: "held", reported_at: isoTimestamp() }), // session_file missing
	);

	const report = await store.reconcile({ isPidAlive: () => false });
	const byId = Object.fromEntries(report.entries.map((entry) => [entry.job_id, entry]));
	assert.equal(byId["cp-held"]?.outcome, "revivable");
	assert.equal(byId["cp-held"]?.phase_after, "held");
	assert.match(byId["cp-held"]?.detail ?? "", /revive with --session/);
	assert.equal(byId["cp-lost"]?.outcome, "failed");

	const jobs = Object.fromEntries(readFleet(home.path).jobs.map((job) => [job.job_id, job]));
	assert.equal(jobs["cp-held"]?.phase, "held", "the envelope is in; the hold is not lost with the process");
	assert.equal(jobs["cp-lost"]?.phase, "failed");
	assert.match(jobs["cp-lost"]?.failure?.message ?? "", /cannot be revived/);
});

test("an envelope on disk is never overwritten with a failure: intake owns it", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-rep" }));
	writeEnvelope(home.path, "cp-rep");

	const report = await store.reconcile({ isPidAlive: () => false });
	assert.equal(report.entries[0]?.outcome, "reported");
	assert.deepEqual(report.needs_intake, ["cp-rep"]);
	assert.equal(report.changed, 0);
	assert.equal(readFleet(home.path).jobs[0]?.phase, "waiting");
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

test("reconcile is idempotent: terminal records are not re-litigated", async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-a" }));
	const first = await store.reconcile({ isPidAlive: () => false });
	const afterFirst = readFleet(home.path).jobs[0];

	const second = await store.reconcile({ isPidAlive: () => false });
	assert.equal(first.changed, 1);
	assert.equal(second.changed, 0);
	assert.equal(second.entries[0]?.outcome, "terminal");
	assert.deepEqual(readFleet(home.path).jobs[0], afterFirst);
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

test("the parent extension reconciles at session_start", { timeout: 60_000 }, async (t) => {
	const home = withHome(t);
	const store = new FleetStore({ home: home.path });
	await store.add(makeRecord({ job_id: "cp-startup" }));

	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
	});

	const notify = await rpc.waitFor(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			typeof record.message === "string" &&
			record.message.startsWith("fleet:"),
	);
	assert.match(String(notify.message), /cp-startup failed/);

	const record = await waitFor(
		() => readFleet(home.path).jobs[0] as FleetRecord,
		(job) => job.phase === "failed",
		{ what: "reconciled phase on disk" },
	);
	assert.equal(record.failure?.class, "crash");
});

// ---------------------------------------------------------------------------
// acceptance: kill -9 a worker, restart the parent, fleet reflects reality
// ---------------------------------------------------------------------------

test("kill -9 a worker, restart the parent, fleet reflects reality", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-kill9";
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "kill9", files: { "README.md": "# kill9\n" } });
	const home = createScratchHome();
	const agentDir = createAgentDir({ provider });
	const model = provider.addScript("kill9", [{ kind: "text", text: "ready" }]);
	agentDir.writeModels(provider);

	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const runDir = join(home.path, paths.runDir(jobId));
	mkdirSync(runDir, { recursive: true });
	const profile = loadProfile(PROFILES_DIR, "implementer");
	const managed = manager.spawn({
		identity: { jobId, kind: "ship", delivery: "pr", runDir, worktree: repo.path },
		profile,
		model,
		sessionDir: join(home.path, "sessions"),
	});

	t.after(async () => {
		await manager.shutdownAll();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	// One real turn, so the session file exists on disk (the hold's context).
	await managed.worker.send("say ready");
	await managed.worker.waitForSettled(60_000);
	const state = await managed.worker.getState(30_000);
	const sessionFile = state.sessionFile as string;
	const pid = managed.worker.pid as number;
	await waitFor(() => existsSync(sessionFile), (ok) => ok, { what: "worker session file" });

	// The parent dispatched this job and recorded it.
	const store = new FleetStore({ home: home.path });
	await store.add(
		makeRecord({
			job_id: jobId,
			project: "kill9",
			worktree: repo.path,
			branch: jobId,
			worker: {
				pid,
				session_id: (state.sessionId as string | undefined) ?? "unknown",
				session_file: sessionFile,
				profile: profile.frontmatter.name,
				role: profile.frontmatter.role,
				model,
				started_at: isoTimestamp(),
			},
		}),
	);

	// kill -9: no graceful shutdown, no envelope, no status.json — exactly what
	// a parent finds after it comes back from the dead itself.
	const exit = await managed.worker.kill("SIGKILL");
	assert.equal(exit.signal, "SIGKILL");
	assert.equal(existsSync(join(runDir, "status.json")), false, "no projection: nobody was watching");
	assert.equal(isPidAlive(pid), false, "the pid is really gone");

	// Restart the parent: a brand new process reads fleet.json and reconciles.
	const script = join(home.path, "restart-parent.mjs");
	writeFileSync(
		script,
		[
			`import { FleetStore } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src/fleet.ts")).href)};`,
			`const store = new FleetStore({ home: ${JSON.stringify(home.path)} });`,
			"const report = await store.reconcile();",
			"process.stdout.write(JSON.stringify(report));",
		].join("\n"),
	);
	const stdout = execFileSync(process.execPath, [script], { encoding: "utf8" });
	const report = JSON.parse(stdout) as ReconcileReport;

	assert.equal(report.checked, 1);
	// cp-8km (option A): the job never filed an envelope (phase stays `waiting`),
	// but its session survived the kill — exactly the incident this closes:
	// a mid-rebase ship job crashed before reporting must be revivable, not
	// thrown away as an unrecoverable crash.
	assert.equal(report.changed, 0);
	assert.deepEqual(report.revivable, [jobId]);
	const entry = report.entries[0];
	assert.equal(entry?.job_id, jobId);
	assert.equal(entry?.outcome, "revivable");
	assert.equal(entry?.phase_after, "waiting");
	assert.equal(entry?.pid_alive, false);
	assert.equal(entry?.session_file_present, true);
	assert.equal(entry?.resumable, true, "the session survived the kill, so the work can be resumed");

	const record = readFleet(home.path).jobs[0] as FleetRecord;
	assert.equal(record.phase, "waiting");
	assert.equal(record.failure, undefined, "a revivable job is not a failure");
	assert.equal(record.worker.exited_at, undefined, "the restarted parent observed no close, so it stamps none");
	assert.equal(isResumable(record), true);
});
