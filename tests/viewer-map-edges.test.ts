import assert from "node:assert/strict";
import { test } from "node:test";
import { edgePoints, type GraphBox } from "../viewer-app/screens/map-edges.ts";
import { build } from "esbuild";
import { REPO_ROOT } from "./harness/index.ts";
import { mapQaFixture } from "./fixtures/viewer-mandates-map.ts";

async function geometry() {
 const result=await build({stdin:{contents:'export {mapLayout,mapLanes} from "./viewer-app/screens/MapGraph.tsx";',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
}

const box=(column:number,row=0):GraphBox=>({x:220+column*160,y:52+row*86,w:124,h:56});
function crosses(a:readonly number[],b:readonly number[],node:GraphBox):boolean {
 if(a[0]===b[0]) return a[0]!>node.x && a[0]!<node.x+node.w && Math.max(a[1]!,b[1]!)>node.y && Math.min(a[1]!,b[1]!)<node.y+node.h;
 assert.equal(a[1],b[1],"routing uses orthogonal segments");
 return a[1]!>node.y && a[1]!<node.y+node.h && Math.max(a[0]!,b[0]!)>node.x && Math.min(a[0]!,b[0]!)<node.x+node.w;
}
test("a dependency that skips a job uses the row gap and leaves both endpoints on node boundaries",()=>{
 const points=edgePoints(box(0),box(2));
 assert.deepEqual(points,[[282,108],[282,123],[602,123],[602,108]]);
 for(let i=1;i<points.length;i++) for(const node of [box(0),box(1),box(2)]) assert.equal(crosses(points[i-1]!,points[i]!,node),false);
});
test("cross-lane and backwards routes avoid all intervening job boxes",()=>{
 const nodes=Array.from({length:3},(_,r)=>Array.from({length:3},(_,c)=>box(c,r))).flat();
 for(const [from,to] of [[box(2),box(0)],[box(0),box(2,2)],[box(2,2),box(0)]] as const) {
  const points=edgePoints(from,to);
  for(let i=1;i<points.length;i++) for(const node of nodes) assert.equal(crosses(points[i-1]!,points[i]!,node),false,JSON.stringify({from,to,node}));
 }
 assert.deepEqual(edgePoints(box(0),box(1)),[[344,80],[380,80]]);
});

test("dependency-depth, wrapped and cross-lane edges route through gaps in the taller grid",async()=>{
 const {mapLayout,mapLanes}=await geometry();const data=mapQaFixture();
 data.edges=[{from:"cp-job-0",to:"cp-job-1",kind:"open"},{from:"cp-job-1",to:"cp-job-2",kind:"open"},{from:"cp-job-0",to:"cp-job-2",kind:"satisfied"}];
 data.nodes.push({...data.nodes[0]!,id:"cp-other-lane",project:"aaa-paused",mandate_id:"md-paused"});
 data.edges.push({from:"cp-job-5",to:"cp-other-lane",kind:"open"});
 const layout=mapLayout(mapLanes(data,false),data.edges,680) as {positions:Map<string,GraphBox>;width:number;height:number};
 assert.equal(layout.positions.get("cp-job-0")!.x,220);assert.equal(layout.positions.get("cp-job-2")!.x,540);
 assert.ok(layout.positions.get("cp-job-3")!.y>layout.positions.get("cp-job-2")!.y);
 const boxes=[...layout.positions.values()];assert.ok(boxes.every(b=>b.h===96));
 for(const edge of data.edges) {
  const points=edgePoints(layout.positions.get(edge.from)!,layout.positions.get(edge.to)!);
  for(let i=1;i<points.length;i++) for(const node of boxes) assert.equal(crosses(points[i-1]!,points[i]!,node),false,edge.from+" → "+edge.to);
 }
 for(const a of boxes) for(const b of boxes) if(a!==b) assert.ok(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y,"nodes cannot overlap");
});

test("cycles, self-links and their dependents use a bounded deterministic fallback at every pane width",async()=>{
 const {mapLayout,mapLanes}=await geometry();const data=mapQaFixture();
 data.nodes=Array.from({length:227},(_,i)=>({...data.nodes[0]!,id:`cp-cycle-${i}`}));
 data.edges=data.nodes.map((node,i)=>({from:node.id,to:data.nodes[(i+1)%data.nodes.length]!.id,kind:"open"}));
 data.nodes.push({...data.nodes[0]!,id:"cp-self"},{...data.nodes[0]!,id:"cp-descendant"});
 data.edges.push({from:"cp-self",to:"cp-self",kind:"open"},{from:"cp-cycle-0",to:"cp-descendant",kind:"open"});
 for(const pane of [360,520,680,840]) {
  const lanes=mapLanes(data,false),layout=mapLayout(lanes,data.edges,pane) as {positions:Map<string,GraphBox>;width:number;height:number};
  assert.equal(layout.width,pane);assert.equal(layout.positions.size,data.nodes.length);
  assert.deepEqual(layout,mapLayout(lanes,data.edges,pane));
  const boxes=[...layout.positions.values()];assert.ok(new Set(boxes.map(box=>box.y)).size>1);
  for(const box of boxes) assert.ok(box.x+box.w<=layout.width && box.y+box.h<=layout.height);
  for(const edge of data.edges) {
   const points=edgePoints(layout.positions.get(edge.from)!,layout.positions.get(edge.to)!);
   for(let i=1;i<points.length;i++) for(const box of boxes) assert.equal(crosses(points[i-1]!,points[i]!,box),false);
  }
 }
});

test("a long connected chain scrolls rather than clipping, and history membership remains unchanged",async()=>{
 const {mapLayout,mapLanes}=await geometry();const data=mapQaFixture();
 data.nodes=Array.from({length:12},(_,i)=>({...data.nodes[0]!,id:`cp-chain-${i}`}));
 data.edges=data.nodes.slice(1).map((node,i)=>({from:data.nodes[i]!.id,to:node.id,kind:"open"}));
 data.nodes.push({...data.nodes[0]!,id:"cp-history",project:"aaa-old",mandate_id:"md-old"});
 for(const history of [false,true]) {
  const lanes=mapLanes(data,history),layout=mapLayout(lanes,data.edges,520) as {positions:Map<string,GraphBox>;width:number};
  assert.equal(layout.positions.has("cp-history"),history);
  assert.deepEqual([...layout.positions.keys()].sort(),lanes.flatMap((lane:{jobs:{id:string}[]})=>lane.jobs.map(job=>job.id)).sort());
  assert.ok(layout.width>520);assert.equal(layout.positions.get("cp-chain-11")!.x,220+11*160);
 }
});
