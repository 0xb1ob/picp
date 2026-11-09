/**
 * Settings Parent CLI and Workers CLI through `bin/cp-view`'s HTTP routes and served page, into the operator session's
 * real dashboard-control server and settings ports. `pi --list-models` is a stub on PATH; no model runs.
 */
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { ControlPorts } from "../../src/dashboard-control.ts";
import { settingsPorts } from "../../src/settings-control.ts";
import { settingsAuditFile } from "../../src/settings-write.ts";
import { readControlRecord } from "../../src/viewer/control-files.ts";
import { operatorSession, startViewer, until } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import type { Init } from "../harness/remote.ts";

type Json = Record<string, any>;
const MODELS = "provider model\nopenai gpt-5\nanthropic claude-opus-5-5\nanthropic claude-haiku-5\n";
const CLAUDE_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"];
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const settle = () => new Promise((done) => setTimeout(done, 150));
const optionValues = (select: Element) => [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));
const groupLabels = (select: Element) => [...select.querySelectorAll("optgroup")].map((group) => group.getAttribute("label"));

/** A home with the shipped routing.json, `pi` stubbed and a live session whose parent restarts are recorded. */
async function home(t: TestContext, seed: (home: string) => void = () => {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const root = scratch.path;
	const bin = join(root, "stub-bin");
	put(join(bin, "pi"), `#!/bin/sh\ncat "$(dirname "$0")/out"\n`);
	chmodSync(join(bin, "pi"), 0o755);
	put(join(bin, "out"), MODELS);
	mkdirSync(join(root, LAYOUT.state), { recursive: true });
	put(join(root, LAYOUT.routingFile), readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"));
	seed(root);
	const view = await startViewer(t, { home: root, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
	const restarts: string[] = [];
	const ports: Partial<ControlPorts> = {
		...settingsPorts({ target: () => ({ home: root, mode: "multi" }), env: {} }),
		parentRestartState: () => ({ safe: true, reason: "drained: no live worker", last: null }),
		parentRestart: async (mode) => { restarts.push(mode); return { done: Promise.resolve(`restarted ${mode}`) }; },
	};
	await operatorSession(t, join(root, LAYOUT.state), () => true, ports);
	const csrf = (readControlRecord(join(root, LAYOUT.state)) as { record: { csrf: string } }).record.csrf;
	await until(() => view.get("/api/settings").then((reply) => reply.body.models_loading), (loading) => loading === false, "the model listing");
	const read = async () => (await view.get("/api/settings")).body as Json;
	const field = async (key: string) => ((await read()).snapshot.fields as Json[]).find((row) => row.key === key);
	const post = async (path: string, body: Json, dryRun = false) => {
		const revision = (await read()).snapshot.revision as string;
		const init: Init = { method: "POST", body: JSON.stringify({ ...body, request_id: `req-${Math.random().toString(36).slice(2, 12)}`, ...(dryRun ? { dry_run: true } : {}) }),
			headers: { origin: view.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": csrf, ...(dryRun ? {} : { "if-match": `"${revision}"` }) } };
		return await view.get(path, init);
	};
	const json = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as Json;
	return { root, view, csrf, restarts, read, field, post, json };
}

async function settingsTab(h: Awaited<ReturnType<typeof home>>) {
	const tab = await h.view.open("#settings");
	await tab.find('section[aria-label="Model routing"] li.settings-rule');
	const section = (title: string) => tab.$(`section[aria-label="${title}"]`)!;
	const row = (id: string) => [...section("Model routing").querySelectorAll("li.settings-rule")].find((li) => li.querySelector("code")?.textContent === id)!;
	const choose = async (select: Element, value: string) => {
		for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === value);
		select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
		await settle();
	};
	const button = (scope: Element, label: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === label)!;
	const press = async (scope: Element, label: string) => { tab.click(button(scope, label)); await settle(); };
	const posts = () => tab.requests.filter((r) => r.method === "POST").map((r) => ({ ...r, json: JSON.parse(r.body ?? "{}") as Json }));
	const thinking = (li: Element) => [...li.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Thinking"))!.querySelector("select")!;
	return { tab, section, row, choose, button, press, posts, thinking };
}

// Scenario: switching the workers CLI pi↔native filters the model lists and validates rows
//   Given the shipped rubric with small-ship on openai/gpt-5 and planner-default at thinking minimal
//   When the operator picks Native Claude, then pi again
//   Then only Claude models and efforts are offered, both rows are named and Save is off until they are fixed
test("Workers CLI: native filters every row's model and effort list, names the rows to fix, saves rows and switches together", { timeout: 120_000 }, async (t) => {
	const h = await home(t, (root) => {
		const routing = JSON.parse(readFileSync(join(root, LAYOUT.routingFile), "utf8")) as Json;
		for (const row of routing.rubric as Json[]) {
			if (row.id === "small-ship") row.model = "openai/gpt-5";
			if (row.id === "planner-default") row.thinking = "minimal";
		}
		put(join(root, LAYOUT.routingFile), JSON.stringify(routing));
	});
	const ui = await settingsTab(h);
	const cli = ui.section("Model routing").querySelector("#setting-workers-driver")!;
	assert.deepEqual([(await h.field("workers.driver"))?.value, optionValues(cli)], ["pi", ["pi", "claude"]]);
	const cliSource = () => ui.section("Model routing").querySelector(".settings-cli .settings-meta")?.textContent;
	assert.equal(cliSource(), "from code", "no row names a driver yet");
	const small = ui.row("small-ship");
	assert.match(small.querySelector(".settings-rule-name")?.textContent ?? "", /^Small ship$/, "a human label over the row id");
	assert.deepEqual(groupLabels(small.querySelector("select")!), ["anthropic", "openai"], "pi offers every model pi lists");
	assert.ok(optionValues(ui.thinking(small)).includes("minimal"), "pi offers its own levels");
	const save = () => ui.button(ui.section("Model routing"), "Save");

	await ui.choose(cli, "claude");
	for (const li of ui.section("Model routing").querySelectorAll("li.settings-rule")) {
		assert.deepEqual(groupLabels(li.querySelector("select")!), ["anthropic"], `${li.querySelector("code")?.textContent}: only anthropic/claude-* under native`);
	}
	assert.deepEqual(optionValues(ui.thinking(ui.row("big-ship"))), ["", ...CLAUDE_EFFORTS], "the Claude driver's effort levels, from the session");
	const block = ui.section("Model routing").querySelector(".settings-cli-block")?.textContent ?? "";
	assert.match(block, /Native Claude needs a new model or effort on Small ship \(small-ship\), Planner \(planner-default\)\./);
	assert.match(small.querySelector(".settings-rule-error")?.textContent ?? "", /anthropic\/claude-… model, not openai\/gpt-5/);
	assert.match(ui.row("planner-default").querySelector(".settings-rule-error")?.textContent ?? "", /Effort minimal has no Claude equivalent/);
	assert.ok(save().hasAttribute("disabled"), "Save stays off while a row cannot run native");

	await ui.choose(small.querySelector("select")!, "anthropic/claude-haiku-5");
	assert.ok(save().hasAttribute("disabled"), "one row still needs an effort");
	await ui.choose(ui.thinking(ui.row("planner-default")), "high");
	assert.equal(ui.section("Model routing").querySelector(".settings-cli-block"), null);
	assert.equal(save().hasAttribute("disabled"), false);
	await ui.press(ui.section("Model routing"), "Save");
	await ui.tab.find(".settings-ok");
	const [saved] = ui.posts();
	assert.equal(saved?.status, 200);
	assert.equal(saved?.json.changes["workers.driver"], "claude");
	const routing = h.json(LAYOUT.routingFile);
	assert.deepEqual((routing.rubric as Json[]).map((row) => row.driver), Array(7).fill("claude"), "every row runs native");
	const smallRow = (routing.rubric as Json[]).find((row) => row.id === "small-ship")!;
	assert.deepEqual([smallRow.model, smallRow.fallbacks], ["anthropic/claude-haiku-5", ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"]], "fallbacks kept as they were");
	assert.deepEqual(h.json(`${LAYOUT.data}/native.json`), { claude_research: true, claude_ship: true, claude_review: true });
	assert.deepEqual([(await h.field("workers.driver"))?.value, (await h.field("workers.native_claude_research"))?.value], ["claude", true]);

	await until(cliSource, (source) => source === "from file", "the re-read");
	await ui.choose(ui.section("Model routing").querySelector("#setting-workers-driver")!, "pi");
	assert.deepEqual(groupLabels(ui.row("small-ship").querySelector("select")!), ["anthropic", "openai"], "pi lists every model again");
	assert.ok(optionValues(ui.thinking(ui.row("small-ship"))).includes("minimal"));
	await ui.press(ui.section("Model routing"), "Save");
	await until(() => ui.posts().length, (n) => n === 2, "the pi save");
	assert.deepEqual(ui.posts()[1]?.json.changes, { "workers.driver": "pi" });
	await until(() => h.json(LAYOUT.routingFile), (doc) => (doc.rubric as Json[]).every((row) => !("driver" in row)), "rows back on pi");
	assert.deepEqual(h.json(`${LAYOUT.data}/native.json`), {}, "pi turns the native switches off");
});

// Scenario: the parent CLI switch writes driver and reports restart-needed
//   Given a parent on pi with anthropic/claude-opus-5-5
//   When the operator picks Native Claude for the parent and saves
//   Then parent.json says driver claude, the answer says restart parent, and the page offers the drain-gated restart
test("Parent CLI: native narrows the parent pickers, writes driver, reports restart and restarts only on request", { timeout: 120_000 }, async (t) => {
	const h = await home(t, (root) => put(join(root, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 150000, model: "anthropic/claude-opus-5-5" })));
	const ui = await settingsTab(h);
	const people = ui.section("Parent and operator models");
	const cli = people.querySelector("#setting-models-parent_driver")!;
	assert.deepEqual([(await h.field("models.parent_driver"))?.value, optionValues(cli)], ["pi", ["pi", "claude"]]);
	assert.deepEqual(groupLabels(people.querySelector("#setting-models-parent")!), ["anthropic", "openai"]);
	await ui.choose(cli, "claude");
	assert.deepEqual(groupLabels(people.querySelector("#setting-models-parent")!), ["anthropic"], "native offers only anthropic/claude-*");
	assert.deepEqual(optionValues(people.querySelector("#setting-models-parent_thinking")!), ["", ...CLAUDE_EFFORTS]);
	assert.deepEqual(groupLabels(people.querySelector("#setting-models-operator")!), ["anthropic", "openai"], "the operator keeps pi's list");
	await ui.press(people, "Save");
	await ui.tab.find(".settings-ok");
	const [saved] = ui.posts();
	assert.deepEqual([saved?.status, saved?.json.changes], [200, { "models.parent_driver": "claude" }]);
	assert.deepEqual(h.json(`${LAYOUT.data}/parent.json`), { compact_at_tokens: 150000, model: "anthropic/claude-opus-5-5", driver: "claude" });
	const restart = await ui.tab.find(".settings-restart");
	assert.match(restart.textContent ?? "", /keeps its current CLI until it restarts/);
	assert.deepEqual(h.restarts, [], "a save never restarts the parent");
	await ui.press(restart, "Restart parent");
	await ui.press(restart, "Tap again to restart the parent · resumes its session");
	await until(() => h.restarts, (calls) => calls.length === 1, "the restart through the parent-restart route");
	assert.deepEqual([h.restarts, ui.posts().at(-1)?.path], [["resume"], "/api/parent/restart"]);

	const dry = await h.post("/api/settings/apply", { changes: { "models.parent_driver": "pi" } }, true);
	assert.deepEqual([dry.status, dry.body.state, dry.body.restart], [200, "planned", "parent"], "a dry run says a restart is needed too");
});

// Scenario: native + an openai model is refused
//   Given a parent on openai/gpt-5 and a rubric row on openai/gpt-5
//   When a write asks for the claude parent or the claude workers CLI
//   Then each is a 400 naming the model, nothing is written and the audit records the refusal
test("native + an openai model is refused before any write, for the parent and for a worker row", { timeout: 120_000 }, async (t) => {
	const h = await home(t, (root) => {
		put(join(root, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 150000, model: "openai/gpt-5" }));
		const routing = JSON.parse(readFileSync(join(root, LAYOUT.routingFile), "utf8")) as Json;
		(routing.rubric as Json[])[0]!.model = "openai/gpt-5";
		put(join(root, LAYOUT.routingFile), JSON.stringify(routing));
	});
	const before = [readFileSync(join(h.root, LAYOUT.data, "parent.json"), "utf8"), readFileSync(join(h.root, LAYOUT.routingFile), "utf8")];
	const parent = await h.post("/api/settings/apply", { changes: { "models.parent_driver": "claude" } });
	assert.equal(parent.status, 400, JSON.stringify(parent.body));
	assert.deepEqual(parent.body.errors, ['models.parent: the claude parent runs only an anthropic/claude-… model, not "openai/gpt-5"']);
	const both = await h.post("/api/settings/apply", { changes: { "models.parent_driver": "claude", "models.parent": "openai/gpt-5", "models.parent_thinking": "minimal" } });
	assert.equal(both.status, 400);
	assert.equal((both.body.errors as string[]).length, 2, "the model and the effort, each named");
	const workers = await h.post("/api/settings/apply", { changes: { "workers.driver": "claude" } });
	assert.equal(workers.status, 400);
	assert.deepEqual(workers.body.errors, ["row risky-any: native Claude runs only an anthropic/claude-… model, not openai/gpt-5; pick one for this row"]);
	assert.equal((await h.post("/api/settings/apply", { changes: { "workers.driver": "claude" } }, true)).status, 400, "a dry run refuses the same way");
	assert.deepEqual([readFileSync(join(h.root, LAYOUT.data, "parent.json"), "utf8"), readFileSync(join(h.root, LAYOUT.routingFile), "utf8")], before, "nothing written");
	assert.equal(existsSync(join(h.root, LAYOUT.data, "native.json")), false, "no native switch turned on");
	const audit = readFileSync(settingsAuditFile(h.root), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
	assert.deepEqual(audit.map((line) => [line.type, line.status]), [["refused", 400], ["refused", 400], ["refused", 400]]);

	const ui = await settingsTab(h);
	const people = ui.section("Parent and operator models");
	await ui.choose(people.querySelector("#setting-models-parent_driver")!, "claude");
	assert.match(people.querySelector(".settings-warn[role=alert]")?.textContent ?? "", /anthropic\/claude-… model, not openai\/gpt-5/);
	assert.ok(ui.button(people, "Save").hasAttribute("disabled"), "the page blocks the pair before posting");
	assert.equal(ui.posts().length, 0);
});

// Scenario: restore works
//   Given the parent and every worker on native Claude
//   When the operator restores the Model routing and the parent keys
//   Then the rows lose their driver, the native switches go, the parent is back on pi and the read says pi
test("restore puts the parent and every worker back on pi and turns the native switches off", { timeout: 120_000 }, async (t) => {
	const h = await home(t, (root) => {
		put(join(root, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 150000, model: "anthropic/claude-opus-5-5" }));
		put(join(root, LAYOUT.data, "native.json"), JSON.stringify({ max_concurrent: 2 }));
	});
	const set = await h.post("/api/settings/apply", { changes: { "workers.driver": "claude", "models.parent_driver": "claude" } });
	assert.deepEqual([set.status, set.body.state, set.body.restart], [200, "applied", "parent"], JSON.stringify(set.body));
	assert.deepEqual(h.json(`${LAYOUT.data}/native.json`), { max_concurrent: 2, claude_research: true, claude_ship: true, claude_review: true });
	assert.deepEqual([(await h.field("workers.driver"))?.value, (await h.field("models.parent_driver"))?.value], ["claude", "claude"]);

	const ui = await settingsTab(h);
	await ui.press(ui.section("Model routing"), "Restore defaults");
	await until(() => ui.posts().length, (n) => n === 1, "the routing restore");
	assert.deepEqual([ui.posts()[0]?.path, ui.posts()[0]?.json.keys], ["/api/settings/restore", ["models.rubric", "workers.driver"]]);
	await until(() => h.json(LAYOUT.routingFile), (doc) => (doc.rubric as Json[]).every((row) => !("driver" in row)), "rows back on pi");
	assert.deepEqual(h.json(LAYOUT.routingFile), JSON.parse(readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8")), "the shipped routing, byte for byte in value");
	assert.deepEqual(h.json(`${LAYOUT.data}/native.json`), { max_concurrent: 2 }, "only the three switches go");

	const parent = await h.post("/api/settings/restore", { keys: ["models.parent_driver"] });
	assert.deepEqual([parent.status, parent.body.state, parent.body.restart], [200, "applied", "parent"]);
	assert.deepEqual(h.json(`${LAYOUT.data}/parent.json`), { compact_at_tokens: 150000, model: "anthropic/claude-opus-5-5" });
	assert.deepEqual([(await h.field("workers.driver"))?.value, (await h.field("models.parent_driver"))?.value], ["pi", "pi"]);
	assert.equal((await h.post("/api/settings/restore", { keys: ["workers.driver", "models.parent_driver"] })).body.state, "unchanged");
});
