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
	assert.deepEqual([...ui.root.querySelectorAll("section > h2")].map((h) => h.textContent), ["Model routing", "Parent and operator models", "Grant defaults"]);
	assert.equal(ui.section("Model routing").querySelectorAll("li.settings-rule").length, 6, "one row per shipped rubric entry");
	const people = ui.section("Parent and operator models");
	const parent = people.querySelector("#setting-models-parent")!;
	await ui.type(parent, "custom", "change");
	await ui.type(parent.parentElement!.querySelector("input")!, "anthropic/claude-opus-5-5");
	assert.equal(people.querySelector(".settings-unsaved")?.textContent, "1 unsaved change");
	await ui.click(people, "Save");
	assert.equal(posts.length, 1);
	assert.equal(posts[0]!.url, "/api/settings/apply");
	assert.equal(posts[0]!.headers["if-match"], `"${snapshot(true).revision}"`);
	assert.equal(posts[0]!.headers["x-cp-control-token"], TOKEN);
	assert.deepEqual(posts[0]!.body.changes, { "models.parent": "anthropic/claude-opus-5-5" });
	assert.match(String(posts[0]!.body.request_id), /^[A-Za-z0-9_-]{16}$/);
	assert.match(ui.root.querySelector(".settings-stale")?.textContent ?? "", /Changed on disk/);
	assert.equal((people.querySelector("#setting-models-parent")!.parentElement!.querySelector("input") as HTMLInputElement).value, "anthropic/claude-opus-5-5", "the draft survives a 412");
	await ui.click(people, "Save");
	assert.equal(posts[1]!.headers["if-match"], `"${"b".repeat(64)}"`, "the retry carries the fresh revision");
	assert.deepEqual(posts[1]!.body.changes, { "models.parent": "anthropic/claude-opus-5-5" });
	assert.match(ui.root.querySelector(".settings-ok")?.textContent ?? "", /^Saved · 1 change$/);
});

