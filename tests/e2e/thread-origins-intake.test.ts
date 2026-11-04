/**
 * Full match S10b: job origins at parent intake through the real parent host and a real pi parent (mock provider).
 * Sends go in by the bridge's `requestSend` (and once through the operator's own cp_parent send); the scripted parent
 * names the `ps-…` id from its prompt; `GET /api/threads` on `bin/cp-view` reads the joins.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { type Job, LAYOUT } from "../../src/contracts.ts";
import { readJobsDocument } from "../../src/ledger.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { bindThread, writeThread } from "../../src/operator-named-threads.ts";
import { requestSend } from "../../src/operator-origins.ts";
import { attachParentHost, type ParentHostClient } from "../../src/parent-host.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { readQueueJournal } from "../../src/viewer/control-queue.ts";
import { controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { startViewer } from "../harness/dashboard.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, type ScriptStep, startPiChild, waitFor } from "../harness/index.ts";
import type { RecordedRequest } from "../harness/mock-provider.ts";

type Json = Record<string, any>;
const DC = (n: number) => `dc-20261104150000-${n.toString(16).padStart(8, "0")}`;
const FORGED_PS = "ps-20261104150000-deadbeef";
const MARKER = /\[cp-send (ps-\d{14}-[0-9a-f]{8})/;
const IDLE: Record<string, Json> = { cp_job: { action: "list" }, cp_pipeline: { action: "classify", task: "nothing to start" }, cp_ask: { question: " " } };

test("thread-origins intake: explicit ps ids tag jobs once; children inherit; retry, wake, updates and replay keep it; joins stay unambiguous", { timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const stateDir = join(home.path, LAYOUT.state);
	await new ProjectRegistry({ home: home.path }).register({ name: "picp", clone_url: "https://example.invalid/picp.git" });
	const now = new Date();
	const thread = (n: number, name: string) => String((writeThread(stateDir, "thread_create", { client_id: DC(0x100 + n), name }, now) as Json).result.thread_id);
	const [A, B] = [thread(1, "Alpha"), thread(2, "Beta")];
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	const journal = [[1, A], [2, B], [3, undefined]].flatMap(([n, th]) => [
		{ type: "request", kind: "message", id: DC(n as number), at: now.toISOString(), text: `dashboard ${n}`, ...(th ? { thread_id: th } : {}) },
		{ type: "outcome", id: DC(n as number), state: "delivered" },
	]);
	writeFileSync(controlJournalFile(stateDir), journal.map((line) => `${JSON.stringify(line)}\n`).join(""));
	const outbox = new ParentSendOutbox({ file: parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl")) });
	const jobs = () => readJobsDocument(home.path).jobs;
	const by = (title: string): Job[] => jobs().filter((job) => job.title === title);
	const origin = (title: string) => by(title).map((job) => job.origin ?? "untagged");

	// The mock parent "reads" its prompt: the ps id or `[s10b-wake …]` names `&`-joined `op:title` directives.
	// Each turn fills four cp_job slots, cp_pipeline and cp_ask (idle if none); `queued:` enqueues an undrainable send.
	let queued: string | undefined;
	const directives = (request: RecordedRequest): string[] => {
		const last = JSON.stringify(((request.body as Json).messages as Json[]).filter((m) => m.role === "user").at(-1) ?? "");
		const id = last.match(MARKER)?.[1];
		const text = id ? outbox.list().find((entry) => entry.id === id)?.text : last.match(/\[s10b-wake ([^\]]+)\]/)?.[1];
		return text?.split(" & ").map((d) => `${d}|${id ?? ""}`) ?? [];
	};
	const create = (title: string, source?: string): [string, Json] =>
		["cp_job", { action: "create", project: "picp", title, delivery: "pr", kind: "ship", ...(source ? { source_send_id: source } : {}) }];
	const plans = new WeakMap<RecordedRequest, Array<[string, Json]>>();
	const plan = (request: RecordedRequest) => plans.get(request) ?? plans.set(request, directives(request).flatMap((d): Array<[string, Json]> => {
		const [op, rest] = d.split(":") as [string, string];
		const [title, id] = rest.split("|") as [string, string];
		const job = () => by(title)[0]!.id;
		if (op === "job") return [create(title, id)];
		if (op === "plain") return [create(title)];
		if (op === "forged") return [create(title, FORGED_PS)];
		if (op === "malformed") return [create(title, "ps-bad")];
		if (op === "queued") return [create(title, (queued = outbox.enqueue("noop").id))];
		if (op === "then") return [create(title, outbox.list().find((e) => e.text.includes(`later:${title}`))!.id)];
		if (op === "pipeline") return [["cp_pipeline", { action: "start", project: "picp", title, task: `plan ${title}`, source_send_id: id }]];
		if (op === "ask") return [["cp_ask", { project: "picp", question: title, source_send_id: id }]];
		if (op === "comment") return [["cp_job", { action: "comment", job_id: job(), text: "woken" }]];
		if (op === "claim") return [["cp_job", { action: "claim", job_id: job() }]];
		if (op === "status") return [["cp_job", { action: "update", job_id: job(), status: "open" }]];
		if (op === "notes") return [["cp_job", { action: "update", job_id: job(), notes: "touched" }]];
		if (op === "label") return [["cp_job", { action: "update", job_id: job(), add_labels: ["s10b-touched"] }]];
		return [];
	})).get(request)!;
	const slot = (name: string, n: number) => ({ name, args: (request: RecordedRequest) => plan(request).filter(([tool]) => tool === name)[n]?.[1] ?? IDLE[name] });
	const turn: ScriptStep[] = [
		{ kind: "tool_calls", calls: [slot("cp_job", 0), slot("cp_job", 1), slot("cp_job", 2), slot("cp_job", 3), slot("cp_pipeline", 0), slot("cp_ask", 0)] },
		{ kind: "text", text: "handled" },
	];
	const provider = await MockProvider.start();
	// The first send's turn hangs so the test can kill the parent mid-turn; every later turn is the reading step.
	// Turn BEFORE_RETRY + 1 (R1.2) answers its tool calls, then a 503; the outer retry replays the whole turn.
	const BEFORE_RETRY = 8;
	const steps: ScriptStep[] = [{ kind: "hang" }, ...Array.from({ length: BEFORE_RETRY }, () => turn).flat(), turn[0]!,
		{ kind: "error", status: 503, message: "S10B service unavailable" }, ...turn, ...Array.from({ length: 30 }, () => turn).flat()];
	const model = provider.addScript("s10b-parent", steps);
	// The operator relays once it was asked to; every other turn (relays the host replays on attach) reads status.
	let relayCalled = false;
	const operatorCall = (request: RecordedRequest) => {
		const asked = JSON.stringify((request.body as Json).messages).includes("Relay it.");
		if (!asked || relayCalled) return { action: "status" };
		relayCalled = true;
		return { action: "send", text: "job:viaop", source_send_id: DC(0x20) };
	};
	const operatorModel = provider.addScript("s10b-operator", Array.from({ length: 20 }, (_, n): ScriptStep[] => [
		{ kind: "tool_calls", calls: [{ id: `op-${n}`, name: "cp_parent", args: operatorCall }] }, { kind: "text", text: "noted" },
	]).flat());
	// pi's own retry is off so a 503 reaches the delivery's outer retry under the same send id.
	const agent = createAgentDir({ provider, settings: { retry: { enabled: false } } });
	const env = { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	let host: ParentHostClient | undefined;
	let operator: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => {
		await operator?.close();
		await host?.request("stop", undefined, 5_000).catch(() => undefined);
		host?.disconnect();
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		agent.cleanup();
		await provider.stop();
		home.cleanup();
	});
	host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	await host.request("start", { home: home.path, mode: "multi", model, modelExplicit: true });
	await host.onRelay(() => {});
	const send = async (text: string, source: { source_send_id: string; thread_id: string | null }) => {
		const reply = await requestSend(host!, text, {}, source) as { send_id?: string; pending?: string };
		const id = reply.send_id ?? reply.pending;
		assert.ok(id, JSON.stringify(reply));
		return id;
	};
	const settled = (id: string) => waitFor(() => outbox.list().find((e) => e.id === id), (e) => e?.state === "settled", { timeoutMs: 90_000, what: `send ${id} settles` });
	const bodies = () => JSON.stringify(provider.requests("s10b-parent").map((r) => r.body));

	// Restart: the parent dies mid-turn on B's send; the restarted parent's resume nudge names the same ps id.
	let at = performance.now();
	const sending = send("job:replayed", { source_send_id: DC(2), thread_id: B });
	await waitFor(() => provider.requests("s10b-parent").length, (n) => n >= 1, { timeoutMs: 60_000, what: "the parent's first turn" });
	process.kill((await host.request("status") as { pid: number }).pid, "SIGKILL");
	await settled(await sending);
	t.diagnostic(`parent SIGKILL → replayed send created its job ${(performance.now() - at).toFixed(1)} ms`);
	assert.match(JSON.stringify(provider.requests("s10b-parent")[1]?.body), /cp-send ps-\d{14}-[0-9a-f]{8} — resume\]/, "the restarted parent got the resume nudge");
	assert.deepEqual(origin("replayed"), [{ source_send_id: DC(2), thread_id: B }], "R1.4 restart: the resumed send's job keeps its own origin");
	at = performance.now();
	for (const [text, source] of [
		["job:alpha & later:gamma & pipeline:piped", { source_send_id: DC(1), thread_id: A }],
		["job:beta & then:gamma", { source_send_id: DC(2), thread_id: B }],
		["job:alpha & plain:untagged", { source_send_id: DC(2), thread_id: B }],
		["forged:forged & job:nothread", { source_send_id: DC(3), thread_id: null }],
		["job:orphan & job:contested", { source_send_id: DC(4), thread_id: "th-00000000000000ff" }],
	] as const) await settled(await send(text, source));
	t.diagnostic(`five intake turns ${(performance.now() - at).toFixed(1)} ms`);

	const ALPHA = { source_send_id: DC(1), thread_id: A };
	assert.deepEqual({ alpha: origin("alpha"), beta: origin("beta"), gamma: origin("gamma") }, {
		alpha: [ALPHA], beta: [{ source_send_id: DC(2), thread_id: B }], gamma: [ALPHA],
	}, "interleaved: gamma, created during B's turn, keeps the A send it names; B's duplicate alpha never rebinds A's");
	assert.deepEqual([origin("research: piped"), origin("ship: piped")], [[ALPHA], [ALPHA]], "the pipeline ship inherits the research job's origin");
	assert.deepEqual([origin("untagged"), origin("nothread")], [["untagged"], [{ source_send_id: DC(3), thread_id: null }]], "no key is untagged; No thread is null");
	assert.deepEqual(by("forged"), [], "a forged ps id creates nothing");
	assert.equal(bodies().includes(`source_send_id ${FORGED_PS} is not a send the operator made to this parent; nothing was created`), true, "the forged id is refused in plain words");
	assert.equal(jobs().filter((job) => job.origin).every((job) => Object.keys(job.origin!).join() === "source_send_id,thread_id"), true);
	t.diagnostic(`ledger bytes per job origin ${JSON.stringify({ origin: by("alpha")[0]!.origin }).length - 2}`);

	// R2: a malformed and a queued (never delivered) ps id are refused with the ledger unchanged; cp_ask tags its job.
	const before = jobs();
	await settled(await send("malformed:badkey & queued:unsent & ask:Ship gamma?", ALPHA));
	assert.ok(queued, "the queued send was enqueued during the turn");
	await settled(queued!);
	assert.match(bodies(), /source_send_id must be a parent send id \(ps-<14 digits>-<8 hex>\); nothing was created/, "a malformed id is refused in plain words");
	assert.equal(bodies().includes(`source_send_id ${queued} was never delivered to the parent; nothing was created`), true, "an undelivered id is refused in plain words");
	assert.deepEqual(jobs().filter((job) => job.title !== "Ship gamma?"), before, "neither refusal created or changed a job");
	assert.deepEqual([origin("Ship gamma?"), by("Ship gamma?")[0]?.labels.includes("delivery:answer")], [[ALPHA], true], "cp_ask's job carries its send's origin");

	// R1.2 retry: the turn creates `retried`, then fails on a transient 503; the outer retry resumes under the same id.
	assert.equal(provider.remaining("s10b-parent"), steps.length - 1 - 2 * BEFORE_RETRY, "the next turn is the scripted retry");
	at = performance.now();
	const retried = await settled(await send("job:retried", { source_send_id: DC(2), thread_id: B }));
	t.diagnostic(`transient send → settled after the outer retry ${(performance.now() - at).toFixed(1)} ms`);
	assert.deepEqual([retried?.outer_retry_attempts, origin("retried")], [1, [{ source_send_id: DC(2), thread_id: B }]], "R1.2 retry: one job, origin unchanged");

	// R1.1 wake: a durable wake-up reaches the parent, which comments on alpha; alpha's origin is unchanged.
	new DurableWakeupOutbox({ home: home.path }).enqueue({ id: "s10b-wake", kind: "recovery", content: "S10B wake [s10b-wake comment:alpha]" });
	await waitFor(() => by("alpha")[0]!, (job) => job.comments.some((c) => c.text === "woken"), { timeoutMs: 60_000, what: "the wake turn comments on alpha" });
	assert.deepEqual(origin("alpha"), [ALPHA], "R1.1 wake: origin unchanged");

	// R1.3 claim, then a status change, notes and labels through cp_job, one turn each so no write order is assumed.
	await settled(await send("claim:alpha", { source_send_id: DC(2), thread_id: B }));
	assert.deepEqual([by("alpha")[0]!.status, origin("alpha")], ["in_progress", [ALPHA]], "R1.3 cp_job claim: origin unchanged");
	for (const op of ["status", "notes", "label"]) await settled(await send(`${op}:alpha`, { source_send_id: DC(2), thread_id: B }));
	const touched = by("alpha")[0]!;
	assert.deepEqual([touched.status, touched.notes, touched.labels.includes("s10b-touched")], ["open", "touched", true], "the updates landed");
	assert.deepEqual(origin("alpha"), [ALPHA], "R1.3 cp_job claim/status/notes/labels: origin unchanged");

	// R3: one dashboard message in A goes through the operator's own pi and cp_parent send with its dc id.
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	operator = startPiChild({ cwd: home.path, model: operatorModel, sessionDir: join(stateDir, "sessions", "operator"), extensions: [CP_BRIDGE_EXTENSION], env: { ...env } });
	const control = await waitFor(() => readControlRecord(stateDir), (row) => row.state === "ok", { timeoutMs: 30_000, what: "dashboard control record" });
	if (control.state !== "ok") throw new Error("no dashboard control");
	// The owner journals the dashboard message delivered; a later operator turn relays it with that dc id.
	const relayed = await controlRequest(control.record, "send", { kind: "message", text: "via the operator", client_id: DC(0x20), thread_id: A });
	assert.equal(relayed.ok, true, JSON.stringify(relayed));
	await waitFor(() => readQueueJournal(stateDir).messages.get(DC(0x20))?.state, (state) => state === "delivered", { timeoutMs: 30_000, what: "the dashboard message is delivered" });
	await operator.prompt("Relay it.", "followUp");
	const viaop = await waitFor(() => outbox.list().find((e) => e.text === "job:viaop"), (e) => e?.state === "settled", { timeoutMs: 90_000, what: "the operator's relay settles" });
	assert.deepEqual([viaop?.origin, origin("viaop")], [{ source_send_id: DC(0x20), thread_id: A }, [{ source_send_id: DC(0x20), thread_id: A }]], "R3: operator cp_parent send → parent cp_job");

	// Joins: an ask carries its S10a source; a registry bind that disagrees with a job's origin makes it multi-origin;
	// a malformed origin joins nothing even when bound.
	const asks = new OperatorAsks(join(stateDir, "operator", "asks.jsonl"));
	const ask = asks.open({ project: "picp", question: "Ship alpha?", options: [{ label: "Yes", consequence: "Goes" }], recommendation: "Yes" }, { send_id: DC(1), thread_id: A });
	asks.answer(ask.id, "Yes");
	asks.open({ project: "picp", question: "Plain?", options: [{ label: "Yes", consequence: "Goes" }], recommendation: "Yes" });
	const contested = by("contested")[0]!.id;
	bindThread(stateDir, { kind: "job", id: by("beta")[0]!.id }, A, now);
	const doc = readJobsDocument(home.path);
	doc.jobs.push({ ...by("untagged")[0]!, id: "cp-malformed", title: "malformed", origin: { source_send_id: "dc-bad", thread_id: A } } as Job);
	writeFileSync(join(home.path, LAYOUT.jobsFile), JSON.stringify(doc));
	bindThread(stateDir, { kind: "job", id: "cp-malformed" }, A, now);
	const viewer = await startViewer(t, { home: home.path });
	at = performance.now();
	const view = (await viewer.get("/api/threads")).body as Json;
	t.diagnostic(`GET /api/threads ${(performance.now() - at).toFixed(1)} ms`);
	const joins = Object.fromEntries((view.joins as Json[]).map((j) => [j.thread_id, j]));
	const titles = (rows: Json[]) => rows.map((row) => row.title).sort();
	assert.deepEqual({ A: titles(joins[A].jobs), B: titles(joins[B].jobs) }, {
		A: ["Ship gamma?", "alpha", "gamma", "research: piped", "ship: piped", "viaop"], B: ["replayed", "retried"],
	}, "jobs join by origin; beta (bound to A, origin B) is multi-origin and joins neither; malformed joins none");
	assert.deepEqual(joins[A].started_from_chat.map((row: Json) => [row.title, row.source_send_id]).sort(), [
		["Ship gamma?", DC(1)], ["alpha", DC(1)], ["gamma", DC(1)], ["research: piped", DC(1)], ["ship: piped", DC(1)], ["viaop", DC(0x20)],
	]);
	assert.deepEqual([joins[A].asks.map((row: Json) => [row.title, row.state]), joins[B].asks], [[["Ship alpha?", "answered"]], []], "the answer goes with its ask");
	assert.deepEqual(view.join_diagnostics, { multi_origin: 1, unknown_thread: 2, malformed: 1, unreadable: [] }, "ambiguity is counted, never guessed");
	assert.equal(JSON.stringify(view.joins).includes(contested), false, "a job naming an unknown thread joins none");
});
