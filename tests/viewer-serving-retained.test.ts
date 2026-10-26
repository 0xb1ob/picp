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
import { deployView } from "../src/viewer/deploy-view.ts";
import { readObject } from "../src/viewer/sessions.ts";
import { routingEvents } from "../src/viewer/overview-health.ts";
import { readLines, startOffset } from "../src/viewer/tail.ts";
import { hostAllowed } from "../src/viewer/server.ts";
import type { ViewerJob } from "../src/viewer/api-types.ts";
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

// `deployView` on live phases: launching and working come only from a running worker's in-flight row, which a scratch
// home cannot hold; the e2e P21-deploy reads every file-backed state through /api/job.
test("deployView: a launching deploy job is queued and a working one is deploying", (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(stateDir, "runs", "cp-merged"), { recursive: true });
	writeFileSync(join(stateDir, "runs", "cp-merged", "after-merge.json"), JSON.stringify({ schema_version: 1, job_id: "cp-merged", merge_commit_sha: "b59fc3a1".repeat(5), base_branch: "main", status: "created", deploy_job_id: "cp-deploy", coverage: "none", task_file: "/x/t.md", recorded_at: "2026-09-26T12:00:00Z" }));
	const at = (phase: string) => deployView({ home: home.path, stateDir }, "cp-merged", [{ id: "cp-deploy", phase, failure: null, finished_at: null } as unknown as ViewerJob])?.state;
	assert.deepEqual([at("launching"), at("working")], ["queued", "deploying"]);
});

// `diffJson`/`applyDelta` codec matrix: key order, __proto__, scalars and duplicate ids are shapes no screen view emits;
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
