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

const box=(column:number,row=0):GraphBox=>({x:12+column*264,y:196+row*94,w:228,h:58});
function crosses(a:readonly number[],b:readonly number[],node:GraphBox):boolean {
 if(a[0]===b[0]) return a[0]!>node.x && a[0]!<node.x+node.w && Math.max(a[1]!,b[1]!)>node.y && Math.min(a[1]!,b[1]!)<node.y+node.h;
 assert.equal(a[1],b[1],"routing uses orthogonal segments");
 return a[1]!>node.y && a[1]!<node.y+node.h && Math.max(a[0]!,b[0]!)>node.x && Math.min(a[0]!,b[0]!)<node.x+node.w;
}
test("adjacent jobs connect vertically on their facing boundaries",()=>{
 assert.deepEqual(edgePoints(box(0),box(0,1)),[[24,254],[24,290]]);
 assert.deepEqual(edgePoints(box(0,1),box(0)),[[24,290],[24,254]]);
});
test("skipped, backwards, self and cross-column edges avoid intervening job cards",()=>{
 const nodes=Array.from({length:3},(_,r)=>Array.from({length:3},(_,c)=>box(c,r))).flat();
 for(const [from,to] of [[box(0),box(0,2)],[box(0,2),box(0)],[box(0),box(0)],[box(0),box(2)],[box(2,2),box(0)]] as const) {
  const points=edgePoints(from,to);
  for(let i=1;i<points.length;i++) for(const node of nodes) assert.equal(crosses(points[i-1]!,points[i]!,node),false,JSON.stringify({from,to,node}));
 }
});

test("mandates form separate columns and dependencies route around their compact cards",async()=>{
 const {mapLayout,mapLanes}=await geometry();const data=mapQaFixture();
 data.items.push({...data.items.find(m=>m.id==="md-live")!,id:"md-second"});
 data.nodes.push({...data.nodes[1]!,id:"cp-other-column",mandate_id:"md-second"});
 data.edges=[{from:"cp-job-0",to:"cp-job-1",kind:"open"},{from:"cp-job-0",to:"cp-job-2",kind:"satisfied"},{from:"cp-job-5",to:"cp-other-column",kind:"open"}];
 const layout=mapLayout(mapLanes(data,false),680) as {positions:Map<string,GraphBox>;width:number;height:number};
 assert.equal(layout.positions.get("cp-job-0")!.x,12);assert.equal(layout.positions.get("cp-job-2")!.x,12);
 assert.ok(layout.positions.get("cp-job-2")!.y>layout.positions.get("cp-job-0")!.y);
 assert.equal(layout.positions.get("cp-other-column")!.x,276);
 const boxes=[...layout.positions.values()];assert.ok(boxes.every(b=>b.h===58));
 for(const edge of data.edges) {
  const points=edgePoints(layout.positions.get(edge.to)!,layout.positions.get(edge.from)!);
  for(let i=1;i<points.length;i++) for(const node of boxes) assert.equal(crosses(points[i-1]!,points[i]!,node),false,edge.from+" → "+edge.to);
 }
 for(const a of boxes) for(const b of boxes) if(a!==b) assert.ok(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y,"nodes cannot overlap");
});

test("cycles and self-links retain deterministic reachable positions at every pane width",async()=>{
 const {mapLayout,mapLanes}=await geometry();const data=mapQaFixture();
 data.nodes=Array.from({length:227},(_,i)=>({...data.nodes[0]!,id:`cp-cycle-${i}`}));
 data.edges=data.nodes.map((node,i)=>({from:node.id,to:data.nodes[(i+1)%data.nodes.length]!.id,kind:"open"}));
 data.nodes.push({...data.nodes[0]!,id:"cp-self"},{...data.nodes[0]!,id:"cp-descendant"});
 data.edges.push({from:"cp-self",to:"cp-self",kind:"open"},{from:"cp-cycle-0",to:"cp-descendant",kind:"open"});
 for(const pane of [360,520,680,840]) {
  const lanes=mapLanes(data,false),layout=mapLayout(lanes,pane) as {positions:Map<string,GraphBox>;width:number;height:number};
  assert.equal(layout.width,Math.max(pane,516),"the default closed mandate keeps its column");assert.equal(layout.positions.size,data.nodes.length);
  assert.deepEqual(layout,mapLayout(lanes,pane));
  const boxes=[...layout.positions.values()];assert.equal(new Set(boxes.map(box=>box.x)).size,1);
  for(const box of boxes) assert.ok(box.x+box.w<=layout.width && box.y+box.h<=layout.height);
  for(const edge of data.edges) {
   const points=edgePoints(layout.positions.get(edge.to)!,layout.positions.get(edge.from)!);
   for(let i=1;i<points.length;i++) for(const box of boxes) assert.equal(crosses(points[i-1]!,points[i]!,box),false);
  }
 }
});

test("overflowing mandate columns scroll horizontally and history retains every selected job",async()=>{
 const {mapLayout,mapLanes}=await geometry();const data=mapQaFixture();
 const active=data.items.find(m=>m.id==="md-live")!;
 data.items=Array.from({length:12},(_,i)=>({...active,id:`md-column-${i}`})).concat(data.items.filter(m=>m.status!=="active"));
 data.nodes=Array.from({length:12},(_,i)=>({...data.nodes[1]!,id:`cp-column-${i}`,mandate_id:`md-column-${i}`}));
 data.nodes.push({...data.nodes[0]!,id:"cp-history",project:"aaa-old",mandate_id:"md-old"});
 for(const history of [false,true]) {
  const lanes=mapLanes(data,history),layout=mapLayout(lanes,520) as {positions:Map<string,GraphBox>;width:number};
  assert.equal(layout.positions.has("cp-history"),history);
  assert.deepEqual([...layout.positions.keys()].sort(),lanes.flatMap((lane:{jobs:{id:string}[]})=>lane.jobs.map(job=>job.id)).sort());
  assert.ok(layout.width>520);assert.equal(layout.positions.get("cp-column-11")!.x,12+11*264);
 }
});
