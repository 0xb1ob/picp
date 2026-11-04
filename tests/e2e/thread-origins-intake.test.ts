/**
 * Full match S10b: job origins at parent intake through the real parent host and a real pi parent (command-post
 * extension, mock provider). Sends go in by the bridge's own `requestSend` with an S10a origin; the scripted parent
 * names the `ps-…` id from its prompt; `GET /api/threads` on `bin/cp-view` reads the joins.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { type Job, LAYOUT } from "../../src/contracts.ts";
import { readJobsDocument } from "../../src/ledger.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { bindThread, writeThread } from "../../src/operator-named-threads.ts";
import { requestSend } from "../../src/operator-origins.ts";
import { attachParentHost, type ParentHostClient } from "../../src/parent-host.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { controlJournalFile } from "../../src/viewer/control-files.ts";
import { startViewer } from "../harness/dashboard.ts";
import { createAgentDir, createScratchHome, MockProvider, type ScriptStep, waitFor } from "../harness/index.ts";
import type { RecordedRequest } from "../harness/mock-provider.ts";

type Json = Record<string, any>;
const DC = (n: number) => `dc-20261104150000-${n.toString(16).padStart(8, "0")}`;
const FORGED_PS = "ps-20261104150000-deadbeef";
const MARKER = /\[cp-send (ps-\d{14}-[0-9a-f]{8})/;

test("thread-origins intake: explicit ps ids tag jobs once; pipeline inherits; replay keeps it; joins stay unambiguous", { timeout: 300_000 }, async (t) => {
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

	// The mock parent "reads" its prompt: the first ps id in its latest user message, that send's directives
	// (`op:title`, `&`-joined) and, for `then:`, the earlier send whose text said `later:` with that title.
	const directives = (request: RecordedRequest): string[] => {
		const users = ((request.body as Json).messages as Json[]).filter((m) => m.role === "user");
		const id = JSON.stringify(users.at(-1) ?? "").match(MARKER)?.[1];
		return outbox.list().find((entry) => entry.id === id)?.text.split(" & ").map((d) => `${d}|${id}`) ?? [];
	};
	const jobArgs = (slot: number) => (request: RecordedRequest) => {
		const [op, rest] = (directives(request).filter((d) => !d.startsWith("pipeline:"))[slot] ?? "list:|").split(":");
		const [title, id] = rest!.split("|");
		const create = { action: "create", project: "picp", title, delivery: "pr", kind: "ship" };
		if (op === "job") return { ...create, source_send_id: id };
		if (op === "plain") return create;
		if (op === "forged") return { ...create, source_send_id: FORGED_PS };
		if (op === "then") return { ...create, source_send_id: outbox.list().find((e) => e.text.includes(`later:${title}`))!.id };
		return { action: "list" };
	};
	const pipelineArgs = (request: RecordedRequest) => {
		const piped = directives(request).find((d) => d.startsWith("pipeline:"));
		if (!piped) return { action: "classify", task: "nothing to start" };
		const [title, id] = piped.slice("pipeline:".length).split("|");
		return { action: "start", project: "picp", title, task: `plan ${title}`, source_send_id: id };
	};
	const turn: ScriptStep[] = [
		{ kind: "tool_calls", calls: [{ name: "cp_job", args: jobArgs(0) }, { name: "cp_job", args: jobArgs(1) }, { name: "cp_pipeline", args: pipelineArgs }] },
		{ kind: "text", text: "handled" },
	];
	const provider = await MockProvider.start();
	// The first send's turn hangs so the test can kill the parent mid-turn; every later turn is the reading step.
	const model = provider.addScript("s10b-parent", [{ kind: "hang" }, ...Array.from({ length: 12 }, () => turn).flat()]);
	const agent = createAgentDir({ provider });
	const env = { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	let host: ParentHostClient | undefined;
	t.after(async () => {
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
	const send = async (text: string, origin: { source_send_id: string; thread_id: string | null }) => {
		const reply = await requestSend(host!, text, {}, origin) as { send_id?: string; pending?: string };
		const id = reply.send_id ?? reply.pending;
		assert.ok(id, JSON.stringify(reply));
		return id;
	};
	const settled = (id: string) => waitFor(() => outbox.list().find((e) => e.id === id), (e) => e?.state === "settled", { timeoutMs: 90_000, what: `send ${id} settles` });

	// Restart: the parent dies mid-turn on B's send; the restarted parent's resume nudge names the same ps id.
	let at = performance.now();
	const sending = send("job:replayed", { source_send_id: DC(2), thread_id: B });
	await waitFor(() => provider.requests("s10b-parent").length, (n) => n >= 1, { timeoutMs: 60_000, what: "the parent's first turn" });
	process.kill((await host.request("status") as { pid: number }).pid, "SIGKILL");
	await settled(await sending);
	t.diagnostic(`parent SIGKILL → replayed send created its job ${(performance.now() - at).toFixed(1)} ms`);
	assert.match(JSON.stringify(provider.requests("s10b-parent")[1]?.body), /cp-send ps-\d{14}-[0-9a-f]{8} — resume\]/, "the restarted parent got the resume nudge");
	at = performance.now();
	for (const [text, origin] of [
		["job:alpha & later:gamma & pipeline:piped", { source_send_id: DC(1), thread_id: A }],
		["job:beta & then:gamma", { source_send_id: DC(2), thread_id: B }],
		["job:alpha & plain:untagged", { source_send_id: DC(2), thread_id: B }],
		["forged:forged & job:nothread", { source_send_id: DC(3), thread_id: null }],
		["job:orphan & job:contested", { source_send_id: DC(4), thread_id: "th-00000000000000ff" }],
	] as const) await settled(await send(text, origin));
	t.diagnostic(`five intake turns ${(performance.now() - at).toFixed(1)} ms`);

	const jobs = readJobsDocument(home.path).jobs;
	const by = (title: string): Job[] => jobs.filter((job) => job.title === title);
	const origin = (title: string) => by(title).map((job) => job.origin ?? "untagged");
	assert.deepEqual({ alpha: origin("alpha"), beta: origin("beta"), gamma: origin("gamma") }, {
		alpha: [{ source_send_id: DC(1), thread_id: A }], beta: [{ source_send_id: DC(2), thread_id: B }],
		gamma: [{ source_send_id: DC(1), thread_id: A }],
	}, "interleaved: gamma, created during B's turn, keeps the A send it names; B's duplicate alpha never rebinds A's");
	assert.deepEqual([origin("research: piped"), origin("ship: piped")], [[{ source_send_id: DC(1), thread_id: A }], [{ source_send_id: DC(1), thread_id: A }]], "the pipeline ship inherits the research job's origin");
	assert.deepEqual(origin("replayed"), [{ source_send_id: DC(2), thread_id: B }], "the resumed send after a parent restart resolves its own origin");
	assert.deepEqual([origin("untagged"), origin("nothread")], [["untagged"], [{ source_send_id: DC(3), thread_id: null }]], "no key is untagged; No thread is null");
	assert.deepEqual(by("forged"), [], "a forged ps id creates nothing");
	const bodies = JSON.stringify(provider.requests("s10b-parent").map((r) => r.body));
	assert.equal(bodies.includes(`source_send_id ${FORGED_PS} is not a send the operator made to this parent; nothing was created`), true, "the forged id is refused in plain words");
	assert.equal(JSON.stringify(jobs).includes(`"origin"`) && jobs.filter((job) => job.origin).every((job) => Object.keys(job.origin!).join() === "source_send_id,thread_id"), true);
	t.diagnostic(`ledger bytes per job origin ${JSON.stringify({ origin: by("alpha")[0]!.origin }).length - 2}`);

	// Joins: an ask carries its S10a source; a registry bind that disagrees with a job's origin makes it multi-origin.
	const asks = new OperatorAsks(join(stateDir, "operator", "asks.jsonl"));
	const ask = asks.open({ project: "picp", question: "Ship alpha?", options: [{ label: "Yes", consequence: "Goes" }], recommendation: "Yes" }, { send_id: DC(1), thread_id: A });
	asks.answer(ask.id, "Yes");
	asks.open({ project: "picp", question: "Plain?", options: [{ label: "Yes", consequence: "Goes" }], recommendation: "Yes" });
	const contested = by("contested")[0]!.id;
	bindThread(stateDir, { kind: "job", id: by("beta")[0]!.id }, A, now);
	const viewer = await startViewer(t, { home: home.path });
	at = performance.now();
	const view = (await viewer.get("/api/threads")).body as Json;
	t.diagnostic(`GET /api/threads ${(performance.now() - at).toFixed(1)} ms`);
	const joins = Object.fromEntries((view.joins as Json[]).map((j) => [j.thread_id, j]));
	const titles = (rows: Json[]) => rows.map((row) => row.title).sort();
	assert.deepEqual({ A: titles(joins[A].jobs), B: titles(joins[B].jobs) }, {
		A: ["alpha", "gamma", "research: piped", "ship: piped"], B: ["replayed"],
	}, "jobs join by origin; beta (bound to A, origin B) is multi-origin and joins neither");
	assert.deepEqual(joins[A].started_from_chat.map((row: Json) => [row.title, row.source_send_id]).sort(), [["alpha", DC(1)], ["gamma", DC(1)], ["research: piped", DC(1)], ["ship: piped", DC(1)]]);
	assert.deepEqual([joins[A].asks.map((row: Json) => [row.title, row.state]), joins[B].asks], [[["Ship alpha?", "answered"]], []], "the answer goes with its ask");
	assert.deepEqual(view.join_diagnostics, { multi_origin: 1, unknown_thread: 2, malformed: 0, unreadable: [] }, "ambiguity is counted, never guessed");
	assert.equal(JSON.stringify(view.joins).includes(contested), false, "a job naming an unknown thread joins none");
});
