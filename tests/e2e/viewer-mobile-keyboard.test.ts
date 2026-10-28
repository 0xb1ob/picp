/**
 * Behavior 19 (P19b): the phone keyboard (cp-kbd). The served Sessions screen pins its shell to the visual viewport
 * and never leaves the page scrolled; the served stylesheet fixes the shell on a phone and sizes the composer; the
 * served page asks for keyboard resizing without zoom. Linkedom tab and served text only: no layout or pixels.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { viewer } from "../harness/conversations.ts";
import { until } from "../harness/dashboard.ts";

/** Every `@media <query>{…}` block's body in the minified stylesheet, joined. */
function media(css: string, query: string): string {
	const out: string[] = [];
	for (let at = css.indexOf(`@media${query}{`); at >= 0; at = css.indexOf(`@media${query}{`, at + 1)) {
		let depth = 0, end = at;
		for (let i = css.indexOf("{", at); i < css.length; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}" && --depth === 0) { end = i; break; }
		}
		out.push(css.slice(css.indexOf("{", at) + 1, end));
	}
	return out.join("\n");
}

test("P19-kbd-fit: Sessions follows the visual viewport's height and pan, resets the page scroll, and refits on a tapped field", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const tab = await d.open("#jobs");
	const listeners = new Map<string, Set<() => void>>();
	let scrollY = 0;
	const scrolls: number[] = [];
	// An iPhone-sized page with the keyboard open: the visible area is shorter, and panned down 214 px.
	const viewport = {
		height: 402, offsetTop: 214,
		addEventListener: (type: string, listener: () => void) => void listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)),
		removeEventListener: (type: string, listener: () => void) => void listeners.get(type)?.delete(listener),
	};
	const fire = (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); };
	Object.defineProperties(tab.window, {
		visualViewport: { configurable: true, value: viewport },
		scrollY: { configurable: true, get: () => scrollY },
		scrollTo: { configurable: true, value: (x: number, y: number) => { scrolls.push(x, y); scrollY = y; } },
	});
	const read = (name: string) => (tab.document.documentElement as unknown as { style: { getPropertyValue(n: string): string } }).style.getPropertyValue(name);
	scrollY = 120;
	tab.go("#sessions");
	await until(() => read("--cp-viewport-height"), (height) => height === "402px", "the Sessions shell to fit the visual viewport");
	assert.equal(read("--cp-viewport-offset"), "214px", "it moves down with the keyboard's pan, so the composer stays above it");
	assert.deepEqual(scrolls.slice(-2), [0, 0], "the page itself is reset: only the transcript scroller scrolls");
	assert.equal(scrollY, 0, "window.scrollY stays 0 while the keyboard is open");

	// The keyboard closes: the visible area grows back and the pan goes away.
	viewport.height = 640; viewport.offsetTop = 0;
	fire("resize");
	assert.deepEqual([read("--cp-viewport-height"), read("--cp-viewport-offset")], ["640px", "0px"], "a resize refits");
	// The page panned under the shell; the offset is the visual viewport's own pan, net of the scroll just undone.
	scrollY = 37; viewport.offsetTop = 251;
	fire("scroll");
	assert.deepEqual([read("--cp-viewport-offset"), scrollY], ["251px", 0], "a later pan fires scroll and refits");
	// Focusing a field fits on its own, before the keyboard's resize lands.
	viewport.height = 380; viewport.offsetTop = 273;
	const field = await tab.find(".sessions textarea, .sessions input");
	field.dispatchEvent(new tab.window.Event("focusin", { bubbles: true }));
	assert.deepEqual([read("--cp-viewport-height"), read("--cp-viewport-offset")], ["380px", "273px"], "a tapped field refits before the resize");
	tab.go("#jobs");
	await until(() => read("--cp-viewport-height"), (height) => height === "", "leaving Sessions to clear the fit");
	assert.equal(listeners.get("resize")?.size ?? 0, 0, "leaving Sessions stops following the viewport");
});

