/**
 * The desktop sidebar's resize handle, through `bin/cp-view` on a scratch home and the served app in a wide linkedom
 * tab (DOM, served CSS and localStorage; no layout, so the width is read from `--sidebar-width` and aria-valuenow).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboard, openTab, type Tab, until } from "../harness/dashboard.ts";

const KEY = "cp-sidebar-width";
const HANDLE = ".shell > .sidebar-resizer";
const width = (tab: Tab) => [tab.$(".shell")?.getAttribute("style") ?? "", tab.$(HANDLE)?.getAttribute("aria-valuenow")];
const pointer = (tab: Tab, target: EventTarget, type: string, clientX: number) =>
	target.dispatchEvent(Object.assign(new tab.window.Event(type, { bubbles: true, cancelable: true }), { clientX, button: 0 }));
const drag = (tab: Tab, from: number, to: number) => {
	pointer(tab, tab.$(HANDLE)!, "pointerdown", from);
	pointer(tab, tab.window, "pointermove", to);
	pointer(tab, tab.window, "pointerup", to);
};

// Scenario: a dragged width survives a reload, clamped to 180–480 px
//   Given the Jobs page on a desktop tab with no stored width
//   When the operator drags the handle, reloads, drags past the maximum, steps with the keyboard and double-clicks
//   Then each width is applied, stored and restored, never outside the bounds, and the reset returns the 208 px default
test("sidebar-resize: drag, reload, clamp, keyboard and double-click reset through the served app", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t);
	const storage = new Map<string, string>();
	let tab = await openTab(t, d.port, "#jobs", storage, undefined, {}, true);
	const handle = await tab.find(HANDLE);
	assert.deepEqual(["role", "aria-orientation", "tabindex", "aria-valuemin", "aria-valuemax", "aria-valuenow"].map((a) => handle.getAttribute(a)),
		["separator", "vertical", "0", "180", "480", "208"], "a focusable vertical separator at the 208 px default");
	assert.deepEqual([width(tab)[0], storage.has(KEY)], ["", false], "no width is set or stored before the operator resizes");

	drag(tab, 208, 300);
	await until(() => width(tab), ([style, now]) => /--sidebar-width:\s*300px/.test(style) && now === "300", "the dragged width");
	assert.equal(storage.get(KEY), "300", "the drop is stored");

	tab = await tab.reopen();
	await until(() => width(tab), ([style, now]) => /--sidebar-width:\s*300px/.test(style) && now === "300", "the width after a reload");
	drag(tab, 300, 2000);
	await until(() => width(tab)[1], (now) => now === "480", "a drag past the maximum");
	assert.equal(storage.get(KEY), "480", "the stored width is the clamped one");
	tab = await tab.reopen();
	await until(() => width(tab), ([style, now]) => /--sidebar-width:\s*480px/.test(style) && now === "480", "the clamped width after a reload");

	assert.equal(tab.key(tab.$(HANDLE)!, "ArrowLeft").defaultPrevented, true, "the arrow key is the handle's");
	await until(() => storage.get(KEY), (v) => v === "464", "ArrowLeft steps 16 px");
	tab.key(tab.$(HANDLE)!, "Home");
	await until(() => width(tab)[1], (now) => now === "180", "Home goes to the minimum");
	tab.key(tab.$(HANDLE)!, "ArrowLeft");
	await until(() => storage.get(KEY), (v) => v === "180", "a step below the minimum stays clamped");

	tab.$(HANDLE)!.dispatchEvent(new tab.window.Event("dblclick", { bubbles: true }));
	await until(() => width(tab), ([style, now]) => !/--sidebar-width:\s*\d/.test(style) && now === "208", "double-click resets to the default");
	assert.equal(storage.has(KEY), false, "the reset forgets the stored width");

	// A stored value out of range is clamped; one that is not a number falls back to the default.
	for (const [raw, now, style] of [["9999", "480", /--sidebar-width:\s*480px/], ["12", "180", /--sidebar-width:\s*180px/], ["wide", "208", /^$/]] as const) {
		const next = await openTab(t, d.port, "#jobs", new Map([[KEY, raw]]), undefined, {}, true);
		await until(() => width(next), ([s, n]) => style.test(s) && n === now, `stored ${raw}`);
	}

	// Served CSS: both columns read the variable; the handle resizes on desktop only, so the phone layout is unchanged.
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	assert.match(css, /\.shell-sidebar,\.sidebar-resizer\{display:none\}/);
	assert.match(css, /width:var\(--sidebar-width,208px\)/);
	assert.match(css, /grid-template-columns:var\(--sidebar-width,261px\) minmax\(0,1fr\)/);
	assert.match(css, /\.sidebar-resizer\{display:block;[^}]*cursor:col-resize/);
});

// Scenario: the Chats column shares the stored width
//   Given a stored 320 px width
//   When the operator opens Chats on a desktop tab
//   Then the chat column's own handle reports 320 px, and a reset reports the column's 261 px default
test("sidebar-resize-chats: the Chats column draws its own handle on the shared width", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t);
	const storage = new Map([[KEY, "320"]]);
	const tab = await openTab(t, d.port, "#sessions?view=you", storage, undefined, {}, true);
	const handle = await tab.find(".sessions > .sidebar-resizer");
	assert.equal(handle.getAttribute("aria-valuenow"), "320");
	assert.equal(tab.$$(".sidebar-resizer").length, 1, "the shell drops its handle with its rail");
	handle.dispatchEvent(new tab.window.Event("dblclick", { bubbles: true }));
	await until(() => tab.$(".sessions > .sidebar-resizer")?.getAttribute("aria-valuenow"), (now) => now === "261", "the Chats default");
	assert.equal(storage.has(KEY), false);
});
