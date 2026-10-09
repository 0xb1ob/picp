import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { StatsResponse } from "../../src/viewer/api-types.ts";
import { amount, count, elapsed, money, percent } from "../format.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import "./stats.css";

const RANGES = [["1h","1h"],["24h","24h"],["7d","7d"],["custom","Custom"]] as const;
const FILLS = ["blue","green","muted","dim"] as const;
const pct = (v: number | null): string => v === null ? "-" : `${Math.round(v*100)}%`;
const local = (iso: string | null): string => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(+d) ? new Date(+d - d.getTimezoneOffset()*60000).toISOString().slice(0,16) : ""; };
const csvCell = (v: string | number | null): string => { const s = v === null ? "" : String(v); return /^[=+\-@]/.test(s) || /[",\n]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g,'""')}"` : s; };
/** `Oct 7, 18:00`, in the browser's own zone (no timeZone option; the zone name follows the range once). */
const dayTime = (iso: string): string => new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(iso));
const hm = (iso: string): string => new Intl.DateTimeFormat("en-GB",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(iso));
const dayLabel = (iso: string): string => new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"}).format(new Date(iso));

/** The two ends of `range` are distinct instants (from = to minus the window); the window before it has the same length. */
export function rangeCaption(range: StatsResponse["range"]): string {
 const span = (Date.parse(range.to) - Date.parse(range.from))/1000;
 const before = range.key === "custom" ? elapsed(span) : range.key;
 return `${dayTime(range.from)} – ${dayTime(range.to)} · compared with the ${before} before`;
}

/** The API URL for a hash query: the browser's IANA zone is added when the hash has none, and never written back to the hash. */
export function statsApiUrl(hashQuery: string, tz: string | undefined): string {
 const api = new URLSearchParams(hashQuery);
 if (tz && !api.has("tz")) api.set("tz",tz);
 return `/api/stats?${api}`;
}

/** The hash is the one home for filters; a change rewrites it and the route's own hashchange reloads the data. */
function setHash(query: URLSearchParams, change: Record<string,string | null>) {
 for (const [k,v] of Object.entries(change)) { if (v === null || v === "") query.delete(k); else query.set(k,v); }
 location.hash = `#stats?${query}`;
}

export function exportCsv(rows: StatsResponse["mandates"]): string {
 return [["mandate","objective","status","jobs","spend_usd","spend_cap_usd","tokens","token_cap","time_left_seconds"],...rows.map(r => [r.id,r.objective,r.status,r.jobs,r.spend_usd,r.spend_cap_usd,r.tokens,r.token_cap,r.time_left_seconds])].map(r => r.map(csvCell).join(",")).join("\n")+"\n";
}

interface Series { name: string; fill: number; values: (number | null)[] }
interface Table { labels: string[]; series: Series[]; format: (v: number | null) => string }

/** A panel with a quiet Table link that swaps its chart for the same numbers. */
function Panel({title, note, table, className, children}: {title:string; note?:string; table:Table; className?:string; children:ComponentChildren}) {
 const [open,setOpen] = useState(false);
 return <section class={`stats-panel ${className ?? ""}`} aria-label={title}>
  <header><h2>{title}{note && <span>{note}</span>}</h2><button type="button" class="stats-link" aria-pressed={open} onClick={() => setOpen(!open)}>Table</button></header>
  {open ? <div class="stats-scroll"><table class="stats-table"><thead><tr><th scope="col"></th>{table.series.map(s => <th scope="col" key={s.name}>{s.name}</th>)}</tr></thead>
   <tbody>{table.labels.map((l,i) => <tr key={l+i}><th scope="row">{l}</th>{table.series.map(s => <td key={s.name}>{table.format(s.values[i] ?? null)}</td>)}</tr>)}</tbody></table></div> : children}
 </section>;
}

const ticks = (labels: string[]): string[] => labels.length < 7 ? labels : Array.from({length:6},(_,i) => labels[Math.round(i*(labels.length-1)/5)]!);

function Legend({items}: {items:{name:string; fill:number; n?:number | null}[]}) {
 return <ul class="stats-legend">{items.map(s => <li key={s.name}><span class={`stats-swatch stats-fill-${FILLS[s.fill % 4]}`} aria-hidden="true"/>{s.name}{s.n !== undefined && <b> {count(s.n)}</b>}</li>)}</ul>;
}

/** Stacked bars per bucket; the readout line is the hover tooltip (and each bucket also carries a native title). */
function Stacked({data, label}: {data:StatsResponse; label:(iso:string) => string}) {
 const [hover,setHover] = useState<number | null>(null);
 const b = data.jobs_finished.buckets;
 const max = Math.max(0,...b.map(x => x.merged + x.closed));
 const top = max <= 4 ? 4 : Math.ceil(max/4)*4;
 const readout = hover === null ? "" : `${label(b[hover]!.start)}–${label(b[hover]!.end)} · Merged ${b[hover]!.merged} · Closed ${b[hover]!.closed}`;
 return <>
  <div class="stats-legend-row"><Legend items={[{name:"Merged",fill:0,n:data.jobs_finished.merged},{name:"Closed without PR",fill:2,n:data.jobs_finished.closed}]}/><span class="stats-hover" role="status">{readout}</span></div>
  {b.length && max > 0 ? <div class="stats-plot"><div class="stats-yticks" aria-hidden="true">{[top,top/2,0].map(t => <span key={t}>{t}</span>)}</div>
   <svg class="stats-chart" viewBox={`0 0 ${b.length*10} 100`} preserveAspectRatio="none" role="img" aria-label="Jobs finished per bucket">
    {[0,50,100].map(y => <line key={y} class="stats-grid" x1="0" x2={b.length*10} y1={y} y2={y}/>)}
    {b.map((x,i) => <g key={x.start} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}><title>{`${label(x.start)}–${label(x.end)} · Merged ${x.merged} · Closed ${x.closed}`}</title>
     <rect class="stats-hit" x={i*10} width={10} y={0} height={100}/>
     {x.merged > 0 && <rect class="stats-fill-blue" x={i*10+1} width={8} y={100-x.merged/top*100} height={x.merged/top*100}/>}
     {x.closed > 0 && <rect class="stats-fill-muted" x={i*10+1} width={8} y={100-(x.merged+x.closed)/top*100} height={x.closed/top*100}/>}</g>)}
   </svg><div class="stats-xlabels" aria-hidden="true">{ticks(b.map(x => label(x.start))).map((t,i) => <span key={i}>{t}</span>)}</div></div>
  : <p class="stats-none">-</p>}
 </>;
}

