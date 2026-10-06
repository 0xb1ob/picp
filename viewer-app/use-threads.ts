import { useEffect, useState } from "preact/hooks";
import { readThreads, sendThreadDone, THREAD_KEY, type ThreadsStatus, type ThreadsView, threadsReady } from "./threads.ts";

function stored(): string | null {
 try { return typeof window === "undefined" ? null : window.localStorage?.getItem(THREAD_KEY) ?? null; } catch { return null; }
}

/**
 * The Full transcript's threads (cp-xmw2 S5): reads `/api/threads` on mount, on every refresh and after each Mark done;
 * one selection (a tag, `localStorage` `cp-thread`, absent for All); one done at a time.
 */
export function useThreads(active: boolean, refreshKey: string | null, fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): ThreadsView | undefined {
 const [status, setStatus] = useState<ThreadsStatus | null>(null);
 const [selected, setSelected] = useState<string | null>(stored);
 const [sending, setSending] = useState<string | null>(null);
 const [failed, setFailed] = useState<ThreadsView["failed"]>(null);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  void readThreads(fetcher, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); });
  return () => controller.abort();
 }, [active, refreshKey, generation]);
 if (!active) return undefined;
 const select = (tag: string | null) => {
  setSelected(tag);
  setFailed(null);
  try { if (tag) window.localStorage?.setItem(THREAD_KEY, tag); else window.localStorage?.removeItem(THREAD_KEY); }
  catch (error) { console.warn(`thread choice not persisted: ${(error as Error).message}`); }
 };
 const done = (id: string) => {
  if (!threadsReady(status) || !status.token || sending) return;
  setSending(id);
  setFailed(null);
  void sendThreadDone(fetcher, status.token, id).then(result => {
   // A done thread leaves the chips: the view goes back to All.
   if ("error" in result) setFailed({id, reason: result.error});
   else select(null);
   setSending(null);
   setGeneration(value => value + 1);
  });
 };
 return {status, selected, select, done, sending, failed};
}
