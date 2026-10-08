import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createViewer } from "../src/viewer/server.ts";
import { route, screenDataUrl } from "../viewer-app/routes.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import { operatorSessionsFile } from "../src/viewer/operator-sessions.ts";

const put = (path: string, value: unknown) => { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,JSON.stringify(value)); };
test("sessions view exposes recorded decision chains and confined transcripts, retaining classic sidebar", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state);
 const at = "2026-09-26T10:39:00Z", send = "ps-20260926103900-1234abcd";
 put(join(stateDir,"fleet.json"),{jobs:[{job_id:"cp-one",project:"demo",phase:"held",worker:{session_file:join(stateDir,"sessions/one.jsonl")}}]});
 put(join(stateDir,"sessions/cp-parent.sends.json"),{entries:[{id:send,text:"Approve this change",queued_at:at,state:"settled",delegated:true,reply:"Done",owner_observed_at:at}]});
 put(join(stateDir,"escalations.json"),{items:[{id:"es-abcd",question:"Approve risk?",kind:"risk_high_irreversible",created_at:"2026-09-26T10:36:00Z",status:"answered",answer:"approve",answered_by:"operator-delegated",answered_at:at,send_id:send}]});
 writeFileSync(join(stateDir,"sessions/one.jsonl"),JSON.stringify({type:"message",timestamp:at,message:{role:"assistant",content:[{type:"text",text:"Working <script>"},{type:"toolCall",name:"read",arguments:{path:"src/a.ts"}}]}})+"\n");
 put(join(stateDir,"operator/asks.jsonl"),{type:"open",id:"ask-abcd",project:"demo",question:"Raise cap?",created_at:at,recommendation:"Keep",options:[{label:"Keep",consequence:"Paused"}],source_escalation:"es-abcd"});
 appendFileSync(join(stateDir,"operator/asks.jsonl"),"\n");
 const sendsBefore=readFileSync(join(stateDir,"sessions/cp-parent.sends.json"),"utf8");
 const options = {home:home.path,stateDir,host:"127.0.0.1",port:0}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port;
 t.after(()=>server.close()); const get=(path:string)=>fetch(`http://127.0.0.1:${options.port}${path}`);
 const classic=await (await get("/api/sessions")).json(); assert.equal(classic.active[0].id,"cp-one");
 const you=await (await get("/api/sessions?view=you")).json();
 assert.equal(you.selected,"you"); assert.ok(you.entries.some((e:any)=>e.trace.some((s:any)=>s.id==="es-abcd")));
 assert.ok(you.entries.some((e:any)=>e.tag==="decided for you"));
 assert.ok(you.entries.every((e:any)=>e.tag!=="worth a look"));
 assert.ok(you.entries.some((e:any)=>e.kind==="ask" && e.text==="Raise cap?" && e.tag==="awaiting you"));
 assert.equal(readFileSync(join(stateDir,"sessions/cp-parent.sends.json"),"utf8"),sendsBefore);
 assert.doesNotMatch(JSON.stringify(you),/told you/);
 const worker=await (await get("/api/sessions?view=workers&id=cp-one")).json();
 assert.equal(worker.entries[0].text,"Working <script>"); assert.equal(worker.entries[1].name,"read");
 appendFileSync(join(stateDir,"sessions/one.jsonl"),JSON.stringify({type:"message",timestamp:at,message:{role:"toolResult",toolName:"read",isError:true,content:[{type:"text",text:"Denied"}]}}));
 assert.equal((await (await get("/api/sessions?view=workers&id=cp-one")).json()).entries.length,2,"partial lines wait");
 appendFileSync(join(stateDir,"sessions/one.jsonl"),"\n");
 assert.equal((await (await get("/api/sessions?view=workers&id=cp-one")).json()).entries.at(-1).failed,true);
 put(join(stateDir,"sessions/cp-parent.jsonl"),{type:"message",timestamp:at,message:{role:"user",content:`Approve\n[cp-send ${send} — delivery id, not an instruction]`}});
 appendFileSync(join(stateDir,"sessions/cp-parent.jsonl"),"\n");
 const parent=await (await get("/api/sessions?view=parent")).json();
 assert.equal(parent.entries[0].kind,"via"); assert.equal(parent.entries[0].send_id,send); assert.equal(parent.entries[0].trace[0].id,"es-abcd");
 for(const view of ["sessions","files"]) assert.equal((await fetch(`http://127.0.0.1:${options.port}/api/stream?view=${view}`,{method:"HEAD"})).status,200);
 assert.equal((await get("/api/sessions?view=workers&id=../../etc/passwd")).status,404);
 put(join(stateDir,"escalations.json"),{items:"bad"});
 const bad=await (await get("/api/sessions?view=you")).json(); assert.ok(bad.warnings.some((s:string)=>s.includes("escalations")));
});

