/** cp-p56a: the composer's Enter sends (followUp while busy), Shift+Enter stays a newline, IME Enter never sends. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import type { ControlBody, ControlView } from "../viewer-app/control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {OperatorComposer,COMPOSER_PLACEHOLDER} from "./viewer-app/components/OperatorComposer.tsx"; export {act,COMPOSER_PLACEHOLDER}; export const mount=(root,control,draft)=>render(h(OperatorComposer,{control,draft}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {act,mount,unmount,COMPOSER_PLACEHOLDER} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; mount: (root: unknown, control: ControlView, draft?: string) => void; unmount: (root: unknown) => void; COMPOSER_PLACEHOLDER: string;
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
