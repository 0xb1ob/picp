import { useContext } from "preact/hooks";
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
 */
export function PageHeader({title, detail, back, fallback = false}: {title: string; detail?: string | undefined; back?: {href: string; label: string}; fallback?: boolean}) {
 const slot = useContext(HeaderSlot);
 if (slot && !fallback) slot.owned = true;
 const {status, updatedAt = null, control, version} = useContext(ShellContext);
 const Title = fallback ? "p" : "h1";
 return <div class={fallback ? "page-header page-header-fallback" : "page-header"}>
  {back && <a class="page-header-back" href={back.href}>{back.label}</a>}
  <Title title={title}>{title}</Title>
  {detail && <code class="page-header-detail" title={detail}>{detail}</code>}
  <div class="page-header-end">
   <span class={`shell-live shell-live-${status}`}><span/>{updatedAt ? <time class="shell-clock" dateTime={updatedAt} title={`Updated ${stamp(updatedAt, true)}`}>Updated {time(updatedAt)}</time> : status}</span>
   <MoreMenu control={control} version={version} updatedAt={updatedAt}/>
  </div>
 </div>;
}