test("rubric edits post the whole row list; restore bodies per section; a 400 lists its errors", async (t) => {
	const snap = snapshot(true);
	const { fetcher, posts } = server(() => settings(snap), (url) => url.endsWith("/apply") ? [400, { status: 400, state: "refused", error: "invalid settings", errors: ["row risky-any: only model, fallbacks and thinking may change"] }] : [200, { status: 200, state: "applied", changes: [] }]);
	const ui = await page(t, fetcher);
	const workers = ui.section("Model routing");
	const first = workers.querySelector("li.settings-rule")!;
	await ui.type(first.querySelector("select")!, "custom", "change");
	await ui.type(first.querySelector("input")!, "openai/gpt-6.1-sol");
	await ui.click(first, "×");
	for (const added of ["a/b", "c/d"]) {
		await ui.type(first.querySelector("select[aria-label='Add a fallback to risky-any']")!, "custom", "change");
		await ui.type(first.querySelector("input[aria-label='Add a fallback to risky-any: custom id']")!, added, "change");
	}
	const thinking = [...first.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Thinking"))!;
	await ui.type(thinking.querySelector("select")!, "low", "change");
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
	const workers = ui.section("Model routing");
	assert.equal(workers.querySelector(".settings-readonly")?.textContent, "No data/routing.json: workers use each profile's own model.");
	assert.equal(workers.querySelectorAll("input, button").length, 0);
	assert.equal(posts.length, 0);
});

const optionTexts = (select: Element) => [...select.querySelectorAll("option")].map((option) => option.textContent);

test("model dropdowns: grouped by provider; (unset) only for parent/operator; an unlisted value is kept; Custom… reveals the input; fallbacks add, remove, cap at 4 and save", async (t) => {
	const snap = snapshot(true);
	const { fetcher, posts } = server(() => settings(snap, { available_models: ["openai/gpt-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-5"], models_error: null }), () => [200, { status: 200, state: "applied", changes: [] }]);
	const ui = await page(t, fetcher);
	assert.equal(ui.root.querySelector("datalist"), null, "no datalist any more");
	const people = ui.section("Parent and operator models");
	const parent = people.querySelector("#setting-models-parent")!;
	assert.equal(parent.tagName, "SELECT");
	assert.deepEqual([...parent.querySelectorAll("optgroup")].map((group) => [group.getAttribute("label"), [...group.querySelectorAll("option")].map((option) => option.getAttribute("value"))]), [
		["anthropic", ["anthropic/claude-haiku-5", "anthropic/claude-opus-5-5"]],
		["openai", ["openai/gpt-5"]],
	], "providers alphabetical, models alphabetical within each");
	assert.deepEqual(optionTexts(parent), ["(unset)", "anthropic/claude-haiku-5", "anthropic/claude-opus-5-5", "openai/gpt-5", "Custom…"]);
	assert.ok(people.querySelector("#setting-models-operator"), "the operator model is a dropdown too");
	const workers = ui.section("Model routing");
	const first = workers.querySelector("li.settings-rule")!;
	const model = first.querySelector("select")!;
	assert.equal(optionTexts(model)[0], "anthropic/claude-haiku-5", "a rubric model has no (unset)");
	const fallback = first.querySelector("select[aria-label='Fallback 1 of risky-any']")!;
	assert.equal(optionTexts(fallback)[0], "openai/gpt-6.1-sol (not in pi's list)", "the unlisted current value stays selectable");
	const warns = (scope: Element) => [...scope.querySelectorAll(".settings-warn")].map((warn) => warn.textContent);
	assert.deepEqual(warns(first), ["Not in pi's model list: openai/gpt-6.1-sol. It can still be saved."]);
	assert.equal(first.querySelector("input"), null, "no text input until Custom…");
	await ui.type(model, "custom", "change");
	const custom = first.querySelector("input[aria-label='Model of risky-any: custom id']") as HTMLInputElement;
	assert.equal(custom.value, "anthropic/claude-opus-5-5", "Custom… opens on the current value");
	await ui.type(custom, "my/other");
	assert.equal(warns(first).length, 2, "an unlisted custom model warns too");
	await ui.type(model, "openai/gpt-5", "change");
	assert.equal(first.querySelector("input[aria-label='Model of risky-any: custom id']"), null, "picking a listed model closes the custom input");
	assert.equal(warns(first).length, 1, "a listed value does not warn");
	const add = () => first.querySelector("select[aria-label='Add a fallback to risky-any']");
	assert.equal(optionTexts(add()!)[0], "Add fallback…");
	await ui.type(add()!, "anthropic/claude-haiku-5", "change");
	await ui.type(add()!, "anthropic/claude-opus-5-5", "change");
	await ui.type(add()!, "custom", "change");
	await ui.type(first.querySelector("input[aria-label='Add a fallback to risky-any: custom id']")!, "my/fourth", "change");
	assert.equal(first.querySelectorAll(".settings-fallback select").length, 4);
	assert.equal(add(), null, "no Add fallback past 4");
	await ui.click(first, "×");
	assert.equal(first.querySelectorAll(".settings-fallback select").length, 3, "× removed one fallback (the saved list below says which)");
	assert.ok(add(), "Add fallback is back under 4");
	await ui.type(parent, "custom", "change");
	await ui.type(parent.parentElement!.querySelector("input")!, "my/custom-model");
	assert.match(people.querySelector(".settings-warn")?.textContent ?? "", /my\/custom-model/);
	await ui.click(workers, "Save");
	const rows = posts[0]!.body.changes as { "models.rubric": Array<{ model: string; fallbacks?: string[] }> };
	assert.deepEqual([rows["models.rubric"][0]!.model, rows["models.rubric"][0]!.fallbacks], ["openai/gpt-5", ["anthropic/claude-haiku-5", "anthropic/claude-opus-5-5", "my/fourth"]]);
	await ui.click(people, "Save");
	assert.deepEqual(posts[1]!.body.changes, { "models.parent": "my/custom-model" });
});

test("model dropdowns: (unset) saves null", async (t) => {
	const snap = snapshot(true);
	const { fetcher, posts } = server(() => settings(snap, { available_models: ["openai/gpt-5"], models_error: null }), () => [200, { status: 200, state: "applied", changes: [] }]);
	const ui = await page(t, fetcher);
	const people = ui.section("Parent and operator models");
	await ui.type(people.querySelector("#setting-models-operator")!, "openai/gpt-5", "change");
	await ui.type(people.querySelector("#setting-models-operator")!, "", "change");
	await ui.type(people.querySelector("#setting-models-parent")!, "openai/gpt-5", "change");
	await ui.click(people, "Save");
	assert.deepEqual(posts[0]!.body.changes, { "models.operator": null, "models.parent": "openai/gpt-5" });
});

test("model dropdowns: while the server's first listing runs, the current value and Custom… only, then the list after a retry", async (t) => {
	const snap = snapshot(true);
	let reads = 0;
	const { fetcher } = server(() => { reads++; return reads === 1 ? settings(snap, { available_models: null, models_error: null, models_loading: true }) : settings(snap, { available_models: ["openai/gpt-5"], models_error: null }); }, () => [500, {}]);
	const ui = await page(t, fetcher);
	assert.equal(ui.section("Model routing").querySelector("p[role=status]")?.textContent, "Loading the model list…");
	assert.deepEqual(optionTexts(ui.section("Model routing").querySelector("select")!), ["anthropic/claude-opus-5-5", "Custom…"]);
	assert.deepEqual(optionTexts(ui.root.querySelector("#setting-models-parent")!), ["(unset)", "Custom…"]);
	for (let i = 0; i < 40 && !ui.root.querySelector("optgroup"); i++) await new Promise((done) => setTimeout(done, 100));
	assert.deepEqual(optionTexts(ui.root.querySelector("#setting-models-parent")!), ["(unset)", "openai/gpt-5", "Custom…"], "the retry picked the list up");
	assert.equal(ui.section("Model routing").querySelector("p[role=status]"), null);
});

test("model dropdowns: an unavailable list keeps each current value plus Custom…, and one note", async (t) => {
	const snap = snapshot(true);
	const { fetcher } = server(() => settings(snap, { available_models: null, models_error: "model list unavailable" }), () => [500, {}]);
	const ui = await page(t, fetcher);
	assert.equal(ui.root.querySelector("optgroup"), null);
	const first = ui.section("Model routing").querySelector("li.settings-rule")!;
	assert.deepEqual(optionTexts(first.querySelector("select")!), ["anthropic/claude-opus-5-5", "Custom…"]);
	assert.deepEqual(optionTexts(first.querySelector("select[aria-label='Fallback 1 of risky-any']")!), ["openai/gpt-6.1-sol", "Custom…"]);
	assert.deepEqual(optionTexts(first.querySelector("select[aria-label='Add a fallback to risky-any']")!), ["Add fallback…", "Custom…"]);
	assert.equal(ui.root.querySelectorAll(".settings-warn").length, 0);
	assert.match(ui.section("Model routing").querySelector("p[role=status]")?.textContent ?? "", /^Model list unavailable \(model list unavailable\): type a provider\/model\.$/);
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
