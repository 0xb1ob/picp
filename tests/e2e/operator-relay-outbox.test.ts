/**
 * P9b, behavior 11: the parent→operator relay outbox seen through its real consumers: a detached parent host
 * (fake or mock-provider parent), real `pi --mode rpc` operator sessions with the cp-bridge extension, and the
 * cp-health entry point. Files are read at their documented paths under the home's runtime dir.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { isoTimestamp, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore, raiseForGate } from "../../src/escalation.ts";
import { EscalationRelayLedger, escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { OPERATOR_ASK_LIST, OPERATOR_DECIDE_LIST, OPERATOR_NOTE, OPERATOR_NOTE_MAX_LINES, OPERATOR_REMOTE_DEVICE_RULE } from "../../src/operator-note.ts";
import { OperatorRelayOutbox } from "../../src/operator-outbox.ts";
import { attachParentHost, currentHost, parentHostPaths, type ParentHostClient } from "../../src/parent-host.ts";
import {
	CP_BRIDGE_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchLedger,
	MockProvider,
	type PiChild,
	REPO_ROOT,
	type ScratchHome,
	startPiChild,
	waitFor,
} from "../harness/index.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "..", "fixtures", "fake-parent.mjs");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const receipt = { level: null, reached: [] };

interface Entry { id: string; queued_at: string; producer: string; relay: { kind: string; text: string } }
interface AckRow { type: string; id?: string; owner?: string; at?: string }

/** The documented relay files (docs/storage.md) and readers that never go through the product's own parser. */
function relayFiles(home: ScratchHome) {
	const dir = join(home.path, ".pi-command-post/state/operator");
	const outbox = join(dir, "relay-outbox.json");
	const acks = join(dir, "relay-acks.jsonl");
	return {
		dir, outbox, acks,
		entries: (): Entry[] => existsSync(outbox) ? (JSON.parse(readFileSync(outbox, "utf8")) as { entries: Entry[] }).entries : [],
		rows: (): AckRow[] => existsSync(acks) ? readFileSync(acks, "utf8").split("\n").flatMap((line) => {
			try { return [JSON.parse(line) as AckRow]; } catch { return []; }
		}) : [],
	};
}

