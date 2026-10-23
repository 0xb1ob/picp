import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, LAYOUT, isoTimestamp, paths, SCHEMA_VERSION, type DiffVerdict } from "../../src/contracts.ts";
import { PipelineStore } from "../../src/pipeline.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { formatTeardown } from "../../src/teardown.ts";
import { git, readRunEvents } from "../harness/index.ts";
import { SKIP, startStack } from "./landing-helpers.ts";

for (const [mode, title] of [
 ["pass", "S18: teardown review pass"], ["bound", "S18: teardown review bound"],
 ["truncated", "S18: teardown review truncated"], ["flagged", "S18: teardown review flagged"],
 ["policy", "S18: teardown review policy"], ["stale", "S18: teardown review stale"],
 ["revise", "S18: teardown review revise"], ["force", "S18: teardown review force"],
 ["none", "S18: teardown review none"], ["silent", "S18: teardown review silent"], ["off", "S18: teardown review off"],
] as const) {
 test(title, { skip: SKIP, timeout: 120_000 }, async (t) => {
  const s = await startStack(t);
  const live = await s.held(`S18 review ${mode}`, 981);
  if (mode === "bound") {
   const branch = `${live.jobId}-bound`;
   git(live.worktree, "branch", "-m", branch);
   git(live.worktree, "push", "--quiet", "origin", branch);
   await s.post.fleet.patch(live.jobId, { branch, bound_pr: { number: 981, url: live.prUrl, base: "main" } });
  }
  let usage;
  if (mode === "pass") {
   await s.post.manager.shutdown(live.jobId);
   usage = JSON.parse(readFileSync(join(s.home, paths.statusFile(live.jobId)), "utf8")).usage;
   assert.ok(usage.total_tokens > 0);
   await s.post.fleet.patch(live.jobId, { usage: EMPTY_USAGE });
  }
  if (mode !== "none") new PipelineStore(s.home).write({ schema_version: SCHEMA_VERSION,
   research_id: `${live.jobId}-research`, ship_id: live.jobId, project: "demo", delivery: "pr", state: "implementing",
   created_at: isoTimestamp(), updated_at: isoTimestamp(), ...(mode === "silent" ? {} : { review: { enabled: mode !== "off" } }) });
  const review = (verdict: DiffVerdict["verdict"], attempt = 1, head = live.head) => atomicWriteJson(join(s.home, paths.reviewFile(live.jobId, attempt)), {
   schema_version: SCHEMA_VERSION, job_id: live.jobId, attempt, verdict,
   cause: verdict === "escalate" ? (mode === "policy" || mode === "none" ? "policy" : "flagged") : null,
   flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["legacy review"],
   decided_at: isoTimestamp(), head_sha: head, diff_stat: { files: 1, truncated: mode === "truncated" },
  });
  const checkpoint = (decision: "pending" | "approved") => atomicWriteJson(join(s.home, paths.checkpointFile(live.jobId, "diff")), {
   schema_version: SCHEMA_VERSION, job_id: live.jobId, question: "Ship reviewed work?", requested_at: isoTimestamp(), decision,
   ...(decision === "approved" ? { decided_at: isoTimestamp(), decided_by: "operator" } : {}),
  });
  const refused = async (code: string) => {
   const result = await s.post.tearDown(live.jobId);
   assert.deepEqual([result.torn_down, result.lease_returned, result.failure?.code], [false, false, code]);
   assert.equal(s.post.fleet.require(live.jobId).phase, "held");
   return result;
  };
  if (["pass", "bound", "force"].includes(mode)) {
   assert.match((await refused("review_missing")).failure?.fix ?? "", /cp_review/);
   if (mode !== "force") review("pass");
  } else if (mode === "flagged" || mode === "policy") {
   review("escalate");
   await refused("review_escalated");
   checkpoint("pending");
   await refused("review_escalated");
   checkpoint("approved");
   if (mode === "policy") { assert.match((await refused("review_escalated")).failure?.message ?? "", /policy/); return; }
  } else if (mode === "truncated") {
   review("pass");
   assert.match((await refused("review_escalated")).failure?.message ?? "", /truncated subject/);
   review("escalate", 2); checkpoint("approved");
   await refused("review_escalated");
   review("pass", 3, "f".repeat(40)); await refused("review_pending"); return;
  } else if (mode === "stale" || mode === "revise") {
   review(mode === "stale" ? "pass" : "revise", 1, mode === "stale" ? "0".repeat(40) : live.head);
   const result = await refused("review_pending");
   assert.match(result.failure?.message ?? "", mode === "stale" ? /HEAD is/ : /attempt 1/);
   review("pass", 2);
  } else review("escalate");
  const result = await s.post.tearDown(live.jobId, mode === "force" ? { force: true } : {});
  assert.deepEqual([result.torn_down, result.lease_returned, result.reason], [true, true, mode === "force" ? undefined : "pushed"]);
  assert.equal(s.post.fleet.require(live.jobId).closed_reason, mode === "force" ? "forced" : "gated");
  assert.notEqual((await s.post.ledger().show(live.jobId)).status, "closed");
  if (mode === "pass") assert.deepEqual(s.post.fleet.require(live.jobId).usage, usage);
  if (mode === "force") assert.ok(readRunEvents(s.home, live.jobId).some((e) => e.type === "shutdown_requested" && (e.payload as { forced?: boolean }).forced === true));
 });
}