test("files screen API reuses confined roots and preserves classic listing", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup()); const stateDir=join(home.path, LAYOUT.state);
 put(join(home.path, LAYOUT.projects, "demo/package.json"),{name:"demo"}); put(join(home.path, LAYOUT.projects, "demo/.env"),{secret:true});
 const options={home:home.path,stateDir,host:"127.0.0.1",port:0}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port; t.after(()=>server.close());
 const get=(q:string)=>fetch(`http://127.0.0.1:${options.port}/api/files${q}`);
 const root=await (await get("?view=screen")).json(); assert.equal(root.roots[0].id,"project:demo"); assert.equal(root.listing.kind,"dir");
 assert.deepEqual(root.listing.entries.map((e:any)=>e.name),["package.json"]);
 assert.equal((await get("?view=screen&root=project:demo&path=.env")).status,404);
 const classic=await (await get("?root=project:demo&path=package.json")).json(); assert.equal(classic.kind,"file");
});

/** The operator session's own pi transcript: one record per entry type the viewer renders. */
function operatorFixture(file: string, at: string): void {
 const message = (timestamp: string, m: unknown) => JSON.stringify({type:"message",timestamp,message:m});
 const lines = [
  JSON.stringify({type:"session",id:"fixture",timestamp:at}),
  message(at,{role:"user",content:[{type:"text",text:"the operator's ask"}]}),
  message(at,{role:"assistant",content:[{type:"thinking",thinking:"weighing options"},{type:"text",text:"acknowledged"},{type:"toolCall",id:"call-1",name:"read",arguments:{path:"src/a.ts"}}]}),
  message(at,{role:"toolResult",toolCallId:"call-1",toolName:"read",content:[{type:"text",text:"Read 42 lines"}]}),
  JSON.stringify({type:"custom_message",timestamp:at,customType:"cp-bridge",display:true,content:"[cp-bridge send send=ps-20260926103900-1234abcd]\nApproved"}),
  JSON.stringify({type:"custom_message",timestamp:at,customType:"cp-memory",display:false,content:"hidden from the CLI"}),
  JSON.stringify({type:"compaction",timestamp:at,tokensBefore:260000,summary:"a long summary nothing renders"}),
  message(at,{role:"system",content:""}),
 ];
 mkdirSync(dirname(file),{recursive:true});
 writeFileSync(file, lines.join("\n")+"\n");
}

