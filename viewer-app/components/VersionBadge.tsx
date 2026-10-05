import { useEffect, useRef, useState } from "preact/hooks";
import type { ProcessVersion, VersionResponse } from "../../src/viewer/api-types.ts";
import { elapsed } from "../format.ts";
import { badgeView, pageScript, type VersionState } from "../use-version.ts";

const ROLE: Record<ProcessVersion["role"], string> = {viewer: "Viewer server", host: "Parent host", parent: "CP parent", operator: "Operator session"};
const ago = (at: string | null): string => at && !Number.isNaN(Date.parse(at)) ? `${elapsed(Math.max(0, (Date.now() - Date.parse(at)) / 1000))} ago` : "unknown";

function upstreamText(view: VersionResponse): string {
 const u = view.upstream;
 const refs = u.state === "unknown" ? `not comparable${u.reason ? ` (${u.reason})` : ""}`
  : u.state === "current" ? "at origin/main"
  : u.state === "behind" ? `${u.behind} behind origin/main`
  : u.state === "ahead" ? `${u.ahead} ahead of origin/main`
  : `diverged: ${u.behind} behind, ${u.ahead} ahead`;
 return `${refs}; ${u.checked_at ? `fetched ${ago(u.checked_at)}` : "no recent fetch, so origin/main may be old"}`;
}

/**
 * The version badge (cp-kz20): a 44 px dot + short text (✓, N↓, ↻, !, ?) that never relies on colour alone; tapping it
 * opens the three layers — upstream, each running process with its restart, and this page with Reload. Esc and a tap
 * outside close it (as MoreMenu). `labelled` also shows the label (the desktop corner has room). Read-only: the one
 * action is the browser's own reload.
 */
export function VersionBadge({state, labelled = false}: {state: VersionState; labelled?: boolean}) {
 const menu = useRef<HTMLDetailsElement>(null);
 const [open,setOpen] = useState(false);
 useEffect(() => {
  if (!open) return;
  const close = () => { if (menu.current) menu.current.open = false; };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); menu.current?.querySelector("summary")?.focus(); } };
  const outside = (e: Event) => { if (menu.current && !menu.current.contains(e.target as Node)) close(); };
  document.addEventListener("keydown",key);
  document.addEventListener("pointerdown",outside);
  return () => { document.removeEventListener("keydown",key); document.removeEventListener("pointerdown",outside); };
 },[open]);
 const badge = badgeView(state, typeof document === "undefined" ? null : pageScript());
 const view = state.view;
 return <details class={`shell-version shell-version-${badge.level}${labelled ? " shell-version-labelled" : ""}`} ref={menu} onToggle={e => setOpen(e.currentTarget.open)}>
  <summary aria-label={`Version: ${badge.label}`} title={badge.label}><span class="shell-version-dot" aria-hidden="true"/><span class="shell-version-short" aria-hidden="true">{badge.short}</span>{labelled && <span class="shell-version-label" aria-hidden="true">{badge.label}</span>}</summary>
  {open && <div class="shell-version-panel">
   <p class="shell-version-head">{badge.label}</p>
   {view && <>
    <dl class="shell-version-layers">
     <dt>Deployed</dt><dd>{view.deployed ? <><code>{view.deployed.sha.slice(0,7)}</code> · committed {ago(view.deployed.at)}</> : "checkout HEAD unreadable"}</dd>
     <dt>Upstream</dt><dd>{upstreamText(view)}</dd>
     {view.upstream.updater && <><dt>Updater</dt><dd>{view.upstream.updater.enabled ? "" : "auto-update off · "}{view.upstream.updater.result ?? "no result"}{view.upstream.updater.last_run_at && ` · last run ${ago(view.upstream.updater.last_run_at)}`}{view.upstream.updater.fetch_failures > 0 && ` · ${view.upstream.updater.fetch_failures} failed fetch(es)`}{view.upstream.updater.detail && <small>{view.upstream.updater.detail}</small>}</dd></>}
     {!view.upstream.updater && <><dt>Updater</dt><dd>never ran (no state/update.json)</dd></>}
    </dl>
    <ul class="shell-version-procs">{view.processes.map(p => <li key={p.role}>
     <span class={`shell-version-state shell-version-state-${p.state}`}>{p.state}</span> <strong>{ROLE[p.role]}</strong>{p.commit && <> <code>{p.commit.slice(0,7)}</code></>}
     <small>{p.why}{p.started_at ? ` · started ${ago(p.started_at)}` : ""}</small>
     {p.fix && (p.state === "stale" || p.state === "unknown") && <small class="shell-version-fix">Restart: {p.fix}</small>}
    </li>)}</ul>
   </>}
   <p class="shell-version-page">This page: {badge.pageStale ? <>an older build than the server's <button type="button" class="shell-version-reload" onClick={() => location.reload()}>Reload page</button></> : view ? "current build" : "unknown"}</p>
  </div>}
 </details>;
}
