import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { build } from "esbuild";
import { test } from "node:test";
import { join } from "node:path";
import { awaitingScreen, decidedScreen, decisionsScreen } from "../src/viewer/decision-views.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("Awaiting and Decided render truthful empty, unavailable, provenance and filtered states", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h,render as domRender} from "preact"; import {act} from "preact/test-utils"; import render from "preact-render-to-string"; import {AwaitingScreen} from "./viewer-app/screens/Awaiting.tsx"; import {DecidedScreen,filterDecisions} from "./viewer-app/screens/Decided.tsx"; export const screen=(data,decided=false)=>render(h(decided?DecidedScreen:AwaitingScreen,{data})); export {filterDecisions,act}; export const mount=(root,data)=>domRender(h(DecidedScreen,{data}),root); export const unmount=root=>domRender(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen,filterDecisions,act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const state = {home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const awaiting = awaitingScreen(state); const decided = decidedScreen(state);
 assert.match(screen(awaiting),/Nothing needs you/); assert.match(screen(awaiting),/What comes here/);
 assert.equal((screen(awaiting).match(/decided today/gi) ?? []).length,1,"the decided-today count shows once: no Handled without you aside"); assert.match(screen(awaiting),/0 decided today · 0 for you, 0 by you/); assert.doesNotMatch(screen(awaiting),/worth a look/); assert.doesNotMatch(screen(awaiting),/Handled without you/);
 assert.match(screen(decided,true),/Nothing here for this filter/); assert.doesNotMatch(screen(decided,true),/What comes here|Always asks you about|decision-kinds/,"the kinds list lives on Awaiting only");
 awaiting.availability.asks = "unavailable"; awaiting.awaiting_count = null;
 assert.match(screen(awaiting),/Questions unavailable/); assert.doesNotMatch(screen(awaiting),/Nothing needs you/);
 decided.availability.escalations = "unavailable";
 assert.match(screen(decided,true),/Decisions unavailable/); assert.doesNotMatch(screen(decided,true),/Nothing here for this filter/);
 awaiting.availability.asks = "ok"; awaiting.awaiting_count = 1;
 awaiting.items = [{id:"ask-aa",project:"demo",question:"<script>Raise cap?</script>",created_at:awaiting.generated_at,options:[{label:"Keep",consequence:"Paused",reply:"ask-aa: Keep"}],recommendation:"Keep",source_escalation:"es-open",job_ids:["cp-demo"],context:null,evidence_paths:[],reason:"Not delegated",source_created_at:awaiting.generated_at,mandate_id:null,mandate_status:null,spend:null,spend_cap:null,mandate_objective:null,jobs:[],escalation:null,evidence:[]}];
 const html = screen(awaiting); assert.match(html,/>Keep<\/strong>/); assert.doesNotMatch(html,/ask-aa: Keep|Copy a reply/); assert.match(html,/&lt;script>/); assert.match(html,/Where it came from/); assert.match(html,/Not delegated/);
 assert.doesNotMatch(html,/<script>|style=|onclick=/i);
 assert.match(html,/href="#sessions\?view=parent"/);
 assert.doesNotMatch(html,/\/classic/);
 decided.availability.escalations = "ok";
 decided.items = [{id:"es-risk",question:"Risk?",answer:"Proceed",quote:"yes",answered_at:decided.generated_at,job_ids:["cp-demo"],source:"operator-delegated",project:null,source_escalation:"es-risk",rule:"Evidence clears it",worth:["risk"],today:true,kind:"risk_high_irreversible",basis:{kind:"words",ref:"Evidence clears it"}}, {id:"ask-bb",question:"Older human answer",answer:"Keep",quote:"Keep",answered_at:decided.generated_at,job_ids:[],source:"you",project:"demo",source_escalation:null,rule:null,worth:[],today:false,kind:null,basis:{kind:"words",ref:"ask-bb"}}];
 assert.deepEqual(filterDecisions(decided.items,"today",false).map((d:{id:string}) => d.id),["es-risk"]);
 assert.deepEqual(filterDecisions(decided.items,"all",false).map((d:{id:string}) => d.id),["es-risk","ask-bb"]);
 assert.deepEqual(filterDecisions(decided.items,"all",true).map((d:{id:string}) => d.id),["es-risk"]);
 assert.match(screen(decided,true),/Evidence clears it/); assert.match(screen(decided,true),/risk/);
 assert.doesNotMatch(screen(decided,true),/Older human answer/);
 for (const quote of ["Remove it with a normal revert commit.","Proceed",null]) {
  const item = {...decided.items[0]!,question:"A long recorded question ".repeat(30),quote};
  const doc = parseHTML(screen({...decided,items:[item]},true)).document;
  assert.equal(doc.querySelector(".decided-question")?.getAttribute("title"),item.question);
  assert.equal(doc.querySelector(".decided-answer span")?.textContent ?? null,quote === null ? null : `\u201c${quote}\u201d`);
 }
 // Audit P2 #16: evidence opens the decision's job; a jobless decision falls back to the parent transcript.
 assert.match(screen(decided,true),/<a href="#job\/cp-demo"><span class="decision-phone">evidence/); assert.doesNotMatch(screen(decided,true),/href="#sessions\?view=parent"/);
 assert.match(screen({...decided,items:[{...decided.items[0]!,job_ids:[]}]},true),/href="#sessions\?view=parent"/);
 // Audit P2 #13: the header's "decided for you" is the Awaiting count; your own answers today are counted apart.
 const mine = {...decided,items:[decided.items[0]!,{...decided.items[1]!,today:true}]};
 assert.match(screen(mine,true),/Decided for you 1/); assert.match(screen(mine,true),/Answered by you 1/);
 assert.match(screen(mine,true),/role="tablist"/); assert.match(screen(mine,true),/aria-selected="true"/); assert.match(screen(mine,true),/aria-controls="decided-panel-for"/); assert.match(screen(mine,true),/role="tabpanel"/); assert.match(screen(mine,true),/tabindex="0"/); assert.match(screen(mine,true),/tabindex="-1"/); assert.match(screen(mine,true),/your words/);
 assert.doesNotMatch(screen(decided,true),/\/classic/);
 const {window,document} = parseHTML("<html><body><main></main></body></html>");
 const originals = ["window","document"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,"window",{configurable:true,value:window});
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 t.after(() => { for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } });
 const root = document.querySelector("main")!;
 await act(() => mount(root,decided));
 const button = (label:string) => [...root.querySelectorAll("button")].find(b => b.textContent === label)!;
 const key = (k:string) => { const e = new window.Event("keydown",{bubbles:true,cancelable:true}); Object.defineProperty(e,"key",{value:k}); return e; };
 const tab = (name:string) => [...root.querySelectorAll("[role=tab]")].find(b => b.textContent?.startsWith(name))!;
 await act(() => button("All").dispatchEvent(new window.Event("click",{bubbles:true})));
 assert.equal(button("All").getAttribute("aria-pressed"),"true");
 assert.doesNotMatch(root.textContent!,/Older human answer/,"All stays on the for-you tab");
 assert.equal(tab("Decided for you").getAttribute("aria-selected"),"true");
 assert.equal(tab("Decided for you").getAttribute("tabIndex"),"0");
 assert.equal(tab("Answered by you").getAttribute("tabIndex"),"-1");
 assert.equal(tab("Decided for you").getAttribute("aria-controls"),root.querySelector("[role=tabpanel]")?.id);
 await act(() => tab("Decided for you").dispatchEvent(key("ArrowRight")));
 assert.equal(tab("Answered by you").getAttribute("aria-selected"),"true");
 assert.equal(tab("Answered by you").getAttribute("tabIndex"),"0");
 assert.match(root.textContent!,/Older human answer/); assert.match(root.textContent!,/your reply/); assert.match(root.textContent!,/answered by you/);
 await act(() => button("Worth a look only").dispatchEvent(new window.Event("click",{bubbles:true})));
 assert.match(root.textContent!,/Older human answer/,"worth applies only to the for-you tab");
 await act(() => tab("Answered by you").dispatchEvent(key("ArrowLeft")));
 assert.equal(tab("Decided for you").getAttribute("aria-selected"),"true");
 assert.doesNotMatch(root.textContent!,/Older human answer/);
 assert.match(root.textContent!,/Evidence clears it/);
 await act(() => mount(root,{...decided,items:decided.items.filter((d:{worth:string[]}) => !d.worth.length)}));
 assert.match(root.textContent!,/own judgement appear here/);
 assert.match(root.textContent!,/rests on your words or a standing order/);
 await act(() => button("Worth a look only").dispatchEvent(new window.Event("click",{bubbles:true})));
 assert.match(root.textContent!,/Nothing here for this filter/);
 await act(() => tab("Answered by you").dispatchEvent(new window.Event("click",{bubbles:true})));
 assert.match(root.textContent!,/Older human answer/);
 // Audit P1 #6: a day's mission-end closes fold into one line; a single close stays a row; show expands them.
 const close = (id:string) => ({...decided.items[0]!,id,question:`${id}: every job it names is closed`,worth:[],kind:"mission_end"});
 const folded = {...decided,items:[close("md-aaaa"),decided.items[0]!,close("md-bbbb"),close("md-cccc")]};
 const foldedHtml = screen(folded,true);
 assert.match(foldedHtml,/3 mandate closes<button[^>]*>show<\/button>/); assert.doesNotMatch(foldedHtml,/md-aaaa|md-bbbb|md-cccc/); assert.match(foldedHtml,/Evidence clears it/);
 assert.match(foldedHtml,/Decided for you 4/,"the tab count still counts every close");
 assert.match(screen({...decided,items:[close("md-solo"),decided.items[0]!]},true),/md-solo: every job/,"one close alone is not folded");
 await act(() => mount(root,folded));
 await act(() => tab("Decided for you").dispatchEvent(new window.Event("click",{bubbles:true})));
 await act(() => button("All").dispatchEvent(new window.Event("click",{bubbles:true})));
 await act(() => button("show").dispatchEvent(new window.Event("click",{bubbles:true})));
 for (const id of ["md-aaaa","md-bbbb","md-cccc"]) assert.match(root.textContent!,new RegExp(id)); assert.doesNotMatch(root.textContent!,/mandate closes/);
 await act(() => unmount(root));
});

