import type { ComponentChildren } from "preact";
import type { FlightJob, OverviewResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { ContextChip } from "../components/ContextChip.tsx";
import { CiSignal, ModelName, reviewText } from "../components/JobSignals.tsx";
import { Icon } from "../components/icons.tsx";
import { StartSession } from "../components/StartSession.tsx";
import type { ControlView } from "../control.ts";
import { count, elapsed, money, observedTime, percent, phaseText, prNumber, shortSha, time } from "../format.ts";
import { jobHref } from "../routes.ts";
function Chip({href,tone,label,value,title}: {href?:string;tone:string;label:string;value:string;title?:string | undefined}) {
 const body = <><span class="overview-meta"><span class={`overview-dot overview-dot-${tone}`}/>{label}</span><strong title={title ? `${value}\n${title}` : value}>{value}</strong></>;
 return href ? <a href={href} class="overview-chip">{body}</a> : <div class="overview-chip">{body}</div>;
}
/** Audit P3 #18: amber once any parent question has waited this long. */
const STUCK_SECONDS = 600;
/** Parent, operator session, main CI and workers at a glance (audit P3 #18, #19); quota only once a quota was observed. */
function Health({data}: {data:OverviewResponse}) {
 const fleet = data.availability.fleet === "unavailable";
 // The lock file is a record, not a fact: a pid left behind by a crash is down, not alive (cp-hvbj).
 const parent = data.fleet.parent;
 const parentValue = parent.alive ? "alive" : parent.stale_since ? `down (stale lock since ${observedTime(parent.stale_since)})` : "down";
 const operator = data.fleet.operator;
 const questions = data.parent_questions;
 const stuck = questions.some(q => q.age_seconds >= STUCK_SECONDS);
 const held = operator.held === null ? "inbox unreadable" : operator.held > 0 ? `${operator.held} held` : null;
 const operatorValue = [operator.running ? "running" : "offline", stuck ? `${questions.length} unanswered, oldest ${elapsed(Math.max(...questions.map(q => q.age_seconds)))}` : null, held].filter(Boolean).join(" · ");
 // A missing row is no latch, never proof of green: main-ci.json holds only red rows (src/main-ci.ts).
 const main = data.main_ci;
 const red = main.red.map(r => `${main.red.length > 1 ? `${r.project} ` : ""}red since ${r.red_since_sha.slice(0,7)} ${time(r.red_since_at)}`);
 const mainValue = main.availability === "unavailable" ? "unreadable" : red.length ? red.join(", ") : "no red latch";
 const active = data.mandates.items.filter(m => m.status === "active");
 const slots = active.length && active.every(m => m.dispatch_parallelism !== null) ? active.reduce((sum,m) => sum + m.dispatch_parallelism!,0) : null;
 const tight = data.quota?.providers.filter(p => p.tight).map(p => p.provider) ?? [];
 return <section class="overview-health" aria-label="Health">
  <Chip href="#sessions?view=parent" tone={parent.alive ? "working" : "down"} label="parent" value={parentValue}/>
  <Chip href="#decided" tone={!operator.running ? "down" : stuck ? "tight" : "working"} label="operator" value={operatorValue}/>
  <Chip tone={red.length ? "ci-red" : main.availability === "unavailable" ? "tight" : "idle"} label="main CI" value={mainValue} title={main.red.map(r => `${r.project}: ${r.failing ?? r.workflow ?? "CI failed"} on ${r.red_since_sha}`).join("\n") || undefined}/>
  <Chip href="#jobs" tone={!fleet && (data.fleet.workers.live ?? 0) > 0 ? "working" : "idle"} label="workers" value={`${fleet ? "-" : count(data.fleet.workers.live)} live / ${count(slots)} slots`}/>
  {data.quota && <Chip tone={tight.length ? "tight" : "working"} label="quota" value={tight.length ? `tight: ${tight.join(", ")}` : "ok"}/>}
 </section>;
}
/** The watchdog's last run (cp-daemon P3), the one service fact no chip carries; Start session while the operator is offline. */
function Services({data,control}: {data:OverviewResponse;control?:ControlView | undefined}) {
 const health = data.services.health;
 const line = !health ? "health not run" : health.failing.length ? `health failing: ${health.failing.map(f => f.check).join(", ")} (${ago(health.last_run_at, data.generated_at)})` : `health ok ${ago(health.last_run_at, data.generated_at)}`;
 return <section class="overview-services" aria-label="Services">
  <p class="overview-meta overview-services-line" title={health?.failing.map(f => `${f.check}: ${f.detail}`).join("\n") || undefined}>{line}</p>
  {!data.fleet.operator.running && control && <StartSession control={control}/>}
 </section>;
}
const ago = (at: string, now: string): string => {
 const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(at)) / 60_000));
 return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};
