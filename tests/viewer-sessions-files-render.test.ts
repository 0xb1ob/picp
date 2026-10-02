import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { filesView } from "../src/viewer/files-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

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
 assert.ok(desktop>0 && css.indexOf("136px")>desktop,"the clock padding sits in the desktop media block"); assert.match(css.slice(0,desktop),/\.session-heading \{ display: none; padding: 0 16px 12px;/);
 // Audit P2 #14: held-idle counts as live the way the Overview's health() does, and a running worker shows its run phase, never "waiting".
 const workers=[{id:"cp-run",kind:"worker",job_id:"cp-run",phase:"waiting",run_phase:"working",model:"m",live:true},{id:"cp-idle",kind:"worker",job_id:"cp-idle",phase:"held",run_phase:"idle",model:"m",live:false},{id:"cp-gone",kind:"worker",job_id:"cp-gone",phase:"done",run_phase:"exited",model:"m",live:false}];
 const listed=screen({...sessions,workers});
 // The row text is now `model · thinking` (cp-s9rc addendum 1); the run phase stays on the status dot, never "waiting".
 assert.match(listed,/Workers · 2 live/); assert.match(listed,/session-dot-working/); assert.match(listed,/session-dot-held/); assert.doesNotMatch(listed,/waiting · m|session-dot-waiting/); assert.match(listed,/<small>m<\/small>/);
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
