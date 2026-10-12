/** Remote dashboard PR 3: Settings → Devices (hook + component) against a fake home, mounted with linkedom; Settings keeps it when operator Settings are offline. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { DEVICE_TRUST, type DevicesResponse } from "../src/viewer/api-types.ts";
import type { DeviceView } from "../src/viewer/device-files.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Devices} from "./viewer-app/components/Devices.tsx"; import {Settings} from "./viewer-app/screens/Settings.tsx"; import {useDevices} from "./viewer-app/use-devices.ts"; export {act}; const Page=({fetcher,confirm,settings})=>{const view=useDevices(fetcher,confirm); const devices=h(Devices,{view}); return settings ? h(Settings,{view:settings},devices) : devices;}; export const mount=(root,fetcher,confirm,settings)=>render(h(Page,{fetcher,confirm,settings}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
const { act, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; mount: (root: unknown, fetcher: Fetcher, confirm: (text: string) => boolean, settings?: unknown) => void; unmount: (root: unknown) => void;
};
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const TOKEN = "d".repeat(64);
const ORIGIN = "https://amber-otter.trycloudflare.com";
const LINK = `${ORIGIN}/pair#${"s".repeat(43)}`;

const device = (id: string, name: string, over: Partial<DeviceView> = {}): DeviceView => ({
	id, name, level: "full", origin: ORIGIN, generation: 1, state: "active", created_at: "2026-09-27T09:00:00.000Z", last_seen_at: "2026-09-27T10:00:00.000Z",
	expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null, pairing_id: `pair-${id.slice(4)}`, ...over,
});
const listing = (over: Partial<DevicesResponse> = {}): DevicesResponse => ({
	generated_at: "2026-09-27T10:00:00.000Z", origin: ORIGIN, pending_codes: 0, token: TOKEN, can_create: true, can_revoke: true, trust: DEVICE_TRUST,
	devices: [device("dev-0000000000000001", "<img src=x onerror=alert(1)>"), device("dev-0000000000000002", "Tablet", { level: "view", revoked_at: "2026-09-27T11:00:00.000Z" })],
	events: [{ id: "pair-0000000000000001", at: "2026-09-27T09:00:00.000Z", device_id: "dev-0000000000000001", name: "Phone", level: "full", route: "loopback-dashboard", recipients: [], state: "active" }],
	...over,
});

/** A fake home: GET /api/devices answers `list()`, POSTs are recorded and answered by `post`. */
function home(list: () => [number, unknown], post: (url: string, body: Record<string, unknown>) => [number, unknown] = () => [500, {}]) {
	const posts: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
	const fetcher: Fetcher = async (url, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			posts.push({ url, headers: init.headers as Record<string, string>, body });
			const [status, answer] = post(url, body);
			return new Response(JSON.stringify(answer), { status });
		}
		const [status, answer] = list();
		return new Response(JSON.stringify(answer), { status });
	};
	return { fetcher, posts };
}

