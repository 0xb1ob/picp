import assert from "node:assert/strict";
import { build } from "esbuild";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlStatusResponse, SessionEntry, SessionsResponse } from "../src/viewer/api-types.ts";
import type { ControlView } from "../viewer-app/control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const bundle = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import ssr from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {useControl} from "./viewer-app/use-control.ts"; export {act}; export const html=(data,control,threads)=>ssr(h(Sessions,{data,control,threads})); function Stage({data,fetcher,onControl}) { const control=useControl(true,data.generated_at,data.entries,fetcher,true); onControl(control); return h(Sessions,{data,control}); } export const mount=(root,data,fetcher,onControl)=>render(h(Stage,{data,fetcher,onControl}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {html,act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`);
const at="2026-10-04T14:00:00Z";
const status: ControlStatusResponse = {generated_at:at,enabled:true,running:true,reason:null,token:"fixture-only",busy:true,pending:true,session_file:"fixture.jsonl",recent:[],offline:false,held:0,inbox_token:null,start_unavailable:null,launchers:{tmux:false,herdr:false},resume:{tmux:false,herdr:false}};
const entry=(id:string,extra:Partial<SessionEntry>={}):SessionEntry=>({id,at,kind:"say",who:"Assistant",text:id,name:null,send_id:null,tag:null,failed:false,trace:[],...extra});
const view=(entries:SessionEntry[],generated_at=at)=>({generated_at,selected:"you",session_id:null,parent:{id:"cp-parent",live:false},workers:[],entries,title:"Operator ↔ you",subtitle:"Full transcript",warnings:[],truncated:false,transcript:true} as unknown as SessionsResponse);
const pending=(key:string,extra:object={})=>({key,id:`dc-${key}`,at,state:"queued",reason:null,ask_id:null,body:{kind:"message",text:`queued ${key}`,thread:"layout"},...extra});

test("queued bubbles: FIFO after newest transcript, state and time, attachment chips, failures and thread filtering",()=>{
 const items=[pending("one",{body:{kind:"message",text:"queued one",thread:"layout",images:["im-fixture.png"],files:["future-file.json"]}}),pending("two",{state:"held"}),pending("three",{state:"failed",reason:"connection refused"})];
 const control={status,delivery:null,pending:items,send:()=>{},retry:()=>{},discard:()=>{}} as unknown as ControlView;
 const data=view([entry("streaming response")]);
 const {document}=parseHTML(html(data,control));
 const bubbles=[...document.querySelectorAll(".session-pending")];
 assert.equal(bubbles.length,3,"each send stays visible, not just the last delivery line");
 assert.deepEqual(bubbles.map(b=>b.querySelector(".md")?.textContent),["queued one","queued two","queued three"]);
 assert.ok(bubbles.every(b=>b.classList.contains("session-own")));
 assert.match(bubbles[0]!.textContent!,/Queued · 1 of 2/);
 assert.match(bubbles[1]!.textContent!,/Queued · 2 of 2/);
 assert.equal(bubbles[0]!.querySelector("time")?.getAttribute("datetime"),at);
 assert.deepEqual([...bubbles[0]!.querySelectorAll(".session-pending-attachments li")].map(el=>el.textContent),["Image · im-fixture.png","File · future-file.json"]);
 assert.match(bubbles[2]!.textContent!,/Failed: connection refused.*Retry.*Discard/);
 assert.ok(bubbles[2]!.classList.contains("session-pending-failed"));
 assert.ok(document.querySelector("[aria-live=polite]"));
 assert.equal(document.querySelector(".session-entries")?.lastElementChild,bubbles[2]);
 const threads={status:{availability:"ok",threads:[{id:"th-layout",tag:"layout"}]},selected:"other",select:()=>{},done:()=>{},sending:null,failed:null};
 assert.equal(parseHTML(html(data,control,threads)).document.querySelectorAll(".session-pending").length,0);
 threads.selected="layout";
 assert.equal(parseHTML(html(data,control,threads)).document.querySelectorAll(".session-pending").length,3);
 const arrived=view([entry("real one",{kind:"via",who:"Operator (dashboard)",dashboard_id:"dc-one",text:"queued one"})]);
 assert.equal(parseHTML(html(arrived,control)).document.querySelectorAll(".session-pending").length,2,"transcript wins in the same render, before hook effects");
});

