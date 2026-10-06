import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { CommandPost } from "../src/command-post.ts";
import { createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, REPO_ROOT, treehouseAvailable, waitFor } from "./harness/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, FailureClassSchema, isoTimestamp, LAYOUT, paths, validate, type FleetRecord } from "../src/contracts.ts";
import { runScript, resolveScriptFile } from "../src/script-runner.ts";
import { ScriptDispatcher } from "../src/script-dispatch.ts";
import type { IntakeResult } from "../src/intake.ts";
import { ScheduleRunner } from "../src/schedule-runner.ts";
import { type Schedule, Scheduler } from "../src/scheduler.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";

test("script dispatch leases a branch, intakes once, and cannot replay", { skip: treehouseAvailable() ? false : "treehouse required", timeout: 60_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "pwd\nexit 7\n" } });
 const received: string[] = [];
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, onReported: (result) => received.push(result.job_id) });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const ledger = post.ledger();
 const fleet = post.fleet;
 const job = await ledger.create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 const preview = await post.previewDispatch({ jobId: job.id });
 assert.equal("executor" in preview && preview.executor, "script");
 assert.equal(fleet.get(job.id), undefined);
 await assert.rejects(post.dispatch({ jobId: job.id, task: "ignored" }), /task is not accepted/);
 const result = await post.dispatch({ jobId: job.id });
 assert.equal("executor" in result && result.executor, "script");
 assert.equal(result.branch, job.id);
 assert.equal(fleet.require(job.id).worker, undefined);
 assert.equal(fleet.require(job.id).schedule_id, undefined, "schedlater S3: an unscheduled record carries no schedule_id");
 await waitFor(() => fleet.require(job.id).phase, (phase) => phase === "failed", { timeoutMs: 10_000 });
 assert.equal(fleet.require(job.id).failure?.class, "script_exit");
 assert.equal(received.length, 1);
 assert.equal((await post.intake.intake(job.id)).already, true);
 assert.equal(received.length, 1);
 assert.equal((await post.revivePlan(job.id)).ok, false);
 await assert.rejects(post.send({ jobId: job.id, message: "again" }), /cannot promote or replay/);
 await assert.rejects(post.dispatch({ jobId: job.id }), /cannot be replayed|already has a fleet record/);
 writeFileSync(join(result.worktree, "dirty"), "keep this lease\n");
 const refused = await post.tearDown(job.id);
 assert.equal(refused.failure?.code, "dirty");
 unlinkSync(join(result.worktree, "dirty"));
 const closed = await post.tearDown(job.id);
 assert.equal(closed.torn_down, true);
 assert.equal(fleet.require(job.id).phase, "done");
});

test("schedlater S1: a script_path schedule runs with no model; a refused teardown wakes the parent, live and after a restart, until the runner tears it down", { skip: treehouseAvailable() ? false : "treehouse required", timeout: 60_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 const reported: IntakeResult[] = [];
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, onReported: (result) => reported.push(result) });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const job = await post.ledger().create({ title: "nightly", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh", labels: ["schedule:sch-abc123"] });
 const schedule = { id: "sch-abc123", name: "nightly", project: "demo", mandate_id: "md-abcd", trigger: { type: "cron", cron: "0 3 * * *", tz: "UTC" }, job: { title: "nightly", kind: "ship", delivery: "local", script_path: "scripts/run.sh" }, enabled: true, created_at: isoTimestamp() } as Schedule;
 const wakes: IntakeResult[] = [];
 const runnerFor = () => new ScheduleRunner({
  dispatch: (request) => post.dispatch(request), tearDown: (id) => post.tearDown(id), recorded: (id) => post.intake.intake(id), wake: (result) => wakes.push(result),
  ledger: () => post.ledger(), fleetJobs: () => post.fleet.read().jobs, schedules: () => [schedule], now: () => new Date(), log: () => {},
 });
 const runner = runnerFor();
 await runner.onFired({ schedule_id: schedule.id, job_id: job.id });
 const record = post.fleet.require(job.id);
 assert.equal(record.executor, "script");
 assert.equal(record.worker, undefined, "no model is spawned for a static schedule");
 assert.equal(record.schedule_id, "sch-abc123", "schedlater S3: the script record carries its schedule");
 await waitFor(() => reported.length, (count) => count === 1, { timeoutMs: 10_000 });
 assert.equal(runner.claims(reported[0]!), true);
 // The real teardown gate refuses a dirty lease: the parent gets the real envelope wake.
 writeFileSync(join(record.worktree, "dirty"), "keep this lease\n");
 assert.equal(await runner.onReported(reported[0]!), false);
 assert.deepEqual(wakes.map((w) => [w.job_id, w.next]), [[job.id, "teardown"]]);
 // A restart with the lease still dirty: the sweep reads the recorded outcome and wakes again, never silent.
 await runnerFor().sweepReported();
 assert.deepEqual(wakes.map((w) => [w.job_id, w.already]), [[job.id, false], [job.id, true]]);
 assert.equal(reported.length, 1, "the recorded read is idempotent: no second onReported");
 // Cleaned up, the next restart's sweep tears it down with no wake.
 unlinkSync(join(record.worktree, "dirty"));
 await runnerFor().sweepReported();
 assert.equal(post.fleet.require(job.id).phase, "done");
 assert.equal(wakes.length, 2);
});

