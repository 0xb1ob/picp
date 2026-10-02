import type { MandateItem, MapNode, MapResponse } from "../../src/viewer/api-types.ts";

export const mapTitle = "[c-parent-host] host the parent RPC pipe outside the operator process without losing tool results";
export const mapObjective = "Land the hygiene-ranking beads, one reviewed PR per bead. Preserve recorded decisions and operator ownership while making long real-world titles, dependency relations, usage accounting, and existing review gates readable on both phone and desktop screens.";
export function mapQaFixture(): MapResponse {
 const mandate=(id:string,status:string,project:string):MandateItem=>({id,status,projects:[project],objective:mapObjective,expiry:status==="expired" || status==="paused" ? "2026-09-25T00:00:00Z" : "2026-09-27T00:00:00Z",pause_reason:null,ask_on:["risk:high"],spend_cap:{usd:100,tokens:10000000},job_cap:12,dispatch_parallelism:4,spend:{usd:38.1,tokens:2460000,jobs:6,inFlight:2},job_ids:[]});
 const items=[mandate("md-old","expired","aaa-old"),mandate("md-paused","paused","aaa-paused"),mandate("md-live","active","pi-command-post-system"),mandate("md-revoked","revoked","aaa-old"),{...mandate("md-closed","closed","pi-command-post-system"),closed_at:"2026-09-26T11:03:00Z"}];
 const nodes:MapNode[]=Array.from({length:6},(_,i)=>({id:`cp-job-${i}`,title:mapTitle,project:"pi-command-post-system",mandate_id:"md-live",phase:i===0 ? "done" : i===1 ? "held" : i===2 ? "working" : "not dispatched",ledger_status:i===0 ? "closed" : "in_progress",model:"openai/gpt-5.4",cost_usd:4.2,pr_url:"https://github.com/acme/repo/pull/265",ci:"running"}));
 items.find(m=>m.id==="md-live")!.job_ids=nodes.map(n=>n.id);
 return {generated_at:"2026-09-26T12:00:00Z",availability:{mandates:"ok",fleet:"ok",ledger:"ok",escalations:"ok"},items,active_count:1,paused_count:1,revoked_count:1,nodes,edges:[{from:"cp-job-0",to:"cp-job-2",kind:"satisfied"}],stranded_count:0};
}
