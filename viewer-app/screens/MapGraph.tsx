import { useEffect, useRef, useState } from "preact/hooks";
import type { MandateItem, MandatesResponse, MapNode, MapResponse } from "../../src/viewer/api-types.ts";
import { edgePoints, type GraphBox } from "./map-edges.ts";
import { amount, count, elapsed, money, phaseText, time } from "../format.ts";
export function mapJobs(jobs:MapNode[]) {
 const hidden=jobs.filter(n=>n.phase==="done" || n.ledger_status==="closed").slice(1);
 const ids=new Set(hidden.map(n=>n.id));
 return {shown:jobs.filter(n=>!ids.has(n.id)),hidden};
}
export function visibleMandates(data:MandatesResponse,history=false):MandateItem[] {
 const order=["active","paused","closed","expired","revoked"];
 return data.items.filter(m=>history || m.status==="active").sort((a,b)=>order.indexOf(a.status)-order.indexOf(b.status));
}
export function MandateHistoryToggle({data,checked,onChange}:{data:MandatesResponse;checked:boolean;onChange:(value:boolean)=>void}) {
 const hidden=data.availability.mandates==="unavailable" ? null : data.items.length-visibleMandates(data).length;
 return <label class="mandate-history-toggle">Show {count(hidden)} inactive mandates<input type="checkbox" checked={checked} onChange={e=>onChange(e.currentTarget.checked)}/></label>;
}
export function expiry(m:MandateItem,now:string):string {
 if(m.status==="closed") return m.closed_at ? `closed ${time(m.closed_at)}` : "closed";
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
export function mapLayout(lanes:MapLane[],paneWidth=840) {
 const positions=new Map<string,GraphBox>();
 const columns:{lane:MapLane;x:number;y:number;heading:boolean;height:number}[]=[];
 let y=32,x=0,project="",bottom=32,width=Math.max(360,Math.floor(paneWidth));
 for(const lane of lanes) {
  const heading=project!==lane.project;
  if(heading){if(project) y=bottom+44;project=lane.project;x=0;}
  lane.jobs.forEach((job,i)=>positions.set(job.id,{x:x+12,y:y+128+i*94,w:228,h:58}));
  const height=128+lane.jobs.length*94+32;
  columns.push({lane,x,y,heading,height});bottom=Math.max(bottom,y+height);
  width=Math.max(width,x+252);x+=264;
 }
 return {positions,columns,width,height:bottom+8};
}
export function MapGraph({data,lanes,selection,onSelect,healthy}:{data:MapResponse;lanes:MapLane[];selection:string|null;onSelect:(id:string)=>void;healthy:boolean}) {
 const graph=useRef<HTMLDivElement>(null),[paneWidth,setPaneWidth]=useState(840);
 useEffect(()=>{
  const element=graph.current;if(!element) return;
  const measure=()=>{if(element.clientWidth>0) setPaneWidth(element.clientWidth);};
  measure();if(typeof ResizeObserver==="undefined") return;
  const observer=new ResizeObserver(measure);observer.observe(element);
  return ()=>observer.disconnect();
 },[]);
 const [expanded,setExpanded]=useState<string[]>([]);
 const key=(lane:MapLane)=>`${lane.project}:${lane.mandate?.id ?? "none"}`;
 const shown=lanes.map(lane=>({...lane,jobs:expanded.includes(key(lane)) ? lane.jobs : mapJobs(lane.jobs).shown}));
 const {positions,columns,width,height}=mapLayout(shown,paneWidth);
 const labels=new Map<string,string[]>();
 for(const e of data.edges) if(positions.has(e.from) && positions.has(e.to)) labels.set(e.to,[...(labels.get(e.to) ?? []),`${e.to} blocked by ${e.from} · ${e.kind}`]);
 const lit=selection ? new Set([selection]) : null;
 if(lit){
  for(const e of data.edges){if(e.from===selection)lit.add(e.to);if(e.to===selection)lit.add(e.from);}
  for(const lane of lanes)for(const n of lane.jobs){if(n.id===selection && lane.mandate)lit.add(lane.mandate.id);if(lane.mandate?.id===selection)lit.add(n.id);}
 }
 return <div ref={graph} class="map-graph" role="region" aria-label="Mandate and job graph" tabIndex={0}><svg width={width} height={height} aria-label="Dependency graph">
  {columns.map(({lane,x,y,heading,height})=><g key={key(lane)} class="map-column">
   {heading && <><text x={0} y={y-20} class="map-project-heading">{lane.project}</text>{healthy && <text x={lane.project.length*8+16} y={y-20} class="map-health-status"><tspan class="map-health-check">✓</tspan> No stranded dependencies</text>}</>}
   <rect x={x} y={y} width={252} height={height} rx={16} class="map-band"/>
  </g>)}
  {data.edges.map(e=>{
   const a=positions.get(e.from),b=positions.get(e.to);if(!a || !b)return null;
   const points=edgePoints(b,a),[x1,y1]=points.at(-2)!,[x2,y2]=points.at(-1)!;
   const length=Math.hypot(x2-x1,y2-y1)||1,ux=(x2-x1)/length,uy=(y2-y1)/length,bx=x2-7*ux,by=y2-7*uy;
   const path=points.slice(0,-1).map(([x,y],i)=>`${i ? "L" : "M"}${x} ${y}`).join("")+`L${bx} ${by}`;
   const label=`${e.to} blocked by ${e.from} · ${e.kind}`;
   const text=labels.get(e.to)!.join("; "),labelY=a.x===b.x && Math.abs(a.y-b.y)===94 ? Math.max(a.y,b.y)-25 : b.y+b.h+8;
   return <g key={`${e.from}:${e.to}`} class={`map-edge map-edge-${e.kind}${selection && e.from!==selection && e.to!==selection ? " map-edge-dim" : ""}`}><title>{label}</title><path d={path}/><polygon points={`${x2},${y2} ${bx-3.5*uy},${by+3.5*ux} ${bx+3.5*uy},${by-3.5*ux}`}/>{labels.get(e.to)![0]===label && <foreignObject x={b.x+26} y={labelY} width={b.w-26} height={22}><p class="map-edge-label" title={text}>{text}</p></foreignObject>}</g>;
  })}
  {columns.map(({lane,x,y,height})=>{
   const original=lanes.find(l=>key(l)===key(lane))!,hidden=mapJobs(original.jobs).hidden,isExpanded=expanded.includes(key(lane));
   return <g key={`nodes:${key(lane)}`}>
    <foreignObject x={x+12} y={y+12} width={228} height={104}>{lane.mandate ? <button class={`map-node map-mandate-node ${lane.mandate.status!=="active" ? "map-inactive" : ""}${lit && !lit.has(lane.mandate.id) ? " map-node-dim" : ""}`} title={lane.mandate.objective} aria-label={`${lane.mandate.id}: ${lane.mandate.objective}`} aria-pressed={selection===lane.mandate.id} onClick={()=>onSelect(lane.mandate!.id)}><span><code>{lane.mandate.id}</code><small>{expiry(lane.mandate,data.generated_at)}</small></span><span class="map-label">{lane.mandate.objective}</span><small>{money(lane.mandate.spend?.usd ?? null)} / {money(lane.mandate.spend_cap.usd)} · {amount(lane.mandate.spend?.tokens ?? null)} / {amount(lane.mandate.spend_cap.tokens)} tok{lane.mandate.status!=="active" && ` · ${lane.mandate.status}`}</small></button> : <div class="map-uncovered">No mandate</div>}</foreignObject>
    {lane.jobs.map(job=>{
     const p=positions.get(job.id)!;const stranded=data.edges.some(e=>e.to===job.id && e.kind==="stranded" && job.ledger_status!=="closed");
     return <foreignObject key={job.id} x={p.x} y={p.y} width={p.w} height={p.h}><button class={`map-node${stranded ? " map-node-stranded" : ""}${lit && !lit.has(job.id) ? " map-node-dim" : ""}`} title={`${job.id}: ${job.title}`} aria-label={`${job.id}: ${job.title}`} aria-pressed={selection===job.id} onClick={()=>onSelect(job.id)}><span><i class={phaseClass(job.phase)}/><code>{job.id}</code><small>{phaseText(job.phase)}</small></span><span class="map-label">{job.title}</span></button></foreignObject>;
    })}
    {!!hidden.length && <foreignObject x={x+12} y={y+height-56} width={228} height={44}><button class="map-more-done" aria-expanded={isExpanded} onClick={()=>{
     if(isExpanded && hidden.some(n=>n.id===selection)) onSelect(selection!);
     setExpanded(isExpanded ? expanded.filter(id=>id!==key(lane)) : [...expanded,key(lane)]);
    }}>{isExpanded ? "Show fewer done" : `+${hidden.length} more done`}</button></foreignObject>}
   </g>;
  })}
 </svg></div>;
}
