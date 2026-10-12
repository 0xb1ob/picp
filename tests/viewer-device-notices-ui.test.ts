/** Remote dashboard PR 1d, the page: the global pairing notice (SSR via preact-render-to-string), its pure helpers and its 390/1440 px CSS. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import type { DeviceNotice, DeviceNoticesResponse } from "../src/viewer/api-types.ts";
import { deliverySummary, type DeviceNoticesState, unreadNotices } from "../viewer-app/use-device-notices.ts";
import { REPO_ROOT } from "./harness/index.ts";

const notice = (id: string, at: string, over: Partial<DeviceNotice> = {}): DeviceNotice => ({
	id, at, device_id: "dev-0123456789abcdef", name: "Phone", level: "view", route: "cli-pair",
	recipients: [
		{ device_id: "dev-aaaaaaaaaaaaaaaa", name: "Laptop", state: "delivered", attempts: 1, updated_at: at, last_error: null },
		{ device_id: "dev-0123456789abcdef", name: "Phone", state: "unsubscribed", attempts: 0, updated_at: at, last_error: "no push subscription on this device" },
	],
	...over,
});
const data = (notices: DeviceNotice[], delivery_error: string | null = null): DeviceNoticesResponse => ({ generated_at: "2026-09-27T00:00:00Z", delivery_error, notices });

async function renderer() {
	const built = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {DeviceNoticesView} from "./viewer-app/components/DeviceNotices.tsx"; export const draw=(state,cursor)=>render(h(DeviceNoticesView,{state,cursor,onDismiss:()=>{}}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	return (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { draw: (state: DeviceNoticesState, cursor: string) => string }).draw;
}

test("DeviceNotices: New device paired with name, level, time, honest push state and a Devices link; names are text; off and dismissed render nothing; errors are visible", async () => {
	const draw = await renderer();
	const html = draw({ kind: "ok", data: data([notice("pair-0000000000000002", "2026-09-27T10:00:00.000Z", { name: "<img src=x onerror=alert(1)>", level: "full" }), notice("pair-0000000000000001", "2026-09-27T09:00:00.000Z")]) }, "");
	assert.match(html, /<section class="device-notices" role="status" aria-label="New device paired">/);
	assert.match(html, /New device paired: &lt;img src=x onerror=alert\(1\)> · Full control · <time datetime="2026-09-27T10:00:00.000Z" title="2026-09-27T10:00:00.000Z">/);
	assert.match(html, /New device paired: Phone · View only · /);
	assert.match(html, /push: 1 delivered to push service · 1 not subscribed/);
	assert.match(html, /<a href="#settings">Devices<\/a><button type="button">Dismiss<\/button>/);
	assert.doesNotMatch(html, /<img/);

	assert.equal(draw({ kind: "ok", data: data([notice("pair-0000000000000001", "2026-09-27T09:00:00.000Z")]) }, "2026-09-27T09:00:00.000Z"), "", "dismissed on this browser");
	assert.equal(draw({ kind: "off" }, ""), "", "no device routes here: nothing, as before");
	assert.equal(draw({ kind: "loading" }, ""), "");
	assert.match(draw({ kind: "error", error: "HTTP 503", data: null }, ""), /Pairing notices unavailable \(HTTP 503\)/);
	const stale = draw({ kind: "error", error: "HTTP 503", data: data([notice("pair-0000000000000001", "2026-09-27T09:00:00.000Z")]) }, "");
	assert.match(stale, /New device paired: Phone/, "an offline tab keeps its unread notice");
	assert.match(stale, /showing the last read/);
	const many = draw({ kind: "ok", data: data(["5", "4", "3", "2", "1"].map((n) => notice(`pair-000000000000000${n}`, `2026-09-27T0${n}:00:00.000Z`))) }, "");
	assert.equal(many.match(/class="device-notice"/g)?.length, 3);
	assert.match(many, /\+2 more/);
});

test("device notice helpers: unread is newer than this browser's cursor; the summary never reports an unreadable ledger as delivered", () => {
	const list = [notice("pair-0000000000000002", "2026-09-27T10:00:00.000Z"), notice("pair-0000000000000001", "2026-09-27T09:00:00.000Z")];
	assert.deepEqual(unreadNotices(list, "").map((n) => n.id), ["pair-0000000000000002", "pair-0000000000000001"]);
	assert.deepEqual(unreadNotices(list, "2026-09-27T09:00:00.000Z").map((n) => n.id), ["pair-0000000000000002"]);
	assert.equal(deliverySummary(list[0]!.recipients, "the pairing-alert delivery ledger is unreadable"), "push status unavailable: the pairing-alert delivery ledger is unreadable");
	assert.equal(deliverySummary([], null), "push: no recipients");
});

test("device notice CSS: wraps at 390 px (no fixed widths, long names break), one row of actions at 1440 px; mounted on every screen", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/components/device-notices.css"), "utf8");
	const rule = (selector: string) => new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
	assert.match(rule(".device-notices"), /flex-wrap: wrap/);
	assert.match(rule(".device-notices"), /min-width: 0/);
	assert.match(rule(".device-notices"), /max-width: 100%/);
	for (const selector of [".device-notices", ".device-notice", ".device-notices-error"]) assert.match(rule(selector), /overflow-wrap: anywhere/, selector);
	assert.match(rule(".device-notices-list"), /flex: 1 1 320px/, "shares the row with its actions at 1440 px, wraps below them at 390 px");
	assert.doesNotMatch(css, /white-space: nowrap|[^-]width: \d/);
	assert.match(readFileSync(join(REPO_ROOT, "viewer-app/main.tsx"), "utf8"), /import "\.\/components\/device-notices\.css";/);
	assert.match(readFileSync(join(REPO_ROOT, "viewer-app/components/Shell.tsx"), "utf8"), /<main class=[^>]*><DeviceNotices updatedAt=\{updatedAt\}\/>/, "above every screen, independent of Settings");
});
