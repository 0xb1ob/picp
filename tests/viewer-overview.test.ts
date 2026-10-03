import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { overview } from "../src/viewer/overview-view.ts";
import { boardView } from "../src/viewer/jobs-view.ts";
import { createScratchHome } from "./harness/index.ts";
import { EMPTY_USAGE, LAYOUT } from "../src/contracts.ts";
import { OperatorAsks } from "../src/operator-asks.ts";
import { MandateStore, mandateSpend } from "../src/mandate.ts";
import { FleetStore } from "../src/fleet.ts";
import { MainCiStore } from "../src/main-ci.ts";
import { liveUsageJobs } from "../src/mandate-usage.ts";
import { readStatus, resolveStateDir, runtimeRoot } from "../src/viewer/sessions.ts";
import type { RunRegistry } from "../src/runs.ts";
process.env.TZ = "UTC";
const now = Date.parse("2026-09-26T12:00:00Z");
function fixture(t: {after(fn: () => void): void}) {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const state = {home: home.path, stateDir: join(home.path, LAYOUT.state)};
 const put = (file: string, value: unknown) => { const path = join(home.path, file); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
 return {state, put};
}
const ask = {type:"open", id:"ask-ab12", created_at:"2026-09-26T11:00:00Z", project:"demo", question:"Raise cap?", options:[{label:"Keep",consequence:"Paused"}], recommendation:"Keep", source_escalation:"es-1"};

test("asks and parent escalations stay distinct; only delegated answers count today", t => {
 const {state, put} = fixture(t);
 put(join(LAYOUT.state, "operator/asks.jsonl"), `${JSON.stringify(ask)}\n{"type":`);
 put(LAYOUT.escalationsFile, {items:[
  {id:"es-1",status:"open",question:"Raise cap?",created_at:ask.created_at,kind:"budget_exhausted",job_ids:["cp-a"]},
  {id:"es-old",status:"withdrawn",question:"Withdrawn?",created_at:ask.created_at,job_ids:[]},
  {id:"es-2",status:"open",question:"Other?",created_at:ask.created_at,kind:"product_ambiguity",job_ids:[]},
  ...["operator-delegated", "operator-quote", "mandate"].map((by,i) => ({id:`es-d${i}`, status:"answered", question:"Ship?", created_at:ask.created_at, answered_at:ask.created_at, answered_by:by, answer:"yes", options:[{id:"yes",label:"Ship it"}], job_ids:[]})),
 ]});
 const data = overview(state, now);
 assert.equal(data.awaiting.count, 1); assert.equal(data.awaiting.items[0]?.options[0]?.reply, "ask-ab12: Keep");
 assert.deepEqual(data.parent_questions.map(q => q.id), ["es-2"]);
 assert.equal(data.parent_questions[0]?.age_seconds, 3600);
 assert.equal(data.decided_today.count, 1); assert.equal(data.decided_today.items[0]?.answer, "Ship it");
 assert.equal(data.all_questions_delegated, false); assert.deepEqual(data.fleet.operator, {running:false, pid:null, since:null, held:0}); assert.deepEqual(data.services, {health:null}); assert.equal(data.quota, null);
});

test("corrupt and over-limit ask journals are unavailable without hiding valid fleet data", t => {
 const {state, put} = fixture(t);
 put(LAYOUT.fleetFile, {jobs:[{job_id:"cp-a", project:"demo", phase:"held"}]});
 for (const journal of ["not json\n", `${JSON.stringify(ask)}\n${JSON.stringify(ask)}\n`, "x".repeat(16*1024*1024+1)]) {
  put(join(LAYOUT.state, "operator/asks.jsonl"), journal);
  const data = overview(state, now);
  assert.equal(data.availability.asks, "unavailable"); assert.equal(data.awaiting.count, null);
  assert.equal(data.in_flight[0]?.phase, "held"); assert.ok(data.warnings.some(w => w.section === "asks"));
 }
});

test("shipment requires an actual merge today and current review evidence rejects old/truncated passes", t => {
 const {state, put} = fixture(t); const head = "a".repeat(40);
 put(LAYOUT.fleetFile, {jobs:[{job_id:"cp-a",project:"demo",phase:"held",bounds:{wall_clock_seconds:100}}]});
 put(join(LAYOUT.runs, "cp-a/status.json"), {phase:"idle",started_at:"2026-09-26T11:00:00Z"});
 put(join(LAYOUT.runs, "cp-a/envelope.json"), {envelope:{head_sha:head}});
 put(join(LAYOUT.runs, "cp-a/review-1.json"), {verdict:"pass",head_sha:"b".repeat(40),diff_stat:{truncated:false}});
 put(join(LAYOUT.runs, "cp-a/merge.json"), {job_id:"cp-a", pr_url:"https://github.com/acme/repo/pull/1", merge_commit_sha:head, recorded_at:ask.created_at});
 let data = overview(state, now);
 assert.equal(data.shipped_today.length, 0); assert.equal(data.in_flight[0]?.review, null);
 assert.equal(data.in_flight[0]?.elapsed_seconds, 3600); assert.equal(data.fleet.workers.live, 1);
 put(`${LAYOUT.runs}/cp-a/review-equivalent-${head}.json`, {verdict:"pass",head_sha:head,diff_stat:{truncated:false}});
 put(join(LAYOUT.runs, "cp-a/merge.json"), {job_id:"cp-a", pr_url:"https://github.com/acme/repo/pull/1", merge_commit_sha:head, merged_at:ask.created_at});
 data = overview(state, now); assert.equal(data.in_flight[0]?.review, "pass"); assert.equal(data.shipped_today.length, 1);
 put(`${LAYOUT.runs}/cp-a/review-equivalent-${head}.json`, {verdict:"pass",head_sha:head,diff_stat:{truncated:true}});
 assert.equal(overview(state, now).in_flight[0]?.review, null);
});

test("audit P2 #12: Landed today is merged plus closed without PR, the same total as the Board's column", t => {
 const {state, put} = fixture(t); const sha = "c".repeat(40); const at = "2026-09-26T10:00:00Z";
 const job = (id: string, status: string, closed_at?: string) => ({id, title:id, status, labels:["project:demo","kind:ship"], ...(closed_at ? {closed_at} : {})});
 put(".pi-command-post/jobs.json", {jobs:[job("cp-merged","closed",at), job("cp-closed","closed",at), job("cp-ledger","closed",at), job("cp-old","closed","2026-09-20T10:00:00Z"), job("cp-held","in_progress")]});
 put(LAYOUT.fleetFile, {jobs:[
  {job_id:"cp-merged",project:"demo",phase:"done",dispatched_at:at,closed_at:at},
  {job_id:"cp-closed",project:"demo",phase:"done",dispatched_at:at,closed_at:at},
  {job_id:"cp-old",project:"demo",phase:"done",dispatched_at:at,closed_at:"2026-09-20T10:00:00Z"},
  {job_id:"cp-held",project:"demo",phase:"held",dispatched_at:at}]});
 put(join(LAYOUT.runs, "cp-merged/merge.json"), {job_id:"cp-merged", pr_url:"https://github.com/acme/repo/pull/2", merge_commit_sha:sha, merged_at:at});
 const data = overview(state, now);
 assert.deepEqual([data.shipped_today.map(j => j.id), data.closed_today], [["cp-merged"], 2], "a done fleet job and a ledger-only close, never the old one or the held one");
 const board = boardView(state, now);
 assert.equal(board.jobs.filter(j => j.phase === "done").length, data.shipped_today.length + (data.closed_today ?? 0));
 put(LAYOUT.fleetFile, "{broken"); assert.equal(overview(state, now).closed_today, null);
});

test("audit P3 #17 #19 #20: failed jobs with a one-line cause, the main-ci latch as MainCiStore writes it, and merged cost", t => {
 const {state, put} = fixture(t); const sha = "d".repeat(40); const at = "2026-09-26T10:00:00Z";
 put(".pi-command-post/jobs.json", {jobs:[{id:"cp-dead",title:"Died",status:"in_progress",labels:[]}]});
 put(LAYOUT.fleetFile, {jobs:[
  {job_id:"cp-dead",project:"demo",phase:"failed",failure:{at,message:"fleet cause"}},
  {job_id:"cp-long",project:"demo",phase:"failed",failure:{at,message:`\n${"x".repeat(120)}\nsecond line`}},
  {job_id:"cp-held",project:"demo",phase:"held",failure:{at,message:"old 503"}},
  {job_id:"cp-merged",project:"demo",phase:"done",dispatched_at:at,closed_at:at,usage:{...EMPTY_USAGE,cost_usd:1.25,total_tokens:10}}]});
 put(join(LAYOUT.runs, "cp-dead/status.json"), {phase:"exited",failure:{at,message:"provider 503: overloaded"}});
 put(join(LAYOUT.runs, "cp-merged/merge.json"), {job_id:"cp-merged", pr_url:"https://github.com/acme/repo/pull/3", merge_commit_sha:sha, merged_at:at});
 let data = overview(state, now);
 assert.deepEqual(data.failed, [{id:"cp-dead",project:"demo",title:"Died",failure:"provider 503: overloaded"}, {id:"cp-long",project:"demo",title:null,failure:`${"x".repeat(79)}…`}], "the run's failure wins; first line, 80 chars; a held job's old failure is not a failed job");
 assert.deepEqual(data.shipped_today.map(j => [j.id, j.cost_usd]), [["cp-merged", 1.25]]);
 assert.equal(data.shipped_today[0]?.cost_usd, boardView(state, now).jobs.find(j => j.id === "cp-merged")?.cost_usd, "the same cost the Jobs list shows");
 assert.deepEqual(data.main_ci, {availability:"missing", red:[]}, "no latch file: no latch, never green");
 const store = new MainCiStore({home: state.home, now: () => new Date(at)});
 store.setRed("demo", sha, {workflow:"ci", failing:"AssertionError: x"});
 data = overview(state, now);
 assert.deepEqual(data.main_ci, {availability:"ok", red:[{project:"demo", red_since_sha:sha, red_since_at:at, workflow:"ci", failing:"AssertionError: x"}]});
 store.clear("demo"); assert.deepEqual(overview(state, now).main_ci, {availability:"ok", red:[]});
 put(join(LAYOUT.state, "main-ci.json"), "{broken"); assert.equal(overview(state, now).main_ci.availability, "unavailable");
 put(join(LAYOUT.state, "main-ci.json"), {schema_version:1, updated_at:at, projects:[{project:"demo", red_since_sha:"not a sha", red_since_at:at}]}); assert.equal(overview(state, now).main_ci.availability, "unavailable", "an off-schema row is unreadable, never a silent no-latch");
});

test("missing and dropped blockers stay unresolved; corrupt grants cannot claim no stranded dependencies", t => {
 const {state, put} = fixture(t);
 put(".pi-command-post/jobs.json", {jobs:[{id:"cp-a",title:"Waits on a dropped job",status:"open",blocked_by:["cp-missing","cp-dropped"],labels:[]}, {id:"cp-dropped",status:"closed",close_reason:"dropped: no longer needed",blocked_by:[],labels:[]}]});
 assert.equal(overview(state, now).blocked.stranded_count, 2);
 assert.deepEqual(overview(state, now).blocked.items.map(j => [j.id,j.title,j.blockers.map(b => b.id)]), [["cp-a","Waits on a dropped job",["cp-missing","cp-dropped"]]]);
 put(join(LAYOUT.mandates, "md-bad.json"), "{bad");
 assert.equal(overview(state, now).blocked.stranded_count, null);
});

test("a flat standard home: the overview reads its fleet and ledger directly under the home (cp-daemon v1 P1)", t => {
 const scratch = createScratchHome(); t.after(() => scratch.cleanup());
 const flat = `${scratch.path}/.pi-command-post`;
 const put = (file: string, value: unknown) => { const path = `${flat}/${file}`; mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, JSON.stringify(value)); };
 put("state/fleet.json", {jobs:[{job_id:"cp-a", project:"demo", phase:"held"}]});
 put("jobs.json", {jobs:[{id:"cp-b",title:"Blocked on a missing job",status:"open",blocked_by:["cp-missing"],labels:[]}]});
 assert.equal(runtimeRoot(flat), flat); assert.equal(resolveStateDir(flat), `${flat}/state`);
 assert.equal(runtimeRoot(scratch.path), join(scratch.path, LAYOUT.runtimeDir));
 const data = overview({home: flat, stateDir: resolveStateDir(flat)}, now);
 assert.deepEqual(data.in_flight.map(j => [j.id, j.phase]), [["cp-a", "held"]]);
 assert.deepEqual(data.blocked.items.map(j => j.id), ["cp-b"]);
});