/** Sets env for the hosts this process spawns; returns the restore step. */
function withEnv(env: Record<string, string | undefined>): () => void {
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	return () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const bodies = (provider: MockProvider, script: string) => provider.requests(script).map((request) => JSON.stringify(request.body.messages));

test("P9-relay-crash: a wake queued while no operator listens survives a host SIGKILL and enters one session once", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "p9-crash-operator";
	const model = provider.addScript(script, [{ kind: "text", text: "Relay seen." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const WAKE = "P9 wake while nobody listened";
	const restore = withEnv({ ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi",
		FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: "cp-gone", FAKE_PARENT_WAKE_TEXT: WAKE });
	const operators: PiChild[] = [];
	t.after(() => teardownHome(home, async () => { for (const child of operators) await child.close(); }, () => agent.cleanup(), () => provider.stop(), restore));
	const files = relayFiles(home);
	const paths = parentHostPaths(home.path, "multi");

	const first = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await first.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	const queued = await waitFor(() => files.entries().filter((entry) => entry.relay.text.includes(WAKE)), (items) => items.length === 1,
		{ timeoutMs: 30_000, what: "the wake on disk with no operator attached" });
	const id = queued[0]!.id;
	assert.match(id, /^wake:[0-9a-f-]{36}$/, "a wake gets its own uuid id");
	const generation = currentHost(paths).gen;
	first.disconnect();
	process.kill(first.hostPid, "SIGKILL");
	await waitFor(() => isPidAlive(first.hostPid), (alive) => !alive, { timeoutMs: 15_000, what: "host 1 dead" });
	delete process.env.FAKE_PARENT_WAKE; // the next host must not wake again; `restore` still runs at teardown
	const second = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	assert.equal(currentHost(paths).gen, generation + 1);
	second.disconnect();

	const operator = (name: string) => {
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
			extensions: [CP_BRIDGE_EXTENSION], sessionDir: join(home.path, name) });
		operators.push(child);
		return child;
	};
	assert.equal(existsSync(files.acks), false, "no operator has written the journal yet");
	const a = operator("operator-a");
	await waitFor(() => files.rows(), (rows) => rows.some((row) => row.type === "ack" && row.id === id), { timeoutMs: 45_000, what: "the wake acked in context" });
	await a.waitForSettled(30_000);
	await sleep(1_000);
	const carried = bodies(provider, script).filter((body) => body.includes(WAKE));
	assert.ok(carried.length >= 1, "the wake reached the operator model");
	assert.equal(occurrences(carried.at(-1)!, WAKE), 1, "exactly once in context");
	assert.equal(files.rows().filter((row) => row.type === "emit" && row.id === id).length, 1, "handed off once");
	await a.close();

	// A torn tail and an oversized journal: the next session skips the torn line and compacts the rest.
	const bulk = Array.from({ length: 6_000 }, (_, index) => JSON.stringify({ type: "ack", id: `gone-${index}-${"x".repeat(60)}`, at: new Date().toISOString() }));
	appendFileSync(files.acks, `{"type":"ack","id":"tor\n${bulk.join("\n")}\n`);
	const requestsBefore = provider.requests(script).length;
	const b = operator("operator-b");
	await b.prompt("Anything new from the parent?");
	await b.waitForSettled(30_000);
	await sleep(1_000);
	assert.equal(provider.requests(script).slice(requestsBefore).some((request) => JSON.stringify(request.body.messages).includes(WAKE)), false,
		"acked: a new session never sees it again");
	const rows = files.rows();
	assert.ok(readFileSync(files.acks, "utf8").length < 512 * 1024, "the oversized journal was compacted at session start");
	assert.deepEqual(rows.filter((row) => row.type === "ack").map((row) => row.id), [id], "compaction keeps acks only for ids still in the outbox");
	assert.equal(rows.filter((row) => row.type === "consumer").length, 1, "and the newest consumer line");
});

test("P9-relay-ledger: a code-raised escalation is relayed once, and the consumer's ledger stops a re-relay after prune", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "p9-ledger-operator";
	const model = provider.addScript(script, [{ kind: "text", text: "Escalation seen." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const restore = withEnv({ ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_HOST_ESCALATION_TICK_SECONDS: "1" });
	const hosts: ParentHostClient[] = [];
	let operator: PiChild | undefined;
	t.after(() => teardownHome(home, () => operator?.close(), async () => { for (const host of hosts) host.disconnect(); },
		() => agent.cleanup(), () => provider.stop(), restore));
	const files = relayFiles(home);
	const store = new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 60_000) });
	const gate = (job: string) => raiseForGate(store, {
		schema_version: SCHEMA_VERSION, job_id: job, attempt: 1, verdict: "escalate", cause: "policy",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["conflicting acceptance"], revisions: [], model: "mock/one", decided_at: new Date().toISOString(),
	})!;
	const raised = await gate("cp-gjva");
	const escId = `esc:${raised.id}`;
	const begin = Date.now();
	hosts.push(await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 }));
	await waitFor(files.entries, (items) => items.some((entry) => entry.id === escId), { timeoutMs: 40_000, what: "the escalation in the relay outbox" });
	assert.ok(Date.now() - begin < 40_000, `relayed in ${Date.now() - begin} ms`);
	assert.equal(files.entries().filter((entry) => entry.id.startsWith(escId)).length, 1, "one esc:<id> entry");
	assert.match(files.entries().find((entry) => entry.id === escId)!.relay.text, new RegExp(`${raised.id} \\(conflicting_acceptance\\)`));

	operator = startPiChild({ cwd: home.path, model, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
		extensions: [CP_BRIDGE_EXTENSION], sessionDir: join(home.path, "operator") });
	await waitFor(files.rows, (rows) => rows.some((row) => row.type === "ack" && row.id === escId), { timeoutMs: 45_000, what: "the escalation acked in context" });
	await waitFor(() => bodies(provider, script), (items) => items.some((body) => body.includes(raised.id)), { timeoutMs: 30_000, what: "the escalation reached the operator model" });
	const ledger = new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi"));
	assert.ok(ledger.ids().has(raised.id), "the consumer noted the delivery in the escalation-relay ledger");
	await operator.waitForSettled(30_000);
	await operator.close();
	await hosts[0]!.request("stop").catch(() => undefined);
	await hosts[0]!.closed;

	// The state a day later: the host pruned the closed entry and an operator's compaction dropped its ack line,
	// so only the ledger still knows. 205 acked fillers past the 24 h TTL: the host keeps only the newest 200.
	const old = Date.now() - 50 * 3_600_000;
	const seeded = JSON.parse(readFileSync(files.outbox, "utf8")) as { entries: Entry[] };
	seeded.entries = seeded.entries.filter((entry) => entry.id !== escId);
	for (let index = 0; index < 205; index++) {
		seeded.entries.push({ id: `wake:filler-${index}`, queued_at: isoTimestamp(new Date(old)), producer: "p9-seed",
			relay: { kind: "wake", stale: false, text: `filler ${index}`, receipt, paths: [] } as Entry["relay"] });
	}
	writeFileSync(files.outbox, JSON.stringify(seeded));
	writeFileSync(files.acks, [...files.rows().filter((row) => row.id !== escId),
		...seeded.entries.map((entry, index) => ({ type: "ack", id: entry.id, at: new Date(old + 3_600_000 + index * 1_000).toISOString() }))]
		.map((row) => `${JSON.stringify(row)}\n`).join(""));
	const pending = await gate("cp-other");
	hosts.push(await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 }));
	await waitFor(() => files.entries().some((entry) => entry.id === `esc:${pending.id}`), Boolean, { timeoutMs: 40_000, what: "a fresh host relays the new escalation" });
	await sleep(3_000); // three escalation ticks of a host with fresh memory
	const left = files.entries().map((entry) => entry.id);
	assert.equal(left.some((entry) => entry.startsWith(escId)), false, "the ledger stops a re-enqueue of the pruned escalation");
	assert.equal(left.filter((entry) => entry.startsWith("wake:filler-")).length, 200, "the newest 200 closed entries stay past the TTL");
	assert.equal(left.includes("wake:filler-0"), false, "the oldest closed went first");
	assert.ok(left.includes("wake:filler-204"));
	assert.ok(left.includes(`esc:${pending.id}`), "a pending entry is never pruned");
});

