import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { test } from "node:test";
import { createViewer, pollingStreams } from "../src/viewer/server.ts";
import { dependencyMap, dependencyMap as mandateView } from "../src/viewer/mandates-map-view.ts";
import type { MapResponse } from "../src/viewer/api-types.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const now = "2099-09-26T12:00:00Z";
function fixture(t: {after(fn: () => void): void}) {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const state = {home:home.path,stateDir:join(home.path, LAYOUT.state),host:"127.0.0.1",port:0};
 const put = (file:string,value:unknown) => {const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 const grant = (id:string,status:string,project:string) => put(`${LAYOUT.mandates}/${id}.json`,{id,status,projects:[project],issued_at:"2026-01-01T00:00:00Z",expiry:now,objective:`Goal ${id}`,spend_cap:{usd:100,tokens:10000},job_cap:12,dispatch_parallelism:4,ask_on:["risk:high"]});
 return {state,put,grant};
}

test("the map endpoint exposes all grants and cross-project blockers without writing; the mandates page is gone",async t => {
 const {state,put,grant}=fixture(t);
 grant("md-active","active","demo"); grant("md-paused","paused","other");
 for(let i=0;i<7;i++) grant(`md-rev${i}`,"revoked",`old${i}`);
 put(".pi-command-post/jobs.json",{jobs:[
  {id:"cp-a",title:"Dependent",status:"open",labels:["project:demo"],blocked_by:["cp-b","cp-done","cp-drop","cp-missing"]},
  {id:"cp-b",title:"Blocker",status:"open",labels:["project:other"],blocked_by:[]},
  {id:"cp-done",status:"closed",labels:["project:demo"],blocked_by:[]},
  {id:"cp-drop",status:"closed",close_reason:"dropped: skipped",labels:["project:demo"],blocked_by:[]}
 ]});
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-b",project:"other",phase:"failed",usage:{cost_usd:2,total_tokens:200,cache_read:50}}]});
 put(join(LAYOUT.runs, "cp-b/review-1/status.json"),{usage:{cost_usd:0.5,total_tokens:30,cache_read:0}});
 const server=createViewer(state);await new Promise<void>(r=>server.listen(0,state.host,r));state.port=(server.address() as AddressInfo).port;t.after(()=>server.close());
 const snapshot=(dir:string):unknown=>readdirSync(dir,{withFileTypes:true}).map(e=>[e.name,e.isDirectory() ? snapshot(join(dir,e.name)) : readFileSync(join(dir,e.name),"utf8")]);
 const before=snapshot(state.home);
 const get=async<T>(path:string):Promise<T>=>{const r=await fetch(`http://127.0.0.1:${state.port}${path}`);assert.equal(r.status,200,path);return r.json();};
 const map=await get<MapResponse>("/api/map");
 assert.equal(map.items.length,9);assert.equal(map.revoked_count,7);
 assert.deepEqual(map.items.find(m=>m.id==="md-paused")?.spend,{usd:2.5,tokens:180,jobs:1,inFlight:0});
 assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/mandates`)).status,404);
 assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/stream?view=mandates`,{method:"HEAD"})).status,404);
 assert.equal(map.nodes.find(n=>n.id==="cp-b")?.phase,"failed");
 assert.equal(map.nodes.find(n=>n.id==="cp-a")?.mandate_id,"md-active");
 assert.equal(map.edges.find(e=>e.from==="cp-done")?.kind,"satisfied");
 for(const id of ["cp-b","cp-drop","cp-missing"]) assert.equal(map.edges.find(e=>e.from===id)?.kind,"stranded",id);
 assert.equal(map.stranded_count,3);
 assert.ok(map.nodes.some(n=>n.id==="cp-missing" && n.ledger_status===null));
 for(const view of ["map"]) {
  const url=`http://127.0.0.1:${state.port}/api/${view}`;
  assert.equal((await fetch(url,{method:"POST"})).status,405);
  const refused=await new Promise<number>((resolve,reject)=>{const req=request(url,{headers:{host:"evil.example"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));});req.on("error",reject);req.end();});
  assert.equal(refused,421);
  assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/stream?view=${view}`,{method:"HEAD"})).status,200);
 }
 assert.equal(pollingStreams(),0);assert.deepEqual(snapshot(state.home),before);
 put(join(LAYOUT.mandates, "md-bad.json"),{status:"bad"});
 const broken=await get<MapResponse>("/api/map");assert.equal(broken.stranded_count,null);assert.equal(broken.availability.mandates,"unavailable");
});

test("launching consumes a slot, held does not; revoked and expired grants retain their recorded status",t=>{
 const {state,put,grant}=fixture(t);
 grant("md-live","active","demo");grant("md-old","revoked","old");
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-launch",project:"demo",phase:"launching"},{job_id:"cp-held",project:"demo",phase:"held"}]});
 const data=mandateView(state,Date.parse("2026-09-26T12:00:00Z"));
 assert.equal(data.items.find(m=>m.id==="md-live")?.spend?.inFlight,1);
 assert.equal(data.items.find(m=>m.id==="md-live")?.spend?.jobs,2);
 const expired=mandateView(state,Date.parse("2100-01-01T00:00:00Z"));
 assert.equal(expired.items.find(m=>m.id==="md-live")?.status,"expired");
 assert.equal(expired.items.find(m=>m.id==="md-old")?.status,"revoked");
 assert.equal(dependencyMap(state).nodes.find(n=>n.id==="cp-launch")?.phase,"launching");
 put(LAYOUT.fleetFile,{jobs:[{job_id:"../bad",project:"demo",phase:"held"}]});
 assert.equal(mandateView(state).items.find(m=>m.id==="md-live")?.spend,null);
});

test("closed today is derived only from complete named-job closure records; titles and PR status remain recorded",t=>{
 const {state,put,grant}=fixture(t);const at=Date.parse("2026-09-26T12:00:00Z");
 grant("md-broad","active","demo");
 for(const [id,status,ids] of [["md-finished","active",["cp-one","cp-two"]],["md-incomplete","active",["cp-one","cp-missing"]],["md-paused","paused",["cp-one"]],["md-revoked","revoked",["cp-one"]]] as const) {
  put(`${LAYOUT.mandates}/${id}.json`,{id,status,projects:["demo"],job_ids:ids,issued_at:"2026-01-01T00:00:00Z",expiry:status==="paused" ? "2026-09-25T12:00:00Z" : now,spend_cap:{usd:100,tokens:1000}});
 }
 const title="[c-parent-host] host the parent RPC pipe outside the operator process";
 put(".pi-command-post/jobs.json",{jobs:[{id:"cp-one",title,status:"closed",closed_at:"2026-09-26T11:03:00Z",labels:["project:demo"]},{id:"cp-two",status:"closed",closed_at:"2026-09-25T12:00:00Z",labels:["project:demo"]}]});
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-one",project:"demo",phase:"done",receipts:[{kind:"pr",url:"https://github.com/acme/repo/pull/254",status:"merged"}]}]});
 const data=mandateView(state,at);
 assert.equal(data.items.find(m=>m.id==="md-finished")?.status,"closed");
 for(const [id,status] of [["md-broad","active"],["md-incomplete","active"],["md-paused","paused"],["md-revoked","revoked"]]) assert.equal(data.items.find(m=>m.id===id)?.status,status);
 assert.equal(data.active_count,2);
 const map=dependencyMap(state,at);assert.equal(map.nodes.find(n=>n.id==="cp-one")?.title,title);
 assert.equal(map.nodes.find(n=>n.id==="cp-one")?.pr_status,"merged");
});

test("mission-end closes count on the revocation day without relabeling ordinary revocations",t=>{
 const {state,put}=fixture(t); const at=Date.parse("2026-09-26T12:00:00Z");
 for(const id of ["md-close","md-label","md-old","md-manual","md-open","md-extend","md-future"]) {
  put(`${LAYOUT.mandates}/${id}.json`,{id,status:"revoked",projects:["demo"],issued_at:"2026-01-01T00:00:00Z",expiry:now,spend_cap:{usd:10,tokens:100},revoked_at:id==="md-old" ? "2026-09-25T11:00:00Z" : id==="md-future" ? "2026-09-26T13:00:00Z" : "2026-09-26T11:00:00Z"});
 }
 put(LAYOUT.escalationsFile,{items:["close","label","old","open","extend","future"].map(id=>({id:`es-${id}`,mandate_id:`md-${id}`,kind:"mission_end",status:id==="open" ? "open" : "answered",answer:id==="label" ? "Close the mission" : id==="extend" ? "extend" : "close",answered_at:"2026-09-26T10:00:00Z",options:[{id:"close",label:"Close the mission"}]}))});
 const data=mandateView(state,at);
 assert.deepEqual(data.items.filter(m=>m.closed_at).map(m=>m.id),["md-close","md-label"]);
 assert.equal(data.revoked_count,7);
 assert.ok(data.items.every(m=>m.status==="revoked"));
 put(LAYOUT.escalationsFile,"{bad");
 assert.equal(mandateView(state,at).availability.escalations,"unavailable");
});

test("single-project state uses explicit coverage and reports open and expired blockers",t=>{
 const {state,put}=fixture(t);const single={...state,stateDir:join(state.home,".pi-command-post/state")};
 put(".pi-command-post/state/mandates/md-limit.json",{id:"md-limit",status:"active",projects:["demo"],job_ids:["cp-b"],issued_at:"2026-01-01T00:00:00Z",expiry:now,spend_cap:{usd:10,tokens:100}});
 put(".pi-command-post/jobs.json",{jobs:[{id:"cp-a",status:"open",labels:["project:demo"],blocked_by:["cp-b"]},{id:"cp-b",status:"open",labels:["project:demo"],blocked_by:[]}]});
 const map=dependencyMap(single,Date.parse("2026-09-26T12:00:00Z"));
 assert.equal(map.nodes.find(n=>n.id==="cp-a")?.mandate_id,null);
 assert.equal(map.nodes.find(n=>n.id==="cp-b")?.mandate_id,"md-limit");
 assert.equal(map.edges[0]?.kind,"open");assert.equal(map.stranded_count,0);
 assert.equal(dependencyMap(single,Date.parse("2100-01-01T00:00:00Z")).edges[0]?.kind,"stranded");
});
