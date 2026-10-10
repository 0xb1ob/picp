/**
 * cp-kbd (mobile-keyboard-fix): focusing the composer on a phone put it at the
 * top of the screen, with the chat history above it, off screen. iOS never
 * resizes the layout viewport for the keyboard — it pans the *visual* one — so
 * the Sessions shell is pinned to the visual viewport, not to the page.
 *
 * These are the regression locks: the shell follows `visualViewport.height` and
 * `visualViewport.offsetTop`, the page itself is never left scrolled, and the
 * phone stylesheet fixes the shell and stops html/body scrolling. The
 * real-browser check is a Playwright run reported in the PR; there was no
 * device check.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";
import { APP_VIEWPORT } from "../src/viewer/app-page.ts";
import { VIEWPORT_HEIGHT, VIEWPORT_OFFSET } from "../viewer-app/viewport-fit.ts";

interface StubViewport { height: number; offsetTop: number; fire(type: string): void }

/** Mount the hook in a real DOM, with a visual viewport, a scroll spy and focus events the test owns. */
async function stage(t: import("node:test").TestContext, height: number, offsetTop: number) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const listeners = new Map<string, Set<() => void>>();
	let scrollY = 0;
	const scrolls: number[] = [];
	const viewport: StubViewport = {
		height, offsetTop,
		fire: (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); },
	};
	Object.defineProperties(window, {
		visualViewport: { configurable: true, value: Object.assign(viewport, {
			addEventListener: (type: string, listener: () => void) => { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
			removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); },
		}) },
		scrollY: { configurable: true, get: () => scrollY },
		scrollTo: { configurable: true, value: (x: number, y: number) => { scrolls.push(x, y); scrollY = y; } },
	});
	const originals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	const result = await build({
		stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {useViewportFit} from "./viewer-app/viewport-fit.ts"; export {act}; export const mount=root=>render(h(function C(){useViewportFit(); return h("div",{class:"sessions"},h("textarea",{id:"composer"}));},{}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" },
		bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact",
	});
	const { act, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
		act: (run: () => void | Promise<void>) => Promise<void>;
		mount: (root: Element) => void;
		unmount: (root: Element) => void;
	};
	const root = document.getElementById("root")!;
	t.after(async () => { await act(() => unmount(root)); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	return {
		viewport,
		scrolls,
		scrollY: () => scrollY,
		pan: (value: number) => { scrollY = value; },
		mount: () => act(() => mount(root)),
		/** iOS pans on focus before it resizes: dispatch the focusin the hook listens for. */
		focusComposer: () => act(() => { root.querySelector("textarea")!.dispatchEvent(new window.Event("focusin", { bubbles: true })); }),
		read: (name: string) => (document.documentElement as Element & { style: { getPropertyValue(name: string): string } }).style.getPropertyValue(name),
	};
}

test("the shell follows the visual viewport: its height, and the pan the keyboard makes", async t => {
	// An iPhone-sized page with the keyboard open: the visible area is shorter, and panned down 214 px.
	const s = await stage(t, 402, 214);
	await s.mount();
	assert.equal(s.read(VIEWPORT_HEIGHT), "402px", "the shell is as tall as the visible area, not the layout viewport");
	assert.equal(s.read(VIEWPORT_OFFSET), "214px", "and it moves down with the keyboard's pan, so the composer stays above it");
	assert.deepEqual(s.scrolls.slice(-2), [0, 0], "the page itself is reset: only the transcript scroller scrolls");
	assert.equal(s.scrollY(), 0, "window.scrollY stays 0 while the keyboard is open");

	// The keyboard closes: the visible area grows back and the pan goes away.
	s.viewport.height = 640; s.viewport.offsetTop = 0;
	s.viewport.fire("resize");
	assert.equal(s.read(VIEWPORT_HEIGHT), "640px");
	assert.equal(s.read(VIEWPORT_OFFSET), "0px");
});

test("a later pan fires scroll, and a tapped field refits before the resize arrives", async t => {
	const s = await stage(t, 402, 0);
	await s.mount();
	assert.equal(s.read(VIEWPORT_OFFSET), "0px");
	// The page panned under the shell; the offset is the visual viewport's own pan, net of the scroll just undone.
	s.pan(37); s.viewport.offsetTop = 251;
	s.viewport.fire("scroll");
	assert.equal(s.read(VIEWPORT_OFFSET), "251px");
	assert.equal(s.scrollY(), 0);
	// Focusing the composer fits on its own, before the keyboard's resize lands.
	s.viewport.height = 380; s.viewport.offsetTop = 273;
	await s.focusComposer();
	assert.equal(s.read(VIEWPORT_HEIGHT), "380px");
	assert.equal(s.read(VIEWPORT_OFFSET), "273px");
});

test("phone stylesheet pins the shell to the visual viewport and stops the page scrolling", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/styles/shell.css"), "utf8");
	assert.match(css, /@property --cp-viewport-offset \{ syntax: "<length>"; inherits: true; initial-value: 0px; \}/, "typed and defaulted, and inherited: the root's offset must reach the shell it moves");
	assert.match(css, /\.shell:has\(> \.shell-main > \.sessions\) \{ height: var\(--cp-viewport-height, 100dvh\); \}/, "the shell's height is the visible area");
	const phone = css.slice(css.indexOf("@media (max-width: 899px) {\n html:has("));
	assert.match(phone, /html:has\(\.shell > \.shell-main > \.sessions\), html:has\(\.shell > \.shell-main > \.sessions\) > body \{ overflow: hidden; overscroll-behavior: none; \}/, "no page scroll and no rubber-banding behind the shell");
	assert.match(phone, /\.shell:has\(> \.shell-main > \.sessions\) \{ position: fixed; inset: 0 auto auto 0; width: 100%; transform: translateY\(var\(--cp-viewport-offset, 0px\)\); \}/, "fixed to the visual viewport, moved by its pan");
	assert.doesNotMatch(css.slice(css.indexOf("@media (min-width: 900px) {")), /position: fixed; inset: 0 auto auto 0/, "desktop keeps the ordinary flex shell");
});

test("the app page asks Android Chrome to resize its content for the keyboard, and still never zooms", () => {
	assert.ok(APP_VIEWPORT.includes("interactive-widget=resizes-content"));
	assert.ok(APP_VIEWPORT.includes("user-scalable=no"), "no zooming (operator 2026-09-27)");
	assert.ok(APP_VIEWPORT.includes("viewport-fit=cover"), "non-zero safe-area insets");
});

test("the Sessions screen shares .shell-main with the page bar and banners: it fills the rest, never height: 100% on top of them", () => {
	// Measured (Chromium, 1440x900 and 390x844): `.sessions { height: 100% }` under a 64 px page bar pushed the composer 64 px below the viewport.
	const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/sessions.css"), "utf8");
	assert.match(css, /\.shell-main:has\(> \.sessions\) \{ display: flex; flex-direction: column; \}/, "main stacks its children, so siblings above .sessions take their own height");
	assert.match(css, /\.shell-main > \.sessions \{ flex: 1 1 0; \}/, "and .sessions takes only what is left");
	assert.match(css, /\.session-transcript \{ flex: 1; min-height: 0; overflow-y: auto;/, "the transcript scrolls above the composer");
	assert.match(readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8"), /\.operator-composer \{[^}]*padding-bottom: calc\(8px \+ env\(safe-area-inset-bottom\)\);[^}]*flex-shrink: 0;/, "the composer never shrinks and clears the home indicator");
});

test("the attach icon never overlaps composer text: the textarea keeps 42px left padding past the generic textarea rule", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8");
	const generic = css.indexOf(".operator-composer textarea {");
	const pad = css.indexOf(".operator-composer .operator-composer-field > textarea { padding-left: 42px; }");
	assert.ok(generic > 0 && pad > 0, "both rules exist");
	assert.match(css.slice(generic, css.indexOf("}", generic)), /padding: 10px 12px/, "the generic rule sets padding");
	assert.ok(pad < generic, "the field rule is earlier, so it must out-rank by specificity (2 classes + element vs 1 class + element)");
	assert.doesNotMatch(css, /\n\.operator-composer-field > textarea \{ padding-left/, "a bare one-class field selector loses to the generic rule");
});

test("the collapsed phone composer shares one row with a 44px Message options target", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8");
	const phone = css.slice(css.lastIndexOf("@media (max-width: 899px) {"));
	assert.match(phone, /\.operator-composer \{ display: grid; grid-template-columns: 44px minmax\(0,1fr\); \}/, "options share the input row instead of consuming another 44px row");
	assert.match(phone, /\.operator-composer-meta \{ display: contents; \}/, "the hidden ready status leaves no empty row or gap");
	assert.match(phone, /\.operator-composer-row \{[^}]*order: 1;[^}]*grid-column: 2;/);
	assert.match(phone, /\.operator-composer-options \{[^}]*order: 1;[^}]*grid-column: 1;/);
	assert.match(phone, /\.operator-composer-options > summary \{[^}]*width: 44px;[^}]*height: 44px;/, "the disclosure keeps its touch target");
});
