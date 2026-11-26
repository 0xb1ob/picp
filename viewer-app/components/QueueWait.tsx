import { useEffect, useRef, useState } from "preact/hooks";
import { QUEUED_AT_LABELS, type QueueWait, type QueueWaited } from "../../src/viewer/api-types.ts";
import { elapsed, observedTime } from "../format.ts";

/** Server-measured seconds plus the client's own seconds since that value arrived: it ticks with no clock skew. */
function useLive(seconds: number, key: string): number {
 const since = useRef({key, at: Date.now()});
 if (since.current.key !== key) since.current = {key, at: Date.now()};
 const [, tick] = useState(0);
 useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 15_000); return () => clearInterval(timer); }, []);
 return seconds + Math.max(0, Math.floor((Date.now() - since.current.at) / 1000));
}

const queuedText = (at: string, source: QueueWait["queued_at_source"]) =>
 `queued ${observedTime(at)} (${QUEUED_AT_LABELS[source]})`;

/** The live wait of a queued or waiting job, the one figure that ticks on the page. */
export function WaitingFor({wait}: {wait: QueueWait}) {
 const seconds = useLive(wait.waiting_seconds, `${wait.queued_at}|${wait.waiting_seconds}`);
 const title = queuedText(wait.queued_at, wait.queued_at_source);
 return <span class="job-meta job-wait-time" title={title}>waiting {elapsed(seconds)}</span>;
}

/** Why it waits, from the server, then when it was queued and which stamp that is; `timed` leads with the wait. */
export function WaitReason({wait, timed = false}: {wait: QueueWait; timed?: boolean}) {
 const line = `${wait.reason} · ${queuedText(wait.queued_at, wait.queued_at_source)}`;
 return <span class="job-note job-wait-reason" title={line}>{timed && <><WaitingFor wait={wait}/> · </>}{line}</span>;
}

type Waits = {wait?: QueueWait | null | undefined; waited?: QueueWaited | null | undefined};
/** Job detail: the whole wait, or how long a started job waited when its park stamp was recorded. */
export function WaitDetail({wait, waited}: Waits) {
 if (wait) {
  const queued = queuedText(wait.queued_at, wait.queued_at_source);
  return <p class="job-wait-detail"><WaitingFor wait={wait}/> · {wait.reason} · {queued}</p>;
 }
 if (!waited) return null;
 const queued = queuedText(waited.queued_at, waited.queued_at_source);
 return <p class="job-wait-detail">waited {elapsed(waited.seconds)} before dispatch · {queued}</p>;
}
