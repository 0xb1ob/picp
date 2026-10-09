import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readPendingSends } from "../src/viewer/control-pending.ts";
import { INBOX_MAX_AGE_MS, controlJournalFile } from "../src/viewer/control-files.ts";
import { LAYOUT } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

test("accepted sends settle by target metadata and 24h TTL, preserving live FIFO and final outcomes", t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state);
 mkdirSync(join(stateDir,"operator"),{recursive:true});
 const now = new Date("2026-10-08T12:00:00Z");
 const since = "2026-10-07T10:00:00Z";
 const session = {running:true,pid:process.pid,since,reason:"running"};
 const transcript = join(home.path,"session.jsonl"); writeFileSync(transcript, "");
 const rows: object[] = [];
 const add = (n:number, at:string, extra:object={}, outcome="queued") => {
  const id = `dc-20261008120000-${n.toString(16).padStart(8,"0")}`;
  rows.push({type:"request",by:"bridge",id,at,kind:"message",text:`send ${n}`,ask_id:null,peer:null,deliver:"followUp",session_started_at:since,session_file:transcript,...extra});
  rows.push({type:"outcome",by:"bridge",id,at,state:"injected",reason:null});
  rows.push({type:"outcome",by:"bridge",id,at,state:outcome,reason:outcome === "failed" ? "late rejection" : null});
  return id;
 };
 const boundary = add(1,new Date(now.getTime()-INBOX_MAX_AGE_MS).toISOString());
 const expired = add(2,new Date(now.getTime()-INBOX_MAX_AGE_MS-1).toISOString());
 const missing = add(3,"2026-10-08T11:00:00Z",{session_file:join(home.path,"missing.jsonl")},"injected");
 const ended = add(4,"2026-10-08T11:01:00Z",{session_started_at:"2026-10-07T09:00:00Z"});
 const live = add(5,"2026-10-08T11:02:00Z");
 const delivered = add(6,"2026-10-08T11:03:00Z",{},"delivered");
 const failed = add(7,"2026-10-08T11:04:00Z",{},"failed");
 const legacy = add(8,"2026-10-07T09:59:59Z",{session_started_at:undefined,session_file:undefined});
 const file = controlJournalFile(stateDir);
 writeFileSync(file,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
 const before = readFileSync(file,"utf8");
 const result = readPendingSends(stateDir,now,session);
 assert.equal(result.sends_error,null);
 const states = new Map(result.sends.map(send=>[send.id,send.state]));
 assert.deepEqual([boundary,expired,missing,ended,live,delivered,failed,legacy].map(id=>states.get(id)),["queued","dropped","dropped","dropped","queued","delivered","failed","dropped"]);
 assert.deepEqual(result.sends.filter(send=>send.state === "queued").map(send=>send.id),[boundary,live]);
 assert.deepEqual(readPendingSends(stateDir,now,session),result,"repeat reads are idempotent");
 assert.equal(readFileSync(file,"utf8"),before,"projection never rewrites or appends");
 const offline = readPendingSends(stateDir,now,{running:false,pid:null,since:null,reason:"no dashboard control record"});
 assert.equal(offline.sends.find(send=>send.id === live)?.state,"dropped");
 const dead = readPendingSends(stateDir,now,{running:false,pid:42,since:null,reason:"the recorded session pid 42 is not running"});
 assert.equal(dead.sends.find(send=>send.id === live)?.state,"dropped");
 const invalid = readPendingSends(stateDir,now,{running:false,pid:null,since:null,reason:"unreadable record"});
 assert.equal(invalid.sends.find(send=>send.id === live)?.state,"queued","uncertain metadata is not proof of abandonment");
 appendFileSync(file,JSON.stringify({type:"outcome",by:"viewer",id:live,at:now.toISOString(),peer:null,state:"dropped",reason:"operator discarded abandoned send"})+"\n");
 appendFileSync(file,JSON.stringify({type:"outcome",by:"bridge",id:live,at:now.toISOString(),peer:null,state:"queued",reason:null})+"\n");
 assert.equal(readPendingSends(stateDir,now,session).sends.find(send=>send.id === live)?.state,"dropped","late acceptance cannot resurrect terminal drops");
});

test("cp-y43c: a dashboard-held message is editable with its saved text, outlives its session, and loses Edit once handed over or cancelled", t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state);
 mkdirSync(join(stateDir,"operator"),{recursive:true});
 const now = new Date("2026-10-08T12:00:00Z");
 const session = {running:true,pid:process.pid,since:"2026-10-08T11:30:00Z",reason:"running"};
 const id = (n:number) => `dc-20261008110000-${n.toString(16).padStart(8,"0")}`;
 const at = "2026-10-08T11:00:00Z";
 const request = (n:number) => ({type:"request",by:"bridge",id:id(n),at,kind:"message",text:`draft ${n}`,ask_id:null,peer:null,deliver:"followUp",session_started_at:"2026-10-08T10:00:00Z",session_file:join(home.path,"gone.jsonl")});
 const outcome = (n:number,state:string) => ({type:"outcome",by:"bridge",id:id(n),at,state,reason:null});
 const edited = (n:number,text:string) => ({type:"edited",by:"bridge",id:id(n),at,peer:null,text});
 writeFileSync(controlJournalFile(stateDir),[
  request(1),outcome(1,"queued"),edited(1,"saved 1"),
  request(2),outcome(2,"queued"),edited(2,"saved 2"),outcome(2,"injected"),edited(2,"never applied"),
  request(3),outcome(3,"queued"),outcome(3,"cancelled"),
 ].map(row=>JSON.stringify(row)).join("\n")+"\n");
 const sends = new Map(readPendingSends(stateDir,now,session).sends.map(send=>[send.id,send]));
 assert.deepEqual([sends.get(id(1))?.state,sends.get(id(1))?.body.text,sends.get(id(1))?.editable],["queued","saved 1",true],"held across a session restart, with its edit");
 assert.deepEqual([sends.get(id(2))?.state,sends.get(id(2))?.body.text,sends.get(id(2))?.editable],["dropped","saved 2",undefined],"handed over: the text pi got; its session ended, so dropped, never resent");
 assert.deepEqual([sends.get(id(3))?.state,sends.get(id(3))?.reason,sends.get(id(3))?.editable],["dropped","Cancelled from the dashboard",undefined]);
});