test("schedlater S1: a runner fire over the job cap is refused by the real dispatch gate, noted, never woken, and dropped at the next slot", async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 t.after(() => { home.cleanup(); repo.cleanup(); });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 // The ledger stamps created_at with the real clock, so the schedule clock is anchored to it.
 const real = Date.now();
 const clock = { now: new Date(real - 90_000) };
 const mandate = post.mandates.issue({ projects: ["demo"], objective: "nightly", expiry: isoTimestamp(new Date(real + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 1, schedule_grant: true });
 const scheduler = new Scheduler({
  home: home.path, ledger: () => post.ledger(), mandates: post.mandates, usageJobs: () => post.fleet.read().jobs, cloneOf: (p) => post.registry.pathOf(p), now: () => clock.now, startedAt: clock.now,
  mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }),
 });
 const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "* * * * *", tz: "UTC", title: "nightly", kind: "ship", delivery: "local", script_path: "scripts/run.sh" });
 const wakes: IntakeResult[] = [];
 const runner = new ScheduleRunner({
  dispatch: (request) => post.dispatch(request), tearDown: (id) => post.tearDown(id), recorded: (id) => post.intake.intake(id), wake: (result) => wakes.push(result),
  ledger: () => post.ledger(), fleetJobs: () => post.fleet.read().jobs, schedules: () => scheduler.list(), now: () => clock.now, log: () => {},
 });
 clock.now = new Date(real);
 const [fired] = await scheduler.tick();
 assert.equal(fired?.outcome, "fired");
 // Another run of this schedule takes the fire grant's one slot after it was minted (schedlater S3: only the schedule's own jobs count).
 await post.fleet.add({
  job_id: "cp-other", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "held", reported_at: isoTimestamp(), worktree: "/wt", branch: "cp-other", dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, schedule_id: schedule.id,
  worker: { pid: 1, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m/x", started_at: isoTimestamp() },
 } as FleetRecord);
 await runner.onFired(fired!);
 await runner.retryPending();
 const jobId = fired!.job_id!;
 assert.equal(post.fleet.get(jobId), undefined, "nothing leased or spawned over the cap");
 const notes = (await post.ledger().show(jobId)).comments.filter((c) => c.text.startsWith("dispatch refused"));
 assert.equal(notes.length, 1);
 assert.match(notes[0]!.text, /job cap 1 reached/);
 assert.deepEqual(wakes, [], "a refusal is retried, not a parent wake");
 clock.now = new Date(Date.now() + 180_000); // past the next minute slot after the job's created_at
 await runner.retryPending();
 const dropped = await post.ledger().show(jobId);
 assert.equal(dropped.status, "closed");
 assert.match(dropped.close_reason ?? "", /not dispatched before the next slot: dispatch refused .*job cap 1 reached/);
});

 test("script risk:high mandate refuses before leasing and dry_run only previews", async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 t.after(() => { home.cleanup(); repo.cleanup(); });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 post.mandates.issue({ projects: ["demo"], objective: "ship changes", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"] });
 const job = await post.ledger().create({ title: "rotate production credentials", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 const preview = await post.previewDispatch({ jobId: job.id });
 assert.equal(preview.mandate_gate, "would ask: risk:high");
 await assert.rejects(post.dispatch({ jobId: job.id }), /risk:high under ask_on/);
 assert.equal(post.fleet.get(job.id), undefined);
 assert.equal(execFileSync("git", ["branch", "--list", job.id], { cwd: post.registry.pathOf("demo"), encoding: "utf8" }).trim(), "");
});

test("script cap: home worker-bounds.json reaches the runner and the record; override wins; malformed refuses before lease", { skip: treehouseAvailable() ? false : "treehouse required", timeout: 30_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const configFile = join(home.path, LAYOUT.workerBoundsFile);
 const seen: number[] = [];
 const dispatcher = new ScriptDispatcher({ home: home.path, ledger: post.ledger(), fleet: post.fleet, preflight: post.preflight, leases: post.leases, runs: post.runs, intake: post.intake, run: (options) => { seen.push(options.wallClockSeconds); return runScript(options); } });

 writeFileSync(configFile, JSON.stringify({ wall_clock_seconds: "soon" }));
 const bad = await post.ledger().create({ title: "bad cap", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 await assert.rejects(dispatcher.preview({ jobId: bad.id }), /worker-bounds\.json wall_clock_seconds must be a positive integer/);
 await assert.rejects(dispatcher.dispatch({ jobId: bad.id }), /worker-bounds\.json wall_clock_seconds must be a positive integer/);
 assert.equal(post.fleet.get(bad.id), undefined);
 assert.equal(execFileSync("git", ["branch", "--list", bad.id], { cwd: post.registry.pathOf("demo"), encoding: "utf8" }).trim(), "");

 writeFileSync(configFile, JSON.stringify({ wall_clock_seconds: 77 }));
 const homed = await post.ledger().create({ title: "home cap", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 assert.equal((await dispatcher.preview({ jobId: homed.id })).wall_clock_seconds, 77);
 await dispatcher.dispatch({ jobId: homed.id });
 assert.equal(post.fleet.require(homed.id).bounds?.wall_clock_seconds, 77);
 await waitFor(() => post.fleet.require(homed.id).phase, (phase) => phase !== "waiting" && phase !== "launching", { timeoutMs: 10_000 });
 assert.equal((await post.tearDown(homed.id)).torn_down, true);

 const explicit = await post.ledger().create({ title: "explicit cap", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 await dispatcher.dispatch({ jobId: explicit.id, wallClockSeconds: 5 });
 assert.equal(post.fleet.require(explicit.id).bounds?.wall_clock_seconds, 5);
 assert.deepEqual(seen, [77, 5]);
 await waitFor(() => post.fleet.require(explicit.id).phase, (phase) => phase !== "waiting" && phase !== "launching", { timeoutMs: 10_000 });
});

test("post-lease occupancy refusal does not launch a script", { skip: treehouseAvailable() ? false : "treehouse required" }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "echo launched > marker\n" } });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const job = await post.ledger().create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 const check = post.preflight.check.bind(post.preflight);
 post.preflight.check = async (input) => {
  const result = await check(input);
  return input.worktree ? { ...result, status: "fail", findings: [...result.findings, { code: "occupied_refuse", level: "fail", message: "occupied", fix: "keep lease" }] } as typeof result : result;
 };
 await assert.rejects(post.dispatch({ jobId: job.id }), /preflight refused leased worktree.*occupied/s);
 assert.equal(post.fleet.get(job.id), undefined);
 assert.equal(existsSync(join(home.path, paths.scriptResultFile(job.id))), false);
});

test("failed write-ahead fleet registration never starts a script", { skip: treehouseAvailable() ? false : "treehouse required", timeout: 15_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "sleep 30\n" } });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const job = await post.ledger().create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 post.fleet.add = async () => { throw new Error("injected fleet failure"); };
 await assert.rejects(post.dispatch({ jobId: job.id }), /injected fleet failure/);
 assert.equal(post.fleet.get(job.id), undefined);
 assert.equal(existsSync(join(home.path, paths.scriptResultFile(job.id))), false);
});

test("launch claim survives a restart before spawn without inventing a pid", { skip: treehouseAvailable() ? false : "treehouse required", timeout: 15_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "sleep 30\n" } });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const ledger = post.ledger();
 const job = await ledger.create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 ledger.claim = async () => {
  assert.equal(post.fleet.require(job.id).phase, "launching");
  assert.equal(post.fleet.require(job.id).script_process, undefined);
  const staged = (await post.status()).jobs.find((candidate) => candidate.job_id === job.id);
  assert.equal(staged?.pid, null);
  assert.equal(staged?.alive, false);
  assert.equal(existsSync(join(home.path, paths.scriptResultFile(job.id))), false);
  throw new Error("simulated interruption before spawn");
 };
 const dispatcher = new ScriptDispatcher({ home: home.path, ledger, fleet: post.fleet, preflight: post.preflight, leases: post.leases, runs: post.runs, intake: post.intake });
 await assert.rejects(dispatcher.dispatch({ jobId: job.id }), /simulated interruption before spawn/);
 const restarted = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 assert.equal((await restarted.reconcile({ isPidAlive: () => false })).report.needs_intake.length, 0);
 assert.equal(restarted.fleet.require(job.id).phase, "failed");
 assert.equal(restarted.fleet.require(job.id).script_process, undefined);
 await assert.rejects(restarted.dispatch({ jobId: job.id }), /already has a fleet record|cannot be replayed/);
 await assert.rejects(restarted.tearDown(job.id), /exit is unknown/);
 assert.equal((await restarted.tearDown(job.id, { force: true })).torn_down, true);
});