test("asks fold like the operator store without writing, and day boundaries use host timezone", t => {
 const {state,put} = fixture(t);
 const store = new OperatorAsks(join(state.stateDir,"operator","asks.jsonl"));
 const input = {project:"demo",question:"Proceed?",options:[{label:"Yes",consequence:"Continue"}],recommendation:"Yes"};
 const first = store.open(input); store.answer(first.id,"Yes");
 const second = store.open(input); store.withdraw(second.id,"No longer needed");
 const open = store.open(input);
 assert.deepEqual(overview(state,now).awaiting.items.map(a => a.id),store.open().map(a => a.id));
 assert.equal(overview(state,now).awaiting.items[0]?.id,open.id);
 put(LAYOUT.escalationsFile,{items:["2026-09-25T23:59:59Z","2026-09-26T00:00:00Z"].map((at,i) => ({id:`es-day${i}`,status:"answered",question:"Proceed?",created_at:at,answered_at:at,answered_by:"operator-delegated",answer:"yes"}))});
 assert.equal(overview(state,now).decided_today.count,1);
 assert.equal("time_zone" in overview(state,now),false,"the server zone never reaches the page");
});

test("mandates keep full objectives, full revoked counts and canonical reviewer/noncached accounting", t => {
 const {state,put} = fixture(t);
 const grants = new MandateStore(state.home);
 const active = grants.issue({projects:["demo"],objective:"Long objective ".repeat(30),expiry:"2026-09-27T12:00:00Z",spend_cap:{usd:100,tokens:10000},job_cap:10,at:"2026-09-26T00:00:00Z"});
 for (let i=0;i<7;i++) grants.revoke(grants.issue({projects:["demo"],objective:`Old ${i}`,expiry:"2026-09-27T12:00:00Z",spend_cap:{usd:10,tokens:1000},job_cap:2,at:"2026-09-26T00:00:00Z"}).id);
 put(LAYOUT.fleetFile,{schema_version:1,updated_at:"2026-09-26T11:00:00Z",jobs:[{job_id:"cp-work",project:"demo",kind:"ship",delivery:"pr",origin:"terminal",phase:"waiting",worker:{pid:4242,session_id:"s",session_file:"/s.jsonl",profile:"implementer",role:"implementer",model:"m",started_at:"2026-09-26T00:00:00Z"},worktree:"/unused",branch:"cp-work",dispatched_at:"2026-09-26T00:00:00Z",usage:{...EMPTY_USAGE,cost_usd:1,total_tokens:100,cache_read:40}}]});
 put(join(LAYOUT.runs, "cp-work/status.json"),{phase:"working",usage:{...EMPTY_USAGE,cost_usd:2,total_tokens:200,cache_read:50}});
 put(join(LAYOUT.runs, "cp-work/review-1/status.json"),{schema_version:1,job_id:"cp-work",phase:"idle",turns:1,tool_calls:0,usage:{input:20,output:10,cache_read:0,cache_write:0,total_tokens:30,cost_usd:0.5},started_at:"2026-09-26T00:00:00Z",last_activity_at:"2026-09-26T00:00:00Z",event_count:1,reported:false});
 const data = overview(state,now); const item = data.mandates.items.find(m => m.id === active.id)!;
 assert.equal(item.objective,active.objective); assert.equal(data.mandates.revoked_hidden_count,7);assert.equal(data.mandates.active_count,1);
 const jobs = grants.withReviewerSpend(liveUsageJobs(new FleetStore({home:state.home}),{get:(id:string) => ({status:readStatus(state,id)})} as unknown as RunRegistry));
 assert.deepEqual(item.spend,mandateSpend(active,jobs));
 assert.equal(item.spend?.tokens,180); assert.equal(item.spend?.usd,2.5);
 put(join(LAYOUT.mandates, "md-paused.json"),{id:"md-paused",status:"paused",projects:["paused-project"],issued_at:"2026-09-25T00:00:00Z",expiry:"2026-09-25T12:00:00Z",objective:"Paused",spend_cap:{usd:10,tokens:1000}});
 assert.deepEqual(overview(state,now).mandates.paused_projects,["paused-project"]);
});

