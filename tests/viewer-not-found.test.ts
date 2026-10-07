import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import type { Route } from "../viewer-app/routes.ts";
import { REPO_ROOT } from "./harness/index.ts";
import type { FlightJob, OverviewResponse } from "../src/viewer/api-types.ts";
import type { NotFoundProps } from "../viewer-app/components/NotFound.tsx";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overview } from "../src/viewer/overview-view.ts";

const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {NotFound, notFoundFor} from "./viewer-app/components/NotFound.tsx"; export {notFoundFor}; export const html=(props)=>render(h(NotFound,props));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
const {notFoundFor, html} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	notFoundFor: (route: Route, code: number | undefined, workers?: FlightJob[]) => NotFoundProps | null;
	html: (props: NotFoundProps) => string;
};

const job = (jobId: string): Route => ({screen:"job", jobId, section:null});
const workers = (id: string): Route => ({screen:"sessions", section:null, query:`view=workers&id=${id}`});

test("notFoundFor maps only a 404 job or worker session", () => {
	const missing = notFoundFor(job("cp-x"), 404);
	assert.equal(missing?.title, "No job cp-x");
	assert.equal(missing?.back.href, "#jobs");
	assert.equal(missing?.back.label, "Back to Jobs");
	const worker = notFoundFor(workers("cp-w"), 404);
	assert.equal(worker?.title, "No worker session cp-w");
	assert.equal(worker?.back.href, "#sessions");
	for (const code of [403, 500, undefined]) assert.equal(notFoundFor(job("cp-x"), code), null, String(code));
	assert.equal(notFoundFor({screen:"sessions", section:null, query:"view=you&id=cp-w"}, 404), null);
	assert.equal(notFoundFor({screen:"jobs", section:null}, 404), null);
});

test("NotFound render has the back link and no alert", () => {
	const page = html(notFoundFor(job("cp-x"), 404)!);
	assert.match(page, /href="#jobs"/);
	assert.match(page, /Back to Jobs/);
	assert.match(page, /Search jobs/);
	assert.doesNotMatch(page, /role="alert"/);
});


const flight = (id: string, phase: string, script_path: string | null = null): FlightJob => ({id,phase,script_path,project:"picp",title:"A long fixture title ".repeat(20),model:null,elapsed_seconds:null,limit_seconds:null,head:null,ci:null,review:null,review_attempts:0,routing:null,note:null});

test("404 recovery has circular kind-specific icons and only observed worker alternatives", () => {
	const known = [flight("cp-working","working"),flight("cp-launching","launching"),...['waiting','idle','held','done','failed','queued'].map(phase=>flight(`cp-${phase}`,phase)),flight("cp-script","working","script.ts")];
	const doc = parseHTML(html(notFoundFor(workers("cp-missing"),404,known)!)).document;
	assert.equal(doc.querySelector(".not-found-heading h1")?.textContent,"Sessions");
	assert.equal(doc.querySelector(".not-found-heading .page-header-back")?.textContent,"← Sessions");
	assert.equal(doc.querySelector(".not-found-heading .page-header-back")?.getAttribute("href"),"#sessions");
	assert.equal(doc.querySelector(".not-found-heading .page-header-detail")?.textContent,"cp-missing");
	assert.equal(doc.querySelector(".not-found-back")?.getAttribute("href"),"#sessions");
	assert.ok(doc.querySelector('.not-found-illustration[aria-hidden="true"] svg path'));
	const links = [...doc.querySelectorAll(".not-found-workers a")];
	assert.deepEqual(links.map(e=>e.getAttribute("href")),["#sessions?view=workers&id=cp-working","#sessions?view=workers&id=cp-launching"]);
	assert.ok(links.every(e=>e.textContent?.includes("picp") && e.querySelector("code")));
	assert.doesNotMatch(doc.toString(), /role="alert"|style=|onclick=/i);
	for (const evidence of [undefined,[],[flight("cp-idle","idle")]]) {
		assert.equal(parseHTML(html(notFoundFor(workers("cp-x"),404,evidence)!)).document.querySelector(".not-found-workers"),null,"unknown or inactive evidence gives no suggestions");
	}
	const jobDoc = parseHTML(html(notFoundFor(job("cp-x"),404,known)!)).document;
	assert.ok(jobDoc.querySelector('.not-found-illustration svg circle'));
	assert.equal(jobDoc.querySelector("h1")?.textContent,"No job cp-x");
	assert.equal(jobDoc.querySelector(".not-found-workers"),null);
});

