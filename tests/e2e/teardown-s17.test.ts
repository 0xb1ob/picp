import assert from "node:assert/strict";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../harness/index.ts";
import { isoTimestamp, isScriptFleetRecord, paths } from "../../src/contracts.ts";
import { readRunEvents, waitFor } from "../harness/index.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, mkdirSync } from "node:fs";
import { advanceBase, squashMergeAndDeleteHead, rebaseMergeAndDeleteHead } from "../harness/index.ts";
import { formatTeardown } from "../../src/teardown.ts";

function gitFault(home: string, condition: string, response: string, bin = "git") {
 const real = execFileSync("which", [bin], { encoding: "utf8" }).trim();
 const file = join(home, "bin", bin);
 writeFileSync(file, `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process'); const a=process.argv.slice(2);\nif (${condition}) { ${response} } else { const r=spawnSync(${JSON.stringify(real)},a,{stdio:'inherit'});process.exit(r.status??1); }\n`);
 chmodSync(file, 0o755);
 return () => rmSync(file, { force: true });
}
import { startFakeGitlab } from "./landing-helpers.ts";
import { SKIP, startStack } from "./landing-helpers.ts";

for (const delivery of ["pr", "local"] as const) {
 test(`S17: ${delivery} teardown preserves dirty and unpushed work, then returns a reported pushed lease once`, { skip: SKIP, timeout: 120_000 }, async (t) => {
  const s = await startStack(t);
  const live = await s.held("S17 durability", 917, delivery === "local" ? { delivery } : {});
  const worker = s.post.manager.get(live.jobId)!;
  const artifact = join(s.home, paths.artifactDir(live.jobId), "preserved.txt");
  mkdirSync(join(s.home, paths.artifactDir(live.jobId)), { recursive: true });
  writeFileSync(artifact, "operator evidence\n");
  writeFileSync(join(live.worktree, "scratch.txt"), "unfinished\n");
  const dirty = await s.post.tearDown(live.jobId);
  assert.deepEqual([dirty.torn_down, dirty.lease_returned, dirty.failure?.code], [false, false, "dirty"]);
  assert.equal(s.post.fleet.require(live.jobId).phase, "held");
  rmSync(join(live.worktree, "scratch.txt"));
  writeFileSync(join(live.worktree, "change.txt"), "second version\n");
  git(live.worktree, "add", "change.txt");
  git(live.worktree, "commit", "--quiet", "-m", "unpublished work");
  git(s.remote, "branch", "-D", live.jobId);
  git(live.worktree, "branch", "--unset-upstream");
  const unpushed = await s.post.tearDown(live.jobId);
  assert.deepEqual([unpushed.torn_down, unpushed.lease_returned, unpushed.failure?.code], [false, false, "unpushed"]);
  assert.ok(existsSync(join(live.worktree, "change.txt")), "refusal preserves the worktree");
  git(live.worktree, "push", "--quiet", "origin", live.jobId);
  const pushed = await s.post.tearDown(live.jobId);
  assert.deepEqual([pushed.torn_down, pushed.lease_returned, pushed.reason], [true, true, "pushed"]);
  assert.deepEqual([pushed.artifacts_removed, readFileSync(artifact, "utf8")], [false, "operator evidence\n"]);
  assert.equal(worker.worker.alive, false, "the managed worker close is observed");
  assert.equal(s.post.manager.get(live.jobId), undefined);
  const closed = s.post.fleet.require(live.jobId);
  assert.equal(closed.phase, "done");
  assert.equal(closed.closed_reason, "gated");
  assert.ok(closed.closed_at);
  assert.ok(closed.worker.exited_at);
  const again = await s.post.tearDown(live.jobId);
  assert.deepEqual([again.torn_down, again.lease_returned, again.failure], [false, false, undefined]);
  await assert.rejects(s.post.tearDown("cp-unknown-s17"), /no fleet record/);
 });
}

