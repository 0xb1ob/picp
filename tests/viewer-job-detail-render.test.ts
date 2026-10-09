import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import type { JobResponse, ViewerJob } from "../src/viewer/api-types.ts";
import { REPO_ROOT } from "./harness/index.ts";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
 assert.equal(parseHTML(html).document.querySelector(".job-fact-pr .job-sha > code")?.textContent, merge.slice(0,7));
 assert.equal(html.match(/aria-label="Copy reply for the operator chat"/g)?.length, 2);
 assert.match(html, new RegExp(head));
 assert.match(html, new RegExp(merge));
 assert.match(html, /<code[^>]*>claude-fixture<\/code><span class="job-provider">anthropic<\/span>/);
 assert.match(html, /\$1\.25/);
 assert.match(html, /<a href="#map"><code>md-active<\/code> →<\/a>/);
});

test("desktop header row links back to jobs, then the title and the id", () => {
 const row = parseHTML(detail({id: "cp-merged", title: "Landed"})).document.querySelector(".job-detail-heading > .page-header")!;
 assert.deepEqual([...row.children].slice(0,3).map(e => [e.tagName, e.textContent]), [["A","Jobs"],["H1","Landed"],["CODE","cp-merged"]]);
 assert.equal(row.querySelector("a.page-header-back")?.getAttribute("href"), "#jobs");
});


test("hero spans the body and contains title then phase, PR, CI and review badges", () => {
 const html = detail({phase:"held", title:"A long fixture title", head:"a".repeat(40), ci:"green", review:"pass", review_attempts:1, pr_url:"https://github.com/acme/widgets/pull/12", pr_status:"open"});
 const {document} = parseHTML(html);
 const hero = document.querySelector(".job-detail > .job-detail-heading")!;
 assert.ok(hero, "hero must sit above both body columns");
 assert.deepEqual([...hero.children].map(e=>e.className || e.tagName), ["page-header page-header-stack","job-badges","P"]);
 const badges = hero.querySelector(".job-badges")!;
 assert.deepEqual([...badges.children].map(e=>e.textContent), ["held","#12 open ↗","CI green aaaaaaa","review 1 / 5 · pass"]);
 assert.equal(badges.querySelector("a")?.getAttribute("href"), "https://github.com/acme/widgets/pull/12");
 assert.deepEqual([...document.querySelector(".job-detail-body")!.children].map(e=>e.className), ["job-detail-main","job-detail-side"], "the tab content and the facts rail");
 const labels = [...document.querySelectorAll(".job-facts dt")].map(e=>e.textContent);
 assert.deepEqual(labels, ["Wall clock","Cost","Model","Head","Context","Routing","Mandate","PR","CI","Review"]);
 const model = document.querySelector(".job-fact-model dd");
 const provider = detail({model:"anthropic/claude-fixture"});
 assert.match(provider, /<code[^>]*>claude-fixture<\/code><span class="job-provider">anthropic<\/span>/);
 assert.ok(model);
});

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

test("timeline abbreviates SHA40 but preserves full accessible and copyable values", () => {
 const head = "A".repeat(40), merge = "b".repeat(40);
 const html = detail({phase:"done"}, {run_href:"/api/job/cp-queued/events", timeline:[{at:"2026-09-27T00:00:00Z",label:"CI green",meta:`on ${head} · as ${merge}`,tone:"green"}]}, {wide:true, initial:"timeline"});
 const {document} = parseHTML(html);
 const shas = [...document.querySelectorAll(".job-timeline .job-sha > code")];
 assert.deepEqual(shas.map(e=>e.textContent), [head.slice(0,7),merge.slice(0,7)]);
 assert.deepEqual(shas.map(e=>e.getAttribute("title")), [head,merge]);
 assert.deepEqual([...document.querySelectorAll(".job-timeline .overview-reply code")].map(e=>e.textContent), [head,merge]);
 assert.equal(document.querySelector('.job-links a[href="/api/job/cp-queued/events"]')?.textContent, "Run log");
 assert.doesNotMatch(html, /events\.jsonl|job-event-pending/);
});

test("finished research has no speculative pending stages; an equivalent pass is not not-started", () => {
 assert.doesNotMatch(detail({phase:"done"}), /job-event-pending|starts after|not yet/);
 const {document} = parseHTML(detail({phase:"done",review:"pass",review_attempts:0}));
 assert.match(document.querySelector(".job-badge-review")!.textContent!, /pass.*equivalent/);
 assert.doesNotMatch(document.querySelector(".job-badge-review")!.textContent!, /not started/);
});


test("SHA copy target stays 44px with invisible padding around the 14px icon", () => {
 const css=readFileSync(join(REPO_ROOT,"viewer-app/screens/job-detail.css"),"utf8");
 assert.match(css,/\.job-sha \.overview-reply button \{[^}]*min-width: 44px;[^}]*min-height: 44px;[^}]*padding: 15px;[^}]*border: 0;[^}]*background: transparent/);
});