test("operator tier: decisions is still the default, and Full transcript renders the recorded file by entry type", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup());
 const stateDir=join(home.path, LAYOUT.state), dir=mkdtempSync(join(tmpdir(),"cp-operator-session-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const at="2026-09-27T08:24:05Z", older=join(dir,"older.jsonl"), newest=join(dir,"newest.jsonl");
 operatorFixture(newest,at);
 writeFileSync(older,JSON.stringify({type:"message",timestamp:"2026-09-26T18:00:00Z",message:{role:"user",content:[{type:"text",text:"the older session"}]}})+"\n");
 put(join(stateDir,"operator/asks.jsonl"),{type:"open",id:"ask-abcd",project:"demo",question:"Raise cap?",created_at:at,recommendation:"Keep",options:[{label:"Keep",consequence:"Paused"}]});
 appendFileSync(join(stateDir,"operator/asks.jsonl"),"\n");
 const record=operatorSessionsFile(join(stateDir,"sessions")); mkdirSync(dirname(record),{recursive:true});
 writeFileSync(record,[older,newest].map((file,i)=>JSON.stringify({at:i === 0 ? "2026-09-26T18:00:00.000Z" : "2026-09-27T08:24:05.000Z",session_file:file})).join("\n")+"\n");
 const options = {home:home.path,stateDir,host:"127.0.0.1",port:0,requireTailnet:true}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port;
 t.after(()=>server.close()); const get=(path:string)=>fetch(`http://127.0.0.1:${options.port}${path}`);

 const decisions=await (await get("/api/sessions?view=you")).json();
 assert.equal(decisions.transcript,undefined,"the recorded decisions view is still the default");
 assert.equal(decisions.subtitle,"Recorded decisions and questions");
 assert.ok(decisions.entries.some((e:any)=>e.tag==="awaiting you"));

 const full=await (await get("/api/sessions?view=you&transcript=1")).json();
 assert.equal(full.transcript,true); assert.equal(full.subtitle,"Full transcript");
 assert.equal(full.operator_session,"newest.jsonl");
 assert.deepEqual(full.operator_sessions.map((s:any)=>s.id),["newest.jsonl","older.jsonl"],"newest first, and the older file stays listed");
 assert.deepEqual(full.entries.map((e:any)=>[e.kind,e.name,e.who]),[
  ["say",null,"Operator"],["tool","thinking","assistant"],["say",null,"Assistant"],["tool","read","assistant"],["system",null,"cp-bridge"],["system",null,"compaction"],["ask",null,"Operator → you"],
 ],"user, thinking, assistant text, the paired tool call, the bridge message, the compaction marker, and the open ask's card placed by when it was raised");
 assert.equal(full.entries[0].text,"the operator's ask"); assert.equal(full.entries[0].at,at,"timestamps are kept");
 assert.equal(full.entries[1].text,"weighing options","thinking is its own collapsed entry");
 assert.match(full.entries[3].text,/Arguments\n\{\n  "path": "src\/a\.ts"\n\}/);
 assert.match(full.entries[3].text,/Result\nRead 42 lines/,"the result pairs with its call, not a second entry");
 assert.equal(full.entries[4].tag,"bridge"); assert.equal(full.entries[4].text,"Approved","the bridge header line is stripped"); assert.deepEqual(full.entries[4].bridge,{kind:"send",job:null,id:null,receipt:null}); assert.equal(full.entries[4].paths,undefined,"a notice with no paths: block carries no links at all");
 assert.match(full.entries[5].text,/260000 tokens before/);
 assert.ok(!full.entries.some((e:any)=>e.text==="hidden from the CLI"),"a display:false custom message stays hidden");
 assert.ok(!full.entries.some((e:any)=>!e.text.trim()),"the empty system record adds nothing");

 const first=await (await get("/api/sessions?view=you&transcript=1&session=older.jsonl")).json();
 assert.equal(first.operator_session,"older.jsonl"); assert.equal(first.entries[0].text,"the older session");
 assert.equal((await get("/api/sessions?view=you&transcript=1&session=nope.jsonl")).status,404,"an unknown id is the same 404 an unknown worker id is");
 assert.equal((await (await get("/api/sessions?view=parent&transcript=1")).json()).entries.length,0,"the parent tier ignores the new params");
 
 // The toggle is a hash: the app's own loader (screenDataUrl) turns the deep link into this projection's request.
 const parsed=route("#sessions?view=you&transcript=1&session=older.jsonl");
 assert.equal(parsed.screen,"sessions");
 assert.equal(screenDataUrl(parsed),"/api/sessions?view=you&transcript=1&session=older.jsonl","the loader forwards the deep link's transcript and session");
 const viaHash=await (await get(screenDataUrl(parsed))).json();
 assert.equal(viaHash.transcript,true); assert.equal(viaHash.operator_session,"older.jsonl","the hash the toggle writes reaches the view");
 assert.equal(new URLSearchParams(route("#sessions?view=you").query).get("transcript"),"1","the default hash opens the Full transcript");
 assert.equal((await (await get(screenDataUrl(route("#sessions?view=you&transcript=0")))).json()).transcript,undefined,"transcript=0 is the recorded decisions view");
 
 // Live file: the client refetches on the sessions refresh stream, and every read re-reads the file.
 appendFileSync(newest,JSON.stringify({type:"message",timestamp:"2026-09-27T08:30:00Z",message:{role:"user",content:[{type:"text",text:"a later operator word"}]}})+"\n");
 const live=await (await get("/api/sessions?view=you&transcript=1")).json();
 assert.equal(live.entries.at(-1).text,"a later operator word","a line appended to the session file appears on the next read");
 assert.equal(live.entries.at(-1).who,"Operator");
 assert.equal((await fetch(`http://127.0.0.1:${options.port}/api/stream?view=sessions`,{method:"HEAD"})).status,200,"the refresh stream every Sessions view already follows");
});

