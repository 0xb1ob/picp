/** P21 units no dashboard entry point reaches; each test names the function and why (docs/testing-migration/p21.md). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appPage } from "../src/viewer/app-page.ts";
import { buildViewer } from "../src/viewer/build.ts";
import { LAYOUT } from "../src/contracts.ts";
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createScratchHome } from "./harness/index.ts";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { refreshStream, refreshStreams } from "../src/viewer/refresh-stream.ts";
import { createResource, POLL_MS, pollStream, type Stream } from "../viewer-app/resource.ts";
import { applyDelta, diffJson } from "../src/viewer/json-delta.ts";
import { readObject } from "../src/viewer/sessions.ts";
import { routingEvents } from "../src/viewer/overview-health.ts";
import { readLines, startOffset } from "../src/viewer/tail.ts";
import { hostAllowed } from "../src/viewer/server.ts";
import { build } from "esbuild";
import { overview } from "../src/viewer/overview-view.ts";
import { REPO_ROOT } from "./harness/index.ts";
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


// `diffJson`/`applyDelta` codec matrix: key order, __proto__, scalars and duplicate ids no screen view emits;
// the throws guard a forged or mismatched delta the server never sends. P21-delta covers the served round trip.
const rows = Array.from({ length: 700 }, (_, i) => ({ id: `cp-${i}`, title: `job ${i} ${"long text ".repeat(5)}`, cost: i }));
const oneChanged = rows.map((r) => (r.id === "cp-7" ? { ...r, cost: 9999 } : r));
const PAIRS: Array<[string, unknown, unknown]> = [
	["identical", { a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }],
	["700 rows, 1 changed", { rows }, { rows: oneChanged }],
	["700 rows, 1 added at the front", { rows }, { rows: [{ id: "cp-new", title: "new", cost: 0 }, ...rows] }],
	["700 rows, 1 removed", { rows }, { rows: rows.filter((r) => r.id !== "cp-300") }],
	["700 rows, reordered", { rows }, { rows: [...rows].reverse() }],
	["job_id-keyed rows", [{ job_id: "a", n: 1 }, { job_id: "b", n: 2 }], [{ job_id: "b", n: 3 }, { job_id: "c", n: 1 }]],
	["duplicate ids", [{ id: "a", n: 1 }, { id: "a", n: 2 }], [{ id: "a", n: 1 }, { id: "a", n: 3 }]],
	["arrays of primitives", { xs: [1, 2, 3] }, { xs: [1, 3, 2, 4] }],
	["nested key add and delete", { o: { keep: 1, gone: 2, deep: { x: 1 } } }, { o: { keep: 1, deep: { x: 2, y: [] }, added: "z" } }],
	["key order change", { a: 1, b: 2 }, { b: 2, a: 1 }],
	["null to object", { x: null }, { x: { y: 1 } }],
	["object to null", { x: { y: 1 } }, { x: null }],
	["integer-like and __proto__ keys", JSON.parse('{"b":1,"2":0}'), JSON.parse('{"b":2,"2":0,"1":5,"__proto__":{"p":1}}')],
	["top-level scalar", 1, "one"],
];

test("applyDelta(a, diffJson(a, b)) serializes byte-identical to b, key order included", () => {
	for (const [name, a, b] of PAIRS) {
		const before = JSON.stringify(a);
		assert.equal(JSON.stringify(applyDelta(a, diffJson(a, b) ?? {})), JSON.stringify(b), name);
		assert.equal(JSON.stringify(a), before, `${name}: the base is never mutated`);
	}
	assert.equal(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), undefined);
	assert.deepEqual(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 }), { v: { b: 2, a: 1 } }, "a key-order change is a whole value");
	assert.deepEqual(diffJson([{ id: "a" }, { id: "a" }], [{ id: "a", n: 1 }]), { v: [{ id: "a", n: 1 }] }, "duplicate ids are not keyed");
	const small = JSON.stringify(diffJson({ rows }, { rows: oneChanged }));
	assert.ok(small.length < 2048, `a 1-row change must stay small, got ${small.length}`);
});

test("applyDelta throws on a delta that does not fit its base", () => {
	assert.throws(() => applyDelta([{ id: "a" }], { key: "id", put: [{ id: "b" }] }), /unknown key in put/);
	assert.throws(() => applyDelta([{ id: "a" }], { key: "id", put: [], ids: ["a", "zz"] }), /unknown id/);
	assert.throws(() => applyDelta(5, { sub: { x: { v: 1 } } }), /non-object/);
	assert.throws(() => applyDelta({}, { sub: { x: { v: 1 } } }), /sub on missing key/);
	assert.throws(() => applyDelta({ a: 1 }, { key: "id", put: [] }), /malformed array delta/);
});

// The source caches' identity (a parse-once hit, a cached event list) is process-local; P21-performance and
// P21-cache-fresh pin what a screen shows. Same-mtime replacement needs utimes on the file under the cache.
test("JSON source cache reuses unchanged reads and invalidates edits, replacement, deletion and corruption",t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const file=join(home.path,"source.json");
 writeFileSync(file,'{"value":1}');const first=readObject(file);
 assert.equal(readObject(file),first,"unchanged JSON is parsed only once");
 const time=statSync(file).mtime;
 writeFileSync(file,'{"value":2}');utimesSync(file,time,time);
 assert.equal(readObject(file)?.value,2);
 writeFileSync(`${file}.new`,'{"value":3}');utimesSync(`${file}.new`,time,time);renameSync(`${file}.new`,file);
 assert.equal(readObject(file)?.value,3);
 writeFileSync(file,"{bad");assert.equal(readObject(file),undefined);
 rmSync(file);assert.equal(readObject(file),undefined);
 writeFileSync(file,'{"value":4}');assert.equal(readObject(file)?.value,4);
});

test("routingEvents: an unchanged log is a cache hit and an append is read", (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state), log = join(stateDir, "runs", "cp-a", "events.jsonl");
	const event = (mandate: string) => `${JSON.stringify({ source: "cp", type: "routing_resolved", ts: "2026-09-26T12:00:00Z", payload: { mandate_id: mandate } })}\n`;
	mkdirSync(dirname(log), { recursive: true });
	writeFileSync(log, event("md-first"));
	const first = routingEvents({ home: home.path, stateDir }, "cp-a")[0];
	assert.equal(routingEvents({ home: home.path, stateDir }, "cp-a")[0], first, "unchanged events hit the cache");
	writeFileSync(log, event("md-first") + event("md-next"));
	assert.equal(routingEvents({ home: home.path, stateDir }, "cp-a").length, 2);
});

/** A scratch directory removed after the test. */
function scratch(t: { after(fn: () => void): void }): string {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return home.path;
}

