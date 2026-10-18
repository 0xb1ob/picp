import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { VersionResponse } from "../src/viewer/api-types.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {VersionBadge} from "./viewer-app/components/VersionBadge.tsx"; export {act}; export const mount=(root,view)=>render(h(VersionBadge,{state:{view,error:null}}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);

const DETAIL = "origin/main at aaaaaaa first seen 2026-10-01T11:51:00.000Z; quiet until 2026-10-01T12:11:00.000Z";
const HEADLINE = "1 behind (update to aaaaaaa waits for quiet origin/main until 12:11Z)";
const view = (phase: string | null | undefined): VersionResponse => ({
 generated_at: "2026-10-01T12:00:00.000Z", deployed: {sha: "b".repeat(40), at: "2026-10-01T11:00:00.000Z"},
 upstream: {state: "behind", behind: 1, ahead: 0, reason: null, checked_at: "2026-10-01T11:59:00.000Z", updater: {
  enabled: true, phase: phase as string | null, result: "skipped_settling", since: null, last_run_at: "2026-10-01T11:59:00.000Z", detail: DETAIL,
  fetch_failures: 0, progress: "update to aaaaaaa waits for quiet origin/main until 12:11Z", progress_short: "waits until 12:11Z",
 }},
 processes: [], bundle: {script: null}, overall: {level: "warn", label: "1 behind (waits until 12:11Z)", headline: HEADLINE},
});

test("#325: a settling updater's raw-ISO detail stays hidden for an idle, null or missing phase; head and title carry the sentence", async t => {
 const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
 const originals = ["window","document"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,"window",{configurable:true,value:window});
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 t.after(() => { for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } });
 const root = document.getElementById("root")!;
 const open = async () => { const details = root.querySelector("details")!; details.open = true; details.dispatchEvent(new window.Event("toggle")); };
 // A record written before `phase` existed (or with phase null) is idle: the detail would only repeat the clock as ISO.
 for (const phase of ["idle", null, undefined]) {
  await act(() => mount(root,view(phase)));
  await act(open);
  assert.equal(root.querySelector("summary")!.getAttribute("title"),HEADLINE,String(phase));
  assert.equal(root.querySelector(".shell-version-head")!.textContent,HEADLINE,String(phase));
  assert.match(root.textContent!,/waits for quiet origin\/main until 12:11Z/,String(phase));
  assert.doesNotMatch(root.textContent!,/T11:51:00/,String(phase));
  await act(() => unmount(root));
 }
 // A running phase is not settled: the detail shows.
 await act(() => mount(root,view("draining")));
 await act(open);
 assert.match(root.textContent!,/T11:51:00/);
 await act(() => unmount(root));
});