for (const [delivery, title] of [
 ["answer", "S18: research answer ledger closure survives a write failure"],
 ["pipeline", "S18: research pipeline ledger closure survives a write failure"],
] as const) {
 test(title, { skip: SKIP, timeout: 120_000 }, async (t) => {
  const s = await startStack(t);
  const live = await s.held("S18 legacy research", 982);
  await s.post.manager.shutdown(live.jobId);
  git(live.worktree, "reset", "--soft", "origin/main");
  git(live.worktree, "restore", "--staged", ".");
  git(live.worktree, "clean", "-fd");
  await s.post.fleet.mutate((jobs) => { const r = jobs.find((r) => r.job_id === live.jobId)!; r.kind = "research"; r.delivery = delivery; });
  new PipelineStore(s.home).write({ schema_version: SCHEMA_VERSION, research_id: `${live.jobId}-research`,
   ship_id: live.jobId, project: "demo", delivery: "pr", state: "implementing", created_at: isoTimestamp(), updated_at: isoTimestamp(), review: { enabled: true } });
  const artifact = join(s.home, "findings.md");
  writeFileSync(join(s.home, paths.envelopeFile(live.jobId)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: live.jobId,
   received_at: isoTimestamp(), attempt: 1, envelope: { job_id: live.jobId, kind: "research", status: "done", summary: "Findings ready", artifact_path: artifact } }));
  const file = s.post.ledger().file;
  const dir = dirname(file);
  const original = readFileSync(file, "utf8");
  if (delivery === "answer") chmodSync(dir, 0o555);
  else writeFileSync(file, JSON.stringify({ ...JSON.parse(original), unexpected: true }));
  let first;
  try { first = await s.post.tearDown(live.jobId); }
  finally {
   chmodSync(dir, 0o755);
   if (delivery === "pipeline") writeFileSync(file, original);
  }
  assert.equal(first.torn_down, true);
  assert.equal(first.lease_returned, true);
  assert.ok(first.ledger_close_error, "ledger write failure is visible");
  assert.doesNotMatch(first.ledger_close_error, /\n/);
  if (delivery === "pipeline") assert.equal(first.ledger_close_error, `${file} violates the jobs contract:`);
  assert.match(formatTeardown(first), /re-run cp_teardown/);
  const failures = () => {
   const wakeups = JSON.parse(readFileSync(join(s.home, LAYOUT.wakeupsFile), "utf8"));
   return [...wakeups.pending, ...wakeups.delivered].filter((r) => r.id === `ledger-close-failed:${live.jobId}`);
  };
  assert.equal(failures().length, 1);
  assert.deepEqual([failures()[0].kind, failures()[0].job_id], ["recovery", live.jobId]);
  assert.notEqual((await s.post.ledger().show(live.jobId)).status, "closed");
  const second = await s.post.tearDown(live.jobId);
  assert.deepEqual([second.torn_down, second.lease_returned, second.ledger_closed], [false, false, true]);
  assert.match(formatTeardown(second), /ledger close was retried/);
  assert.equal(failures().length, 1, "retry adds no recovery notification");
  const closed = await s.post.ledger().show(live.jobId);
  assert.equal(closed.close_reason, delivery === "answer" ? "answered: Findings ready" : `researched: ${artifact}`);
  assert.equal((await s.post.ledger().ready()).some((r) => r.id === live.jobId), false);
  assert.equal((await s.post.tearDown(live.jobId)).ledger_closed, undefined);
  assert.equal(failures().length, 1, "third call adds no recovery notification");
 });
}

