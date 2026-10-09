import { useState } from "preact/hooks";
import type { StatsResponse } from "../../src/viewer/api-types.ts";
import { amount, count, elapsed, money, stamp } from "../format.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import "./stats.css";

const RANGES = [["1h","1h"],["24h","24h"],["7d","7d"],["custom","Custom"]] as const;
const FILLS = ["blue","green","muted","dim"] as const;
const pct = (v: number | null): string => v === null ? "-" : `${Math.round(v*100)}%`;
const local = (iso: string | null): string => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(+d) ? new Date(+d - d.getTimezoneOffset()*60000).toISOString().slice(0,16) : ""; };
const csvCell = (v: string | number | null): string => { const s = v === null ? "" : String(v); return /^[=+\-@]/.test(s) || /[",\n]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g,'""')}"` : s; };

/** The hash is the one home for filters; a change rewrites it and the route's own hashchange reloads the data. */
function setHash(query: URLSearchParams, change: Record<string,string | null>) {
 for (const [k,v] of Object.entries(change)) v === null || v === "" ? query.delete(k) : query.set(k,v);
 location.hash = `#stats?${query}`;
}

export function exportCsv(rows: StatsResponse["mandates"]): string {
 return [["mandate","objective","status","jobs","spend_usd","spend_cap_usd","tokens","token_cap","time_left_seconds"],...rows.map(r => [r.id,r.objective,r.status,r.jobs,r.spend_usd,r.spend_cap_usd,r.tokens,r.token_cap,r.time_left_seconds])].map(r => r.map(csvCell).join(",")).join("\n")+"\n";
}

interface Series { name: string; fill: number; values: (number | null)[] }
/** One stacked bar chart (inline SVG, fills by CSS class) with a Table toggle onto the same numbers. */
function Chart({title, labels, series, format}: {title:string; labels:string[]; series:Series[]; format:(v:number | null) => string}) {
 const [table,setTable] = useState(false);
 const totals = labels.map((_,i) => series.reduce((a,s) => a + (s.values[i] ?? 0),0));
 const max = Math.max(0,...totals);
 return <section class="stats-panel" aria-label={title}>
  <header><h2>{title}</h2><button type="button" aria-pressed={table} onClick={() => setTable(!table)}>Table</button></header>
  {table ? <div class="stats-scroll"><table class="stats-table"><thead><tr><th scope="col"></th>{series.map(s => <th scope="col" key={s.name}>{s.name}</th>)}</tr></thead>
   <tbody>{labels.map((l,i) => <tr key={l+i}><th scope="row">{l}</th>{series.map(s => <td key={s.name}>{format(s.values[i] ?? null)}</td>)}</tr>)}</tbody></table></div>
  : labels.length && max > 0 ? <svg class="stats-chart" viewBox={`0 0 ${labels.length*10} 100`} preserveAspectRatio="none" role="img" aria-label={title}>
   {labels.map((l,i) => { let used = 0; return <g key={l+i}><title>{l}</title>{series.map(s => { const h = (s.values[i] ?? 0)/max*100; used += h; return h > 0 ? <rect key={s.name} class={`stats-fill-${FILLS[s.fill % 4]}`} x={i*10+1} width={8} y={100-used} height={h}/> : null; })}</g>; })}</svg>
  : <p class="stats-none">-</p>}
  <ul class="stats-legend">{series.map(s => <li key={s.name}><span class={`stats-swatch stats-fill-${FILLS[s.fill % 4]}`} aria-hidden="true"/>{s.name}</li>)}</ul>
 </section>;
}

export function Stats({data, query}: {data:StatsResponse; query:string}) {
 const [all,setAll] = useState(false);
 const q = new URLSearchParams(query);
 const range = q.get("range") ?? "24h";
 const custom = range === "custom";
 const k = data.kpis;
 const day = data.range.bucket_seconds >= 86400;
 const label = (iso: string) => day ? new Date(iso).toLocaleDateString([],{month:"short",day:"numeric"}) : stamp(iso);
 const empty = data.jobs_finished.merged === 0 && data.jobs_finished.closed === 0;
 const models = data.tokens_by_model.models;
 const kpis: [string,string,string][] = [
  ["Spend",money(k.spend_usd),`${k.spend_delta_pct === null ? "-" : `${k.spend_delta_pct > 0 ? "+" : ""}${k.spend_delta_pct}%`} vs prior · Spend includes reviewers`],
  ["Merge rate",pct(k.merge_rate),`${count(data.jobs_finished.merged)} merged · ${count(data.jobs_finished.closed)} closed`],
  ["CI green first try",pct(k.ci_green_first_try),"first CI observation"],
  ["Median wall clock",elapsed(k.median_wall_clock_seconds),`queue wait ${elapsed(k.median_queue_wait_seconds)}`],
  ["Decisions",count(k.decisions),`${count(data.decisions.for_you)} for you · ${count(data.decisions.by_you)} by you`],
  ["Tokens",amount(k.tokens),`${amount(k.tokens_input)} in · ${amount(k.tokens_output)} out`],
 ];
 const download = () => {
  const url = URL.createObjectURL(new Blob([exportCsv(data.mandates)],{type:"text/csv"}));
  const a = document.createElement("a"); a.href = url; a.download = "stats-mandates.csv"; a.click(); URL.revokeObjectURL(url);
 };
 const when = (key: "from" | "to", value: string) => { const d = new Date(value); if (!Number.isNaN(+d)) setHash(new URLSearchParams(query),{[key]:d.toISOString()}); };
 return <div class="stats">
  <header class="stats-heading"><PageHeader title="Stats"/><p>{label(data.range.from)} – {label(data.range.to)}</p></header>
  <div class="stats-filters">
   <div class="jobs-segments" role="group" aria-label="Range">{RANGES.map(([key,text]) => <button type="button" key={key} aria-pressed={range === key} onClick={() => setHash(new URLSearchParams(query),key === "custom" ? {range:key,from:q.get("from") ?? data.range.from,to:q.get("to") ?? data.range.to} : {range:key,from:null,to:null})}>{text}</button>)}</div>
   <label>Project<select value={q.get("project") ?? ""} onChange={e => setHash(new URLSearchParams(query),{project:e.currentTarget.value})}><option value="">All projects</option>{data.filters.projects.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
   <label>Mandate<select value={q.get("mandate") ?? ""} onChange={e => setHash(new URLSearchParams(query),{mandate:e.currentTarget.value})}><option value="">All mandates</option>{data.filters.mandates.map(m => <option key={m.id} value={m.id}>{m.id} · {m.objective}</option>)}</select></label>
   {custom && <><label>From<input type="datetime-local" value={local(q.get("from"))} onChange={e => when("from",e.currentTarget.value)}/></label><label>To<input type="datetime-local" value={local(q.get("to"))} onChange={e => when("to",e.currentTarget.value)}/></label></>}
  </div>
  {data.warnings.map(w => <p role="alert" class="overview-error" key={w.section}>{w.section}: {w.message}</p>)}
  {empty && <p class="stats-empty" role="status">Nothing finished in this range</p>}
  <div class="stats-kpis">{kpis.map(([name,value,sub]) => <article class="stats-kpi" key={name}><h2>{name}</h2><strong>{value}</strong><p>{sub}</p></article>)}</div>
  <div class="stats-charts">
   <Chart title="Jobs finished" labels={data.jobs_finished.buckets.map(b => label(b.start))} series={[{name:"Merged",fill:1,values:data.jobs_finished.buckets.map(b => b.merged)},{name:"Closed",fill:2,values:data.jobs_finished.buckets.map(b => b.closed)}]} format={count}/>
   <Chart title="Tokens by model" labels={data.tokens_by_model.buckets.map(b => label(b.start))} series={models.map((m,i) => ({name:m,fill:i,values:data.tokens_by_model.buckets.map(b => b.tokens[m] ?? 0)}))} format={amount}/>
   <Chart title="Time in phase" labels={["Queued","Working","Held","Review"]} series={[{name:"Median time",fill:0,values:[data.phases.queued_seconds,data.phases.working_seconds,data.phases.held_seconds,data.phases.review_seconds]}]} format={elapsed}/>
   <Chart title="Spend by model" labels={data.spend_by_model.map(m => m.model)} series={[{name:"Spend",fill:1,values:data.spend_by_model.map(m => m.usd)}]} format={money}/>
  </div>
  <section class="stats-panel" aria-label="Mandates">
   <header><h2>Mandates</h2><button type="button" onClick={download}>Export CSV</button></header>
   <div class="stats-scroll"><table class="stats-table stats-stack"><thead><tr>{["Mandate","Status","Jobs","Spend","Tokens","Time left"].map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead>
   <tbody>{(all ? data.mandates : data.mandates.slice(0,10)).map(m => <tr key={m.id}><th scope="row">{m.id}{m.objective && <span class="stats-sub">{m.objective}</span>}</th><td data-label="Status">{m.status ?? "-"}</td><td data-label="Jobs">{m.jobs}</td><td data-label="Spend">{money(m.spend_usd)}{m.spend_cap_usd !== null && ` / ${money(m.spend_cap_usd)}`}</td><td data-label="Tokens">{amount(m.tokens)}{m.token_cap !== null && ` / ${amount(m.token_cap)}`}</td><td data-label="Time left">{elapsed(m.time_left_seconds)}</td></tr>)}</tbody></table></div>
   {!data.mandates.length && <p class="stats-none">-</p>}
   {data.mandates.length > 10 && <button type="button" class="stats-more" aria-pressed={all} onClick={() => setAll(!all)}>{all ? "Show first 10" : `Show all ${data.mandates.length}`}</button>}
  </section>
 </div>;
}
