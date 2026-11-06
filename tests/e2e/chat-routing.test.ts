/** cp-chat-cleanup: sends, asks and jobs after the thread/origin removal, via viewer HTTP, the dashboard-control owner,
 * the operator's pi (cp-bridge, fake parent) and a command-post pi parent (mock provider). */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { LAYOUT } from "../../src/contracts.ts";
import { initJobsDocument, Ledger, readJobsDocument } from "../../src/ledger.ts";
import { attachParentHost } from "../../src/parent-host.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { controlInboxFile, controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { type Json, jsonl, lines, viewer, write } from "../harness/conversations.ts";
import { operatorSession } from "../harness/dashboard.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, type ScriptStep, startPiChild, waitFor } from "../harness/index.ts";

const FAKE_PARENT = join(import.meta.dirname, "..", "fixtures", "fake-parent.mjs");
const MESSAGE = "/api/operator/message";
const DC = "dc-20261104140000-0000000a", PS = "ps-20261104150000-0000000b";
const RETIRED_ORIGIN = { source_send_id: DC, thread_id: "th-00000000000000a1" };
const OLD_ASK = { type: "open", id: "ask-0123456789ab", project: "picp", question: "Old?", options: [{ label: "Yes", consequence: "Goes" }],
	recommendation: "Yes", created_at: "2026-11-01T00:00:00Z", source: { send_id: DC, thread_id: "th-00000000000000a1" } };
const ask = (question: string) => ({ project: "picp", question, options: [{ label: "Yes", consequence: "Goes ahead" }], recommendation: "Yes" });

/** A ledger holding one job whose record still carries the retired `origin`, written as an older picp left it. */
async function seedOldJob(home: string, project: string): Promise<string> {
	initJobsDocument(home, "cp");
	const ledger = new Ledger({ home });
	const job = await ledger.create({ title: "old tagged job", project, delivery: "pr", kind: "ship" });
	const doc = JSON.parse(readFileSync(ledger.file, "utf8")) as { jobs: Json[] };
	doc.jobs.find((row) => row.id === job.id)!.origin = RETIRED_ORIGIN;
	writeFileSync(ledger.file, JSON.stringify(doc));
	return job.id;
}

const toolResult = (child: ReturnType<typeof startPiChild>, id: string) =>
	JSON.stringify(child.eventsOfType("tool_execution_end").find((row) => row.toolCallId === id) ?? null);

