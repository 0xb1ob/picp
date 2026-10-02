import { useEffect, useState } from "preact/hooks";
import { readScheduleControl, type ScheduleControlStatus, type ScheduleControlView, scheduleControlReady, type ScheduleOp, sendScheduleControl } from "./schedule-control.ts";

/**
 * The Schedules page's controls (cp-hhuf P6): reads `/api/schedules/control` on mount, on every refresh of the page
 * (`refreshKey`) and after each send; sends one request at a time, and only while ready.
 */
export function useScheduleControl(active: boolean, refreshKey: string | null, fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): ScheduleControlView | undefined {
 const [status, setStatus] = useState<ScheduleControlStatus | null>(null);
 const [sending, setSending] = useState<ScheduleControlView["sending"]>(null);
 const [failed, setFailed] = useState<ScheduleControlView["failed"]>(null);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  void readScheduleControl(fetcher, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); });
  return () => controller.abort();
 }, [active, refreshKey, generation]);
 if (!active) return undefined;
 const request = (op: ScheduleOp, scheduleId: string) => {
  if (!scheduleControlReady(status) || sending) return;
  setSending({schedule_id: scheduleId, op});
  setFailed(null);
  void sendScheduleControl(fetcher, status.token ?? "", {op, schedule_id: scheduleId}).then(result => {
   if ("error" in result) setFailed({schedule_id: scheduleId, reason: result.error});
   setSending(null);
   setGeneration(value => value + 1);
  });
 };
 return {status, sending, failed, request};
}
