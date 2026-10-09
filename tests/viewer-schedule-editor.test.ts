/** P3b: the typed schedule editor and the control hook's receipts. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ScheduleControlStatusResponse, SchedulePolicyResponse, ScheduleItem } from "../src/viewer/api-types.ts";
import { policyFromLegacy } from "../src/viewer/schedule-policy.ts";
import type { ScheduleControlView } from "../viewer-app/schedule-control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const contents = `import {h,render} from "preact"; import {act} from "preact/test-utils"; import {ScheduleEditor} from "./viewer-app/screens/ScheduleEditor.tsx"; import {useScheduleControl,SCHEDULE_RECEIPTS_KEY} from "./viewer-app/use-schedule-control.ts";
export {act, SCHEDULE_RECEIPTS_KEY};
export const editor=(root,props)=>render(h(ScheduleEditor,props),root);
export const probe=(root,fetcher,out)=>render(h(()=>{out.control=useScheduleControl(true,null,fetcher);return null;},{}),root);
export const unmount=root=>render(null,root);`;
const result = await build({ stdin: { contents, resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; SCHEDULE_RECEIPTS_KEY: string;
	editor: (root: unknown, props: unknown) => void; probe: (root: unknown, fetcher: unknown, out: { control?: ScheduleControlView }) => void; unmount: (root: unknown) => void;
};

const ready: ScheduleControlStatusResponse = { generated_at: "2026-07-01T07:00:00Z", enabled: true, reason: null, token: "t".repeat(64), parent: { running: true, pid: 1, reason: "running" }, requests: [], error: null };
const template = { seed_mandate_id: "md-aaaaaa", expiry_hours: 24, spend_usd: 5, spend_tokens: 1000, job_cap: 4, dispatch_parallelism: 1, allowed_actions: ["plan"], ask_on: ["risk:high", "merge"], exclusions: {}, approval: { operator_quote: "ok", decided_by: "operator-quote", approved_at: "2026-07-01T00:00:00Z" } };
const sched = { id: "sch-aaaaaa", name: "nightly", project: "demo", mandate_id: "md-live1", trigger: { type: "manual" }, job: { title: "T", kind: "research", delivery: "answer" }, enabled: true, created_at: "2026-07-01T00:00:00Z", grant_template: template };
const legacy = policyFromLegacy(sched as never, template as never);
const response: SchedulePolicyResponse = { policy: null, active_revision: null, legacy, effective: { limits: { ...legacy.limits, tokens: 500 }, exclusions: { paths: [".github/workflows/"] }, notes: ["token cap clamped to the home's token_ceiling 500"] }, blocking: [] };

function dom(t: { after: (fn: () => void) => void }) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const original = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });
	return { window, document, root: document.getElementById("root")! };
}
const input = (root: Element, label: RegExp) => [...root.querySelectorAll("label")].find(l => label.test(l.textContent ?? ""))!.querySelector("input")!;
const type = (window: { Event: new (n: string, o?: object) => Event }, el: Element, value: string) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new window.Event("input", { bubbles: true })); };

test("editor: invalid field shows its own error and blocks Save; inherited ceilings are read-only; Save sends one save_policy with the base revision", async t => {
	const { window, root } = dom(t);
	const sent: unknown[] = [];
	const control: ScheduleControlView = { status: ready, sending: null, failed: null, request: (op, id, extra) => { sent.push([op, id, extra]); } };
	await mod.act(() => mod.editor(root, { s: sched as unknown as ScheduleItem, policy: response, control, onClose: () => {} }));
	const save = () => [...root.querySelectorAll("button")].find(b => b.textContent === "Save settings")!;
	assert.equal(save().hasAttribute("disabled"), false);
	assert.match(root.querySelector(".schedule-readonly")?.textContent ?? "", /Inherited ceilings \(read-only[^)]*\).*500 tokens/);
	assert.equal(root.querySelectorAll(".schedule-readonly input").length, 0, "inherited ceilings have no input");
	await mod.act(() => type(window, input(root, /At once/), "0"));
	assert.equal(save().hasAttribute("disabled"), true);
	assert.match(input(root, /At once/).closest("label")?.textContent ?? "", /parallelism|between|at least|1/i, "error sits under its own field");
	assert.equal(root.querySelectorAll(".schedule-field-error").length > 0, true);
	await mod.act(() => type(window, input(root, /USD/), "7"));
	await mod.act(() => type(window, input(root, /At once/), "1"));
	assert.equal(save().hasAttribute("disabled"), false);
	await mod.act(() => { save().dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
	assert.equal(sent.length, 1, "one save_policy");
	const [op, id, extra] = sent[0] as [string, string, { revision: number; policy: { limits: { usd: number } } }];
	assert.deepEqual([op, id, extra.revision, extra.policy.limits.usd], ["save_policy", "sch-aaaaaa", 0, 7]);
	await mod.act(() => mod.unmount(root));
});

test("editor: a server refusal lands under the field it names", async t => {
	const { root } = dom(t);
	const control: ScheduleControlView = { status: ready, sending: null, failed: { schedule_id: "sch-aaaaaa", reason: "invalid schedule policy: /limits/usd: must be above 0" }, request: () => {} };
	await mod.act(() => mod.editor(root, { s: sched as unknown as ScheduleItem, policy: response, control, onClose: () => {} }));
	assert.match(input(root, /USD/).closest("label")?.textContent ?? "", /must be above 0/);
	await mod.act(() => mod.unmount(root));
});

test("control hook: a send keeps its receipt id across a reload and never resends; a double click sends once", async t => {
	const { root } = dom(t);
	const store = new Map<string, string>();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
	t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
	const posts: string[] = [];
	const fetcher = async (url: string, init?: RequestInit) => init?.method === "POST"
		? (posts.push(String(init.body)), new Response(JSON.stringify({ id: "sc-20260701070000-00000001", state: "queued" }), { status: 202 }))
		: new Response(JSON.stringify(ready), { status: 200 });
	const out: { control?: ScheduleControlView } = {};
	await mod.act(() => mod.probe(root, fetcher, out));
	await mod.act(() => new Promise(resolve => setTimeout(resolve, 10)));
	await mod.act(() => { out.control!.request("run_now", "sch-aaaaaa", { revision: 2 }); out.control!.request("run_now", "sch-aaaaaa", { revision: 2 }); });
	await mod.act(() => new Promise(resolve => setTimeout(resolve, 10)));
	assert.equal(posts.length, 1, "double click sends once");
	assert.match(posts[0]!, /"revision":2,"client_id":"sk-[0-9]{14}-[0-9a-f]{8}"/);
	assert.deepEqual(JSON.parse(store.get(mod.SCHEDULE_RECEIPTS_KEY)!), ["sc-20260701070000-00000001"], "ids only");
	await mod.act(() => mod.unmount(root));
	const again: { control?: ScheduleControlView } = {};
	await mod.act(() => mod.probe(root, fetcher, again));
	await mod.act(() => new Promise(resolve => setTimeout(resolve, 10)));
	assert.deepEqual(again.control!.receipts, ["sc-20260701070000-00000001"], "the reload keeps the receipt");
	assert.equal(posts.length, 1, "and resends nothing");
	await mod.act(() => mod.unmount(root));
});

test("the Schedules screen bundles for the browser: no node-bound module reaches viewer-app at runtime", async () => {
	const out = await build({ stdin: { contents: 'import "./viewer-app/screens/Schedules.tsx";', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "browser", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
	assert.ok(out.outputFiles.length > 0);
});