test("dispatch stamps a spawn error with no pid once", { skip: treehouseAvailable() ? false : "treehouse required" }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 const received: string[] = [];
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, onReported: (result) => received.push(result.job_id) });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const job = await post.ledger().create({ title: "spawn failure", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 const dispatcher = new ScriptDispatcher({ home: home.path, ledger: post.ledger(), fleet: post.fleet, preflight: post.preflight, leases: post.leases, runs: post.runs, intake: post.intake, run: (options) => runScript({ ...options, shell: join(home.path, "missing-sh") }) });
 await assert.rejects(dispatcher.dispatch({ jobId: job.id }), /could not spawn \/bin\/sh/);
 assert.equal(post.fleet.require(job.id).script_process, undefined);
 assert.equal(post.fleet.require(job.id).failure?.class, "spawn_failed");
 assert.ok(post.fleet.require(job.id).reported_at);
 assert.deepEqual(received, [job.id]);
 const restarted = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, onReported: (result) => received.push(result.job_id) });
 await restarted.reconcile({ isPidAlive: () => false });
 assert.deepEqual(received, [job.id]);
 assert.equal((await restarted.tearDown(job.id)).torn_down, true);
});

test("durable spawn error on a pidless claim is stamped once after restart", async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 t.after(() => { repo.cleanup(); home.cleanup(); });
 const received: string[] = [];
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, onReported: (result) => received.push(result.job_id) });
 const jobId = "cp-spawn-error";
 await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "launching", executor: "script", script_path: "scripts/run.sh", worktree: repo.path, branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE } as unknown as FleetRecord);
 const result = await runScript({ home: home.path, jobId, worktree: repo.path, file: join(repo.path, "scripts/run.sh"), shell: join(home.path, "missing-sh"), wallClockSeconds: 10 }).closed;
 assert.equal(result.reason, "spawn_error");
 const first = await post.reconcile({ isPidAlive: () => false });
 assert.deepEqual(first.report.needs_intake, [jobId]);
 assert.equal(first.intake[0]?.accepted, true, JSON.stringify(first.intake));
 assert.equal(post.fleet.require(jobId).failure?.class, "spawn_failed");
 assert.equal(validate(FailureClassSchema, post.fleet.require(jobId).failure?.class).ok, true);
 assert.match(post.fleet.require(jobId).failure?.message ?? "", /spawn_error/);
 assert.ok(post.fleet.require(jobId).reported_at);
 assert.deepEqual(received, [jobId]);
 await post.reconcile({ isPidAlive: () => false });
 assert.deepEqual(received, [jobId]);
});

