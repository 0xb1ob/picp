import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AnsweredOutbox } from "../../src/answered.ts";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { PipelineStore } from "../../src/pipeline.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, readRunEvents, REPO_ROOT, startPiChild, waitFor } from "../harness/index.ts";
import { SKIP, run, startStack } from "./landing-helpers.ts";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

for (const [action, busy, title] of [
 ["no_mandate", false, "S23: native answered no_mandate stays durable while idle"],
 ["no_mandate", true, "S23: native answered no_mandate stays durable while busy"],
 ["wait", false, "S23: native answered wait stays durable while idle"],
 ["wait", true, "S23: native answered wait stays durable while busy"],
 ["draining", false, "S23: native answered draining stays durable while idle"],
 ["draining", true, "S23: native answered draining stays durable while busy"],
 ["dispatch", false, "S23: native answered dispatch stays durable while idle"],
 ["dispatch", true, "S23: native answered dispatch stays durable while busy"],
 ["pipeline", false, "S23: native answered pipeline stays durable while idle"],
 ["pipeline", true, "S23: native answered pipeline stays durable while busy"],
 ["paused", false, "S23: native answered paused stays durable while idle"],
 ["paused", true, "S23: native answered paused stays durable while busy"],
 ["mission_end", false, "S23: native answered mission_end stays durable while idle"],
 ["mission_end", true, "S23: native answered mission_end stays durable while busy"],
] as const) {
 test(title, { timeout: 110_000 }, async (t) => {
  const home = createScratchHome();
  initJobsDocument(home.path, "cp");
  const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
  await post.registry.register({ name: "demo", clone_url: home.path, delivery: "local" });
  if (action !== "no_mandate" && action !== "draining") {
   const job = await post.ledger().create({ title: "Independent S23 work", project: "demo", delivery: "local", kind: "ship" });
   const grant = post.mandates.issue({ projects: ["demo"], objective: "S23 answer routing", job_ids: [job.id], expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10, ask_on: [] });
   if (action === "paused") post.mandates.pause(grant.id, "operator");
   if (action === "mission_end") await post.ledger().close(job.id, "dropped: fixture cancelled");
   if (action === "wait") await post.ledger().claim(job.id, "fixture");
   if (action === "pipeline") new PipelineStore(home.path).write({ schema_version: SCHEMA_VERSION,
    research_id: job.id, ship_id: "cp-s23-ship", project: "demo", delivery: "local", state: "researching", created_at: isoTimestamp(), updated_at: isoTimestamp() });
  }
  await post.shutdown();
  const provider = await MockProvider.start();
  let release = () => {};
  const until = new Promise<void>((resolve) => { release = resolve; });
  const model = provider.addScript("s23-native", [...(busy ? [{ kind: "hang" as const, until }] : []), { kind: "text", text: "S23 received." }], { onExhausted: "repeat" });
  const agent = createAgentDir({ provider });
  chmodSync(agent.path, 0o700);
  const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION], sessionDir: join(home.path, "sessions") });
  t.after(async () => { release(); await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
  await child.getState();
  if (busy) {
   await child.prompt("S23 busy operator turn");
   await waitFor(() => provider.requests("s23-native").length, (count) => count === 1, { timeoutMs: 15_000, what: "busy request" });
  }
  if (action === "draining") {
   mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
   writeFileSync(join(home.path, LAYOUT.state, "drain.json"), JSON.stringify({ state: "drained", reported: true, started_at: isoTimestamp(), finished_at: isoTimestamp(), deadline: "2099-01-01T00:00:00Z", timeout_s: 999999, jobs: [] }));
  }
  const box = new AnsweredOutbox({ home: home.path });
  const jobsFile = join(home.path, LAYOUT.jobsFile);
  const jobs = readFileSync(jobsFile, "utf8");
  const retryNext = busy && action === "no_mandate";
  if (retryNext) writeFileSync(jobsFile, "{broken");
  box.enqueue({ id: "aw-s23-native", type: "approval", decision: `S23_NATIVE_${action}`, answer: "continue", answered_by: "operator dialog (tui)" });
  if (retryNext) {
   await waitFor(() => JSON.stringify(child.records()), (text) => text.includes("answered wake-up failed; answer remains queued"), { timeoutMs: 15_000, what: "failed next read is visible" });
   assert.equal(box.read().sends?.length ?? 0, 0, "failed next read reserves no emission");
   assert.equal(box.pending().length, 1);
   writeFileSync(jobsFile, jobs);
  }
  await waitFor(() => box.read(), (state) => (state.sends?.length ?? 0) + state.delivered.length > 0, { timeoutMs: 30_000, what: "native decision offered" });
  release();
  const quiet = ["no_mandate", "wait", "draining"].includes(action);
  if (quiet) {
   if (busy) await child.waitForSettled(30_000);
   const quietSince = Date.now();
   await waitFor(() => Date.now() - quietSince, (elapsed) => elapsed > 1500,
    { timeoutMs: 5000, what: "quiet delivery creates no autonomous turn" });
   assert.equal(provider.requests("s23-native").length, busy ? 1 : 0, "quiet delivery creates no autonomous request or stranded nudge");
   await child.prompt("Read the quiet S23 decision");
  }
  await waitFor(() => provider.requests("s23-native"), (rows) => rows.some((row) => JSON.stringify(row.body.messages).includes(`S23_NATIVE_${action}`)), { timeoutMs: 30_000, what: "native decision reaches provider" });
  await child.waitForSettled(30_000);
  assert.match(JSON.stringify(provider.requests("s23-native").flatMap((row) => row.body.messages)), /without calling cp_next again/);
  assert.equal(box.delivered("aw-s23-native"), true, "only arrival confirms the durable receipt");
 });
}


