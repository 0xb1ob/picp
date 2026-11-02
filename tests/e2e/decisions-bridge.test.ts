/**
 * Behavior 09 (P10b): the operator's cp-bridge session, real pi with a mock model. The ask guard nudges a prose
 * question once, then cards it for the next chat line; the escalation backstop relays an overdue escalation once;
 * cp_parent answer keeps short answers inline and publishes long ones as reports behind the M2 PR2 migration gate;
 * a parent pi migrates the legacy answers journal at startup and delivers schedule result cards.
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
import { answerJournals } from "../../src/migrate-answer-reports.ts";
import { publishResponseReport, readResponseReport, RESPONSE_INLINE_MAX, RESPONSE_REPORT_MAX_BYTES, responseReportSlug } from "../../src/response-reports.ts";
import { resolveStateDir } from "../../src/viewer/sessions.ts";
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
async function bridge(t: TestContext, home: Home, steps: ScriptStep[], repeat = false, sessionDir?: string, env: Record<string, string> = {}) {
	const provider = await MockProvider.start();
	const script = `bridge-${Math.random().toString(16).slice(2)}`;
	const model = provider.addScript(script, steps, repeat ? { onExhausted: "repeat" } : undefined);
	const agentDir = createAgentDir({ provider });
	const pi = startPiChild({ cwd: home.path, model, sessionDir, env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", ...env }, extensions: [CP_BRIDGE_EXTENSION] });
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

const VIEWER_ENV = { CP_VIEWER_HOST: "127.0.0.2", CP_VIEWER_PORT: "9911" };
/** Astral characters: 4,000 code points are 8,000 UTF-16 units, so a `.length` threshold would misfire. */
const astral = (n: number) => "\u{1F600}".repeat(n);
const LONG_ANSWER = `Headline.\n\n${astral(RESPONSE_INLINE_MAX)}`;
type End = { toolCallId: string; isError?: boolean; result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
const boardsOf = (home: string): string[] => { const dir = join(resolveStateDir(home), "boards"); return existsSync(dir) ? readdirSync(dir).sort() : []; };
const LEGACY = [
	{ type: "posted", by: "bridge", id: "ans-aaaaaaaaaaaa", at: "2026-01-01T00:00:00Z", project: "demo", question: "Q?", answer: "Acked answer.", evidence_paths: ["README.md"], job_id: "cp-local" },
	{ type: "posted", by: "schedule", id: "ans-bbbbbbbbbbbb", at: "2026-01-02T00:00:00Z", project: "demo", question: "Nightly", answer: "Card.", evidence_paths: [], job_id: null,
		source: { kind: "schedule", schedule_id: "sch-123456", run_id: "run-1", source_key: "k", outcome: "completed" } },
	{ type: "acked", by: "viewer", id: "ans-aaaaaaaaaaaa", at: "2026-01-03T00:00:00Z", peer: "127.0.0.1" },
	{ type: "acked", by: "viewer", id: "ans-aaaaaaaaaaaa", at: "2026-01-04T00:00:00Z", peer: null },
].map((row) => `${JSON.stringify(row)}\n`).join("");
const MIGRATED = [
	{ project: "demo", question: "Q?", answer: "Acked answer.", evidence: ["README.md"], job: "cp-local", source: "legacy:ans-aaaaaaaaaaaa", time: "2026-01-01T00:00:00Z" },
	{ project: "demo", question: "Nightly", answer: "Card.", evidence: [], job: null, source: "legacy:ans-bbbbbbbbbbbb", time: "2026-01-02T00:00:00Z" },
];

test("decisions: cp_parent answer keeps short answers inline, publishes long ones as permanent reports (redacted, one per source) and refuses anything else", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	for (const [id, over] of [
		["cp-local", {}], ["cp-answer", { delivery: "answer", phase: "done" }], ["cp-board", { delivery: "board" }],
		["cp-ship", { kind: "ship", delivery: "pr" }], ["cp-other", { project: "elsewhere" }],
		["cp-waiting", { phase: "waiting" }], ["cp-failed", { phase: "failed" }],
	] as Array<[string, Partial<FleetRecord>]>) await fleet.add(fleetJob(home.path, id, over));
	const input = { action: "answer", project: "demo", question: "Does it work?", answer: "Yes." };
	const jobs = ["cp-local", "cp-answer", "cp-board"];
	const calls: Array<[string, Record<string, unknown>]> = [
		["short", input],
		["exact", { ...input, answer: astral(RESPONSE_INLINE_MAX) }],
		["long", { ...input, question: "q".repeat(600), answer: LONG_ANSWER, evidence_paths: ["state/runs/cp-1/artifact.md"] }],
		["redacted", { ...input, answer: `token ${ghShaped} here\n\n${LONG_ANSWER}` }],
		["key", { ...input, answer: `${keyHeader}\nMIIE` }],
		// lastIndex: a late match, then one in the first text checked; a global regex would carry its index and miss it.
		["key-late", { ...input, answer: `${"pad ".repeat(200)}${keyHeader}\nMIIE` }],
		["key-question", { ...input, question: `${keyHeader}\nMIIE` }],
		...jobs.map((id): [string, Record<string, unknown>] => [`job-${id}`, { ...input, answer: LONG_ANSWER, job_id: id }]),
		...jobs.map((id): [string, Record<string, unknown>] => [`again-${id}`, { ...input, answer: LONG_ANSWER, job_id: id }]),
		["changed", { ...input, answer: `${LONG_ANSWER} changed`, job_id: "cp-local" }],
		...["cp-nope", "cp-ship", "cp-other", "cp-waiting", "cp-failed"].map((id): [string, Record<string, unknown>] => [`refuse-${id}`, { ...input, job_id: id }]),
		["too-long", { ...input, answer: "a".repeat(RESPONSE_REPORT_MAX_BYTES + 1) }],
		["too-many", { ...input, evidence_paths: Array.from({ length: 11 }, (_, i) => `p${i}`) }],
		["ask-id", { ...input, id: "ask-abc123" }],
		["ask-question", { ...input, question: "ask-abc123: Keep" }],
		["relay", { ...input, question: "[cp-bridge send] wake-up" }],
		["no-project", { ...input, project: "" }],
	];
	const steps = calls.map(([id, args]): ScriptStep => ({ kind: "tool_calls", calls: [{ id, name: "cp_parent", args }] }));
	const { pi } = await bridge(t, home, [text("Hello."), text("Hello again."), ...steps, text("Posted.")], false, undefined, VIEWER_ENV);
	const boards = join(resolveStateDir(home.path), "boards");
	await turn(pi, "Hi.");
	const quiet = snapshot(home.path);
	await turn(pi, "Again.");
	const before = snapshot(home.path);
	await turn(pi, "Post the answers.");

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
	const payloadOf = (slug: unknown) => readFileSync(join(boards, String(slug), "site", "content.json"), "utf8");

	assert.deepEqual(ok("short"), { state: "inline", id: null, job_id: null, project: "demo", delivery: "inline", text: "Yes.", url: null });
	assert.deepEqual([ok("exact").delivery, ok("exact").url], ["inline", null], "exactly 4,000 code points stays inline");
	const long = ok("long");
	assert.deepEqual([long.state, long.delivery, long.url], ["posted", "report", `http://127.0.0.2:9911/boards/${long.id}/`]);
	assert.match(String(long.id), /^report-[0-9a-f]{32}$/);
	assert.equal(long.text, `Headline.\n\nFull answer: ${long.url}`);
	assert.doesNotMatch(ends.get("long")?.result?.content?.[0]?.text ?? "", /\u{1F600}/u, "the tool text is the headline and link, never the body");
	const content = payloadOf(long.id), payload = JSON.parse(content) as Record<string, unknown>;
	assert.deepEqual(Object.keys(payload), ["project", "question", "answer", "evidence", "job", "source", "time"]);
	assert.deepEqual([String(payload.question).length, payload.answer, payload.evidence, payload.job], [600, LONG_ANSWER, ["state/runs/cp-1/artifact.md"], null]);
	assert.match(String(payload.source), /^chat:\S+:long$/);
	const meta = JSON.parse(readFileSync(join(boards, String(long.id), "board.json"), "utf8")) as Record<string, unknown>;
	assert.deepEqual([meta.project, meta.source, meta.content_sha256], ["demo", payload.source, createHash("sha256").update(content, "utf8").digest("hex")]);
	assert.equal(statSync(join(boards, String(long.id), "site", "content.json")).mode & 0o777, 0o600);

	const redacted = payloadOf(ok("redacted").id);
	assert.ok(redacted.includes("\u2022\u2022\u2022") && !redacted.includes(ghShaped));
	for (const id of ["key", "key-late", "key-question"]) assert.doesNotMatch(refused(id, /secret-shaped text \(private key block\) remains after redaction/), /BEGIN/);

	const first = jobs.map((id) => ok(`job-${id}`));
	assert.deepEqual(first.map((details) => [details.state, details.job_id, JSON.parse(payloadOf(details.id)).source]), jobs.map((id) => ["posted", id, `research:${id}`]));
	assert.deepEqual(jobs.map((id) => [ok(`again-${id}`).state, ok(`again-${id}`).id]), first.map((details) => ["duplicate", details.id]));
	refused("changed", /response report conflict: research:cp-local is already published as \/boards\/report-[0-9a-f]{32}\/ with different content/);
	refused("refuse-cp-nope", /unknown job cp-nope/);
	refused("refuse-cp-ship", /cp-ship is a ship job \(delivery pr\); answers name kind:research landings only, any delivery/);
	refused("refuse-cp-other", /cp-other belongs to elsewhere, not demo/);
	refused("refuse-cp-waiting", /has not landed \(phase waiting\)/);
	refused("refuse-cp-failed", /has not landed \(phase failed\)/);
	refused("too-long", /invalid operator answer/);
	refused("too-many", /invalid operator answer/);
	refused("ask-id", /ask_answer/);
	for (const id of ["ask-question", "relay"]) refused(id, /the question is a relay or a decision reply/);
	refused("no-project", /cp_parent answer needs project, question and answer/);

	assert.equal(boardsOf(home.path).length, 5, "long, redacted and three job landings; inline, refused and duplicate posts publish nothing");
	const after = snapshot(home.path);
	const touched = (from: Record<string, string>, to: Record<string, string>) => Object.keys(to).filter((file) => from[file] !== to[file]);
	const plain = touched(quiet, before);
	const extra = touched(before, after).filter((file) => !file.includes("/boards/report-") && !plain.includes(file));
	assert.deepEqual(extra, [], `beyond what a plain turn touches (${plain.join(", ")}), only reports are written`);
	assert.equal(existsSync(answerJournals(home.path).live), false, "no answers journal and no pending card");
	assert.equal(existsSync(join(resolveStateDir(home.path), "operator", "asks.jsonl")), false, "posting an answer creates no ask");
});