test("desktop opens on Transcript beside the facts rail; phone opens on Details with three tabs", () => {
 const tabs = (html: string) => [...parseHTML(html).document.querySelectorAll('[role="tab"]')].map(e => [e.textContent, e.getAttribute("aria-selected")]);
 const desktop = detail({phase:"done"}, {}, {wide:true});
 assert.deepEqual(tabs(desktop), [["Transcript","true"],["Timeline","false"]]);
 assert.ok(parseHTML(desktop).document.querySelector(".job-detail-side .job-facts"), "facts stay on the rail");
 assert.doesNotMatch(desktop, /class="job-timeline"/, "Timeline is its own tab");
 const phone = detail({phase:"done"}, {}, {wide:false});
 assert.deepEqual(tabs(phone), [["Details","true"],["Transcript","false"],["Timeline","false"]]);
 assert.match(phone, /data-tab="details"/);
});

test("asks, the failure action, the description and the mandate snippet render outside the tabs", () => {
 const mandate = {id:"md-a", status:"active", objective:"Ship it", spend_usd:1.5, cap_usd:20, jobs:3};
 const html = detail({phase:"failed", failure:"Boom"}, {description:"Why this job exists", mandate, asks:[{id:"ask-a", question:"Keep?", options:[{label:"Keep", consequence:"c", reply:"keep"}]}] as never});
 const {document} = parseHTML(html);
 assert.match(document.querySelector(".job-detail-top")!.textContent!, /Awaiting you.*Keep\?.*Boom/);
 assert.match(html, /Ask about this failure/);
 assert.equal(document.querySelector(".job-card p")?.textContent, "Why this job exists");
 assert.match(document.querySelector(".job-mandate-snippet")!.textContent!, /md-a.*active.*Ship it.*\$1\.50 \/ \$20\.00.*3 jobs/);
 assert.equal(parseHTML(detail()).document.querySelector(".job-card, .job-mandate-snippet"), null, "omitted when null");
});

test("description and mandate goal keep their stored spaces and line breaks; header chips sit on the same row", () => {
 const css=readFileSync(join(REPO_ROOT,"viewer-app/screens/job-detail.css"),"utf8");
 assert.match(css,/\.job-card p, \.job-mandate-objective \{ white-space: pre-wrap; \}/);
 assert.match(css,/\.jt-jump \{[^}]*margin-left: auto/);
 assert.match(css,/@media \(max-width: 899px\) \{\s*\.jt-review > summary[^}]*min-height: 44px/,"44px summary targets are phone-only");
 assert.match(readFileSync(join(REPO_ROOT,"viewer-app/components/tool-run.css"),"utf8"),/max-width: 899px\) \{ \.tool-run-solid > \.session-tools \{ min-height: 44px/,"shared tool row: 44px on phone only");
});

test("summary renders collapsed with no `more` before a client measurement says it overflows", () => {
 const html = detail({summary: "Short"});
 assert.match(html, /<p class="job-summary job-summary-clamp">Short<\/p>/);
 assert.doesNotMatch(html, /job-summary-more/, "more is shown only on measured overflow");
 assert.doesNotMatch(detail({summary: null}), /job-summary-row/);
});

test("failure headline sits above the tabs; the Ask action lives in the facts rail, shown on desktop and phone Details only", () => {
 const ask = (props: {wide?: boolean; initial?: string}) => {
  const {document} = parseHTML(detail({phase: "failed", failure: "wall clock limit"}, {}, props));
  const root = document.querySelector(".job-detail")!;
  const link = [...document.querySelectorAll("a")].find(a => a.textContent === "Ask about this failure");
  return {tab: root.getAttribute("data-tab"), inSide: !!link?.closest(".job-detail-side"), headline: document.querySelector(".job-detail-top .job-failure")?.textContent, tabsAfterTop: !!document.querySelector(".job-detail-top + .job-tabs")};
 };
 const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/job-detail.css"), "utf8");
 assert.match(css, /\.job-detail-side \{ display: none;/, "phone: the rail is hidden by default");
 assert.match(css, /\.job-detail\[data-tab="details"\] \.job-detail-side \{ display: flex; \}/, "phone: shown on the Details tab");
 for (const [name, props] of [["phone details", {wide: false}], ["desktop", {wide: true}]] as const) {
  const r = ask(props);
  assert.deepEqual([r.inSide, r.headline, r.tabsAfterTop], [true, "wall clock limit", true], name);
 }
 assert.equal(ask({wide: false}).tab, "details", "the phone opens on Details, where the action is visible");
 assert.equal(ask({wide: false, initial: "transcript"}).tab, "transcript", "on phone Transcript the rail is CSS-hidden");
 assert.equal(detail({phase: "done"}).includes("Ask about this failure"), false, "only failed jobs offer it");
});
