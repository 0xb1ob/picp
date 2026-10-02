import type { IncomingMessage, ServerResponse } from "node:http";
let active = 0;
export const refreshStreams = (): number => active;
/** A read-only refresh clock, not a claim that operational files changed. */
export function refreshStream(req: IncomingMessage, res: ServerResponse): void {
 res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
 if (req.method === "HEAD") { res.end(); return; }
 let ready = res.write("retry: 2000\n\nevent: refresh\ndata: {}\n\n");
 const drain = () => { ready = true; };
 res.on("drain", drain);
 const timer = setInterval(() => { if (ready) ready = res.write("event: refresh\ndata: {}\n\n"); }, 2000);
 active++;
 let closed = false;
 const stop = () => {
  if (closed) return;
  closed = true; active--; clearInterval(timer);
  res.off("drain", drain); req.off("close", stop);
  // A response can emit an error after close; stop remains an idempotent sink.
 };
 req.on("close", stop); res.on("error", stop);
}
