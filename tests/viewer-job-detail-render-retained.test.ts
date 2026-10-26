// Retained (P18c): JobDetail's routing text fallback; the viewer sends `routing` only beside the facts it derives from.
// The rendered routing pills are P18-job-detail-ui in tests/e2e/viewer-ui-p18c.test.ts.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import type { JobResponse, ViewerJob } from "../src/viewer/api-types.ts";
import { REPO_ROOT } from "./harness/index.ts";
import { parseHTML } from "linkedom";

const buildResult = await build({
 stdin: {
  contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {JobDetail} from "./viewer-app/screens/JobDetail.tsx"; export const screen=(data,props={})=>render(h(JobDetail,{data,...props}));',
  loader: "tsx",
  resolveDir: REPO_ROOT,
 },
 bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: {".css": "empty"},
});
const {screen} = await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles![0]!.contents).toString("base64")}`);

function job(over: Partial<ViewerJob>): ViewerJob {
 return {
  id: "cp-queued", project: "demo", title: "Queued title", phase: "queued", model: null, script_path: null,
  elapsed_seconds: null, limit_seconds: null, head: null, ci: null, review: null, review_attempts: 0, routing: null,
  note: null, ledger_status: "open", ledger_disagrees: false, mandate_id: null, cost_usd: null, pr_url: null,
  pr_status: null, finished_at: null, finished_today: false, merge_sha: null, failure: null, summary: null, blockers: [],
  context: null, ...over,
 };
}

function detail(over: Partial<ViewerJob> = {}, extra: Partial<JobResponse> = {}, props: {wide?: boolean; initial?: string} = {wide: true}): string {
 const data: JobResponse = {
  generated_at: "2026-09-27T00:00:00Z", awaiting_count: 0, job: job(over), description: null, mandate: null, timeline: [], timeline_truncated: false,
  files_href: null, artifact_href: null, artifact_name: null, run_href: null, reports: [], asks: [], questions: [], warnings: [], ...extra,
 };
 return screen(data, props);
}

test("routing pills retain recorded provenance once and show one explanation", () => {
 const html = detail({routing:"legacy duplicate", routing_facts:{scope:"M",risk:"low",provenance:{scope:"inferred",risk:"explicit"},rule:"recorded rule",reasons:["Recorded explanation", "Additional reason"]}});
 const {document} = parseHTML(html);
 const routing = document.querySelector(".job-fact-routing")!;
 assert.deepEqual([...routing.querySelectorAll(".job-routing-pill")].map(e=>e.textContent), ["scope:M · inferred","risk:low · explicit","recorded rule"]);
 assert.equal(routing.querySelectorAll("p").length, 1);
 assert.equal(routing.querySelector("p")?.textContent, "Recorded explanation · Additional reason");
 assert.doesNotMatch(html, /legacy duplicate/);
 assert.match(detail({routing:"legacy recorded routing"}), /legacy recorded routing/);
 assert.match(detail(), /Not recorded/);
 const partial = detail({routing_facts:{scope:null,risk:"low",provenance:{scope:null,risk:null},rule:null,reasons:[]}});
 assert.match(partial, /risk:low/);
 assert.doesNotMatch(partial, /scope:|inferred|defaulted/);
});
