import { useEffect, useRef, useState } from "preact/hooks";
import { readControl } from "./control.ts";
import { type Drafts, readSettings, type RestoreSelector, type SettingsStatus, type SettingsView, writeSettings } from "./settings-control.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The Settings page's state: `/api/settings` and the session's control token on mount and after each write. A write
 * resolves true when it landed (the page drops those drafts); a 412 swaps in the fresh snapshot and keeps the drafts.
 */
export function useSettingsControl(fetcher: Fetch = (url, init) => fetch(url, init)): SettingsView {
 const [status, setStatus] = useState<SettingsStatus | null>(null);
 const [token, setToken] = useState<string | null>(null);
 const [writes, setWrites] = useState(0);
 const pending = useRef(0), revision = useRef<string | undefined>(undefined), queue = useRef<Promise<unknown>>(Promise.resolve());
 const [notice, setNotice] = useState<SettingsView["notice"]>(null);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  void Promise.all([readSettings(fetcher, controller.signal), readControl(fetcher, controller.signal, false)]).then(([settings, control]) => {
   if (controller.signal.aborted) return;
   setStatus(settings);
   // A read that raced a queued write may predate it: only an idle page takes its revision.
   if (!("error" in settings) && pending.current === 0) revision.current = settings.snapshot?.revision;
   setToken("error" in control || !control.running ? null : control.token ?? null);
   // The server answers at once while its first `pi --list-models` run is going: ask again shortly (bounded: that run ends in at most 8 s).
   if (!("error" in settings) && settings.models_loading) retry = setTimeout(() => setGeneration(value => value + 1), 2000);
  });
  return () => { controller.abort(); clearTimeout(retry); };
 }, [generation]);
 // Writes run one at a time, each on the revision the previous one left, so a click in another section is never dropped.
 const send = async (body: {changes: Drafts} | RestoreSelector, token: string): Promise<boolean> => {
  if (!revision.current) return false;
  const result = await writeSettings(fetcher, token, revision.current, body);
  if ("error" in result) { setNotice({kind: "error", text: `Not saved: ${result.error}`, errors: []}); return false; }
  const answer = result.body;
  if (answer.revision) revision.current = answer.revision;
  if (result.status === 412 && answer.snapshot) {
   const snapshot = answer.snapshot;
   setStatus(current => current && !("error" in current) ? {...current, snapshot} : current);
   setNotice({kind: "stale", text: "Changed on disk since this page loaded: review your edits against the fresh values and save again", errors: []});
   return false;
  }
  if (answer.state === "applied" || answer.state === "unchanged") {
   setNotice({kind: "ok", text: answer.state === "applied" ? `Saved · ${answer.changes?.length ?? 0} change${answer.changes?.length === 1 ? "" : "s"}${answer.audit_warning ? ` · ${answer.audit_warning}` : ""}` : "Nothing to change", errors: []});
   setGeneration(value => value + 1);
   return true;
  }
  setNotice({kind: "error", text: `Not saved: ${answer.error ?? answer.state}`, errors: answer.errors ?? []});
  return false;
 };
 const write = (body: {changes: Drafts} | RestoreSelector): Promise<boolean> => {
  if (!token) return Promise.resolve(false);
  pending.current++;
  setWrites(count => count + 1);
  const run = queue.current.then(() => send(body, token)).finally(() => { pending.current--; setWrites(count => count - 1); });
  queue.current = run.catch(() => false);
  return run;
 };
 return {status, token, busy: writes > 0, notice, save: changes => write({changes}), restore: write};
}
