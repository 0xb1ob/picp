import { useEffect, useState } from "preact/hooks";
import type { PushStatusResponse } from "../src/viewer/api-types.ts";
import { browserPushDeps, disablePush, enablePush, type PushDeps, pushPhase, type PushView, readSubscribed } from "./push.ts";

let browserDeps: PushDeps | undefined;

/** More's Notifications control: reads `/api/push` and this browser's subscription while More is shown. */
export function usePush(active: boolean, deps: PushDeps = browserDeps ??= browserPushDeps()): PushView | undefined {
 const [status, setStatus] = useState<PushStatusResponse | null | undefined>(undefined);
 const [subscribed, setSubscribed] = useState<boolean | undefined>(undefined);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  deps.fetch("/api/push", {signal: controller.signal})
   .then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json() as PushStatusResponse; })
   .then(value => { if (!controller.signal.aborted) setStatus(value); })
   .catch(() => { if (!controller.signal.aborted) setStatus(null); });
  if (deps.env().supported) readSubscribed(deps).then(value => { if (!controller.signal.aborted) setSubscribed(value); }).catch(() => { if (!controller.signal.aborted) setSubscribed(false); });
  return () => controller.abort();
 }, [active, generation, deps]);
 if (!active) return undefined;
 const phase = pushPhase(deps.env(), {status, subscribed, busy});
 const toggle = () => {
  if (busy || (phase !== "on" && phase !== "off") || !status?.public_key) return;
  const publicKey = status.public_key;
  setBusy(true); setError(null); setNotice(null);
  const run = phase === "on"
   ? disablePush(deps).then(result => { if (result.warning) setNotice(result.warning); })
   : enablePush(deps, publicKey).then(result => { if (result === "denied") setNotice("Notifications were not allowed in this browser"); });
  void run.catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : "Notifications could not be changed"); })
   .finally(() => { setBusy(false); setGeneration(value => value + 1); });
 };
 return {phase, status, error, notice, toggle};
}
