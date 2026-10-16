import { applyDelta, type Delta } from "../src/viewer/json-delta.ts";
export interface Stream extends EventTarget { close(): void }
/** `code`: the HTTP status of the last refused fetch (a 403 is a route the server will not serve here). */
export interface Snapshot<T> { data: T | null; status: "connecting" | "live" | "stale" | "offline"; error: string | null; code?: number | undefined }
interface Dependencies {
 fetch(url: string, init: {signal: AbortSignal; headers?: Record<string,string>}): Promise<Response>;
 stream(url: string): Stream;
}
export const POLL_MS = 2000;
/**
 * Quick Tunnels carry no SSE, so the quick listener's app polls: a two-second clock speaking the stream's events.
 * `createResource` keeps doing the rest — it opens this only while visible, coalesces overlapping refreshes and closes it on hide/dispose.
 */
export function pollStream(): Stream {
 const target = new EventTarget();
 const opened = setTimeout(() => target.dispatchEvent(new Event("open")), 0);
 const clock = setInterval(() => target.dispatchEvent(new Event("refresh")), POLL_MS);
 return Object.assign(target, { close() { clearTimeout(opened); clearInterval(clock); } });
}
/** A value with the server version it came from (`x-cp-version`; null when the server sent none). */
export interface Held<T> { version: string | null; value: T }
/**
 * One GET outside `createResource`: sends `x-cp-delta-base` for `held` and applies a delta reply onto it. A reply for
 * another base, or one that does not apply, refetches in full once. A non-2xx reply comes back for the caller to read.
 */
export async function readDelta<T>(fetch: (url: string, init?: RequestInit) => Promise<Response>, url: string, held: Held<T> | null, signal?: AbortSignal): Promise<{ok: true; held: Held<T>} | {ok: false; response: Response}> {
 for (const base of held?.version ? [held, null] : [null]) {
  const response = await fetch(url, {...(signal ? {signal} : {}), ...(base?.version ? {headers: {"x-cp-delta-base": base.version}} : {})});
  if (!response.ok) return {ok: false, response};
  const body = await response.json() as T;
  const echoed = response.headers.get("x-cp-delta-base"), version = response.headers.get("x-cp-version");
  if (echoed === null) return {ok: true, held: {version, value: body}};
  try { if (base && echoed === base.version) return {ok: true, held: {version, value: applyDelta(base.value, body as Delta)}}; } catch { /* refetch in full */ }
 }
 throw new Error("delta reply for another base");
}
export function createResource<T>(url: string, streamUrl: string, deps: Dependencies = {fetch: (u,i) => fetch(u,i), stream:u => new EventSource(u)}) {
 let state: Snapshot<T> = {data:null,status:"connecting",error:null};
 let generation = 0, visible = false, connected = false, trailing = false, disposed = false;
 // The server version `state.data` holds (`x-cp-version`); null asks for a full body next time.
 let version: string | null = null;
 let source: Stream | null = null, request: AbortController | null = null;
 let freshness: ReturnType<typeof setTimeout> | undefined;
 const listeners = new Set<(state: Snapshot<T>) => void>();
 const publish = () => { state = {...state}; for (const listener of listeners) listener(state); };
 const refresh = async () => {
  if (!visible || disposed) return;
  if (request) { trailing = true; return; }
  const current = generation; const controller = new AbortController(); request = controller;
  let code: number | undefined;
  try {
   const base = version && state.data ? version : null;
   const response = await deps.fetch(url,{signal:controller.signal,...(base ? {headers:{"x-cp-delta-base":base}} : {})});
   if (!response.ok) { code = response.status; throw new Error("Overview unavailable"); }
   const body = await response.json() as T;
   if (generation !== current || disposed) return;
   let data = body;
   const echoed = response.headers.get("x-cp-delta-base");
   if (echoed !== null) {
    try {
     if (echoed !== base || !state.data) throw new Error("delta for another base");
     data = applyDelta(state.data, body as Delta);
    } catch { version = null; trailing = true; return; }
   }
   version = response.headers.get("x-cp-version");
   clearTimeout(freshness);
   freshness = setTimeout(() => { state.status = "stale"; state.error = "Refresh delayed"; publish(); },5000);
   state = {data, status:connected ? "live" : "stale", error:null}; publish();
  } catch {
   if (generation !== current || disposed) return;
   // A remote 401 is a revoked or expired device: protected data goes, never shown stale (the local listener never answers 401).
   if (code === 401) { state.data = null; version = null; }
   clearTimeout(freshness); state.status = state.data ? "stale" : "offline"; state.error = "Refresh failed";
   if (code === undefined) delete state.code; else state.code = code;
   publish();
  } finally {
   if (generation === current && !disposed) {
    request = null;
    if (trailing) { trailing = false; void refresh(); }
   }
  }
 };
 const open = () => { connected = true; clearTimeout(freshness); state.status = state.data ? "stale" : "connecting"; publish(); void refresh(); };
 const update = () => { void refresh(); };
 const error = () => { connected = false; clearTimeout(freshness); state.status = state.data ? "stale" : "offline"; publish(); };
 const disconnect = () => {
  generation++; request?.abort(); request = null; trailing = false; connected = false; clearTimeout(freshness);
  source?.removeEventListener("open",open); source?.removeEventListener("refresh",update); source?.removeEventListener("error",error);
  source?.close(); source = null;
 };
 return {
  snapshot: () => state,
  subscribe(listener: (value: Snapshot<T>) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  setVisible(value: boolean) {
   if (disposed || value === visible) return;
   visible = value; disconnect();
   if (!value) { state.status = "offline"; publish(); return; }
   state.status = state.data ? "stale" : "connecting"; publish();
   try { source = deps.stream(streamUrl); source.addEventListener("open",open); source.addEventListener("refresh",update); source.addEventListener("error",error); }
   catch { error(); }
   void refresh();
  },
  dispose() { disposed = true; visible = false; version = null; disconnect(); listeners.clear(); },
 };
}