test("quota is bounded historical evidence; admin scores only, cache refreshes after append", t => {
 const {state,put} = fixture(t);
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-a",project:"demo",phase:"waiting",dispatched_at:"2026-09-26T11:00:00Z"}]});
 const event = (source:string,at:string) => ({source:"cp",type:"routing_resolved",ts:at,payload:{scope:"M",risk:"high",provenance:{risk:"explicit"},quota:{providers:[{provider:"anthropic",five_hour:62,seven_day:86,tight:true}]},capacity:{source,scores:[{provider:"anthropic",score:3}]}}});
 put(join(LAYOUT.runs, "cp-a/events.jsonl"),`${JSON.stringify(event("fleet","2026-09-26T11:00:00Z"))}\n`);
 assert.equal(overview(state,now).quota?.providers[0]?.free_slots,null);
 assert.match(overview(state,now).in_flight[0]?.routing ?? "",/risk:high \(explicit\)/);
 put(join(LAYOUT.runs, "cp-a/events.jsonl"),`${JSON.stringify(event("admin","2026-09-26T11:01:00Z"))}\n`);
 const quota = overview(state,now).quota!;
 assert.equal(quota.historical,true);assert.equal(quota.source_job_id,"cp-a");assert.equal(quota.observed_at,"2026-09-26T11:01:00Z");assert.equal(quota.providers[0]?.free_slots,3);
 put(join(LAYOUT.runs, "cp-a/events.jsonl"),`${" ".repeat(256*1024)}\n${JSON.stringify(event("admin","2026-09-26T11:02:00Z"))}\n`);
 assert.equal(overview(state,now).quota,null);
});

