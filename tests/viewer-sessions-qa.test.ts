import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { route } from "../viewer-app/routes.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const put=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
test("QA: operator tier contains decisions and every ask state, not parent replies; tool calls and done workers stay hidden", async t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const at="2026-09-26T10:39:00Z", later="2026-09-26T10:41:00Z", send="ps-20260926103900-1234abcd";
 put(join(state.stateDir,"fleet.json"),{jobs:[{job_id:"cp-live",phase:"waiting",worker:{session_file:join(state.stateDir,"sessions/live.jsonl")}},{job_id:"cp-failed",phase:"failed"},{job_id:"cp-done",phase:"done"}]});
 put(join(state.stateDir,"escalations.json"),{items:[{id:"es-abcd",question:"Approve **review** of `src/main.ts`?",kind:"risk_high_irreversible",created_at:at,status:"answered",answer:"approve",answered_by:"operator-delegated",answered_at:later,send_id:send,delegation_rule:"Inside the approved objective"}]});
 put(join(state.stateDir,"sessions/cp-parent.sends.json"),{entries:[{id:send,text:"approve",queued_at:at,state:"settled",reply:"PARENT-REPLY-MUST-NOT-APPEAR",owner_observed_at:later}]});
 const asks=["ask-aa","ask-bb","ask-cc"].map(id=>({type:"open",id,created_at:at,project:"demo",question:`Question ${id}`,options:[{label:"Keep",consequence:"Paused"}],recommendation:"Keep",source_escalation:"es-abcd"}));
 const askFile=join(state.stateDir,"operator/asks.jsonl");mkdirSync(dirname(askFile),{recursive:true});writeFileSync(askFile,[...asks,{type:"answer",id:"ask-bb",answer:"Keep",answered_at:later},{type:"withdraw",id:"ask-cc",reason:"No longer needed"}].map(e=>JSON.stringify(e)).join("\n")+"\n");
 const messages=[{role:"assistant",content:[{type:"toolCall",id:"call-1",name:"read",arguments:{path:"src/main.ts"}}]},{role:"toolResult",toolCallId:"call-1",toolName:"read",content:[{type:"text",text:"Read 42 lines\nFull file contents"}]},{role:"assistant",content:[{type:"text",text:"**Checked** `src/main.ts` <script>alert(1)</script> [link](https://example.com)"}]}];
 writeFileSync(join(state.stateDir,"sessions/live.jsonl"),messages.map(message=>JSON.stringify({type:"message",timestamp:at,message})).join("\n")+"\n");
 const built=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export const screen=data=>render(h(Sessions,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);
 const you=sessionsView(state,"you",null)!; const html=screen(you);
 assert.doesNotMatch(html,/PARENT-REPLY-MUST-NOT-APPEAR|Parent reply via main session|worth a look|cp-done|told you/);
 assert.match(html,/send ps-20260926103900-1234abcd/);assert.match(html,/Inside the approved objective/);
 assert.match(html,/decided for you/);assert.match(html,/awaiting you/);assert.match(html,/Question ask-bb/);assert.match(html,/Question ask-cc/);assert.match(html,/No longer needed/);
 assert.deepEqual(you.workers.map(w=>w.id),["cp-live","cp-failed"]);
 const decision=you.entries.find(e=>e.kind==="decision")!;assert.deepEqual(decision.trace.map(s=>[s.label,s.at]),[["parent asked",at],["decided",later]]);
 const withdrawn=you.entries.find(e=>e.id==="ask-cc")!;assert.equal(withdrawn.at,at,"withdrawals have no recorded timestamp");
 assert.equal(new URLSearchParams(route("#sessions").query).get("view"),"you");
 const worker=sessionsView(state,"workers","cp-live")!;const rendered=screen(worker);
 assert.equal(worker.entries.filter(e=>e.kind==="tool").length,1,"the view still carries the tool entry; only the render hides it");
 assert.match(rendered,/<button type="button" class="session-tools" aria-expanded="false"/);assert.match(rendered,/<\/span> 1 tool call/);
 assert.match(rendered,/<div class="session-tool-run"><button type="button" class="session-tools" aria-expanded="false"><span aria-hidden="true">▸<\/span> 1 tool call(<small> · [^<]*<\/small>)?<\/button><\/div>/,"the Sessions row is the shared ToolRunRow, collapsed: wrapper, button, marker, count, no rows");
 assert.doesNotMatch(rendered,/class="session-tool"|Full file contents/,"a hidden tool call renders neither its summary nor its result");
 // The toggle on (its persisted key): the shown entry renders its summary, never its raw args.
 const windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,"window");
 Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:()=>"1"}}});
 t.after(()=>{if(windowDescriptor)Object.defineProperty(globalThis,"window",windowDescriptor);else Reflect.deleteProperty(globalThis,"window");});
 const shown=screen(worker);
 const summary=/<details class="session-tool"><summary>(.*?)<\/summary>/.exec(shown)?.[1] ?? "";
 assert.match(summary,/Read 42 lines/);assert.doesNotMatch(summary,/&quot;path&quot;|Full file contents/,"the summary carries neither raw args nor the result body");
 assert.match(shown,/Full file contents/);
 assert.match(rendered,/src\/main\.ts/);
 assert.match(rendered,/<strong>Checked<\/strong>/);assert.match(rendered,/<code>src\/main.ts<\/code>/);
 assert.match(rendered,/&lt;script>/);assert.doesNotMatch(rendered,/<script>/);
 assert.match(rendered,/<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">link<\/a>/,"a markdown link renders as its label, opening in a new tab");
 writeFileSync(join(state.stateDir,"sessions/live.jsonl"),JSON.stringify({type:"message",timestamp:at,message:{role:"toolResult",toolCallId:"older-call",toolName:"index",content:[{type:"text",text:JSON.stringify({summary:"Indexed 8 files",project:"demo"})}]}})+"\n");
 const orphan=sessionsView(state,"workers","cp-live")!.entries[0]!;
 assert.equal(orphan.summary,"Indexed 8 files");assert.match(orphan.text,/"project":"demo"/);
});