test("P9-relay-refresh: a re-raised escalation replaces its pending text, and after an ack only new text relays again", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const ledger = createScratchLedger({ home: home.path, knownProjects: ["demo"] }).ledger;
	const job = await ledger.create({ title: "Refresh probe", project: "demo", kind: "research", delivery: "answer" });
	const question = (usd: number) => `Spend ${usd} more USD on the refresh probe?`;
	const raise = (usd: number) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_escalate", args: { job_ids: [job.id], kind: "product_ambiguity",
		question: question(usd), mandate_id: "md-p9refresh", options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }],
		recommended: "hold", evidence_paths: [] } }] });
	// The first turn answers 1.5 s late, so the 100 ms send below always outlives its request.
	const parentModel = provider.addScript("p9-refresh-parent", [raise(5), { kind: "hang", ms: 1_500 }, raise(7), { kind: "text", text: "Raised." },
		raise(9), { kind: "text", text: "Raised." }, raise(9), { kind: "text", text: "Raised." }], { onExhausted: "repeat" });
	const script = "p9-refresh-operator";
	const operatorModel = provider.addScript(script, [{ kind: "text", text: "Escalation seen." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const restore = withEnv({ ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" });
	const hosts: ParentHostClient[] = [];
	let operator: PiChild | undefined;
	t.after(() => teardownHome(home, () => operator?.close(), async () => { for (const host of hosts) host.disconnect(); },
		() => agent.cleanup(), () => provider.stop(), restore));
	const files = relayFiles(home);
	const startHost = async () => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
		hosts.push(host);
		await host.request("start", { home: home.path, mode: "multi", model: parentModel, modelExplicit: true, requestTimeoutMs: 15_000 });
		return host;
	};
	const family = () => files.entries().filter((entry) => entry.id.startsWith("esc:"));
	const host = await startHost();
	// A send that outlives its 100 ms request leaves its outcome to the outbox, under one `send:<ps-id>` id.
	const sent = await host.request("send", "Raise the spend question.", 100) as { send_id?: string };
	assert.match(sent.send_id ?? "", /^ps-/);
	const [v1] = await waitFor(family, (items) => items.length === 1, { timeoutMs: 20_000, what: "the first escalation relay" });
	assert.match(v1!.id, /^esc:es-[a-z0-9]+$/);
	assert.ok(v1!.relay.text.includes(question(5)));
	await waitFor(() => files.entries().filter((entry) => entry.id === `send:${sent.send_id}`).length, (count) => count === 1,
		{ timeoutMs: 20_000, what: "the send outcome under its stable id" });
	await sleep(1_100);
	await host.request("send", "Raise it again with fresh numbers.");
	await waitFor(family, (items) => items[0]?.relay.text.includes(question(7)) === true, { timeoutMs: 20_000, what: "the pending entry refreshed" });
	assert.equal(family().length, 1, "a pending entry is replaced in place");
	assert.equal(family()[0]!.queued_at, v1!.queued_at, "queued_at kept");

	operator = startPiChild({ cwd: home.path, model: operatorModel, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
		extensions: [CP_BRIDGE_EXTENSION], sessionDir: join(home.path, "operator") });
	await waitFor(files.rows, (rows) => rows.some((row) => row.type === "ack" && row.id === v1!.id), { timeoutMs: 45_000, what: "the refreshed escalation acked" });
	await waitFor(() => bodies(provider, script), (items) => items.some((body) => body.includes(question(7))), { timeoutMs: 30_000, what: "the refreshed text reached the operator" });
	assert.equal(bodies(provider, script).some((body) => body.includes(question(5))), false, "the stale text never reached the operator");
	await host.request("send", "Raise it once more.");
	await waitFor(family, (items) => items.length === 2, { timeoutMs: 20_000, what: "new text after the ack mints a new id" });
	assert.equal(family()[1]!.id, `${v1!.id}#2`);
	assert.ok(family()[1]!.relay.text.includes(question(9)));
	await waitFor(files.rows, (rows) => rows.some((row) => row.type === "ack" && row.id === `${v1!.id}#2`), { timeoutMs: 45_000, what: "the refreshed question delivered again" });

	// A restarted bridge forgets what it relayed; the outbox still turns the same text into a no-op.
	await host.request("stop").catch(() => undefined);
	await host.closed;
	const again = await startHost();
	await again.request("send", "Raise the same question after the restart.");
	await sleep(3_000);
	assert.deepEqual(family().map((entry) => entry.id), [v1!.id, `${v1!.id}#2`], "same text after the ack: nothing new");
	assert.equal(provider.remaining("p9-refresh-parent"), 0, "the parent re-raised after the restart");
});

test("P9-relay-scope: a scheduled-only wake never reaches the outbox; its escalation and a mixed turn do, envelope verbatim", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const ledger = createScratchLedger({ home: home.path, knownProjects: ["demo"] }).ledger;
	const scheduled = (await ledger.create({ title: "Weather", project: "demo", kind: "research", delivery: "answer", labels: ["schedule:sch-aaaaaa"] })).id;
	const plain = (await ledger.create({ title: "Other", project: "demo", kind: "research", delivery: "answer" })).id;
	const restore = withEnv({ PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_HOST_ESCALATION_TICK_SECONDS: "1",
		FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: scheduled, FAKE_PARENT_WAKE_TEXT: "P9 scheduled-only wake", FAKE_PARENT_WAKE_ENVELOPE: undefined });
	const hosts: ParentHostClient[] = [];
	t.after(() => teardownHome(home, async () => { for (const host of hosts) host.disconnect(); }, restore));
	const files = relayFiles(home);
	const startHost = async () => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
		hosts.push(host);
		await host.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
		return host;
	};
	const store = new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 60_000) });
	const first = await startHost();
	const raised = (await raiseForGate(store, {
		schema_version: SCHEMA_VERSION, job_id: scheduled, attempt: 1, verdict: "escalate", cause: "policy",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["conflicting acceptance"], revisions: [], model: "mock/one", decided_at: new Date().toISOString(),
	}))!;
	await waitFor(() => files.entries().some((entry) => entry.id === `esc:${raised.id}`), Boolean,
		{ timeoutMs: 40_000, what: "the scheduled job's escalation relayed" });
	assert.equal(files.entries().some((entry) => entry.relay.text.includes("P9 scheduled-only wake")), false, "a scheduled-only wake is dropped");

	await first.request("stop").catch(() => undefined);
	await first.closed;
	process.env.FAKE_PARENT_WAKE_TEXT = "P9 mixed wake";
	// One turn carries an earlier envelope, a rejected one, a foreign message, a bad id and a blank summary:
	// only the last accepted, well-formed envelope per job rides on the relay.
	process.env.FAKE_PARENT_WAKE_ENVELOPE = JSON.stringify([
		{ job_id: plain, status: "done", summary: "first report" },
		{ job_id: "cp-rejected", status: "failed", summary: "rejected report", accepted: false },
		{ job_id: "cp-foreign", status: "done", summary: "recovery text", customType: "cp-recovery" },
		{ job_id: "../bad id", status: "done", summary: "bad id report" },
		{ job_id: scheduled, status: "done", summary: "  " },
		{ job_id: plain, status: "done", summary: "npm, Node v24" },
	]);
	await startHost();
	const [mixed] = await waitFor(() => files.entries().filter((entry) => entry.relay.text.includes("P9 mixed wake")), (items) => items.length === 1,
		{ timeoutMs: 30_000, what: "the mixed wake relayed" });
	assert.ok(mixed!.relay.text.endsWith(`\n\nenvelope ${plain} (done), verbatim: npm, Node v24`), mixed!.relay.text);
	assert.equal(mixed!.relay.text.split("verbatim:").length, 2, "one envelope line: the last accepted, well-formed one");
	for (const dropped of ["first report", "rejected report", "recovery text", "bad id report"]) {
		assert.equal(mixed!.relay.text.includes(dropped), false, `${dropped} never rides on the relay`);
	}
	// The same wake again: a wake has no stable id, so the second one is a new entry under a fresh uuid.
	await hosts.at(-1)!.request("stop").catch(() => undefined);
	await hosts.at(-1)!.closed;
	await startHost();
	const twice = await waitFor(() => files.entries().filter((entry) => entry.relay.text.includes("P9 mixed wake")),
		(items) => items.length === 2,
		{ timeoutMs: 30_000, what: "the second mixed wake relayed" });
	assert.match(twice[1]!.id, /^wake:[0-9a-f-]{36}$/);
	assert.notEqual(twice[0]!.id, twice[1]!.id, "two wakes, two ids");
});