test("S17: a detached head keeps its lease even when its commit is on origin", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 detached", 918);
 git(live.worktree, "checkout", "--quiet", "--detach");
 git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "detached work");
 git(live.worktree, "push", "--quiet", "origin", "HEAD:refs/heads/s17-detached");
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, "unreachable_work"]);
 assert.equal(s.post.fleet.require(live.jobId).phase, "held");
 assert.ok(existsSync(live.worktree));
});

 test("S17: legacy research teardown preserves commits and exit time, and labels dead unreported work", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 research", 919);
 await s.post.manager.shutdown(live.jobId);
 const exitedAt = "2026-01-01T00:00:00Z";
 await s.post.fleet.mutate((jobs) => {
  const record = jobs.find((job) => job.job_id === live.jobId)!;
  record.kind = "research";
  record.delivery = "pipeline";
  if (isScriptFleetRecord(record)) assert.fail("model job");
  record.worker.exited_at = exitedAt;
  delete record.reported_at;
  record.phase = "waiting";
 });
 const committed = await s.post.tearDown(live.jobId);
 assert.deepEqual([committed.torn_down, committed.lease_returned, committed.failure?.code], [false, false, "research_commits"]);
 git(live.worktree, "reset", "--soft", "origin/main");
 git(live.worktree, "restore", "--staged", ".");
 git(live.worktree, "clean", "-fd");
 const clean = await s.post.tearDown(live.jobId, { acceptUnreported: "pipeline hand-off" });
 assert.deepEqual([clean.torn_down, clean.reason, clean.unreported, clean.killed_unreported], [true, "clean_research", true, undefined]);
 const closed = s.post.fleet.require(live.jobId);
 if (isScriptFleetRecord(closed)) assert.fail("model job");
 assert.equal(closed.worker.exited_at, exitedAt);
 assert.notEqual(closed.closed_at, exitedAt);
 });

 test("S17: live unowned legacy workers refuse every teardown shape until an observed exit", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 orphan", 920);
 await s.post.manager.shutdown(live.jobId);
 rmSync(join(s.home, paths.eventsFile(live.jobId)), { force: true });
 rmSync(join(s.home, paths.statusFile(live.jobId)), { force: true });
 s.post.runs.close(live.jobId);
 await s.post.fleet.mutate((jobs) => {
  const record = jobs.find((job) => job.job_id === live.jobId)!;
  if (isScriptFleetRecord(record)) assert.fail("model job");
  record.worker.pid = process.pid;
  delete record.worker.exited_at;
  delete record.reported_at;
  record.phase = "waiting";
 });
 const shapes = [{}, { force: true }, { force: true, requireAuthorization: true },
  { force: true, requireAuthorization: true, authorization: { by: "operator-quote", quote: "End this worker." } },
  { acceptUnreported: "pipeline hand-off" }];
 let refusals = 0;
 for (const phase of ["waiting", "held", "failed"] as const) {
  await s.post.fleet.mutate((jobs) => {
   const record = jobs.find((job) => job.job_id === live.jobId)!;
   record.phase = phase;
   if (phase !== "waiting") record.reported_at = isoTimestamp();
   if (phase === "failed") record.failure = { class: "crash", message: "legacy exit", at: isoTimestamp() };
  });
  for (const options of shapes) {
   const result = await s.post.tearDown(live.jobId, options);
   assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, "unmanaged_live_worker"]);
   assert.equal(s.post.fleet.require(live.jobId).phase, phase);
   assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "teardown_refused").length, ++refusals);
   assert.equal(result.killed_unreported, undefined);
  }
 }
 await s.post.fleet.mutate((jobs) => {
  const record = jobs.find((job) => job.job_id === live.jobId)!;
  if (isScriptFleetRecord(record)) assert.fail("model job");
  record.phase = "held";
  record.worker.exited_at = isoTimestamp();
 });
 const closed = await s.post.tearDown(live.jobId);
 assert.deepEqual([closed.torn_down, closed.reason], [true, "pushed"]);
 const observed = await s.held("S17 observed orphan", 920);
 await s.post.manager.shutdown(observed.jobId);
 await s.post.fleet.mutate((jobs) => { const r = jobs.find((r) => r.job_id === observed.jobId)!; if (!isScriptFleetRecord(r)) { r.worker.pid = process.pid; delete r.worker.exited_at; } });
 const observedClose = await s.post.tearDown(observed.jobId);
 assert.deepEqual([observedClose.torn_down, observedClose.reason], [true, "pushed"], "run observation proves the old worker closed");
 });

