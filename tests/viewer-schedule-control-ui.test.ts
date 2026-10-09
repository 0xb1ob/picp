/** cp-hhuf P6: the Schedules page's buttons and their fetch helpers. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ScheduleControlStatusResponse, ScheduleItem } from "../src/viewer/api-types.ts";
import { readinessLine, readScheduleControl, requestLine, scheduleClientId, type ScheduleControlView, type ScheduleOp, sendScheduleControl } from "../viewer-app/schedule-control.ts";
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
	const labels = () => [...root.querySelectorAll("button")].map(b => b.textContent);
	assert.deepEqual(labels(), ["Run now", "Disable", "Remove…"]);
	assert.equal(button(/^Run now$/).className, "schedule-primary");
	await click(/^Run now$/);
	assert.deepEqual(sent, [["run_now", "sch-aaaaaa"]]);
	await click(/^Remove…$/);
	assert.equal(sent.length, 1, "the first tap only arms Remove");
	assert.equal(button(/remove/i).textContent, "Tap again to remove");
	await click(/^Tap again to remove$/);
	assert.deepEqual(sent.at(-1), ["remove", "sch-aaaaaa"]);
	assert.equal(button(/remove/i).textContent, "Remove…", "and disarms again");
	await click(/^Disable$/);
	assert.deepEqual(sent.at(-1), ["disable", "sch-aaaaaa"]);
	await act(() => mount(root, { ...schedule, enabled: false }, control));
	assert.deepEqual(labels(), ["Enable", "Remove…"], "disabled schedules cannot Run now");
	await click(/^Enable$/);
	assert.deepEqual(sent.at(-1), ["enable", "sch-aaaaaa"]);
	for (const held of [
		{ ...control, status: { error: "Controls unavailable" } },
		{ ...control, status: { ...ready, parent: { running: false, pid: null, reason: "offline" } } },
		{ ...control, sending: { schedule_id: schedule.id, op: "run_now" as const } },
		{ ...control, status: { ...ready, requests: [{ id: "sc-20260701070000-00000001", at: ready.generated_at, op: "run_now" as const, schedule_id: schedule.id, state: "queued" as const, reason: null, job_id: null }] } },
	]) {
		await act(() => mount(root, schedule, held));
		assert.ok([...root.querySelectorAll("button")].every(b => b.hasAttribute("disabled")), "unavailable/pending requests disable every action");
	}
	await act(() => mount(root, schedule, { ...control, failed: { schedule_id: schedule.id, reason: "grant is stopped: move the schedule to a new grant" } }));
	assert.equal(root.querySelector('[role="alert"]')?.textContent, "Refused: grant is stopped: move the schedule to a new grant");
	assert.equal(root.querySelector(".schedule-remove")?.textContent, "Remove…");
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

test("requestLine: queued, applying and accepted read as accepted, never completed", () => {
	const req = (op: ScheduleOp, state: "queued" | "applying" | "done", job_id: string | null, reason: string | null = null) => ({ id: "sc-1", at: "2026-07-01T07:00:00Z", op, schedule_id: "sch-aaaaaa", state, reason, job_id });
	assert.equal(requestLine(req("run_now", "done", "cp-x")), "Run accepted · cp-x · view run");
	assert.equal(requestLine(req("run_now", "done", null)), "Run accepted");
	assert.equal(requestLine(req("run_now", "queued", null)), "Request queued · run_now · sc-1");
	assert.equal(requestLine(req("run_now", "applying", null)), "Starting run…");
	assert.equal(requestLine(req("disable", "done", null)), "Done · Disable");
	assert.equal(requestLine(req("save_policy", "done", null, "Settings saved · revision 2 (applies to the next run)")), "Settings saved · revision 2 (applies to the next run)");
	assert.equal(requestLine(req("deactivate", "done", null)), "Back on per-fire grants");
	assert.equal(readinessLine(null), "Checking readiness");
	assert.equal(readinessLine({ error: "x" }), "Blocked: x");
	assert.equal(readinessLine({ policy: null, active_revision: null, legacy: null, effective: null, blocking: ["a", "b"] }), "Blocked: a; b");
	assert.equal(readinessLine({ policy: null, active_revision: null, legacy: null, effective: null, blocking: [] }), "Ready");
});

test("sendScheduleControl carries revision, policy and client_id; scheduleClientId matches the server shape", async () => {
	assert.match(scheduleClientId(), /^sk-[0-9]{14}-[0-9a-f]{8}$/);
	let body = "";
	const accepted = async (_url: string, init?: RequestInit) => { body = String(init?.body); return new Response(JSON.stringify({ id: "sc-1", state: "queued" }), { status: 202 }); };
	await sendScheduleControl(accepted, "t", { op: "run_now", schedule_id: "sch-aaaaaa", revision: 3, client_id: "sk-20260701070000-0000abcd" });
	assert.equal(body, '{"op":"run_now","schedule_id":"sch-aaaaaa","revision":3,"client_id":"sk-20260701070000-0000abcd"}');
});

test("a policy-bound card sends revision-bound Run now, shows View active run while one is open, and links the accepted job", async t => {
	const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
	const original = Object.getOwnPropertyDescriptor(globalThis,"document");
	Object.defineProperty(globalThis,"document",{configurable:true,value:document});
	t.after(() => { if (original) Object.defineProperty(globalThis,"document",original); else Reflect.deleteProperty(globalThis,"document"); });
	const root = document.getElementById("root")!;
	const sent: unknown[] = [];
	const control: ScheduleControlView = { status: ready, sending: null, failed: null, request: (op, id, extra) => { sent.push([op, id, extra]); } };
	const active = { ...schedule, policy: { active_revision: 4 } } as ScheduleItem;
	await act(() => mount(root, active, control));
	const click = (label: RegExp) => act(() => { [...root.querySelectorAll("button")].find(b => label.test(b.textContent ?? ""))!.dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true})); });
	await click(/^Run now$/);
	assert.deepEqual(sent, [["run_now", "sch-aaaaaa", { revision: 4 }]]);
	await act(() => mount(root, { ...active, active_run: { anchor_job_id: "cp-anchor" } } as ScheduleItem, control));
	assert.equal(root.querySelector(".schedule-view-run")?.getAttribute("href"), "#job/cp-anchor");
	assert.equal([...root.querySelectorAll("button")].some(b => /^Run now$/.test(b.textContent ?? "")), false);
	await act(() => mount(root, schedule, { ...control, status: { ...ready, requests: [{ id: "sc-1", at: ready.generated_at, op: "run_now" as const, schedule_id: schedule.id, state: "done" as const, reason: null, job_id: "cp-job" }] } }));
	assert.equal(root.querySelector('[role="status"] a')?.getAttribute("href"), "#job/cp-job");
	assert.match(root.querySelector('[role="status"]')?.textContent ?? "", /^Run accepted · cp-job · view run$/);
	await act(() => unmount(root));
});
