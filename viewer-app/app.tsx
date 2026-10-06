import { useContext, useEffect, useState } from "preact/hooks";
import type { DecisionsResponse, OverviewResponse, BoardResponse, JobResponse, JobsResponse, SessionsResponse, FilesResponse, MapResponse, ReportsResponse, SchedulesResponse } from "../src/viewer/api-types.ts";
import { type Route, decisionsFallback, screenDataUrl } from "./routes.ts";
import { useControl } from "./use-control.ts";
import { useScheduleControl } from "./use-schedule-control.ts";
import { Decisions } from "./screens/Decisions.tsx";
import { Sessions } from "./screens/Sessions.tsx";
import { Files } from "./screens/Files.tsx";
import { Jobs } from "./screens/Jobs.tsx";
import { JobDetail } from "./screens/JobDetail.tsx";
import { Board } from "./screens/Board.tsx";
import { Reports } from "./screens/Reports.tsx";
import { Schedules } from "./screens/Schedules.tsx";
import { useRoute } from "./use-route.ts";
import { useScreenData } from "./use-screen-data.ts";
import { Shell, ShellContext } from "./components/Shell.tsx";
import { NotFound, notFoundFor } from "./components/NotFound.tsx";
import { Overview } from "./screens/Overview.tsx";
import { More } from "./screens/More.tsx";
import { DependencyMap } from "./screens/DependencyMap.tsx";
import { usePush } from "./use-push.ts";
import { useAnswersControl } from "./use-answers-control.ts";
import { useThreads } from "./use-threads.ts";
export function DetailScreen({current:asked, workers}: {current:Route; workers?: OverviewResponse["in_flight"] | undefined}) {
 // A defaulted Full transcript the server refuses (403) falls back to Decisions, silently (routes.ts).
 // `refused` never outlives its route: DetailScreen is keyed on `${screen}?${query}`, so a route change remounts it.
 const [refused,setRefused]=useState(false);
 const current=refused ? decisionsFallback(asked) : asked;
 const sessions=current.screen === "sessions";
 const query=new URLSearchParams(current.query);
 const resource=useScreenData<SessionsResponse | FilesResponse>(screenDataUrl(current),`/api/stream?view=${current.screen}`);
 useEffect(() => { if (current.defaulted && resource.code === 403) setRefused(true); },[current.defaulted,resource.code]);
 const transcript=sessions && query.get("view") === "you" && query.get("transcript") === "1";
 const data=sessions ? resource.data as SessionsResponse | null : null;
 // Restart session lives in the shell's ⋮ menu: the composer stays held while that restart runs, and re-reads its token once the state moves.
 const shell=useContext(ShellContext);
 const restarting=shell.control?.restarting ?? null;
 const own=useControl(transcript,`${data?.generated_at ?? ""}|${restarting?.state ?? ""}`,data?.entries ?? []);
 const control=own && restarting ? {...own,restarting} : own;
 const threads=useThreads(transcript,data?.generated_at ?? null);
 if (current.defaulted && resource.code === 403) return <p role="status">Loading</p>;
 const missing = resource.data ? null : notFoundFor(current, resource.code, workers);
 if (missing) return <NotFound {...missing}/>;
 const draft=sessions ? query.get("draft") ?? undefined : undefined;
 return <>{resource.error && <p role="alert" class="overview-error">{resource.error}</p>}{resource.data ? sessions ? <Sessions data={resource.data as SessionsResponse} control={control} draft={draft} threads={threads}/> : <Files data={resource.data as FilesResponse}/> : <p role="status">{resource.error ? "View unavailable" : "Loading"}</p>}</>;
}
export function App() {
 const current = useRoute();
 if (current.screen === "decisions") return <DecisionPage current={current}/>;
 return ["jobs","job","board","reports","schedules"].includes(current.screen) ? <JobsRoute key={`${current.screen}/${current.jobId ?? ""}`} current={current}/> : <OverviewPage current={current}/>;
}
/** Scroll a page's `#awaiting`/`#decided` section into view once its data has loaded. */
function useSection(current: Route, loaded: boolean) {
 useEffect(() => {
  if (current.section && loaded) { const section = document.getElementById(current.section); section?.scrollIntoView(); section?.focus({preventScroll:true}); }
 },[current.screen,current.section,loaded]);
}
function DecisionPage({current}: {current:Route}) {
 const resource = useScreenData<DecisionsResponse>("/api/decisions","/api/stream?view=decisions");
 const control = useControl(true,resource.data?.generated_at ?? null,[]);
 const answers = useAnswersControl(true,resource.data?.generated_at ?? null);
 useSection(current,resource.data !== null);
 return <Shell current={current} awaiting={resource.data?.awaiting_count ?? null} status={resource.status} updatedAt={resource.data?.generated_at ?? null}>
  {resource.error && <p role="alert" class="overview-error">{resource.error}{resource.data && " · showing last recorded data"}</p>}
  {resource.data ? <Decisions data={resource.data} control={control} answers={answers}/> : <p role="status">{resource.error ? "Recorded data unavailable" : "Loading"}</p>}
 </Shell>;
}
function JobsRoute({current}:{current:Route}) {
 const url = current.screen === "job" ? `/api/job/${encodeURIComponent(current.jobId!)}` : `/api/${current.screen}`;
 const resource = useScreenData<JobsResponse | JobResponse | BoardResponse | ReportsResponse | SchedulesResponse>(url,`/api/stream?view=${current.screen}`);
 const data = resource.data;
 const summary = data && "awaiting_count" in data ? data : null;
 const scheduleControl = useScheduleControl(current.screen === "schedules", data?.generated_at ?? null);
 const missing = data ? null : notFoundFor(current, resource.code);
 return <Shell current={current} awaiting={summary?.awaiting_count ?? null} status={resource.status} updatedAt={data?.generated_at ?? null}>
  {missing ? <NotFound {...missing}/> : <>
  {resource.error && <p role="alert" class="overview-error">{resource.error}{data && " · showing last recorded data"}</p>}
  {summary?.warnings.map(w=><p role="alert" class="overview-error" key={w.section}>{w.section}: {w.message}</p>)}
  {data ? current.screen === "job" ? <JobDetail data={data as JobResponse}/> : current.screen === "board" ? <Board data={data as BoardResponse}/> : current.screen === "reports" ? <Reports data={data as ReportsResponse}/> : current.screen === "schedules" ? <Schedules data={data as SchedulesResponse} control={scheduleControl}/> : <Jobs data={data as JobsResponse}/> : <p role="status">{resource.error ? "Recorded data unavailable" : "Loading"}</p>}
  </>}
 </Shell>;
}
function OverviewPage({current}: {current:Route}) {
 const screen = current.screen === "map" ? current.screen : "overview";
 const resource = useScreenData<OverviewResponse | MapResponse>(`/api/${screen}`,`/api/stream?view=${screen}`);
 const loaded = resource.data !== null;
 const push = usePush(current.screen === "more");
 // Start session on the Overview's "operator session offline" line needs the control status (and its inbox token).
 const control = useControl(current.screen === "overview",resource.data?.generated_at ?? null,[]);
 useSection(current,loaded);
 const workers = !resource.error && resource.data && "in_flight" in resource.data && resource.data.availability.fleet === "ok" && resource.data.availability.ledger !== "unavailable" ? resource.data.in_flight : undefined;
 return <Shell current={current} awaiting={resource.data && "awaiting" in resource.data ? resource.data.awaiting.count : null} status={resource.status} updatedAt={resource.data?.generated_at ?? null}>
  {resource.error && <p role="alert" class="overview-error">{resource.error}{loaded && " · showing last recorded data"}</p>}
  {current.screen === "sessions" || current.screen === "files" ? <DetailScreen key={`${current.screen}?${current.query ?? ""}`} current={current} workers={workers}/> : resource.data ? "awaiting" in resource.data ? current.screen === "more" ? <More data={resource.data} push={push}/> : <Overview data={resource.data} control={control}/> : <DependencyMap data={resource.data}/> : <p role="status">{resource.error ? "View unavailable" : "Loading"}</p>}
 </Shell>;
}
