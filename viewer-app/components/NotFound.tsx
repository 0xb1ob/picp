import { useContext } from "preact/hooks";
import type { FlightJob } from "../../src/viewer/api-types.ts";
import { sessionHref } from "../routes.ts";
import { Icon } from "./icons.tsx";
import { PageHeader } from "./PageHeader.tsx";
import type { Route } from "../routes.ts";
import { ShellContext } from "./Shell.tsx";
import "./not-found.css";

export interface NotFoundProps {
 kind: "job" | "worker";
 id: string;
 workers?: FlightJob[];
 title: string;
 body: string;
 back: {href: string; label: string};
 searchLabel: string;
}

/** A calm 404 for an unknown job or worker session. Any other status stays the recorded-data error. */
export function notFoundFor(route: Route, code: number | undefined, workers?: FlightJob[]): NotFoundProps | null {
 if (code !== 404) return null;
 if (route.screen === "job" && route.jobId) return {
  kind: "job", id: route.jobId,
  title: `No job ${route.jobId}`,
  body: "It isn't in this home's ledger. The id may be mistyped, or the job belongs to another home.",
  back: {href: "#jobs", label: "Back to Jobs"},
  searchLabel: "Search jobs",
 };
 if (route.screen === "sessions") {
  const params = new URLSearchParams(route.query);
  const id = params.get("id");
  if (params.get("view") === "workers" && id) return {
   kind: "worker", id,
   workers: workers?.filter(w => w.id !== id && !w.script_path && ["working","launching"].includes(w.phase)),
   title: `No worker session ${id}`,
   body: "No live or finished worker has this id in this home. It may be mistyped, or the session belongs to another home.",
   back: {href: "#sessions", label: "Back to Sessions"},
   searchLabel: "Search",
  };
 }
 return null;
}

export function NotFound({kind, id, title, body, back, searchLabel, workers}: NotFoundProps) {
 const openSearch = useContext(ShellContext).openSearch;
 const Heading = kind === "worker" ? "h2" : "h1";
 return <div class={`not-found not-found-${kind}`}>
  {kind === "worker" && <header class="not-found-heading"><PageHeader title="Sessions" detail={id}/></header>}
  <section class="not-found-recovery" aria-labelledby="not-found-title">
   <span class="not-found-illustration" aria-hidden="true"><Icon name={kind === "worker" ? "sessions" : "search"} size={28}/></span>
   <Heading id="not-found-title">{title}</Heading>
   <p>{body}</p>
   {!!workers?.length && <nav class="not-found-workers" aria-label="Live workers"><h2>Live workers</h2>{workers.map(worker => <a key={worker.id} href={sessionHref("workers",worker.id)} title={worker.title ?? worker.id}><span class={`job-dot job-dot-${worker.phase}`}/><code>{worker.id}</code><span>{worker.project} · {worker.phase}</span><span aria-hidden="true">→</span></a>)}</nav>}
   <div class="not-found-actions">
    <a class="not-found-back" href={back.href}>{back.label}</a>
    <button type="button" class="not-found-search" onClick={() => openSearch()}>{searchLabel}</button>
   </div>
  </section>
 </div>;
}
