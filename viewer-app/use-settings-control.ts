import { useEffect, useRef, useState } from "preact/hooks";
import { type ControlStatus, readControl } from "./control.ts";
import { type Drafts, type ModelsStatus, readModels, readSettings, type RestoreSelector, type SettingsStatus, type SettingsView, writeSettings } from "./settings-control.ts";
import type { SettingKey } from "../src/contracts.ts";
import type { ModelApplyRow } from "../src/viewer/api-types.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type ApplyWatch = {after: string; since: number} | null;
const APPLY_POLL_MS = 5_000, APPLY_POLL_CAP_MS = 600_000, MODELS_POLL_MS = 1_000;
/** Only the parent writes `state/model-apply.jsonl` rows today. */
const WATCHED: SettingKey[] = ["models.parent", "models.parent_thinking"];

/** True while a row is `queued`, or a saved key has no newer row; false once 10 min passed (the cap). */
function applyPending(rows: ModelApplyRow[], watch: {current: ApplyWatch}): boolean {
 const latest = rows.at(-1)?.at ?? "";
 const queued = (["parent", "operator"] as const).some(session => rows.filter(row => row.session === session).at(-1)?.state === "queued");
 if (watch.current && latest > watch.current.after && !queued) watch.current = null;
 if (!queued && !watch.current) return false;
 watch.current ??= {after: latest, since: Date.now()};
 return Date.now() - watch.current.since < APPLY_POLL_CAP_MS;
}
/**
 * The Settings page's state: `/api/settings` and the session's control token on mount and after each write. A write
 * resolves true when it landed (the page drops those drafts); a 412 swaps in the fresh snapshot and keeps the drafts.
 */
export function useSettingsControl(fetcher: Fetch = (url, init) => fetch(url, init)): SettingsView {
 const [status, setStatus] = useState<SettingsStatus | null>(null);
 const [token, setToken] = useState<string | null>(null);
 const [control, setControl] = useState<ControlStatus | null>(null);
 const [restart, setRestart] = useState(false);
 const [operatorRestart, setOperatorRestart] = useState(false);
 const [writes, setWrites] = useState(0);
 const pending = useRef(0), revision = useRef<string | undefined>(undefined), queue = useRef<Promise<unknown>>(Promise.resolve());
 const [notice, setNotice] = useState<SettingsView["notice"]>(null);
 const [generation, setGeneration] = useState(0);
 const [models, setModels] = useState<ModelsStatus | null>(null);
 const [modelsAsk, setModelsAsk] = useState({n: 0, refresh: true});
 // A saved parent model key, or a queued switch, re-reads until its outcome row lands (bounded).
 const watch = useRef<ApplyWatch>(null), lastAt = useRef("");
 useEffect(() => {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  void Promise.all([readSettings(fetcher, controller.signal), readControl(fetcher, controller.signal, false)]).then(([settings, control]) => {
   if (controller.signal.aborted) return;
   setStatus(settings);
   // A read that raced a queued write may predate it: only an idle page takes its revision.
   if (!("error" in settings) && pending.current === 0) revision.current = settings.snapshot?.revision;
   if (!("error" in settings)) lastAt.current = settings.model_apply?.at(-1)?.at ?? "";
   setToken("error" in control || !control.running ? null : control.token ?? null);
   setControl(control);
   if (!("error" in settings) && applyPending(settings.model_apply ?? [], watch)) retry = setTimeout(() => setGeneration(value => value + 1), APPLY_POLL_MS);
  });
  return () => { controller.abort(); clearTimeout(retry); };
 }, [generation]);
 // The model list loads on its own: opening the page asks for a fresh run, then re-reads until it lands (8 s at most).
 useEffect(() => {
  const controller = new AbortController();
  let poll: ReturnType<typeof setTimeout> | undefined;
  void readModels(fetcher, modelsAsk.refresh, controller.signal).then(list => {
   if (controller.signal.aborted) return;
   setModels(list);
   if (!("error" in list) && list.pi.loading) poll = setTimeout(() => setModelsAsk(ask => ({n: ask.n + 1, refresh: false})), MODELS_POLL_MS);
  });
  return () => { controller.abort(); clearTimeout(poll); };
 }, [modelsAsk]);
 // Writes run one at a time, each on the revision the previous one left,
 // so a click in another section is never dropped.
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
   if (answer.restart === "parent") setRestart(true);
   // `restart` names one session; a restore can change both drivers.
   if (answer.changes?.some(change => change.key === "models.operator_driver")) setOperatorRestart(true);
   if (answer.state === "applied" && answer.changes?.some(change => WATCHED.includes(change.key))) watch.current = {after: lastAt.current, since: Date.now()};
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
 const refreshModels = () => setModelsAsk(ask => ({n: ask.n + 1, refresh: true}));
 return {status, token, busy: writes > 0, notice, control, restart, operatorRestart, save: changes => write({changes}), restore: write, models, refreshModels};
}