test("single-project layout, script health and unknown sources never invent operator or parent liveness", t => {
 const {state,put} = fixture(t); const single = {...state,stateDir:join(state.home,".pi-command-post","state")};
 put(".pi-command-post/state/fleet.json",{jobs:[{job_id:"cp-script",project:"demo",phase:"held",executor:"script",script_path:"scripts/run.sh"},{job_id:"cp-unknown",project:"demo",phase:"waiting"}]});
 put(".pi-command-post/state/runs/cp-script/status.json",{phase:"idle"});
 put(".pi-command-post/state/sessions/cp-parent-context.json",{contextTokens:23000,lastTurnCostUsd:0.041});
 put(".pi-command-post/data/parent.json",{compact_at_tokens:300000});
 put(".pi-command-post/state/sessions/cp-parent-control.json",{model:"recorded-model",token:"must-not-leak"});
 const data = overview(single,now);
 assert.equal(data.fleet.parent.activity,"unknown");assert.equal(data.fleet.parent.compact_at_tokens,300000);assert.equal(data.fleet.parent.model,"recorded-model");assert.equal(data.fleet.operator.running,false);
 assert.equal(data.fleet.workers.live,1);assert.equal(data.fleet.workers.unknown,1);assert.equal(data.in_flight[0]?.script_path,"scripts/run.sh");assert.equal(data.in_flight[0]?.model,null);
 assert.doesNotMatch(JSON.stringify(data),/must-not-leak/);
 assert.equal(data.fleet.parent.pid,null); assert.equal(data.fleet.parent.alive,false,"no lock file is down, never alive"); assert.equal(data.fleet.parent.stale_since,null);
 put(".pi-command-post/state/parent.lock",{pid:4242,started_at:"2026-09-26T10:00:00Z",home:state.home});
 const stale = overview(single,now,() => false);
 assert.equal(stale.fleet.parent.pid,4242,"the recorded lock holder stays a fact, never a liveness claim"); assert.equal(stale.fleet.parent.alive,false); assert.equal(stale.fleet.parent.stale_since,"2026-09-26T10:00:00Z","a lock a crashed parent left behind names when");
 const held = overview(single,now,() => true); assert.equal(held.fleet.parent.alive,true); assert.equal(held.fleet.parent.stale_since,null,"a live holder leaves nothing stale");
 put(".pi-command-post/state/parent.lock",{pid:process.pid,started_at:"2026-09-26T10:00:00Z",home:state.home,session_id:"live-holder"});
 assert.equal(overview(single,now).fleet.parent.alive,true,"the production probe is process.kill(pid, 0), not a fixed answer");
 put(".pi-command-post/state/fleet.json","{broken"); assert.equal(overview(single,now).fleet.workers.live,null);
});

