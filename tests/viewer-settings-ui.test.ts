/** cp-settings-minimal: the Settings screen (three sections) and its fetch helpers, against a real snapshot. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { LAYOUT, SETTING_FIELDS, type SettingsSnapshot } from "../src/contracts.ts";
import { readSettings } from "../src/settings.ts";
import type { SettingsResponse } from "../src/viewer/api-types.ts";
import { writeSettings } from "../viewer-app/settings-control.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Settings} from "./viewer-app/screens/Settings.tsx"; import {useSettingsControl} from "./viewer-app/use-settings-control.ts"; export {act}; const Page=({fetcher})=>h(Settings,{view:useSettingsControl(fetcher)}); export const mount=(root,fetcher)=>render(h(Page,{fetcher}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
const {act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; mount: (root: unknown, fetcher: Fetcher) => void; unmount: (root: unknown) => void;
};
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const TOKEN = "t".repeat(64);

function snapshot(routing: boolean): SettingsSnapshot {
	const home = createScratchHome();
	try {
		if (routing) {
			mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
			copyFileSync(join(REPO_ROOT, "defaults/routing.default.json"), join(home.path, LAYOUT.routingFile));
		}
		return readSettings(home.path, {});
	} finally { home.cleanup(); }
}

const settings = (snap: SettingsSnapshot, extra: Partial<SettingsResponse> = {}): SettingsResponse => ({ generated_at: snap.read_at, enabled: true, running: true, supported: true, writable: true, reason: null, snapshot: snap, catalog: [...SETTING_FIELDS], audit: [], ...extra });

/** A fake home: GETs answer `get()`, POSTs are recorded and answered by `post`. */
function server(get: () => SettingsResponse, post: (url: string, body: Record<string, unknown>) => [number, unknown]) {
	const posts: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
	const fetcher: Fetcher = async (url, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			posts.push({ url, headers: init.headers as Record<string, string>, body });
			const [status, answer] = post(url, body);
			return new Response(JSON.stringify(answer), { status });
		}
		if (url === "/api/settings") return new Response(JSON.stringify(get()));
		if (url === "/api/operator/control") return new Response(JSON.stringify({ generated_at: "now", enabled: true, running: true, reason: null, token: TOKEN, offline: false, held: 0, inbox_token: null }));
		return new Response("{}", { status: 404 });
	};
	return { fetcher, posts };
}

