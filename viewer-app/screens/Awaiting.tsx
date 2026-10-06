import type { AwaitingDetail, AwaitingResponse } from "../../src/viewer/api-types.ts";
import { DecisionCard } from "../components/DecisionCard.tsx";
import { Icon } from "../components/icons.tsx";
import type { ControlView } from "../control.ts";
import { count, elapsed, time } from "../format.ts";
import { jobHref } from "../routes.ts";
import { DecisionKinds } from "./DecisionContext.tsx";

function AskCard({ask,index,data,control}: {ask:AwaitingDetail;index:number;data:AwaitingResponse;control?:ControlView | undefined}) {
 return <div class="awaiting-card"><DecisionCard ask={ask} control={control} factsOpen>
  <div class="awaiting-meta"><span class="awaiting-index"><span class="overview-square"/>{index+1} of {data.items.length}</span><span>asked {time(ask.created_at)} &middot; waiting {elapsed(Math.max(0,(Date.parse(data.generated_at)-Date.parse(ask.created_at))/1000))}</span></div>
 </DecisionCard>
  <section class="awaiting-origin"><h3>Where it came from</h3><ol>
   {ask.source_escalation && <li><code>{ask.source_created_at ? time(ask.source_created_at) : "-"}</code><span>CP parent raised {ask.source_escalation}</span><a href="#sessions?view=parent">parent transcript &rarr;</a></li>}
   <li><code>{time(ask.created_at)}</code><span>Operator session sent it to you</span><a href="#sessions?view=you&transcript=1">operator transcript &rarr;</a></li>
   <li class="awaiting-origin-now"><code>now</code><span>Waiting on your reply</span><code>{ask.id}</code>{ask.job_ids.map(id => <a key={id} href={jobHref(id)}>{id} &rarr;</a>)}</li>
  </ol></section>
 </div>;
}
export function AwaitingScreen({data,control}: {data:AwaitingResponse;control?:ControlView | undefined}) {
 if (data.availability.asks !== "unavailable" && data.awaiting_count === 0 && data.items.length === 0) return <section class="awaiting-empty" role="status"><Icon name="check" size={18}/><h2>Awaiting you &middot; Nothing needs you</h2><a href="#decided">{count(data.decided_today.count === null || data.decided_today.by_you == null ? null : data.decided_today.count + data.decided_today.by_you)} decided today · {count(data.decided_today.count)} for you, {count(data.decided_today.by_you ?? null)} by you →</a></section>;
 return <div class="awaiting-screen"><div class="awaiting-primary"><header class="decision-heading"><div><h2>Awaiting you</h2><p>Only questions the operator session raised to you. Everything else it answers itself.</p></div><span class="decision-desktop">{data.awaiting_count === null ? "unavailable" : data.awaiting_count ? `${data.awaiting_count} open` : "queue empty"}</span></header>
  {data.availability.asks === "unavailable" || data.awaiting_count === null ? <p role="alert" class="overview-error">Questions unavailable</p> : data.items.map((ask,index) => <AskCard key={ask.id} ask={ask} index={index} data={data} control={control}/>)}
 </div><aside class="awaiting-aside"><DecisionKinds/></aside></div>;
}
