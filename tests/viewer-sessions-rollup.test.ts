/**
 * Sessions chat rollups (PR B): consecutive relay turns about one PR, else one job, fold into one card showing the
 * latest turn and the subject chip; earlier turns sit behind a toggle. Rollups never cross subjects, days, threads, source
 * gaps, operator messages or the quick-reply anchor, and Tools on shows every row on its own.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";
import type { AwaitingDetail, ControlStatusResponse, PrChip, SessionEntry, SessionsResponse } from "../src/viewer/api-types.ts";
import type { ControlView } from "../viewer-app/control.ts";
import { rollups, rowHead, rows } from "../viewer-app/session-rows.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import renderToString from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export {act}; export const html=(data,control)=>renderToString(h(Sessions,{data,control})); export const mount=(root,data)=>render(h(Sessions,{data}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, html, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (run: () => void | Promise<void>) => Promise<void>;
	html: (data: SessionsResponse, control?: ControlView) => string;
	mount: (root: Element, data: SessionsResponse) => void;
	unmount: (root: Element) => void;
};

const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const AT = local(15, 9);
const entry = (id: string, kind: SessionEntry["kind"], over: Partial<SessionEntry> = {}): SessionEntry => ({ id, at: AT, kind, who: "Assistant", text: id, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const wake = (id: string, job: string | null, over: Partial<SessionEntry> = {}) => entry(id, "system", { who: "cp-bridge", tag: "bridge", bridge: { kind: "wake", job, id: null, receipt: null }, ...over });
const relay = (id: string, text = id, over: Partial<SessionEntry> = {}) => entry(id, "say", { text, ...over });
const URL = "https://github.com/o/picp/pull/355", URL2 = "https://github.com/o/picp/pull/356";
const pr = (url: string, job: string): PrChip => ({ kind: "pr", url, number: Number(url.split("/").at(-1)), repo: "o/picp", job_id: job, head_sha: null, state: "open", merge_sha: null,
	closed_by: null, job_status: null, ci: "green", review: null });
const CHIPS = { [URL]: pr(URL, "cp-a"), [URL2]: pr(URL2, "cp-a") };

/** Each output row: a rollup as `subject[turn rows|turn rows]` by head ids, any other row by its head id. */
function fold(list: SessionEntry[], { days = new Map<string, string>(), order, keep }: { days?: Map<string, string>; order?: Map<string, number>; keep?: string } = {}) {
	const o = order ?? new Map(list.map((e, i) => [e.id, i]));
	return rollups(rows(list, days, o), days, o, CHIPS, keep).map(r => r.kind === "rollup" ? `${r.subject}[${r.turns.map(t => t.map(x => rowHead(x).id).join(",")).join("|")}]` : rowHead(r).id);
}

test("rollups: same-job turns fold; a PR named across a job turn and a job-less HELD PR LANDED turn folds by PR", () => {
	assert.deepEqual(fold([wake("w1", "cp-b"), entry("t1", "tool", { name: "bash" }), relay("r1"), wake("w2", "cp-b"), relay("r2")]), ["job:cp-b[w1,r1|w2,r2]"], "(a) a wake with steps heads its turn");
	assert.deepEqual(fold([wake("w1", "cp-a"), relay("r1", "#355 review running", { links: { "#355": URL } }), wake("w2", null, { text: "HELD PR LANDED" }), relay("r2", `${URL} merged.`)]),
		[`pr:${URL}[w1,r1|w2,r2]`], "(b)");
	assert.deepEqual(fold([wake("w1", "cp-a"), relay("r1", `${URL} and ${URL2}`), wake("w2", "cp-a"), relay("r2", `${URL2}, ${URL}`)]), ["job:cp-a[w1,r1|w2,r2]"], "(i) two PRs named: the job key");
});

test("rollups: never across another subject, an operator message, a day, a thread or a source gap; single and subject-less turns stay", () => {
	const ids = (list: SessionEntry[]) => list.map(e => e.id);
	const aba = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-c"), relay("r2"), wake("w3", "cp-b"), relay("r3")];
	assert.deepEqual(fold(aba), ids(aba), "(c) A, B, A");
	const op = [wake("w1", "cp-b"), relay("r1"), relay("o1", "ok", { who: "Operator" }), wake("w2", "cp-b"), relay("r2")];
	assert.deepEqual(fold(op), ids(op), "(d) an operator message");
	const two = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-b"), relay("r2")];
	assert.deepEqual(fold(two, { days: new Map([["w2", "Fri, Oct 16"]]) }), ids(two), "(e) a local-midnight start");
	assert.deepEqual(fold(two, { days: new Map([["r2", "Fri, Oct 16"]]) }), ids(two), "(e) a day start inside the later turn");
	const threaded = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-b", { thread: "th-x" }), relay("r2", "r2", { thread: "th-x" })];
	assert.deepEqual(fold(threaded), ids(threaded), "(e) a thread change");
	assert.deepEqual(fold(two, { order: new Map([["w1", 0], ["r1", 1], ["w2", 7], ["r2", 8]]) }), ids(two), "(e) an order gap a filter opened");
	assert.deepEqual(fold(two.slice(0, 2)), ["w1", "r1"], "(f) a single turn");
	const bare = [wake("w1", null), relay("r1", "plain"), wake("w2", null), relay("r2", "plain")];
	assert.deepEqual(fold(bare), ids(bare), "(h) no PR and no job: never merged");
});