// Scenario: thread routes and owner ops are gone; a send carrying a retired field is refused before anything is
// journaled; an offline-held line and a queued journal request, both with retired thread keys, and plain sends are
// still delivered beside a corrupt registry.
test("chat-routing: removed thread routes and ops refuse; plain and offline-held sends deliver beside a corrupt registry", { timeout: 120_000 }, async (t) => {
	const QUEUED = "dc-20261104120000-00000002";
	const d = await viewer(t, { seed: (stateDir) => {
		write(join(stateDir, "operator", "named-threads.jsonl"), "{not json\n");
		write(join(stateDir, "operator", "asks.jsonl"), jsonl([OLD_ASK]));
		write(controlInboxFile(stateDir), jsonl([{ type: "held", id: "dc-20261104130000-00000001", at: new Date().toISOString(), text: "typed offline",
			ask_id: null, thread: "ops", thread_id: "th-00000000000000a1" }]));
		const at = new Date(Date.now() - 60_000).toISOString();
		write(controlJournalFile(stateDir), jsonl([
			{ type: "request", by: "bridge", id: QUEUED, at, peer: null, kind: "message", text: "queued before restart", ask_id: null, deliver: "prompt",
				thread: "ops", thread_id: "th-00000000000000a1" },
			{ type: "outcome", by: "bridge", id: QUEUED, at, kind: "message", state: "queued" },
		]));
	} });
	let idle = true;
	const { injected, control } = await operatorSession(t, d.stateDir, () => idle);
	const record = (readControlRecord(d.stateDir) as { record: Parameters<typeof controlRequest>[0] & { csrf: string } }).record;
	// The stub session shows each handoff in its transcript, as pi would; an unseen one is re-handed.
	const seen = () => control.observe({ role: "user", content: [{ type: "text", text: injected.at(-1)![0] }] });
	await waitFor(() => injected.length, (n) => n >= 1, { timeoutMs: 10_000, what: "the first reloaded turn" });
	seen();
	control.settled();
	await waitFor(() => injected.length, (n) => n >= 2, { timeoutMs: 10_000, what: "the second reloaded turn" });
	seen();
	control.settled();
	const reloaded = injected.slice(0, 2).map(([text]) => text);
	assert.ok(reloaded.some((text) => text.includes("(dc-20261104130000-00000001): typed offline")), "the offline inbox line is replayed");
	assert.ok(reloaded.some((text) => text.startsWith("queued before restart\n\n")), "the queued journal request is delivered");
	assert.ok(reloaded.some((text) => text.includes(`[cp-dashboard ${QUEUED} — from the dashboard]`)), "the reloaded request keeps its id");
	assert.equal(reloaded.some((text) => /thread/.test(text)), false, "retired thread keys reach no marker or text");

	assert.equal((await d.send("/api/threads")).status, 404, "GET /api/threads is an unknown route");
	assert.equal((await d.send("/api/operator/threads", d.json(record.csrf, { op: "create", client_id: DC, name: "Alpha" }))).status, 405, "no thread write route");
	for (const op of ["thread_create", "thread_rename"]) {
		const reply = await controlRequest(record, op, { client_id: DC, name: "Alpha" });
		assert.deepEqual([reply.ok, !reply.ok && reply.error], [false, `unknown op ${op}`], `${op} is an unknown owner op`);
	}

	for (const retired of [{ thread_id: "th-00000000000000a1" }, { thread_id: null }, { thread: "ops" }]) {
		const refused = await d.send(MESSAGE, d.json(record.csrf, { kind: "message", text: "RETIRED-FIELD", ...retired }));
		assert.deepEqual([refused.status, refused.body.error], [400, `unknown field ${Object.keys(retired)[0]}`], JSON.stringify(retired));
	}
	const plain = await d.send(MESSAGE, d.json(record.csrf, { kind: "message", text: "PLAIN-SEND" }));
	assert.equal(plain.status, 202, JSON.stringify(plain.body));
	await waitFor(() => injected.length, (n) => n >= 3, { timeoutMs: 10_000, what: "the plain send" });
	assert.match(injected[2]![0], /^PLAIN-SEND\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard\]$/);
	control.settled();

	// Busy: the send is held, its queue edit applies, and an answer click delivers first once the session idles.
	idle = false;
	const held = await d.send(MESSAGE, d.json(record.csrf, { kind: "message", text: "BUSY-DRAFT" }));
	assert.equal(held.status, 202, JSON.stringify(held.body));
	const edit = await controlRequest(record, "queue_edit", { id: held.body.id, text: "BUSY-EDITED" });
	assert.ok(edit.ok, JSON.stringify(edit));
	const click = await d.send(MESSAGE, d.json(record.csrf, { kind: "answer", ask_id: "ask-0123456789ab", label: "Yes" }));
	assert.equal(click.status, 202, JSON.stringify(click.body));
	idle = true;
	control.settled();
	await waitFor(() => injected.length, (n) => n >= 4, { timeoutMs: 10_000, what: "the answer click" });
	control.settled();
	await waitFor(() => injected.length, (n) => n >= 5, { timeoutMs: 10_000, what: "the edited send" });
	assert.deepEqual(injected.slice(3, 5).map(([text]) => text.split("\n\n[cp-dashboard")[0]), ["ask-0123456789ab: Yes", "BUSY-EDITED"]);
	assert.match(injected[3]![0], /; ask=ask-0123456789ab\]$/, "the click's marker keeps its ask id, nothing about threads");

	const requests = lines(controlJournalFile(d.stateDir)).filter((line) => line.type === "request" && line.id !== QUEUED);
	assert.deepEqual(requests.map((line) => "thread_id" in line || "thread" in line), [false, false, false], "a refused send journals no request");
	assert.equal(injected.some(([text]) => text.includes("RETIRED-FIELD")), false, "a refused send is never injected");
});