test("audit P4 #24 #26: one Decisions page stacks Awaiting, a collapsed Being handled line and the Decided log; the badge rides on Decisions", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Decisions} from "./viewer-app/screens/Decisions.tsx"; import {Shell} from "./viewer-app/components/Shell.tsx"; export const page=(data)=>render(h(Decisions,{data})); export const shell=(screen,awaiting)=>render(h(Shell,{current:{screen,section:null},awaiting,status:"live",updated:null}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {page,shell} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const data = decisionsScreen({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 const empty = page(data);
 assert.equal((empty.match(/<h1>/g) ?? []).length,1,"one page title"); assert.match(empty,/<h1>Decisions<\/h1>/);
 assert.match(empty,/Nothing needs you/); assert.match(empty,/Nothing here for this filter/); assert.doesNotMatch(empty,/Being handled/,"no parent questions: no Being handled line");
 const at = (html:string,needle:string) => { const i = html.indexOf(needle); assert.ok(i >= 0,needle); return i; };
 assert.ok(at(empty,'id="awaiting"') < at(empty,'id="decided"'),"Awaiting sits above the Decided log");
 assert.doesNotMatch(empty,/id="answers"/,"no answers journal: no Answers section");
 data.answers = {availability:"ok",open:[{id:"ans-aaaaaaaaaaaa",project:"demo",question:"What?",answer:"Because.",short:"Because.",posted_at:data.generated_at,acked_at:null,job:null,evidence:[],links:{}}],open_count:1,history:[],history_total:0,warning:null};
 const withAnswers = page(data);
 assert.ok(at(withAnswers,'id="awaiting"') < at(withAnswers,'id="answers"') && at(withAnswers,'id="answers"') < at(withAnswers,'id="decided"'),"Answers sit between Awaiting and the Decided log");
 data.parent_questions = [{id:"es-a",question:"Close md-x?",kind:"mission_end",created_at:data.generated_at,job_ids:["cp-a"],age_seconds:3470},{id:"es-b",question:"q",kind:"mission_end",created_at:data.generated_at,job_ids:[],age_seconds:60}];
 data.decided = [{id:"es-risk",question:"Risk?",answer:"Proceed",quote:null,answered_at:data.generated_at,job_ids:["cp-demo"],source:"operator-delegated",project:null,source_escalation:"es-risk",rule:"Evidence clears it",worth:[],today:true,kind:null}];
 const html = page(data);
 assert.match(html,/<details class="decisions-handled decisions-handled-overdue"><summary>Being handled · 2<span> \(oldest 57m\)<\/span><\/summary>/,"collapsed, count and oldest age, amber past 10 minutes");
 assert.ok(at(html,'id="awaiting"') < at(html,"Being handled") && at(html,"Being handled") < at(html,'id="decided"'));
 assert.match(html,/Close md-x\?/); assert.match(html,/Evidence clears it/); assert.doesNotMatch(html,/Nothing here for this filter/);
 data.availability.escalations = "unavailable"; data.parent_questions = [];
 assert.match(page(data),/Being handled · -/); assert.match(page(data),/Parent questions unavailable/);
 // The awaiting badge sits on Decisions in the sidebar and the tab bar, never on Overview.
 const doc = parseHTML(shell("decisions",3)).document;
 for (const label of ["Desktop primary","Primary"]) {
  const links = [...doc.querySelectorAll(`nav[aria-label="${label}"] a`)];
  assert.deepEqual(links.filter(a => a.querySelector(".shell-count")).map(a => [a.getAttribute("href"),a.querySelector(".shell-count")!.textContent]),[["#decisions","3"]],label);
  assert.deepEqual(links.filter(a => a.getAttribute("aria-current") === "page").map(a => a.getAttribute("href")),["#decisions"],label);
 }
 assert.equal(parseHTML(shell("decisions",0)).document.querySelector(".shell-count"),null);
});