test("P19-kbd-css: the served page and stylesheet pin the phone shell, stop page scroll, and size the composer row", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const page = (await d.get("/")).text;
	const viewportMeta = /<meta name="viewport" content="([^"]+)"/.exec(page)?.[1] ?? "";
	assert.ok(viewportMeta.includes("interactive-widget=resizes-content"), "Android Chrome resizes its content for the keyboard");
	assert.ok(viewportMeta.includes("user-scalable=no"), "no zooming (operator 2026-09-27)");
	assert.ok(viewportMeta.includes("viewport-fit=cover"), "non-zero safe-area insets");
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec(page)?.[1]))).text;
	const phone = media(css, "(max-width:899px)"), desktop = media(css, "(min-width:900px)");

	assert.match(css, /@property --cp-viewport-offset\{syntax: "<length>"; inherits: true; initial-value: 0px;\}/, "typed, defaulted and inherited, so the root's offset reaches the shell");
	assert.match(css, /\.shell:has\(>\.shell-main>\.sessions\)\{height:var\(--cp-viewport-height, 100dvh\)\}/, "the shell's height is the visible area");
	assert.match(phone, /html:has\(\.shell>\.shell-main>\.sessions\),html:has\(\.shell>\.shell-main>\.sessions\)>body\{overflow:hidden;overscroll-behavior:none\}/, "no page scroll and no rubber-banding behind the shell");
	assert.match(phone, /\.shell:has\(>\.shell-main>\.sessions\)\{position:fixed;inset:0 auto auto 0;width:100%;transform:translateY\(var\(--cp-viewport-offset, 0px\)\)\}/, "fixed to the visual viewport, moved by its pan");
	assert.ok(desktop.length > 0, "the desktop block is served"); assert.doesNotMatch(desktop, /position:fixed;inset:0 auto auto 0/, "desktop keeps the ordinary flex shell");

	// Measured (Chromium, 1440x900 and 390x844): `.sessions { height: 100% }` under a 64 px page bar hid the composer.
	assert.match(css, /\.shell-main:has\(>\.sessions\)\{display:flex;flex-direction:column\}/, "main stacks its children, so siblings above .sessions take their own height");
	assert.match(css, /\.shell-main>\.sessions\{flex:1 1 0\}/, "and .sessions takes only what is left");
	assert.match(css, /\.session-transcript\{flex:1;min-height:0;overflow-y:auto;/, "the transcript scrolls above the composer");
	assert.match(css, /\.operator-composer\{[^}]*padding-bottom:calc\(8px \+ env\(safe-area-inset-bottom\)\);[^}]*flex-shrink:0/, "the composer never shrinks and clears the home indicator");

	assert.doesNotMatch(css, /operator-composer-field>\.operator-composer-attach/, "the attach icon is never positioned over the field");
	assert.match(css, /\.operator-composer textarea\{[^}]*padding:10px 12px;/, "the field keeps its own padding only");

	// Chat v2 (PR5): below 900 px the footer flattens into the box's row; the thread and Options live in the top bar.
	assert.match(css, /\.operator-composer-box\{display:flex;align-items:flex-end;/, "one flex row of 44 px targets");
	assert.match(css, /\.operator-composer-footer\{display:contents\}/, "the footer's controls share the field's row");
	assert.match(phone, /\.operator-composer-field\{order:1\}/);
	assert.match(phone, /\.operator-composer-more,\.operator-composer-send\{order:2\}/, "send stays at the row's end");
	assert.match(phone, /\.operator-composer-options,\.operator-composer-thread\{display:none\}/, "Options is desktop-only; the top bar carries the thread");
	assert.match(phone, /\.operator-composer-attach,\.operator-composer-send,\.operator-composer-more>summary\{width:44px;height:44px\}/);
	assert.match(phone, /\.operator-composer textarea\{min-height:46px;padding:12px 16px;border-radius:22px;font-size:16px\}/, "a 16 px field");
	assert.match(css, /\.thread-pill>select\{position:absolute;inset:-6px 0;width:100%;[^}]*opacity:0;/, "the native select stays the control");
	assert.match(css, /\.session-bar-id\{position:relative;flex:1;align-self:stretch;/, "the bar's name column is the # target");
	assert.match(css, /\.session-bar-sub>\.thread-pill\{position:static;/, "so its select covers the whole column");
	assert.match(css, /\.session-bar-icon,\.session-bar-more>summary\{position:relative;width:44px;height:44px;/, "back and ⋯ are 44 px");
});