async function stage(t:TestContext, store=new Map<string,string>()) {
 const {window,document}=parseHTML("<html><body><div id='root'></div></body></html>");
 Object.defineProperty(window,"localStorage",{configurable:true,value:{getItem:(key:string)=>store.get(key) ?? null,setItem:(key:string,value:string)=>store.set(key,value)}});
 const originals=["window","document"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for (const [key,value] of [["window",window],["document",document]] as const) Object.defineProperty(globalThis,key,{configurable:true,value});
 const root=document.getElementById("root")!;
 let control:ControlView;
 let current={...status};
 const posted:unknown[]=[];
 const replies:Array<(response:Response)=>void>=[];
 const fetcher=async (_url:string,init?:RequestInit)=>{
  if (_url === "/api/operator/upload" && init?.method === "POST") {
   const file=init.body as File;
   return new Response(JSON.stringify({id:"tx-20261004-0123456789abcdef01234567.md",name:file.name,bytes:file.size,mime:"text/plain",expires_at:at,url:"/api/operator/uploads/fixture"}),{status:201});
  }
  if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return new Promise<Response>(resolve=>replies.push(resolve)); }
  return new Response(JSON.stringify(current));
 };
 const flush=()=>act(async()=>{for(let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve));});
 const show=async (entries:SessionEntry[]=[],version=Math.random().toString())=>{await act(()=>mount(root,view(entries,version),fetcher,(value:ControlView)=>{control=value;}));await flush();};
 t.after(async()=>{await act(()=>unmount(root));for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const bubbleTexts=()=>[...root.querySelectorAll(".session-pending .md")].map(el=>el.textContent);
 return {root,store,posted,show,flush,bubbleTexts,get control(){return control!;},status:(value:ControlStatusResponse)=>{current=value;},
  reply:async(body:unknown,code=202)=>{await act(()=>replies.shift()!(new Response(JSON.stringify(body),{status:code})));await flush();},
  click:async(selector:string)=>{await act(()=>root.querySelector(selector)!.dispatchEvent(new window.Event("click",{bubbles:true})));await flush();},
  remount:async()=>{await act(()=>unmount(root));await show();}};
}

test("send FIFO: quick sends remain visible, POSTs serialize, delivered status never leaves a gap before transcript promotion",async t=>{
 const s=await stage(t);await s.show([entry("response")]);
 await act(()=>{s.control.send({kind:"message",text:"first",thread:"layout",images:["im-fixture.png"],files:["tx-20261004-0123456789abcdef01234567.md"]});s.control.send({kind:"message",text:"second"});});await s.flush();
 assert.deepEqual(s.bubbleTexts(),["first","second"]);
 assert.equal(s.posted.length,1,"server allows only one in-flight POST");
 assert.equal(s.root.querySelector("textarea")?.hasAttribute("disabled"),false,"another composer send is allowed");
 await s.reply({id:"dc-first",state:"queued",deliver:"followUp"});
 assert.equal(s.posted.length,2);assert.deepEqual(s.bubbleTexts(),["first","second"]);
 await s.reply({id:"dc-second",state:"queued",deliver:"followUp"});
 s.status({...status,recent:[{id:"dc-first",kind:"message",state:"delivered",at,reason:null,ask_id:null}]});
 await s.show([entry("response"),entry("next streamed response")]);
 assert.deepEqual(s.bubbleTexts(),["first","second"],"status delivered stays visible until actual arrival");
 assert.match(s.root.querySelector(".session-pending")!.textContent!,/waiting for transcript/);
 assert.equal(s.root.querySelector(".session-pending")?.previousElementSibling?.textContent?.includes("next streamed response"),true,"pending sends move after the latest response");
 await s.show([entry("response"),entry("real-first",{kind:"via",text:"first",dashboard_id:"dc-first"})]);
 assert.deepEqual(s.bubbleTexts(),["second"]);
 assert.equal([...s.root.querySelectorAll(".md")].filter(el=>el.textContent === "first").length,1,"one real bubble, no duplicate render");
 await s.remount();assert.deepEqual(s.bubbleTexts(),["second"],"unseen second persists; promoted first stays removed");
});

test("reload reconstructs journal-backed queue, holds, and late failures; retry keeps attachments, discard removes only its own failure",async t=>{
 const s=await stage(t);
 const sends=[pending("one"),pending("two",{state:"held"}),pending("gone",{state:"delivered"})].map(({key,...send})=>send) as NonNullable<ControlStatusResponse["sends"]>;
 s.status({...status,sends});await s.show();
 assert.deepEqual(s.bubbleTexts(),["queued one","queued two"],"settled journal history is not a new pending bubble");
 await s.remount();assert.deepEqual(s.bubbleTexts(),["queued one","queued two"]);
 s.status({...status,sends,recent:[{id:"dc-one",kind:"message",state:"failed",at,reason:"late inject failure",ask_id:null}]});await s.show();
 assert.match(s.root.querySelector(".session-pending-failed")!.textContent!,/late inject failure/);
 await s.remount();assert.match(s.root.querySelector(".session-pending-failed")!.textContent!,/late inject failure/);
 await s.click(".session-pending-actions button:last-child");
 assert.deepEqual(s.bubbleTexts(),["queued two"]);
 await s.show();await s.remount();assert.deepEqual(s.bubbleTexts(),["queued two"],"discarded journal failure stays dismissed");
 await act(()=>s.control.send({kind:"message",text:"try attachment",images:["im-fixture.png"],files:["tx-20261004-0123456789abcdef01234567.md"],thread:"layout"}));await s.flush();
 await s.reply({error:"socket refused"},503);
 assert.match(s.root.querySelector(".session-pending-failed")!.textContent!,/socket refused/);
 await s.click(".session-pending-actions button:first-child");
 const {client_id:previous,...original}=s.posted[0] as Record<string,unknown>;
 const {client_id:retried,...retryBody}=s.posted[1] as Record<string,unknown>;
 assert.deepEqual(retryBody,original,"retry retains original attachment ids and thread");
 assert.notEqual(retried,previous,"a retry is a fresh correlation id");
 await s.reply({id:"dc-retry",state:"queued",deliver:"followUp"});
 assert.deepEqual(s.bubbleTexts(),["queued two","try attachment"]);
 await s.remount();
 assert.deepEqual(s.control.pending?.at(-1)?.body.files,["tx-20261004-0123456789abcdef01234567.md"],"retried text attachments survive reload with image ids and thread");
 await s.show([entry("inbox",{who:"Operator",text:"[cp-dashboard inbox — 1 message(s)]\n- time (dc-two): queued two"})]);
 assert.deepEqual(s.bubbleTexts(),["try attachment"],"actual inbox replay promotes held sends too");
});


test("pending updates use existing auto-scroll and leave a reader who scrolled up in place",async t=>{
 const s=await stage(t);await s.show([entry("response")]);
 const el=s.root.querySelector(".session-transcript")!;
 let height=1000,top=600;
 Object.defineProperties(el,{scrollHeight:{configurable:true,get:()=>height},clientHeight:{configurable:true,value:400},scrollTop:{configurable:true,get:()=>top,set:(value:number)=>{top=Math.min(value,height-400);}}});
 height=1100;
 await act(()=>s.control.send({kind:"message",text:"new pending"}));await s.flush();
 assert.equal(top,700,"adding a pending bubble follows the bottom");
 await act(()=>{top=200;el.dispatchEvent(new el.ownerDocument.defaultView!.Event("scroll"));});
 height=1200;
 await s.reply({id:"dc-scroll",state:"queued",deliver:"followUp"});
 await s.show([entry("response"),entry("streaming later")]);
 assert.equal(top,200,"streaming response and pending status do not yank a scrolled reader");
 await s.click(".session-new");assert.equal(top,800,"Jump to latest includes pending sends");
 height=1300;
 await s.show([entry("response"),entry("streaming later"),entry("another response")]);
 assert.equal(top,900,"following remains pinned as pending bubbles move below new entries");
});

test("invalid acknowledgement is a visible failure and does not stall the next queued POST",async t=>{
 const s=await stage(t);await s.show();
 await act(()=>{s.control.send({kind:"message",text:"first"});s.control.send({kind:"message",text:"second"});});await s.flush();
 await s.reply(null);
 assert.match(s.root.querySelector(".session-pending-failed")!.textContent!,/invalid send acknowledgement/);
 assert.equal(s.posted.length,2);
 await s.reply({id:"dc-second",state:"queued",deliver:"followUp"});
 assert.deepEqual(s.bubbleTexts(),["first","second"]);
});


test("transcript arrives before POST acknowledgement: exact correlation removes sending without a duplicate or resurrection",async t=>{
 const s=await stage(t);await s.show();
 await act(()=>s.control.send({kind:"message",text:"arrives first"}));await s.flush();
 const id=(s.posted[0] as {client_id:string}).client_id;
 assert.match(id,/^dc-\d{14}-[a-f0-9]{8}$/);
 await s.show([entry("real",{kind:"via",who:"Operator (dashboard)",text:"arrives first",dashboard_id:id})]);
 assert.deepEqual(s.bubbleTexts(),[]);
 assert.equal([...s.root.querySelectorAll(".md")].filter(el=>el.textContent === "arrives first").length,1);
 await s.reply({id,state:"delivered",deliver:"prompt"});
 assert.deepEqual(s.bubbleTexts(),[]);
 await s.remount();assert.deepEqual(s.bubbleTexts(),[]);
});


test("text-capable composer uploads into the FIFO, keeps chips through failure/retry/reload, and promotes the real file link",async t=>{
 const s=await stage(t);s.status({...status,files:true});await s.show();
 assert.equal(typeof s.control.upload,"function","files-only capability keeps the upload port");
 const input=s.root.querySelector("input[type=file]")!;
 Object.defineProperty(input,"files",{configurable:true,value:[new File(["# notes"],"notes.md",{type:"text/markdown"})]});
 await act(()=>input.dispatchEvent(new input.ownerDocument.defaultView!.Event("change",{bubbles:true})));await s.flush();
 assert.match(s.root.querySelector(".operator-composer-file-name")!.textContent!,/notes.md/);
 await s.click(".operator-composer-send");
 const fileId="tx-20261004-0123456789abcdef01234567.md";
 assert.deepEqual((s.posted[0] as {files:string[]}).files,[fileId]);
 assert.match(s.root.querySelector(".session-pending-attachments")!.textContent!,new RegExp(fileId));
 await s.reply({error:"session disconnected"},503);await s.remount();
 assert.match(s.root.querySelector(".session-pending-failed")!.textContent!,/session disconnected/);
 await s.click(".session-pending-actions button:first-child");
 assert.deepEqual((s.posted[1] as {files:string[]}).files,[fileId]);
 const id=(s.posted[1] as {client_id:string}).client_id;
 await s.show([entry("real-file",{kind:"via",who:"Operator (dashboard)",text:"",dashboard_id:id,files:[fileId],file_metadata:{[fileId]:{name:"notes.md",bytes:7}}})]);
 assert.deepEqual(s.bubbleTexts(),[]);
 assert.equal(s.root.querySelector(".session-file-link")?.getAttribute("href"),`/api/operator/uploads/${fileId}`);
 assert.match(s.root.querySelector(".session-file-link")!.textContent!,/notes.md/);
 await s.reply({id,state:"delivered",deliver:"prompt"});assert.deepEqual(s.bubbleTexts(),[]);
});