test("404 CSS keeps phone targets and provides a wider desktop recovery with horizontal actions", () => {
	const css = readFileSync(join(REPO_ROOT,"viewer-app/components/not-found.css"),"utf8");
	assert.match(css,/\.not-found-illustration \{[^}]*border-radius: 50%/);
	assert.match(css,/\.not-found-actions a, \.not-found-actions button \{[^}]*min-height: 44px/);
	const desktop = css.split("@media (min-width: 900px) {")[1]!;
	assert.match(desktop,/\.not-found-recovery \{[^}]*max-width: 468px/);
	assert.match(desktop,/\.not-found-actions \{[^}]*flex-direction: row/);
	assert.match(desktop,/\.not-found-heading \.page-header-back \{ display: none/);
	const phone = css.split("@media (max-width: 899px)")[1]!.split("@media")[0]!;
	assert.match(phone,/\.not-found-heading \.page-header-detail \{ display: block/);
	assert.match(phone,/\.page-header > h1 \{[^}]*clip-path: inset\(50%\)/);
	assert.doesNotMatch(phone,/\.page-header > h1[^{]*display:\s*none/);
	assert.match(phone,/\.page-header-back::after \{ content: "\/"/);
});


test("App passes known overview workers to a 404; unavailable evidence and other errors never invent recovery links", async t => {
	const built=await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {App} from "./viewer-app/app.tsx"; export {act}; export const mount=root=>render(h(App,{}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
	const {act,mount,unmount}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);
	const {window,document}=parseHTML("<html><body><div id='root'></div></body></html>");
	const originals=["window","document","location","fetch","EventSource"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
	const root=document.getElementById("root")!;
	const requests:string[]=[];
	let data:OverviewResponse=overview({home:"/nonexistent",stateDir:"/nonexistent"});
	let code=404;
	const globals={window,document,location:{hash:"#sessions?view=workers&id=cp-missing"},EventSource:class extends EventTarget {close() {}},fetch:async (url:string) => {
		requests.push(url);
		return new Response(JSON.stringify(url==="/api/overview" ? data : {error:"unavailable"}),{status:url==="/api/overview" ? 200 : url.startsWith("/api/sessions?") ? code : 503});
	}};
	for(const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{configurable:true,value});
	t.after(()=>{unmount(root);for(const [key,descriptor] of originals) {if(descriptor) Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
	const render = async () => {await act(()=>unmount(root));await act(()=>mount(root));await act(async()=>{await new Promise(done=>setImmediate(done));});};
	data={...data,availability:{...data.availability,fleet:"ok",ledger:"ok"},in_flight:[flight("cp-working","working"),flight("cp-idle","idle")]};
	await render();
	assert.equal(root.querySelector(".not-found-workers a")?.getAttribute("href"),"#sessions?view=workers&id=cp-working");
	assert.equal(root.querySelectorAll(".not-found-workers a").length,1);
	for(const source of ["fleet","ledger"] as const) {
		const available=data.availability;
		data={...data,availability:{...available,[source]:"unavailable"}};
		await render();assert.ok(root.querySelector(".not-found"));assert.equal(root.querySelector(".not-found-workers"),null,source);
		data={...data,availability:available};
	}
	for(code of [403,500]) {await render();assert.equal(root.querySelector(".not-found"),null,String(code));assert.match(root.textContent ?? "",/View unavailable/);}
	assert.ok(requests.some(url=>url==="/api/overview"));
	assert.ok(requests.filter(url=>url.startsWith("/api/sessions?")).every(url=>!url.includes("transcript")),"suggestions use Overview, never a transcript lookup");
});
