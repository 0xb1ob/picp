/** dashboard-decisions-clickable: open asks pinned in the Full transcript, a clickable Awaiting page, and the context to decide. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { LAYOUT } from "../src/contracts.ts";
import { OperatorAsks } from "../src/operator-asks.ts";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import { awaitingScreen } from "../src/viewer/decision-views.ts";
import { operatorSessionsFile } from "../src/viewer/operator-sessions.ts";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import type { ControlBody, ControlView } from "../viewer-app/control.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const at = "2026-09-27T08:20:00Z";
const now = Date.parse("2026-09-27T09:00:00Z");
const status = (over: Partial<ControlStatusResponse> = {}): ControlStatusResponse => ({ generated_at: at, enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false }, ...over });

function fixture(t: { after(fn: () => void): void }) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
	const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
	const asks = new OperatorAsks(join(state.stateDir, "operator", "asks.jsonl"));
	const context = "The parent paused cp-demo at the spend cap.\n\n- Keep: nothing more is spent\n- Raise: $5 more, finishes today\n\nRisk: low.";
	const first = asks.open({ project: "demo", question: "Raise the cap?", options: [{ label: "Keep", consequence: "Work stays paused" }, { label: "Raise", consequence: "Spends $5 more" }], recommendation: "Keep", source_escalation: "es-cap", job_ids: ["cp-demo"], evidence_paths: [join(state.stateDir, "runs", "cp-demo", "artifact.md"), "README.md", "/nowhere/else.md", "runs/cp-demo/notes.md", join(state.stateDir, "runs", "cp-ghost", "artifact.md")], context });
	const second = asks.open({ project: "demo", question: "Second question", options: [{ label: "Yes", consequence: "Proceeds" }], recommendation: "Yes" });
	const settled = asks.open({ project: "demo", question: "Settled", options: [{ label: "Yes", consequence: "Proceeds" }], recommendation: "Yes" });
	asks.answer(settled.id, "Yes");
	put(join(state.stateDir, "escalations.json"), { items: [{ id: "es-cap", created_at: at, question: "cp-demo hit its cap: raise or drop?", status: "open", kind: "budget_exhausted", job_ids: ["cp-demo"], mandate_id: "md-abcd", mandate_clause: "the USD cap is never the parent's", recommended: "drop", options: [{ id: "drop", label: "Drop the job" }, { id: "raise", label: "Raise" }] }] });
	put(join(state.stateDir, "mandates", "md-abcd.json"), { id: "md-abcd", status: "active", issued_at: "2026-09-27T00:00:00Z", expiry: "2026-09-28T00:00:00Z", projects: ["demo"], spend_cap: { usd: 10 }, objective: "Ship the demo dashboard" });
	put(join(state.stateDir, "fleet.json"), { jobs: [{ job_id: "cp-demo", project: "demo", phase: "held", kind: "ship", delivery: "pr", dispatched_at: at, worker: { model: "anthropic/claude-demo" }, usage: { cost_usd: 1.5, total_tokens: 100 }, receipts: [{ kind: "pr", url: "https://github.com/acme/repo/pull/7", status: "open" }] }] });
	put(join(state.home, ".pi-command-post", "jobs.json"), { jobs: [{ id: "cp-demo", status: "in_progress", title: "Demo dashboard job", labels: ["project:demo"] }] });
	put(join(dirname(state.stateDir), "projects", "demo", "README.md"), "# demo\n");
	// A project-relative path that happens to carry a runs/ segment is a file, never a job run (same for an unknown id).
	put(join(dirname(state.stateDir), "projects", "demo", "runs", "cp-demo", "notes.md"), "# notes\n");
	return { state, put, first, second, context };
}

test("API: open asks carry context, jobs, mandate objective, the parent's escalation and evidence links; the transcript pins every open ask, window or not", (t) => {
	const { state, put, first, second, context } = fixture(t);
	const items = awaitingScreen(state, now).items;
	assert.deepEqual(items.map((a) => a.id), [first.id, second.id], "open asks only, oldest (journal order) first, the settled ask excluded");
	const item = items.find((a) => a.id === first.id), other = items.find((a) => a.id === second.id);
	assert.equal(item?.context, context, "context round-trips through the journal");
	assert.equal(other?.context, null);
	assert.equal(item?.mandate_objective, "Ship the demo dashboard");
	assert.deepEqual(item?.jobs, [{ id: "cp-demo", title: "Demo dashboard job", phase: "held", model: "anthropic/claude-demo", cost_usd: 1.5, pr_url: "https://github.com/acme/repo/pull/7", ci: null, review: null }]);
	assert.deepEqual(item?.escalation, { id: "es-cap", kind: "budget_exhausted", question: "cp-demo hit its cap: raise or drop?", recommended: "Drop the job", differs: true });
	assert.deepEqual(item?.evidence.map((e) => [e.href, e.read]), [["#job/cp-demo", null], [`#files?${new URLSearchParams({ root: "project:demo", path: "README.md" })}`, null], [null, null], [`#files?${new URLSearchParams({ root: "project:demo", path: "runs/cp-demo/notes.md" })}`, null], [null, null]]);
	assert.throws(() => new OperatorAsks(join(state.stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "Q", options: [{ label: "A", consequence: "B" }], recommendation: "A", context: "x".repeat(2001) }), /invalid operator ask/, "context is capped at 2,000 characters");

	// The operator transcript: 320 lines after the ask call, so the first ask's own card sits outside the 300-entry window.
	const file = join(state.home, "operator-session.jsonl");
	const message = (m: unknown) => JSON.stringify({ type: "message", timestamp: at, message: m });
	put(file, [message({ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "cp_parent", arguments: { action: "ask" } }] }), message({ role: "toolResult", toolCallId: "call-a", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id: first.id }) }] }), ...Array.from({ length: 320 }, (_, i) => message({ role: "user", content: [{ type: "text", text: `line ${i}` }] }))].join("\n") + "\n");
	put(operatorSessionsFile(join(state.stateDir, "sessions")), JSON.stringify({ at, session_file: file }) + "\n");
	const full = sessionsView(state, "you", null, { transcript: true, now })!;
	assert.equal(full.truncated, true);
	assert.deepEqual(full.open_asks?.map((a) => a.id), items.map((a) => a.id), "the pinned list is every open ask, in the Awaiting order");
	assert.equal(full.open_asks?.find((a) => a.id === first.id)?.escalation?.differs, true);
	assert.equal(sessionsView(state, "you", null, { now })?.open_asks, undefined, "the Decisions view pins nothing");
});

test("component: Awaiting renders option buttons, never CopyReply; disabled with the reason when control is down; Other answer sends a message body", async (t) => {
	const { state, first } = fixture(t);
	const built = await build({ stdin: { contents: 'import {h,render as domRender} from "preact"; import {act} from "preact/test-utils"; import render from "preact-render-to-string"; import {AwaitingScreen} from "./viewer-app/screens/Awaiting.tsx"; export {act}; export const screen=(data,control)=>render(h(AwaitingScreen,{data,control})); export const mount=(root,data,control)=>domRender(h(AwaitingScreen,{data,control}),root); export const unmount=root=>domRender(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	const { screen, mount, unmount, act } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);
	const data = awaitingScreen(state, now);
	const sent: [ControlBody, string | undefined][] = [];
	const control = (s: ControlStatusResponse, delivery: ControlView["delivery"] = null): ControlView => ({ status: s, delivery, send: (body, askId) => { sent.push([body, askId]); } });

	const ready = screen(data, control(status()));
	assert.doesNotMatch(ready, /Copy reply|Copy a reply|overview-reply/);
	assert.equal(ready.match(/<button type="button" class="decision-card-option/g)?.length, 3, "one button per option");
	assert.match(ready, /class="decision-card-option decision-card-recommended"><span class="decision-card-option-heading"><strong>Keep<\/strong><span class="overview-rec-badge">recommended<\/span><\/span><span class="decision-card-consequence">Work stays paused/);
	assert.match(ready, /<li>Keep: nothing more is spent<\/li><li>Raise: \$5 more, finishes today<\/li>/, "context bullets");
	assert.match(ready, /<p>Risk: low\.<\/p>/, "context paragraphs");
	assert.match(ready, /the parent recommends Drop the job/, "the parent's differing recommendation is flagged");
	assert.match(ready, /Ship the demo dashboard/);
	assert.match(ready, /href="#job\/cp-demo"><code>cp-demo<\/code><\/a><span>Demo dashboard job<\/span><small>held · anthropic\/claude-demo · \$1\.50<\/small><a href="https:\/\/github\.com\/acme\/repo\/pull\/7">https:\/\/github\.com\/acme\/repo\/pull\/7<\/a>/);
	assert.match(ready, /<a href="#files\?root=project%3Ademo&amp;path=README\.md">README\.md<\/a>/);
	assert.match(ready, /<code>\/nowhere\/else\.md<\/code>/, "an unresolvable path stays plain text");

	const down = screen(data, control(status({ running: false, token: null, reason: "Session not running: no dashboard control record" })));
	assert.match(down, /class="decision-card-option decision-card-recommended" disabled(?:="")?>/, "buttons stay visible, disabled");
	assert.match(down, /class="decision-card-disabled" role="status">Session not running: no dashboard control record/);
	assert.doesNotMatch(down, /Copy reply/);
	assert.match(screen(data), /class="decision-card-disabled" role="status">Checking dashboard control/, "no control yet reads as checking");
	assert.match(screen(data, control(status(), { id: "dc-1", state: "queued", reason: null, ask_id: first.id })), /Sent, queued — the card closes when the session records the answer/);
	assert.match(screen(data, control(status(), { id: null, state: "failed", reason: "ask is answered", ask_id: first.id })), /role="alert" class="decision-card-delivery decision-card-failed">Failed: ask is answered/);

	const { window, document } = parseHTML("<html><body><main></main></body></html>");
	const originals = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, "window", { configurable: true, value: window });
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const root = document.querySelector("main")!;
	await act(() => mount(root, data, control(status())));
	const card = root.querySelector(`article[aria-labelledby="question-${first.id}"]`)!;
	await act(() => [...card.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Raise"))!.dispatchEvent(new window.Event("click", { bubbles: true })));
	const input = card.querySelector("input")! as unknown as HTMLInputElement;
	input.value = "approve with changes: cap at $3";
	await act(() => input.dispatchEvent(new window.Event("input", { bubbles: true })));
	await act(() => [...card.querySelectorAll("button")].find((b) => b.textContent === "Send")!.dispatchEvent(new window.Event("click", { bubbles: true })));
	const id = first.id;
	assert.deepEqual(sent, [[{ kind: "answer", ask_id: id, label: "Raise" }, undefined], [{ kind: "message", text: `${id}: approve with changes: cap at $3` }, id]]);
	await act(() => unmount(root));
});