test("launch claim survives a restart after spawn but before the pid write", { skip: treehouseAvailable() ? false : "treehouse required", timeout: 15_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "sleep 30\n" } });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"));
 t.after(() => { pool.cleanup(); repo.cleanup(); home.cleanup(); });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const job = await post.ledger().create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 post.intake.intake = async () => { throw new Error("simulated parent interruption before intake"); };
 post.fleet.patch = async () => {
  assert.equal(post.fleet.require(job.id).phase, "launching");
  assert.equal(post.fleet.require(job.id).script_process, undefined);
  throw new Error("simulated interruption before pid write");
 };
 await assert.rejects(post.dispatch({ jobId: job.id }), /simulated interruption before pid write/);
 const restarted = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 const first = await restarted.reconcile({ isPidAlive: () => false });
 assert.deepEqual(first.report.needs_intake, [job.id]);
 assert.equal(restarted.fleet.require(job.id).phase, "failed");
 assert.equal(restarted.fleet.require(job.id).script_process, undefined);
 assert.equal(restarted.fleet.require(job.id).failure?.class, "script_signal");
 assert.ok(restarted.fleet.require(job.id).reported_at);
 assert.equal((await restarted.tearDown(job.id)).torn_down, true);
});

test("restart intakes a durable script exit once instead of calling the dead pid a crash", async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 t.after(() => { home.cleanup(); repo.cleanup(); });
 const file = await resolveScriptFile(repo.path, "scripts/run.sh");
 const { child, closed } = runScript({ home: home.path, jobId: "cp-restart", worktree: repo.path, file, wallClockSeconds: 10 });
 await closed;
 const received: string[] = [];
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, onReported: (result) => received.push(result.job_id) });
 // SAFETY: the fleet contract validates this script record without a worker; FleetRecord still types legacy model readers.
 await post.fleet.add({ job_id: "cp-restart", project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "waiting", executor: "script", script_path: "scripts/run.sh", script_process: { pid: child.pid!, started_at: isoTimestamp() }, worktree: repo.path, branch: "cp-restart", dispatched_at: isoTimestamp(), usage: EMPTY_USAGE } as unknown as FleetRecord);
 const resultFile = join(home.path, paths.scriptResultFile("cp-restart"));
 renameSync(resultFile, `${resultFile}.held`);
 await post.fleet.reconcile({ isPidAlive: () => false });
 assert.equal(post.fleet.require("cp-restart").phase, "failed");
 await assert.rejects(post.tearDown("cp-restart"), /exit is unknown.*keep the lease/);
 renameSync(`${resultFile}.held`, resultFile);
 const first = await post.reconcile({ isPidAlive: () => false });
 assert.deepEqual(first.report.needs_intake, ["cp-restart"]);
 assert.equal(post.fleet.require("cp-restart").phase, "held");
 assert.equal(post.fleet.require("cp-restart").failure, undefined);
 assert.deepEqual(received, ["cp-restart"]);
 const second = await post.reconcile({ isPidAlive: () => false });
 assert.deepEqual(second.report.needs_intake, []);
 assert.deepEqual(received, ["cp-restart"]);
});

