/** Restart session in the shell's ⋮ menu: shown only with a control view, Esc / outside tap close it, no inline copies remain. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import type { ControlView } from "../viewer-app/control.ts";
import type { Restarting } from "../viewer-app/restart-control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const status = (over: Partial<ControlStatusResponse> = {}): ControlStatusResponse => ({ generated_at: "2026-01-01T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false }, restart: { supported: true, blockers: [], reason: null }, session_started_at: "2026-01-01T08:00:00.000Z", ...over });
const restarting = (state: Restarting["state"]): Restarting => ({ state, reason: null, started_at: null, session_file: "op.jsonl" });
const view = (s: ControlStatusResponse, r: Restarting | null = null, restart: () => void = () => {}): ControlView => ({ status: s, delivery: null, send: () => {}, restarting: r, restart });

const built = await build({ stdin: { contents: 'import {h,render as domRender} from "preact"; import {act} from "preact/test-utils"; import render from "preact-render-to-string"; import {MoreMenu} from "./viewer-app/components/MoreMenu.tsx"; export {act}; export const draw=(control, extra)=>render(h(MoreMenu,{control, ...extra})); export const mount=(root,control, extra)=>domRender(h(MoreMenu,{control, ...extra}),root); export const unmount=root=>domRender(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, draw, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { act: (fn: () => unknown) => Promise<void>; draw: (control: ControlView | undefined, extra?: {version?: {view: unknown; error: string | null}; updatedAt?: string | null}) => string; mount: (root: unknown, control: ControlView | undefined, extra?: object) => void; unmount: (root: unknown) => void };

test("⋮ menu: always rendered; Restart only with a session; a dot while a restart runs", () => {
	assert.match(draw(undefined), /aria-label="More actions"/, "no control view: the menu still renders");
	assert.doesNotMatch(draw(undefined), /Restart session/);
	assert.match(draw(view(status({ running: false, token: null }))), /More actions/);
	assert.doesNotMatch(draw(view(status({ running: false, token: null }))), /Restart session/, "offline and not restarting: no Restart row");
	const idle = draw(view(status()));
	assert.match(idle, /<summary aria-label="More actions" title="More actions">/);
	assert.doesNotMatch(idle, /shell-more-dot|Restart session/, "closed: no panel, no dot");
	assert.match(draw(view(status(), restarting("stopping"))), /shell-more-dot/, "a compact dot, not a block");
	assert.doesNotMatch(draw(view(status(), restarting("restarted"))), /shell-more-dot/);
});
test("⋮ dot shows on a version alert and Restart stays hidden without a control view", () => {
	const version = { view: { generated_at: "2026-01-01T00:00:00Z", deployed: null, upstream: { state: "unknown" as const, behind: null, ahead: null, reason: null, checked_at: null, updater: null }, processes: [], bundle: { script: null }, overall: { level: "alert" as const, label: "update failed" } }, error: null };
	assert.match(draw(undefined, {version}), /shell-more-dot/);
	assert.doesNotMatch(draw(undefined, {version}), /Restart session/);
	assert.doesNotMatch(draw(undefined, {version: {...version, view: {...version.view, overall: {level: "ok" as const, label: "current"}}}}), /shell-more-dot/);
});

test("⋮ menu: opens with Restart session inside (two-tap confirm kept); Esc and an outside tap close it", async t => {
	const { window, document } = parseHTML("<html><body><div id='root'></div><p id='elsewhere'>x</p></body></html>");
	const originals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, "window", { configurable: true, value: window });
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	window.matchMedia = (() => ({matches:false}) as MediaQueryList);
	t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const root = document.getElementById("root")!;
	let restarts = 0;
	await act(() => mount(root, view(status(), null, () => { restarts++; })));
	const details = root.querySelector("details")!;
	const toggle = async (open: boolean) => { details.open = open; await act(() => details.dispatchEvent(new window.Event("toggle"))); };
	assert.equal(root.querySelector(".shell-more-panel"), null);
	await toggle(true);
	const item = () => root.querySelector<HTMLButtonElement>(".operator-restart-button")!;
	const text = root.querySelector(".shell-more-panel")!.textContent ?? "";
	assert.ok(text.indexOf("Refresh now") < text.indexOf("Copy link to this view") && text.indexOf("Copy link to this view") < text.indexOf("Notifications") && text.indexOf("Notifications") < text.indexOf("Viewer"), text);
	assert.equal(root.querySelectorAll(".shell-more-row > svg").length, 3, "Refresh, Copy and Notifications each have an icon");
	assert.ok(root.querySelector(".shell-more-footer .shell-more-version"), "Viewer sits in the divided footer");
	assert.ok(root.querySelector(".shell-more-scrim[aria-hidden=true]"), "the phone background dims while the panel is open");
	assert.equal(item().textContent, "Restart session");
	await act(() => item().click());
	assert.match(item().textContent!, /^Tap again to restart/);
	assert.equal(restarts, 0, "one tap sends nothing");
	await act(() => item().click());
	assert.equal(restarts, 1);

	const key = (k: string) => { const e = new window.Event("keydown", { bubbles: true }); Object.defineProperty(e, "key", { value: k }); return e; };
	await act(() => document.dispatchEvent(key("Enter")));
	assert.equal(details.open, true, "other keys leave it open");
	let focused = false;
	root.querySelector("summary")!.focus = () => { focused = true; };
	await act(() => document.dispatchEvent(key("Escape")));
	assert.equal(details.open, false, "Esc closes");
	assert.equal(focused, true, "Escape restores focus to the opener");
	await toggle(true);
	await act(() => document.getElementById("elsewhere")!.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
	assert.equal(details.open, false, "an outside tap closes");
	await toggle(true);
	await act(() => root.querySelector(".shell-more-scrim")!.dispatchEvent(new window.Event("pointerdown", {bubbles:true})));
	assert.equal(details.open, false, "a tap on the scrim closes the menu");
	await toggle(true);
	await act(() => item().dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
	assert.equal(details.open, true, "a tap inside keeps it open");
	await act(() => unmount(root));
});

test("Restart session no longer renders inline; the ⋮ button is 44px and the panel stays inside the viewport", () => {
	for (const file of ["viewer-app/components/OperatorComposer.tsx", "viewer-app/screens/Overview.tsx"]) assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), "utf8"), /RestartSession/, file);
	assert.match(readFileSync(join(REPO_ROOT, "viewer-app/components/Shell.tsx"), "utf8"), /class="shell-search"[\s\S]*?<MoreMenu control=\{control\} version=\{version\} updatedAt=\{updatedAt\}\/>/, "far right of the header, after Search");
	const css = readFileSync(join(REPO_ROOT, "viewer-app/styles/shell.css"), "utf8");
	const rule = (selector: string) => new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
	assert.match(rule(".shell-more > summary"), /width: 44px; height: 44px/);
	assert.match(rule(".shell-more-panel"), /max-width: calc\(100vw - 16px\)/);
	assert.match(rule(".shell-more-panel"), /var\(--surface\)/, "theme tokens, so light and dark both hold");
});

// cp-wuhl: the menu once shared `.more-menu` with the More screen's list; the one bundled stylesheet gave the <details>
// `overflow: hidden`, so a tap toggled it open and the absolutely placed panel was clipped to nothing.
test("⋮ menu: its classes are styled by shell.css alone, so no other screen's rule can clip the open panel", () => {
	const classes = new Set([...draw(view(status(), restarting("stopping"))).matchAll(/class="([^"]+)"/g)].flatMap(m => m[1]!.split(/\s+/)));
	classes.add("shell-more-panel");
	assert.ok(classes.has("shell-more") && classes.has("shell-more-dot"), [...classes].join(" "));
	const dirs = ["viewer-app/components", "viewer-app/screens", "viewer-app/styles"];
	const sheets = dirs.flatMap(dir => readdirSync(join(REPO_ROOT, dir)).filter(f => f.endsWith(".css")).map(f => `${dir}/${f}`));
	assert.ok(sheets.includes("viewer-app/screens/more.css"), "the scan covers the More screen's stylesheet");
	for (const sheet of sheets.filter(s => s !== "viewer-app/styles/shell.css")) {
		const css = readFileSync(join(REPO_ROOT, sheet), "utf8");
		for (const cls of classes) assert.doesNotMatch(css, new RegExp(`\\.${cls}(?![\\w-])`), `${sheet} styles .${cls}`);
	}
});

test("desktop page header: one row per page with a short updated time, the ⋮ menu and exactly one <h1>", async () => {
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Shell} from "./viewer-app/components/Shell.tsx"; import {NotFound,notFoundFor} from "./viewer-app/components/NotFound.tsx"; import {Overview} from "./viewer-app/screens/Overview.tsx"; import {JobDetail} from "./viewer-app/screens/JobDetail.tsx"; const shell=(current,child)=>render(h(Shell,{current,awaiting:0,status:"live",updatedAt:"2026-10-06T08:30:00Z"},child)); export const bare=()=>shell({screen:"sessions",query:"view=you"},h("div",{class:"sessions"})); export const missing=current=>shell(current,h(NotFound,notFoundFor(current,404))); export const overview=data=>shell({screen:"overview"},h(Overview,{data})); export const job=data=>shell({screen:"job",jobId:data.job.id},h(JobDetail,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const draw = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 // A screen with no header of its own (here a bare Sessions stand-in, or loading): the shell's fallback row, no <h1>.
 const bare = parseHTML(draw.bare()).document;
 assert.ok(bare.querySelector(".shell-main > .sessions"));
 const fallback = bare.querySelector(".shell-main > .page-header.page-header-fallback")!;
 assert.equal(fallback.querySelector("p")?.textContent,"Sessions");
 assert.ok(fallback.querySelector(".page-header-end > .shell-live-live > span"),"the live dot stays");
 const clock = fallback.querySelector(".page-header-end time")!;
 assert.equal(clock.getAttribute("datetime"),"2026-10-06T08:30:00Z");
 assert.match(clock.textContent ?? "",/^updated \d\d:\d\d$/,"no seconds, no zone");
 assert.match(clock.getAttribute("title") ?? "",/^Updated \d\d:\d\d:\d\d/,"the full time is its title");
 assert.ok(fallback.querySelector(".page-header-end > .shell-more:last-child"),"⋮ is the row's last item");
 assert.equal(bare.querySelectorAll("h1").length,0);
 assert.equal(bare.querySelector(".shell-desktop-search kbd")?.textContent,"⌘K");
 // A job 404 keeps the recovery <h1>; the fallback row names Jobs and the id.
 const job404 = parseHTML(draw.missing({screen:"job",jobId:"cp-doesnotexist",section:null})).document;
 assert.deepEqual([...job404.querySelectorAll("h1")].map(e => e.textContent),["No job cp-doesnotexist"]);
 assert.equal(job404.querySelector(".page-header-fallback > p")?.textContent,"Jobs");
 assert.equal(job404.querySelector(".page-header-fallback > .page-header-detail")?.textContent,"cp-doesnotexist");
 // A worker 404 draws its own row: the one <h1> is Sessions, the id muted after it; the recovery title is an <h2>.
 const worker404 = parseHTML(draw.missing({screen:"sessions",section:null,query:"view=workers&id=cp-doesnotexist"})).document;
 assert.deepEqual([...worker404.querySelectorAll("h1")].map(e => e.textContent),["Sessions"]);
 assert.equal(worker404.querySelector(".page-header-fallback"), null, "the worker 404 row is its own header");
 assert.equal(worker404.querySelector(".not-found-heading .page-header-back")?.textContent,"← Sessions");
 assert.equal(worker404.querySelector(".not-found-heading > .page-header > .page-header-detail")?.textContent,"cp-doesnotexist");
 assert.equal(worker404.querySelector(".not-found-recovery > h2")?.textContent,"No worker session cp-doesnotexist");
 const {overview} = await import("../src/viewer/overview-view.ts");
 const {createScratchHome} = await import("./harness/index.ts");
 const home = createScratchHome();
 try {
  const page = parseHTML(draw.overview(overview({home:home.path,stateDir:join(home.path,".pi-command-post/state")}))).document;
  assert.deepEqual([...page.querySelectorAll("h1")].map(e => e.textContent),["Overview"]);
  const row = page.querySelector(".overview-heading .page-header:not(.page-header-fallback)")!;
  assert.ok(row.querySelector("h1 + .page-header-end > .shell-live + .shell-more"),"title, then status, then ⋮");
  assert.equal(page.querySelector(".page-header-fallback"), null, "no second header, no second ⋮");
  assert.equal(page.querySelectorAll(".shell-main .shell-more").length, 1);
 } finally { home.cleanup(); }
 // JobDetail: the job's title is the <h1>, its id follows muted; a long title is whole in the title attribute.
 const title = "A long job title ".repeat(12).trim();
 const jobView = {id:"cp-long",title,phase:"held",pr_url:null,pr_status:null,merge_sha:null,ci:null,review:null,review_attempts:0,head:null,summary:null,failure:null,model:null,script_path:null,context:null,routing:null,routing_facts:null,mandate_id:null,cost_usd:null,elapsed_seconds:null,limit_seconds:null};
 const detail = parseHTML(draw.job({job:jobView,questions:[],asks:[],reports:[],timeline:[],timeline_truncated:false,artifact_href:null,artifact_name:null,files_href:null,run_href:null})).document;
 const h1s = [...detail.querySelectorAll("h1")];
 assert.equal(h1s.length,1);
 assert.equal(h1s[0]!.getAttribute("title"),title);
 assert.equal(detail.querySelector(".job-detail-heading > .page-header > .page-header-detail")?.textContent,"cp-long");
});

test("fallback header survives a shell-only re-render and returns when the screen drops its header", async t => {
 const result = await build({stdin:{contents:'import {h,render} from "preact"; import {useState} from "preact/hooks"; import {act} from "preact/test-utils"; import {Shell} from "./viewer-app/components/Shell.tsx"; import {PageHeader} from "./viewer-app/components/PageHeader.tsx"; function Screen(){ const [on,setOn]=useState(true); return h("div",{class:"screen"}, h("button",{type:"button",class:"drop",onClick:()=>setOn(false)},"drop"), on && h(PageHeader,{title:"Overview"})); } export {act}; export const mount=root=>render(h(Shell,{current:{screen:"overview",section:null},awaiting:0,status:"live",updatedAt:"2026-10-07T08:30:00Z"}, h(Screen)), root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {act,mount,unmount}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const {window,document}=parseHTML("<html><body><div id='root'></div></body></html>");
 const originals=["window","document","fetch"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,"window",{configurable:true,value:window});
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 Object.defineProperty(globalThis,"fetch",{configurable:true,value:()=>Promise.resolve(new Response("{}",{status:503}))});
 window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as unknown as typeof window.matchMedia;
 const proto = window.Element.prototype as Element & {showModal?:() => void; close?:() => void};
 proto.showModal=()=>{};
 proto.close=()=>{};
 const root=document.getElementById("root")!;
 t.after(()=>{unmount(root); for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }});
 const menus=()=>root.querySelectorAll(".shell-main .shell-more").length;
 await act(()=>mount(root));
 await act(async()=>{await new Promise(done=>setImmediate(done));});
 assert.equal(root.querySelector(".page-header-fallback"),null);
 assert.equal(menus(),1,"one ⋮ in the screen header");
 root.querySelector<HTMLButtonElement>(".shell-search")!.focus=()=>{};
 await act(()=>root.querySelector<HTMLButtonElement>(".shell-search")!.click());
 await act(async()=>{await new Promise(done=>setImmediate(done));});
 assert.equal(root.querySelector(".page-header-fallback"),null,"opening search does not mount a second header");
 assert.equal(menus(),1);
 await act(()=>root.querySelector<HTMLButtonElement>(".drop")!.click());
 await act(async()=>{await new Promise(done=>setImmediate(done));});
 assert.ok(root.querySelector(".shell-main > .page-header-fallback"),"dropping the screen header brings the fallback back");
 assert.equal(root.querySelector(".screen .page-header"),null);
 assert.equal(menus(),1);
});

test("desktop page header CSS: a compact hairline row, transparent below 900 px, and no overlay hacks left", () => {
 const dirs = ["viewer-app/components","viewer-app/screens","viewer-app/styles"];
 for (const sheet of dirs.flatMap(dir => readdirSync(join(REPO_ROOT,dir)).filter(f => f.endsWith(".css")).map(f => `${dir}/${f}`))) {
  const css = readFileSync(join(REPO_ROOT,sheet),"utf8");
  assert.doesNotMatch(css,/margin-right: 248px|shell-page-bar|session-title|job-crumb|not-found-crumb/,sheet);
  assert.doesNotMatch(css,/z-index: 4; \}/,`${sheet}: no title-band overlay`);
 }
 const css = readFileSync(join(REPO_ROOT,"viewer-app/styles/shell.css"),"utf8");
 const at = css.indexOf("@media (min-width: 900px) {");
 const phone = css.slice(0,at), desktop = css.slice(at);
 assert.match(phone,/\.page-header \{ display: contents; \}/,"below 900 px the screen's own <h1> layout is unchanged");
 assert.match(phone,/\.page-header-back, \.page-header-detail, \.page-header-end, \.page-header-fallback \{ display: none; \}/);
 assert.doesNotMatch(phone,/\.shell-main:has\(> \.page-header-fallback\)/,"the fallback flex column is desktop-only");
 const row = /\n \.page-header \{([^}]*)\}/.exec(desktop)?.[1] ?? "";
 assert.match(row,/height: 48px/);
 assert.match(row,/border-bottom: 1px solid var\(--border\)/,"a hairline in the existing border token");
 assert.doesNotMatch(row,/background|position|z-index|margin/,"on the page surface, in flow");
 assert.match(desktop,/\.shell \.page-header > :is\(h1, p\) \{[^}]*font-size: 20px; font-weight: 600;[^}]*text-overflow: ellipsis;/);
 assert.match(desktop,/\.shell-main \{ min-width: 0; padding: 0 32px 48px; \}/,"the row sits at the top, in the content's horizontal padding");
 assert.match(desktop,/\.shell-main:has\(\.page-header:not\(\.page-header-fallback\)\) > \.page-header-fallback \{ display: none; \}/);
 assert.match(desktop,/--page-header-gap: 24px/);
 assert.match(desktop,/\.page-header-fallback \{ margin-bottom: var\(--page-header-gap\); \}/);
});