const stacks = new WeakMap<object, Array<() => Promise<void>>>();
async function page(t: import("node:test").TestContext, fetcher: Fetcher, options: { confirm?: (text: string) => boolean; settings?: unknown } = {}) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	const writes: string[] = [];
	const storage = { getItem: () => null, setItem: (key: string) => void writes.push(key), removeItem: () => {} };
	const savedStorage = [Object.getOwnPropertyDescriptor(globalThis, "localStorage"), Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")] as const;
	for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, name, { configurable: true, value: storage });
	const root = document.getElementById("root")!;
	const settle = async () => { for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 1))); };
	// Several pages in one test: tear down newest first, so each unmount still sees its own document.
	let stack = stacks.get(t);
	if (!stack) {
		const fresh: Array<() => Promise<void>> = [];
		stacks.set(t, (stack = fresh));
		t.after(async () => { for (const cleanup of fresh.reverse()) await cleanup(); });
	}
	stack.push(async () => {
		await act(() => unmount(root));
		if (saved) Object.defineProperty(globalThis, "document", saved); else Reflect.deleteProperty(globalThis, "document");
		for (const [i, name] of (["localStorage", "sessionStorage"] as const).entries()) { const d = savedStorage[i]; if (d) Object.defineProperty(globalThis, name, d); else Reflect.deleteProperty(globalThis, name); }
	});
	await act(() => mount(root, fetcher, options.confirm ?? (() => true), options.settings));
	await settle();
	const buttons = () => [...root.querySelectorAll("button")].map((b) => b.textContent);
	const click = async (label: string) => {
		const button = [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;
		assert.ok(button, `no ${label} button in ${root.innerHTML}`);
		await act(() => { button.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
		await settle();
	};
	return { root, buttons, click, settle, writes, window };
}

test("local: names are text, level/created/last use/revocation shown, trust statement verbatim; Add posts the level with the token and shows a QR + link never stored", async (t) => {
	const fake = home(() => [200, listing()], (url) => url === "/api/pair/create" ? [201, { level: "view", expires_at: new Date(Date.now() + 300_000).toISOString(), link: LINK }] : [500, {}]);
	const p = await page(t, fake.fetcher);
	const text = p.root.textContent ?? "";
	assert.ok(text.includes(DEVICE_TRUST), "the approved statement, verbatim");
	assert.match(p.root.innerHTML, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
	assert.doesNotMatch(p.root.innerHTML, /<img/);
	assert.match(text, /Full control/);
	assert.match(text, /View only · revoked/);
	assert.match(text, /via this machine's dashboard · last used/);
	assert.deepEqual(p.buttons(), ["Revoke", "Add device"], "a revoked device has no Revoke");

	const select = p.root.querySelector(".devices-add select")!;
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === "view");
	await act(() => { select.dispatchEvent(new p.window.Event("change", { bubbles: true })); });
	await p.click("Add device");
	assert.deepEqual(fake.posts.map((x) => [x.url, x.body, x.headers["x-cp-control-token"]]), [["/api/pair/create", { level: "view" }, TOKEN]]);
	assert.match(p.root.querySelector(".devices-pairing")?.innerHTML ?? "", /<svg [^>]*class="devices-qr"[^>]*>.*<path [^>]*d="M\d/, "a drawn QR");
	assert.equal(p.root.querySelector(".devices-link")?.textContent, LINK);
	assert.deepEqual(p.writes, [], "no pairing secret in browser storage");
	await p.click("Hide link");
	assert.equal(p.root.querySelector(".devices-link"), null);
});

test("revoke: confirms first, posts the id with the token, refreshes; a declined confirm sends nothing", async (t) => {
	let revoked = false;
	const fake = home(() => [200, listing({ devices: [device("dev-0000000000000001", "Phone", revoked ? { revoked_at: "2026-09-27T12:00:00.000Z" } : {})] })], (_url, body) => ((revoked = true), [200, { id: body.id, revoked_at: "2026-09-27T12:00:00.000Z", audit_error: null, cleanup_error: null }]));
	let answer = false;
	const asked: string[] = [];
	const p = await page(t, fake.fetcher, { confirm: (text) => (asked.push(text), answer) });
	await p.click("Revoke");
	assert.equal(fake.posts.length, 0);
	answer = true;
	await p.click("Revoke");
	assert.deepEqual(fake.posts.map((x) => [x.url, x.body, x.headers["x-cp-control-token"]]), [["/api/devices/revoke", { id: "dev-0000000000000001" }, TOKEN]]);
	assert.match(asked[0]!, /Revoke Phone\?/);
	assert.match(p.root.textContent ?? "", /Revoked Phone/);
	assert.match(p.root.textContent ?? "", /revoked 27 Sept|revoked 27 Sep/, "the list re-read after the write");
	assert.deepEqual(p.buttons(), ["Add device"]);
});

test("remote Full control: list and Revoke, never Add; View only: list and the trust explanation, no write buttons", async (t) => {
	const full = await page(t, home(() => [200, listing({ can_create: false })]).fetcher);
	assert.deepEqual(full.buttons(), ["Revoke"]);
	assert.match(full.root.textContent ?? "", /a remote device can never add one/);
	const view = await page(t, home(() => [200, listing({ can_create: false, can_revoke: false, token: null })]).fetcher);
	assert.deepEqual(view.buttons(), []);
	assert.match(view.root.textContent ?? "", /View only: you can see devices but not change them/);
	assert.ok((view.root.textContent ?? "").includes(DEVICE_TRUST));
});

test("off (404), unreadable store, refused Add and an expired pairing link are all visible, never silent", async (t) => {
	const off = await page(t, home(() => [404, { error: "not found" }]).fetcher);
	assert.match(off.root.textContent ?? "", /remote dashboard is off on this home.*cp-tunnel up/);
	assert.ok((off.root.textContent ?? "").includes(DEVICE_TRUST));

	const broken = await page(t, home(() => [503, { error: "store_invalid" }]).fetcher);
	assert.match(broken.root.querySelector('[role="alert"]')?.textContent ?? "", /Devices unavailable: The device list is unreadable on this home/);

	const full = await page(t, home(() => [200, listing()], () => [429, { error: "too_many_codes" }]).fetcher);
	await full.click("Add device");
	assert.match(full.root.textContent ?? "", /Three pairing links are already live/);

	const stopped = await page(t, home(() => [200, listing({ origin: null })]).fetcher);
	assert.match(stopped.root.textContent ?? "", /not running/);
	assert.equal(stopped.root.querySelector<HTMLButtonElement>(".devices-add button")?.disabled, true, "no code without a running tunnel");

	const expiring = await page(t, home(() => [200, listing()], () => [201, { level: "full", expires_at: new Date(Date.now() + 30).toISOString(), link: LINK }]).fetcher);
	await expiring.click("Add device");
	await new Promise((done) => setTimeout(done, 60));
	await expiring.settle();
	assert.equal(expiring.root.querySelector(".devices-link"), null, "cleared at expiry");
	assert.match(expiring.root.textContent ?? "", /pairing link expired/);
});

test("Settings keeps Devices when operator Settings are unavailable", async (t) => {
	const settings = { status: { error: "HTTP 503" }, token: null, busy: false, notice: null, save: async () => false, restore: async () => false };
	const p = await page(t, home(() => [200, listing({ can_create: false })]).fetcher, { settings });
	assert.match(p.root.textContent ?? "", /Settings unavailable: HTTP 503/);
	assert.ok(p.root.querySelector('section[aria-label="Devices"]'), "Devices still rendered");
	assert.deepEqual(p.buttons(), ["Revoke"]);
});

test("Devices CSS: wraps at 390 px (flex-wrap, min-width 0, QR shrinks), 44 px controls; QR colours are tokens", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/settings.css"), "utf8");
	const rule = (selector: string) => new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
	for (const selector of [".devices-row", ".devices-pairing", ".devices-name"]) assert.match(rule(selector), /flex-wrap: wrap/, selector);
	assert.match(rule(".devices-row"), /min-width: 0/);
	assert.match(rule(".devices-qr"), /max-width: 100%/);
	assert.match(css, /\.devices-row button, \.devices-pairing button \{[^}]*min-height: 44px/);
	assert.match(rule(".devices-qr-dark"), /fill: var\(--qr-dark\)/);
});
