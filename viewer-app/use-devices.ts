import { useEffect, useState } from "preact/hooks";
import type { DevicesResponse, PairCodeResponse } from "../src/viewer/api-types.ts";
import { createPairing, type DeviceLevel, type Fetcher, readDevices, revokeDevice } from "./devices-control.ts";

/** While a pairing link is shown, the list refreshes this often so the new device appears. */
export const DEVICES_PAIRING_REFRESH_MS = 2_000;

/** `off`: this viewer has no device routes (404): the remote dashboard is not set up, or not running here. */
export type DevicesState = { kind: "loading" } | { kind: "off" } | { kind: "ok"; data: DevicesResponse } | { kind: "error"; error: string; data: DevicesResponse | null };
export interface DevicesView {
 state: DevicesState;
 /** The live pairing link: in memory only, cleared at its expiry and on unmount. */
 pairing: PairCodeResponse | null;
 busy: boolean;
 error: string | null;
 notice: string | null;
 create(level: DeviceLevel): void;
 revoke(id: string, name: string): void;
 dismissPairing(): void;
}

/** Settings → Devices: its own GET and writes, independent of operator Settings (they may be offline). */
export function useDevices(fetcher: Fetcher = (url, init) => fetch(url, init), confirm: (text: string) => boolean = text => globalThis.confirm?.(text) ?? true): DevicesView {
 const [state, setState] = useState<DevicesState>({kind: "loading"});
 const [pairing, setPairing] = useState<PairCodeResponse | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  let controller: AbortController | undefined;
  const load = () => {
   if (document.visibilityState === "hidden") return;
   controller?.abort();
   const current = controller = new AbortController();
   void readDevices(fetcher, current.signal).then(result => {
    if (current.signal.aborted) return;
    if (result.ok) setState({kind: "ok", data: result.value});
    else if (result.status === 404) setState({kind: "off"});
    else setState(prior => ({kind: "error", error: result.error, data: prior.kind === "ok" || prior.kind === "error" ? prior.data : null}));
   });
  };
  load();
  const tick = pairing ? setInterval(load, DEVICES_PAIRING_REFRESH_MS) : undefined;
  document.addEventListener("visibilitychange", load);
  return () => { controller?.abort(); clearInterval(tick); document.removeEventListener("visibilitychange", load); };
 }, [generation, pairing !== null]);
 useEffect(() => {
  if (!pairing) return;
  const left = Date.parse(pairing.expires_at) - Date.now();
  const timer = setTimeout(() => { setPairing(null); setNotice("The pairing link expired; add the device again for a new one"); }, Math.max(0, left));
  return () => clearTimeout(timer);
 }, [pairing]);
 const data = state.kind === "ok" || state.kind === "error" ? state.data : null;
 const run = <T,>(work: () => Promise<{ok: true; value: T} | {ok: false; error: string}>, done: (value: T) => void) => {
  if (busy) return;
  setBusy(true); setError(null); setNotice(null);
  void work().then(result => { if (result.ok) done(result.value); else setError(result.error); })
   .finally(() => { setBusy(false); setGeneration(value => value + 1); });
 };
 return {
  state, pairing, busy, error, notice,
  create: level => { if (data?.token && data.can_create) run(() => createPairing(fetcher, data.token!, level), setPairing); },
  revoke: (id, name) => {
   if (!data?.token || !data.can_revoke || !confirm(`Revoke ${name}? Its next request is refused and it must pair again.`)) return;
   run(() => revokeDevice(fetcher, data.token!, id), value => setNotice(`Revoked ${name}${value.audit_error ? ` (audit: ${value.audit_error})` : ""}${value.cleanup_error ? ` (its push subscription stays until the next push: ${value.cleanup_error})` : ""}`));
  },
  dismissPairing: () => setPairing(null),
 };
}
