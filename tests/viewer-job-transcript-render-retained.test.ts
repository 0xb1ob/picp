// Retained (P18b): measured overflow, poll timing and the steps variant are pure UI helpers no served tab exposes;
// the transcript render itself is P18-transcript-ui in tests/e2e/viewer-job-p18b.test.ts.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./harness/index.ts";

process.env.TZ = "UTC";
const built = await build({
 stdin: {
  contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {ToolRunRow} from "./viewer-app/components/ToolRunRow.tsx"; export const steps=(o,notice,toggle=true)=>render(h(ToolRunRow,{count:2,detail:"d",open:o,onToggle:toggle?()=>{}:undefined,steps:true,notice},"kids")); import {shouldFetch,POLL_MS} from "./viewer-app/screens/JobTranscript.tsx"; export {shouldFetch,POLL_MS}; import {overflows} from "./viewer-app/screens/JobDetail.tsx"; export {overflows};',
  loader: "tsx", resolveDir: REPO_ROOT,
 },
 bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: {".css": "empty"},
});
const {steps, overflows, shouldFetch, POLL_MS} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);

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

test("the steps variant is Sessions' opt-in pill and card; the default and solid rows above are unchanged by it", () => {
 // Chat v2 PR 2: `steps` adds a pill face and one card that holds the notice slot even while closed; without onToggle
 // (Tools on) the pill goes and the card stays open. JobTranscript never passes `steps`.
 assert.equal(steps(false), '<div class="session-tool-run session-steps"><button type="button" class="session-tools" aria-expanded="false"><span class="session-steps-face"><span aria-hidden="true">≡</span> 2 steps<small> · d</small><span aria-hidden="true"> ▸</span></span></button></div>');
 assert.match(steps(false, "NOTICE"), /<\/button><div class="session-steps-card">NOTICE<\/div><\/div>$/, "closed, the notice slot still renders; the rows do not");
 assert.match(steps(true, "NOTICE"), /^<div class="session-tool-run session-steps session-steps-open">.*<div class="session-steps-card">NOTICEkids<\/div><\/div>$/);
 assert.equal(steps(true, undefined, false), '<div class="session-tool-run session-steps session-steps-open"><div class="session-steps-card">kids</div></div>');
 assert.doesNotMatch(readFileSync(join(REPO_ROOT, "viewer-app/screens/JobTranscript.tsx"), "utf8"), /\bsteps\b/);
});
