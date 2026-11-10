/**
 * The Settings model list loads on its own: `bin/cp-view`'s real `/api/settings` and `/api/settings/models` routes and
 * served page, into the operator session's real dashboard-control server and settings ports. `pi --list-models` is a
 * stub on PATH that can hold, fail or change its list; no model runs.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { settingsPorts } from "../../src/settings-control.ts";
import { operatorSession, startViewer, type Tab, until } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";

type Json = Record<string, any>;
const MODELS = "provider model\nopenai gpt-5\nanthropic claude-opus-5-5\n";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const settle = () => new Promise((done) => setTimeout(done, 150));
const values = (select: Element) => [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));
const parentJson = (model: string) => (root: string) => put(join(root, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 150000, model }));

/** A home with the shipped routing.json, a live session, and a `pi` stub that counts runs, holds, prints, exits. */
async function home(t: TestContext, seed: (root: string) => void = () => {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const root = scratch.path, bin = join(root, "stub-bin");
	put(join(bin, "pi"), '#!/bin/sh\nd="$(dirname "$0")"\necho 1 >> "$d/calls"\nwhile [ -e "$d/hold" ]; do sleep 0.05; done\ncat "$d/out"\nexit "$(cat "$d/status")"\n');
	chmodSync(join(bin, "pi"), 0o755);
	const answer = (out: string, status = 0) => { put(join(bin, "out"), out); put(join(bin, "status"), String(status)); };
	answer(MODELS);
	mkdirSync(join(root, LAYOUT.state), { recursive: true });
	put(join(root, LAYOUT.routingFile), readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"));
	seed(root);
	const view = await startViewer(t, { home: root, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
	await operatorSession(t, join(root, LAYOUT.state), () => true, settingsPorts({ target: () => ({ home: root, mode: "multi" }), env: {} }));
	const release = () => rmSync(join(bin, "hold"), { force: true });
	t.after(release);
	const models = async () => (await view.get("/api/settings/models")).body as Json;
	return {
		root, view, answer, models, release, hold: () => put(join(bin, "hold"), ""),
		calls: () => existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n").length : 0,
		listed: () => until(models, (body) => body.pi.loading === false, "the model listing"),
	};
}

async function page(tab: Tab) {
	await tab.find('section[aria-label="Auto-compaction"]');
	const section = (title: string) => tab.$(`section[aria-label="${title}"]`)!;
	const choose = async (select: Element, value: string) => {
		for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === value);
		select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
		await settle();
	};
	const press = async (scope: Element, label: string) => { tab.click([...scope.querySelectorAll("button")].find((b) => b.textContent === label)!); await settle(); };
	const states = () => tab.$$(".settings-models").map((el) => el.getAttribute("data-models"));
	const posts = () => tab.requests.filter((r) => r.method === "POST").map((r) => ({ ...r, json: JSON.parse(r.body ?? "{}") as Json }));
	return { section, choose, press, states, posts };
}

// Scenario: the Settings payload answers while the model list is still loading
//   Given pi's model listing never returns and the parent is saved on anthropic/claude-opus-5-5
//   When the operator opens Settings
//   Then /api/settings answers with no model field, only the pickers say loading, the saved model stays shown
test("the Settings payload answers while the model list is still loading", { timeout: 120_000 }, async (t) => {
	const h = await home(t, parentJson("anthropic/claude-opus-5-5"));
	h.hold();
	const settings = await h.view.get("/api/settings");
	assert.equal(settings.status, 200);
	assert.ok(settings.body.snapshot, "the snapshot answers while pi is still listing");
	assert.deepEqual(["available_models", "models_error", "models_loading"].filter((key) => key in settings.body), [], "no model field rides the Settings read");
	const list = await h.models();
	assert.deepEqual([list.pi.models, list.pi.loading, list.pi.listed_at, list.claude.loading], [null, true, null, true]);
	const tab = await h.view.open("#settings");
	const ui = await page(tab);
	assert.deepEqual(tab.$$("section.settings-section > h2").map((h2) => h2.textContent).slice(0, 6), ["Model routing", "Parent and operator models", "Grant defaults", "Auto-compaction", "Dashboard address", "Native workers"]);
	assert.deepEqual(tab.$$(".settings-models").map((el) => [el.closest("section")?.getAttribute("aria-label"), el.getAttribute("data-models"), el.querySelector("p[role=status]")?.textContent]), [
		["Model routing", "loading", "Loading the model list…"],
		["Parent and operator models", "loading", "Loading the model list…"],
	], "a loading note in each picker section, nowhere else");
	// linkedom keeps no select value; the real-Chrome screenshots show the saved model selected.
	const parent = ui.section("Parent and operator models").querySelector("#setting-models-parent")!;
	assert.deepEqual(values(parent), ["", "anthropic/claude-opus-5-5", "custom"], "the saved value stays shown");
	assert.equal(h.calls(), 1, "opening the page joins the one listing already running");
});

// Scenario: the models endpoint fills in later
//   Given pi's listing is held and the operator has drafted a parent thinking change
//   When the listing lands
//   Then the endpoint serves both CLIs' lists and the pickers fill in with no page reload and the draft kept
test("the models endpoint fills in later", { timeout: 120_000 }, async (t) => {
	const h = await home(t, parentJson("anthropic/claude-opus-5-5"));
	h.hold();
	const tab = await h.view.open("#settings");
	const ui = await page(tab);
	const people = ui.section("Parent and operator models");
	await ui.choose(people.querySelector("#setting-models-parent_thinking")!, "high");
	assert.equal(people.querySelector(".settings-unsaved")?.textContent, "1 unsaved change");
	h.release();
	await until(ui.states, (states) => states.every((state) => state === "ready"), "the pickers fill in");
	assert.deepEqual(values(people.querySelector("#setting-models-parent")!), ["", "anthropic/claude-opus-5-5", "openai/gpt-5", "custom"]);
	assert.equal(people.querySelector(".settings-unsaved")?.textContent, "1 unsaved change", "the unsaved draft survives the list landing");
	assert.equal((people.querySelector("#setting-models-parent_thinking") as HTMLSelectElement).value, "high");
	assert.equal(tab.requests.filter((r) => r.path === "/api/settings").length, 1, "no Settings re-read, no reload");
	const list = await h.models();
	assert.deepEqual([list.pi.models, list.pi.error, list.pi.loading, list.claude.models], [["openai/gpt-5", "anthropic/claude-opus-5-5"], null, false, ["anthropic/claude-opus-5-5"]]);
	assert.match(String(list.pi.listed_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

// Scenario: Refresh picks up a newly added model
//   Given a listed and cached model list, and Settings open
//   When pi learns anthropic/claude-fable-5-2 and the operator presses Refresh
//   Then a plain read still serves the cached list, and Refresh runs pi once more and offers the new model to both CLIs
test("Refresh picks up a newly added model", { timeout: 120_000 }, async (t) => {
	const h = await home(t, parentJson("anthropic/claude-opus-5-5"));
	await h.listed();
	const tab = await h.view.open("#settings");
	const ui = await page(tab);
	await until(ui.states, (states) => states.every((state) => state === "ready"), "the open's own refresh");
	assert.equal(h.calls(), 2, "opening Settings asked pi again");
	const parent = ui.section("Parent and operator models").querySelector("#setting-models-parent")!;
	assert.equal(values(parent).includes("anthropic/claude-fable-5-2"), false);
	h.answer(`${MODELS}anthropic claude-fable-5-2\n`);
	assert.equal((await h.models()).pi.models.includes("anthropic/claude-fable-5-2"), false, "a plain read serves the 5 min list");
	assert.equal(h.calls(), 2, "without running pi");
	await ui.press(ui.section("Model routing").querySelector(".settings-models")!, "Refresh");
	await until(() => values(parent), (now) => now.includes("anthropic/claude-fable-5-2"), "the refreshed list");
	assert.equal(h.calls(), 3, "Refresh ran pi once");
	assert.ok(tab.requests.some((r) => r.path === "/api/settings/models?refresh=1"));
	assert.deepEqual((await h.models()).claude.models, ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-2"], "the Claude CLI's list has it too");
});

// Scenario: a failing list shows a section note and the page still saves other settings
//   Given pi --list-models exits non-zero
//   When the operator opens Settings and saves an Auto-compaction threshold
//   Then each picker section notes the failure with Retry, the save lands, and Retry fills the list once pi recovers
test("a failing list shows a section note and the page still saves other settings", { timeout: 120_000 }, async (t) => {
	const h = await home(t);
	h.answer(MODELS, 1);
	await h.listed();
	const tab = await h.view.open("#settings");
	const ui = await page(tab);
	await until(ui.states, (states) => states.length === 2 && states.every((state) => state === "error"), "the failure note");
	const routing = ui.section("Model routing").querySelector(".settings-models")!;
	assert.deepEqual([routing.querySelector("p[role=status]")?.textContent, routing.querySelector("button")?.textContent],
		["Model list unavailable (model list unavailable): type a provider/model.", "Retry"]);
	assert.deepEqual(values(ui.section("Parent and operator models").querySelector("#setting-models-parent")!), ["", "custom"], "Custom… keeps the field editable as text");
	const compaction = ui.section("Auto-compaction");
	const threshold = compaction.querySelector("#setting-sessions-parent_compact_at_tokens") as HTMLInputElement;
	threshold.value = "175000";
	threshold.dispatchEvent(new tab.window.Event("input", { bubbles: true }));
	await settle();
	await ui.press(compaction, "Save");
	await tab.find(".settings-ok");
	assert.deepEqual([ui.posts()[0]?.status, ui.posts()[0]?.json.changes], [200, { "sessions.parent_compact_at_tokens": 175000 }]);
	h.answer(MODELS);
	await ui.press(routing, "Retry");
	await until(ui.states, (states) => states.every((state) => state === "ready"), "the retried list");
	assert.ok(tab.$(".settings-rule optgroup"), "the pickers filled in");
});

// Scenario: a saved model missing from the list is kept
//   Given the parent is saved on openrouter/gone-model, which pi no longer lists
//   When Settings loads the list and the operator saves another key in that section
//   Then the model stays in its picker, marked not in pi's list, and the saved file still names it
test("a saved model missing from the list is kept", { timeout: 120_000 }, async (t) => {
	const h = await home(t, parentJson("openrouter/gone-model"));
	await h.listed();
	const tab = await h.view.open("#settings");
	const ui = await page(tab);
	await until(ui.states, (states) => states.every((state) => state === "ready"), "the list");
	const people = ui.section("Parent and operator models");
	const parent = people.querySelector("#setting-models-parent")!;
	assert.deepEqual([...parent.querySelectorAll("option")].map((o) => o.textContent).slice(0, 2), ["(unset)", "openrouter/gone-model (not in pi's list)"]);
	assert.equal(people.querySelector(".settings-warn")?.textContent, "Not in pi's model list: openrouter/gone-model. It can still be saved.");
	await ui.choose(people.querySelector("#setting-models-operator_thinking")!, "low");
	await ui.press(people, "Save");
	await tab.find(".settings-ok");
	assert.deepEqual(ui.posts()[0]?.json.changes, { "models.operator_thinking": "low" });
	assert.equal(JSON.parse(readFileSync(join(h.root, LAYOUT.data, "parent.json"), "utf8")).model, "openrouter/gone-model", "never silently dropped");
	assert.match(people.querySelector("#setting-models-parent")?.textContent ?? "", /openrouter\/gone-model \(not in pi's list\)/);
});