test("script runner observes exit and bounds stdout/stderr outside the worktree", async (t) => {
 const home = mkdtempSync(join(tmpdir(), "cp-script-home-"));
 const worktree = mkdtempSync(join(tmpdir(), "cp-script-repo-"));
 t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(worktree, { recursive: true, force: true }); });
 execFileSync("git", ["init", "-q"], { cwd: worktree });
 mkdirSync(join(worktree, "scripts"));
 writeFileSync(join(worktree, "scripts/run.sh"), "printf '%070000d' 1\npwd\nprintf 'error' >&2\nexit 7\n");
 execFileSync("git", ["add", "scripts/run.sh"], { cwd: worktree });
 const file = await resolveScriptFile(worktree, "scripts/run.sh");
 const { child, closed } = runScript({ home, jobId: "cp-test", worktree, file, wallClockSeconds: 10 });
 assert.ok(child.pid);
 const result = await closed;
 assert.equal(result.status, "failed");
 assert.equal(result.exit_code, 7);
 const artifact = readFileSync(join(home, paths.artifactFile("cp-test")), "utf8");
 assert.ok(artifact.startsWith("stdout: 7"));
 assert.match(artifact, /truncated/);
 assert.ok(artifact.includes(worktree));
 assert.equal(readFileSync(join(home, paths.scriptResultFile("cp-test")), "utf8").includes('"reason": "exit"'), true);
});

