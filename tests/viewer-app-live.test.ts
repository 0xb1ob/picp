import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { refreshStream, refreshStreams } from "../src/viewer/refresh-stream.ts";
import { createResource, POLL_MS, pollStream, type Stream } from "../viewer-app/resource.ts";

class Events extends EventTarget implements Stream { closed = false; close() { this.closed = true; } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("refreshes coalesce, failed GETs preserve stale data, hidden requests cannot publish", async t => {
 t.mock.timers.enable({apis:["setTimeout"]});
 const streams: Events[] = []; const pending: {resolve(v: Response): void; signal: AbortSignal}[] = [];
 const resource = createResource<{n:number}>("/api/overview", "/api/stream?view=overview", {
  fetch: (_url, init) => new Promise(resolve => pending.push({resolve, signal:init.signal})),
  stream: () => { const s = new Events(); streams.push(s); return s; },
 });
 resource.setVisible(true); assert.equal(pending.length, 1);
 const stream = streams[0]!; stream.dispatchEvent(new Event("open"));
 for (let i=0;i<10;i++) stream.dispatchEvent(new Event("refresh"));
 assert.equal(pending.length, 1);
 pending[0]!.resolve(new Response('{"n":1}')); await tick();
 assert.equal(pending.length, 2); assert.equal(resource.snapshot().data?.n, 1);
 pending[1]!.resolve(new Response("failure", {status:503})); await tick();
 assert.equal(resource.snapshot().status, "stale"); assert.equal(resource.snapshot().data?.n, 1);
 stream.dispatchEvent(new Event("refresh")); resource.setVisible(false);
 assert.equal(pending[2]!.signal.aborted, true); assert.equal(stream.closed, true);
 pending[2]!.resolve(new Response('{"n":99}')); await tick(); assert.equal(resource.snapshot().data?.n, 1);
 resource.setVisible(true); streams[1]!.dispatchEvent(new Event("open"));
 pending[3]!.resolve(new Response('{"n":2}')); await tick();
 assert.equal(resource.snapshot().status, "live");
 t.mock.timers.tick(5001); assert.equal(resource.snapshot().status,"stale","a stalled GET must not leave an old success live forever");
 streams[1]!.dispatchEvent(new Event("error")); assert.equal(resource.snapshot().status, "stale");
 resource.dispose(); assert.equal(streams[1]!.closed, true);
});

test("quick-mode pollStream: a two-second refresh clock while visible, no requests while hidden, cleared on dispose", async t => {
 t.mock.timers.enable({apis:["setTimeout","setInterval"]});
 let gets = 0, status = 200;
 const resource = createResource<{n:number}>("/api/overview", "/api/stream?view=overview", {fetch: () => (gets++, Promise.resolve(new Response(`{"n":${gets}}`, {status}))), stream: pollStream});
 resource.setVisible(true); await tick(); assert.equal(gets, 1);
 t.mock.timers.tick(0); await tick(); assert.equal(gets, 2, "the poll clock opens like a stream: one refresh");
 assert.equal(resource.snapshot().status, "live");
 t.mock.timers.tick(POLL_MS); await tick(); assert.equal(gets, 3);
 resource.setVisible(false); t.mock.timers.tick(POLL_MS * 5); await tick(); assert.equal(gets, 3, "a hidden tab never polls");
 resource.setVisible(true); t.mock.timers.tick(0); await tick(); assert.equal(gets, 5);
 t.mock.timers.tick(POLL_MS); await tick(); assert.equal(gets, 6);
 status = 503; t.mock.timers.tick(POLL_MS); await tick(); assert.equal(resource.snapshot().data?.n, 6, "a failed poll keeps stale data");
 status = 401; t.mock.timers.tick(POLL_MS); await tick(); assert.equal(resource.snapshot().data, null, "a revoked device's 401 drops the protected data");
 resource.dispose(); t.mock.timers.tick(POLL_MS * 5); await tick(); assert.equal(gets, 8);
});

test("view SSE emits immediately without a transcript, respects backpressure, and clears its clock once", t => {
 t.mock.timers.enable({apis:["setInterval"]});
 const req = Object.assign(new EventEmitter(),{method:"GET"});
 const chunks: string[] = []; let accepts = false;
 const res = Object.assign(new EventEmitter(),{writeHead:() => {},write:(chunk:string) => {chunks.push(chunk);return accepts;},end:() => {}});
 refreshStream(req as IncomingMessage,res as unknown as ServerResponse);
 assert.equal(refreshStreams(),1); assert.match(chunks[0]!,/retry: 2000\n\nevent: refresh\ndata: \{\}/); assert.doesNotMatch(chunks.join(""),/id:/);
 t.mock.timers.tick(6000); assert.equal(chunks.length,1);
 accepts = true; res.emit("drain"); t.mock.timers.tick(2000); assert.equal(chunks.length,2);
 req.emit("close"); res.emit("error",new Error("closed"));
 assert.equal(refreshStreams(),0); t.mock.timers.tick(6000);assert.equal(chunks.length,2);
});
