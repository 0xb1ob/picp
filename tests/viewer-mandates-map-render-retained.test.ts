// Retained (P18c): DependencyMap's closed stamp for a closure with no date; the viewer always sends closed_at with it.
// The rest of this flow is P18-map-render in tests/e2e/viewer-ui-p18c.test.ts.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";
import { mapQaFixture, mapTitle } from "./fixtures/viewer-mandates-map.ts";

async function renderer() {
 const result=await build({stdin:{contents:'import {h,render as domRender} from "preact"; import {act} from "preact/test-utils"; import render from "preact-render-to-string"; import {DependencyMap} from "./viewer-app/screens/DependencyMap.tsx"; import {Shell} from "./viewer-app/components/Shell.tsx"; export {act}; export const mount=(root,data)=>domRender(h(DependencyMap,{data}),root); export const unmount=root=>domRender(null,root); export const screen=(data)=>render(h(DependencyMap,{data})); export const shell=(screen)=>render(h(Shell,{current:{screen,section:null,classic:null},awaiting:0,status:"live",updatedAt:"2026-09-26T05:41:07Z"}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
}

test("Map shows today's revoked mission closures and toggles older history in the browser's local day",async t=>{
 const {mount,unmount,act}=await renderer();const data=mapQaFixture();
 // The day boundary is the browser's own zone: 23:00Z on the 25th and 02:00Z on the 26th are both Sep 25 in Los Angeles.
 const zone=process.env.TZ;process.env.TZ="America/Los_Angeles";t.after(()=>{if(zone===undefined) delete process.env.TZ;else process.env.TZ=zone;});
 data.generated_at="2026-09-26T02:00:00Z";
 const recent=data.items.find(m=>m.id==="md-revoked")!;recent.closed_at="2026-09-25T23:00:00Z";
 data.items.push({...recent,id:"md-history",closed_at:"2026-09-25T01:00:00Z"});
 data.nodes.push({...data.nodes[0]!,id:"cp-recent",project:recent.projects[0]!,mandate_id:recent.id});
 data.nodes.push({...data.nodes[0]!,id:"cp-history",project:recent.projects[0]!,mandate_id:"md-history"});
 delete data.items.find(m=>m.id==="md-closed")!.closed_at;
 const {window,document}=parseHTML("<html><body><main></main></body></html>");
 const originals=["window","document"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,"window",{configurable:true,value:window});
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 t.after(()=>{for(const [key,descriptor] of originals) {if(descriptor) Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const root=document.querySelector("main")!;
 {
  await act(()=>mount(root,data));
  for(const id of ["md-revoked","cp-recent","md-paused","md-closed"]) assert.ok(root.textContent!.includes(id));
  assert.ok(root.querySelector('.map-mandate-node[aria-label^="md-paused:"]'));
  assert.ok(root.querySelector('.map-mandate-node[aria-label^="md-closed:"]'));
  assert.doesNotMatch(root.textContent!,/md-history|md-old|cp-history/);
  assert.match(root.textContent!,/Show 2 expired or revoked mandates/);
  const toggle=root.querySelector<HTMLInputElement>('.mandate-history-toggle input')!;
  await act(()=>{toggle.checked=true;toggle.dispatchEvent(new window.Event("change",{bubbles:true}));});
  for(const id of ["md-history","md-old","md-revoked","md-paused","md-closed","cp-recent","cp-history"]) assert.ok(root.textContent!.includes(id));
  assert.equal(root.querySelector('.map-mandate-node[aria-label^="md-closed:"] small')!.textContent,"closed","unknown closure dates do not invent a day");
  const historyNode=root.querySelector<HTMLButtonElement>('.map-graph button[title^="cp-history:"]')!;
  await act(()=>historyNode.dispatchEvent(new window.Event("click",{bubbles:true})));
  assert.match(root.textContent!,/job · cp-history/);
  await act(()=>{toggle.checked=false;toggle.dispatchEvent(new window.Event("change",{bubbles:true}));});
  assert.match(root.textContent!,/md-revoked/);assert.match(root.textContent!,/cp-recent/);
  assert.doesNotMatch(root.textContent!,/md-history|md-old|cp-history/);
  const legend=root.querySelector<HTMLButtonElement>('[aria-label="Show full legend"]')!;
  await act(()=>{legend.dispatchEvent(new window.Event("click",{bubbles:true}));});
  assert.equal(legend.getAttribute("aria-pressed"),"true");
  for(const label of ["working","not dispatched","held","failed","launching","done","blocked by · open","stranded","blocked by · satisfied","dependency removed","pipeline","waits on PR · CI red","superseded by","repairs"]) assert.ok(root.querySelector(".map-full-legend")!.textContent!.includes(label),label);
  await act(()=>{legend.dispatchEvent(new window.Event("click",{bubbles:true}));});
  assert.equal(legend.getAttribute("aria-pressed"),"false");assert.equal(root.querySelector(".map-full-legend"),null);
  assert.match(root.textContent!,/Select a job or mandate/);
  assert.equal(root.querySelectorAll(".map-node-dim").length,0);
  const pick=(id:string)=>[...root.querySelectorAll("button")].find(b=>(b.getAttribute("title")??"").startsWith(`${id}:`))!;
  await act(()=>{pick("cp-job-2").dispatchEvent(new window.Event("click",{bubbles:true}));});
  assert.match(root.textContent!,/job · cp-job-2/);
  assert.ok(root.textContent!.includes(mapTitle));
  assert.ok(root.querySelector(".map-node-dim"));
  assert.match(root.innerHTML,/#265 · CI running/);
  data.nodes.find(n=>n.id==="cp-job-2")!.pr_status="merged";
  await act(()=>mount(root,data));
  assert.match(root.innerHTML,/#265 · merged/);
  assert.doesNotMatch(root.innerHTML,/>https:\/\/github/);
  for(let i=0;i<4;i++) data.nodes.push({...data.nodes[0]!,id:`cp-more-done-${i}`});
  data.edges.push({from:"cp-more-done-3",to:"cp-job-2",kind:"open"});
  await act(()=>mount(root,data));
  const more=root.querySelector<HTMLButtonElement>(".map-more-done")!;
  assert.equal(more.textContent,"+4 more done");
  assert.equal(more.tagName,"BUTTON","native buttons support Enter and Space activation");
  assert.equal(more.hasAttribute("disabled"),false);assert.notEqual(more.getAttribute("aria-disabled"),"true");
  assert.ok(Number(more.getAttribute("tabindex") ?? 0)>=0,"the enabled native button stays in the keyboard tab order");
  assert.equal(more.getAttribute("aria-expanded"),"false");
  const hiddenEdge=()=>[...root.querySelectorAll(".map-graph .map-edge > title")].find(title=>title.textContent==="cp-job-2 blocked by cp-more-done-3 · open");
  assert.equal(hiddenEdge(),undefined,"an edge with a collapsed endpoint is initially hidden");
  assert.equal(root.querySelectorAll('.map-graph button[title^="cp-more-done-"]').length,0);
  assert.equal(root.querySelectorAll('.map-done-details a[href^="#job/cp-more-done-"]').length,4,"phone disclosure retains all finished links");
  await act(()=>more.dispatchEvent(new window.Event("click",{bubbles:true})));
  assert.equal(more.getAttribute("aria-expanded"),"true");
  assert.equal(root.querySelectorAll('.map-graph button[title^="cp-more-done-"]').length,4);
  assert.ok(hiddenEdge()?.parentElement?.querySelector("path"),"expansion restores the hidden endpoint's edge path");
  assert.ok(hiddenEdge()?.parentElement?.querySelector("polygon"),"the restored edge keeps its arrow");
  await act(()=>pick("cp-more-done-3").dispatchEvent(new window.Event("click",{bubbles:true})));
  assert.match(root.textContent!,/job · cp-more-done-3/);
  await act(()=>more.dispatchEvent(new window.Event("click",{bubbles:true})));
  assert.equal(more.getAttribute("aria-expanded"),"false");
  assert.equal(hiddenEdge(),undefined,"collapsing again hides that edge with its endpoint");
  assert.match(root.textContent!,/Select a job or mandate/);assert.equal(root.querySelectorAll(".map-node-dim").length,0);
  await act(()=>unmount(root));
 }
});
