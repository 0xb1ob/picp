/** cp-mxk4 PR2: the Answers to acknowledge section, its tick and its fetch helpers. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { AnswerItem, AnswersControlStatusResponse, AnswersView } from "../src/viewer/api-types.ts";
import { type AnswersControlView, answersControlLine, readAnswersControl, sendAnswerAck } from "../viewer-app/answers-control.ts";
import { route } from "../viewer-app/routes.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import ssr from "preact-render-to-string"; import {AnswersSection} from "./viewer-app/screens/Answers.tsx"; export {act}; export const html=(data,control)=>ssr(h(AnswersSection,{data,control})); export const mount=(root,data,control)=>render(h(AnswersSection,{data,control}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
const {act,html,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; html: (data: AnswersView, control?: AnswersControlView) => string;
	mount: (root: unknown, data: AnswersView, control?: AnswersControlView) => void; unmount: (root: unknown) => void;
};

const item = (id: string, extra: Partial<AnswerItem> = {}): AnswerItem => ({ id, project: "demo", question: "What is up?", answer: "Short.\n\nLonger body.", short: "Short.", posted_at: "2026-07-01T07:00:00Z", acked_at: null, job: null, evidence: [], links: {}, ...extra });
const view = (open: AnswerItem[], history: AnswerItem[] = []): AnswersView => ({ availability: "ok", open, open_count: open.length, history, history_total: history.length, warning: null });
const ready: AnswersControlStatusResponse = { generated_at: "2026-07-01T07:00:00Z", enabled: true, reason: null, token: "t".repeat(64) };
const control = (extra: Partial<AnswersControlView> = {}): AnswersControlView => ({ status: ready, sending: null, failed: null, acked: [], ack: () => {}, ...extra });
const A = "ans-aaaaaaaaaaaa";

test("a hostile question and answer render as text: no markup, no inline style, only http(s) links, full answer in details", () => {
	const long = "q ".repeat(400);
	const out = html(view([item(A, { question: `<script>alert(1)</script>${long}`, answer: "javascript:alert(1) and https://example.com/a and [x](https://example.org/b)\n\nlong", short: "Short.", evidence: [{ path: "/n/else.md", href: null, read: null }, { path: "/s/boards/alpha/index.html", href: "#reports", read: "/boards/alpha/" }], job: { id: "cp-demo", href: "#job/cp-demo", read: "/artifacts/cp-demo" } })]), control());
	assert.doesNotMatch(out, /<script>|style=|onclick=/i);
	assert.match(out, /&lt;script>/);
	const doc = parseHTML(`<body>${out}</body>`).document;
	assert.equal(doc.querySelector(".answers-question")?.getAttribute("title")?.startsWith("<script>"), true, "the whole question is the title, the clamp is CSS");
	assert.ok(doc.querySelector("details.answers-full .answers-text"), "the full answer sits in a details");
	assert.equal(doc.querySelector("details.answers-full")?.hasAttribute("open"), false);
	const links = [...doc.querySelectorAll(".answers-text a")].map(a => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]);
	assert.deepEqual(links, [["https://example.com/a", "_blank", "noopener noreferrer"], ["https://example.org/b", "_blank", "noopener noreferrer"]], "javascript: is plain text");
	assert.match(doc.querySelector(".answers-text")?.textContent ?? "", /javascript:alert\(1\)/);
	assert.deepEqual([...doc.querySelectorAll(".answers-evidence li")].map(li => [...li.querySelectorAll("a")].map(a => a.getAttribute("href")).join(",") || li.textContent), ["/n/else.md", "#reports,/boards/alpha/"]);
	assert.deepEqual([...doc.querySelectorAll(".answers-meta a")].map(a => a.getAttribute("href")), ["#job/cp-demo", "/artifacts/cp-demo"]);
	assert.match(doc.querySelector(".answers-header")?.textContent ?? "", /Answers to acknowledge1/);
});

test("the tick is disabled with the reason when control is not ready; a click acknowledges; an acked id is hidden", async t => {
	const off = parseHTML(`<body>${html(view([item(A)]), control({ status: { ...ready, enabled: false, token: null, reason: "Dashboard control is off: opt-out" } }))}</body>`).document;
	assert.equal(off.querySelector("button.answers-ack")?.hasAttribute("disabled"), true);
	assert.equal(off.querySelector(".answers-control")?.textContent, "Dashboard control is off: opt-out");
	assert.match(html(view([item(A)]), control({ status: null })), /Checking…/);
	assert.match(answersControlLine({ error: "HTTP 500" }), /^Acknowledge unavailable: HTTP 500/);
	assert.match(answersControlLine(ready), /^Tick ✓ to acknowledge/);

	const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
	const original = Object.getOwnPropertyDescriptor(globalThis,"document");
	Object.defineProperty(globalThis,"document",{configurable:true,value:document});
	t.after(() => { if (original) Object.defineProperty(globalThis,"document",original); else Reflect.deleteProperty(globalThis,"document"); });
	const root = document.getElementById("root")!;
	const sent: string[] = [];
	const data = view([item(A), item("ans-bbbbbbbbbbbb")], [item("ans-cccccccccccc", { acked_at: "2026-07-01T08:00:00Z" })]);
	await act(() => mount(root, data, control({ ack: id => { sent.push(id); } })));
	const button = () => root.querySelector(`button[aria-label="Acknowledge ${A}"]`)!;
	assert.equal(button().hasAttribute("disabled"), false);
	await act(() => { button().dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true})); });
	assert.deepEqual(sent, [A]);
	await act(() => mount(root, data, control({ acked: [A] })));
	assert.equal(root.querySelector(`button[aria-label="Acknowledge ${A}"]`), null, "hidden at once");
	assert.ok(root.querySelector(`button[aria-label="Acknowledge ans-bbbbbbbbbbbb"]`));
	assert.match(root.querySelector(".answers-history summary")?.textContent ?? "", /Acknowledged · 1/);
	assert.equal(root.querySelectorAll(".answers-history button").length, 0, "history is read-only");
	await act(() => mount(root, view([]), control()));
	assert.match(root.textContent ?? "", /No answers waiting/);
	assert.ok(root.querySelector('.answers-header') === null); assert.ok(root.querySelector('.answers-control') === null);
	assert.equal(root.querySelector('.answers-quiet')?.hasAttribute('open'),false);
	await act(() => mount(root, view([item(A)]), control({acked:[A]})));
	assert.ok(root.querySelector('.answers-quiet'),"the last successful tick compacts the section before refresh");
	const historyOnly = parseHTML(`<body>${html(view([],data.history),control())}</body>`).document;
	assert.match(historyOnly.querySelector('.answers-quiet > summary')?.textContent ?? "",/1 acknowledged/);
	assert.ok(historyOnly.querySelector('.answers-quiet > article .answers-text'),"history is reachable in one disclosure");
	assert.equal(historyOnly.querySelectorAll('.answers-quiet button').length,0);
	const unreadable = html({...view([]),availability:"unavailable",open_count:null,warning:"Answers unavailable"},control());
	assert.match(unreadable,/Answers unavailable/); assert.doesNotMatch(unreadable,/No answers waiting|answers-quiet/);
	assert.doesNotMatch(html({...view([]),warning:"An unreadable answer was skipped"},control()),/No answers waiting|answers-quiet/,"partial data cannot claim an empty queue");
	const capped = html({...view([item(A)]),open_count:101},control({acked:[A]}));
	assert.match(capped,/answers-count">100</); assert.doesNotMatch(capped,/No answers waiting/,"acknowledging the rendered window cannot hide unrendered pending answers");
	await act(() => mount(root, { ...view([item(A)]), warning: "1 unreadable line(s) in state/operator/answers.jsonl skipped" }, control({ failed: { id: A, reason: "was already acknowledged" } })));
	assert.match(root.querySelector('[role="alert"].answers-warning')?.textContent ?? "", /1 unreadable line/);
	assert.match(root.querySelector(".answers-failed")?.textContent ?? "", /Failed: was already acknowledged/);
	await act(() => unmount(root));
	assert.equal(html({ ...view([]), availability: "missing" }, control()), "", "no journal: no section");
});

test("sendAnswerAck posts the exact body and token; readAnswersControl maps a 403 to an error; #answers is a Decisions section", async () => {
	const calls: Array<[string, RequestInit | undefined]> = [];
	const accepted = async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ id: A, state: "acked", acked_at: "2026-07-01T07:00:00Z" }), { status: 202 }); };
	assert.deepEqual(await sendAnswerAck(accepted, "t".repeat(64), A), { id: A, state: "acked", acked_at: "2026-07-01T07:00:00Z" });
	const [url, init] = calls[0]!;
	assert.equal(url, "/api/answers/ack");
	assert.equal(init?.method, "POST");
	assert.deepEqual(init?.headers, { "content-type": "application/json", "x-cp-control-token": "t".repeat(64) });
	assert.equal(init?.body, `{"id":"${A}"}`);
	const conflict = async () => new Response(JSON.stringify({ error: "was already acknowledged" }), { status: 409 });
	assert.deepEqual(await sendAnswerAck(conflict, "t", A), { error: "was already acknowledged", status: 409 });
	const forbidden = async () => new Response(JSON.stringify({ error: "answer acknowledgement is served only under --require-tailnet" }), { status: 403 });
	assert.deepEqual(await readAnswersControl(forbidden), { error: "answer acknowledgement is served only under --require-tailnet" });
	assert.deepEqual(route("#answers"), { screen: "decisions", section: "answers" });
});
