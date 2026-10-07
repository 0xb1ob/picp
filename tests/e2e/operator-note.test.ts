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
import { join, resolve } from "node:path";
import { test } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { OPERATOR_NOTE } from "../../src/operator-note.ts";
import { layoutForHome } from "../../src/contracts.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import {
	createAgentDir,
	createScratchHome,
	CP_BRIDGE_EXTENSION,
	MockProvider,
	startPiChild,
	waitFor,
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
	assert.ok(requests[0], "no first request");
	assert.ok(
		JSON.stringify(requests[0].body).includes("Three tiers, smallest first"),
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

test("human and bridge turns share system bytes, including a relay after session resume", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "operator-note-prefix";
	const model = provider.addScript(script, [
		{ kind: "text", text: "human turn complete" },
		{ kind: "text", text: "relay turn complete" },
		{ kind: "text", text: "resumed relay complete" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path, model, env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
		extensions: [CP_BRIDGE_EXTENSION], sessionDir: join(home.path, "sessions"),
	});
	let resumed: ReturnType<typeof startPiChild> | undefined;
	t.after(() => teardownHome(home, () => resumed?.close(), () => child.close(), () => agentDir.cleanup(), () => provider.stop()));

	await child.prompt("Acknowledge this message.");
	await child.waitForSettled();
	const humanRequest = provider.requests(script)[0];
	assert.ok(humanRequest, "no human request");
	const humanSystem = JSON.stringify(humanRequest.body.messages?.filter((m) => m.role === "system"));
	assert.ok(humanSystem.includes("Three tiers, smallest first"), "note missing from human request's SYSTEM messages");

	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(join(home.path, layoutForHome("multi", home.path).state)));
	const enqueue = (text: string) => outbox.enqueue({
		kind: "wake", stale: false, text, receipt: { level: null, reached: [] }, paths: [],
	}, "test");
	const fromIndex = child.records().length;
	enqueue("cache-prefix probe");
	await waitFor(() => provider.requests(script).length, (count) => count === 2,
		{ timeoutMs: 45_000, what: "bridge relay request" });
	await child.waitFor((r) => r.type === "agent_settled" && child.records().slice(fromIndex).includes(r));
	const relay = provider.requests(script)[1];
	assert.ok(relay, "no relay request");
	const relaySystem = JSON.stringify(relay.body.messages?.filter((m) => m.role === "system"));
	assert.ok(JSON.stringify(relay.body).includes("cache-prefix probe"), "the second request must come from the bridge relay");
	assert.ok(relaySystem.includes("Three tiers, smallest first"), "note missing from relay request's SYSTEM messages");
	assert.equal(relaySystem, humanSystem, "human and bridge requests forked the system prompt");

	const { sessionFile } = await child.getState();
	assert.equal(typeof sessionFile, "string");
	await child.close();
	// Resume the same conversation and script cursor in a new process. No prompt()
	// runs here: session_start delivers the queued relay from disk.
	enqueue("resumed cache-prefix probe");
	resumed = startPiChild({
		cwd: home.path, env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
		extensions: [CP_BRIDGE_EXTENSION], sessionFile: sessionFile as string,
	});
	await resumed.waitForSettled(45_000);
	const resumedRequest = provider.requests(script)[2];
	assert.ok(resumedRequest, "no request after resume");
	assert.ok(JSON.stringify(resumedRequest.body).includes("resumed cache-prefix probe"));
	const resumedSystem = JSON.stringify(resumedRequest.body.messages?.filter((m) => m.role === "system"));
	assert.ok(resumedSystem.includes("Three tiers, smallest first"), "note did not survive resume in SYSTEM messages");
	assert.equal(resumedSystem, humanSystem, "resume changed the persisted system prompt");
	assert.equal(provider.remaining(script), 0);
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
