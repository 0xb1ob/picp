import { useEffect, useState } from "preact/hooks";
import type { SessionEntry } from "../src/viewer/api-types.ts";
import { canStart, type ControlBody, type ControlStatus, type ControlView, controlReady, controlToken, type Delivery, type Launcher, readControl, sendControl, START_HINTS, START_WAIT_MS, type Starting, startOperator } from "./control.ts";
import { restartInFlight } from "./restart-control.ts";
import { useRestart } from "./use-restart.ts";

/**
 * The Full transcript's dashboard control: reads `/api/operator/control` on mount and on every refresh of the
 * transcript (`refreshKey`), and sends one composer message, click or abort at a time. While offline it offers
 * Start session: one `POST /api/operator/start` `{via}`, then the status every 2 s until a session serves (≤ 60 s).
 */
export function useControl(active: boolean, refreshKey: string | null, entries: SessionEntry[], fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): ControlView | undefined {
 const [status, setStatus] = useState<ControlStatus | null>(null);
 const [delivery, setDelivery] = useState<Delivery | null>(null);
 const [generation, setGeneration] = useState(0);
 const [starting, setStarting] = useState<Starting | null>(null);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  void readControl(fetcher, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); });
  return () => controller.abort();
 }, [active, refreshKey, generation]);
 useEffect(() => {
  if (!active || starting?.state !== "starting") return;
  const via = starting.via ?? "tmux";
  const deadline = Date.now() + START_WAIT_MS;
  let stop = false;
  const poll = async () => {
   while (!stop) {
    const value = await readControl(fetcher);
    if (stop) return;
    setStatus(value);
    if (!("error" in value) && value.running && value.token) return setStarting({state: "running", reason: null});
    if (Date.now() > deadline) return setStarting({state: "failed", reason: `no session served the dashboard within 60 s; ${START_HINTS[via][0]} ${START_HINTS[via][1]} to see why`, via});
    await new Promise(done => setTimeout(done, 2_000));
   }
  };
  void poll();
  return () => { stop = true; };
 }, [active, starting?.state]);
 const {restarting, restart} = useRestart(active, status, fetcher, setStatus);
 if (!active) return undefined;
 // Promote a queued send once the bridge or the transcript itself has seen it.
 const seen = delivery?.id && delivery.state === "queued" && (entries.some(e => e.dashboard_id === delivery.id) || (status && !("error" in status) && status.recent.some(r => r.id === delivery.id && r.state === "delivered")));
 const shown = seen ? {...delivery, state: "delivered" as const} : delivery;
 const send = (body: ControlBody, card?: string) => {
  if (!controlReady(status) || delivery?.state === "sending" || starting?.state === "starting" || restartInFlight(restarting)) return;
  const askId = body.kind === "answer" ? body.ask_id : card ?? null;
  setDelivery({id: null, state: "sending", reason: null, ask_id: askId});
  void sendControl(fetcher, controlToken(status), body).then(result => {
   setDelivery("error" in result ? {id: null, state: "failed", reason: result.error, ask_id: askId} : {id: result.id, state: result.state, reason: null, ask_id: askId});
   setGeneration(value => value + 1);
  });
 };
 const start = (via: Launcher, resume = false) => {
  if (!canStart(status) || starting?.state === "starting") return;
  setStarting({state: "starting", reason: null, via});
  void startOperator(fetcher, status.inbox_token ?? "", via, resume).then(result => {
   if ("error" in result || result.state === "unavailable") setStarting({state: "failed", reason: "error" in result ? result.error : result.reason ?? "unavailable", via});
   else if (result.state === "already_running") setGeneration(value => value + 1);
  });
 };
 return {status, delivery: shown, send, starting, start, restarting, restart};
}
