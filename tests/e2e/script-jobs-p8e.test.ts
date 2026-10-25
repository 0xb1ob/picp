/**
 * Behavior 04 (P8e, 04-33..04-35): script jobs through cp_dispatch — the lease, the one intake and the replay refusals,
 * the mandate and deny gates before any lease, and the runner's exit, cap, timeout and signal on the fleet record.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, REPO_ROOT, treehouseAvailable, waitFor } from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "script-jobs-p8e e2e needs treehouse on PATH";

test("P8e script dispatch: a script job leases its branch, intakes once, refuses every replay, and tears down only clean", { skip: SKIP, timeout: 60_000 }, async (t) => {
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
 const base = { projects: ["demo"], objective: "script", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 };
 post.mandates.issue(base);
 const selected = post.mandates.issue({ ...base, job_ids: [job.id] });
 const preview = await post.previewDispatch({ jobId: job.id });
 assert.equal("executor" in preview && preview.executor, "script");
 assert.equal(preview.mandate_id, selected.id);
 assert.equal(fleet.get(job.id), undefined);
 await assert.rejects(post.dispatch({ jobId: job.id, task: "ignored" }), /task is not accepted/);
 const result = await post.dispatch({ jobId: job.id });
 assert.equal("executor" in result && result.executor, "script");
 assert.equal(result.mandate_id, selected.id);
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

test("P8e script gates: a risk:high script is only previewed under ask_on and refused before any lease; a denied project refuses first", { skip: SKIP, timeout: 30_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: { "scripts/run.sh": "exit 0\n" } });
 t.after(() => { home.cleanup(); repo.cleanup(); });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 post.mandates.issue({ projects: ["demo"], objective: "ship changes", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"] });
 const branches = (id: string) => execFileSync("git", ["branch", "--list", id], { cwd: post.registry.pathOf("demo"), encoding: "utf8" }).trim();
 const job = await post.ledger().create({ title: "rotate production credentials", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
 const preview = await post.previewDispatch({ jobId: job.id });
 assert.equal(preview.mandate_gate, "would ask: risk:high");
 assert.equal(preview.mandate_id, post.mandates.list()[0]!.id);
 await assert.rejects(post.dispatch({ jobId: job.id }), /risk:high under ask_on/);
 assert.deepEqual([post.fleet.get(job.id), branches(job.id)], [undefined, ""], "no record, no branch");

 // cp-7re9: the deny list is added after the grant (it would refuse the issue itself) and refuses before the risk gate.
 mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
 writeFileSync(join(home.path, LAYOUT.mandateDefaultsFile), JSON.stringify({ ...loadMandateDefaults(home.path), deny_projects: ["demo"] }));
 const before = new EscalationStore({ home: home.path }).open().length;
 await assert.rejects(post.dispatch({ jobId: job.id }), (error: Error & { result?: { findings: Array<{ code: string }> } }) => {
  assert.match(error.message, /project demo is denied/);
  assert.deepEqual(error.result?.findings.map((finding) => finding.code), ["project_denied"]);
  return true;
 });
 assert.deepEqual([post.fleet.get(job.id), branches(job.id)], [undefined, ""], "no record, no branch, no lease");
 assert.equal(new EscalationStore({ home: home.path }).open().length, before, "no new risk_high escalation: the deny refuses first");
});

test("P8e script runner: the home cap reaches the record and an override wins, a malformed cap refuses before a lease, and exit, timeout and signal each land as their own failure", { skip: SKIP, timeout: 90_000 }, async (t) => {
 const home = createScratchHome();
 const repo = createScratchRepo({ files: {
  "scripts/out.sh": "printf '%070000d' 1\npwd\nprintf 'error' >&2\nexit 7\n",
  "scripts/trap.sh": "trap '' TERM\nwhile :; do sleep 0.1; done\n",
  "scripts/descendant.sh": "trap 'exit 0' TERM\n(trap '' TERM; exec sleep 30) >/dev/null 2>&1 &\necho $! > \"$CP_RUN_DIR/descendant.pid\"\nwait\n",
  "scripts/signal.sh": "kill -TERM $$\n",
 } });
 symlinkSync("out.sh", join(repo.path, "scripts/link.sh"));
 execFileSync("git", ["add", "scripts/link.sh"], { cwd: repo.path });
 execFileSync("git", ["commit", "-qm", "link"], { cwd: repo.path });
 execFileSync("git", ["push", "-q", "origin", "HEAD"], { cwd: repo.path });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
 await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
 execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
 const pool = enableTreehouse(post.registry.pathOf("demo"), { maxTrees: 6 });
 let orphan: number | undefined;
 t.after(() => {
  if (orphan) try { process.kill(orphan, "SIGKILL"); } catch { /* Already gone. */ }
  pool.cleanup(); repo.cleanup(); home.cleanup();
 });
 createScratchLedger({ home: home.path, knownProjects: ["demo"] });
 const job = async (title: string, scriptPath: string) => (await post.ledger().create({ title, project: "demo", kind: "ship", delivery: "local", scriptPath })).id;
 const settled = (id: string) => waitFor(() => post.fleet.require(id).failure?.class, Boolean, { timeoutMs: 20_000, what: `${id}'s exit` });
 const configFile = join(home.path, LAYOUT.workerBoundsFile);

 writeFileSync(configFile, JSON.stringify({ wall_clock_seconds: "soon" }));
 const bad = await job("bad cap", "scripts/out.sh");
 await assert.rejects(post.previewDispatch({ jobId: bad }), /worker-bounds\.json wall_clock_seconds must be a positive integer/);
 await assert.rejects(post.dispatch({ jobId: bad }), /worker-bounds\.json wall_clock_seconds must be a positive integer/);
 assert.equal(post.fleet.get(bad), undefined);
 writeFileSync(configFile, JSON.stringify({ wall_clock_seconds: 1 }));
 const link = await job("link", "scripts/link.sh");
 await assert.rejects(post.dispatch({ jobId: link }), /symlink/);
 assert.equal(post.fleet.get(link), undefined, "a symlinked script never launches");

 const [out, trap, descendant, signal] = [await job("out", "scripts/out.sh"), await job("trap", "scripts/trap.sh"),
  await job("descendant", "scripts/descendant.sh"), await job("signal", "scripts/signal.sh")];
 await post.dispatch({ jobId: out, wallClockSeconds: 5 });
 for (const id of [trap, descendant, signal]) await post.dispatch({ jobId: id });
 assert.deepEqual([out, trap].map((id) => post.fleet.require(id).bounds?.wall_clock_seconds), [5, 1], "an override wins over the home cap");

 assert.equal(await settled(out), "script_exit");
 const artifact = readFileSync(join(home.path, paths.artifactFile(out)), "utf8");
 assert.ok(artifact.startsWith("stdout: 7") && /truncated/.test(artifact), "stdout is bounded to its tail");
 assert.ok(artifact.includes(post.fleet.require(out).worktree) && artifact.includes("stderr: 5 bytes"));
 assert.ok(!existsSync(join(post.fleet.require(out).worktree, paths.artifactFile(out))), "the artifact lives outside the worktree");
 assert.equal(await settled(trap), "wall_clock_exceeded", "a TERM-ignoring group is killed at the cap");
 assert.equal(await settled(descendant), "wall_clock_exceeded");
 orphan = Number(readFileSync(join(home.path, paths.runDir(descendant), "descendant.pid"), "utf8"));
 await waitFor(() => {
  try { return readFileSync(`/proc/${orphan}/stat`, "utf8").split(" ")[2] === "Z"; }
  catch { return true; }
 }, Boolean, { timeoutMs: 5_000, what: "the TERM-ignoring descendant to die" });
 assert.equal(await settled(signal), "script_signal");
 assert.equal(post.fleet.require(signal).script_process?.exit_code, null, "a signal never guesses an exit code");
 assert.equal(post.fleet.require(signal).script_process?.signal, "SIGTERM");
});
