import { useEffect, useState } from "preact/hooks";
import type { QuotaObservation, WorkspaceStatusResponse } from "../../src/viewer/api-types.ts";
import { elapsed, money } from "../format.ts";
import type { Snapshot } from "../resource.ts";
import { useScreenData } from "../use-screen-data.ts";

const wideNow = () => typeof matchMedia === "function" ? matchMedia("(min-width: 900px)").matches : true;
/** This browser's local calendar day, sent explicitly: the endpoint refuses anything but one whole day in `tz`. */
export function statusUrl(now: number): string {
 const d = new Date(now), day = (n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).toISOString();
 return `/api/workspace/status?${new URLSearchParams({from: day(0), to: day(1), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"})}`;
}
const pct = (value: number | null, window: string) => `${value === null ? "—" : `${Math.round(value)}%`} ${window}`;
const age = (seconds: number) => seconds < 86_400 ? elapsed(seconds) : `${Math.floor(seconds / 86_400)}d`;
/** SSE reaches this viewer only: no recorded observation proves cp-daemon's connection, so the label never names it. */
const CONNECTION: Record<Snapshot<unknown>["status"], string> = {connecting: "viewer connecting", live: "viewer connected", stale: "viewer reconnecting", offline: "viewer offline"};
const known = (field: {availability: string; count: number | null} | undefined, unit: string) =>
 field?.availability === "unavailable" ? `${unit} unreadable` : `${field?.count ?? "—"} ${unit}`;

/** Recorded utilization (used, not remaining): an unrecorded 5h window reads "— 5h" and draws no bar. */
function Meter({provider}: {provider: QuotaObservation["providers"][number]}) {
 const sep = <span class="workspace-status-sep" aria-hidden="true">·</span>;
 return <span class="workspace-status-meter" title={`${provider.provider} ${pct(provider.five_hour, "5h")} · ${pct(provider.seven_day, "wk")}`}>
  <span class="workspace-status-dim">{provider.provider}</span>
  {provider.five_hour !== null && <progress max={100} value={provider.five_hour} aria-label={`${provider.provider} 5-hour utilization`}/>}
  <span>{pct(provider.five_hour, "5h")} {sep} {pct(provider.seven_day, "wk")}</span></span>;
}

/** Full match S5 (frames 1–2): the desktop chat's 37 px footer. Phones have none, so they read nothing. */
export function WorkspaceStatus() {
 const [wide, setWide] = useState(wideNow);
 const [, setTick] = useState(0);
 useEffect(() => {
  // A minute's tick moves the observation age and, past local midnight, the day the URL asks for.
  const tick = window.setInterval(() => setTick(n => n + 1), 60_000);
  const query = typeof matchMedia === "function" ? matchMedia("(min-width: 900px)") : null, change = () => setWide(query!.matches);
  query?.addEventListener("change", change);
  return () => { window.clearInterval(tick); query?.removeEventListener("change", change); };
 }, []);
 const now = Date.now();
 const status = useScreenData<WorkspaceStatusResponse>(wide ? statusUrl(now) : null, "/api/stream?view=overview");
 if (!wide) return null;
 const data = status.data, quota = data?.quota, observed = quota?.observation;
 const spend = !data ? "—" : data.spend.availability === "unavailable" ? "unreadable" : data.spend.usd === null ? "not recorded" : money(data.spend.usd);
 return <footer class="workspace-status" aria-label="Status">
  {observed ? <>{observed.providers.map(p => <Meter key={p.provider} provider={p}/>)}
   <time class="workspace-status-dim" dateTime={observed.observed_at} title={`Recorded at routing by ${observed.source_job_id}; not a live feed`}>
    observed {age(Math.max(0, Math.round((now - Date.parse(observed.observed_at)) / 1000)))} ago</time></>
   : <span class="workspace-status-dim">{!quota ? status.error ? "status unavailable" : "" : quota.availability === "unavailable" ? "quota unreadable" : "quota not recorded"}</span>}
  <span class="workspace-status-dim workspace-status-today">today</span><span title="Worker and reviewer spend of jobs finished today (local day)">{spend}</span>
  <span class="workspace-status-sep" aria-hidden="true">·</span><span>{known(data?.working, "working")}</span>
  <span class="workspace-status-sep" aria-hidden="true">·</span><span>{known(data?.done, "done")}</span>
  <span class={`workspace-status-link workspace-status-${status.status}`}>{CONNECTION[status.status]}<span class="workspace-status-dot" aria-hidden="true"/></span>
 </footer>;
}
