import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import type { JobResponse, ViewerJob } from "../src/viewer/api-types.ts";
import { REPO_ROOT } from "./harness/index.ts";

const buildResult = await build({
 stdin: {
  contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {JobDetail} from "./viewer-app/screens/JobDetail.tsx"; export const screen=(data)=>render(h(JobDetail,{data}));',
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

function detail(over: Partial<ViewerJob> = {}): string {
 const data: JobResponse = {
  generated_at: "2026-09-27T00:00:00Z", awaiting_count: 0, job: job(over), timeline: [], timeline_truncated: false,
  files_href: null, artifact_href: null, artifact_name: null, run_href: null, asks: [], questions: [], warnings: [],
 };
 return screen(data);
}

test("queued job uses words instead of a dash", () => {
 const html = detail();
 assert.doesNotMatch(html, />-</, "no dash-only text node");
 assert.doesNotMatch(html, /<dd>-/);
 assert.match(html, /no commits yet/);
 assert.match(html, /not run yet/);
 assert.match(html, /none yet/);
 assert.match(html, /not started · 0 \/ 5/);
 assert.doesNotMatch(html, /<script>|style=|onclick=/i);
});

test("merged job shows the PR, the short merge sha and two copy buttons", () => {
 const head = "a".repeat(40);
 const merge = "b".repeat(40);
 const html = detail({
  id: "cp-merged", phase: "done", title: "Landed", head, ci: "green", review: "pass", review_attempts: 1,
  model: "anthropic/claude-fixture", mandate_id: "md-active", cost_usd: 1.25,
  pr_url: "https://github.com/acme/widgets/pull/12", pr_status: "merged", merge_sha: merge,
 });
 assert.match(html, /#12 ↗/);
 assert.match(html, new RegExp(`as <code>${merge.slice(0, 7)}</code>`));
 assert.equal(html.match(/aria-label="Copy reply for the operator chat"/g)?.length, 2);
 assert.match(html, new RegExp(head));
 assert.match(html, new RegExp(merge));
 assert.match(html, /claude-fixture · anthropic/);
 assert.match(html, /\$1\.25/);
 assert.match(html, /<a href="#map"><code>md-active<\/code> →<\/a>/);
});

test("desktop breadcrumb links back to jobs and names the id", () => {
 const html = detail({id: "cp-merged", title: "Landed"});
 assert.match(html, /<a href="#jobs">← Jobs<\/a> \/ <code>cp-merged<\/code>/);
});