for (const mode of ["tree", "squash", "rebase", "stale", "unreadable", "receipt", "receipt-extra"] as const) {
 test(`S17: landing evidence ${mode} is checked against origin and the exact head`, { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held(`S17 ${mode}`, 921);
 let merged: string;
 if (mode === "rebase") {
  advanceBase(s.repo, "docs/before.md", "before\n");
  merged = rebaseMergeAndDeleteHead(s.repo, live.jobId);
 } else merged = squashMergeAndDeleteHead(s.repo, live.jobId);
 if (mode === "stale") {
  git(live.worktree, "fetch", "--quiet", "origin");
  git(s.remote, "update-ref", "refs/heads/main", `${merged}^`);
  advanceBase(s.repo, "docs/elsewhere.md", "elsewhere\n");
 }
 if (["squash", "rebase", "receipt", "receipt-extra"].includes(mode)) advanceBase(s.repo, "docs/after.md", "later\n");
 if (mode.startsWith("receipt") || mode === "rebase") {
  s.setGh({ merged: { [live.jobId]: { head: live.head, commit: merged } } });
  await s.post.recordMerge({ jobId: live.jobId, strategy: "squash" });
  await s.post.fleet.mutate((jobs) => { const r = jobs.find((r) => r.job_id === live.jobId)!; r.phase = "failed"; r.failure = { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() }; delete r.reported_at; });
 }
 if (mode === "receipt-extra") {
  writeFileSync(join(live.worktree, "change.txt"), "unlanded\n");
  git(live.worktree, "commit", "-qam", "after merge");
 }
 let restore: (() => void) | undefined;
 const trace = join(s.home, "git-trace.jsonl");
 if (mode === "tree") restore = gitFault(s.home, `(require('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n'),false)`, "");
 if (mode === "unreadable" || mode === "receipt") restore = gitFault(s.home,
  "a[0]==='ls-remote' && a.includes('refs/heads/main')", "process.stderr.write('origin unavailable'); process.exit(128);");
 try {
  const result = await s.post.tearDown(live.jobId);
  if (["stale", "receipt-extra", "unreadable"].includes(mode)) {
   assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, mode === "unreadable" ? "landing_unverified" : "unpushed"]);
   assert.equal(s.post.fleet.require(live.jobId).phase, mode === "receipt-extra" ? "failed" : "held");
   if (mode === "stale") assert.match(result.failure?.message ?? "", /stale remote-tracking ref/);
   if (mode === "receipt-extra") assert.match(result.failure?.message ?? "", /landed nowhere/);
   if (mode === "unreadable") assert.doesNotMatch(result.failure?.fix ?? "", /force/);
  } else {
   assert.deepEqual([result.torn_down, result.lease_returned, result.reason], [true, true, mode === "receipt" || mode === "rebase" ? "merged" : mode === "tree" ? "merged_head_deleted" : "landed_by_git"]);
   assert.equal(s.post.fleet.require(live.jobId).closed_reason, "gated");
   assert.equal(existsSync(join(s.home, paths.mergeFile(live.jobId))), mode === "receipt" || mode === "rebase");
   if (mode === "tree") {
    const calls: string[][] = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const evidenceCalls = calls.slice(0, calls.findIndex((a) => a[0] === "diff") + 1);
    assert.ok(calls.some((a) => a[0] === "ls-remote" && a.includes("refs/heads/main")), "base evidence asks origin");
    assert.equal(evidenceCalls.some((a) => a[0] === "rev-parse" && a.includes("refs/remotes/origin/main")), false);
    assert.ok(calls.some((a) => a[0] === "diff" && a.includes(merged)), "tree proof uses origin's advertised SHA");
   }
  }
 } finally { restore?.(); }
 });
}