async function page(t: import("node:test").TestContext, fetcher: Fetcher) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	const confirm = (globalThis as { confirm?: unknown }).confirm;
	(globalThis as { confirm?: unknown }).confirm = () => true;
	const root = document.getElementById("root")!;
	t.after(async () => {
		await act(() => unmount(root));
		if (saved) Object.defineProperty(globalThis, "document", saved); else Reflect.deleteProperty(globalThis, "document");
		(globalThis as { confirm?: unknown }).confirm = confirm;
	});
	await act(() => mount(root, fetcher));
	// Two awaited GETs settle over a few microtask turns.
	for (let i = 0; i < 20 && !root.querySelector("section"); i++) await act(() => new Promise((done) => setTimeout(done, 1)));
	const settle = async () => { for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 1))); };
	const section = (title: string) => root.querySelector(`section[aria-label="${title}"]`)!;
	const click = async (scope: Element, label: string) => {
		const button = [...scope.querySelectorAll("button")].find((b) => b.textContent === label)!;
		await act(() => { button.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
		await settle();
	};
	const type = async (input: Element, value: string, event = "input") => {
		if (input.tagName === "SELECT") for (const option of input.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === value);
		else (input as HTMLInputElement).value = value;
		await act(() => { input.dispatchEvent(new window.Event(event, { bubbles: true })); });
	};
	return { root, section, click, type, settle };
}

test("three sections exactly; Save posts If-Match, the control token and only the drafted keys; a 412 keeps the draft", async (t) => {
	let snap = snapshot(true);
	let stale = true;
	const { fetcher, posts } = server(() => settings(snap), (_url, body) => {
		if (stale) { stale = false; snap = { ...snap, revision: "b".repeat(64) }; return [412, { status: 412, state: "stale", error: "stale revision", snapshot: snap }]; }
		return [200, { status: 200, state: "applied", changes: [{ key: "models.parent" }] }];
	});
	const ui = await page(t, fetcher);
	assert.deepEqual([...ui.root.querySelectorAll("section > h2")].map((h) => h.textContent), ["Worker models", "Parent and operator models", "Grant defaults"]);
	assert.equal(ui.section("Worker models").querySelectorAll("li.settings-rule").length, 6, "one row per shipped rubric entry");
	const people = ui.section("Parent and operator models");
	const parent = people.querySelector("#setting-models-parent")!;
	await ui.type(parent, "anthropic/claude-opus-5-5");
	await ui.click(people, "Save");
	assert.equal(posts.length, 1);
	assert.equal(posts[0]!.url, "/api/settings/apply");
	assert.equal(posts[0]!.headers["if-match"], `"${snapshot(true).revision}"`);
	assert.equal(posts[0]!.headers["x-cp-control-token"], TOKEN);
	assert.deepEqual(posts[0]!.body.changes, { "models.parent": "anthropic/claude-opus-5-5" });
	assert.match(String(posts[0]!.body.request_id), /^[A-Za-z0-9_-]{16}$/);
	assert.match(ui.root.querySelector(".settings-stale")?.textContent ?? "", /Changed on disk/);
	assert.equal((people.querySelector("#setting-models-parent") as HTMLInputElement).value, "anthropic/claude-opus-5-5", "the draft survives a 412");
	await ui.click(people, "Save");
	assert.equal(posts[1]!.headers["if-match"], `"${"b".repeat(64)}"`, "the retry carries the fresh revision");
	assert.deepEqual(posts[1]!.body.changes, { "models.parent": "anthropic/claude-opus-5-5" });
	assert.match(ui.root.querySelector(".settings-ok")?.textContent ?? "", /^Saved · 1 change$/);
});

test("rubric edits post the whole row list; restore bodies per section; a 400 lists its errors", async (t) => {
	const snap = snapshot(true);
	const { fetcher, posts } = server(() => settings(snap), (url) => url.endsWith("/apply") ? [400, { status: 400, state: "refused", error: "invalid settings", errors: ["row risky-any: only model, fallbacks and thinking may change"] }] : [200, { status: 200, state: "applied", changes: [] }]);
	const ui = await page(t, fetcher);
	const workers = ui.section("Worker models");
	const first = workers.querySelector("li.settings-rule")!;
	const [model, fallbacks] = [...first.querySelectorAll("input")];
	await ui.type(model!, "openai/gpt-6.1-sol");
	await ui.type(fallbacks!, "a/b, c/d", "change");
	await ui.type(first.querySelector("select")!, "low", "change");
	await ui.click(workers, "Save");
	const rows = posts[0]!.body.changes as { "models.rubric": Array<Record<string, unknown>> };
	const shipped = snap.fields.find((field) => field.key === "models.rubric")!.value as Array<Record<string, unknown>>;
	assert.deepEqual(rows["models.rubric"], [{ ...shipped[0], model: "openai/gpt-6.1-sol", fallbacks: ["a/b", "c/d"], thinking: "low" }, ...shipped.slice(1)]);
	assert.deepEqual([...ui.root.querySelectorAll(".settings-error li")].map((li) => li.textContent), ["row risky-any: only model, fallbacks and thinking may change"]);
	await ui.click(workers, "Restore defaults");
	await ui.click(ui.section("Parent and operator models"), "Restore defaults");
	await ui.click(ui.section("Grant defaults"), "Restore defaults");
	assert.deepEqual(posts.slice(1).map((post) => [post.url, post.body.keys ?? post.body.section]), [
		["/api/settings/restore", ["models.rubric"]],
		["/api/settings/restore", ["models.parent", "models.operator"]],
		["/api/settings/restore", "grants"],
	]);
});

test("read-only when the session is not writable; an absent routing.json shows one line and no rubric controls", async (t) => {
	const snap = snapshot(false);
	const { fetcher, posts } = server(() => settings(snap, { writable: false, reason: "Operator session offline: not running" }), () => [500, {}]);
	const ui = await page(t, fetcher);
	assert.match(ui.root.querySelector(".settings-readonly")?.textContent ?? "", /^Read only: Operator session offline/);
	assert.ok([...ui.root.querySelectorAll("input, select, textarea, button")].every((element) => element.hasAttribute("disabled") || element.closest("fieldset[disabled]")), "every control is disabled (a checkbox by its disabled fieldset)");
	const workers = ui.section("Worker models");
	assert.equal(workers.querySelector(".settings-readonly")?.textContent, "No data/routing.json: workers use each profile's own model.");
	assert.equal(workers.querySelectorAll("input, button").length, 0);
	assert.equal(posts.length, 0);
});

test("writeSettings: the exact restore request; a refusal without a transaction body is an error", async () => {
	const calls: Array<[string, RequestInit | undefined]> = [];
	const ok = async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ status: 200, state: "unchanged" }), { status: 200 }); };
	assert.deepEqual(await writeSettings(ok, TOKEN, "a".repeat(64), { section: "grants" }), { status: 200, body: { status: 200, state: "unchanged" } });
	assert.equal(calls[0]![0], "/api/settings/restore");
	assert.deepEqual(calls[0]![1]?.headers, { "content-type": "application/json", "if-match": `"${"a".repeat(64)}"`, "x-cp-control-token": TOKEN });
	assert.deepEqual(Object.keys(JSON.parse(String(calls[0]![1]?.body))), ["section", "request_id"]);
	const refused = async () => new Response(JSON.stringify({ error: "control token missing or stale; reload the page" }), { status: 403 });
	assert.deepEqual(await writeSettings(refused, TOKEN, "a".repeat(64), { changes: { "grants.job_cap": 4 } }), { status: 403, error: "control token missing or stale; reload the page" });
	assert.deepEqual(await writeSettings(async () => { throw new Error("down"); }, TOKEN, "a".repeat(64), { section: "grants" }), { status: 0, error: "Could not reach this home" });
});
