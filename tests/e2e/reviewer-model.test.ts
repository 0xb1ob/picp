import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, type Mandate } from "../../src/contracts.ts";
import { argOf, captureSpawns, createAgentDir, createScratchHome, MockProvider, REPO_ROOT } from "../harness/index.ts";
import { initJobsDocument } from "../../src/ledger.ts";

test("S16: public plan gates select reviewer preferences from current and legacy authority", { timeout: 180_000 }, async (t) => {
 const home = createScratchHome();
 const provider = await MockProvider.start();
 const agent = createAgentDir({ provider });
 const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env } });
 t.after(async () => { await post.shutdown(); agent.cleanup(); await provider.stop(); home.cleanup(); });
 const spawns = captureSpawns(post.manager);
 initJobsDocument(home.path, "cp");
 await post.registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git" });
 mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
 const routing = (model: string) => writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "fallback", role: "gate-reviewer", model, thinking: "high" }] }));
 const base = post.mandates.issue({ projects: ["demo"], objective: "review", expiry: isoTimestamp(new Date(Date.now() + 86400000)), spend_cap: { usd: 10, tokens: 1000000 }, job_cap: 100 });
 const save = (grants: Mandate[]) => {
  rmSync(join(home.path, paths.mandateFile(base.id), ".."), { recursive: true, force: true });
  for (const grant of grants) {
   const file = join(home.path, paths.mandateFile(grant.id));
   mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(grant));
   assert.equal(post.mandates.get(grant.id)?.id, grant.id, "legacy grant passes the persisted schema");
  }
 };
 let index = 0;
 async function check(label: string, grants: (model: string, other: string) => Mandate[], source: string, explicit = false, schedule?: "actual" | "foreign" | "legacy", project = true) {
  const job = await post.ledger().create({ title: label, project: "demo", kind: "research", delivery: "pipeline", ...(schedule === "legacy" ? { labels: ["schedule:sch-aaaaaa"] } : {}) });
  const script = `s16-${++index}`;
  const model = provider.addScript(script, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job.id, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: [label] } }] }]);
  const other = provider.addScript(`${script}-wrong`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job.id, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["wrong reviewer selected"] } }] }]);
  agent.writeModels(provider); routing(model);
  await post.registry.setReviewerModel("demo", project ? source === "mandate" ? other : model : null);
  save(grants(model, other));
  const now = isoTimestamp();
  if (label !== "recordless") await post.fleet.add({ job_id: job.id, project: "demo", kind: "research", delivery: "pipeline", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: isoTimestamp(new Date(Date.now() - 3600000)), usage: EMPTY_USAGE, worktree: home.path, branch: job.id,
   ...(schedule && schedule !== "legacy" ? { schedule_id: schedule === "actual" ? "sch-aaaaaa" : "sch-bbbbbb" } : {}),
   worker: { pid: process.pid, session_id: "legacy", session_file: join(home.path, "legacy.jsonl"), profile: "planner", role: "planner", model: "mock/author", started_at: now } });
  writeFileSync(post.artifacts.path(job.id), "# Goal\nReview this plan.\n");
  if (label.includes('"status":"paused"') || label.includes('"status":"revoked"')) {
   await assert.rejects(post.gate({ jobId: job.id }), /paused|revoked/);
   assert.equal(provider.requests(script).length, 0);
   assert.equal(provider.requests(`${script}-wrong`).length, 0);
   return;
  }
  const started = await post.gate({ jobId: job.id, ...(explicit ? { model } : {}) });
  if (!("key" in started)) assert.fail(`${label}: ${JSON.stringify(started)}`);
  if ("key" in started) { post.reviewRuns.handBack(started.key); await post.reviewRuns.settled(started.key); }
  assert.equal(JSON.parse(readFileSync(join(home.path, paths.gateFile(job.id, 1)), "utf8")).verdict, "pass", `${label}: completed gate`);
  const events = readFileSync(join(home.path, paths.gateRunDir(job.id, 1), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(provider.requests(script).length > 0, true, `${label}: chosen reviewer receives plan`);
  assert.equal(provider.requests(`${script}-wrong`).length, 0, `${label}: rejected reviewer receives nothing`);
  assert.equal(argOf(spawns.at(-1)?.args ?? [], "--model"), model, `${label}: spawned model`);
  assert.equal(argOf(spawns.at(-1)?.args ?? [], "--thinking"), "high", `${label}: reviewer effort`);
  const selected = events.find((event) => event.type === "reviewer_model_selected")?.payload;
  assert.equal(selected?.source, source === "routing" ? undefined : source, `${label}: selection source`);
  if (source !== "routing") assert.equal(selected?.model, model, `${label}: selected model`);
  if (source === "mandate") assert.equal(selected?.mandate_id, label === "newest active" || label === "active before expired" ? "md-neww" : label === "id tie" ? "md-zzzz" : base.id, `${label}: selected grant`);
 }
 const active = (model: string): Mandate => ({ ...base, reviewer_model: model });
 const expired = (model: string): Mandate => ({ ...active(model), status: "expired", expiry: isoTimestamp(new Date(Date.now() - 1800000)) });
 await check("explicit", (_m, wrong) => [active(wrong)], "explicit", true);
 await check("project", () => [], "project");
 await check("active before expired", (m, wrong) => [expired(wrong), { ...active(m), id: "md-neww", issued_at: isoTimestamp(new Date(Date.now() - 600000)) }], "mandate");
 await check("newest active", (m, wrong) => [{ ...active(wrong), issued_at: "2020-01-01T00:00:00Z" }, { ...active(m), id: "md-neww" }], "mandate");
 await check("id tie", (m, wrong) => [active(wrong), { ...active(m), id: "md-zzzz" }], "mandate");
 await check("expired continuation", (m) => [expired(m)], "mandate");
 for (const disqualifier of [{ allowed_actions: ["plan"] }, { projects: ["other"] }, { job_ids: ["cp-other"] }, { exclusions: { job_kinds: ["research"] } }, { schedule_grant: true }, { status: "paused", paused_at: isoTimestamp(), pause_reason: "operator" }, { status: "revoked", revoked_at: isoTimestamp(), revoked_by: { by: "operator", operator_quote: "stop", decided_by: "operator-quote" } }]) {
  await check(JSON.stringify(disqualifier), (_m, wrong) => [{ ...(disqualifier.allowed_actions ? expired(wrong) : active(wrong)), ...disqualifier } as Mandate], "project");
 }
 await check("unset uses routing", () => [], "routing", false, undefined, false);
 await check("recordless", () => [], "routing");
 const scheduleGrant = { ...active(""), schedule_grant: true as const };
 const schedules = [["sch-aaaaaa", base.id], ["sch-bbbbbb", "md-othr"]].map(([id, mandate_id]) => ({ id, mandate_id, name: "review", project: "demo", trigger: { type: "manual" }, job: { title: "review", kind: "research", delivery: "pipeline" }, enabled: true, created_at: isoTimestamp() }));
 writeFileSync(join(home.path, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules }));
 assert.equal(post.mandates.scheduleMandates().get("sch-aaaaaa"), base.id, "legacy schedule passes the persisted schema");
 assert.equal(post.mandates.scheduleMandates().get("sch-bbbbbb"), "md-othr", "foreign schedule names a different grant");
 for (const schedule of ["actual", "foreign", "legacy"] as const) await check(`schedule ${schedule}`, (m, wrong) => [{ ...scheduleGrant, reviewer_model: schedule === "foreign" ? wrong : m }], schedule === "foreign" ? "routing" : "mandate", false, schedule, schedule !== "foreign");
});