test("P9-relay-lost-write: a relay the outbox could not hold still reaches a real operator, id-less, in memory", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "p9-lost-operator";
	const model = provider.addScript(script, [{ kind: "text", text: "Relay seen." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const WAKE = "P9 wake the outbox could not hold";
	const restore = withEnv({ ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_TEXT: WAKE });
	let operator: PiChild | undefined;
	let host: ParentHostClient | undefined;
	t.after(() => teardownHome(home, () => operator?.close(), () => host?.disconnect(), () => agent.cleanup(), () => provider.stop(), restore));
	const files = relayFiles(home);
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.outbox, "{not json");
	const paths = parentHostPaths(home.path, "multi");
	host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await host.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	const log = () => { try { return readFileSync(paths.log, "utf8"); } catch { return ""; } };
	await waitFor(log, (text) => text.includes("relay outbox write failed"), { timeoutMs: 30_000, what: "the failed outbox write is logged" });
	assert.ok(log().includes(`${files.outbox} is not valid JSON`), "the corrupt outbox is named by its path");
	host.disconnect();
	host = undefined;
	operator = startPiChild({ cwd: home.path, model, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
		extensions: [CP_BRIDGE_EXTENSION], sessionDir: join(home.path, "operator") });
	await waitFor(() => bodies(provider, script), (items) => items.some((body) => body.includes(WAKE)), { timeoutMs: 45_000, what: "the lost relay delivered in memory" });
	await operator.waitForSettled(30_000);
	const acked = files.rows().filter((row) => row.type === "ack").map((row) => row.id);
	assert.ok(acked.some((id) => id?.startsWith("wake:")), "delivered under a consumer-minted id and acked");
	assert.equal(readFileSync(files.outbox, "utf8"), "{not json", "the outbox is never rewritten by the operator");
});

test("P9-relay-health: cp-health reports the oldest unseen relay, skips torn ack lines and names an unreadable outbox", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const agent = createAgentDir();
	t.after(() => { agent.cleanup(); home.cleanup(); });
	const files = relayFiles(home);
	const health = () => {
		execFileSync(process.execPath, [join(REPO_ROOT, "src/service/health.ts")], { env: { ...process.env, ...agent.env, CP_HOME: home.path }, stdio: "pipe" });
		return (JSON.parse(readFileSync(join(home.path, ".pi-command-post/state/health.json"), "utf8")) as { checks: Record<string, { status: string; key?: string; detail?: string }> }).checks.relay!;
	};
	const at = (minutesAgo: number) => new OperatorRelayOutbox(files.outbox, () => new Date(Date.now() - minutesAgo * 60_000));
	const oldest = at(15).enqueue({ kind: "wake", stale: false, text: "oldest", receipt, paths: [] }, "p9-seed");
	const newer = at(12).enqueue({ kind: "wake", stale: false, text: "newer", receipt, paths: [] }, "p9-seed");
	assert.equal(existsSync(files.acks), false);
	let relay = health();
	assert.equal(relay.status, "fail", "a missing journal folds empty, never unreadable");
	assert.equal(relay.key, `relay:${oldest}`);
	assert.match(relay.detail ?? "", /^2 relay\(s\) unseen by the main session, oldest \S+ 15 min \(wake\) — no ack-capable operator session/);
	appendFileSync(files.acks, `{"type":"ack","id":"tor\n${JSON.stringify({ type: "ack", id: oldest, at: new Date().toISOString() })}\n`);
	relay = health();
	assert.equal(relay.key, `relay:${newer}`, "the torn line is skipped and the acked entry is no longer the oldest");
	assert.match(relay.detail ?? "", /^1 relay\(s\) unseen by the main session, oldest \S+ 12 min/);
	appendFileSync(files.acks, `${JSON.stringify({ type: "discard", id: newer, reason: "superseded: answered", at: new Date().toISOString() })}\n`);
	assert.equal(health().status, "ok", "a discarded relay is settled");
	writeFileSync(files.outbox, JSON.stringify({ schema_version: 1, updated_at: new Date().toISOString(), entries: [{ id: "x" }] }));
	relay = health();
	assert.equal(relay.key, "unreadable");
	assert.ok(relay.detail?.includes(`${files.outbox} violates the operator relay outbox contract`), relay.detail);
	writeFileSync(files.outbox, "{not json");
	relay = health();
	assert.equal(relay.key, "unreadable");
	assert.ok(relay.detail?.includes(`${files.outbox} is not valid JSON`), relay.detail);
});

