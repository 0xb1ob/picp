import { useEffect, useState } from "preact/hooks";
import type { VersionLevel, VersionResponse } from "../src/viewer/api-types.ts";

export const VERSION_REFRESH_MS = 60_000;
export interface VersionState { view: VersionResponse | null; error: string | null }
export interface BadgeView { level: VersionLevel; short: string; label: string; pageStale: boolean }

/** The app script this tab loaded, as the server names it in `bundle.script`. */
export function pageScript(doc: Document = document): string | null {
 return doc.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/viewer/"]')?.getAttribute("src")?.split("?")[0] ?? null;
}

/** What the badge shows: the server's level and label, plus an outdated page (its script differs from the server's) → at least amber. */
export function badgeView(state: VersionState, script: string | null): BadgeView {
 const view = state.view;
 if (!view) return {level: "unknown", short: "?", label: state.error ? `version unavailable (${state.error})` : "version: loading", pageStale: false};
 const pageStale = view.bundle.script !== null && script !== null && script !== view.bundle.script;
 const level = pageStale && (view.overall.level === "ok" || view.overall.level === "unknown") ? "warn" : view.overall.level;
 const label = pageStale ? `page outdated — reload · ${view.overall.label}` : view.overall.label;
 const short = level === "ok" ? "✓" : level === "alert" ? "!" : level === "unknown" ? "?" : view.upstream.behind ? `${view.upstream.behind}↓` : "↻";
 return {level, short, label, pageStale};
}

/**
 * `GET /api/version` on mount, every 60 s and whenever the tab becomes visible again; one interval per mounted
 * shell, cleared on unmount. A failed read keeps the last view and names the error.
 */
export function useVersion(fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): VersionState {
 const [state, setState] = useState<VersionState>({view: null, error: null});
 useEffect(() => {
  let controller: AbortController | undefined;
  const load = () => {
   controller?.abort();
   const current = controller = new AbortController();
   void fetcher("/api/version", {signal: current.signal}).then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as VersionResponse;
   }).then(view => { if (!current.signal.aborted) setState({view, error: null}); })
    .catch((error: Error) => { if (!current.signal.aborted) setState(prior => ({view: prior.view, error: error.message || "unavailable"})); });
  };
  load();
  const tick = window.setInterval(load, VERSION_REFRESH_MS);
  const visible = () => { if (document.visibilityState === "visible") load(); };
  document.addEventListener("visibilitychange", visible);
  return () => { controller?.abort(); window.clearInterval(tick); document.removeEventListener("visibilitychange", visible); };
 }, []);
 return state;
}