/** A bridge notice's `paths:` block, resolved the same way Awaiting's evidence is (decision-views.ts). */
test("operator Full transcript: a bridge notice's paths: block becomes viewer links", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state), dir = mkdtempSync(join(tmpdir(), "cp-bridge-paths-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 const at = "2026-09-27T16:18:00Z";
 const run = join(stateDir, "runs", "cp-xrhq");
 put(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-xrhq", project: "demo", phase: "done", worker: {} }] });
 mkdirSync(run, { recursive: true }); writeFileSync(join(run, "artifact.md"), "the artifact\n");
 const bridge = (content: string) => JSON.stringify({ type: "custom_message", timestamp: at, customType: "cp-bridge", display: true, content });
 const file = join(dir, "session.jsonl");
 writeFileSync(file, [
  bridge(`[cp-bridge wake job=cp-xrhq receipt=owner_observed]\nMobile chat landed.\npaths:\n- ${join(run, "artifact.md")}\n- ${run}\n- ${join(home.path, "gone/nothing.md")}`),
  bridge("[cp-bridge send send=ps-20260927161800-1234abcd]\nApproved"),
 ].join("\n") + "\n");
 const record = operatorSessionsFile(join(stateDir, "sessions")); mkdirSync(dirname(record), { recursive: true });
 writeFileSync(record, JSON.stringify({ at, session_file: file }) + "\n");
 const options = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true }; const server = createViewer(options);
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); options.port = (server.address() as AddressInfo).port;
 t.after(() => server.close());
 const full = await (await fetch(`http://127.0.0.1:${options.port}/api/sessions?view=you&transcript=1`)).json() as any;

 assert.deepEqual(full.entries[0].paths.map((p: any) => [p.path, p.href]), [
  [join(run, "artifact.md"), "#job/cp-xrhq"],
  [run, "#job/cp-xrhq"],
  [join(home.path, "gone/nothing.md"), null],
 ], "each path resolves once, by the viewer's own evidence rules; an unreadable one is not a link");
 assert.equal(full.entries[1].paths, undefined, "a notice with no paths: block is left alone");
 assert.equal(full.entries[0].bridge.kind,"wake"); assert.equal(full.entries[0].bridge.job,"cp-xrhq"); assert.equal(full.entries[0].bridge.id,null); assert.equal(full.entries[0].bridge.receipt,"owner_observed"); assert.ok(full.entries[0].text.startsWith("Mobile chat landed.")); assert.doesNotMatch(full.entries[0].text,/^\[cp-bridge/);
 assert.deepEqual(full.entries[0].links, { [join(run, "artifact.md")]: "#job/cp-xrhq", [run]: "#job/cp-xrhq" }, "bare .pi-command-post paths in the text resolve by the same helper; an unreadable one is not a link");
});

test("operator Full transcript: bridge fields parse, and a project chip only for a known projects/* dir", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup());
 const stateDir=join(home.path, LAYOUT.state), dir=mkdtempSync(join(tmpdir(),"cp-session-project-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const at="2026-09-27T18:00:00Z";
 mkdirSync(join(home.path, LAYOUT.projects, "picp"),{recursive:true});
 writeFileSync(join(home.path, LAYOUT.projects, "notes.txt"), "not a project\n");
 const message=(text:string)=>JSON.stringify({type:"message",timestamp:at,message:{role:"assistant",content:[{type:"text",text}]}});
 const bridge=(content:string)=>JSON.stringify({type:"custom_message",timestamp:at,customType:"cp-bridge",display:true,content});
 const file=join(dir,"session.jsonl");
 writeFileSync(file,[
  message("[picp] landed the chip"),
  message("[notes.txt] stays in the text"),
  message("[unknown] stays too"),
  bridge("[cp-bridge escalation job=cp-1 id=es-abcd stale receipt=turn_settled]\nbody line"),
  bridge("[cp-bridge wake extra]\nstill the header"),
 ].join("\n")+"\n");
 const record=operatorSessionsFile(join(stateDir,"sessions")); mkdirSync(dirname(record),{recursive:true});
 writeFileSync(record,JSON.stringify({at,session_file:file})+"\n");
 const options={home:home.path,stateDir,host:"127.0.0.1",port:0,requireTailnet:true}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port;
 t.after(()=>server.close());
 const full=await (await fetch(`http://127.0.0.1:${options.port}/api/sessions?view=you&transcript=1`)).json() as any;
 const says=full.entries.filter((e:any)=>e.kind==="say");
 assert.equal(says[0].project,"picp"); assert.equal(says[0].text,"landed the chip");
 assert.equal(says[1].project,undefined); assert.equal(says[1].text,"[notes.txt] stays in the text");
 assert.equal(says[2].project,undefined); assert.equal(says[2].text,"[unknown] stays too");
 const escalation=full.entries.find((e:any)=>e.bridge?.kind==="escalation");
 assert.deepEqual(escalation.bridge,{kind:"escalation",job:"cp-1",id:"es-abcd",receipt:"turn_settled"});
 assert.equal(escalation.text,"body line");
 const bare=full.entries.find((e:any)=>String(e.text).includes("still the header"));
 assert.equal(bare.bridge,undefined,"a header line that is not exactly the cp-bridge tag stays text");
 assert.match(bare.text,/^\[cp-bridge wake extra\]/);
});

