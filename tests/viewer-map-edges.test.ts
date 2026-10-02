import assert from "node:assert/strict";
import { test } from "node:test";
import { edgePoints, type GraphBox } from "../viewer-app/screens/map-edges.ts";

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