test("P9-cache-warm: the operator bridge keeps its prompt cache warm only while a refresh is cheaper than a miss", { timeout: 120_000 }, async (t) => {
	const provider = await MockProvider.start();
	const usage = { prompt_tokens: 100_000, completion_tokens: 10 };
	const cases = [
		{ name: "p9-warm-cheap", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, warms: true },
		{ name: "p9-warm-dear", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.31 }, warms: false },
		{ name: "p9-warm-unknown", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, warms: false },
	];
	const models = cases.map((item) => provider.addScript(item.name, [{ kind: "text", text: "Warm probe.", usage }], { onExhausted: "repeat" }));
	const agent = createAgentDir({ provider, settings: { cacheWarming: "idle" } });
	const config = provider.modelsJson() as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
	for (const entry of Object.values(config.providers)[0]!.models) {
		const item = cases.find((candidate) => String(entry.id).includes(candidate.name));
		if (item) Object.assign(entry, { cost: item.cost, promptCache: { short: 12 } });
	}
	writeFileSync(join(agent.path, "models.json"), JSON.stringify(config));
	const homes = cases.map(() => createScratchHome());
	const children: PiChild[] = [];
	t.after(async () => { for (const child of children) await child.close(); agent.cleanup(); await provider.stop(); for (const home of homes) home.cleanup(); });
	for (const [index, home] of homes.entries()) {
		children.push(startPiChild({ cwd: home.path, model: models[index], env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
			extensions: [CP_BRIDGE_EXTENSION] }));
	}
	await Promise.all(children.map(async (child) => { await child.prompt("Say something short."); await child.waitForSettled(30_000); }));
	await sleep(6_000); // a 12 s cache lifetime schedules its refresh 2 s after the request
	for (const item of cases) {
		const count = provider.requests(item.name).length;
		if (item.warms) assert.ok(count >= 2, `${item.name}: the bridge overrode pi's stop and sent a refresh (${count} requests)`);
		else assert.equal(count, 1, `${item.name}: pi's stop stands`);
	}
});