test("operator Full transcript: a missing or unrecorded file names itself, never an empty page", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup()); const stateDir=join(home.path, LAYOUT.state);
 const dir=mkdtempSync(join(tmpdir(),"cp-operator-missing-")); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const options = {home:home.path,stateDir,host:"127.0.0.1",port:0,requireTailnet:true}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port;
 t.after(()=>server.close()); const get=(path:string)=>fetch(`http://127.0.0.1:${options.port}${path}`);
 const record=operatorSessionsFile(join(stateDir,"sessions")); mkdirSync(dirname(record),{recursive:true});

 let out=await (await get("/api/sessions?view=you&transcript=1")).json();
 assert.equal(out.entries.length,0); assert.equal(out.operator_session,null);
 assert.match(out.warnings[0],/No operator session recorded yet/);
 assert.ok(out.warnings[0].includes(record),"the empty state names the record the bridge would have written");

 const gone=join(dir,"gone.jsonl");
 writeFileSync(record,JSON.stringify({at:"2026-09-27T08:24:05.000Z",session_file:gone})+"\n");
 out=await (await get("/api/sessions?view=you&transcript=1")).json();
 assert.equal(out.entries.length,0); assert.equal(out.operator_session,"gone.jsonl","the selector still names the file it could not read");
 assert.equal(out.warnings[0],`Operator transcript missing: ${gone} (ENOENT)`);

 const notAFile=join(dir,"directory.jsonl"); mkdirSync(notAFile,{recursive:true});
 writeFileSync(record,JSON.stringify({at:"2026-09-28T08:24:05.000Z",session_file:notAFile})+"\n");
 out=await (await get("/api/sessions?view=you&transcript=1")).json();
 assert.equal(out.warnings[0],`Operator transcript unreadable: ${notAFile} (not a file)`);
});

test("operator Full transcript is refused off-tailnet: not under --require-tailnet, and never on another Host", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup()); const stateDir=join(home.path, LAYOUT.state);
 const path="/api/sessions?view=you&transcript=1";
 const foreignHost=(port:number)=>new Promise<number>((resolve,reject)=>{
  const req=request({host:"127.0.0.1",port,path,headers:{host:"evil.example"}},res=>{res.resume();resolve(res.statusCode ?? 0);});
  req.on("error",reject); req.end();
 });
 // bin/cp-view by hand, no flag: the transcript is refused outright; everything else is unchanged.
 const plain={home:home.path,stateDir,host:"127.0.0.1",port:0}; const plainServer=createViewer(plain);
 await new Promise<void>(resolve=>plainServer.listen(0,"127.0.0.1",resolve)); plain.port=(plainServer.address() as AddressInfo).port;
 t.after(()=>plainServer.close());
 const refused=await fetch(`http://127.0.0.1:${plain.port}${path}`);
 assert.equal(refused.status,403,"only a viewer started with --require-tailnet serves this route");
 assert.match(String((await refused.json() as {error:string}).error),/require-tailnet/);
 assert.equal((await fetch(`http://127.0.0.1:${plain.port}/api/sessions?view=you`)).status,200,"every other route is untouched");
 assert.equal(await foreignHost(plain.port),421,"and the Host guard runs first");
 // bin/cp-operator's viewer (--require-tailnet): served, but only to the bind's own Host.
 const tailnet={home:home.path,stateDir,host:"127.0.0.1",port:0,requireTailnet:true}; const server=createViewer(tailnet);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); tailnet.port=(server.address() as AddressInfo).port;
 t.after(()=>server.close());
 assert.equal(await foreignHost(tailnet.port),421,"an off-tailnet Host is refused before the transcript is read");
 assert.equal((await fetch(`http://127.0.0.1:${tailnet.port}${path}`)).status,200,"and the same route answers on the bind itself");
});

