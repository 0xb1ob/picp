import { type ComponentChildren, createContext } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { FlightJob, OverviewResponse } from "../../src/viewer/api-types.ts";
import { SearchDialog } from "./SearchDialog.tsx";
import type { Route } from "../routes.ts";
import { Icon } from "./icons.tsx";
import { Navigation } from "./Navigation.tsx";
import { clock } from "../format.ts";
function Brand() { return <div class="shell-brand"><code>command-post</code></div>; }
/** What a screen with its own top bar (Sessions on mobile) needs from the shell it hides: the live state and search. */
export const ShellContext = createContext<{status:string;openSearch:() => void}>({status:"unknown",openSearch:() => {}});
export function Shell({current,awaiting,status,updated,children}: {current:Route;awaiting:number | null;status:string;updated:string | null;children:ComponentChildren}) {
 const [searchOpen,setSearchOpen] = useState(false);
 const [search,setSearch] = useState<{jobs:FlightJob[] | null;error:string | null}>({jobs:null,error:null});
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
  setSearch({jobs:null,error:null});
  void fetch("/api/overview",{signal:controller.signal}).then(async response => {
   if (!response.ok) throw new Error("Overview unavailable");
   const data = await response.json() as OverviewResponse;
   if (!controller.signal.aborted) setSearch({jobs:data.in_flight,error:data.availability.fleet === "unavailable" || data.availability.ledger === "unavailable" ? "In-flight jobs unavailable or incomplete" : null});
  }).catch(() => { if (!controller.signal.aborted) setSearch({jobs:[],error:"In-flight jobs unavailable"}); });
  return () => controller.abort();
 },[searchOpen]);
 const openSearch = (event: {currentTarget:HTMLButtonElement}) => { event.currentTarget.focus(); setSearchOpen(true); };
 const [now,setNow] = useState(() => new Date());
 useEffect(() => { const tick = window.setInterval(() => setNow(new Date()),15_000); return () => window.clearInterval(tick); },[]);
 // The phone header (hidden on desktop) backs out of a More view to More; Board and Map are Jobs views with the plain header (audit P4).
 const subpage=["files","schedules","reports"].includes(current.screen);
 const live = <span class={`shell-live shell-live-${status}`} role="status"><span/>{status}{updated && <> &middot; {updated}</>}</span>;
 const localClock = <time class="shell-clock" dateTime={now.toISOString()} title="Local time">{clock(now)}</time>;
 return <div class="shell"><header class={`shell-header${current.screen === "files" ? " shell-files-header" : subpage ? " shell-header-subpage" : ""}`}>
  {subpage ? <><a href="#more" aria-label="Back to More" class="shell-back"><Icon name="back"/></a><Brand/></> : current.screen === "job" ? <><a class="shell-back" href="#jobs" aria-label="Back to jobs"><Icon name="back"/></a><code class="shell-detail-title">{current.jobId ?? "command-post"}</code></> : <Brand/>}
  <div class="shell-header-right">{!subpage && current.screen !== "job" && live}{localClock}<button type="button" aria-label="Search navigation and in-flight jobs" aria-haspopup="dialog" title="Search" onClick={openSearch} class="shell-search"><Icon name="search"/></button></div>
 </header>
  <aside class="shell-sidebar"><Brand/><button type="button" class="shell-desktop-search" aria-haspopup="dialog" title="Search" onClick={openSearch}><Icon name="search" size={16}/><span>Search</span></button><Navigation current={current} awaiting={awaiting} desktop/><div class="shell-sidebar-status">{live}</div></aside>
  <main class={`shell-main${current.screen === "board" ? " shell-main-board" : ""}`}><div class="shell-corner">{localClock}</div><ShellContext.Provider value={{status,openSearch:() => setSearchOpen(true)}}>{children}</ShellContext.Provider></main><Navigation current={current} awaiting={awaiting}/>
  {searchOpen && <SearchDialog jobs={search.jobs} error={search.error} onClose={() => setSearchOpen(false)}/>}
 </div>;
}