// Scenario: an operator session with old asks, outbox entries and jobs carrying retired fields keeps working: a plain
// relay keeps its delegation and gets no origin, a stale source_send_id is ignored, the old ask answers, jobs list, and
// a corrupt non-retired field still refuses; the parent host knows no sendFrom op.
test("chat-routing: old asks, sends and jobs read through cp_parent; new ones carry no source or origin", { timeout: 180_000 }, async (t: TestContext) => {
	const home = createScratchHome();
	const stateDir = join(home.path, LAYOUT.state);
	const asksFile = join(stateDir, "operator", "asks.jsonl");
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	writeFileSync(asksFile, `${JSON.stringify(OLD_ASK)}\n`);
	const oldJob = await seedOldJob(home.path, "picp");
	const outboxFile = parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl"));
	const outbox = () => new ParentSendOutbox({ file: outboxFile });
	const old = outbox().enqueue("OLD-RELAY");
	const raw = JSON.parse(readFileSync(outboxFile, "utf8")) as { entries: Json[] };
	raw.entries[0]!.origin = RETIRED_ORIGIN;
	writeFileSync(outboxFile, JSON.stringify(raw));

	const provider = await MockProvider.start();
	const model = provider.addScript("chat-routing-operator", [
		{ kind: "tool_calls", calls: [{ id: "start", name: "cp_parent", args: { action: "start", home: home.path } }] },
		{ kind: "text", text: "started" },
		{ kind: "tool_calls", calls: [
			{ id: "send", name: "cp_parent", args: { action: "send", text: "PLAIN-RELAY", delegated: true, delegation_rule: "standing order 3", source_send_id: DC } },
			{ id: "ask", name: "cp_parent", args: { action: "ask", ask: ask("New?"), source_send_id: DC } },
			{ id: "answer", name: "cp_parent", args: { action: "ask_answer", id: OLD_ASK.id, answer: "Yes" } },
			{ id: "jobs", name: "cp_parent", args: { action: "jobs", jobs: { mode: "list" } } },
		] },
		{ kind: "text", text: "relayed" },
		{ kind: "tool_calls", calls: [{ id: "corrupt", name: "cp_parent", args: { action: "ask", ask: ask("After corrupt?") } }] },
		{ kind: "text", text: "refused" },
	]);
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	const child = startPiChild({ cwd: home.path, model, sessionDir: join(stateDir, "sessions", "operator"), extensions: [CP_BRIDGE_EXTENSION],
		env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi", CP_PARENT_PI_BIN: FAKE_PARENT } });
	const closers: Array<() => unknown> = [];
	t.after(() => teardownHome(home, ...closers.reverse(), () => child.close(), () => agent.cleanup(), () => provider.stop()));
	const settled = (n: number) => child.waitFor(() => child.eventsOfType("agent_settled").length >= n, 60_000);
	const result = (id: string) => toolResult(child, id);

	await child.prompt(`Start the parent under ${home.path}.`);
	await settled(1);
	assert.match(result("start"), /started (clean|resumed) pid=/);
	await child.prompt("Relay, ask and read.");
	await settled(2);
	assert.match(result("send"), /receipt: /, "a stale source_send_id is ignored, never a refusal");
	const entries = await waitFor(() => outbox().list(), (rows) => rows.some((row) => row.text === "PLAIN-RELAY"), { timeoutMs: 30_000, what: "the relay enqueued" });
	assert.deepEqual(entries.map((row) => [row.text, "origin" in row]), [["OLD-RELAY", false], ["PLAIN-RELAY", false]], "the old entry survives, no origin on either");
	assert.equal(entries[0]!.id, old.id);
	const relay = entries.find((row) => row.text === "PLAIN-RELAY")!;
	assert.deepEqual([relay.delegated, relay.delegation_rule], [true, "standing order 3"], "delegation rides the ordinary send unchanged");
	assert.doesNotMatch(readFileSync(outboxFile, "utf8"), /"origin"/, "the rewritten outbox carries no origin");

	assert.match(result("answer"), /ask-0123456789ab recorded/, "the old ask with a retired source answers");
	assert.equal(readFileSync(asksFile, "utf8").includes(`"type":"answer","id":"${OLD_ASK.id}"`), true, "its answer is journaled");
	const askLines = readFileSync(asksFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
	const opened = askLines.find((line) => line.type === "open" && line.question === "New?");
	assert.ok(opened && !("source" in opened), `a new ask carries no source: ${JSON.stringify(opened)}`);
	assert.match(result("jobs"), new RegExp(oldJob), "the job with a retired origin still lists");

	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 30_000 });
	closers.push(() => host.disconnect());
	await assert.rejects(host.request("sendFrom", "x", undefined, {}, RETIRED_ORIGIN), /unknown parent host op sendFrom/);

	// Negative control: only the retired field is ignored; any other unknown field still refuses the journal.
	appendFileSync(asksFile, `${JSON.stringify({ ...OLD_ASK, id: "ask-0123456789ac", bogus: true })}\n`);
	await child.prompt("Ask again.");
	await settled(3);
	assert.match(result("corrupt"), /bogus|must NOT have additional properties|unexpected property/i, "an unknown non-retired field still refuses");
	assert.equal(readFileSync(asksFile, "utf8").includes("After corrupt?"), false, "nothing appended to a refused journal");
});

// Scenario: parent intake on a ledger with a retired job origin: cp_job create, cp_pipeline start and cp_ask create
// their jobs, the removed source_send_id param is refused with nothing created, and no job carries an origin.
test("chat-routing: cp_job create, cp_pipeline start and cp_ask create jobs without origins on a ledger with a retired one", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	await new ProjectRegistry({ home: home.path }).register({ name: "picp", clone_url: "https://example.invalid/picp.git" });
	const oldJob = await seedOldJob(home.path, "picp");
	const provider = await MockProvider.start();
	const model = provider.addScript("chat-routing-parent", [
		{ kind: "tool_calls", calls: [
			{ id: "stale", name: "cp_job", args: { action: "create", project: "picp", title: "stale job", delivery: "pr", kind: "ship", source_send_id: PS } },
			{ id: "stale-pipeline", name: "cp_pipeline", args: { action: "start", project: "picp", title: "stale piped", task: "plan", source_send_id: PS } },
			{ id: "stale-ask", name: "cp_ask", args: { project: "picp", question: "Stale ask?", source_send_id: PS } },
			{ id: "job", name: "cp_job", args: { action: "create", project: "picp", title: "plain job", delivery: "pr", kind: "ship" } },
			{ id: "pipeline", name: "cp_pipeline", args: { action: "start", project: "picp", title: "piped", task: "plan piped" } },
			{ id: "ask", name: "cp_ask", args: { project: "picp", question: "Ship it?" } },
		] },
		{ kind: "text", text: "handled" },
	] satisfies ScriptStep[]);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, sessionDir: join(home.path, "parent-sessions"), extensions: [COMMAND_POST_EXTENSION],
		env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" } });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("Take the requests.");
	await child.waitFor(() => child.eventsOfType("agent_settled").length >= 1, 120_000);

	assert.match(toolResult(child, "stale"), /source_send_id[\s\S]*must not have additional properties/, "cp_job's closed schema refuses it");
	// cp_pipeline and cp_ask schemas are open: a stale source_send_id is ignored, never resolved into an origin.
	for (const id of ["stale-pipeline", "stale-ask"]) {
		const reply = toolResult(child, id);
		assert.ok(/must not have additional properties/.test(reply) || !/source_send_id|origin/.test(reply), `${id}: ${reply}`);
	}
	assert.match(toolResult(child, "job"), /created cp-/, `cp_job create: ${toolResult(child, "job")}`);
	const jobs = readJobsDocument(home.path).jobs;
	const titles = jobs.map((job) => job.title);
	for (const title of ["old tagged job", "plain job", "Ship it?"]) assert.ok(titles.includes(title), `${title} in ${titles.join(", ")}`);
	assert.equal(titles.includes("stale job"), false, "the refused create made nothing");
	assert.ok(titles.some((title) => /: piped$|^piped$/.test(title)), `cp_pipeline start created its jobs: ${titles.join(", ")}`);
	assert.ok(jobs.some((job) => job.id === oldJob), "the old job survives the rewrite");
	assert.doesNotMatch(readFileSync(new Ledger({ home: home.path }).file, "utf8"), /"origin"/, "no job carries an origin");
});