test("operator Full transcript: each cp_parent ask is followed by its decision card; dashboard messages are tagged with their id and ask", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup()); const stateDir=join(home.path, LAYOUT.state);
 const dir=mkdtempSync(join(tmpdir(),"cp-operator-cards-")); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,"session.jsonl"), at="2026-09-27T08:20:00Z";
 const message=(m:unknown)=>JSON.stringify({type:"message",timestamp:at,message:m});
 const askCall=(call:string,id:string)=>[
  message({role:"assistant",content:[{type:"toolCall",id:call,name:"cp_parent",arguments:{action:"ask",ask:{project:"demo",question:"q",options:[{label:"Keep",consequence:"c"}],recommendation:"Keep"}}}]}),
  message({role:"toolResult",toolCallId:call,toolName:"cp_parent",content:[{type:"text",text:JSON.stringify({id,state:"open"})}]}),
 ];
 writeFileSync(file,[
  message({role:"user",content:[{type:"text",text:"what next?"}]}),
  ...askCall("call-a","ask-abcd"), ...askCall("call-b","ask-bbbb"),
  message({role:"user",content:[{type:"text",text:"ask-abcd: Keep\n\n[cp-dashboard dc-20260927082500-0123abcd — from the dashboard; ask=ask-abcd]"}]}),
  message({role:"user",content:[{type:"text",text:"steer: stop the merge\n\n[cp-dashboard dc-20260927082600-4567cdef — from the dashboard]"}]}),
  message({role:"user",content:[{type:"text",text:"look\n\n[cp-dashboard dc-20260927082700-89abcdef — from the dashboard; images=im-20260927-0123456789abcdef01234567.png]"},{type:"image",data:"aGk=",mimeType:"image/png"}]}),
  message({role:"user",content:[{type:"text",text:"from the CLI"},{type:"image",data:"aGk=",mimeType:"image/png"}]}),
 ].join("\n")+"\n");
 const open=(id:string,created_at:string)=>({type:"open",id,project:"demo",question:`Question ${id}`,created_at,recommendation:"Keep",options:[{label:"Keep",consequence:"Paused"},{label:"Raise",consequence:"Spends"}]});
 put(join(stateDir,"operator/asks.jsonl"),open("ask-abcd",at));
 appendFileSync(join(stateDir,"operator/asks.jsonl"),"\n"+[open("ask-bbbb",at),{type:"answer",id:"ask-bbbb",answer:"Raise",answered_at:"2026-09-27T08:30:00Z"},open("ask-cccc",at),{type:"answer",id:"ask-cccc",answer:"Keep",answered_at:at},open("ask-dddd","2026-09-26T08:00:00Z")].map(e=>JSON.stringify(e)).join("\n")+"\n");
 const record=operatorSessionsFile(join(stateDir,"sessions")); mkdirSync(dirname(record),{recursive:true});
 writeFileSync(record,JSON.stringify({at,session_file:file})+"\n");
 const options={home:home.path,stateDir,host:"127.0.0.1",port:0,requireTailnet:true}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port; t.after(()=>server.close());
 const full=await (await fetch(`http://127.0.0.1:${options.port}/api/sessions?view=you&transcript=1`)).json();
 assert.deepEqual(full.entries.map((e:any)=>e.kind === "ask" ? `card:${e.ask.id}:${e.ask.state}` : e.kind === "tool" ? `tool:${e.ask_id}` : e.kind),
  ["card:ask-dddd:open","say","tool:ask-abcd","card:ask-abcd:open","tool:ask-bbbb","card:ask-bbbb:answered","via","via","via","say"],
  "a card follows the call that raised it; an older unanchored open ask sits at the top; a settled unanchored one is omitted");
 const card=full.entries[3];
 assert.deepEqual(card.ask.options.map((o:any)=>[o.label,o.consequence,o.reply]),[["Keep","Paused","ask-abcd: Keep"],["Raise","Spends","ask-abcd: Raise"]]);
 assert.equal(card.ask.recommendation,"Keep"); assert.equal(card.tag,"awaiting you");
 assert.deepEqual([full.entries[5].ask.answer,full.entries[5].ask.answered_at],["Raise","2026-09-27T08:30:00Z"],"an answered card carries the answer");
 const click=full.entries[6];
 assert.deepEqual([click.who,click.tag,click.text,click.dashboard_id,click.ask_id],["Operator (dashboard)","dashboard","ask-abcd: Keep","dc-20260927082500-0123abcd","ask-abcd"],"the marker is stripped and read");
 assert.deepEqual([full.entries[7].text,full.entries[7].dashboard_id,full.entries[7].ask_id],["steer: stop the merge","dc-20260927082600-4567cdef",undefined]);
 assert.deepEqual([full.entries[8].tag,full.entries[8].text,full.entries[8].dashboard_id,full.entries[8].images],["dashboard","look","dc-20260927082700-89abcdef",["im-20260927-0123456789abcdef01234567.png"]],"image parts follow the marker: still a dashboard message; the marker's ids are its thumbnails, never [image]");
 assert.equal(full.entries[7].images,undefined,"a text-only dashboard message carries no images");
 assert.equal(full.entries[9].text,"from the CLI\n[image]","a CLI message with an image is unchanged");
 const fileId="tx-20260927-0123456789abcdef01234567.html";
 appendFileSync(file,message({role:"user",content:`File: original.html\n\`\`\`text\n<script>literal</script>\n\`\`\`\n\n[cp-dashboard dc-20260927082800-0123abcd — from the dashboard; thread=notes; files=${fileId}]`})+"\n");
 put(join(stateDir,"operator/dashboard.jsonl"),{type:"upload",id:fileId,mime:"text/plain",bytes:24,name:"original.html"}); appendFileSync(join(stateDir,"operator/dashboard.jsonl"),"\n");
 const next=await (await fetch(`http://127.0.0.1:${options.port}/api/sessions?view=you&transcript=1`)).json();
 const fileEntry=next.entries.at(-1); assert.equal(fileEntry.tag,"dashboard"); assert.deepEqual(fileEntry.files,[fileId]); assert.deepEqual(fileEntry.file_metadata,{[fileId]:{name:"original.html",bytes:24}}); assert.ok(fileEntry.text.includes("<script>literal</script>"));
});

