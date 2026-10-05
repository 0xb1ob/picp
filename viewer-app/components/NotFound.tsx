import { useContext } from "preact/hooks";
import type { Route } from "../routes.ts";
import { ShellContext } from "./Shell.tsx";
import "./not-found.css";

export interface NotFoundProps {
 title: string;
 body: string;
 back: {href: string; label: string};
 searchLabel: string;
}

/** A calm 404 for an unknown job or worker session. Any other status stays the recorded-data error. */
export function notFoundFor(route: Route, code: number | undefined): NotFoundProps | null {
 if (code !== 404) return null;
 if (route.screen === "job" && route.jobId) return {
  title: `No job ${route.jobId}`,
  body: "It isn't in this home's ledger. The id may be mistyped, or the job belongs to another home.",
  back: {href: "#jobs", label: "Back to Jobs"},
  searchLabel: "Search jobs",
 };
 if (route.screen === "sessions") {
  const params = new URLSearchParams(route.query);
  const id = params.get("id");
  if (params.get("view") === "workers" && id) return {
   title: `No worker session ${id}`,
   body: "No live or finished worker has this id in this home. It may be mistyped, or the session belongs to another home.",
   back: {href: "#sessions", label: "Back to Sessions"},
   searchLabel: "Search",
  };
 }
 return null;
}

export function NotFound({title, body, back, searchLabel}: NotFoundProps) {
 const openSearch = useContext(ShellContext).openSearch;
 return <div class="not-found">
  <h1>{title}</h1>
  <p>{body}</p>
  <div class="not-found-actions">
   <a class="not-found-back" href={back.href}>{back.label}</a>
   <button type="button" class="not-found-search" onClick={() => openSearch()}>{searchLabel}</button>
  </div>
 </div>;
}
