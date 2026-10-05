import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { join } from "node:path";
import { overview } from "../src/viewer/overview-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const bundle = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Shell} from "./viewer-app/components/Shell.tsx"; export {act}; export const mount=(root,screen="overview")=>render(h(Shell,{current:{screen,section:null,classic:null},awaiting:0,status:"live",updated:null},"Content"),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`);

test("shell search filters navigation and recorded in-flight jobs with keyboard and request cleanup", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const data = overview({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 data.in_flight = [{id:"cp-search",title:"Repair <script>queue</script>",project:"demo",phase:"held",model:null,script_path:null,elapsed_seconds:null,limit_seconds:null,head:null,ci:null,review:null,review_attempts:0,routing:null,note:null}];
 const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
 const originals = ["window","document","fetch"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for (const [key,value] of [["window",window],["document",document]] as const) Object.defineProperty(globalThis,key,{configurable:true,value});
 const root = document.getElementById("root")!;
 // Linkedom lacks native dialog and focus behavior; keep component event handlers real.
 const listeners = new WeakMap<object,WeakMap<object,EventListener>>();
 const add = window.EventTarget.prototype.addEventListener;
 const remove = window.EventTarget.prototype.removeEventListener;
 t.mock.method(window.EventTarget.prototype,"addEventListener",function(this:EventTarget,type:string,listener:EventListener,options?:boolean | AddEventListenerOptions) {
  let bound = listeners.get(this); if (!bound) listeners.set(this,bound = new WeakMap());
  if (!bound.has(listener)) bound.set(listener,listener.bind(this));
  add.call(this,type,bound.get(listener)!,options);
 });
 t.mock.method(window.EventTarget.prototype,"removeEventListener",function(this:EventTarget,type:string,listener:EventListener,options?:boolean | EventListenerOptions) {
  remove.call(this,type,listeners.get(this)?.get(listener) ?? listener,options);
 });
 let focused: Element | null = document.body;
 Object.defineProperty(document,"activeElement",{configurable:true,get:() => focused});
 window.HTMLElement.prototype.focus = function() { focused = this; };
 Object.assign(window.HTMLElement.prototype,{
  showModal(this:HTMLElement) { this.setAttribute("open",""); },
  close(this:HTMLElement) { this.removeAttribute("open"); },
 });
 const requests: {signal:AbortSignal;resolve:(response:Response)=>void}[] = [];
 Object.defineProperty(globalThis,"fetch",{configurable:true,value:(url:string,init:{signal:AbortSignal}) => {
  // The shell's version badge reads /api/version on mount (cp-kz20); it is not search's request.
  if (url === "/api/version") return new Promise<Response>(() => {});
  assert.equal(url,"/api/overview");
  return new Promise<Response>(resolve => requests.push({signal:init.signal,resolve}));
 }});
 t.after(async () => { await act(() => unmount(root)); for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } });
 const click = (node:Element) => act(() => node.dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true})));
 const key = (node:EventTarget,key:string,modifiers:Record<string,boolean>={}) => act(() => {
  const event = new window.Event("keydown",{bubbles:true,cancelable:true}); Object.assign(event,{key,...modifiers}); node.dispatchEvent(event);
 });
 const query = (value:string) => act(() => { const input = root.querySelector("input")!; input.value = value; input.dispatchEvent(new window.Event("input",{bubbles:true})); });
 const answer = (response:Response) => act(async () => { requests.at(-1)!.resolve(response); await new Promise<void>(resolve => setImmediate(resolve)); });
 const results = () => [...root.querySelectorAll("dialog a")];
 const close = () => click(root.querySelector('dialog button[aria-label="Close search"]')!);

 await act(() => mount(root));
 assert.equal(requests.length,0,"closed search does not fetch");
 const trigger = root.querySelector(".shell-search")!;
 await click(trigger);
 assert.ok(root.querySelector("dialog[open]"),"header search opens a modal dialog");
 assert.equal(focused,root.querySelector("input"));
 assert.match(root.querySelector("dialog")!.textContent!,/Loading/);
 assert.equal(requests.length,1);
 await answer(Response.json(data));
 // Audit P4 #28: the route table is 10 entries after the nav consolidation, plus the one in-flight job.
 assert.equal(results().length,11);
 assert.equal(root.querySelector("dialog script"),null,"job titles render as text");
 await query("  QUEUE  ");
 assert.deepEqual(results().map(node => node.getAttribute("href")),["#job/cp-search"]);
 await query("CP-SEARCH"); assert.equal(results().length,1);
 await query("files"); assert.deepEqual(results().map(node => node.getAttribute("href")),["#files"]);
 await query("decisions"); assert.deepEqual(results().map(node => node.getAttribute("href")),["#decisions"]);
 for (const gone of ["awaiting","decided"]) { await query(gone); assert.equal(results().length,0,`no separate ${gone} entry`); }
 await query("sessions"); assert.deepEqual(results().map(node => node.getAttribute("href")),["#sessions"]);
 await query("no match"); assert.equal(results().length,0); assert.match(root.querySelector("dialog")!.textContent!,/No results/);
 await key(root.querySelector("input")!,"ArrowDown");
 await query("");
 await key(root.querySelector("input")!,"ArrowDown"); assert.equal(focused,results()[0]);
 await key(focused!,"ArrowDown"); assert.equal(focused,results()[1]);
 await key(focused!,"ArrowUp"); assert.equal(focused,results()[0]);
 await close(); assert.equal(root.querySelector("dialog"),null); assert.equal(focused,trigger);
 assert.equal(requests[0]!.signal.aborted,true);

 // Desktop trigger and Escape's native cancel event restore their own opener.
 const desktop = root.querySelector(".shell-desktop-search")!;
 await click(desktop);
 await act(() => root.querySelector("dialog")!.dispatchEvent(new window.Event("cancel",{cancelable:true})));
 assert.equal(root.querySelector("dialog"),null); assert.equal(focused,desktop);
 const old = requests.at(-1)!;
 assert.equal(old.signal.aborted,true);

 for (const modifier of ["ctrlKey","metaKey"]) {
  await key(window,"k",{[modifier]:true});
  assert.ok(root.querySelector("dialog[open]"));
  await answer(Response.json(data));
  await query("jobs");
  let selected:string | null = null;
  root.querySelector("dialog a")!.addEventListener("click",event => { selected = (event.currentTarget as Element).getAttribute("href"); event.preventDefault(); });
  await key(root.querySelector("input")!,"Enter");
  assert.equal(selected,"#jobs"); assert.equal(root.querySelector("dialog"),null);
 }
 await click(trigger);
 await answer(new Response("failure",{status:503}));
 assert.match(root.querySelector("dialog")!.textContent!,/In-flight jobs unavailable/);
 assert.equal(results().length,10,"navigation remains usable on job fetch failure");
 await close();
 await click(trigger);
 await act(async () => { old.resolve(Response.json(data)); await new Promise<void>(resolve => setImmediate(resolve)); });
 assert.match(root.querySelector("dialog")!.textContent!,/Loading/);
 assert.equal(results().length,10,"late data from a closed dialog cannot appear in a new search");
 data.availability.fleet = "unavailable"; data.in_flight = [];
 await answer(Response.json(data));
 assert.match(root.querySelector("dialog")!.textContent!,/In-flight jobs unavailable/);
 await close();

 for (const screen of ["jobs","job","board","map","decisions","files"]) {
  await act(() => mount(root,screen));
  assert.ok(root.querySelector(".shell-search"),`mobile search remains available on ${screen}`);
 }
 await click(root.querySelector(".shell-search")!);
 await act(() => unmount(root));
 assert.equal(requests.at(-1)!.signal.aborted,true);
 await key(window,"k",{ctrlKey:true}); assert.equal(root.textContent,"");
});
