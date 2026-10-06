/** Restart session in the shell's ⋮ menu: shown only with a control view, Esc / outside tap close it, no inline copies remain. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import type { ControlView } from "../viewer-app/control.ts";
import type { Restarting } from "../viewer-app/restart-control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const status = (over: Partial<ControlStatusResponse> = {}): ControlStatusResponse => ({ generated_at: "2026-01-01T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false }, restart: { supported: true, blockers: [], reason: null }, session_started_at: "2026-01-01T08:00:00.000Z", ...over });
const restarting = (state: Restarting["state"]): Restarting => ({ state, reason: null, started_at: null, session_file: "op.jsonl" });
const view = (s: ControlStatusResponse, r: Restarting | null = null, restart: () => void = () => {}): ControlView => ({ status: s, delivery: null, send: () => {}, restarting: r, restart });

const built = await build({ stdin: { contents: 'import {h,render as domRender} from "preact"; import {act} from "preact/test-utils"; import render from "preact-render-to-string"; import {MoreMenu} from "./viewer-app/components/MoreMenu.tsx"; export {act}; export const draw=(control, extra)=>render(h(MoreMenu,{control, ...extra})); export const mount=(root,control, extra)=>domRender(h(MoreMenu,{control, ...extra}),root); export const unmount=root=>domRender(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, draw, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { act: (fn: () => unknown) => Promise<void>; draw: (control: ControlView | undefined, extra?: {version?: {view: unknown; error: string | null}; updatedAt?: string | null}) => string; mount: (root: unknown, control: ControlView | undefined, extra?: object) => void; unmount: (root: unknown) => void };

test("⋮ menu: always rendered; Restart only with a session; a dot while a restart runs", () => {
	assert.match(draw(undefined), /aria-label="More actions"/, "no control view: the menu still renders");
	assert.doesNotMatch(draw(undefined), /Restart session/);
	assert.match(draw(view(status({ running: false, token: null }))), /More actions/);
	assert.doesNotMatch(draw(view(status({ running: false, token: null }))), /Restart session/, "offline and not restarting: no Restart row");
	const idle = draw(view(status()));
	assert.match(idle, /<summary aria-label="More actions" title="More actions">/);
	assert.doesNotMatch(idle, /shell-more-dot|Restart session/, "closed: no panel, no dot");
	assert.match(draw(view(status(), restarting("stopping"))), /shell-more-dot/, "a compact dot, not a block");
	assert.doesNotMatch(draw(view(status(), restarting("restarted"))), /shell-more-dot/);
});
test("⋮ dot shows on a version alert and Restart stays hidden without a control view", () => {
	const version = { view: { generated_at: "2026-01-01T00:00:00Z", deployed: null, upstream: { state: "unknown" as const, behind: null, ahead: null, reason: null, checked_at: null, updater: null }, processes: [], bundle: { script: null }, overall: { level: "alert" as const, label: "update failed" } }, error: null };
	assert.match(draw(undefined, {version}), /shell-more-dot/);
	assert.doesNotMatch(draw(undefined, {version}), /Restart session/);
	assert.doesNotMatch(draw(undefined, {version: {...version, view: {...version.view, overall: {level: "ok" as const, label: "current"}}}}), /shell-more-dot/);
});

test("⋮ menu: opens with Restart session inside (two-tap confirm kept); Esc and an outside tap close it", async t => {
	const { window, document } = parseHTML("<html><body><div id='root'></div><p id='elsewhere'>x</p></body></html>");
	const originals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, "window", { configurable: true, value: window });
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	window.matchMedia = (() => ({matches:false}) as MediaQueryList);
	t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const root = document.getElementById("root")!;
	let restarts = 0;
	await act(() => mount(root, view(status(), null, () => { restarts++; })));
	const details = root.querySelector("details")!;
	const toggle = async (open: boolean) => { details.open = open; await act(() => details.dispatchEvent(new window.Event("toggle"))); };
	assert.equal(root.querySelector(".shell-more-panel"), null);
	await toggle(true);
	const item = () => root.querySelector<HTMLButtonElement>(".operator-restart-button")!;
	const text = root.querySelector(".shell-more-panel")!.textContent ?? "";
	assert.ok(text.indexOf("Refresh now") < text.indexOf("Copy link to this view") && text.indexOf("Copy link to this view") < text.indexOf("Notifications") && text.indexOf("Notifications") < text.indexOf("Viewer"), text);
	assert.equal(root.querySelectorAll(".shell-more-row > svg").length, 3, "Refresh, Copy and Notifications each have an icon");
	assert.ok(root.querySelector(".shell-more-footer .shell-more-version"), "Viewer sits in the divided footer");
	assert.ok(root.querySelector(".shell-more-scrim[aria-hidden=true]"), "the phone background dims while the panel is open");
	assert.equal(item().textContent, "Restart session");
	await act(() => item().click());
	assert.match(item().textContent!, /^Tap again to restart/);
	assert.equal(restarts, 0, "one tap sends nothing");
	await act(() => item().click());
	assert.equal(restarts, 1);

	const key = (k: string) => { const e = new window.Event("keydown", { bubbles: true }); Object.defineProperty(e, "key", { value: k }); return e; };
	await act(() => document.dispatchEvent(key("Enter")));
	assert.equal(details.open, true, "other keys leave it open");
	let focused = false;
	root.querySelector("summary")!.focus = () => { focused = true; };
	await act(() => document.dispatchEvent(key("Escape")));
	assert.equal(details.open, false, "Esc closes");
	assert.equal(focused, true, "Escape restores focus to the opener");
	await toggle(true);
	await act(() => document.getElementById("elsewhere")!.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
	assert.equal(details.open, false, "an outside tap closes");
	await toggle(true);
	await act(() => root.querySelector(".shell-more-scrim")!.dispatchEvent(new window.Event("pointerdown", {bubbles:true})));
	assert.equal(details.open, false, "a tap on the scrim closes the menu");
	await toggle(true);
	await act(() => item().dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
	assert.equal(details.open, true, "a tap inside keeps it open");
	await act(() => unmount(root));
});

test("Restart session no longer renders inline; the ⋮ button is 44px and the panel stays inside the viewport", () => {
	for (const file of ["viewer-app/components/OperatorComposer.tsx", "viewer-app/screens/Overview.tsx"]) assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), "utf8"), /RestartSession/, file);
	assert.match(readFileSync(join(REPO_ROOT, "viewer-app/components/Shell.tsx"), "utf8"), /class="shell-search"[\s\S]*?<MoreMenu control=\{control\} version=\{version\} updatedAt=\{updatedAt\}\/>/, "far right of the header, after Search");
	const css = readFileSync(join(REPO_ROOT, "viewer-app/styles/shell.css"), "utf8");
	const rule = (selector: string) => new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
	assert.match(rule(".shell-more > summary"), /width: 44px; height: 44px/);
	assert.match(rule(".shell-more-panel"), /max-width: calc\(100vw - 16px\)/);
	assert.match(rule(".shell-more-panel"), /var\(--surface\)/, "theme tokens, so light and dark both hold");
});

// cp-wuhl: the menu once shared `.more-menu` with the More screen's list; the one bundled stylesheet gave the <details>
// `overflow: hidden`, so a tap toggled it open and the absolutely placed panel was clipped to nothing.
test("⋮ menu: its classes are styled by shell.css alone, so no other screen's rule can clip the open panel", () => {
	const classes = new Set([...draw(view(status(), restarting("stopping"))).matchAll(/class="([^"]+)"/g)].flatMap(m => m[1]!.split(/\s+/)));
	classes.add("shell-more-panel");
	assert.ok(classes.has("shell-more") && classes.has("shell-more-dot"), [...classes].join(" "));
	const dirs = ["viewer-app/components", "viewer-app/screens", "viewer-app/styles"];
	const sheets = dirs.flatMap(dir => readdirSync(join(REPO_ROOT, dir)).filter(f => f.endsWith(".css")).map(f => `${dir}/${f}`));
	assert.ok(sheets.includes("viewer-app/screens/more.css"), "the scan covers the More screen's stylesheet");
	for (const sheet of sheets.filter(s => s !== "viewer-app/styles/shell.css")) {
		const css = readFileSync(join(REPO_ROOT, sheet), "utf8");
		for (const cls of classes) assert.doesNotMatch(css, new RegExp(`\\.${cls}(?![\\w-])`), `${sheet} styles .${cls}`);
	}
});

test("shell exposes the desktop live clock and shortcut without wrapping Sessions", async () => {
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Shell} from "./viewer-app/components/Shell.tsx"; export const draw=()=>render(h(Shell,{current:{screen:"sessions",query:"view=you"},awaiting:0,status:"live",updatedAt:"2026-10-06T08:30:00Z"},h("div",{class:"sessions"})));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {draw} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const {document} = parseHTML(draw());
 assert.ok(document.querySelector(".shell-main > .sessions"));
 assert.ok(document.querySelector(".shell-page-bar .shell-live-live > span"));
 assert.equal(document.querySelector(".shell-page-bar time")?.getAttribute("datetime"),"2026-10-06T08:30:00Z");
 assert.match(document.querySelector(".shell-page-bar time")?.textContent ?? "",/^updated /);
 assert.equal(document.querySelector(".shell-desktop-search kbd")?.textContent,"⌘K");
});

test("desktop title clearance skips real recovery headings and still targets Overview", async () => {
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Shell} from "./viewer-app/components/Shell.tsx"; import {NotFound,notFoundFor} from "./viewer-app/components/NotFound.tsx"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const draw=(current,data)=>render(h(Shell,{current,awaiting:0,status:"live",updatedAt:"2026-10-06T08:30:00Z"},data?h(Overview,{data}):h(NotFound,notFoundFor(current,404))));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {draw} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const css = readFileSync(join(REPO_ROOT,"viewer-app/styles/shell.css"),"utf8");
 const selector = /([^{}]+)\{ margin-right: 248px; \}/.exec(css)?.[1]?.trim();
 assert.ok(selector,"the desktop title reservation exists");
 for (const current of [{screen:"job",jobId:"cp-doesnotexist"},{screen:"sessions",query:"view=workers&id=cp-doesnotexist"}]) {
  const doc = parseHTML(draw(current)).document;
  assert.ok(doc.querySelector('.shell-main > .not-found > h1'));
  assert.ok(doc.querySelector(selector) === null,"recovery content below the clock needs no top-band clearance");
 }
 const {overview} = await import("../src/viewer/overview-view.ts");
 const {createScratchHome} = await import("./harness/index.ts");
 const home = createScratchHome();
 try {
  const data = overview({home:home.path,stateDir:join(home.path,".pi-command-post/state")});
  assert.equal(parseHTML(draw({screen:"overview"},data)).document.querySelector(selector)?.className,"overview-heading");
 } finally { home.cleanup(); }
});
