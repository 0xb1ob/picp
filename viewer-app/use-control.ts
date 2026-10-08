import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionEntry } from "../src/viewer/api-types.ts";
import { canStart, type ControlBody, controlFiles, controlImages, type ControlStatus, type ControlView, controlReady, controlToken, type Delivery, type Launcher, readControl, sendControl, START_HINTS, START_WAIT_MS, type Starting, startOperator, uploadImage } from "./control.ts";
import { restartInFlight } from "./restart-control.ts";
import { useRestart } from "./use-restart.ts";
import { emptyPending, readPending, reconcilePending, rememberPending, type PendingState } from "./pending-sends.ts";

/**
 * The Full transcript's dashboard control: reads `/api/operator/control` on mount and on every refresh of the
 * transcript (`refreshKey`). Composer messages keep a persisted FIFO; their POSTs serialize with clicks and aborts.
 * Start session: one `POST /api/operator/start` `{via}`, then the status every 2 s until a session serves (≤ 60 s).
 */
export function useControl(active: boolean, refreshKey: string | null, entries: SessionEntry[], fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init), composer = false): ControlView | undefined {
 const [status, setStatus] = useState<ControlStatus | null>(null);
 const [delivery, setDelivery] = useState<Delivery | null>(null);
 const [generation, setGeneration] = useState(0);
 const [starting, setStarting] = useState<Starting | null>(null);
 const [pending, setPending] = useState<PendingState>(()=>composer ? readPending() : emptyPending());
 const requests = useRef<Promise<unknown>>(Promise.resolve());
 const updatePending = (change: (value: PendingState)=>PendingState) => setPending(value=>rememberPending(change(value)));
 const transcriptKey = entries.map(e=>`${e.id}:${e.dashboard_id ?? ""}`).join("|");
 useEffect(()=>{
  if (!composer || !active) return;
  setPending(value=>{const next=reconcilePending(value,status,entries); return JSON.stringify(next) === JSON.stringify(value) ? value : rememberPending(next);});
 },[active,composer,status,transcriptKey,refreshKey]);
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
 // Decision cards and abort keep their delivery summary; composer messages live in the FIFO list.
 const seen = delivery?.id && (entries.some(e => e.dashboard_id === delivery.id) || (status && !("error" in status) && status.recent.some(row=>row.id === delivery.id && row.state === "delivered")));
 const shown = seen ? {...delivery, state: "delivered" as const} : delivery;
 const enqueue = (body: Extract<ControlBody,{kind:"message"}>, card?: string, retryKey?: string) => {
  if (!controlReady(status) || starting?.state === "starting" || restartInFlight(restarting)) return;
  const at = new Date().toISOString(), ask_id = card ?? null;
  const random = [...crypto.getRandomValues(new Uint8Array(4))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  const key = `dc-${at.replace(/[-:T]/g,"").slice(0,14)}-${random}`;
  updatePending(value=>{
   const prior=value.items.find(item=>item.key === retryKey);
   return {...value,items:[...value.items.filter(item=>item.key !== retryKey),{key,at,id:key,state:"sending",reason:null,ask_id,body}],dismissed:prior?.id ? [...value.dismissed,prior.id] : value.dismissed};
  });
  // The server takes one POST at a time per address. Keep requests FIFO even when the operator sends quickly.
  requests.current = requests.current.then(async ()=>{
   const result = await sendControl(fetcher,controlToken(status),{...body,client_id:key}).catch((error: unknown)=>({error:error instanceof Error ? error.message : "Send failed",status:0}));
   updatePending(value=>({...value,items:value.items.map(item=>item.key !== key ? item : {...item,...("error" in result ? {state:"failed" as const,reason:result.error} : {id:result.id,state:result.state,reason:result.thread?.error ? `thread not recorded: ${result.thread.error}` : null})})}));
   setGeneration(value=>value+1);
  });
 };
 const send = (body: ControlBody, card?: string) => {
  if (composer && body.kind === "message") { enqueue(body,card); return; }
  if (!controlReady(status) || delivery?.state === "sending" || starting?.state === "starting" || restartInFlight(restarting)) return;
  const askId = body.kind === "answer" ? body.ask_id : card ?? null;
  setDelivery({id: null, state: "sending", reason: null, ask_id: askId});
  const perform = async () => {
   const result = await sendControl(fetcher, controlToken(status), body);
   setDelivery("error" in result ? {id: null, state: "failed", reason: result.error, ask_id: askId} : {id: result.id, state: result.state, reason: result.thread?.error ? `thread not recorded: ${result.thread.error}` : null, ask_id: askId});
   setGeneration(value => value + 1);
  };
  if (composer) requests.current = requests.current.then(perform);
  else void perform();
 };
 const start = (via: Launcher, resume = false) => {
  if (!canStart(status) || starting?.state === "starting") return;
  setStarting({state: "starting", reason: null, via});
  void startOperator(fetcher, status.inbox_token ?? "", via, resume).then(result => {
   if ("error" in result || result.state === "unavailable") setStarting({state: "failed", reason: "error" in result ? result.error : result.reason ?? "unavailable", via});
   else if (result.state === "already_running") setGeneration(value => value + 1);
  });
 };
 // Only while the running bridge takes attachments; never held offline.
 const upload = (controlImages(status) || controlFiles(status)) && controlReady(status) ? (file: File) => uploadImage(fetcher, controlToken(status), file) : undefined;
 const visible = composer ? reconcilePending(pending,status,entries).items : undefined;
 const retry = (key: string) => { const item=pending.items.find(item=>item.key === key && item.state === "failed"); if(item) enqueue(item.body,item.ask_id ?? undefined,key); };
 const discard = (key: string) => updatePending(value=>{const found=value.items.find(item=>item.key === key && item.state === "failed"); return found ? {...value,items:value.items.filter(item=>item !== found),dismissed:found.id ? [...value.dismissed,found.id] : value.dismissed} : value;});
 const cardDelivery = visible?.findLast(item=>item.ask_id !== null);
 return {status, delivery: cardDelivery ?? shown, send, ...(composer ? {pending:visible,pending_error:pending.error,retry,discard} : {}), starting, start, restarting, restart, ...(upload ? {upload} : {})};
}
