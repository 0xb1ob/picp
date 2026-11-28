import type { IncomingMessage, ServerResponse } from "node:http";
import { HEARTBEAT_MS, type ViewName } from "./view-sources.ts";
let active = 0;
export const refreshStreams = (): number => active;
/** Calls `onChange` with the changed views among `views` until the returned stop runs (view-sources.ts `subscribe`). */
export type ChangeFeed = (views: readonly ViewName[], onChange: (changed: readonly ViewName[]) => void) => () => void;
const frame = (views: readonly ViewName[]) => `event: refresh\ndata: ${JSON.stringify({ views })}\n\n`;
/**
 * A read-only change stream: on open one `refresh` naming every view in `views`, then one per change naming only the
 * changed ones; a client that stops reading gets the merged set once on drain. At idle only `: hb` comments flow.
 */
export function refreshStream(req: IncomingMessage, res: ServerResponse, views: readonly ViewName[], feed: ChangeFeed, stillValid?: () => boolean): void {
 res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
 if (req.method === "HEAD") { res.end(); return; }
 let ready = res.write(`retry: 2000\n\n${frame(views)}`);
 const pending = new Set<ViewName>();
 let closed = false;
 const flush = () => {
  if (closed || !ready || pending.size === 0) return;
  const changed = views.filter((view) => pending.has(view));
  pending.clear(); ready = res.write(frame(changed));
 };
 const drain = () => { ready = true; flush(); };
 let unsubscribe = () => {}, heartbeat: ReturnType<typeof setInterval> | undefined, validity: ReturnType<typeof setInterval> | undefined;
 const stop = () => {
  if (closed) return;
  closed = true; active--; clearInterval(heartbeat); clearInterval(validity); unsubscribe();
  res.off("drain", drain); req.off("close", stop);
  // A response can emit an error after close; stop remains an idempotent sink.
 };
 active++;
 req.on("close", stop); res.on("error", stop); res.on("drain", drain);
 // A throwing first source read ends this stream; the client's EventSource retries after `retry`.
 try { unsubscribe = feed(views, (changed) => { for (const view of changed) pending.add(view); flush(); }); } catch { stop(); res.end(); return; }
 heartbeat = setInterval(() => { if (ready) ready = res.write(": hb\n\n"); }, HEARTBEAT_MS);
 // A remote session is re-checked on its own clock whether or not the client keeps up: a revoke closes it within 2 s.
 validity = stillValid ? setInterval(() => { if (!stillValid()) { stop(); res.destroy(); } }, 2000) : undefined;
}
