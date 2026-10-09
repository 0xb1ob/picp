import { useEffect, useState } from "preact/hooks";
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
 const [busy, setBusy] = useState(false);
 const [notice, setNotice] = useState<SettingsView["notice"]>(null);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  void Promise.all([readSettings(fetcher, controller.signal), readControl(fetcher, controller.signal)]).then(([settings, control]) => {
   if (controller.signal.aborted) return;
   setStatus(settings);
   setToken("error" in control || !control.running ? null : control.token ?? null);
   // The server answers at once while its first `pi --list-models` run is going: ask again shortly (bounded: that run ends in at most 8 s).
   if (!("error" in settings) && settings.models_loading) retry = setTimeout(() => setGeneration(value => value + 1), 2000);
  });
  return () => { controller.abort(); clearTimeout(retry); };
 }, [generation]);
 const write = async (body: {changes: Drafts} | RestoreSelector): Promise<boolean> => {
  const revision = status && !("error" in status) ? status.snapshot?.revision : undefined;
  if (!revision || !token || busy) return false;
  setBusy(true);
  const result = await writeSettings(fetcher, token, revision, body);
  setBusy(false);
  if ("error" in result) { setNotice({kind: "error", text: `Not saved: ${result.error}`, errors: []}); return false; }
  const answer = result.body;
  if (result.status === 412 && answer.snapshot && status && !("error" in status)) {
   setStatus({...status, snapshot: answer.snapshot});
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
 return {status, token, busy, notice, save: changes => write({changes}), restore: write};
}
