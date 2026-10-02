/**
 * autonomy-programme-cur.5.3 acceptance: "A fresh main session started with
 * bin/cp-operator can, from one human message containing a mandate, start
 * the parent and issue it without further instruction." The mock model is
 * scripted (models don't read prompts in this harness), so what this test
 * proves is the plumbing the note depends on: the note reaches the main
 * session's system prompt, and one prompt is enough to drive `cp_parent`
 * through start then send with no follow-up turn from the human.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { OPERATOR_NOTE } from "../../src/operator-note.ts";
import {
	createAgentDir,
	createScratchHome,
	CP_BRIDGE_EXTENSION,
	MockProvider,
	startPiChild,
} from "../harness/index.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "..", "fixtures", "fake-parent.mjs");

test("one human message: bin/cp-operator's session starts the parent and issues the mandate", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("operator-note-e2e", [
		{
			// cur.5.4: model omitted on purpose -- the bridge must default to the
			// operator session's own model, never guess.
			kind: "tool_calls",
			calls: [{ name: "cp_parent", args: { action: "start", home: home.path, mode: "multi" } }],
		},
		{
			kind: "tool_calls",
			calls: [{ name: "cp_parent", args: { action: "send", text: "mandate: ship the widget" } }],
		},
		{ kind: "text", text: "started the parent and issued the mandate" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path,
		model,
		env: { ...agentDir.env, CP_PARENT_PI_BIN: FAKE_PARENT },
		extensions: [CP_BRIDGE_EXTENSION],
	});
	// cp_parent start spawns a detached host; the child's shutdown only disconnects from it.
	// teardownHome runs every step, stops the host and removes the home even when one fails.
	t.after(() => teardownHome(home, () => child.close(), () => agentDir.cleanup(), () => provider.stop()));

	await child.prompt(
		"Mandate: ship the widget. projects: demo. objective: ship the widget. " +
			"allowed_actions: implement. spend_cap: usd 5 tokens 100000. job_cap: 3. ask_on: risk:high. " +
			"Start the parent under this repo's home and issue it.",
	);
	await child.waitForSettled();

	const requests = provider.requests("operator-note-e2e");
	assert.ok(requests.length >= 1);
	const systemMessage = requests[0]?.body.messages?.find((m) => m.role === "system");
	assert.ok(systemMessage, "no system message on the first request");
	assert.ok(
		JSON.stringify(systemMessage).includes("Three tiers, smallest first"),
		"the operator note did not reach the system prompt",
	);
	assert.equal(provider.remaining("operator-note-e2e"), 0, "the script did not run to completion");

	const toolResults = child.eventsOfType("tool_execution_end");
	const texts = toolResults.map((r) => JSON.stringify(r));
	assert.ok(
		texts.some((t2) => /started pid=/.test(t2)),
		"no evidence cp_parent start ran",
	);
	assert.ok(
		texts.some((t2) => /receipt: owner_observed/.test(t2)),
		"no evidence cp_parent send settled",
	);
	assert.ok(OPERATOR_NOTE.length > 0); // sanity: the note this test depends on still exists
});

// autonomy-programme-cur.2.5 acceptance: "a scripted operator session given
// 'fix example-infra #17' issues the mandate in one send and asks nothing." Same
// convention as the test above (the mock model is scripted, so this proves the
// plumbing: one human message is enough, no second human turn is needed, and
// nothing in the note tells the model to gather caps/expiry first).
test("'fix example-infra #17' issues the mandate in one send, no follow-up question", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("mandate-defaults-e2e", [
		{
			kind: "tool_calls",
			calls: [{ name: "cp_parent", args: { action: "start", home: home.path, mode: "multi" } }],
		},
		{
			kind: "tool_calls",
			// Only projects + objective \u2014 no expiry, no spend_cap, no job_cap: the note
			// says those come from data/mandate-defaults.json, never from asking.
			calls: [{ name: "cp_parent", args: { action: "send", text: "mandate: fix example-infra #17" } }],
		},
		{ kind: "text", text: "issued the mandate for example-infra" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path,
		model,
		env: { ...agentDir.env, CP_PARENT_PI_BIN: FAKE_PARENT },
		extensions: [CP_BRIDGE_EXTENSION],
	});
	t.after(() => teardownHome(home, () => child.close(), () => agentDir.cleanup(), () => provider.stop()));

	// One short human message, exactly the ticket's shape: name a project and
	// what to do. Nothing else.
	await child.prompt("fix example-infra #17");
	await child.waitForSettled();

	// The script ran to completion with no extra turn injected \u2014 the harness
	// only advances the script on a fresh model request, so a mid-script human
	// question from the model would leave the script short.
	assert.equal(provider.remaining("mandate-defaults-e2e"), 0, "the script did not run to completion (the model asked something instead of proceeding)");

	const toolResults = child.eventsOfType("tool_execution_end");
	const texts = toolResults.map((r) => JSON.stringify(r));
	assert.ok(texts.some((t2) => /started pid=/.test(t2)), "no evidence cp_parent start ran");
	assert.ok(texts.some((t2) => /receipt: owner_observed/.test(t2)), "no evidence cp_parent send settled");
});