test("script timeout terminates a TERM-ignoring process group", { timeout: 15_000 }, async (t) => {
 const home = mkdtempSync(join(tmpdir(), "cp-script-timeout-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const file = join(home, "ignore.sh");
 writeFileSync(file, "trap '' TERM\nwhile :; do sleep 0.1; done\n");
 const { closed } = runScript({ home, jobId: "cp-timeout", worktree: home, file, wallClockSeconds: 1 });
 const result = await closed;
 assert.equal(result.status, "failed");
 assert.equal(result.reason, "timeout");
 assert.equal(result.timed_out, true);
});

test("timeout kills an inherited TERM-ignoring descendant after its shell closes", { timeout: 15_000 }, async (t) => {
 const home = mkdtempSync(join(tmpdir(), "cp-script-descendant-"));
 let pid: number | undefined;
 t.after(() => {
  if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  rmSync(home, { recursive: true, force: true });
 });
 const file = join(home, "descendant.sh");
 writeFileSync(file, "trap 'exit 0' TERM\n(trap '' TERM; exec sleep 30) >/dev/null 2>&1 &\necho $! > \"$CP_RUN_DIR/descendant.pid\"\nwait\n");
 const { closed } = runScript({ home, jobId: "cp-descendant", worktree: home, file, wallClockSeconds: 1 });
 await waitFor(() => existsSync(join(home, paths.runDir("cp-descendant"), "descendant.pid")), Boolean, { timeoutMs: 5_000 });
 pid = Number(readFileSync(join(home, paths.runDir("cp-descendant"), "descendant.pid"), "utf8"));
 assert.equal((await closed).reason, "timeout");
 await waitFor(() => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z"; }
  catch { return true; }
 }, Boolean, { timeoutMs: 5_000 });
});

test("script signal is recorded without guessing an exit code", async (t) => {
 const home = mkdtempSync(join(tmpdir(), "cp-script-signal-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const file = join(home, "signal.sh");
 writeFileSync(file, "kill -TERM $$\n");
 const result = await runScript({ home, jobId: "cp-signal", worktree: home, file, wallClockSeconds: 10 }).closed;
 assert.equal(result.status, "failed");
 assert.equal(result.reason, "signal");
 assert.equal(result.signal, "SIGTERM");
 assert.equal(result.exit_code, null);
});

test("script validation refuses symlinks and untracked files", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "cp-script-path-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 execFileSync("git", ["init", "-q"], { cwd: dir });
 writeFileSync(join(dir, "run.sh"), "exit 0\n");
 await assert.rejects(resolveScriptFile(dir, "run.sh"), /tracked/);
 await assert.rejects(resolveScriptFile(dir, "../run.sh"), /unsafe/);
 execFileSync("git", ["add", "run.sh"], { cwd: dir });
 symlinkSync("run.sh", join(dir, "link.sh"));
 await assert.rejects(resolveScriptFile(dir, "link.sh"), /symlink/);
});
