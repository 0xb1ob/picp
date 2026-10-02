/** cp-hhuf P6: the Schedules page's buttons and their fetch helpers. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ScheduleControlStatusResponse, ScheduleItem } from "../src/viewer/api-types.ts";
import { readScheduleControl, type ScheduleControlView, type ScheduleOp, sendScheduleControl } from "../viewer-app/schedule-control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {ScheduleControls} from "./viewer-app/screens/Schedules.tsx"; export {act}; export const mount=(root,s,control)=>render(h(ScheduleControls,{s,control}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
const {act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; mount: (root: unknown, s: ScheduleItem, control: ScheduleControlView) => void; unmount: (root: unknown) => void;
};

const ready: ScheduleControlStatusResponse = { generated_at: "2026-07-01T07:00:00Z", enabled: true, reason: null, token: "t".repeat(64), parent: { running: true, pid: 1, reason: "running" }, requests: [], error: null };
const schedule = { id: "sch-aaaaaa", name: "nightly", enabled: true } as ScheduleItem;

test("Run now sends run_now; Remove needs two taps", async t => {
	const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
	const original = Object.getOwnPropertyDescriptor(globalThis,"document");
	Object.defineProperty(globalThis,"document",{configurable:true,value:document});
	t.after(() => { if (original) Object.defineProperty(globalThis,"document",original); else Reflect.deleteProperty(globalThis,"document"); });
	const root = document.getElementById("root")!;
	const sent: Array<[ScheduleOp, string]> = [];
	const control: ScheduleControlView = { status: ready, sending: null, failed: null, request: (op, id) => { sent.push([op, id]); } };
	await act(() => mount(root, schedule, control));
	const button = (label: RegExp) => [...root.querySelectorAll("button")].find(b => label.test(b.textContent ?? ""))!;
	const click = (label: RegExp) => act(() => { button(label).dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true})); });
	await click(/^Run now$/);
	assert.deepEqual(sent, [["run_now", "sch-aaaaaa"]]);
	await click(/^Remove$/);
	assert.equal(sent.length, 1, "the first tap only arms Remove");
	assert.equal(button(/remove/i).textContent, "Tap again to remove");
	await click(/^Tap again to remove$/);
	assert.deepEqual(sent.at(-1), ["remove", "sch-aaaaaa"]);
	assert.equal(button(/remove/i).textContent, "Remove", "and disarms again");
	await click(/^Disable$/);
	assert.deepEqual(sent.at(-1), ["disable", "sch-aaaaaa"]);
	await act(() => unmount(root));
});

test("sendScheduleControl posts the exact body and token; readScheduleControl maps a 403 to an error", async () => {
	const calls: Array<[string, RequestInit | undefined]> = [];
	const accepted = async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ id: "sc-20260701070000-0000abcd", state: "queued" }), { status: 202 }); };
	assert.deepEqual(await sendScheduleControl(accepted, "t".repeat(64), { op: "run_now", schedule_id: "sch-aaaaaa" }), { id: "sc-20260701070000-0000abcd", state: "queued" });
	const [url, init] = calls[0]!;
	assert.equal(url, "/api/schedules/request");
	assert.equal(init?.method, "POST");
	assert.deepEqual(init?.headers, { "content-type": "application/json", "x-cp-control-token": "t".repeat(64) });
	assert.equal(init?.body, '{"op":"run_now","schedule_id":"sch-aaaaaa"}');
	const refused = async () => new Response(JSON.stringify({ error: "parent not running: no parent lock" }), { status: 503 });
	assert.deepEqual(await sendScheduleControl(refused, "t", { op: "enable", schedule_id: "sch-aaaaaa" }), { error: "parent not running: no parent lock", status: 503 });
	const forbidden = async () => new Response(JSON.stringify({ error: "schedule controls are served only under --require-tailnet" }), { status: 403 });
	assert.deepEqual(await readScheduleControl(forbidden), { error: "schedule controls are served only under --require-tailnet" });
});