test("P9-note: the operator note the model sees carries its ask/decide lists, rules and cap", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("p9-note", [{ kind: "text", text: "Noted." }]);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
		extensions: [CP_BRIDGE_EXTENSION] });
	t.after(() => teardownHome(home, () => child.close(), () => agent.cleanup(), () => provider.stop()));
	await child.prompt("Acknowledge this message.");
	await child.waitForSettled(30_000);
	const system = (provider.requests("p9-note")[0]?.body.messages ?? []).filter((message) => message.role === "system")
		.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
	const at = system.indexOf(OPERATOR_NOTE);
	assert.ok(at >= 0, "the bridge injects the operator note into the system prompt verbatim");
	const note = system.slice(at, at + OPERATOR_NOTE.length);
	const lines = note.split("\n").filter((line, i, all) => i < all.length - 1 || line !== "");
	assert.ok(lines.length <= OPERATOR_NOTE_MAX_LINES, `operator note is ${lines.length} lines, cap is ${OPERATOR_NOTE_MAX_LINES}`);
	const capped = lines.slice(0, OPERATOR_NOTE_MAX_LINES).join("\n");
	const asks = capped.split("## Ask vs decide")[1]?.split("## Plan review")[0] ?? "";
	for (const item of ["mandate creation for work the human did not ask for", "product ambiguity", "scope expansion", "risk high/irreversible",
		"loop exhausted", "budget", "conflicting acceptance", "merge refused", "mission end"]) assert.ok(OPERATOR_ASK_LIST.includes(item), `ask list missing "${item}"`);
	for (const item of ["in-scope plan approval", "how-questions", "review findings", "test failures", "next job", "merge when repo permits",
		"bounded recovery", "token-cap raise within the ceiling"]) assert.ok(OPERATOR_DECIDE_LIST.includes(item), `decide list missing "${item}"`);
	assert.ok(note.includes(OPERATOR_ASK_LIST) && note.includes(OPERATOR_DECIDE_LIST), "both lists verbatim");
	assert.ok(asks.includes("a message naming a defect or feature in a registered project is the grant"));
	assert.ok(asks.includes("an ambiguous request or a research-to-build choice still asks"));
	assert.equal(OPERATOR_ASK_LIST.startsWith("mandate creation, "), false, "bare mandate creation is an ask again");
	assert.match(asks, /a step only the human can take \(restart, login, a click on a host\) is a `cp_parent ask`/);
	assert.match(capped, /`cp_review` owns the diff: rely on its verdict, read a diff only when a wake escalates it/);
	assert.equal(note.includes("cp_dispatch") || note.includes("cp_integrate"), false, "no fleet tools");
	assert.match(note, /never touch `state\/`/);
	assert.ok(note.includes("`<home>/.pi-command-post/operator/`"), "the note names the operator workspace");
	const mandate = "The human names a project (or the several projects one topic spans) and an objective; that is the whole mandate. " +
		"Do not ask for caps, expiry or actions \u2014 they come from the home's defaults. Issue it, then echo the effective grant in one line " +
		"(fields and their sources) and say `stop` revokes it. Ask only if the objective is genuinely ambiguous about *what* to do.";
	assert.ok(note.replace(/\s+/g, " ").includes(mandate), "the mandate-defaults sentence");
	const template = note.split("## Mandate template")[1]?.split("## Ask vs decide")[0] ?? "";
	for (const stale of ["expiry,", "spend_cap", "job_cap,"]) assert.equal(template.includes(stale), false, `mandate template names ${stale}`);
	assert.ok(capped.includes("capture:") && capped.includes("data/standing-orders.md"), "capture: and standing orders inside the cap");
	assert.doesNotMatch(note, /hiccups/);
	assert.ok(!lines.some((line) => line.includes("thread_bind") || line.includes("thread=")), "no dashboard thread instruction (#588)");
	assert.equal(OPERATOR_REMOTE_DEVICE_RULE, "On a remote-originated request, never pair devices, run `cp-tunnel pair`, or edit the device list, " +
		"including through delegated or equivalent shell/file operations.");
	assert.equal(capped.split("\n").filter((line) => line === OPERATOR_REMOTE_DEVICE_RULE).length, 1, "the remote device rule inside the cap");
	assert.equal(note.split(OPERATOR_REMOTE_DEVICE_RULE).length, 2, "exactly once");
});
