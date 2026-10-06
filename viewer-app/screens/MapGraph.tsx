import { useEffect, useRef, useState } from "preact/hooks";
import type { MandateItem, MandatesResponse, MapNode, MapResponse } from "../../src/viewer/api-types.ts";
import { edgePoints, type GraphBox } from "./map-edges.ts";
import { count, elapsed, money, percent, phaseText, time } from "../format.ts";
import { ContextChip } from "../components/ContextChip.tsx";
function closedToday(m:MandateItem,data:MandatesResponse):boolean {
 const day=new Intl.DateTimeFormat("en",{year:"numeric",month:"numeric",day:"numeric"});
 return m.status==="closed" || m.status==="revoked" && !!m.closed_at && Number.isFinite(Date.parse(m.closed_at)) && day.format(new Date(m.closed_at))===day.format(new Date(data.generated_at));
}
export function visibleMandates(data:MandatesResponse,history=false):MandateItem[] {
 const order=["active","paused","closed","expired","revoked"];
 return data.items.filter(m=>history || ["active","paused"].includes(m.status) || closedToday(m,data)).sort((a,b)=>order.indexOf(a.status)-order.indexOf(b.status));
}
export function MandateHistoryToggle({data,checked,onChange}:{data:MandatesResponse;checked:boolean;onChange:(value:boolean)=>void}) {
 const hidden=data.availability.mandates==="unavailable" ? null : data.items.length-visibleMandates(data).length;
 return <label class="mandate-history-toggle">Show {count(hidden)} expired or revoked mandates<input type="checkbox" checked={checked} onChange={e=>onChange(e.currentTarget.checked)}/></label>;
}
export function expiry(m:MandateItem,now:string):string {
 if(m.status==="closed") return m.closed_at ? `closed ${time(m.closed_at)}` : "closed today";
 if(m.status==="revoked") return "revoked";
 const seconds=(Date.parse(m.expiry)-Date.parse(now))/1000;
 return seconds<=0 ? `expired ${new Date(m.expiry).toLocaleDateString("en",{month:"short",day:"numeric"})}` : `${elapsed(seconds)} left`;
}
export function SourceWarnings({data}:{data:MandatesResponse}) {
 return <>{Object.entries(data.availability).filter(([,v])=>v==="unavailable").map(([name])=><p class="overview-error" role="alert" key={name}>{name}: recorded data unavailable or malformed.</p>)}</>;
}
export interface MapLane { project:string; mandate:MandateItem | null; jobs:MapNode[] }
export function mapLanes(data:MapResponse,history:boolean):MapLane[] {
 const visible=visibleMandates(data,history);
 const activeProjects=new Set(visible.filter(m=>m.status==="active").flatMap(m=>m.projects));
 const projects=[...new Set([...visible.flatMap(m=>m.projects),...data.nodes.map(n=>n.project)])].sort((a,b)=>Number(activeProjects.has(b))-Number(activeProjects.has(a)) || a.localeCompare(b));
 return projects.flatMap(project=>{
  const mandates=visible.filter(m=>m.projects.includes(project));
  const lanes=mandates.map(m=>({project,mandate:m,jobs:data.nodes.filter(n=>n.project===project && n.mandate_id===m.id)}));
  const uncovered=data.nodes.filter(n=>n.project===project && !n.mandate_id);
  return uncovered.length ? [...lanes,{project,mandate:null,jobs:uncovered}] : lanes;
 });
}
export const phaseClass=(phase:string)=>`map-dot map-dot-${phase.replaceAll(" ","-")}`;
export function mapLayout(lanes:MapLane[],edges:MapResponse["edges"],paneWidth=840) {
 const positions=new Map<string,GraphBox>();
 const rows:{lane:MapLane;y:number;heading:boolean;height:number}[]=[];
 let y=0,project="",width=Math.max(360,Math.floor(paneWidth));
 const columns=Math.max(1,Math.floor((width-220-16+36)/160));
 for(const lane of lanes) {
  const heading=project!==lane.project;if(heading){y+=44;project=lane.project;}
  const ids=new Set(lane.jobs.map(job=>job.id));
  const incoming=new Map(lane.jobs.map(job=>[job.id,0]));
  const outgoing=new Map(lane.jobs.map(job=>[job.id,[] as string[]]));
  const connected=new Set<string>();
  for(const edge of edges) if(ids.has(edge.from) && ids.has(edge.to)) {
   incoming.set(edge.to,incoming.get(edge.to)!+1);outgoing.get(edge.from)!.push(edge.to);
   connected.add(edge.from);connected.add(edge.to);
  }
  const queue=lane.jobs.filter(job=>incoming.get(job.id)===0).map(job=>job.id);
  const depth=new Map(queue.map(id=>[id,0]));
  // ponytail: depth is lane-local; global layering if cross-lane graphs need aligned columns.
  for(let i=0;i<queue.length;i++) for(const to of outgoing.get(queue[i]!)!) {
   depth.set(to,Math.max(depth.get(to)??0,depth.get(queue[i]!)!+1));
   incoming.set(to,incoming.get(to)!-1);if(incoming.get(to)===0) queue.push(to);
  }
  const columnRows=new Map<number,number>();
  let connectedRows=0;
  const place=(id:string,column:number,row:number)=>{
   const box={x:220+column*160,y:y+8+row*126,w:124,h:96};
   positions.set(id,box);width=Math.max(width,box.x+box.w+16);
  };
  for(const job of lane.jobs) if(connected.has(job.id) && incoming.get(job.id)===0) {
   const column=depth.get(job.id)!;const row=columnRows.get(column)??0;
   place(job.id,column,row);columnRows.set(column,row+1);connectedRows=Math.max(connectedRows,row+1);
  }
  // Independent jobs and the cyclic remainder wrap in stable input order, without recursion.
  const wrapped=lane.jobs.filter(job=>!positions.has(job.id));
  wrapped.forEach((job,i)=>place(job.id,i%columns,connectedRows+Math.floor(i/columns)));
  const height=Math.max(1,connectedRows+Math.ceil(wrapped.length/columns))*126;
  rows.push({lane,y,heading,height});y+=height;
 }
 return {positions,rows,width,height:y+8};
}
export function MapGraph({data,lanes,selection,onSelect}:{data:MapResponse;lanes:MapLane[];selection:string|null;onSelect:(id:string)=>void}) {
 const graph=useRef<HTMLDivElement>(null),[paneWidth,setPaneWidth]=useState(840);
 useEffect(()=>{
  const element=graph.current;if(!element) return;
  const measure=()=>{if(element.clientWidth>0) setPaneWidth(element.clientWidth);};
  measure();if(typeof ResizeObserver==="undefined") return;
  const observer=new ResizeObserver(measure);observer.observe(element);
  return ()=>observer.disconnect();
 },[]);
 const {positions,rows,width,height}=mapLayout(lanes,data.edges,paneWidth);
 const lit=selection ? new Set([selection]) : null;
 if(lit){
  for(const e of data.edges){if(e.from===selection)lit.add(e.to);if(e.to===selection)lit.add(e.from);}
  for(const lane of lanes)for(const n of lane.jobs){if(n.id===selection && lane.mandate)lit.add(lane.mandate.id);if(lane.mandate?.id===selection)lit.add(n.id);}
 }
 return <div ref={graph} class="map-graph" role="region" aria-label="Mandate and job graph" tabIndex={0}><svg width={width} height={height} aria-label="Dependency graph">
  {rows.map(({lane,y,heading,height})=><g key={`${lane.project}:${lane.mandate?.id ?? "none"}`}>
   {heading && <text x={0} y={y-20} class="map-project-heading">{lane.project}</text>}
   <rect x={0} y={y-6} width={width} height={height-4} rx={14} class="map-band"/>
  </g>)}
  {data.edges.map(e=>{
   const a=positions.get(e.from),b=positions.get(e.to);if(!a || !b)return null;
   const points=edgePoints(a,b),[x1,y1]=points.at(-2)!,[x2,y2]=points.at(-1)!;
   const length=Math.hypot(x2-x1,y2-y1)||1,ux=(x2-x1)/length,uy=(y2-y1)/length,bx=x2-7*ux,by=y2-7*uy;
   const path=points.slice(0,-1).map(([x,y],i)=>`${i ? "L" : "M"}${x} ${y}`).join("")+`L${bx} ${by}`;
   return <g key={`${e.from}:${e.to}`} class={`map-edge map-edge-${e.kind}${selection && e.from!==selection && e.to!==selection ? " map-edge-dim" : ""}`}><title>{e.to} blocked by {e.from}: {e.kind}</title><path d={path}/><polygon points={`${x2},${y2} ${bx-3.5*uy},${by+3.5*ux} ${bx+3.5*uy},${by-3.5*ux}`}/></g>;
  })}
  {rows.map(({lane,y})=><g key={`nodes:${lane.project}:${lane.mandate?.id ?? "none"}`}>
   <foreignObject x={0} y={y} width={180} height={96}>{lane.mandate ? <button class={`map-node map-mandate-node ${lane.mandate.status!=="active" ? "map-inactive" : ""}${lit && !lit.has(lane.mandate.id) ? " map-node-dim" : ""}`} title={lane.mandate.objective} aria-label={`${lane.mandate.id}: ${lane.mandate.objective}`} aria-pressed={selection===lane.mandate.id} onClick={()=>onSelect(lane.mandate!.id)}><span><code>{lane.mandate.id}</code><small>{lane.mandate.status}</small></span><span class="map-label">{lane.mandate.objective}</span><svg width="100%" height={3} aria-hidden="true"><rect width="100%" height={3} class="map-bar-track"/>{lane.mandate.spend && lane.mandate.spend_cap.usd!==null && <rect width={`${percent(lane.mandate.spend.usd,lane.mandate.spend_cap.usd)}%`} height={3} class="map-bar"/>}</svg><span><small>{money(lane.mandate.spend?.usd ?? null)} / {money(lane.mandate.spend_cap.usd)}</small><small>{expiry(lane.mandate,data.generated_at)}</small></span></button> : <div class="map-uncovered">No mandate</div>}</foreignObject>
   {lane.jobs.map(job=>{
    const p=positions.get(job.id)!;const stranded=data.edges.some(e=>e.to===job.id && e.kind==="stranded" && job.ledger_status!=="closed");
    return <foreignObject key={job.id} x={p.x} y={p.y} width={p.w} height={p.h}><button class={`map-node${stranded ? " map-node-stranded" : ""}${lit && !lit.has(job.id) ? " map-node-dim" : ""}`} title={`${job.id}: ${job.title}`} aria-label={`${job.id}: ${job.title}`} aria-pressed={selection===job.id} onClick={()=>onSelect(job.id)}><span><i class={phaseClass(job.phase)}/><code>{job.id}</code></span><span class="map-label">{job.title}</span><small>{stranded ? "stranded" : phaseText(job.phase)}{job.phase==="failed" && job.ledger_status ? ` · ledger ${job.ledger_status}` : ""}</small><ContextChip usage={job.context} compact/></button></foreignObject>;
   })}
  </g>)}
 </svg></div>;
}
