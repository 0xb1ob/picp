/** P21 units no dashboard entry point reaches; each test names the function and why (docs/testing-migration/p21.md). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appPage } from "../src/viewer/app-page.ts";
import { buildViewer } from "../src/viewer/build.ts";
import { LAYOUT } from "../src/contracts.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createScratchHome } from "./harness/index.ts";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { refreshStream, refreshStreams } from "../src/viewer/refresh-stream.ts";
import { createResource, POLL_MS, pollStream, type Stream } from "../viewer-app/resource.ts";
import { diffJson } from "../src/viewer/json-delta.ts";
import { bindHostRefusal, localAddresses, sameAddress, viewerHostCandidates } from "../src/viewer/bind-host.ts";

// `appPage` escaping: the build names its assets `main-<HASH>.js|css`, so no served page carries markup in a URL.
test("app asset URLs cannot break out of HTML attributes", () => {
	const page = appPage({ script: '/assets/viewer/a"<>&\'.js', stylesheet: '/assets/viewer/b"<>&\'.css', assets: {}, duration_ms: 0, bytes: 0 });
	assert.ok(page.includes('src="/assets/viewer/a&quot;&lt;&gt;&amp;&#39;.js"'));
	assert.ok(page.includes('href="/assets/viewer/b&quot;&lt;&gt;&amp;&#39;.css"'));
});

// `buildViewer`'s `packageRoot`: cp-view and scripts/build-viewer.ts always build from this package's own entry.
test("build refuses a missing package entry", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	await assert.rejects(buildViewer({ stateDir: join(home.path, "other"), packageRoot: home.path }));
});

// `buildViewer`'s 30 s deadline: only a mocked timer makes a real esbuild run outlast it.
test("the compilation deadline cancels and disposes without publishing a partial snapshot", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const schedule = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
		const timer = schedule(callback, ms);
		if (ms === 30_000) queueMicrotask(callback);
		return timer;
	});
	await assert.rejects(buildViewer({ stateDir: join(home.path, LAYOUT.state) }), /exceeded 30 seconds/);
	assert.deepEqual(readdirSync(join(home.path, LAYOUT.state, "viewer-dist")), []);
});

class Events extends EventTarget implements Stream { closed = false; close() { this.closed = true; } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// `createResource`: stale, stalled, failed and disposed states need a forged reply or a frozen clock.
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

// `pollStream` while hidden and on a 401: absence over time needs a mocked clock; the local listener never answers 401.
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

// `createResource`'s mismatched-base refetch and 401 base drop need a forged reply.
test("delta responses: the held version is sent as base, a delta is applied, a mismatch refetches full, a 401 drops the base", async () => {
 const calls: {headers?: Record<string,string>}[] = []; const replies: Response[] = [];
 const resource = createResource<{n:number; rows:{id:string; v:number}[]}>("/api/jobs", "/api/stream?view=jobs", {
  fetch: (_url, init) => { calls.push({...(init.headers ? {headers:init.headers} : {})}); return Promise.resolve(replies.shift() ?? new Response("{}", {status:503})); },
  stream: () => new Events(),
 });
 const full = {n:1, rows:[{id:"a",v:1},{id:"b",v:1}]}, next = {n:2, rows:[{id:"a",v:1},{id:"b",v:2}]};
 replies.push(new Response(JSON.stringify(full), {headers:{"x-cp-version":"n-1"}}));
 resource.setVisible(true); await tick();
 assert.equal(calls[0]!.headers, undefined, "the first GET has no base");
 replies.push(new Response(JSON.stringify(diffJson(full, next)), {headers:{"x-cp-version":"n-2","x-cp-delta-base":"n-1"}}));
 resource.setVisible(false); resource.setVisible(true); await tick();
 assert.equal(calls[1]!.headers?.["x-cp-delta-base"], "n-1", "the version survives a hide/show");
 assert.deepEqual(resource.snapshot().data, next);
 // A delta naming another base must not publish; exactly one full refetch follows, without a base header.
 const after = {n:3, rows:[]};
 replies.push(new Response('{"v":{"n":99,"rows":[]}}', {headers:{"x-cp-version":"n-9","x-cp-delta-base":"n-8"}}), new Response(JSON.stringify(after), {headers:{"x-cp-version":"n-3"}}));
 resource.setVisible(false); resource.setVisible(true); await tick(); await tick();
 assert.equal(calls.length, 4); assert.equal(calls[2]!.headers?.["x-cp-delta-base"], "n-2"); assert.equal(calls[3]!.headers, undefined);
 assert.deepEqual(resource.snapshot().data, after);
 replies.push(new Response("{}", {status:401}));
 resource.setVisible(false); resource.setVisible(true); await tick();
 assert.equal(calls[4]!.headers?.["x-cp-delta-base"], "n-3"); assert.equal(resource.snapshot().data, null, "a 401 drops data");
 replies.push(new Response(JSON.stringify(full), {headers:{"x-cp-version":"n-4"}}));
 resource.setVisible(false); resource.setVisible(true); await tick();
 assert.equal(calls[5]!.headers, undefined, "after a 401 the next request carries no base");
 resource.dispose();
});

// `refreshStream` backpressure: a 25-byte tick never fills a real socket buffer.
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

// `bindHostRefusal` accepts: an accepted host binds, which this runner cannot do for a tailnet, LAN or ULA address.
test("bindHostRefusal: overlay, private, ULA and loopback pass; wildcard, public, link-local, mapped, zoned and non-IP are refused", () => {
	for (const ok of ["100.70.1.2", "10.0.0.5", "172.16.0.1", "192.168.1.5", "127.0.0.1", "::1", "fd7a:115c:a1e0::1"]) assert.equal(bindHostRefusal(ok), undefined, ok);
	const refused: Record<string, RegExp> = {
		"0.0.0.0": /wildcard/, "::": /wildcard/, "0:0:0:0:0:0:0:0": /wildcard/,
		"8.8.8.8": /public/, "2001:4860::8888": /public/, "224.0.0.1": /public or non-unicast/, "255.255.255.255": /non-unicast/,
		"fe80::1": /link-local/, "169.254.1.1": /link-local/, "fe80::1%eth0": /zone id/,
		"::ffff:10.0.0.1": /IPv4-mapped/, "0:0:0:0:0:ffff:a00:1": /IPv4-mapped/,
		localhost: /not an IP/, "": /not an IP/,
	};
	for (const [address, reason] of Object.entries(refused)) assert.match(bindHostRefusal(address) ?? "", reason, address);
});

// `viewerHostCandidates`/`sameAddress`: cp-install reads the real interfaces, so no entry point controls them.
const info = (address: string) => ({ address, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "", internal: false, cidr: null }) as never;

test("candidates: Tailscale (recommended) > private > loopback; a Tailscale address no interface carries is dropped", () => {
	const locals = localAddresses({ lo: [info("127.0.0.1"), info("::1")], enp3s0: [info("192.168.1.5"), info("fe80::1")], tailscale0: [info("100.80.0.1")], cgnat: [info("100.99.0.9")] });
	assert.ok(!locals.some((local) => local.address === "fe80::1"), "link-local drops out");
	const all = viewerHostCandidates(locals, "100.80.0.1");
	assert.deepEqual(all.map((c) => [c.address, c.source, c.recommended]), [
		["100.80.0.1", "tailscale", true], ["192.168.1.5", "private", false], ["100.99.0.9", "private", false], ["127.0.0.1", "loopback", false], ["::1", "loopback", false],
	]);
	assert.match(all.find((c) => c.address === "100.99.0.9")!.why, /shared address space/);
	assert.ok(!viewerHostCandidates(locals, undefined).some((c) => c.recommended), "no Tailscale, nothing recommended");
	const ghost = viewerHostCandidates(locals, "100.64.0.1");
	assert.ok(!ghost.some((c) => c.recommended || c.address === "100.64.0.1"), "tool output only labels an interface address");
	assert.deepEqual(viewerHostCandidates([], "100.80.0.1"), []);
});

test("sameAddress: IPv6 by value, IPv4 by string", () => {
	assert.ok(sameAddress("FD7A:115C:A1E0:0:0:0:0:1", "fd7a:115c:a1e0::1"));
	assert.ok(!sameAddress("fd7a:115c:a1e0::1", "fd7a:115c:a1e0::2"));
	assert.ok(sameAddress("10.0.0.1", "10.0.0.1"));
	assert.ok(!sameAddress("10.0.0.1", "::ffff:10.0.0.1"));
	assert.ok(!sameAddress("x", "x"));
});
