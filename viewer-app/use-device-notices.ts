import { useEffect, useState } from "preact/hooks";
import type { DeviceNotice, DeviceNoticeRecipient, DeviceNoticesResponse } from "../src/viewer/api-types.ts";

/** Remote dashboard PR 1d: the shell's pairing notices — quick polling while visible, plus every live refresh and reconnect. */
export const DEVICE_NOTICES_REFRESH_MS = 2_000;
/** This browser's dismissal cursor (the newest dismissed event time). Local only: never an acknowledgement another device sees. */
export const DEVICE_NOTICES_CURSOR_KEY = "cp-device-notices-seen";

/** `off`: this viewer has no device routes (404) or this screen may not read them (401/403) — render nothing, stop asking. */
export type DeviceNoticesState = { kind: "loading" } | { kind: "off" } | { kind: "ok"; data: DeviceNoticesResponse } | { kind: "error"; error: string; data: DeviceNoticesResponse | null };

export function readCursor(): string {
 try { return globalThis.localStorage?.getItem(DEVICE_NOTICES_CURSOR_KEY) ?? ""; } catch { return ""; }
}
export function writeCursor(at: string): void {
 try { globalThis.localStorage?.setItem(DEVICE_NOTICES_CURSOR_KEY, at); } catch { /* storage refused: dismissed for this view only */ }
}

/** Notices newer than the cursor, newest first (the server's order). */
export const unreadNotices = (notices: readonly DeviceNotice[], cursor: string): DeviceNotice[] => notices.filter(notice => notice.at > cursor);

const LABELS: Record<DeviceNoticeRecipient["state"], string> = {
 pending: "pending", unsubscribed: "not subscribed", unavailable: "push unavailable", retrying: "retrying", delivered: "delivered to push service",
 failed: "failed", expired: "expired", revoked: "revoked", unknown: "status unknown",
};
/** One honest line: how many recipients are in each push state, e.g. `push: 2 delivered to push service · 1 not subscribed`. */
export function deliverySummary(recipients: readonly DeviceNoticeRecipient[], deliveryError: string | null): string {
 if (deliveryError) return `push status unavailable: ${deliveryError}`;
 const counts = new Map<string, number>();
 for (const recipient of recipients) counts.set(LABELS[recipient.state], (counts.get(LABELS[recipient.state]) ?? 0) + 1);
 return `push: ${[...counts].map(([label, n]) => `${n} ${label}`).join(" · ") || "no recipients"}`;
}

export function useDeviceNotices(updatedAt: string | null, fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): DeviceNoticesState {
 const [state, setState] = useState<DeviceNoticesState>({kind: "loading"});
 const off = state.kind === "off";
 useEffect(() => {
  if (off) return;
  let controller: AbortController | undefined;
  const load = () => {
   if (document.visibilityState === "hidden") return;
   controller?.abort();
   const current = controller = new AbortController();
   void fetcher("/api/devices/notices", {signal: current.signal}).then(async response => {
    if (response.status === 404 || response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as DeviceNoticesResponse;
   }).then(data => { if (!current.signal.aborted) setState(data ? {kind: "ok", data} : {kind: "off"}); })
    .catch((error: Error) => { if (!current.signal.aborted) setState(prior => ({kind: "error", error: error.message || "unavailable", data: prior.kind === "ok" || prior.kind === "error" ? prior.data : null})); });
  };
  load();
  const tick = window.setInterval(load, DEVICE_NOTICES_REFRESH_MS);
  document.addEventListener("visibilitychange", load);
  window.addEventListener("online", load);
  return () => { controller?.abort(); window.clearInterval(tick); document.removeEventListener("visibilitychange", load); window.removeEventListener("online", load); };
 }, [updatedAt, off]);
 return state;
}