test("S23: a throwing main CI read journals its cause and still delivers the held PR fact", { skip: SKIP, timeout: 110_000 }, async (t) => {
 const s = await startStack(t);
 const tip = execFileSync("git", ["--git-dir", s.remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
 const held = await s.seed("S23 held red", { branch: "main", prUrl: "https://github.com/example/demo/pull/83" });
 s.setGh({ prs: { main: { number: 83, url: held.prUrl! } }, runs: [run(83, tip, "completed", "failure")],
  routes: [{ match: "run view 83 --log-failed", replies: [{ stdout: "S23 held regression" }] }] });
 const mandates = join(s.home, LAYOUT.mandates);
 rmSync(mandates, { recursive: true, force: true });
 writeFileSync(mandates, "not a directory");
 await s.parent("Observe held CI despite the failed main read", [{ kind: "text", text: "Observed." }], async () => {
  await waitFor(() => readFileSync(join(s.home, LAYOUT.state, "wakeups.json"), "utf8"),
   (text) => text.includes("ENOTDIR"), { timeoutMs: 30_000, what: "throwing main read reaches durable journal" });
  await waitFor(s.parentMessages, (text) => text.includes(`${held.jobId}: CI RED on ${tip.slice(0, 12)}`),
   { timeoutMs: 30_000, what: "held PR CI still reaches parent provider" });
 });
});


test("S23: a real failed next read defers the resolve notice once then wakes with a recorded cause", { skip: SKIP, timeout: 110_000 }, async (t) => {
 const s = await startStack(t);
 const held = await s.seed("S23 resolve", { prUrl: false });
 mkdirSync(join(s.home, paths.runDir(held.jobId)), { recursive: true });
 const mandates = join(s.home, LAYOUT.mandates);
 rmSync(mandates, { recursive: true, force: true });
 writeFileSync(mandates, "not a directory");
 s.post.durableWakeups.enqueue({ id: `continuation:${held.jobId}:1:abc123def456:ci:resolve`, kind: "recovery", job_id: held.jobId,
  content: `HELD PR STOPPED — ${held.jobId} (continuation, next: resolve)\nS23_NEXT_UNAVAILABLE` });
 await s.parent("Observe the failed next read", [{ kind: "text", text: "Observed." }], async () => {
  await waitFor(s.parentMessages, (text) => text.includes("S23_NEXT_UNAVAILABLE"), { timeoutMs: 30_000, what: "resolve fallback reaches provider" });
  const rulings = readRunEvents(s.home, held.jobId).filter((event) => event.type === "continuation").map((event) => event.payload as Record<string, unknown>);
  assert.equal(rulings.length, 1, "one ruling after the bounded failed refresh");
  assert.match(String(rulings[0]?.reason), /cp_next unavailable:.*ENOTDIR/);
  assert.equal(rulings[0]?.decision, "woke");
 });
});