test("malformed optional status, routing timestamps and receipts stay unknown without crashing the projection", t => {
 const {state,put} = fixture(t); const invalid = {toString:null};
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-a",project:"demo",phase:"held",dispatched_at:invalid},{job_id:"cp-b",project:"demo",phase:"waiting",dispatched_at:invalid}]});
 put(join(LAYOUT.runs, "cp-a/status.json"),{phase:invalid});
 put(join(LAYOUT.runs, "cp-a/merge.json"),{job_id:"cp-a",pr_url:invalid,merge_commit_sha:invalid});
 const data = overview(state,now);
 assert.equal(data.fleet.workers.unknown,2);assert.equal(data.in_flight[0]?.elapsed_seconds,null);assert.deepEqual(data.shipped_today,[]);assert.equal(data.quota,null);
});

test("a deferred ledger job is a valid status: the ledger stays available instead of being rejected whole", t => {
 const {state, put} = fixture(t); const at = "2026-09-26T10:00:00Z";
 put(".pi-command-post/jobs.json", {jobs:[{id:"cp-later",title:"Later",status:"deferred",labels:["project:demo"]}, {id:"cp-done",title:"Done",status:"closed",closed_at:at,labels:["project:demo"]}]});
 put(LAYOUT.fleetFile, {jobs:[]});
 assert.equal(overview(state, now).closed_today, 1, "a deferred row must not make the whole ledger unavailable");
 assert.ok(boardView(state, now).jobs.some(j => j.id === "cp-later"), "the deferred job is listed");
});
