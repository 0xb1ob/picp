import { useEffect, useState } from "preact/hooks";
import { type AnswersControlStatus, type AnswersControlView, answersControlReady, readAnswersControl, sendAnswerAck } from "./answers-control.ts";

/** The Answers section's tick (cp-mxk4): reads `/api/answers/control` on mount, on every refresh and after each send; one ack at a time. */
export function useAnswersControl(active: boolean, refreshKey: string | null, fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): AnswersControlView | undefined {
 const [status, setStatus] = useState<AnswersControlStatus | null>(null);
 const [sending, setSending] = useState<string | null>(null);
 const [failed, setFailed] = useState<AnswersControlView["failed"]>(null);
 const [acked, setAcked] = useState<readonly string[]>([]);
 const [generation, setGeneration] = useState(0);
 useEffect(() => {
  if (!active) return;
  const controller = new AbortController();
  void readAnswersControl(fetcher, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); });
  return () => controller.abort();
 }, [active, refreshKey, generation]);
 if (!active) return undefined;
 const ack = (id: string) => {
  if (!answersControlReady(status) || sending) return;
  setSending(id);
  setFailed(null);
  void sendAnswerAck(fetcher, status.token ?? "", id).then(result => {
   if ("error" in result) setFailed({id, reason: result.error});
   else setAcked(ids => [...ids, id]);
   setSending(null);
   setGeneration(value => value + 1);
  });
 };
 return {status, sending, failed, acked, ack};
}