test("S17: force closes a missing legacy worktree without claiming a gate pass", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.seed("S17 missing worktree");
 await s.post.fleet.mutate((jobs) => {
  const record = jobs.find((job) => job.job_id === live.jobId)!;
  if (isScriptFleetRecord(record)) assert.fail("model job");
  record.worker.exited_at = isoTimestamp();
 });
 const refused = await s.post.tearDown(live.jobId);
 assert.equal(refused.failure?.code, "worktree_missing");
 const restore = gitFault(s.home, "a[0]==='return'", "process.exit(0);", "treehouse");
 t.after(restore);
 const forced = await s.post.tearDown(live.jobId, { force: true });
 assert.deepEqual([forced.torn_down, forced.reason, s.post.fleet.require(live.jobId).closed_reason], [true, undefined, "forced"]);
 assert.ok(readRunEvents(s.home, live.jobId).some((event) => event.type === "shutdown_requested" && (event.payload as { forced?: boolean }).forced));
});

for (const forced of [false, true]) {
 test(`S17: failed lease return stays open and retries (${forced ? "forced" : "gated"})`, { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 return failure", 922);
 const restore = gitFault(s.home, "a[0]==='return'", "process.stderr.write('treehouse: worktree is in use by pid 4242'); process.exit(1);", "treehouse");
 try {
  const result = await s.post.tearDown(live.jobId, { force: forced });
  assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, "lease_return_failed"]);
  assert.match(result.failure?.message ?? "", /worktree is in use by pid 4242/);
  assert.equal(s.post.fleet.require(live.jobId).phase, "held");
  assert.equal(s.post.fleet.require(live.jobId).closed_at, undefined);
  assert.equal(s.post.fleet.require(live.jobId).closed_reason, undefined);
 } finally { restore(); }
 const retried = await s.post.tearDown(live.jobId, { force: forced });
 assert.deepEqual([retried.torn_down, retried.lease_returned, retried.reason], [true, true, forced ? undefined : "pushed"]);
 assert.equal(s.post.fleet.require(live.jobId).closed_reason, forced ? "forced" : "gated");
 });
}

 test("S17: teardown reports ignored data, withdraws only its human review and removes checkpoint refs", { skip: "Declaration 30 parked pending-fix: treehouse v3.1.2 removes ignored data; separate fix job required", timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 bookkeeping", 923, { command: (b) => `printf 'backtest/\\nnode_modules/\\n*.log\\n' > .gitignore && mkdir -p pkg/sub && printf 'x\\n' > pkg/sub/a.ts && git add -A && git commit -qm ignores && git push -qu origin ${b}` });
 for (const path of ["backtest", "node_modules", "pkg/node_modules"]) { mkdirSync(join(live.worktree, path)); writeFileSync(join(live.worktree, path, "x"), "x\n"); }
 writeFileSync(join(live.worktree, "pkg/sub/out.log"), "log\n");
 const ref = `refs/cp-checkpoints/${live.jobId}`;
 git(live.worktree, "update-ref", ref, "HEAD");
 await s.post.fleet.patch(live.jobId, { checkpoint_ref: ref });
 const row = async (job_id: string, subject: string) => (await s.post.awaiting.declareGated({ type: "approval", subject, decision: "decision", why: "why", blocks: "blocks", job_id })).item;
 const human = await row(live.jobId, "human-review pr https://github.com/example/demo/pull/923");
 const reminder = await row(live.jobId, "merge-pending pr https://github.com/example/demo/pull/923");
 const other = await row("cp-other", "human-review pr https://github.com/example/demo/pull/924");
 const result = await s.post.tearDown(live.jobId);
 assert.equal(result.torn_down, true);
 assert.deepEqual(result.ignored, ["backtest/", "pkg/sub/out.log"]);
 assert.match(formatTeardown(result), /backtest\/.*pkg\/sub\/out.log.*not removed/);
 assert.ok(existsSync(join(live.worktree, "backtest/x")));
 assert.deepEqual([s.post.awaiting.get(human.id)?.state, s.post.awaiting.get(reminder.id)?.state, s.post.awaiting.get(other.id)?.state], ["withdrawn", "open", "open"]);
 assert.equal(git(live.worktree, "for-each-ref", ref), "");
 });

 test("S17: unreadable ignored listings are named in the public teardown result", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 ignored error", 924);
 const restore = gitFault(s.home, "a[0]==='status' && a.includes('--ignored')", "process.stderr.write('fatal: cannot list ignored entries\\nprivate second line'); process.exit(128);");
 try {
  const result = await s.post.tearDown(live.jobId);
  assert.equal(result.torn_down, true);
  assert.equal(result.ignored_error, "git status --ignored failed: fatal: cannot list ignored entries");
  assert.match(formatTeardown(result), /ignored entries unknown/);
  assert.doesNotMatch(formatTeardown(result), /private second line/);
 } finally { restore(); }
 });

 test("S17: failed ship teardown accepts only the current generation and intake attempt", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 failed head", 925);
 const original = s.post.fleet.require(live.jobId);
 const file = join(s.home, paths.envelopeFile(live.jobId));
 const envelope = JSON.parse(readFileSync(file, "utf8"));
 await s.post.fleet.patch(live.jobId, { phase: "failed", failure: { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() } });
 const refused = async (label: string) => {
  const result = await s.post.tearDown(live.jobId);
  assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, "unreported_head"], label);
 };
 await s.post.fleet.mutate((jobs) => { delete jobs.find((r) => r.job_id === live.jobId)!.reported_at; });
 await refused("filed report without intake acceptance");
 await s.post.fleet.patch(live.jobId, { reported_at: original.reported_at, supersessions: 1 });
 await refused("previous generation");
 await s.post.fleet.mutate((jobs) => { delete jobs.find((r) => r.job_id === live.jobId)!.supersessions; });
 writeFileSync(file, JSON.stringify({ ...envelope, attempt: envelope.attempt + 1 }));
 await refused("wrong intake attempt");
 writeFileSync(file, JSON.stringify({ ...envelope, envelope: { ...envelope.envelope, head_sha: "0".repeat(40) } }));
 await refused("stale reported head");
 writeFileSync(file, JSON.stringify(envelope));
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.reason], [true, "pushed"]);
 });

 test("S17: an owned unreported worker is named mid-turn or idle and dead workers stop blocking", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 unreported", 926);
 await s.post.fleet.mutate((jobs) => { const r = jobs.find((r) => r.job_id === live.jobId)!; delete r.reported_at; r.phase = "waiting"; });
 const file = join(s.home, paths.statusFile(live.jobId));
 const status = JSON.parse(readFileSync(file, "utf8"));
 writeFileSync(file, JSON.stringify({ ...status, phase: "working" }));
 const mid = await s.post.tearDown(live.jobId);
 assert.equal(mid.failure?.code, "unreported_live_worker");
 assert.match(mid.failure?.message ?? "", /mid-turn/);
 writeFileSync(file, JSON.stringify({ ...status, phase: "idle" }));
 const idle = await s.post.tearDown(live.jobId);
 assert.equal(idle.failure?.code, "unreported_live_worker");
 assert.match(idle.failure?.message ?? "", /is alive/);
 await s.post.manager.shutdown(live.jobId);
 const dead = await s.post.tearDown(live.jobId, { force: true });
 assert.equal(dead.torn_down, true);
 assert.equal(dead.killed_unreported, undefined);
 assert.equal(dead.unreported, true);
 assert.match(formatTeardown(dead), /no report was filed/);
 });

 test("S17: human review withdrawal and checkpoint cleanup are scoped to the closed job", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 for (const hasRef of [true, false]) {
 const live = await s.held(`S17 checkpoint ${hasRef}`, 927);
 const ref = `refs/cp-checkpoints/${live.jobId}`;
 if (hasRef) git(live.worktree, "update-ref", ref, "HEAD");
 await s.post.fleet.patch(live.jobId, { checkpoint_ref: ref });
 const row = async (job_id: string, subject: string) => (await s.post.awaiting.declareGated({ type: "approval", subject, decision: "decision", why: "why", blocks: "blocks", job_id })).item;
 const human = await row(live.jobId, "human-review pr https://github.com/example/demo/pull/927");
 const reminder = await row(live.jobId, "merge-pending pr https://github.com/example/demo/pull/927");
 const other = await row("cp-other", "human-review pr https://github.com/example/demo/pull/928");
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.lease_returned], [true, true]);
 assert.deepEqual([s.post.awaiting.get(human.id)?.state, s.post.awaiting.get(reminder.id)?.state, s.post.awaiting.get(other.id)?.state], ["withdrawn", reminder.state, other.state]);
 assert.equal(git(live.worktree, "for-each-ref", ref), "");
 }
 });

 test("S17: an empty local ship tears down after the base moves while dirty work still refuses", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 empty", 928, { delivery: "local", command: (b) => `git push -qu origin ${b}` });
 git(s.remote, "branch", "-D", live.jobId);
 git(live.worktree, "branch", "--unset-upstream");
 advanceBase(s.repo, "docs/moved.md", "moved\n");
 writeFileSync(join(live.worktree, "scratch.txt"), "dirty\n");
 assert.equal((await s.post.tearDown(live.jobId)).failure?.code, "dirty");
 rmSync(join(live.worktree, "scratch.txt"));
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.lease_returned, result.reason], [true, true, "nothing_to_push"]);
 assert.equal(s.post.fleet.require(live.jobId).closed_reason, "gated");
 assert.equal(existsSync(join(s.home, paths.mergeFile(live.jobId))), false);
 });

