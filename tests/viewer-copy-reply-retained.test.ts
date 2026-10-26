import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {CopyReply} from "./viewer-app/components/CopyReply.tsx"; export {act}; export const mount=(root,reply)=>render(h(CopyReply,{reply}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);

/** Retained (V2): CopyReply's unmount cleanup has no consumer-visible outcome: an unmounted reply renders nothing. */
test("CopyReply unmount cleanup: the feedback timer is cleared and a late clipboard promise schedules nothing", async t => {
 const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
 const originals = ["window","document","navigator"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,"window",{configurable:true,value:window});
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 const root = document.getElementById("root")!;
 t.after(() => { for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } });
 const clipboard = (value:unknown) => Object.defineProperty(globalThis,"navigator",{configurable:true,value:{clipboard:value}});
 const click = async () => { root.querySelector("button")!.dispatchEvent(new window.Event("click",{bubbles:true})); await Promise.resolve(); };
 await t.test("unmount cancels the feedback timer", async t => {
  clipboard({writeText:async () => {}});
  await act(() => mount(root,"ask-aa: Keep"));
  t.mock.timers.enable({apis:["setTimeout"]});
  const scheduled = t.mock.method(globalThis,"setTimeout");
  const cleared = t.mock.method(globalThis,"clearTimeout");
  await act(click);
  const feedback = scheduled.mock.calls.find(call => call.arguments[1] === 1600)?.result;
  assert.ok(feedback); await act(() => unmount(root));
  assert.ok(cleared.mock.calls.some(call => call.arguments[0] === feedback));
  await act(() => t.mock.timers.tick(1600)); assert.equal(root.textContent,"");
 });
 await t.test("a clipboard promise resolving after unmount cannot schedule feedback", async t => {
  let resolve!: () => void;
  clipboard({writeText:() => new Promise<void>(done => {resolve = done;})});
  await act(() => mount(root,"ask-aa: Keep"));
  await act(click); assert.equal(root.querySelector("button")!.disabled,true);
  await act(() => unmount(root));
  const scheduled = t.mock.method(globalThis,"setTimeout");
  await act(resolve);
  assert.equal(scheduled.mock.calls.filter(call => call.arguments[1] === 1600).length,0);
 });
});