// `readLines`/`startOffset`: byte-offset ids never leave the server, and no caller passes a Last-Event-ID.
test("tail: complete lines only, ids are byte offsets past each newline, partial line waits", (t) => {
	const file = join(scratch(t), "s.jsonl");
	writeFileSync(file, '{"a":1}\n{"b":"é"}\n{"c":');
	const first = readLines(file, 0);
	assert.deepEqual(
		first.lines.map((line) => line.text),
		['{"a":1}', '{"b":"é"}'],
	);
	assert.equal(first.lines[0]?.id, 8);
	assert.equal(first.lines[1]?.id, 8 + Buffer.byteLength('{"b":"é"}\n'));
	assert.equal(first.offset, first.lines[1]?.id, "the partial line is not consumed");

	appendFileSync(file, "3}\n");
	const second = readLines(file, first.offset);
	assert.deepEqual(
		second.lines.map((line) => line.text),
		['{"c":3}'],
	);
	assert.equal(readLines(file, second.offset).lines.length, 0);
});

test("tail: a file that shrank below the offset restarts at 0 and says reset", (t) => {
	const file = join(scratch(t), "s.jsonl");
	writeFileSync(file, "x\n");
	const chunk = readLines(file, 500);
	assert.equal(chunk.reset, true);
	assert.deepEqual(
		chunk.lines.map((line) => line.text),
		["x"],
	);
	assert.deepEqual(readLines(join(scratch(t), "missing.jsonl"), 0), { lines: [], offset: 0, reset: false });
});

