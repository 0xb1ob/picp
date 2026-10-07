import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { filesView } from "../src/viewer/files-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import { parseHTML } from "linkedom";

test("Sessions and Files render empty, awaiting, failed, and confined file states", async t=>{
 const home=createScratchHome(); t.after(()=>home.cleanup()); const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const result=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {Files} from "./viewer-app/screens/Files.tsx"; export const screen=(data,files=false)=>render(h(files?Files:Sessions,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const sessions=sessionsView(state,"you",null)!;
 assert.match(screen(sessions),/No recorded entries/); assert.match(screen(sessions),/Operator ↔ you/);
 assert.match(screen(sessions),/Trace a decision/,"the trace helper sits on Operator ↔ you → Decisions");
 for (const selected of ["parent","workers"] as const) assert.doesNotMatch(screen({...sessions,selected}),/Trace a decision|entry for entry/,`no operator helper on the ${selected} view`);
 // Audit P2 #15: the corner-clock clearance is desktop only; the phone heading keeps its own 16px padding.
 const css=readFileSync(join(REPO_ROOT,"viewer-app/screens/sessions.css"),"utf8"); const desktop=css.indexOf("@media (min-width: 900px)");
 assert.ok(desktop>0); assert.equal(css.includes("136px"),false,"the corner clock is gone, so the heading no longer dodges it");
 assert.match(css.slice(0,desktop),/\.session-heading \{ display: none; padding: 0 16px 12px;/);
 assert.match(css.slice(desktop),/\.session-heading \{[^}]*padding: 10px 16px;/);
 assert.doesNotMatch(css,/\.session-tools-toggle[^{]*\{[^}]*display:\s*none/,"the tool-call toggle is never display:none, including at 1440");
 const stamped="2026-09-27T08:24:05Z", olderAt="2026-09-26T18:00:00Z";
 const when=(at:string,current:boolean)=>{ const label=new Intl.DateTimeFormat("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(at)); return current?`${label} · current`:label; };
 const picked=screen({...sessions,transcript:true,operator_sessions:[{id:"newest.jsonl",at:stamped},{id:"older.jsonl",at:olderAt}],operator_session:"newest.jsonl",entries:[
  {id:"p1",at:stamped,kind:"say",who:"Assistant",text:"landed",name:null,send_id:null,tag:null,failed:false,trace:[],project:"picp"},
  {id:"b1",at:stamped,kind:"system",who:"cp-bridge",text:"Mobile chat landed.\nSecond line.",name:null,send_id:null,tag:"bridge",failed:false,trace:[],bridge:{kind:"wake",job:"cp-x",id:null,receipt:"owner_observed"}},
 ]});
 assert.ok(picked.includes(`title="newest.jsonl"`) && picked.includes(when(stamped,true)) && picked.includes(when(olderAt,false)));
 assert.match(picked,/class="session-project">picp</);
 assert.match(picked,/class="session-bridge-line">bridge woke cp-x · owner observed</);
 assert.match(picked,/class="session-bridge-details"/); assert.doesNotMatch(picked,/session-bridge-details" open/);
 const doc=parseHTML(`<body>${picked}</body>`).document;
 assert.equal(doc.querySelector('.sessions > .page-header > h1')?.textContent,"Sessions","the desktop title row stays inside the direct-child screen");
 assert.equal(doc.querySelector('.session-choice[aria-current="page"] strong')?.textContent,"Operator ↔ you");
 assert.equal(doc.querySelector('.session-heading label')?.firstChild?.textContent,"Transcript");
 assert.equal(doc.querySelector('.session-heading label select')?.getAttribute("aria-label"),"Operator session file");
 assert.doesNotMatch(doc.querySelector('.session-heading')?.textContent ?? "",/entry for entry|Full transcript/);
 // Audit P2 #14: held-idle counts as live the way the Overview's health() does, and a running worker shows its run phase, never "waiting".
 const workers=[{id:"cp-run",kind:"worker",job_id:"cp-run",phase:"waiting",run_phase:"working",model:"m",live:true},{id:"cp-idle",kind:"worker",job_id:"cp-idle",phase:"held",run_phase:"idle",model:"m",live:false},{id:"cp-gone",kind:"worker",job_id:"cp-gone",phase:"done",run_phase:"exited",model:"m",live:false}];
 const listed=screen({...sessions,workers});
 // S8 keeps the short model while making the observed run phase readable in both switcher and sidebar.
 assert.match(listed,/Workers · 2 live/); assert.match(listed,/session-dot-working/); assert.match(listed,/session-dot-held/); assert.doesNotMatch(listed,/waiting · m|session-dot-waiting/); assert.match(listed,/<small>working · m<\/small>/);
 const switcher=parseHTML(`<body>${listed}</body>`).document.querySelector('.session-bar-views nav')!;
 assert.deepEqual([...switcher.querySelectorAll('.session-bar-worker small')].map(e=>e.textContent),["working","idle","exited"]);
 const unknown=screen({...sessions,workers:[{...workers[0],run_phase:null}]});
 assert.match(unknown,/>no run status</); assert.doesNotMatch(unknown,/>waiting</);
 sessions.entries=[{id:"ask-ab",at:"2026-09-26T10:00:00Z",kind:"ask",who:"Operator → you",text:"<script>question</script>",name:null,send_id:null,tag:"awaiting you",failed:false,trace:[{id:"es-abcd",label:"parent asked",at:"2026-09-26T09:59:00Z",detail:"Recorded question"}]}];
 const html=screen(sessions); assert.match(html,/awaiting you/); assert.match(html,/&lt;script>/); assert.match(html,/Recorded question/); assert.doesNotMatch(html,/<script>|style=|onclick=/i);
 sessions.entries[0]!.trace[0]!.at=null; assert.doesNotMatch(screen(sessions),/parent asked/,"untimestamped trace chips stay hidden");
 sessions.entries[0]!.failed=true; sessions.entries[0]!.text="Delivery failed"; assert.match(screen(sessions),/Delivery failed/);
 sessions.entries[0]!.at=""; assert.doesNotThrow(()=>screen(sessions),"untimestamped transcript entries still render");
 const files=filesView(state,null,"")!; assert.match(screen(files,true),/No projects/); assert.match(screen(files,true),/Live worktrees/);
 files.selected="project:demo"; files.roots=[{id:"project:demo",kind:"project",label:"demo",project:"demo",phase:null,head:null,pr_url:null,paused:false}];
 files.listing={kind:"file",text:"<script>unsafe</script>",size:23,binary:false,too_large:false};
 assert.match(screen(files,true),/&lt;script>/); assert.doesNotMatch(screen(files,true),/<script>/);
 assert.match(screen(files,true),/href="#files\?root=project%3Ademo/); assert.doesNotMatch(screen(files,true),/\/api\/git|git →|file-git/,"no raw-JSON git link");
 assert.doesNotMatch(screen(files,true),/\/classic/);
 files.listing={kind:"file",size:600000,binary:false,too_large:true}; assert.match(screen(files,true),/512 KiB/);
 files.listing={kind:"file",size:3,binary:true,too_large:false}; assert.match(screen(files,true),/Binary file/);
});