test("operator Full transcript: the 300-entry window never drops an open decision card", async t => {
 const home=createScratchHome(); t.after(()=>home.cleanup()); const stateDir=join(home.path, LAYOUT.state);
 const dir=mkdtempSync(join(tmpdir(),"cp-operator-window-")); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,"session.jsonl"), at="2026-09-27T08:20:00Z";
 const message=(m:unknown)=>JSON.stringify({type:"message",timestamp:at,message:m});
 writeFileSync(file,[
  message({role:"assistant",content:[{type:"toolCall",id:"call-a",name:"cp_parent",arguments:{action:"ask"}}]}),
  message({role:"toolResult",toolCallId:"call-a",toolName:"cp_parent",content:[{type:"text",text:JSON.stringify({id:"ask-abcd"})}]}),
  ...Array.from({length:320},(_,i)=>message({role:"user",content:[{type:"text",text:`line ${i}`}]})),
 ].join("\n")+"\n");
 put(join(stateDir,"operator/asks.jsonl"),{type:"open",id:"ask-abcd",project:"demo",question:"Raise cap?",created_at:at,recommendation:"Keep",options:[{label:"Keep",consequence:"Paused"}]});
 appendFileSync(join(stateDir,"operator/asks.jsonl"),"\n");
 const record=operatorSessionsFile(join(stateDir,"sessions")); mkdirSync(dirname(record),{recursive:true});
 writeFileSync(record,JSON.stringify({at,session_file:file})+"\n");
 const options={home:home.path,stateDir,host:"127.0.0.1",port:0,requireTailnet:true}; const server=createViewer(options);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); options.port=(server.address() as AddressInfo).port; t.after(()=>server.close());
 const full=await (await fetch(`http://127.0.0.1:${options.port}/api/sessions?view=you&transcript=1`)).json();
 assert.equal(full.truncated,true);
 assert.equal(full.entries[0].ask.id,"ask-abcd","the open card survives the cut");
 assert.equal(full.entries.at(-1).text,"line 319");
 assert.equal(full.entries.length,301);
});