test("resume: Last-Event-ID on a line boundary resumes there; garbage, mid-line or past-end does not", (t) => {
	const file = join(scratch(t), "s.jsonl");
	writeFileSync(file, "aaaa\nbbbb\ncccc\n");
	assert.deepEqual(startOffset(file, "5"), { offset: 5, reset: false });
	assert.deepEqual(startOffset(file, "0"), { offset: 0, reset: false });
	// A supplied id that is rejected starts over AND says reset, so the client clears.
	assert.deepEqual(startOffset(file, "7"), { offset: 0, reset: true }, "mid-line id is not a resume point");
	assert.deepEqual(startOffset(file, "9999"), { offset: 0, reset: true }, "past EOF: rotated or replaced");
	assert.deepEqual(startOffset(file, "-1"), { offset: 0, reset: true });
	assert.deepEqual(startOffset(file, "5; drop"), { offset: 0, reset: true });
	assert.deepEqual(startOffset(file, undefined), { offset: 0, reset: false }, "a fresh connection is not a reset");
	assert.deepEqual(startOffset(file, ""), { offset: 0, reset: false });
	assert.deepEqual(startOffset(join(scratch(t), "gone.jsonl"), "5"), { offset: 0, reset: true });
	// Resuming at the id of line 1 yields exactly the lines after it.
	assert.deepEqual(
		readLines(file, startOffset(file, "5").offset).lines.map((line) => line.text),
		["bbbb", "cccc"],
	);
	// A fresh connection on a big file starts at a line boundary inside the backlog.
	assert.deepEqual(startOffset(file, undefined, 7), { offset: 10, reset: false });
	assert.deepEqual(startOffset(file, "7", 7), { offset: 10, reset: true });
});

// `hostAllowed` for a bracketed IPv6 and a bare name: binding [::1] or a non-IP host is unknown on the CI runner.
test("host bind: a bracketed IPv6 and a bare host name match exactly", () => {
	assert.equal(hostAllowed("[::1]:8766", "::1", 8766), true);
	assert.equal(hostAllowed("box", "box", 80), true);
});

// `Overview` SSR from hand-set quota, mandate, parent-lock, operator-question, main-CI latch and blocked shapes owned by
// other subsystems; P21-render-* pin the served Overview. `time`/`clock` read the process zone a shared tab can't switch.
test("times format in the browser's own zone, never a server zone", async t => {
 const {time,observedTime,clock} = await import("../viewer-app/format.ts");
 const zone = process.env.TZ; t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
 const at = "2026-09-26T05:41:07Z";
 process.env.TZ = "Asia/Bangkok";
 assert.equal(time(at),"12:41"); assert.equal(time(at,true),"12:41:07"); assert.match(observedTime(at),/26 Sept? 2026, 12:41/);
 assert.match(clock(new Date(at)),/^12:41 \S+/);
 process.env.TZ = "America/Los_Angeles";
 assert.equal(time(at),"22:41"); assert.match(clock(new Date(at)),/^22:41 \S+/);
});

