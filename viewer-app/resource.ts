export interface Stream extends EventTarget { close(): void }
/** `code`: the HTTP status of the last refused fetch (a 403 is a route the server will not serve here). */
export interface Snapshot<T> { data: T | null; status: "connecting" | "live" | "stale" | "offline"; error: string | null; code?: number | undefined }
interface Dependencies {
 fetch(url: string, init: {signal: AbortSignal}): Promise<Response>;
 stream(url: string): Stream;
}
export function createResource<T>(url: string, streamUrl: string, deps: Dependencies = {fetch: (u,i) => fetch(u,i), stream:u => new EventSource(u)}) {
 let state: Snapshot<T> = {data:null,status:"connecting",error:null};
 let generation = 0, visible = false, connected = false, trailing = false, disposed = false;
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
   const response = await deps.fetch(url,{signal:controller.signal});
   if (!response.ok) { code = response.status; throw new Error("Overview unavailable"); }
   const data = await response.json() as T;
   if (generation !== current || disposed) return;
   clearTimeout(freshness);
   freshness = setTimeout(() => { state.status = "stale"; state.error = "Refresh delayed"; publish(); },5000);
   state = {data, status:connected ? "live" : "stale", error:null}; publish();
  } catch {
   if (generation !== current || disposed) return;
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
  dispose() { disposed = true; visible = false; disconnect(); listeners.clear(); },
 };
}
