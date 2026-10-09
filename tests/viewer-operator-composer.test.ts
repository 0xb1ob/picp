/** cp-p56a: the composer's Enter sends (followUp while busy), Shift+Enter stays a newline, IME Enter never sends. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import type { ControlBody, ControlView } from "../viewer-app/control.ts";
import { REPO_ROOT } from "./harness/index.ts";
import type { ThreadsView } from "../viewer-app/threads.ts";
import { composerHref, route, screenDataUrl } from "../viewer-app/routes.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {OperatorComposer,COMPOSER_PLACEHOLDER} from "./viewer-app/components/OperatorComposer.tsx"; export {act,COMPOSER_PLACEHOLDER}; export const mount=(root,control,draft,thread)=>render(h(OperatorComposer,{control,draft,thread}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {act,mount,unmount,COMPOSER_PLACEHOLDER} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
 act: (fn: () => unknown) => Promise<void>; mount: (root: unknown, control: ControlView, draft?: string, thread?: ThreadsView) => void; unmount: (root: unknown) => void; COMPOSER_PLACEHOLDER: string;
};

const ready: ControlStatusResponse = { generated_at: "2026-09-27T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false } };

test("composer: Enter sends, Shift+Enter and IME Enter do not, and the hint says so", async t => {
	const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
	const originals = ["window","document"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
	Object.defineProperty(globalThis,"window",{configurable:true,value:window});
	Object.defineProperty(globalThis,"document",{configurable:true,value:document});
	t.after(() => { for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } });
	const root = document.getElementById("root")!;
	const sends: ControlBody[] = [];
	const control = (busy: boolean, delivery: ControlView["delivery"] = null): ControlView => ({ status: { ...ready, busy }, delivery, send: body => { sends.push(body); } });

	const textarea = () => root.querySelector("textarea")!;
	const open = async (busy: boolean, delivery: ControlView["delivery"] = null) => { sends.length = 0; await act(() => mount(root, control(busy, delivery))); };
	const type = async (value: string) => { textarea().value = value; await act(() => textarea().dispatchEvent(new window.Event("input",{bubbles:true}))); };
	const press = async (init: {key?: string; shiftKey?: boolean; ctrlKey?: boolean; isComposing?: boolean; keyCode?: number} = {}) => {
		const event = new window.Event("keydown",{bubbles:true,cancelable:true});
		Object.defineProperties(event,{key:{value:init.key ?? "Enter"},shiftKey:{value:!!init.shiftKey},ctrlKey:{value:!!init.ctrlKey},isComposing:{value:!!init.isComposing},keyCode:{value:init.keyCode ?? 0}});
		await act(() => textarea().dispatchEvent(event));
		return event;
	};

	await open(true);
	assert.equal(textarea().getAttribute("placeholder"), COMPOSER_PLACEHOLDER, "one placeholder, busy or not");
	assert.ok(COMPOSER_PLACEHOLDER.length <= 26, `"${COMPOSER_PLACEHOLDER}" must fit the one-row box at 390px: the busy row leaves ~244px for 15px text`);
	assert.equal(textarea().getAttribute("title"), "Enter sends · Shift+Enter for a new line", "the tooltip still spells Enter out");
	assert.equal(textarea().getAttribute("rows"), "1", "one row until it grows");
	await type("ship it");
	await press();
	assert.deepEqual(sends,[{kind:"message",text:"ship it",deliver:"followUp"}], "Enter while busy follows up after this turn");
	await act(() => unmount(root));

	await open(false);
	await type("hello");
	await press();
	assert.deepEqual(sends,[{kind:"message",text:"hello"}], "Enter while idle is a plain send");
	await type("hello");
	await press({ctrlKey:true});
	assert.deepEqual(sends,[{kind:"message",text:"hello"},{kind:"message",text:"hello"}], "Ctrl+Enter sends like Enter");
	await act(() => unmount(root));

	await open(true);
	await type("line one");
	await press({shiftKey:true});
	assert.deepEqual(sends,[], "Shift+Enter leaves a newline, it does not send");
	await press({isComposing:true});
	assert.deepEqual(sends,[], "Enter while an IME composes does not send");
	await press({keyCode:229});
	assert.deepEqual(sends,[], "keyCode 229 (IME) does not send");
	await type("   ");
	await press();
	assert.deepEqual(sends,[], "Enter with no text does not send");
	await act(() => unmount(root));

	await open(false,{id:null,state:"sending",reason:null,ask_id:null});
	await type("again");
	await press();
	assert.deepEqual(sends,[], "a send in flight is left alone");
	await act(() => unmount(root));

	// The round send button does what Enter does; steer and a confirm-tap abort live in the busy ⋯ menu.
	const click = (selector: string) => act(() => { root.querySelector(selector)!.dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true})); });
	await open(true);
	await type("after");
	await click(".operator-composer-send");
	assert.deepEqual(sends,[{kind:"message",text:"after",deliver:"followUp"}], "send while busy follows up");
	await type("now");
	await click(".operator-composer-menu button");
	assert.deepEqual(sends.at(-1),{kind:"message",text:"now",deliver:"steer"}, "Steer now steers");
	await click(".operator-composer-abort");
	assert.equal(sends.length,2, "the first abort tap only arms it");
	assert.equal(root.querySelector(".operator-composer-abort")!.textContent,"Tap again to abort");
	await click(".operator-composer-abort");
	assert.deepEqual(sends.at(-1),{kind:"abort"}, "the confirm tap aborts");
	assert.equal(root.querySelector(".operator-composer-abort")!.textContent,"Abort turn", "and disarms again");
	await act(() => unmount(root));

	await open(false);
	assert.equal(root.querySelector(".operator-composer-more"),null, "idle: no steer/abort menu");
	await type("plain");
	await click(".operator-composer-send");
	assert.deepEqual(sends,[{kind:"message",text:"plain"}], "send while idle is a plain send");
	await act(() => unmount(root));
});

test("composer: a draft (the Schedules page's Add schedule…) fills the textarea, clipped to the text cap", async t => {
	const {document} = parseHTML("<html><body><div id='root'></div></body></html>");
	const original = Object.getOwnPropertyDescriptor(globalThis,"document");
	Object.defineProperty(globalThis,"document",{configurable:true,value:document});
	t.after(() => { if (original) Object.defineProperty(globalThis,"document",original); else Reflect.deleteProperty(globalThis,"document"); });
	const root = document.getElementById("root")!;
	const control: ControlView = { status: ready, delivery: null, send: () => {} };
	await act(() => mount(root, control, "Add a schedule (cp_schedule add): name …"));
	assert.equal(root.querySelector("textarea")!.value, "Add a schedule (cp_schedule add): name …");
	await act(() => unmount(root));
	await act(() => mount(root, control, "x".repeat(16_500)));
	assert.equal(root.querySelector("textarea")!.value.length, 16_000);
	await act(() => unmount(root));
});

test("failure question draft stays editable and unsent in the selected thread, online or offline", async t => {
 const {window,document}=parseHTML("<html><body><div id='root'></div></body></html>");
 const original=Object.getOwnPropertyDescriptor(globalThis,"document");
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 const root=document.getElementById("root")!;
 t.after(()=>{unmount(root);if(original) Object.defineProperty(globalThis,"document",original);else Reflect.deleteProperty(globalThis,"document");});
 const draft="Explain why picp job cp-render failed and the available recovery options.";
 const current=route(composerHref(draft));
 assert.equal(current.screen,"sessions");
 assert.equal(screenDataUrl(current),"/api/sessions?view=you&transcript=1","draft never reaches the read API");
 const threads:ThreadsView={status:{generated_at:ready.generated_at,availability:"missing",enabled:true,reason:null,token:"fixture-only",threads:[],total:0,warning:null},selected:"recovery",select:()=>assert.fail("navigation must preserve the selected thread"),done:()=>{},sending:null,failed:null};
 for(const offline of [false,true]) {
  const sends:ControlBody[]=[];
  const control:ControlView={status:{...ready,running:!offline,offline,token:offline ? null : ready.token,inbox_token:offline ? "i".repeat(64) : null},delivery:null,send:body=>{sends.push(body);}};
  await act(()=>mount(root,control,new URLSearchParams(current.query).get("draft")!,threads));
  const textarea=root.querySelector("textarea")!;
  assert.equal(textarea.value,draft);assert.equal(textarea.disabled,false);
  assert.match(root.querySelector(".operator-composer-options > summary")?.textContent ?? "",/Thread · recovery/);
  assert.deepEqual(sends,[],"opening the link never sends");
  textarea.value=`${draft} Include the recorded cause.`;
  await act(()=>textarea.dispatchEvent(new window.Event("input",{bubbles:true})));
  assert.deepEqual(sends,[],"editing never sends");
  await act(()=>root.querySelector(".operator-composer-send")!.dispatchEvent(new window.Event("click",{bubbles:true})));
  assert.deepEqual(sends,[{kind:"message",text:`${draft} Include the recorded cause.`,thread:"recovery"}]);
  await act(()=>unmount(root));
 }
});

test("composer: the filename and thread picker live in compact, closed message options", async t => {
 const {document} = parseHTML("<html><body><div id='root'></div></body></html>");
 const original = Object.getOwnPropertyDescriptor(globalThis,"document");
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 t.after(() => { if (original) Object.defineProperty(globalThis,"document",original); else Reflect.deleteProperty(globalThis,"document"); });
 const root = document.getElementById("root")!;
 await act(() => mount(root,{status:ready,delivery:null,send:()=>{}}));
 const options = root.querySelector("details.operator-composer-options");
 assert.ok(options); assert.equal(options.hasAttribute("open"),false);
 assert.equal(options.querySelector("summary")?.getAttribute("aria-label"),"Message options","the icon-only mobile trigger keeps its name");
 assert.match(options.textContent ?? "",/op\.jsonl/);
 assert.equal(root.querySelector(".operator-composer-state")?.textContent,"Ready");
 assert.equal(root.querySelector(".operator-composer-state code"),null);
 const threads: ThreadsView = {status:{generated_at:ready.generated_at,availability:"missing",enabled:true,reason:null,token:"fixture-only",threads:[],total:0,warning:null},selected:null,select:()=>{},done:()=>{},sending:null,failed:null};
 await act(() => mount(root,{status:ready,delivery:null,send:()=>{}},undefined,threads));
 const picker = root.querySelector('select[aria-label="Thread"]');
 assert.ok(picker?.closest("details.operator-composer-options"),"the empty picker stays reachable inside message options");
 assert.equal(root.querySelector(".operator-composer-posting")?.textContent,"Posting to no thread");
 assert.match(picker?.textContent ?? "",/^No thread$/);
 await act(() => mount(root,{status:ready,delivery:null,send:()=>{}},undefined,{...threads,selected:"new-fixture-thread"}));
 assert.match(root.querySelector(".operator-composer-options > summary")?.textContent ?? "",/Thread · new-fixture-thread/);
 assert.equal(root.querySelector(".operator-composer-options > summary")?.getAttribute("aria-label"),"Thread · new-fixture-thread","the selected thread stays accessible on mobile");
 assert.equal(root.querySelector(".operator-composer-posting")?.textContent,"Posting to #new-fixture-thread");
 assert.equal(root.querySelector("textarea")?.getAttribute("placeholder"),"Message #new-fixture-thread (Enter to send)");
 await act(() => unmount(root));
 await act(() => mount(root,{status:{...ready,enabled:false,reason:"Dashboard control is off"},delivery:null,send:()=>{}}));
 assert.equal(root.querySelector(".operator-composer-options"),null);
 assert.match(root.textContent ?? "",/Dashboard control is off/);
 await act(() => unmount(root));
 await act(() => mount(root,{status:{...ready,session_file:null},delivery:null,send:()=>{}},undefined,{...threads,status:{error:"HTTP 403"}}));
 assert.equal(root.querySelector(".operator-composer-options"),null,"no empty options when neither a destination nor threads are available");
 await act(() => unmount(root));
});