function Lines({data, label}: {data:StatsResponse; label:(iso:string) => string}) {
 const {models,buckets} = data.tokens_by_model;
 const max = Math.max(0,...buckets.flatMap(b => models.map(m => b.tokens[m] ?? 0)));
 const top = Math.max(3e5,Math.ceil(max/3e5)*3e5);
 const mil = (v: number) => v === 0 ? "0M" : `${+(v/1e6).toFixed(2)}M`;
 const n = buckets.length;
 return <>
  <Legend items={models.map((m,i) => ({name:m,fill:i}))}/>
  {n && max > 0 ? <div class="stats-plot"><div class="stats-yticks" aria-hidden="true">{[top,top*2/3,top/3,0].map(t => <span key={t}>{mil(t)}</span>)}</div>
   <svg class="stats-chart" viewBox={`0 0 ${n*10} 100`} preserveAspectRatio="none" role="img" aria-label="Tokens per bucket by model">
    {[0,100/3,200/3,100].map(y => <line key={y} class="stats-grid" x1="0" x2={n*10} y1={y} y2={y}/>)}
    {models.map((m,i) => <polyline key={m} class={`stats-line stats-stroke-${FILLS[i % 4]}`} fill="none" points={buckets.map((b,j) => `${j*10+5},${100-(b.tokens[m] ?? 0)/top*100}`).join(" ")}><title>{m}</title></polyline>)}
   </svg><div class="stats-xlabels" aria-hidden="true">{ticks(buckets.map(x => label(x.start))).map((t,i) => <span key={i}>{t}</span>)}</div></div>
  : <p class="stats-none">-</p>}
 </>;
}

/** Labelled horizontal bars scaled to the largest row; a missing value is a dash with an empty track. */
function HBars({rows, format, mono}: {rows:{label:string; value:number | null}[]; format:(v:number | null) => string; mono?:boolean}) {
 const max = Math.max(0,...rows.map(r => r.value ?? 0));
 return <div class="stats-hbars">{rows.map(r => <div class="stats-hbar" key={r.label}><span class={mono ? "stats-mono" : undefined}>{r.label}</span><b>{format(r.value)}</b><Bar value={r.value ?? 0} max={max}/></div>)}</div>;
}
function Bar({value, max}: {value:number; max:number}) {
 return <svg class="stats-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="stats-track" width="100" height="4"/><rect class="stats-fill-blue" width={percent(value,max)} height="4"/></svg>;
}