test("S18: done research ledger retry respects report, envelope, edit and ship guards", { skip: SKIP, timeout: 120_000 }, async (t) => {
 const s = await startStack(t);
 const rows = new Map<string, string>();
 for (const mode of ["eligible", "startup", "unreported", "no-envelope", "edited", "ship"]) {
  const live = await s.seed(`S18 ${mode}`);
  rows.set(mode, live.jobId);
  await s.post.fleet.mutate((jobs) => {
   const r = jobs.find((r) => r.job_id === live.jobId)!;
   r.kind = mode === "ship" ? "ship" : "research";
   r.phase = "done"; r.closed_reason = "gated";
   r.closed_at = mode === "edited" ? "2020-01-01T00:00:00Z" : isoTimestamp(new Date(Date.now() + 60_000));
   if (mode === "unreported") delete r.reported_at;
  });
  mkdirSync(join(s.home, paths.runDir(live.jobId)), { recursive: true });
  if (mode !== "no-envelope") writeFileSync(join(s.home, paths.envelopeFile(live.jobId)), JSON.stringify({
   schema_version: SCHEMA_VERSION, job_id: live.jobId, received_at: isoTimestamp(), attempt: 1,
   envelope: { job_id: live.jobId, kind: mode === "ship" ? "ship" : "research", status: "done", summary: mode },
  }));
 }
 const eligible = await s.post.tearDown(rows.get("eligible")!);
 assert.deepEqual([eligible.torn_down, eligible.lease_returned, eligible.ledger_closed], [false, false, true]);
 const wakeups = () => existsSync(join(s.home, LAYOUT.wakeupsFile)) ? readFileSync(join(s.home, LAYOUT.wakeupsFile), "utf8") : "";
 const before = wakeups();
 const calls = join(s.home, "startup-treehouse-calls");
 const real = execFileSync("which", ["treehouse"], { encoding: "utf8" }).trim();
 const shim = join(s.home, "bin", "treehouse");
 writeFileSync(shim, `#!/usr/bin/env node\nconst {appendFileSync}=require('node:fs');const {spawnSync}=require('node:child_process');appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');const r=spawnSync(${JSON.stringify(real)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`);
 chmodSync(shim, 0o755);
 try {
  const probe = await s.held("S18 PATH observation", 983);
  const returned = await s.post.tearDown(probe.jobId);
  assert.equal(returned.lease_returned, true);
  assert.ok(existsSync(calls), "CommandPost lease return must reach the startup shim");
  assert.ok(readFileSync(calls, "utf8").split("\n").filter(Boolean).some((line) => JSON.parse(line)[0] === "return"),
   "CommandPost lease return must be observed through the startup shim");
  rmSync(calls);
  await s.post.reconcile();
 }
 finally { rmSync(shim); }
 assert.equal(existsSync(calls), false, "startup ledger retry never touches a lease");
 assert.equal(wakeups(), before, "successful startup retry adds no recovery notification");
 for (const [mode, id] of rows) {
  assert.equal((await s.post.ledger().show(id)).status === "closed", mode === "eligible" || mode === "startup", mode);
  const result = await s.post.tearDown(id);
  assert.deepEqual([result.torn_down, result.lease_returned, result.ledger_closed], [false, false, undefined], mode);
 }
});
