import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { JobTranscriptResponse, ReportItem, SessionEntry } from "../src/viewer/api-types.ts";
import { REPO_ROOT } from "./harness/index.ts";

process.env.TZ = "UTC";
const built = await build({
 stdin: {
  contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {TranscriptDocument} from "./viewer-app/screens/JobTranscript.tsx"; import {shouldFetch,POLL_MS} from "./viewer-app/screens/JobTranscript.tsx"; export {shouldFetch,POLL_MS}; import {overflows} from "./viewer-app/screens/JobDetail.tsx"; export {overflows}; export const screen=(data,reports=[])=>render(h(TranscriptDocument,{data,model:"anthropic/m",reports}));',
  loader: "tsx", resolveDir: REPO_ROOT,
 },
 bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: {".css": "empty"},
});
const {screen, overflows, shouldFetch, POLL_MS} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);

const e = (id: string, at: string, kind: SessionEntry["kind"], who: string, text: string, over: Partial<SessionEntry> = {}): SessionEntry =>
 ({id, at, kind, who, text, name: null, send_id: null, tag: null, failed: false, trace: [], ...over});
const tool = (id: string, name: string, args: object, result: string, failed = false) => e(id, "2026-09-26T12:01:00Z", "tool", "assistant", `Arguments\n${JSON.stringify(args)}\n\nResult\n${result}`, {name, failed});
const entries: SessionEntry[] = [
 e("a", "2026-09-26T12:00:00Z", "say", "Parent", "The brief <b>x</b>"),
 tool("t1", "read", {path: "a.ts"}, "x"), tool("t2", "read", {path: "b.ts"}, "y"), tool("t3", "bash", {command: "npm test"}, "boom", true),
 e("w", "2026-09-26T12:05:00Z", "say", "Worker", "Done with **it**"),
 tool("r", "report_result", {status: "done"}, "ok"),
 e("v", "2026-09-26T12:09:00Z", "system", "cp-bridge", "Verdict: pass", {bridge: {kind: "review-verdict", job: null, id: null, receipt: null}}),
 e("n", "2026-09-26T12:10:00Z", "system", "cp-bridge", "late notice"),
];
const data = (over: Partial<JobTranscriptResponse> = {}): JobTranscriptResponse => ({entries, truncated: false, warning: null, from: entries[0]!.at, to: entries.at(-1)!.at, ...over});
const report = {slug: "s", title: "T", description: "", created_at: "2026-09-26T12:00:00Z", job_ids: ["cp-x"], href: "/boards/s/"} as ReportItem;

test("transcript renders Worker/Parent time labels, counted tool groups, report and review blocks from a fixture", () => {
 const html = screen(data(), [report]);
 const {document} = parseHTML(html);
 assert.match(document.querySelector(".jt-head")!.textContent!, /read-only.*Worker session · anthropic\/m · 12:00–12:10.*Jump to Brief.*Report.*Reviews/s);
 assert.deepEqual([...document.querySelectorAll(".jt-label")].map(n => n.textContent), ["Parent · 12:00", "Worker · 12:05"]);
 const group = document.querySelector("details.jt-tools")!;
 assert.equal(group.querySelector("summary")!.textContent, "▸3 tool calls · read 2 files · ran 1 command");
 assert.equal(group.querySelectorAll(".jt-tool").length, 3);
 assert.equal(group.querySelector(".jt-tool-failed .jt-failed")?.textContent, "failed");
 assert.equal(group.querySelector(".jt-command")?.textContent, "npm test");
 assert.equal(group.querySelector(".jt-result")?.textContent, "boom");
 const done = document.querySelector(".jt-report")!;
 assert.match(done.textContent!, /Report filed.*12:01.*Open report/);
 assert.equal(done.querySelector("a")?.getAttribute("href"), "/boards/s/");
 const review = document.querySelector("details.jt-review")!;
 assert.match(review.querySelector("summary")!.textContent!, /▸review-verdict · 12:09/);
 assert.equal(review.id, "jt-reviews");
 assert.equal(document.querySelector(".jt-trailing summary")!.textContent, "▸1 more event", "after the last worker/report/review block");
 assert.doesNotMatch(html, /<b>x<\/b>|<script/i, "message text is never raw HTML");
});

test("no report link without a published report; no jump chips for absent blocks; a warning is shown", () => {
 const {document} = parseHTML(screen(data(), []));
 assert.equal(document.querySelector(".jt-report a"), null);
 const bare = parseHTML(screen(data({entries: [], warning: "No worker session recorded", from: null, to: null}))).document;
 assert.equal(bare.querySelector(".jt-jump"), null);
 assert.match(bare.querySelector('[role="status"]')!.textContent!, /No worker session recorded/);
});

test("summary `more` follows a measured overflow, not text length", () => {
 assert.equal(overflows({scrollWidth: 300, clientWidth: 300}), false, "a fitting summary has nothing hidden");
 assert.equal(overflows({scrollWidth: 301, clientWidth: 300}), true);
});

test("a finished job's transcript is fetched once; a live one at most every 10s and never while a request runs", () => {
 const idle = {inflight: false, loaded: true, loadedLive: false, finished: false, sinceMs: 0};
 assert.equal(shouldFetch({...idle, loaded: false}), true, "first load");
 assert.equal(shouldFetch({...idle, loaded: false, finished: true}), true);
 assert.equal(shouldFetch({...idle, finished: true, sinceMs: 10 * POLL_MS}), false, "finished and loaded after finishing: once");
 assert.equal(shouldFetch({...idle, sinceMs: 1000}), false, "live: a tick inside 10s");
 assert.equal(shouldFetch({...idle, sinceMs: POLL_MS}), true, "live: 10s passed");
 assert.equal(shouldFetch({...idle, loaded: false, inflight: true}), false, "one request at a time");
 assert.equal(shouldFetch({...idle, sinceMs: POLL_MS, inflight: true}), false);
});

test("a loaded live job that finishes gets one final fetch, then no finished polling", () => {
 // Simulate the component: refresh ticks while the job is live, then it finishes inside a poll interval.
 let loaded = false, loadedLive = false, last = -Infinity, fetches: string[] = [];
 const tick = (t: number, finished: boolean) => {
  if (!shouldFetch({inflight: false, loaded, loadedLive, finished, sinceMs: t - last})) return;
  fetches.push(`${t}:${finished ? "final" : "live"}`); loaded = true; loadedLive = !finished; last = t;
 };
 for (const t of [0, 1000, 2000, 9000]) tick(t, false);
 assert.deepEqual(fetches, ["0:live"], "live ticks inside 10s do not refetch");
 tick(9500, true);
 assert.deepEqual(fetches, ["0:live", "9500:final"], "finishing inside the interval still fetches the terminal entries");
 for (const t of [10_000, 20_000, 60_000]) tick(t, true);
 assert.equal(fetches.length, 2, "finished polling stops after the final fetch");
 // A job that was already finished on first load is never refetched.
 fetches = []; loaded = false; loadedLive = false; last = -Infinity;
 for (const t of [0, 1000, 60_000]) tick(t, true);
 assert.deepEqual(fetches, ["0:final"]);
});
