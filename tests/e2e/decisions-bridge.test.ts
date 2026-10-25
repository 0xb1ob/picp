/**
 * Behavior 09 (P10b): the operator's cp-bridge session, real pi with a mock model. The ask guard nudges a prose
 * question once, then cards it for the next chat line; the escalation backstop relays an overdue escalation once.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { DETECTED_ASK_PREFIX } from "../../src/ask-guard.ts";
import { type GateVerdict, isoTimestamp, layoutForHome, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { ESCALATION_RELAY_LEDGER_KEEP, escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { EscalationStore, raiseForGate } from "../../src/escalation.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, type PiChild, type ScriptStep, startPiChild } from "../harness/index.ts";

type Home = ReturnType<typeof createScratchHome>;
const NUDGE = "opened no cp_parent ask";

/** A cp-bridge pi on `home` whose mock model runs `steps`; torn down after the test. */
async function bridge(t: TestContext, home: Home, steps: ScriptStep[], repeat = false) {
	const provider = await MockProvider.start();
	const script = `bridge-${Math.random().toString(16).slice(2)}`;
	const model = provider.addScript(script, steps, repeat ? { onExhausted: "repeat" } : undefined);
	const agentDir = createAgentDir({ provider });
	const pi = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await pi.close();
		agentDir.cleanup();
		await provider.stop();
	};
	t.after(close);
	return { pi, provider, script, close };
}

/** Run one prompt to its settle. */
async function turn(pi: PiChild, message: string): Promise<void> {
	const from = pi.records().length;
	await pi.prompt(message);
	await pi.waitFor((r) => r.type === "agent_settled" && pi.records().indexOf(r) >= from, 60_000);
}

const asksFile = (home: string) => join(home, layoutForHome("multi", home).state, "operator", "asks.jsonl");
const asksOf = (home: string) => (existsSync(asksFile(home)) ? new OperatorAsks(asksFile(home)).list() : []);
const detected = (home: string) => asksOf(home).filter((ask) => ask.context?.startsWith(DETECTED_ASK_PREFIX));
const text = (reply: string): ScriptStep => ({ kind: "text", text: reply });
const TAIL = "Still waiting on your two choices: hand-off merges, and the external backlog.";
const LONG = `${"x".repeat(250)}[ ] ${"y".repeat(400)}?`;
const askCall = (id: string) => ({ id, name: "cp_parent", args: { action: "ask", ask: { project: "demo-app", question: `A or B (${id})?`, options: [{ label: "A", consequence: "does a" }, { label: "B", consequence: "does b" }], recommendation: "A" } } });

interface Turn {
	prompt: string;
	steps: ScriptStep[];
	nudged?: boolean;
	/** The detected card this run must open; absent means none. */
	card?: { question: string | ((question: string) => boolean); project?: string; context?: RegExp };
	/** This prompt is not a human answer, so the open card stays open. */
	keep?: boolean;
}

const CLICK = "ask-1: Answer in the operator chat\n[cp-dashboard dc-20300101000000-0a1b2c3d — from the dashboard; ask=ask-0a1b2c]";
const TYPED = "[cp-dashboard dc-20300101000000-0a1b2c3d — from the dashboard]\nB";