test("QA: the operator tier has no Decisions | Full transcript toggle; system entries render and tool calls hide", async t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const built=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export const screen=data=>render(h(Sessions,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);
 const decisions=screen(sessionsView(state,"you",null)!);
 // Audit P4 #27: the toggle is gone from the header and the ⋯ sheet; the transcript=0 view (the 403 fallback) still renders.
 assert.doesNotMatch(decisions,/transcript=0|>Decisions<\/a>|>Full transcript<\/a>|session-views/);
 assert.match(decisions,/Trace a decision/,"the recorded decisions view keeps its helper line");
 assert.doesNotMatch(decisions,/aria-label="Operator session file"/,"no file picker before the transcript view");

 const full=sessionsView(state,"you",null,{transcript:true})!;
 full.operator_sessions=[{id:"newest.jsonl",at:"2026-09-27T08:24:05Z"},{id:"older.jsonl",at:"2026-09-26T18:00:00Z"}];
 full.operator_session="newest.jsonl";
 const long="x".repeat(1300)+"-TAIL-MARKER";
 full.entries=[
  {id:"u1",at:"2026-09-27T08:24:05Z",kind:"say",who:"Operator",text:"the operator's ask",name:null,send_id:null,tag:null,failed:false,trace:[]},
  {id:"t1",at:"",kind:"tool",who:"assistant",text:long,name:"read",send_id:null,tag:null,failed:false,summary:"Read 42 lines",trace:[]},
  {id:"s1",at:"",kind:"system",who:"cp-bridge",text:"[cp-bridge send send=ps-abcd] approved",name:null,send_id:null,tag:"bridge",failed:false,trace:[]},
  {id:"c1",at:"",kind:"system",who:"compaction",text:"Context compacted (260000 tokens before)",name:null,send_id:null,tag:"system",failed:false,trace:[]},
 ];
 const rendered=screen(full);
 assert.doesNotMatch(rendered,/>Full transcript<\/a>|>Decisions<\/a>/);
 assert.match(rendered,/aria-label="Operator session file"/,"more than one recorded file is selectable");
 const optionLabel=(at:string,current:boolean)=>{ const label=new Intl.DateTimeFormat("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(at)); return current?`${label} · current`:label; };
 assert.ok(rendered.includes(`title="newest.jsonl"`) && rendered.includes(optionLabel("2026-09-27T08:24:05Z",true)));
 assert.ok(rendered.includes(`title="older.jsonl"`) && rendered.includes(optionLabel("2026-09-26T18:00:00Z",false)));
 assert.doesNotMatch(rendered,/<option[^>]*>older\.jsonl/);
 assert.match(rendered,/class="session-message session-notice session-system"/);
 assert.match(rendered,/>cp-bridge<\/span><span>bridge<\/span>/);
 assert.match(rendered,/>compaction<\/span>/);
 assert.match(rendered,/Context compacted \(260000 tokens before\)/);
 assert.match(rendered,/Tools 1/,"the transcript header offers the hidden count");
 assert.match(rendered,/<\/span> 1 tool call/,"the long tool call collapses to its one-line run");
 assert.doesNotMatch(rendered,/show all|-TAIL-MARKER/,"its text and its show-all link both stay hidden until shown");
});