test("rollups: a run ends before the quick-reply anchor's turn", () => {
	const three = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-b"), relay("r2"), wake("w3", "cp-b"), relay("r3")];
	assert.deepEqual(fold(three, { keep: "r3" }), ["job:cp-b[w1,r1|w2,r2]", "w3", "r3"], "(g)");
	assert.deepEqual(fold(three, { keep: "r2" }), ["w1", "r1", "w2", "r2", "w3", "r3"]);
});

const view = (entries: SessionEntry[], over: Partial<SessionsResponse> = {}): SessionsResponse => ({ generated_at: "", selected: "you", session_id: null, parent: { id: "cp-parent", live: false }, workers: [], entries,
	title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false, transcript: true, pr_chips: CHIPS, ...over } as unknown as SessionsResponse);
const turns = [wake("w1", "cp-a"), relay("r1", `first update on ${URL}`), wake("w2", "cp-a"), relay("r2", `second update on ${URL}`), wake("w3", null, { text: "HELD PR LANDED" }), relay("r3", `latest update: ${URL} merged`)];

/** A linkedom DOM to click in; `tools` is the remembered Tools-on choice the screen reads from localStorage. */
function stage(t: TestContext, tools = false) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => key === "cp-sessions-tool-calls" && tools ? "1" : null, setItem() {} } });
	class Observer { observe() {} disconnect() {} }
	const originals = ["window", "document", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document], ["ResizeObserver", Observer]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(async () => {
		await act(() => unmount(root));
		for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	});
	return { root, click: (node: Element | null) => act(() => { node!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); }) };
}

test("rollup card: the latest relay and the subject chip; earlier updates open behind an aria-expanded toggle", async t => {
	const s = stage(t);
	await act(() => mount(s.root, view(turns)));
	const card = s.root.querySelectorAll(".session-rollup");
	assert.equal(card.length, 1, "(j) one card");
	assert.match(card[0]!.textContent!, /latest update/);
	assert.doesNotMatch(card[0]!.textContent!, /first update|second update/, "earlier turns are hidden");
	assert.match(card[0]!.querySelector(".session-rollup-head a.pr-chip")?.textContent ?? "", /#355/);
	assert.equal(card[0]!.querySelector(".session-rollup-head a.session-rollup-job")?.getAttribute("href")?.includes("cp-a"), true, "the chip's job links its transcript");
	const toggle = card[0]!.querySelector("button.session-rollup-toggle")!;
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.match(toggle.textContent!, /^2 earlier updates/);
	await s.click(toggle);
	assert.equal(s.root.querySelector("button.session-rollup-toggle")!.getAttribute("aria-expanded"), "true");
	const text = s.root.querySelector(".session-rollup")!.textContent!;
	assert.ok(text.indexOf("first update") >= 0 && text.indexOf("first update") < text.indexOf("second update") && text.indexOf("second update") < text.indexOf("latest update"), "earlier turns above the latest, in order");
});

test("rollup card: Tools on forms no rollup", async t => {
	const s = stage(t, true);
	await act(() => mount(s.root, view(turns)));
	assert.equal(s.root.querySelectorAll(".session-rollup").length, 0, "(k)");
	assert.match(s.root.textContent!, /first update/);
});

test("rollup card: quick replies still render at their anchor, after the turn they follow", () => {
	const ask = { id: "ask-aaaa", project: "picp", question: "Merge?", created_at: AT, options: [{ label: "Merge", consequence: "Lands", reply: "" }], recommendation: "Merge", source_escalation: null,
		job_ids: [], context: null, evidence_paths: [], reason: null, source_created_at: null, mandate_id: null, mandate_status: null, spend: null, spend_cap: null, mandate_objective: null, jobs: [],
		escalation: null, evidence: [] } as unknown as AwaitingDetail;
	const card = entry("c-ask-aaaa", "ask", { who: "Operator → you", ask: { id: "ask-aaaa", question: "Merge?", options: [], recommendation: "Merge", state: "open", answer: null, answered_at: null, reason: null } });
	const control = { status: { generated_at: "", enabled: true, running: true, reason: null, token: "t", busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null } as unknown as ControlStatusResponse, delivery: null, send() {} } as unknown as ControlView;
	const { document } = parseHTML(`<div>${html(view([card, ...turns], { open_asks: [ask] }), control)}</div>`);
	assert.equal(document.querySelectorAll(".session-rollup").length, 1, "(l) the turns before the anchor's still fold");
	const replies = document.querySelector(".session-entries > .session-replies")!;
	assert.match(replies.previousElementSibling?.textContent ?? "", /latest update/, "replies follow the anchor's own turn");
	assert.doesNotMatch(document.querySelector(".session-rollup")!.textContent!, /latest update/, "the anchor's turn stays out of the card");
});
