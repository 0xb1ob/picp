import type { ComponentChildren } from "preact";
import { useContext, useLayoutEffect, useRef } from "preact/hooks";
import { stamp, time } from "../format.ts";
import { navigation, type Route } from "../routes.ts";
import { MoreMenu } from "./MoreMenu.tsx";
import { HeaderSlot, ShellContext } from "./Shell.tsx";

/** The page title a route shows before its screen has data: Board, Map and a job are Jobs views. */
export function routeTitle(route: Route): string {
 return ["board","map","job"].includes(route.screen) ? "Jobs" : navigation.find(n => n.id === route.screen)?.label ?? "Overview";
}

/**
 * The one desktop header row of the main content: an optional parent link (`Jobs /`), the page's <h1> and a muted id,
 * then the live status and the ⋮ menu. Below 900 px the row is `display: contents` and only the <h1> shows, where the
 * screen always had it — except the worker 404, which keeps its id and the way back to Sessions.
 * Shell draws a `fallback` row (no <h1>) only while a screen has none of its own: loading,
 * unavailable, a job 404. A screen's own row claims HeaderSlot while it renders.
 * `stack` (job page) puts the back link, id and status on row 1 and the <h1> alone on row 2 (desktop only).
 */
export function PageHeader({title, detail, back, context, stack = false, fallback = false}: {title: string; detail?: string | undefined; back?: {href: string; label: string}; context?: ComponentChildren; stack?: boolean; fallback?: boolean}) {
 const slot = useContext(HeaderSlot);
 const claimed = useRef(false);
 if (slot && !fallback && !claimed.current) { claimed.current = true; slot.claim(); }
 useLayoutEffect(() => {
  if (!slot || fallback) return;
  return () => { claimed.current = false; slot.release(); };
 }, [slot, fallback]);
 const {status, updatedAt = null, control, version} = useContext(ShellContext);
 const Title = fallback ? "p" : "h1";
 return <div class={fallback ? "page-header page-header-fallback" : stack ? "page-header page-header-stack" : "page-header"}>
  {back && <a class="page-header-back" href={back.href}>{back.label}</a>}
  <Title title={title}>{title}</Title>
  {context && <span class="page-header-context">{context}</span>}
  {detail && <code class="page-header-detail" title={detail}>{detail}</code>}
  <div class="page-header-end">
   <span class={`shell-live shell-live-${status}`}><span/>{updatedAt ? <time class="shell-clock" dateTime={updatedAt} title={`Updated ${stamp(updatedAt, true)}`}>updated {time(updatedAt)}</time> : status}</span>
   <MoreMenu control={control} version={version} updatedAt={updatedAt}/>
  </div>
 </div>;
}
