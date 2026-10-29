/**
 * Behavior 09 (P10b): the operator's cp-bridge session, real pi with a mock model. The ask guard nudges a prose
 * question once, then cards it for the next chat line; the escalation backstop relays an overdue escalation once;
 * a parent pi posts schedule result cards, and the real viewer folds the answers journal.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { DETECTED_ASK_PREFIX } from "../../src/ask-guard.ts";
import { HEADER_NUDGE } from "../../src/header-guard.ts";
import { MandateStore } from "../../src/mandate.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { replySplitsFile } from "../../src/viewer/reply-splits.ts";
import {
	DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, type GateVerdict, isoTimestamp, LAYOUT, layoutForHome, paths, SCHEMA_VERSION,
} from "../../src/contracts.ts";
import { ESCALATION_RELAY_LEDGER_KEEP, escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { EscalationStore, raiseForGate } from "../../src/escalation.ts";
import { FleetStore } from "../../src/fleet.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { PushDeliveryStore } from "../../src/push/deliveries.ts";
import { initPush } from "../../src/push/keys.ts";
import { ScheduleRunStore } from "../../src/schedule-runs.ts";
import type { DecisionsResponse, SessionsResponse } from "../../src/viewer/api-types.ts";
import { policyFromLegacy } from "../../src/viewer/schedule-policy.ts";
import { createViewer } from "../../src/viewer/server.ts";
import {
	COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, type PiChild, type ScriptStep, startPiChild, waitFor,
} from "../harness/index.ts";

type Home = ReturnType<typeof createScratchHome>;
const NUDGE = "opened no cp_parent ask";

/** A cp-bridge pi on `home` whose mock model runs `steps`; torn down after the test. */
async function bridge(t: TestContext, home: Home, steps: ScriptStep[], repeat = false, sessionDir?: string) {
	const provider = await MockProvider.start();
	const script = `bridge-${Math.random().toString(16).slice(2)}`;
	const model = provider.addScript(script, steps, repeat ? { onExhausted: "repeat" } : undefined);
	const agentDir = createAgentDir({ provider });
	const pi = startPiChild({ cwd: home.path, model, sessionDir, env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
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
		// A refused cp_parent ask and a non-cp_parent tool result do not count as an ask: the prose question still nudges.
		{
			prompt: "Try asking.",
			steps: [
				{ kind: "tool_calls", calls: [{ id: "ask-bad", name: "cp_parent", args: { action: "ask", ask: { project: "demo-app", question: "A or B?" } } }, { id: "shell", name: "bash", args: { command: "echo ok" } }] },
				text("Should I proceed with A or B?"),
				text("NO-ASK"),
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
	const failed = pi.records().find((r) => r.type === "tool_execution_end" && (r as { toolCallId?: string }).toolCallId === "ask-bad");
	assert.equal((failed as { isError?: boolean } | undefined)?.isError, true, "the bad ask was refused");
	const status = pi.stderr() + JSON.stringify(pi.records().filter((r) => r.type === "extension_ui_request"));
	assert.doesNotMatch(status, /ask guard: [^"]*failed/, "a blank line is skipped, never a failed answer");
});

test("decisions: the header guard forces one re-send of a reply naming project work without a [project] header, records the outcome in the sidecar the transcript folds, and never adds a turn to a plain or an ask-nudged reply", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const layout = layoutForHome("multi", home.path), stateDir = join(home.path, layout.state);
	for (const name of ["demo-app", "other-app"]) mkdirSync(join(home.path, layout.projects, name), { recursive: true });
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(fleetJob(home.path, "cp-1234", { project: "demo-app" }));
	await fleet.add(fleetJob(home.path, "cp-5678", { project: "other-app" }));
	new MandateStore(home.path).issue({ projects: ["demo-app"], objective: "issue 589", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5 });
	const R = {
		first: "cp-1234 landed and ask-0a1b2c3d4e5f is open.", resent: "[demo-app] cp-1234 landed; ask-0a1b2c3d4e5f is open.",
		mixed: "cp-1234 and cp-5678 merged.", stillMixed: "cp-1234 and cp-5678 are both merged.", bare: "cp-1234 is done.",
		humanMixed: "cp-1234 and cp-5678 shipped.", humanStill: "cp-1234 and cp-5678 are both shipped.",
		askMiss: "cp-1234 is merged now.", askMissAsk: "cp-1234 is merged now. Should I proceed?",
	};
	// Each run: [prompt, replies, header-nudged]. A miss gets one re-send; plain, headed and ask-nudged runs add no turn.
	const runs: Array<[string, string[], boolean]> = [
		["Hi.", ["Done."], false],
		["Status?", ["[demo-app] cp-1234 landed."], false],
		["Status?", [R.first, R.resent], true],
		["Next?", [R.mixed, R.stillMixed], true],
		["[other-app] Then?", [R.humanMixed, R.humanStill], true],
		["Later?", [R.askMiss, R.askMissAsk, "NO-ASK"], true],
		["And?", [R.bare, "NO-PROJECT"], true],
		["Proceed?", ["cp-1234 landed. Should I proceed?", "NO-ASK"], false],
	];
	const sessionDir = join(home.path, "operator-sessions");
	const { pi, provider, script } = await bridge(t, home, runs.flatMap(([, replies]) => replies.map(text)), false, sessionDir);
	const requests = () => provider.requests(script);
	const headerNudges = (index: number) => JSON.stringify(requests()[index]?.body ?? "").split(HEADER_NUDGE).length - 1;
	for (const [prompt, replies, nudged] of runs) {
		const before = requests().length;
		await turn(pi, prompt);
		assert.equal(requests().length - before, replies.length, `${replies[0]}: provider requests`);
		assert.equal(headerNudges(requests().length - 1) > headerNudges(before), nudged, `${replies[0]}: header nudged`);
	}
	assert.match(JSON.stringify(requests().at(-1)?.body), new RegExp(NUDGE), "the question run got the ask nudge instead");
	assert.equal(provider.remaining(script), 0);

	const [file] = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
	assert.ok(file, "the bridge session was saved");
	const sidecar = replySplitsFile(stateDir);
	const records = readFileSync(sidecar, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const kinds = [["superseded", 0], ["superseded", 0], ["split", 0], ["superseded", 0], ["split", 0], ["hidden", 0]];
	assert.deepEqual(records.map((r) => [r.type, r.block]), kinds, "a second miss supersedes the first; NO-PROJECT and an ask-nudged re-send write no superseded");
	assert.ok(records.every((r) => r.session_file === file && typeof r.ts === "number"));
	assert.deepEqual(records[2].segments, [{ text: R.stillMixed, projects: ["demo-app"], source: "reply" }], "two projects by id: the active mandate's");
	assert.deepEqual(records[4].segments, [{ text: R.humanStill, projects: ["other-app"], source: "reply" }], "the human's [project], not the mandate's");
	assert.equal(statSync(sidecar).mode & 0o777, 0o600);

	const sessions = operatorSessionsFile(join(stateDir, "sessions"));
	mkdirSync(dirname(sessions), { recursive: true });
	appendFileSync(sessions, `${JSON.stringify({ at: isoTimestamp(), session_file: file })}\n`);
	// Malformed lines (bad JSON, a split with no `projects`) are skipped, never a 500. The bad split reuses the live
	// split's key: last record wins, so without the shape check it would override the valid split.
	const bad = { type: "split", session_file: file, ts: records[2].ts, block: records[2].block, segments: [{ text: "x" }] };
	appendFileSync(sidecar, `not json\n${JSON.stringify(bad)}\n`);
	const viewer = createViewer({ home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } });
	await new Promise<void>((resolve) => viewer.listen(0, "127.0.0.1", resolve));
	t.after(() => viewer.close());
	const bytes = readFileSync(file);
	const res = await fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/api/sessions?view=you&transcript=1`);
	assert.equal(res.status, 200);
	const says = ((await res.json()) as SessionsResponse).entries.filter((e) => e.kind === "say" && e.who === "Assistant");
	const shown = (reply: string) => says.find((e) => e.text === reply);
	assert.equal(shown(R.first)?.collapsed, "superseded", "the reply the re-send replaced folds");
	assert.deepEqual([shown(R.resent.slice("[demo-app] ".length))?.project, shown(R.resent.slice("[demo-app] ".length))?.collapsed], ["demo-app", undefined]);
	assert.deepEqual([shown(R.mixed)?.collapsed, shown(R.humanMixed)?.collapsed], ["superseded", "superseded"], "one copy shows");
	assert.equal(shown(R.stillMixed)?.project, "demo-app", "the split record overrides the read-time split");
	assert.equal(shown(R.humanStill)?.project, "other-app", "the fallback is the human's project");
	assert.deepEqual([shown(R.askMiss)?.collapsed, shown(R.askMiss)?.project], [undefined, "demo-app"], "an ask-nudged re-send is not a superseded reply");
	assert.equal(shown("NO-PROJECT")?.collapsed, "hidden");
	assert.deepEqual([shown(R.bare)?.collapsed, shown(R.bare)?.project], [undefined, "demo-app"], "NO-PROJECT keeps the reply and its id chip");
	assert.ok(readFileSync(file).equals(bytes), "reading the transcript never rewrites the session file");
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
	const wake = "[cp-bridge wake] cp-wake-probe finished";
	new OperatorRelayOutbox(operatorRelayOutboxFile(join(home.path, layoutForHome("multi", home.path).state)))
		.enqueue({ kind: "wake", stale: false, text: wake, receipt: { level: null, reached: [] }, paths: [], jobId: "cp-wake-probe" }, "test");

	const relays = (pi: PiChild) => pi.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes("[cp-bridge escalation"));
	const relayedIds = (pi: PiChild) => relays(pi).flatMap((r) => [...JSON.stringify(r).matchAll(/\[cp-bridge escalation [^\]]*?id=(es-[\w-]+)/g)].map((m) => m[1]));
	const expected = [oldest.id, answeredAsk.id, due.id, gate.id, health.id];

	const first = await bridge(t, home, [text("Noted.")], true);
	await first.pi.waitFor(() => relayedIds(first.pi).length >= expected.length, 30_000);
	assert.deepEqual(relayedIds(first.pi), expected, "due ids only, oldest first, each once");
	await first.pi.waitFor((r) => r.type === "message_start" && JSON.stringify(r).includes("cp-wake-probe"), 30_000);
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
	assert.ok(!items.some((item) => String(item.id).includes("cp-wake-probe")), "the relayed wake wrote no ledger item");
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

const ghShaped = `gh${"p"}_${"A".repeat(36)}`;
const keyHeader = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;

/** A held research job of `project` for the answers journal's job_id rule. */
function fleetJob(home: string, jobId: string, over: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: jobId, project: "demo", kind: "research", delivery: "local", origin: DEFAULT_ORIGIN, phase: "held",
		worker: { pid: process.pid, session_id: "s", session_file: join(home, "s.jsonl"), profile: "planner", role: "planner", model: "mock/model", started_at: isoTimestamp() },
		worktree: join(home, "wt"), branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, ...(["held", "done"].includes(over.phase ?? "held") ? { reported_at: isoTimestamp() } : {}),
		...(over.phase === "failed" ? { failure: { class: "crash" as const, message: "died", at: isoTimestamp() } } : {}), ...over,
	};
}

function snapshot(root: string, rel = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of existsSync(join(root, rel)) ? readdirSync(join(root, rel), { withFileTypes: true }) : []) {
		const path = join(rel, entry.name);
		if (entry.isDirectory()) Object.assign(out, snapshot(root, path));
		else if (entry.isFile()) out[path] = readFileSync(join(root, path), "utf8");
	}
	return out;
}

test("decisions: cp_parent answer posts bookkeeping answers to the dashboard journal, redacted, deduplicated per research landing and refused for anything else", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	for (const [id, over] of [
		["cp-local", {}], ["cp-answer", { delivery: "answer", phase: "done" }], ["cp-board", { delivery: "board" }],
		["cp-ship", { kind: "ship", delivery: "pr" }], ["cp-other", { project: "elsewhere" }],
		["cp-waiting", { phase: "waiting" }], ["cp-failed", { phase: "failed" }],
	] as Array<[string, Partial<FleetRecord>]>) await fleet.add(fleetJob(home.path, id, over));
	const input = { action: "answer", project: "demo", question: "Does it work?", answer: "Yes." };
	const calls: Array<[string, Record<string, unknown>]> = [
		["long", { ...input, question: "q".repeat(600), evidence_paths: ["state/runs/cp-1/artifact.md"] }],
		["redacted", { ...input, answer: `token ${ghShaped} here` }],
		["key", { ...input, answer: `${keyHeader}\nMIIE` }],
		...["cp-local", "cp-answer", "cp-board"].map((id): [string, Record<string, unknown>] => [`job-${id}`, { ...input, job_id: id }]),
		...["cp-local", "cp-answer", "cp-board"].map((id): [string, Record<string, unknown>] => [`again-${id}`, { ...input, answer: "second", job_id: id }]),
		...["cp-nope", "cp-ship", "cp-other", "cp-waiting", "cp-failed"].map((id): [string, Record<string, unknown>] => [`refuse-${id}`, { ...input, job_id: id }]),
		["too-long", { ...input, answer: "a".repeat(8001) }],
		["too-many", { ...input, evidence_paths: Array.from({ length: 11 }, (_, i) => `p${i}`) }],
		["max", { ...input, answer: "a".repeat(8000) }],
		["ask-id", { ...input, id: "ask-abc123" }],
		["ask-question", { ...input, question: "ask-abc123: Keep" }],
		["relay", { ...input, question: "[cp-bridge send] wake-up" }],
		["no-project", { ...input, project: "" }],
	];
	const steps = calls.map(([id, args]): ScriptStep => ({ kind: "tool_calls", calls: [{ id, name: "cp_parent", args }] }));
	const { pi } = await bridge(t, home, [text("Hello."), text("Hello again."), ...steps, text("Posted.")]);
	const stateDir = join(home.path, layoutForHome("multi", home.path).state);
	const journal = join(stateDir, "operator", "answers.jsonl");
	await turn(pi, "Hi.");
	const quiet = snapshot(home.path);
	await turn(pi, "Again.");
	const before = snapshot(home.path);
	await turn(pi, "Post the answers.");

	type End = { toolCallId: string; isError?: boolean; result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
	const ends = new Map((pi.records().filter((r) => r.type === "tool_execution_end") as unknown as End[]).map((end) => [end.toolCallId, end]));
	const ok = (id: string) => {
		const end = ends.get(id);
		assert.ok(end && !end.isError, `${id}: ${JSON.stringify(end?.result?.content)}`);
		return end.result?.details ?? {};
	};
	const refused = (id: string, message: RegExp) => {
		const end = ends.get(id);
		assert.equal(end?.isError, true, id);
		assert.match(end?.result?.content?.[0]?.text ?? "", message, id);
		return end?.result?.content?.[0]?.text ?? "";
	};
	const lines = () => readFileSync(journal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	const byId = (id: unknown) => lines().find((line) => line.id === id) ?? {};

	const long = ok("long");
	assert.equal(long.state, "posted");
	assert.match(String(long.id), /^ans-[a-f0-9]{12}$/);
	const line = byId(long.id);
	assert.deepEqual([line.type, line.by, line.job_id, line.evidence_paths], ["posted", "bridge", null, ["state/runs/cp-1/artifact.md"]]);
	assert.equal(String(line.question).length, 500);
	assert.ok(String(line.question).endsWith("\u2026"));
	assert.equal(statSync(journal).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(journal)).mode & 0o777, 0o700);

	const stored = String(byId(ok("redacted").id).answer);
	assert.ok(stored.includes("\u2022\u2022\u2022") && !stored.includes(ghShaped));
	assert.doesNotMatch(refused("key", /secret-shaped text \(private key block\) remains after redaction/), /BEGIN/);

	const first = ["cp-local", "cp-answer", "cp-board"].map((id) => ok(`job-${id}`));
	assert.deepEqual(first.map((details) => details.state), ["posted", "posted", "posted"]);
	assert.equal(new Set(first.map((details) => details.id)).size, 3);
	assert.deepEqual(["cp-local", "cp-answer", "cp-board"].map((id) => [ok(`again-${id}`).state, ok(`again-${id}`).id]), first.map((details) => ["duplicate", details.id]));
	refused("refuse-cp-nope", /unknown job cp-nope/);
	refused("refuse-cp-ship", /cp-ship is a ship job \(delivery pr\); answers name kind:research landings only, any delivery/);
	refused("refuse-cp-other", /cp-other belongs to elsewhere, not demo/);
	refused("refuse-cp-waiting", /has not landed \(phase waiting\)/);
	refused("refuse-cp-failed", /has not landed \(phase failed\)/);

	refused("too-long", /invalid operator answer/);
	refused("too-many", /invalid operator answer/);
	assert.equal(String(byId(ok("max").id).answer).length, 8000);
	refused("ask-id", /ask_answer/);
	for (const id of ["ask-question", "relay"]) refused(id, /the question is a relay or a decision reply/);
	refused("no-project", /cp_parent answer needs project, question and answer/);

	assert.equal(lines().length, 6, "two posts, three job landings and the max answer; every refusal and duplicate wrote nothing");
	const after = snapshot(home.path);
	const relJournal = join(layoutForHome("multi", home.path).state, "operator", "answers.jsonl");
	const touched = (from: Record<string, string>, to: Record<string, string>) => Object.keys(to).filter((file) => from[file] !== to[file]);
	const plain = touched(quiet, before);
	const extra = touched(before, after).filter((file) => file !== relJournal && !plain.includes(file));
	assert.deepEqual(extra, [], `beyond what a plain turn touches (${plain.join(", ")}), only the journal is written`);
	assert.ok(!(relJournal in before) && relJournal in after);
	assert.equal(existsSync(join(stateDir, "operator", "asks.jsonl")), false, "posting an answer creates no ask");

	const other = createScratchHome();
	t.after(() => other.cleanup());
	mkdirSync(join(other.path, layoutForHome("multi", other.path).state, "operator", "answers.jsonl"), { recursive: true });
	const blocked = await bridge(t, other, [{ kind: "tool_calls", calls: [{ id: "dir", name: "cp_parent", args: input }] }, text("Refused.")]);
	await turn(blocked.pi, "Post it.");
	const end = blocked.pi.records().find((r) => r.type === "tool_execution_end") as unknown as End | undefined;
	assert.equal(end?.isError, true, "a directory at the journal path refuses the post");
	assert.match(end?.result?.content?.[0]?.text ?? "", /answers journal unreadable/);
});

const SCHED_AT = "2026-10-04T15:00:00Z";
/** One accepted schedule run whose result card is queued but undelivered, as a crash before posting leaves it. */
async function pendingRun(runs: ScheduleRunStore, n: number, sourceKey: string, headline: string) {
	const schedule = `sch-12345${n}`, run = `run-20261004150000-abcde${n}`;
	const policy = policyFromLegacy({ id: schedule, name: `Nightly ${n}`, project: "demo", mandate_id: "md-123456", enabled: true, created_at: SCHED_AT, trigger: { type: "manual" }, job: { title: `Nightly ${n}`, kind: "research", delivery: "answer" } }, {
		seed_mandate_id: "md-123456", channel: "operator_chat", objective: "nightly", expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 6,
		allowed_actions: ["plan", "review"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run the report", decided_by: "operator-quote", approved_at: SCHED_AT },
	});
	await runs.createRun({ schema_version: 1, id: run, schedule_id: policy.schedule_id, policy_revision: 1, policy, trigger: { via: "slot", at: SCHED_AT }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: SCHED_AT, deadline_at: "2026-10-04T16:00:00Z", risk_preapproved: [], authority_log: [], cap_notices: [],
		result: { source_key: sourceKey, job_id: null, generation: null, outcome: "completed", headline, at: SCHED_AT, links: [], answer_id: null, delivered_at: null },
	});
	return { schedule_id: policy.schedule_id, run_id: run, source: { kind: "schedule", schedule_id: policy.schedule_id, run_id: run, source_key: sourceKey, outcome: "completed" } };
}

test("decisions: a parent pi posts each schedule result card once, redacted or refused, pushes only asks, and the dashboard folds acks, garbage and a torn tail", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const stateDir = join(home.path, LAYOUT.state);
	const journal = join(stateDir, "operator", "answers.jsonl");
	const viewer = createViewer({ home: home.path, stateDir, host: "127.0.0.1", port: 0, log: () => {} });
	await new Promise<void>((resolve) => viewer.listen(0, "127.0.0.1", resolve));
	t.after(() => { viewer.close(); scratch.cleanup(); home.cleanup(); });
	const answersView = async () => {
		const res = await fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/api/decisions`);
		assert.equal(res.status, 200);
		return (await res.json() as DecisionsResponse).answers;
	};
	assert.equal((await answersView()).availability, "missing", "no journal yet reads as missing, not unavailable");

	const runs = new ScheduleRunStore({ home: home.path });
	const dup = await pendingRun(runs, 1, "p10b-dup", "posted before the crash");
	const redacted = await pendingRun(runs, 2, "p10b-redact", `token ${ghShaped} here`);
	const refused = await pendingRun(runs, 3, "p10b-refuse", `${keyHeader}\nMIIE`);
	const dupId = `ans-${createHash("sha256").update("p10b-dup").digest("hex").slice(0, 12)}`;
	const line = (row: Record<string, unknown>) => JSON.stringify(row);
	const posted = { type: "posted", project: "demo", question: "Q?", evidence_paths: [], job_id: null };
	mkdirSync(dirname(journal), { recursive: true });
	writeFileSync(journal, [
		line({ ...posted, by: "bridge", id: "ans-aaaaaaaaaaaa", at: "2026-01-01T00:00:00Z", answer: "Acked twice." }),
		line({ ...posted, by: "schedule", id: dupId, at: "2026-01-01T00:00:00Z", answer: "first card", source: dup.source }),
		line({ type: "acked", by: "viewer", id: "ans-aaaaaaaaaaaa", at: "2026-01-01T01:00:00Z", peer: "127.0.0.1" }),
		line({ type: "acked", by: "viewer", id: "ans-aaaaaaaaaaaa", at: "2026-02-02T00:00:00Z", peer: "127.0.0.1" }),
		line({ type: "acked", by: "viewer", id: "ans-000000000000", at: "2026-01-01T00:00:00Z", peer: "127.0.0.1" }),
		"not json",
		line({ ...posted, by: "schedule", id: "ans-bbbbbbbbbbbb", at: "2026-01-01T00:00:00Z", answer: "bad source", source: { ...dup.source, extra: 1 } }),
		"",
	].join("\n"));
	initPush({ dataDir: join(home.path, LAYOUT.data), origin: "https://cp.example.test" });
	const ask = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "A or B?", options: [{ label: "a", consequence: "b" }], recommendation: "a" });

	const provider = await MockProvider.start();
	const model = provider.addScript("p10b-parent", [text("checked")]);
	const agent = createAgentDir({ provider });
	const parent = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await parent.close(); agent.cleanup(); await provider.stop(); });
	await parent.prompt("inspect startup");
	await parent.waitForSettled(60_000);
	const result = (id: string) => runs.run(id)!.result!;
	await waitFor(() => Boolean(result(redacted.run_id).delivered_at && result(refused.run_id).error), Boolean, { timeoutMs: 15_000, what: "schedule result sync" });
	const pushed = await waitFor(() => new PushDeliveryStore(stateDir).read(), Boolean, { timeoutMs: 20_000, what: "push sweep baseline" });

	const raw = readFileSync(journal, "utf8").split("\n").filter(Boolean);
	assert.equal(raw.filter((row) => row.includes(dupId)).length, 1, "a retry after a crash reuses the first card");
	assert.deepEqual([result(dup.run_id).answer_id, Boolean(result(dup.run_id).delivered_at)], [dupId, true]);
	const card = JSON.parse(raw.find((row) => row.includes("p10b-redact"))!);
	assert.deepEqual([card.by, card.source, card.answer.includes(ghShaped), card.answer.includes("token")], ["schedule", redacted.source, false, true]);
	assert.match(result(refused.run_id).error!, /private key block/);
	assert.equal(result(refused.run_id).delivered_at, null);
	assert.ok(!raw.some((row) => row.includes("p10b-refuse")), "a refused card never reaches the journal");
	assert.deepEqual(pushed!.items.map((item) => item.id), [ask.id], "the push sweep baselines the open ask only, never an answer");

	appendFileSync(journal, line({ ...posted, by: "bridge", id: "ans-cccccccccccc", at: "2026-03-03T00:00:00Z", answer: "torn" }).slice(0, 40));
	const view = await answersView();
	assert.deepEqual(view.history.map((item) => [item.id, item.acked_at]), [["ans-aaaaaaaaaaaa", "2026-01-01T01:00:00Z"]], "an ack sets acked_at once");
	assert.deepEqual(view.open.map((item) => [item.id, item.schedule?.run_id]).sort(), [[`ans-${createHash("sha256").update("p10b-redact").digest("hex").slice(0, 12)}`, redacted.run_id], [dupId, dup.run_id]].sort());
	assert.equal(view.warning, "3 unreadable line(s) in state/operator/answers.jsonl skipped", "unknown ack, garbage and bad source skip; the torn tail is ignored");
});
