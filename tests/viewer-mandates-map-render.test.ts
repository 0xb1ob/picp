import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { dependencyMap } from "../src/viewer/mandates-map-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { join } from "node:path";
import { LAYOUT } from "../src/contracts.ts";
import { mapQaFixture, mapTitle, mapObjective } from "./fixtures/viewer-mandates-map.ts";

async function renderer() {
 const result=await build({stdin:{contents:'import {h,render as domRender} from "preact"; import {act} from "preact/test-utils"; import render from "preact-render-to-string"; import {DependencyMap} from "./viewer-app/screens/DependencyMap.tsx"; import {Shell} from "./viewer-app/components/Shell.tsx"; export {act}; export const mount=(root,data)=>domRender(h(DependencyMap,{data}),root); export const unmount=root=>domRender(null,root); export const screen=(data)=>render(h(DependencyMap,{data})); export const shell=(screen)=>render(h(Shell,{current:{screen,section:null,classic:null},awaiting:0,status:"live",updatedAt:"2026-09-26T05:41:07Z"}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
}
test("map renders empty, failed, stranded and selected states without inline styles",async t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const {screen}=await renderer();
 const data=dependencyMap(state);assert.match(screen(data,true),/No jobs recorded/);
 data.nodes=[{id:"cp-failed",title:"<script>bad</script>",project:"demo",mandate_id:null,phase:"failed",ledger_status:"in_progress",model:"model",cost_usd:2,pr_url:null,ci:null}];
 data.edges=[{from:"cp-failed",to:"cp-failed",kind:"stranded"}];data.stranded_count=1;
 const html=screen(data,true);assert.match(html,/1 stranded dependency/);assert.match(html,/failed/);assert.match(html,/aria-label="Selection"/);assert.match(html,/&lt;script>/);assert.match(html,/Mandate and job graph/);assert.doesNotMatch(html,/<script>|style=|onclick=/i);
 assert.equal(parseHTML(html).document.querySelector('.map-graph .map-node > span > small')!.textContent,"failed","stranded jobs retain their recorded phase");
 data.nodes[0]!.ledger_status="closed";
 assert.ok(parseHTML(screen(data)).document.querySelector(".map-health-status"),"closed stranded targets do not count as open dependencies");
 data.nodes[0]!.ledger_status="in_progress";
 data.availability.mandates="unavailable";data.stranded_count=null;
 assert.match(screen(data,true),/Dependency status unavailable/);assert.doesNotMatch(screen(data,true),/No stranded dependencies/);
 data.nodes.push({...data.nodes[0]!,id:"cp-right"});
 data.edges=[{from:"cp-right",to:"cp-failed",kind:"open"}];
 assert.match(screen(data,true),/cp-failed blocked by cp-right · open/,"vertical dependencies retain their recorded endpoints and kind");
});

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

test("S6 map exposes clamped objectives and job titles with full accessible names and compact controls",async()=>{
 const {screen}=await renderer();const data=mapQaFixture();
 data.nodes[0]!.id="cp-a-very-long-job-identifier-that-must-stay-accessible";
 data.nodes[0]!.title='Long job title <with markup> & details that must remain accessible beyond the two visible lines';
 const doc=parseHTML(screen(data)).document;
 assert.equal(doc.querySelector("h1")!.textContent,"Jobs");
 const header=doc.querySelector(".map-heading")!;
 assert.ok(header.querySelector('nav[aria-label="Jobs view"]'));
 assert.ok(header.querySelector(".map-legend-summary"));
 assert.ok(header.querySelector(".mandate-history-toggle"));
 assert.equal(header.querySelectorAll(".map-legend-summary .map-legend-chip").length,2);
 const mandate=doc.querySelector('.map-mandate-node[title]')!;
 assert.equal(mandate.querySelector(".map-label")!.textContent,mapObjective);
 assert.equal(mandate.getAttribute("aria-label"),`md-live: ${mapObjective}`);
 for(const job of data.nodes) {
  const node=[...doc.querySelectorAll('.map-graph button')].find(n=>n.getAttribute("title")===`${job.id}: ${job.title}`)!;
  assert.equal(node.querySelector(".map-label")!.textContent,job.title);
  assert.equal(node.getAttribute("aria-label"),`${job.id}: ${job.title}`);
  assert.equal(node.closest("foreignObject")!.getAttribute("height"),"58","compact cards reserve a title line and inline phase");
  const link=doc.querySelector(`.map-mobile-lanes a[href="#job/${job.id}"]`)!;
  assert.equal(link.querySelector(".map-label")!.textContent,job.title);
  assert.equal(link.getAttribute("aria-label"),`${job.id}: ${job.title}`);
 }
 assert.equal(doc.querySelector(".map-status")!.textContent,"✓No stranded dependencies");
 assert.equal(doc.querySelectorAll(".map-node-dim").length,0);
});

test("S6 revision stacks compact jobs inside mandate columns and preserves default history",async()=>{
 const {screen}=await renderer();const data=mapQaFixture();
 data.nodes[1]!.context={tokens:84000,window:272000,percent:31,level:"ok",reason:null,model:"fixture",last_compact_at:null,thinking:null};
 data.items.push({...data.items.find(m=>m.id==="md-live")!,id:"md-second"});
 data.nodes.push({...data.nodes[1]!,id:"cp-second",mandate_id:"md-second"});
 data.edges.push({from:"cp-job-1",to:"cp-job-2",kind:"open"});
 const doc=parseHTML(screen(data)).document;const graph=doc.querySelector(".map-graph")!;
 const jobs=[...graph.querySelectorAll("foreignObject")].filter(box=>box.querySelector('button[title^="cp-job-"]'));
 assert.equal(new Set(jobs.map(box=>box.getAttribute("x"))).size,1,"each mandate owns one vertical job stack");
 assert.equal(new Set(jobs.map(box=>box.getAttribute("y"))).size,data.nodes.length-1);
 assert.equal(graph.querySelectorAll(".map-column").length,4,"active, paused and current closed mandates retain their columns");
 assert.equal(graph.querySelectorAll(".ctx-chip").length,0,"tiles omit context bars");
 assert.equal(doc.querySelectorAll(".map-mobile-job .ctx-chip").length,0);
 assert.doesNotMatch(doc.querySelector(".map-screen")!.textContent!,/md-old|md-revoked/);
 for(const id of ["md-paused","md-closed"]) assert.ok(graph.querySelector(`.map-mandate-node[aria-label^="${id}:"]`));
 assert.match(doc.querySelector(".map-screen")!.textContent!,/Show 2 expired or revoked mandates/);
 assert.ok(graph.textContent!.includes("cp-job-2 blocked by cp-job-0 · satisfied"));
 assert.equal(graph.querySelectorAll(".map-edge-label").length,1,"multiple blockers share a label without overlapping text");
 assert.ok(graph.querySelector(".map-edge-label")!.getAttribute("title")!.includes("cp-job-2 blocked by cp-job-1 · open"));
 assert.ok(doc.querySelector(".map-selection-empty svg"));
});

test("nonadjacent dependency labels clear the done control in a collapsed column",async()=>{
 const {screen}=await renderer();const data=mapQaFixture();
 data.nodes=[...Array.from({length:2},(_,i)=>({...data.nodes[1]!,id:`cp-label-working-${i}`,phase:"working"})),...Array.from({length:3},(_,i)=>({...data.nodes[0]!,id:`cp-label-done-${i}`}))];
 data.edges=[{from:"cp-label-working-0",to:"cp-label-done-0",kind:"open"}];
 const doc=parseHTML(screen(data)).document,graph=doc.querySelector(".map-graph")!;
 const job=graph.querySelector('button[title^="cp-label-done-0:"]')!.closest("foreignObject")!;
 const label=graph.querySelector(".map-edge-label")!.closest("foreignObject")!;
 const control=graph.querySelector(".map-more-done")!,footer=control.closest("foreignObject")!;
 const top=(box:Element)=>Number(box.getAttribute("y")),bottom=(box:Element)=>top(box)+Number(box.getAttribute("height"));
 assert.match(label.textContent!,/cp-label-done-0 blocked by cp-label-working-0 · open/);
 assert.ok(top(label)>=bottom(job),"the skipped dependency label sits below the last shown job");
 assert.ok(top(footer)>=bottom(label)+8,"the label needs its own space and an 8px gap before the collapse control");
 assert.equal(footer.getAttribute("height"),"44");assert.equal(control.textContent,"+2 more done");
 assert.equal(graph.querySelectorAll('button[title^="cp-label-"]').length,3);
 assert.equal(doc.querySelectorAll('.map-mobile-lanes a[href^="#job/cp-label-"]').length,5,"collapsed jobs keep every phone link");
});

test("map prioritizes active projects, selects nothing until a pick, and keeps every job title",async()=>{
 const {screen}=await renderer();const data=mapQaFixture();const html=screen(data,true);
 assert.doesNotMatch(html,/md-old|md-revoked/);assert.match(html,/Show 2 expired or revoked mandates/);assert.ok(html.includes(`title="${mapObjective}"`));
 assert.match(html,/<h1 title="Jobs">Jobs<\/h1>/);assert.doesNotMatch(html,/#mandates|Open mandates/);
 assert.ok(html.indexOf("<h2>pi-command-post-system")<html.indexOf("<h2>aaa-paused"));
 assert.match(html,/Select a job or mandate/);assert.match(html,/Nothing is dimmed until you pick one/);
 assert.doesNotMatch(html,/map-node-dim/);assert.doesNotMatch(html,/job · cp-job-/);
 assert.match(html,/<svg width="840"/);assert.match(html,/foreignObject x="12" y="630"[^>]*height="58"/);
 assert.match(html,/cp-job-2 blocked by cp-job-0 · satisfied/);
 for(let i=0;i<6;i++) assert.ok(html.includes(`title="cp-job-${i}:`));
 assert.doesNotMatch(html,/>https:\/\/github/);
 for(const label of ["working","not dispatched","held","done"]) assert.ok(html.includes(`>${label}<`),label);
 assert.match(html,/← blocked by · open/);assert.match(html,/← satisfied/);
 assert.doesNotMatch(html,/map-full-legend/);
 data.nodes[3]!.phase="waiting";
 const waiting=screen(data,true);
 assert.match(waiting,/no run status/);assert.doesNotMatch(waiting,/>waiting</);
});

test("hundreds of independent jobs stack without losing nodes, full titles or initial reachability",async()=>{
 const {screen}=await renderer();const data=mapQaFixture();
 data.nodes=Array.from({length:227},(_,i)=>({...data.nodes[0]!,phase:"working",ledger_status:"in_progress",id:`cp-independent-${i}-with-a-long-id`,title:`${mapTitle} ${i}`}));data.edges=[];
 const doc=parseHTML(screen(data)).document;const graph=doc.querySelector('.map-graph > svg')!;
 assert.ok(Number(graph.getAttribute("width"))<=840,"independent jobs must not grow the horizontal canvas");
 const boxes=[...graph.querySelectorAll("foreignObject")].filter(box=>box.querySelector('button[title^="cp-independent-"]'));
 assert.equal(boxes.length,227);assert.ok(new Set(boxes.map(box=>box.getAttribute("y"))).size>1);
 for(const [i,box] of boxes.entries()) {
  assert.equal(box.querySelector("button")!.getAttribute("title"),`${data.nodes[i]!.id}: ${data.nodes[i]!.title}`);
  assert.ok(Number(box.getAttribute("x"))+Number(box.getAttribute("width"))<=Number(graph.getAttribute("width")));
  assert.ok(Number(box.getAttribute("y"))+Number(box.getAttribute("height"))<=Number(graph.getAttribute("height")));
  assert.equal(box.querySelector("button")!.getAttribute("aria-pressed"),"false");
 }
 assert.equal(doc.querySelectorAll(".map-node-dim").length,0);
 assert.equal(doc.querySelectorAll('.map-mobile-lanes a[href^="#job/"]').length,227,"phone keeps every job link");
});

test("the mounted graph follows its pane width and releases its resize observer",async t=>{
 const {mount,unmount,act}=await renderer();const data=mapQaFixture();data.edges=[];
 const {window,document}=parseHTML("<html><body><main></main></body></html>");
 const originals=["window","document","ResizeObserver"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 let measure=()=>{},disconnected=false;
 class Observer {constructor(callback:()=>void){measure=callback;} observe(){} disconnect(){disconnected=true;}}
 for(const [key,value] of Object.entries({window,document,ResizeObserver:Observer})) Object.defineProperty(globalThis,key,{configurable:true,value});
 t.after(()=>{for(const [key,descriptor] of originals) {if(descriptor) Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const root=document.querySelector("main")!;
 try {
  await act(()=>mount(root,data));const graph=root.querySelector('.map-graph')!;
  for(const width of [680,520,840]) {
   Object.defineProperty(graph,"clientWidth",{configurable:true,value:width});await act(()=>measure());
   const svg=graph.querySelector("svg")!;assert.equal(Number(svg.getAttribute("width")),width);
   const boxes=[...svg.querySelectorAll('foreignObject')].filter(box=>box.querySelector('button[title^="cp-job-"]'));
   assert.equal(boxes.length,data.nodes.length);
   for(const box of boxes) assert.ok(Number(box.getAttribute("x"))+Number(box.getAttribute("width"))<=width);
  }
 } finally {await act(()=>unmount(root));}
 assert.equal(disconnected,true);
});
test("More's views keep the phone sub-page header with search, the local clock and no live status",async()=>{
 const {shell}=await renderer();
 for(const screen of ["files","schedules","reports"]) {
  const header=/<header[^>]*>(.*?)<\/header>/.exec(shell(screen))?.[1] ?? "";
  assert.match(header,/href="#more".*aria-label="Back to More"/,screen);
  assert.match(header,/command-post/);assert.doesNotMatch(header,/read-only|shell-badge/,"the dashboard acts: no read-only badge");assert.doesNotMatch(header,/shell-live/);
  assert.match(header,/<time class="shell-clock"[^>]*>\d\d:\d\d\b[^<]*<\/time>/,"the data time sits in the phone header");
  assert.equal(parseHTML(header).document.querySelectorAll("time.shell-clock").length,1,screen);
  assert.doesNotMatch(shell(screen),/shell-corner/);
  const search=parseHTML(header).document.querySelector("button.shell-search");
  assert.ok(search);assert.equal(search.getAttribute("aria-haspopup"),"dialog");
  assert.match(search.getAttribute("aria-label") ?? "",/Search/);
  assert.equal(search.hasAttribute("disabled"),false);assert.notEqual(search.getAttribute("aria-disabled"),"true");
 }
 // Audit P4: Map and Board are Jobs views and Decisions a tab, so they take the plain header with the live status.
 for(const screen of ["map","board","decisions"]) {
  const header=/<header[^>]*>(.*?)<\/header>/.exec(shell(screen))?.[1] ?? "";
  assert.doesNotMatch(header,/Back to More/,screen);assert.match(header,/shell-live/,screen);assert.equal(parseHTML(header).document.querySelectorAll("time.shell-clock").length,1,screen);assert.ok(parseHTML(header).document.querySelector("button.shell-search"),screen);
  assert.doesNotMatch(shell(screen),/shell-corner/);
 }
 const job=/<header[^>]*>(.*?)<\/header>/.exec(shell("job"))?.[1] ?? "";
 assert.doesNotMatch(job,/shell-live/);
 assert.equal(parseHTML(job).document.querySelectorAll("time.shell-clock").length,1,"job");
});
test("audit P4 #23 #25 #26: Map carries the List | Board | Map toggle; the sidebar has seven items, the tab bar five, with Jobs lit on Map",async()=>{
 const {screen,shell}=await renderer();
 const map=parseHTML(screen(mapQaFixture())).document;
 const views=map.querySelector('nav[aria-label="Jobs view"]')!;
 assert.deepEqual([...views.querySelectorAll("a")].map(a=>[a.getAttribute("href"),a.textContent,a.getAttribute("aria-current")]),[["#jobs","List",null],["#board","Board",null],["#map","Map","page"]]);
 const doc=parseHTML(shell("map")).document;
 const links=(label:string)=>[...doc.querySelectorAll(`nav[aria-label="${label}"] a`)];
 assert.deepEqual(links("Desktop primary").map(a=>a.getAttribute("href")),["#overview","#decisions","#jobs","#sessions","#reports","#settings","#more"]);
 assert.deepEqual(links("Primary").map(a=>a.getAttribute("href")),["#overview","#decisions","#jobs","#sessions","#more"]);
 for(const label of ["Desktop primary","Primary"]) assert.deepEqual(links(label).filter(a=>a.getAttribute("aria-current")==="page").map(a=>a.getAttribute("href")),["#jobs"],label);
});
