import { useEffect, useRef, useState } from "preact/hooks";
import type { SchedulePolicyResponse } from "../src/viewer/api-types.ts";
import { readSchedulePolicy, readScheduleControl, type ScheduleControlStatus, type ScheduleControlView, scheduleClientId, scheduleControlReady, type ScheduleOp, type ScheduleRequestExtra, sendScheduleControl } from "./schedule-control.ts";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export const SCHEDULE_RECEIPTS_KEY = "cp-schedule-receipts";
const RECEIPTS_KEPT = 20;

/** Ids of requests already sent; a storage that refuses reads as none and writes nothing. Ids only, never a body. */
export function readReceipts(): string[] {
 try {
  const value: unknown = JSON.parse(globalThis.localStorage?.getItem(SCHEDULE_RECEIPTS_KEY) ?? "[]");
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-RECEIPTS_KEPT) : [];
 } catch { return []; }
}
function keepReceipt(ids: string[], id: string): string[] {
 const next = [...ids.filter(kept => kept !== id), id].slice(-RECEIPTS_KEPT);
 try { globalThis.localStorage?.setItem(SCHEDULE_RECEIPTS_KEY, JSON.stringify(next)); } catch { /* storage refused: the receipt holds for this view only */ }
 return next;
}

/**
 * The Schedules page's controls (cp-hhuf P6): reads `/api/schedules/control` on mount, on every refresh of the page
 * (`refreshKey`) and after each send; sends one request at a time, and only while ready. Every send carries its own
 * `client_id` and is never retried: a reload keeps the receipt ids and resends nothing.
 */
export function useScheduleControl(active: boolean, refreshKey: string | null, fetcher: Fetcher = (url, init) => fetch(url, init)): ScheduleControlView | undefined {
 const [status, setStatus] = useState<ScheduleControlStatus | null>(null);
 const [sending, setSending] = useState<ScheduleControlView["sending"]>(null);
 const [failed, setFailed] = useState<ScheduleControlView["failed"]>(null);
 const [receipts, setReceipts] = useState<string[]>(readReceipts);
 const [generation, setGeneration] = useState(0);
 const inFlight = useRef(false);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  void readScheduleControl(fetcher, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); });
  return () => controller.abort();
 }, [active, refreshKey, generation]);
 if (!active) return undefined;
 const request = (op: ScheduleOp, scheduleId: string, extra: ScheduleRequestExtra = {}) => {
  if (!scheduleControlReady(status) || sending || inFlight.current) return;
  inFlight.current = true;
  setSending({schedule_id: scheduleId, op});
  setFailed(null);
  void sendScheduleControl(fetcher, status.token ?? "", {op, schedule_id: scheduleId, ...extra, client_id: scheduleClientId()}).then(result => {
   if ("error" in result) setFailed({schedule_id: scheduleId, reason: result.error});
   else setReceipts(ids => keepReceipt(ids, result.id));
   inFlight.current = false;
   setSending(null);
   setGeneration(value => value + 1);
  });
 };
 return {status, sending, failed, request, receipts};
}

/** One schedule's policy preview (readiness, editor base); read again when the page refreshes. */
export function useSchedulePolicy(active: boolean, scheduleId: string, refreshKey: string | null, fetcher: Fetcher = (url, init) => fetch(url, init)): SchedulePolicyResponse | {error: string} | null {
 const [policy, setPolicy] = useState<SchedulePolicyResponse | {error: string} | null>(null);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  void readSchedulePolicy(fetcher, scheduleId, controller.signal).then(value => { if (!controller.signal.aborted) setPolicy(value); });
  return () => controller.abort();
 }, [active, scheduleId, refreshKey]);
 return policy;
}
