import { type ComponentChildren, createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { FlightJob, OverviewResponse, ShippedJob } from "../../src/viewer/api-types.ts";
import { SearchDialog } from "./SearchDialog.tsx";
import type { Route } from "../routes.ts";
import { Icon } from "./icons.tsx";
import { Navigation } from "./Navigation.tsx";
import { stamp, time } from "../format.ts";
import type { ControlView } from "../control.ts";
import { useControl } from "../use-control.ts";
import { MoreMenu } from "./MoreMenu.tsx";
import { PageHeader, routeTitle } from "./PageHeader.tsx";
import { useVersion, type VersionState } from "../use-version.ts";
function Brand() { return <div class="shell-brand"><code>command-post</code></div>; }
/** What a screen with its own top bar (Sessions on mobile) and every desktop page header need from the shell: the live state, search and the ⋮ menu's inputs. */
export const ShellContext = createContext<{status:string;openSearch:() => void;control?:ControlView | undefined;version?:VersionState;updatedAt?:string | null}>({status:"unknown",openSearch:() => {}});
/** A screen's PageHeader claims this once. The count survives a Shell-only re-render (search, control) that skips those children. */
export type HeaderSlotApi = {readonly owned:boolean; claim:() => void; release:() => void; listen:(fn:() => void) => () => void};
export const HeaderSlot = createContext<HeaderSlotApi | null>(null);
function createHeaderSlot(): HeaderSlotApi {
 let n = 0;
 const listeners = new Set<() => void>();
 return {
  get owned() { return n > 0; },
  claim() { n++; },
  release() { n = Math.max(0, n - 1); for (const fn of listeners) fn(); },
  listen(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
 };
}
function FallbackHeader({current}: {current:Route}) {
 const slot = useContext(HeaderSlot);
 const [, bump] = useState(0);
 useEffect(() => slot?.listen(() => bump(n => n + 1)), [slot]);
 if (slot?.owned) return null;
 return <PageHeader title={routeTitle(current)} detail={current.jobId} fallback/>;
}
export function Shell({current,awaiting,status,updatedAt,children}: {current:Route;awaiting:number | null;status:string;updatedAt:string | null;children:ComponentChildren}) {
 // The operator control view for the ⋮ menu (Restart session): on every screen, re-read with each data refresh.
 const control = useControl(true,updatedAt,[]);
 // One version read for every badge (the ⋮ row and the Sessions top bar): mount, 60 s, tab visible.
 const version = useVersion();
 const headerSlot = useRef<HeaderSlotApi | null>(null);
 if (headerSlot.current === null) headerSlot.current = createHeaderSlot();
 const [searchOpen,setSearchOpen] = useState(false);
 const [search,setSearch] = useState<{jobs:FlightJob[] | null; landed:ShippedJob[] | null; error:string | null}>({jobs:null, landed:null, error:null});
 useEffect(() => {
  const shortcut = (event:KeyboardEvent) => {
   if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
  };
  window.addEventListener("keydown",shortcut);
  return () => window.removeEventListener("keydown",shortcut);
 },[]);
 useEffect(() => {
  if (!searchOpen) return;
  const controller = new AbortController();
  setSearch({jobs:null, landed:null, error:null});
  void fetch("/api/overview",{signal:controller.signal}).then(async response => {
   if (!response.ok) throw new Error("Overview unavailable");
   const data = await response.json() as OverviewResponse;
   if (!controller.signal.aborted) setSearch({jobs:data.in_flight, landed:data.shipped_today ?? [], error:data.availability.fleet === "unavailable" || data.availability.ledger === "unavailable" ? "In-flight jobs unavailable or incomplete" : null});
  }).catch(() => { if (!controller.signal.aborted) setSearch({jobs:[], landed:null, error:"In-flight jobs unavailable"}); });
  return () => controller.abort();
 },[searchOpen]);
 const openSearch = (event: {currentTarget:HTMLButtonElement}) => { event.currentTarget.focus(); setSearchOpen(true); };
 // The phone header (hidden on desktop) backs out of a More view to More; Board and Map are Jobs views with the plain header (audit P4).
 const subpage=["files","schedules","reports","settings"].includes(current.screen);
 const plain = !subpage && current.screen !== "job";
 const when = updatedAt ? <time class="shell-clock" dateTime={updatedAt}>{stamp(updatedAt)}</time> : null;
 const clockNow = updatedAt ? <time class="shell-clock" dateTime={updatedAt} title={stamp(updatedAt,true)}>{time(updatedAt)}</time> : null;
 const live = <span class={`shell-live shell-live-${status}`} role="status"><span/>{status === "live" ? clockNow ?? status : <>{status}{clockNow && <> · {clockNow}</>}</>}</span>;
 return <div class="shell"><header class={`shell-header${current.screen === "files" ? " shell-files-header" : subpage ? " shell-header-subpage" : ""}`}>
  {subpage ? <><a href="#more" aria-label="Back to More" class="shell-back"><Icon name="back"/></a><Brand/></> : current.screen === "job" ? <><a class="shell-back" href="#jobs" aria-label="Back to jobs"><Icon name="back"/></a><code class="shell-detail-title">{current.jobId ?? "command-post"}</code></> : <Brand/>}
  <div class="shell-header-right">{plain ? live : when}<button type="button" aria-label="Search navigation and in-flight jobs" aria-haspopup="dialog" title="Search" onClick={openSearch} class="shell-search"><Icon name="search"/></button><MoreMenu control={control} version={version} updatedAt={updatedAt}/></div>
 </header>
  <aside class="shell-sidebar"><Brand/><button type="button" class="shell-desktop-search" aria-haspopup="dialog" title="Search (Ctrl/⌘ K)" onClick={openSearch}><Icon name="search" size={16}/><span>Search</span><kbd>⌘K</kbd></button><Navigation current={current} awaiting={awaiting} desktop/><div class="shell-sidebar-status"><span class={`shell-live shell-live-${status}`} role="status"><span/>{status}</span></div></aside>
  <main class={`shell-main${current.screen === "board" ? " shell-main-board" : ""}`}><ShellContext.Provider value={{status,openSearch:() => setSearchOpen(true),control,version,updatedAt}}><HeaderSlot.Provider value={headerSlot.current}>{children}<FallbackHeader current={current}/></HeaderSlot.Provider></ShellContext.Provider></main><Navigation current={current} awaiting={awaiting}/>
  {searchOpen && <SearchDialog jobs={search.jobs} landed={search.landed} error={search.error} onClose={() => setSearchOpen(false)}/>}
 </div>;
}