export function Stats({data, query}: {data:StatsResponse; query:string}) {
 const [all,setAll] = useState(false);
 const q = new URLSearchParams(query);
 const range = q.get("range") ?? "24h";
 const custom = range === "custom";
 const k = data.kpis;
 const jf = data.jobs_finished;
 const day = data.range.bucket_seconds >= 86400;
 const label = (iso: string) => day ? dayLabel(iso) : hm(iso);
 const empty = jf.merged === 0 && jf.closed === 0;
 const total = jf.merged === null || jf.closed === null ? null : jf.merged + jf.closed;
 const delta = k.spend_delta_pct === null ? "-" : `${k.spend_delta_pct > 0 ? "+" : ""}${k.spend_delta_pct}%`;
 const kpis: [string,string,string,string?][] = [
  ["Jobs finished",count(total),`${count(jf.merged)} merged · ${count(jf.closed)} closed`],
  ["Spend",money(k.spend_usd),`${delta} vs prior period`,"Spend includes reviewers"],
  ["Tokens",amount(k.tokens),`in ${amount(k.tokens_input)} · out ${amount(k.tokens_output)}`],
  ["Merge rate",pct(k.merge_rate),`CI green first try ${pct(k.ci_green_first_try)}`],
  ["Median wall clock",elapsed(k.median_wall_clock_seconds),`queue wait ${elapsed(k.median_queue_wait_seconds)}`],
  ["Decisions",count(k.decisions),`${count(data.decisions.for_you)} for you · ${count(data.decisions.by_you)} by you`],
 ];
 const download = () => {
  const url = URL.createObjectURL(new Blob([exportCsv(data.mandates)],{type:"text/csv"}));
  const a = document.createElement("a"); a.href = url; a.download = "stats-mandates.csv"; a.click(); URL.revokeObjectURL(url);
 };
 const when = (key: "from" | "to", value: string) => { const d = new Date(value); if (!Number.isNaN(+d)) setHash(new URLSearchParams(query),{[key]:d.toISOString()}); };
 const phases = [["Queued",data.phases.queued_seconds],["Working",data.phases.working_seconds],["Held · CI or review",data.phases.held_seconds],["Review",data.phases.review_seconds]] as const;
 const bucketNames = (starts: string[]) => starts.map(s => label(s));
 const warn = data.warnings.map(w => w.message).join(" · ");
 const rows = all ? data.mandates : data.mandates.slice(0,10);
 return <div class="stats">
  <PageHeader title="Stats"/>
  <div class="stats-filters">
   <div class="stats-segments" role="group" aria-label="Range">{RANGES.map(([key,text]) => <button type="button" key={key} aria-pressed={range === key} onClick={() => setHash(new URLSearchParams(query),key === "custom" ? {range:key,from:q.get("from") ?? data.range.from,to:q.get("to") ?? data.range.to} : {range:key,from:null,to:null})}>{text}</button>)}</div>
   {custom && <><label class="stats-field stats-from"><span>From</span><input type="datetime-local" value={local(q.get("from"))} onChange={e => when("from",e.currentTarget.value)}/></label><label class="stats-field stats-to"><span>To</span><input type="datetime-local" value={local(q.get("to"))} onChange={e => when("to",e.currentTarget.value)}/></label></>}
   <label class="stats-pill"><span>Project</span><select value={q.get("project") ?? ""} onChange={e => setHash(new URLSearchParams(query),{project:e.currentTarget.value})}><option value="">All</option>{data.filters.projects.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
   <label class="stats-pill"><span>Mandate</span><select value={q.get("mandate") ?? ""} onChange={e => setHash(new URLSearchParams(query),{mandate:e.currentTarget.value})}><option value="">All mandates</option>{data.filters.mandates.map(m => <option key={m.id} value={m.id}>{m.id} · {m.objective}</option>)}</select></label>
   <p class="stats-caption">{rangeCaption(data.range)}</p>
  </div>
  {warn && <p role="alert" class="stats-warn" title={warn}>{warn}</p>}
  {empty && <p class="stats-empty" role="status">Nothing finished in this range</p>}
  <div class="stats-kpis">{kpis.map(([name,value,sub,extra]) => <article class="stats-kpi" key={name}><h2>{name}</h2><strong>{value}</strong><p>{sub}</p>{extra && <p>{extra}</p>}</article>)}</div>
  <div class="stats-charts">
   <Panel title="Jobs finished" note={day ? "per day" : "per hour"} className="stats-jobs" table={{labels:bucketNames(jf.buckets.map(b => b.start)),series:[{name:"Merged",fill:0,values:jf.buckets.map(b => b.merged)},{name:"Closed without PR",fill:2,values:jf.buckets.map(b => b.closed)}],format:count}}><Stacked data={data} label={label}/></Panel>
   <Panel title="Median time per phase" note="finished jobs" className="stats-phase" table={{labels:phases.map(p => p[0]),series:[{name:"Median time",fill:0,values:phases.map(p => p[1])}],format:elapsed}}>
    <HBars rows={phases.map(p => ({label:p[0],value:p[1]}))} format={elapsed}/><p class="stats-note">Held is normal: waiting on CI or review.</p></Panel>
   <Panel title="Tokens by model" note={day ? "per day, millions" : "per hour, millions"} className="stats-tokens" table={{labels:bucketNames(data.tokens_by_model.buckets.map(b => b.start)),series:data.tokens_by_model.models.map((m,i) => ({name:m,fill:i,values:data.tokens_by_model.buckets.map(b => b.tokens[m] ?? 0)})),format:amount}}><Lines data={data} label={label}/></Panel>
   <Panel title="Spend by model" className="stats-spend" table={{labels:data.spend_by_model.map(m => m.model),series:[{name:"Spend",fill:1,values:data.spend_by_model.map(m => m.usd)}],format:money}}>
    {data.spend_by_model.length ? <HBars mono rows={data.spend_by_model.map(m => ({label:m.model,value:m.usd}))} format={money}/> : <p class="stats-none">-</p>}
    <div class="stats-decisions"><h3>Decisions</h3><dl>{[["decided for you",data.decisions.for_you],["answered by you",data.decisions.by_you],["worth a look",data.decisions.worth]].map(([name,n]) => <div key={name as string}><dd>{count(n as number | null)}</dd><dt>{name}</dt></div>)}</dl></div></Panel>
  </div>
  <section class="stats-panel stats-mandates" aria-label="Mandates">
   <header><h2>Mandates<span>spend and tokens against each grant, in this range</span></h2><button type="button" class="stats-link" onClick={download}>Export CSV</button></header>
   <div class="stats-mrow stats-mhead" aria-hidden="true"><span>Mandate</span><span>Jobs</span><span>Spend / cap</span><span>Tokens / cap</span><span>Time left</span><span>Status</span></div>
   {rows.map(m => <div class="stats-mrow" key={m.id}>
    <div class="stats-mid"><code>{m.id === "unassigned" ? "Unassigned" : m.id}</code><p>{m.objective ?? (m.id === "unassigned" ? "No covering live grant" : "-")}</p></div>
    <span class="stats-mjobs" data-label="Jobs">{m.jobs}</span>
    <div class="stats-mbar"><span>{money(m.spend_usd)}{m.spend_cap_usd !== null && ` / ${money(m.spend_cap_usd)}`}</span>{m.spend_usd !== null && m.spend_cap_usd ? <Bar value={m.spend_usd} max={m.spend_cap_usd}/> : null}</div>
    <div class="stats-mbar"><span>{amount(m.tokens)}{m.token_cap !== null && ` / ${amount(m.token_cap)}`}</span>{m.tokens !== null && m.token_cap ? <Bar value={m.tokens} max={m.token_cap}/> : null}</div>
    <span class="stats-mleft" data-label="Time left">{elapsed(m.time_left_seconds)}</span>
    <span class="stats-mstatus" data-label="Status">{m.status ? <><i class={m.status === "active" ? "stats-dot-on" : "stats-dot"} aria-hidden="true"/>{m.status}</> : "-"}</span>
   </div>)}
   {!data.mandates.length && <p class="stats-none">-</p>}
   {data.mandates.length > 10 && <button type="button" class="stats-link stats-more" aria-pressed={all} onClick={() => setAll(!all)}>{all ? "Show first 10" : `Show all ${data.mandates.length}`}</button>}
  </section>
 </div>;
}