/** Audit P3 #21: why a held job is held, in one fact: red or running CI first, then the review, then green CI. */
function heldFact(j: FlightJob): string {
 // ci-watch writes `failed` (src/merge-ask.ts); its schema takes any string, so a recorded `red` reads the same.
 if (j.ci === "failed" || j.ci === "red") return "CI red";
 if (j.ci === "in_progress") return "CI running";
 if (j.review_attempts) return `review ${j.review_attempts}/5 ${j.review === "revise" ? "changes requested" : j.review ?? "not recorded"}`;
 return j.ci === "green" || j.ci === "unreviewed" ? "CI green" : "held";
}
const signal = (j: FlightJob): ViewerJob => j as unknown as ViewerJob;
function FlightRow({j, manyProjects}: {j: FlightJob; manyProjects: boolean}) {
 return <article class="overview-line overview-flight" aria-label={j.id}>
  <a href={jobHref(j.id)} class="overview-job-id"><span aria-hidden="true" class={`overview-dot overview-dot-${j.phase}`}/><code>{j.id}</code></a>
  <div class="overview-flight-title"><span class="overview-line-text" title={j.title ?? undefined}>{j.title ?? "-"}</span><div class="overview-flight-extra">{manyProjects && <span class="overview-project" title={j.project}>{j.project}</span>}{j.phase === "held" && <span class="overview-meta">{heldFact(j)}</span>}{j.pr_url && <a href={j.pr_url} title={j.pr_url}>{prNumber(j.pr_url)}</a>}</div></div>
  <div class="overview-clock"><span>{elapsed(j.elapsed_seconds)} / {elapsed(j.limit_seconds)}</span>{j.elapsed_seconds !== null && j.limit_seconds !== null && j.limit_seconds > 0 && <progress aria-label="Wall clock" max="100" value={percent(j.elapsed_seconds,j.limit_seconds)}/>}{j.context ? <ContextChip usage={j.context} compact/> : <span class="overview-meta">context n/a</span>}</div>
  <span class="overview-review">{reviewText(signal(j))}</span><span class="overview-ci"><CiSignal job={signal(j)}/></span><span class="overview-model"><ModelName job={signal(j)}/></span><span class="overview-cost">{money(j.cost_usd ?? null)}</span>
 </article>;
}
function decidedLine(data: OverviewResponse): string {
 const forYou = data.decided_today.count;
 const byYou = data.decided_today.by_you ?? null;
 const total = forYou === null || byYou === null ? null : forYou + byYou;
 return `${count(total)} decided today · ${count(forYou)} for you, ${count(byYou)} by you`;
}
/** cp-6fyl PR2: a health check failing this long is an alarm (matches src/service-alerts.ts); an unacked relay's own 600 s is `delivery.alarm`. */
const HEALTH_ALARM_SECONDS = 900;
/** The last line of defense: what the parent sent and the main session never saw, or a service failing for a quarter hour. One line per cause. */
function Alarm({data}: {data:OverviewResponse}) {
 const lines: string[] = [];
 const relay = data.delivery;
 if (relay.alarm && relay.oldest_age_seconds !== null) lines.push(`${relay.unseen} parent message${relay.unseen === 1 ? "" : "s"} not seen by the main session, oldest ${elapsed(relay.oldest_age_seconds)} (${relay.oldest_kind} ${relay.oldest_id})`);
 for (const f of data.services.health?.failing ?? []) {
  const age = (Date.parse(data.generated_at) - Date.parse(f.since)) / 1000;
  if (age >= HEALTH_ALARM_SECONDS) lines.push(`health check ${f.check} failing ${elapsed(age)}: ${f.detail}`);
 }
 return lines.length ? <section class="overview-alarm" role="alert">{lines.map(line => <p key={line}>{line}</p>)}</section> : null;
}
const LANDED_ROWS = 5;
function Block({id,title,children}: {id?:string;title:ComponentChildren;children:ComponentChildren}) {
 return <section id={id} tabIndex={id ? -1 : undefined} class="overview-block"><h2>{title}</h2>{children}</section>;
}
export function Overview({data,control}: {data:OverviewResponse;control?:ControlView | undefined}) {
 const paused = data.mandates.paused_projects;
 const fleet = data.availability.fleet === "unavailable";
 const stuck = data.blocked.items.length + data.failed.length;
 const manyProjects = new Set(data.in_flight.map(j => j.project)).size > 1;
 const blockerPhase = (id: string, phase: string | null) => { const live = data.in_flight.find(f => f.id === id)?.phase ?? phase; return live ? phaseText(live) : null; };
 const costs = data.shipped_today.flatMap(j => j.cost_usd === null ? [] : [j.cost_usd]);
 const more = data.shipped_today.length - LANDED_ROWS;
 return <div class="overview"><Alarm data={data}/><div class="overview-heading"><div><h1>Overview</h1>{paused.length > 0 && <p class="overview-subtitle">{paused.map(project => <span key={project} class="overview-paused-pill">{project} paused</span>)}</p>}</div></div>
  {data.warnings.length > 0 && <div role="status" class="overview-error">{data.warnings.map(w => <p key={w.section}>{w.section}: {w.message}</p>)}</div>}
  <div class="overview-status"><Health data={data}/><Services data={data} control={control}/></div>
  {data.availability.asks !== "unavailable" && !data.awaiting.items.length ? <section id="awaiting" tabIndex={-1} class="overview-clear" aria-label="Needs you"><a href="#decided"><Icon name="check" size={16}/><div><strong>Nothing needs you</strong><span>{decidedLine(data)} →</span></div></a></section> : <Block id="awaiting" title={<><span class={`overview-square${data.availability.asks !== "unavailable" && data.awaiting.items.length ? " overview-square-attention" : ""}`}/>Needs you &middot; {count(data.awaiting.count)}</>}>
   {data.availability.asks === "unavailable" ? <p class="overview-error">Questions unavailable</p> : data.awaiting.items.slice(0,3).map(ask => <a key={ask.id} href="#awaiting" class="overview-line"><code>{ask.id}</code><span class="overview-line-text" title={ask.question}>{ask.question}</span><span class="overview-meta">{ask.project}</span></a>)}
  </Block>}
  {stuck > 0 && <Block title={<>Blocked &amp; failed &middot; {stuck}</>}>
   {data.failed.map(j => <a key={j.id} href={jobHref(j.id)} class="overview-line"><code>{j.id}</code><span class="overview-line-text" title={j.title ?? undefined}>{j.title ?? "-"}</span><span class="overview-meta"><span class="overview-failed">failed</span>{j.failure && <> &middot; <span title={j.failure}>{j.failure}</span></>}</span></a>)}
   {data.blocked.items.map(j => <a key={j.id} href={jobHref(j.id)} class="overview-line"><code>{j.id}</code><span class="overview-line-text" title={j.title ?? undefined}>{j.title ?? "-"}</span><span class="overview-meta">blocked by {j.blockers.map((b,i) => { const phase = blockerPhase(b.id, b.phase); return <span key={b.id}>{i > 0 && ", "}<code>{b.id}</code>{phase && ` (${phase})`}{b.stranded && <span class="overview-amber"> · {b.grant_status ?? "no active grant"}</span>}</span>; })}</span></a>)}
  </Block>}
  <Block title={<>In flight &middot; {fleet ? "-" : data.in_flight.length}</>}>
   {fleet ? <p class="overview-error">Jobs unavailable</p> : data.in_flight.length ? <><div class="overview-flight-columns" aria-hidden="true">{["job","title","wall clock / context","review","CI","model","cost"].map(label => <span key={label}>{label}</span>)}</div>{data.in_flight.map(j => <FlightRow key={j.id} j={j} manyProjects={manyProjects}/>)}</> : <p class="overview-meta">Nothing in flight</p>}
  </Block>
  <Block title={<>Landed today &middot; {fleet ? "-" : data.shipped_today.length} merged{data.closed_today ? <> &middot; {data.closed_today} closed without PR</> : null}{costs.length > 0 && <> &middot; {money(costs.reduce((sum,c) => sum + c,0))}</>}</>}>
   {data.shipped_today.slice(0,LANDED_ROWS).map(j => <article key={j.id} class="overview-line overview-landed" aria-label={j.id}><a href={jobHref(j.id)} class="overview-job-id"><span aria-hidden="true" class="overview-dot overview-dot-done"/><code>{j.id}</code></a><span class="overview-line-text" title={j.title ?? undefined}>{j.title ?? "-"}</span><a href={j.pr_url} class="overview-landed-pr">{prNumber(j.pr_url)} ↗</a><span class="overview-meta overview-merge" title={j.merge_sha}>merged <code>{shortSha(j.merge_sha)}</code></span><span class="overview-cost">{money(j.cost_usd)}</span></article>)}
   {more > 0 && <a href="#jobs" class="overview-more">{more} more in Jobs &rarr;</a>}
  </Block>
 </div>;
}