test("decisions: the answer migration gate runs before any cp_parent answer write: live-only migrates and renames, archive-only is a no-op, both or a bad journal fail closed", { timeout: 240_000 }, async (t) => {
	const input = { action: "answer", project: "demo", question: "Does it work?", answer: LONG_ANSWER };
	const seed = (live?: string, archive?: string) => {
		const dir = createScratchHome();
		t.after(() => dir.cleanup());
		const files = answerJournals(dir.path);
		mkdirSync(dirname(files.live), { recursive: true });
		if (live !== undefined) writeFileSync(files.live, live, { mode: 0o640 });
		if (archive !== undefined) writeFileSync(files.archive, archive);
		return { dir, ...files };
	};
	const post = async (dir: Home, id: string, args: Record<string, unknown> = input) => {
		const b = await bridge(t, dir, [{ kind: "tool_calls", calls: [{ id, name: "cp_parent", args }] }, text("Done.")], false, undefined, VIEWER_ENV);
		await turn(b.pi, "Post it.");
		const end = b.pi.records().find((r) => r.type === "tool_execution_end") as unknown as End;
		await b.close();
		return { end, text: end.result?.content?.[0]?.text ?? "" };
	};

	// Live only: every unique posted answer, acknowledged or not, becomes a report with no ack metadata; then the rename.
	const live = seed(LEGACY);
	const migrated = await post(live.dir, "migrate");
	assert.ok(!migrated.end.isError, migrated.text);
	assert.deepEqual([existsSync(live.live), readFileSync(live.archive, "utf8"), statSync(live.archive).mode & 0o777], [false, LEGACY, 0o640]);
	assert.deepEqual(MIGRATED.map((p) => readResponseReport(live.dir.path, p.source)?.payload), MIGRATED);
	assert.deepEqual(boardsOf(live.dir.path).length, 3, "two legacy reports plus the new answer");
	assert.ok(!boardsOf(live.dir.path).some((slug) => /acked|peer/.test(readFileSync(join(resolveStateDir(live.dir.path), "boards", slug, "site", "content.json"), "utf8"))));
	// Archive only (the next startup): nothing is migrated again and the archive keeps its bytes.
	const again = await post(live.dir, "again", { ...input, answer: "Short." });
	assert.ok(!again.end.isError, again.text);
	assert.deepEqual([existsSync(live.live), readFileSync(live.archive, "utf8"), boardsOf(live.dir.path).length], [false, LEGACY, 3]);

	// Both journals: the named conflict, both byte-identical, no producer write.
	const both = seed(LEGACY, "older archive\n");
	const conflict = await post(both.dir, "both");
	assert.equal(conflict.end.isError, true);
	assert.match(conflict.text, /answer migration conflict: live and migrated journals both exist/);
	assert.deepEqual([readFileSync(both.live, "utf8"), readFileSync(both.archive, "utf8"), boardsOf(both.dir.path)], [LEGACY, "older archive\n", []]);

	// A journal that does not parse strictly, or a report that disagrees with it, aborts with the live bytes unchanged.
	const unknownAck = `${JSON.stringify({ type: "acked", by: "viewer", id: "ans-cccccccccccc", at: "2026-01-01T00:00:00Z", peer: null })}\n`;
	for (const [name, bytes, why] of [
		["torn", `${LEGACY}{"type":"posted"`, /last line is torn/], ["garbage", `not json\n${LEGACY}`, /line 1 is not JSON/],
		["unknown-ack", unknownAck, /acknowledges ans-cccccccccccc, which no earlier line posted/],
	] as const) {
		const bad = seed(bytes);
		const failed = await post(bad.dir, name);
		assert.equal(failed.end.isError, true, name);
		assert.match(failed.text, /answer migration failed, \S+answers\.jsonl left unchanged: /, name);
		assert.match(failed.text, why, name);
		assert.deepEqual([readFileSync(bad.live, "utf8"), existsSync(bad.archive), boardsOf(bad.dir.path)], [bytes, false, []], name);
	}
	const mismatch = seed(LEGACY);
	publishResponseReport(mismatch.dir.path, { ...MIGRATED[0]!, answer: "Something else." });
	const refused = await post(mismatch.dir, "mismatch");
	assert.match(refused.text, /answer migration failed, .*legacy:ans-aaaaaaaaaaaa: response report conflict/);
	assert.deepEqual([readFileSync(mismatch.live, "utf8"), existsSync(mismatch.archive), boardsOf(mismatch.dir.path).length], [LEGACY, false, 1]);

	// A restart after a partial publication reuses the verified report and completes once.
	const partial = seed(LEGACY);
	publishResponseReport(partial.dir.path, MIGRATED[0]!);
	const resumed = await post(partial.dir, "partial", { ...input, answer: "Short." });
	assert.ok(!resumed.end.isError, resumed.text);
	assert.deepEqual([existsSync(partial.live), readFileSync(partial.archive, "utf8"), boardsOf(partial.dir.path).length], [false, LEGACY, 2]);
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

test("decisions: a parent pi migrates the legacy journal at startup, then delivers each schedule result card once (inline or a redacted report) or refuses it, and pushes only asks", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const stateDir = join(home.path, LAYOUT.state);
	const { live, archive } = answerJournals(home.path);
	const viewer = createViewer({ home: home.path, stateDir, host: "127.0.0.1", port: 0, log: () => {} });
	await new Promise<void>((resolve) => viewer.listen(0, "127.0.0.1", resolve));
	t.after(() => { viewer.close(); scratch.cleanup(); home.cleanup(); });
	const decisionsPage = async () => {
		const res = await fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/api/decisions`);
		assert.equal(res.status, 200);
		return await res.json() as DecisionsResponse;
	};

	const runs = new ScheduleRunStore({ home: home.path });
	const short = await pendingRun(runs, 1, "p10b-short", "posted before the crash");
	// The headline is capped at 4,000 characters; the card's facts line pushes the delivered text past the threshold.
	const long = await pendingRun(runs, 2, "p10b-long", `token ${ghShaped} here\n\n${"x".repeat(3940)}`);
	const refused = await pendingRun(runs, 3, "p10b-refuse", `${keyHeader}\nMIIE`);
	mkdirSync(dirname(live), { recursive: true });
	writeFileSync(live, LEGACY);
	initPush({ dataDir: join(home.path, LAYOUT.data), origin: "https://cp.example.test" });
	const ask = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "A or B?", options: [{ label: "a", consequence: "b" }], recommendation: "a" });

	const provider = await MockProvider.start();
	const model = provider.addScript("p10b-parent", [text("checked")]);
	const agent = createAgentDir({ provider });
	const parent = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path, ...VIEWER_ENV }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await parent.close(); agent.cleanup(); await provider.stop(); });
	await parent.prompt("inspect startup");
	await parent.waitForSettled(60_000);
	const result = (id: string) => runs.run(id)!.result!;
	await waitFor(() => Boolean(result(long.run_id).delivered_at && result(refused.run_id).error), Boolean, { timeoutMs: 15_000, what: "schedule result sync" });
	const pushed = await waitFor(() => new PushDeliveryStore(stateDir).read(), Boolean, { timeoutMs: 20_000, what: "push sweep baseline" });

	assert.deepEqual([existsSync(live), readFileSync(archive, "utf8")], [false, LEGACY], "startup migrated the journal and renamed it");
	assert.deepEqual(MIGRATED.map((p) => readResponseReport(home.path, p.source)?.payload), MIGRATED);
	assert.deepEqual([Boolean(result(short.run_id).delivered_at), result(short.run_id).report_href], [true, undefined], "a short card stays inline");
	const slug = responseReportSlug("schedule:p10b-long");
	assert.equal(result(long.run_id).report_href, `/boards/${slug}/`);
	const content = readFileSync(join(stateDir, "boards", slug, "site", "content.json"), "utf8");
	assert.ok(content.includes("token") && !content.includes(ghShaped), "the long card is a redacted report");
	assert.match(result(refused.run_id).error!, /private key block/);
	assert.equal(result(refused.run_id).delivered_at, null);
	assert.equal(existsSync(join(stateDir, "boards", responseReportSlug("schedule:p10b-refuse"))), false, "a refused card publishes nothing");
	assert.deepEqual(boardsOf(home.path).length, 3, "two legacy reports and the long card");
	assert.deepEqual(pushed!.items.map((item) => item.id), [ask.id], "the push sweep baselines the open ask only, never an answer");
	assert.equal("answers" in await decisionsPage(), false, "M2 PR3: the Decisions page carries no answers list");
});