test("S17: an empty PR ship still needs publication when origin no longer has its base", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const before = git(s.repo.path, "rev-parse", "HEAD");
 advanceBase(s.repo, "private-base.txt", "base content\n");
 const live = await s.held("S17 empty PR", 930, { command: (b) => `git push -qu origin ${b}` });
 git(s.remote, "branch", "-D", live.jobId);
 git(live.worktree, "branch", "--unset-upstream");
 git(s.remote, "update-ref", "refs/heads/main", before);
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, "unpushed"]);
 assert.equal(s.post.fleet.require(live.jobId).phase, "held");
});

 test("S17: opt-in review must exist before a reported pushed ship can tear down", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 missing review", 929);
 const { PipelineStore } = await import("../../src/pipeline.ts");
 new PipelineStore(s.home).write({ schema_version: 1, research_id: `${live.jobId}-research`, ship_id: live.jobId, project: "demo", delivery: "pr", state: "implementing", created_at: isoTimestamp(), updated_at: isoTimestamp(), review: { enabled: true } });
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, "review_missing"]);
 assert.match(result.failure?.fix ?? "", /cp_review/);
 assert.equal(s.post.fleet.require(live.jobId).phase, "held");
 });

 test("S17: public cp_teardown verifies operator quotes before attempting force", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.seed("S17 quote");
 await s.post.fleet.mutate((jobs) => { const r = jobs.find((r) => r.job_id === live.jobId)!; if (!isScriptFleetRecord(r)) r.worker.exited_at = isoTimestamp(); });
 const restore = gitFault(s.home, "a[0]==='return'", "process.exit(0);", "treehouse");
 try {
 const quote = `Force close ${live.jobId} now.`;
 const events = await s.parent(quote, [
  { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: live.jobId, force: true, operator_quote: "made up" } }] },
  { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: live.jobId, operator_quote: quote } }] },
  { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: live.jobId, force: true, operator_quote: quote } }] },
  { kind: "text", text: "Finished." },
 ]);
 assert.match(JSON.stringify(events[0]), /quote not found/);
 assert.match(JSON.stringify(events[1]), /operator_quote authorizes force/);
 assert.match(JSON.stringify(events[2]), /torn down/);
 assert.equal(s.post.fleet.require(live.jobId).closed_reason, "forced");
 } finally { restore(); }
 });

 test("S17: late worker events after observed close cannot block forced legacy cleanup", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 post exit", 930);
 await s.post.manager.shutdown(live.jobId);
 s.post.runs.close(live.jobId);
 const at = isoTimestamp();
 const events = [
  { source: "cp", type: "spawned", payload: { pid: 4242 } },
  { source: "pi", type: "agent_start", payload: {} },
  { source: "pi", type: "agent_settled", payload: {} },
  { source: "cp", type: "process_exit", payload: { code: 0, signal: null } },
  { source: "pi", type: "agent_start", payload: {} },
  { source: "pi", type: "turn_start", payload: {} },
  { source: "pi", type: "message_start", payload: { message: { role: "user" } } },
 ].map((event, i) => ({ ...event, seq: i + 1, ts: at, job_id: live.jobId }));
 writeFileSync(join(s.home, paths.eventsFile(live.jobId)), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
 rmSync(join(s.home, paths.statusFile(live.jobId)), { force: true });
 const result = await s.post.tearDown(live.jobId, { force: true });
 assert.equal(result.torn_down, true);
 assert.equal(s.post.fleet.require(live.jobId).phase, "done");
 assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "shutdown_requested").length, 1);
 });

 test("S17: concurrent teardown holds the job claim until the external return settles", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const live = await s.held("S17 concurrent", 931);
 const entered = join(s.home, "return-entered");
 const release = join(s.home, "return-release");
 const restore = gitFault(s.home, "a[0]==='return'", `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(entered)}))process.exit(1);fs.writeFileSync(${JSON.stringify(entered)},'entered');while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);const r=spawnSync(${JSON.stringify(execFileSync("which", ["treehouse"], { encoding: "utf8" }).trim())},a,{stdio:'inherit'});process.exit(r.status??1);`, "treehouse");
 const first = s.post.tearDown(live.jobId);
 try {
  await waitFor(() => existsSync(entered), Boolean, { timeoutMs: 30_000, what: "first teardown enters external return" });
  const second = await s.post.tearDown(live.jobId, { force: true });
  assert.deepEqual([second.torn_down, second.lease_returned, second.failure?.code], [false, false, "job_in_flight"]);
  assert.equal(s.post.fleet.require(live.jobId).phase, "held");
 } finally { writeFileSync(release, "release"); await first; restore(); }
 assert.equal((await first).torn_down, true);
 assert.equal(s.post.fleet.require(live.jobId).phase, "done");
 });

 test("S17: a GitLab squash receipt releases a deleted source branch after later base edits", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1", CP_E2E_GITLAB_TOKEN: "s17-fake-token" } });
 const live = await s.held("S17 GitLab", 932);
 const lab = await startFakeGitlab(t, s.remote);
 await s.post.registry.update("demo", { clone_url: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_E2E_GITLAB_TOKEN" } });
 const url = `${lab.web}/o/lab/-/merge_requests/7`;
 git(live.worktree, "remote", "set-url", "origin", `${lab.web}/o/lab.git`);
 const merged = squashMergeAndDeleteHead(s.repo, live.jobId);
 advanceBase(s.repo, "change.txt", "later edit\n");
 await s.post.fleet.patch(live.jobId, { receipts: [{ kind: "pr", status: "open", title: "GitLab MR", url }] });
 lab.mrs[7] = { body: { id: 9001, iid: 7, source_project_id: 42, target_project_id: 42, state: "merged", source_branch: live.jobId, target_branch: "main", sha: live.head, diff_refs: { head_sha: live.head }, squash_commit_sha: merged, merged_at: isoTimestamp(), web_url: url } };
 const receipt = await s.post.recordMerge({ jobId: live.jobId });
 assert.equal(receipt.receipt.forge?.provider, "gitlab");
 assert.equal(receipt.receipt.head_branch_deleted, true);
 const result = await s.post.tearDown(live.jobId);
 assert.deepEqual([result.torn_down, result.reason], [true, "merged"]);
 assert.equal(s.post.fleet.require(live.jobId).closed_reason, "gated");
 });