test("Overview is executive: health strip, awaiting, blocked, in flight and shipped, with escaped text", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; import {More} from "./viewer-app/screens/More.tsx"; export const screen=(data,more=false)=>render(h(more?More:Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const data = overview({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 const empty = screen(data);
 assert.match(empty, /Nothing needs you/); assert.match(empty, /parent<\/span><strong title="down">down/); assert.doesNotMatch(empty, /quota|not observed/, "no quota chip while quota is null");
 assert.match(empty, /0 live \/ - slots/); assert.match(empty, /Nothing in flight/); assert.match(empty, /Landed today · 0 merged</); assert.doesNotMatch(empty, /Shipped today|closed without PR/);
 assert.doesNotMatch(empty, /Blocked|Decided for you|being handled|Fleet health|Mandates|UTC|\/classic/);
 assert.match(empty, /operator<\/span><strong title="offline">offline</); assert.match(empty, /overview-dot-idle"><\/span>main CI<\/span><strong title="no red latch">no red latch</, "no latch is neutral, not a green dot"); assert.doesNotMatch(empty, /main CI<\/span><strong[^>]*>green/, "no latch is never claimed green");
 const more = screen(data,true); assert.doesNotMatch(more,/aria-disabled="true"|#mandates/);
 // Audit P4 #25: More holds Schedules, Files (and Reports, phone only) and Notifications; Board and Map are Jobs views.
 for (const screen of ["stats","reports","schedules","files"]) assert.ok(more.includes(`href="#${screen}"`),screen);
 assert.match(more,/class="more-phone" href="#stats"|href="#stats" class="more-phone"/);
 for (const screen of ["awaiting","decided","board","map"]) assert.ok(!more.includes(`href="#${screen}"`),screen);
 assert.match(more,/class="more-phone" href="#reports"|href="#reports" class="more-phone"/);
 assert.match(more,/class="more-phone" href="#settings"|href="#settings" class="more-phone"/);
 data.availability.asks = "unavailable"; data.awaiting.count = null;
 assert.doesNotMatch(screen(data),/Nothing needs you/); assert.match(screen(data),/Questions unavailable/);
 data.availability.asks = "ok"; data.awaiting.count = 4;
 data.awaiting.items = ["ask-ab","ask-cd","ask-ef","ask-gh"].map(id => ({id,project:"demo",question:'<script>bad()</script>' + "long".repeat(100),created_at:data.generated_at,options:[{label:"Keep",consequence:"Paused",reply:`${id}: Keep`}],recommendation:"Keep",source_escalation:null,job_ids:[],context:null,evidence_paths:[]}));
 data.in_flight = [{id:"cp-render",project:"demo",title:"Long title ".repeat(30),phase:"held",model:"recorded-model",script_path:null,elapsed_seconds:400,limit_seconds:100,head:"a".repeat(40),ci:"failed",review:"revise",review_attempts:2,routing:"scope:M",note:null,pr_url:"https://github.com/acme/repo/pull/7"}];
 data.blocked.items = [{id:"cp-wait",title:"Blocked title",blockers:[{id:"cp-render",phase:"held",grant_status:"paused",mandate_id:"md-a",stranded:true}]}];
 data.shipped_today = [{id:"cp-merged",title:"Merged title",merged_at:data.generated_at,merge_sha:"b".repeat(40),pr_url:"https://github.com/acme/repo/pull/1",cost_usd:1.5}]; data.closed_today = 4;
 data.quota = {observed_at:data.generated_at,source_job_id:"cp-render",historical:true,providers:[{provider:"anthropic",five_hour:50,seven_day:90,tight:true,free_slots:2},{provider:"openai",five_hour:5,seven_day:9,tight:false,free_slots:4}]};
 data.fleet.parent.pid = 4242; data.fleet.parent.alive = true; data.fleet.workers.live = 1;
 data.mandates.items = [{id:"md-a",status:"active",projects:["demo"],objective:"o",expiry:data.generated_at,pause_reason:null,ask_on:[],spend_cap:{usd:1,tokens:1},job_cap:1,dispatch_parallelism:3,spend:null}];
 data.mandates.paused_projects = ["other"];
 const html = screen(data);
 assert.match(html,/Needs you · 4/); assert.doesNotMatch(html,/Awaiting you/,"audit P3 #22: Needs you on the Overview"); assert.equal((html.match(/href="#awaiting" class="overview-line"/g) ?? []).length,3,"at most three awaiting lines");
 assert.match(html,/&lt;script>/); assert.doesNotMatch(html,/<script>|style=|onclick=/i); assert.doesNotMatch(html,/Keep|Nothing needs you/);
 assert.match(html,/parent<\/span><strong title="alive">alive/); assert.match(html,/1 live \/ 3 slots/); assert.match(html,/tight: anthropic</);
 assert.match(html,/Blocked &amp; failed · 1/); assert.match(html,/href="#job\/cp-wait"/); assert.match(html,/Blocked title/); assert.match(html,/blocked by .*cp-render.*paused/);
 assert.match(html,/href="#job\/cp-render"/); assert.match(html,/href="https:\/\/github.com\/acme\/repo\/pull\/7"[^>]*>#7</); assert.ok(html.includes(`title="${data.in_flight[0]!.title}"`));
 assert.match(html,/Landed today · 1 merged · 4 closed without PR · <span title="merged jobs only, worker plus reviewer">\$1\.50/); assert.match(html,/#1 ↗<\/a><span class="overview-meta overview-merge" title="b{40}"><span class="overview-merge-word">merged <\/span><code>bbbbbbb<\/code>/);
 assert.match(html,/CI red</,"audit P3 #21: a held row says why it is held"); assert.doesNotMatch(html,/overview-project/,"one project: no tag");
 assert.match(html,/other · paused/);
 data.availability.fleet = "unavailable"; assert.match(screen(data),/Jobs unavailable/); assert.match(screen(data,true),/- live worktrees/);
 // A pid a crashed parent left behind is down, and the chip says when the lock went stale (cp-hvbj).
 data.fleet.parent.alive = false; data.fleet.parent.stale_since = "2026-09-26T05:41:07Z";
 assert.match(screen(data), /parent<\/span><strong title="down \(stale lock since [^"]+\)">down \(stale lock since/);
});

test("audit P3: Blocked & failed, the operator and main CI chips, project tags, held facts and a capped Landed today", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const screen=(data)=>render(h(Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const data = overview({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 const flight = {title:"t",model:null,script_path:null,elapsed_seconds:1,limit_seconds:null,head:"a".repeat(40),review:null,review_attempts:0,routing:null,note:null};
 data.failed = [{id:"cp-dead",project:"demo",title:"Died title",failure:"provider 503: overloaded"}];
 data.in_flight = [{...flight,id:"cp-ci",project:"demo",phase:"held",ci:"in_progress"}, {...flight,id:"cp-rev",project:"other",phase:"held",ci:"unknown",review:"pass",review_attempts:1}, {...flight,id:"cp-w",project:"other",phase:"working",ci:null}];
 data.shipped_today = Array.from({length:7},(_,i) => ({id:`cp-m${i}`,title:`M${i}`,merged_at:data.generated_at,merge_sha:"b".repeat(40),pr_url:`https://github.com/acme/repo/pull/${i}`,cost_usd:i === 6 ? null : 1}));
 data.fleet.operator = {running:true,pid:7,since:null,held:0};
 data.parent_questions = [{id:"es-a",question:"q",kind:"mission_end",created_at:data.generated_at,job_ids:[],age_seconds:599}];
 assert.match(screen(data),/operator<\/span><strong title="running">running</,"under 10 minutes the chip stays plain");
 data.parent_questions.push({id:"es-b",question:"q",kind:"mission_end",created_at:data.generated_at,job_ids:[],age_seconds:3470});
 data.main_ci = {availability:"ok",red:[{project:"demo",red_since_sha:"c".repeat(40),red_since_at:"2026-09-26T05:41:07Z",workflow:"ci",failing:"AssertionError: x"}]};
 const html = screen(data);
 assert.match(html,/Blocked &amp; failed · 1/); assert.match(html,/href="#job\/cp-dead"/); assert.match(html,/Died title/); assert.match(html,/overview-failed">failed<\/span> · <span title="provider 503: overloaded">provider 503: overloaded/);
 assert.match(html,/href="#decided" class="overview-chip"><span class="overview-meta"><span class="overview-dot overview-dot-tight"><\/span>operator<\/span><strong title="running · 2 unanswered, oldest 57m">/,"amber once one question waited 10 minutes");
 assert.match(html,/overview-dot-ci-red"><\/span>main CI<\/span><strong title="red since ccccccc [^\n"]+\ndemo: AssertionError: x on c{40}">red since ccccccc /);
 assert.equal((html.match(/class="overview-project"/g) ?? []).length,3,"two projects in flight: every row tagged");
 assert.match(html,/CI running</); assert.match(html,/review 1\/5 pass</); assert.match(html,/overview-dot-working/); assert.match(html,/0m \/ -</);
 assert.match(html,/Landed today · 7 merged · <span title="[^"]+">\$6\.00/,"total over every merged row with a known cost");
 assert.equal((html.match(/class="overview-landed-pr"/g) ?? []).length,5,"five landed rows");
 assert.match(html,/href="#jobs" class="overview-more">2 more merged in Jobs →</);
 data.main_ci = {availability:"ok",red:[...data.main_ci.red,{project:"beta",red_since_sha:"d".repeat(7),red_since_at:"2026-09-26T05:41:07Z",workflow:null,failing:null}]};
 assert.match(screen(data),/<strong title="demo red since ccccccc [^,]+, beta red since ddddddd /,"per project once more than one is red");
 data.main_ci = {availability:"unavailable",red:[]}; assert.match(screen(data),/main CI<\/span><strong title="unreadable">unreadable</);
 data.fleet.operator = {running:false,pid:null,since:null,held:2}; assert.match(screen(data),/overview-dot-down"><\/span>operator<\/span><strong title="offline · 2 unanswered, oldest 57m · 2 held">/);
});

test("stamp, shortSha, prNumber and phaseText", async t => {
 const {stamp, shortSha, prNumber, phaseText} = await import("../viewer-app/format.ts");
 const zone = process.env.TZ; t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
 process.env.TZ = "Asia/Bangkok";
 const at = "2026-09-26T05:41:07Z";
 assert.match(stamp(at), /^12:41 \S+$/);
 assert.match(stamp(at, true), /^12:41:07 \S+$/);
 assert.equal(shortSha(null), null);
 assert.equal(shortSha("a".repeat(40)), "aaaaaaa");
 assert.equal(prNumber(null), null);
 assert.equal(prNumber("https://github.com/acme/repo/pull/265"), "#265");
 assert.equal(phaseText("waiting"), "no run status");
 assert.equal(phaseText("working"), "working");
 assert.equal(phaseText("awaiting_merge"), "with the team");
});

test("S7 Overview has a calm empty strip, complete flight cells and five projected landed rows", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const screen=data=>render(h(Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const {parseHTML} = await import("linkedom");
 const data = overview({home:home.path,stateDir:join(home.path,LAYOUT.state)});
 data.decided_today = {...data.decided_today,count:3,by_you:2};
 data.mandates.paused_projects = ["fixture-paused"];
 const flight = {id:"cp-prehead",project:"picp",title:"Long job ".repeat(50),phase:"working",model:"provider/recorded-model",script_path:null,elapsed_seconds:120,limit_seconds:600,head:null,ci:null,review:null,review_attempts:0,routing:null,note:null,pr_url:null,cost_usd:0.25};
 data.in_flight = [flight,{...flight,id:"cp-held",project:"fixture-lab",phase:"held",head:"a".repeat(40),ci:"green",review:"pass",review_attempts:1,elapsed_seconds:900,context:{tokens:25,window:100,percent:25,level:"ok",model:"recorded-model",reason:null,last_compact_at:null,thinking:null},pr_url:"https://github.com/acme/repo/pull/8"},{...flight,id:"cp-unknown",elapsed_seconds:null,limit_seconds:null,cost_usd:null}];
 data.shipped_today = Array.from({length:7},(_,i)=>({id:`cp-landed-${i}`,title:`Landed ${i}`,merged_at:data.generated_at,merge_sha:"b".repeat(40),pr_url:`https://github.com/acme/repo/pull/${i+1}`,cost_usd:0.5}));
 const doc = () => parseHTML(screen(data)).document;
 let document = doc();
 const clear = document.querySelector("#awaiting.overview-clear")!;
 assert.ok(clear,"available empty questions use a single calm strip");
 assert.match(clear.textContent!,/Nothing needs you.*5 decided today · 3 for you, 2 by you/);
 assert.equal(clear.querySelector("a")?.getAttribute("href"),"#decided"); assert.equal(clear.querySelector("h2"),null);
 assert.equal(document.querySelector(".overview-paused-pill")?.textContent,"fixture-paused · paused"); assert.ok(document.querySelector(".page-header-context .overview-paused-pill"),"paused pills live in the title row"); assert.equal(document.querySelector(".overview-subtitle"),null);
 assert.equal(document.querySelector(".overview-health")?.parentElement,document.querySelector(".overview-services")?.parentElement,"health and service line share compact spacing");
 assert.deepEqual([...document.querySelectorAll(".overview-flight-columns > span")].map(e=>e.textContent),["Job","Title","Wall clock","Context","Review","CI","Model","Cost"]); assert.match(document.querySelector(".overview-held-hint")!.textContent!,/held = waiting on CI or review, normal for hours/);
 assert.equal(document.querySelector(".overview-held-hint .glossary-link")?.getAttribute("href"),"https://github.com/0xb1ob/picp#words-you-will-see","#330: Overview rows link the README glossary");
 assert.deepEqual([...document.querySelectorAll(".overview-landed-columns > span")].map(e=>e.textContent),["Job","Title","PR","Commit","Cost"]);
 const rows = [...document.querySelectorAll(".overview-flight")]; assert.equal(rows.length,3);
 for (const row of rows) for (const cell of [".overview-job-id",".overview-flight-title",".overview-clock",".overview-context",".overview-review",".overview-ci",".overview-model",".overview-cost"]) assert.ok(row.querySelector(cell),cell);
 assert.equal(rows[0]!.querySelector("progress")?.getAttribute("value"),"20");
 assert.match(rows[0]!.querySelector(".overview-clock")!.textContent!,/2m \/ 10m/); assert.match(rows[0]!.querySelector(".overview-context")!.textContent!,/context n\/a/); assert.equal(rows[1]!.querySelector(".overview-context .ctx-prefix")?.textContent,"ctx ");
 assert.equal(rows[0]!.querySelector(".overview-line-text")?.getAttribute("title"),flight.title);
 assert.match(rows[0]!.querySelector(".overview-review")!.textContent!,/review not started/); assert.match(rows[0]!.querySelector(".overview-ci")!.textContent!,/no CI yet/);
 assert.equal(rows[0]!.querySelector(".overview-model code")?.textContent,"recorded-model"); assert.equal(rows[0]!.querySelector(".overview-cost")?.textContent,"$0.25");
 assert.equal(rows[1]!.querySelector('progress[aria-label="Wall clock"]')?.getAttribute("value"),"100","overdue wall clock is bounded");
 assert.equal(rows[1]!.querySelector('progress[aria-label="Context window used"]')?.getAttribute("value"),"25");
 assert.match(rows[1]!.textContent!,/review 1\/5 pass/); assert.match(rows[1]!.querySelector(".overview-ci")!.textContent!,/CI green aaaaaaa/);
 assert.equal(rows[2]!.querySelector("progress"),null,"unknown elapsed/limit never fabricates a bar"); assert.equal(rows[2]!.querySelector(".overview-cost")?.textContent,"-");
 const landed = [...document.querySelectorAll(".overview-landed")];
 assert.deepEqual(landed.map(row=>row.querySelector(".overview-job-id code")?.textContent),data.shipped_today.slice(0,5).map(j=>j.id));
 for (const row of landed) { assert.ok(row.querySelector(".overview-dot-done")); assert.equal(row.querySelector(".overview-merge code")?.textContent,"bbbbbbb"); assert.equal(row.querySelector(".overview-merge")?.getAttribute("title"),"b".repeat(40)); assert.equal(row.querySelector(".overview-cost")?.textContent,"$0.50"); }
 assert.equal(landed[0]!.querySelector(".overview-landed-pr")?.getAttribute("href"),data.shipped_today[0]!.pr_url);
 assert.match(document.querySelector(".overview")!.textContent!,/Landed today · 7 merged · \$3\.50/); assert.match(document.querySelector(".overview")!.textContent!,/2 more merged in Jobs →/); assert.equal(document.querySelector(".overview-block h2 span[title]")?.getAttribute("title"),"merged jobs only, worker plus reviewer");
 data.availability.asks="unavailable";data.awaiting.count=null;document=doc();assert.equal(document.querySelector(".overview-clear"),null);assert.match(document.querySelector(".overview")!.textContent!,/Questions unavailable/);
 data.availability.asks="ok";data.awaiting.count=1;data.awaiting.items=[{id:"ask-ab",project:"picp",question:"Continue?",created_at:data.generated_at,options:[],recommendation:"Continue",source_escalation:null,job_ids:[],context:null,evidence_paths:[]}];
 document=doc();assert.equal(document.querySelector(".overview-clear"),null);assert.match(document.querySelector("#awaiting")!.textContent!,/Needs you · 1.*Continue\?/);assert.ok(document.querySelector(".overview-square-attention"));
});