test("decisions: the ask guard nudges a prose question once per run, cards it for the next chat line, and stays quiet on fences, quotes, status lines and a real cp_parent ask", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const real = () => asksOf(home.path).filter((ask) => !ask.context?.startsWith(DETECTED_ASK_PREFIX));
	const quiet = (reply: string, prompt = "Status?", keep = false): Turn => ({ prompt, steps: [text(reply)], keep });
	const carded = (prompt: string, reply: string, card: Turn["card"], second = "I will wait."): Turn => ({ prompt, steps: [text(reply), text(second)], nudged: true, card });
	const turns: Turn[] = [
		quiet("Everything is merged. Nothing else to do."),
		quiet("Result:\n```\nwhat is this?\n```\nAll done."),
		quiet("> Should I proceed?\nDone."),
		quiet("See https://example.test/x?y=1 for details."),
		quiet("```\nunclosed fence: really?"),
		quiet("Dispatched the readers. Still waiting on readers."),
		quiet("Still waiting on readers"),
		quiet(`Should I proceed?\n${"filler. ".repeat(100)}`),
		quiet(`Done.\n\`\`\`\n${TAIL}\n\`\`\`\nAll merged.`),
		quiet(`> ${TAIL}\nAll merged.`),
		// The second reply asks again: still one continuation, then the card for the first.
		carded("What next?", "[demo-app] cp-1234 is blocked. Should I proceed with A or B?", { question: "Should I proceed with A or B?", project: "demo-app", context: /cp-1234 is blocked/ }, "Should I proceed anyway?"),
		quiet("Recorded.", CLICK, true),
		quiet("Noted.", "   ", true),
		carded(TYPED, "Two options exist.\nLet me know what you prefer.", { question: "Let me know what you prefer." }),
		carded("B".repeat(1500), 'Is it ready (see "docs")?', { question: 'Is it ready (see "docs")?' }),
		carded("What next?", `PR #12 merged.\n${TAIL}`, { question: TAIL }),
		carded("And then?", "Both landed. Over to your choice.", { question: "Over to your choice." }),
		carded("Go on.", "Done. Are you still waiting on the readers?", { question: "Are you still waiting on the readers?" }),
		carded("Next.", `${"z".repeat(3000)}\n${LONG}`, { question: (question) => question.length === 300 && question.startsWith("x") }),
		{ prompt: "Explain.", steps: [text("Is this what you meant? Quoting the spec."), text("NO-ASK")], nudged: true },
		// A run with a real cp_parent ask is never continued; a cue with no ? is not nudged while that ask is open.
		{ prompt: "Ask the human.", steps: [{ kind: "tool_calls", calls: [askCall("ask-one")] }, text("Should I proceed with A or B? It is on the dashboard.")] },
		quiet(TAIL),
		quiet("Let me know which option you prefer."),
		{ prompt: "And now?", steps: [text("Should I proceed with A or B?"), { kind: "tool_calls", calls: [askCall("ask-two")] }, text("Asked on the dashboard.")], nudged: true },
		{
			prompt: "Close both asks.",
			steps: [
				{ kind: "tool_calls", calls: [
					{ id: "close-one", name: "cp_parent", args: () => ({ action: "ask_answer", id: real()[0]?.id, answer: "A" }) },
					{ id: "close-two", name: "cp_parent", args: () => ({ action: "ask_answer", id: real()[1]?.id, answer: "B" }) },
				] },
				text("Should I proceed?"),
				text("no-ask"),
			],
			nudged: true,
		},
	];
	const { pi, provider, script } = await bridge(t, home, turns.flatMap((entry) => entry.steps));
	const requests = () => provider.requests(script);
	const nudges = (index: number) => JSON.stringify(requests()[index]?.body ?? "").split(NUDGE).length - 1;

	let open: string | undefined;
	for (const [index, entry] of turns.entries()) {
		const label = `turn ${index} (${JSON.stringify(entry.steps[0]).slice(0, 60)})`;
		const before = requests().length;
		const cards = detected(home.path).length;
		await turn(pi, entry.prompt);
		if (open) {
			const card = detected(home.path).find((ask) => ask.id === open);
			const expected = entry.keep ? ["open", undefined] : ["answered", entry.prompt.trim().slice(0, 1000)];
			assert.deepEqual([card?.state, card?.answer], expected, `${label}: the open card after this prompt`);
			if (!entry.keep) open = undefined;
		}
		assert.equal(requests().length - before, entry.steps.length, `${label}: provider requests`);
		assert.equal(nudges(requests().length - 1) > nudges(before), entry.nudged === true, `${label}: nudged`);
		const fresh = detected(home.path).slice(cards);
		assert.equal(fresh.length, entry.card ? 1 : 0, `${label}: cards opened`);
		const [card] = fresh;
		if (!entry.card || !card) continue;
		const { question, project = "command-post", context } = entry.card;
		assert.ok(typeof question === "function" ? question(card.question) : card.question === question, `${label}: question ${card.question}`);
		assert.equal(card.project, project);
		assert.match(card.context ?? "", new RegExp(`^${DETECTED_ASK_PREFIX} \\(no cp_parent ask was opened\\) at \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z:\\n`));
		assert.ok((card.context?.length ?? 0) <= 2000);
		if (context) assert.match(card.context ?? "", context);
		open = card.id;
	}
	assert.equal(provider.remaining(script), 0);
	assert.deepEqual(real().map((ask) => [ask.state, ask.answer]), [["answered", "A"], ["answered", "B"]], "chat lines never answered a cp_parent ask; ask_answer did");
	const status = pi.stderr() + JSON.stringify(pi.records().filter((r) => r.type === "extension_ui_request"));
	assert.doesNotMatch(status, /ask guard: [^"]*failed/, "a blank line is skipped, never a failed answer");
});

const OPTIONS = [{ id: "hold", label: "Hold", consequence: "waits", cost: "time" }];
const gateVerdict: GateVerdict = {
	schema_version: SCHEMA_VERSION, job_id: "cp-gjva", attempt: 1, verdict: "escalate", cause: "policy",
	flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
	reasons: ["conflicting acceptance"], revisions: [], model: "mock/one", decided_at: isoTimestamp(new Date(Date.now() - 11 * 60_000)),
};

test("decisions: the operator session relays each overdue, unrepresented escalation once, oldest first, pins open ids in its ledger and refuses an unreadable one", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const aged = (seconds: number) => new EscalationStore({ home: home.path, now: () => new Date(Date.now() - seconds * 1000) });
	const raise = (seconds: number, job: string, kind = "product_ambiguity") =>
		aged(seconds).raise({ job_ids: [job], kind: kind as "product_ambiguity", question: `${job}?`, options: OPTIONS, recommended: "hold" });
	const asks = new OperatorAsks(asksFile(home.path));
	const askFor = (source: string) => asks.open({ project: "demo", question: "q?", options: [{ label: "a", consequence: "b" }], recommendation: "a", source_escalation: source });

	// Raised newest first, so the relay order proves the backstop sorts by age.
	const health = await raise(1, "cp-service-health", "service_health");
	const gate = await raiseForGate(new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 11 * 60_000) }), gateVerdict);
	assert.ok(gate);
	const due = await raise(700, "cp-new");
	const answeredAsk = await raise(750, "cp-answered-ask");
	asks.answer(askFor(answeredAsk.id).id, "a");
	const oldest = await raise(900, "cp-old");
	const quiet = {
		young: await raise(300, "cp-young"),
		asked: await raise(700, "cp-asked"),
		healthAsked: await raise(1, "cp-health-asked", "service_health"),
		pinned: await raise(1000, "cp-pinned"),
		withdrawn: await raise(700, "cp-withdrawn"),
		answered: await raise(700, "cp-answered"),
		superseded: await raise(700, "cp-superseded"),
	};
	askFor(quiet.asked.id);
	askFor(quiet.healthAsked.id);
	const store = new EscalationStore({ home: home.path });
	await store.withdraw(quiet.withdrawn.id);
	await store.answer(quiet.answered.id, { answer: "hold", by: "operator command" });
	store.supersede((item) => (item.id === quiet.superseded.id ? "grant revoked" : undefined));
	const card = asks.open({ project: "demo", question: "A or B?", options: [{ label: "Answer in the operator chat", consequence: "next line" }], recommendation: "Answer in the operator chat", context: `${DETECTED_ASK_PREFIX} (no cp_parent ask was opened) at 2030-01-01T00:00:00.000Z:\nA or B?` });

	// The pinned id was relayed by the bridge before 513 settled relays; the cap must never evict it while it is open.
	const ledgerFile = escalationRelayLedgerFile(home.path, "multi");
	const at = (seconds: number) => isoTimestamp(new Date(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000));
	const settled = Array.from({ length: ESCALATION_RELAY_LEDGER_KEEP + 1 }, (_, i) => ({ id: `es-n${i}`, relayed_at: at(i + 1), via: "backstop" }));
	mkdirSync(dirname(ledgerFile), { recursive: true });
	const bridged = (id: string) => ({ id, relayed_at: at(0), via: "bridge" });
	writeFileSync(ledgerFile, JSON.stringify({ schema_version: SCHEMA_VERSION, items: [bridged(quiet.pinned.id), bridged(quiet.withdrawn.id), ...settled] }));
	const ledger = () => JSON.parse(readFileSync(ledgerFile, "utf8")).items as Array<{ id: string; via: string }>;

	const relays = (pi: PiChild) => pi.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes("[cp-bridge escalation"));
	const relayedIds = (pi: PiChild) => relays(pi).flatMap((r) => [...JSON.stringify(r).matchAll(/\[cp-bridge escalation [^\]]*?id=(es-[\w-]+)/g)].map((m) => m[1]));
	const expected = [oldest.id, answeredAsk.id, due.id, gate.id, health.id];

	const first = await bridge(t, home, [text("Noted.")], true);
	await first.pi.waitFor(() => relayedIds(first.pi).length >= expected.length, 30_000);
	assert.deepEqual(relayedIds(first.pi), expected, "due ids only, oldest first, each once");
	const gateRelay = JSON.stringify(relays(first.pi).find((r) => JSON.stringify(r).includes(`id=${gate.id}`)));
	assert.match(gateRelay, new RegExp(`\\] ${gate.id} \\(conflicting_acceptance\\) has been open \\d+ min and was never relayed to this session`), "project-tagged");
	assert.ok(gateRelay.includes(paths.gateFile("cp-gjva", 1)), "the gate evidence path is named");
	assert.deepEqual([asks.list().find((ask) => ask.id === card.id)?.state], ["open"], "a relay is not the human answering a detected card");
	const items = ledger();
	assert.equal(items.length, ESCALATION_RELAY_LEDGER_KEEP + 1 + expected.length, "settled history capped, open ids pinned");
	assert.ok(!items.some((item) => item.id === "es-n0") && items.some((item) => item.id === "es-n1"), "the oldest settled relay is dropped");
	assert.ok(items.some((item) => item.id === quiet.pinned.id && item.via === "bridge"), "the open bridge relay is pinned");
	assert.ok(!items.some((item) => item.id === quiet.withdrawn.id), "a settled bridge relay is pruned under the cap");
	assert.deepEqual(items.filter((item) => expected.includes(item.id)).map((item) => item.via), expected.map(() => "backstop"));
	await first.close();

	const second = await bridge(t, home, [text("Noted.")], true);
	await turn(second.pi, "Ship it.");
	assert.deepEqual(relayedIds(second.pi), [], "a second session on the same home relays nothing again");
	assert.deepEqual([asks.list().find((ask) => ask.id === card.id)?.answer], ["Ship it."]);
	await second.close();

	await raise(700, "cp-late");
	for (const [content, reason] of [["[]", /violates the escalation-relay ledger contract/], ["{not json", /is not valid JSON/]] as const) {
		writeFileSync(ledgerFile, content);
		const broken = await bridge(t, home, [text("Noted.")], true);
		const status = () => broken.pi.stderr() + JSON.stringify(broken.pi.records().filter((r) => r.type === "extension_ui_request"));
		await broken.pi.waitFor(() => /escalation backstop: paused/.test(status()), 30_000);
		assert.match(status(), reason);
		assert.match(status(), /refusing to guess/);
		await turn(broken.pi, "Anything new?");
		assert.deepEqual(relayedIds(broken.pi), [], "an unreadable ledger relays nothing");
		assert.equal(readFileSync(ledgerFile, "utf8"), content, "and writes nothing");
		await broken.close();
	}
});
