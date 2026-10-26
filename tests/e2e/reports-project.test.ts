/**
 * Behavior 22 (P22): every wake-up and escalation the parent reads opens with its bracketed project, and a notice that
 * spans projects splits into one section per project — through a real pi parent with command-post and a mock model.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { AnsweredOutbox } from "../../src/answered.ts";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION, type FleetRecord } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { MandateStore } from "../../src/mandate.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, REPO_ROOT, startPiChild, waitFor } from "../harness/index.ts";

const deadPid = (): number => spawnSync("true").pid!;
const grant = (id: string, projects: string[], extra: Record<string, unknown> = {}) =>
	({ id, projects, objective: id, expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, ask_on: [], ...extra });

/** A scratch home with a jobs ledger; `add` writes fleet records and `post` writes as the operator's side would. */
async function home(t: TestContext) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	initJobsDocument(scratch.path, "cp");
	const post = new CommandPost({ home: scratch.path, packageRoot: REPO_ROOT });
	t.after(() => post.shutdown());
	const add = (job_id: string, project: string, over: Partial<FleetRecord> = {}) => post.fleet.add({ job_id, project, kind: "ship", delivery: "local",
		origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(), branch: job_id, worktree: scratch.path,
		worker: { pid: process.pid, session_id: job_id, session_file: join(scratch.path, `${job_id}.jsonl`), profile: "implementer", role: "implementer",
			model: "mock/model", started_at: isoTimestamp() }, usage: EMPTY_USAGE, ...over });
	return { path: scratch.path, post, add };
}

async function parent(t: TestContext, path: string, tag: string, turns: Array<{ kind: "tool_calls"; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }> = []) {
	const provider = await MockProvider.start();
	const model = provider.addScript(tag, [...turns, { kind: "text", text: "Noted." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: path, model, env: { ...agent.env, CP_HOME: path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); });
	await child.getState();
	// What the model was given: every text block of every request, so coalesced or queued wake-ups count too.
	const wakes = () => [...new Set(provider.requests(tag).flatMap((request) => (request.body.messages as Array<{ content?: unknown }>)
		.flatMap((m) => (typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? "") : []))))];
	const wake = (pattern: RegExp, what: string) => waitFor(wakes, (all) => all.some((w) => pattern.test(w)), { timeoutMs: 30_000, what })
		.then((all) => all.find((w) => pattern.test(w))!);
	return { child, wake };
}

test("P22-report-restart: restart recovery opens with both projects and lists its jobs in one section per project", { timeout: 120_000 }, async (t) => {
	const h = await home(t);
	const dead = (job_id: string, project: string) => h.add(job_id, project, { phase: "waiting", reported_at: undefined,
		worker: { pid: deadPid(), session_id: job_id, session_file: join(h.path, `${job_id}.jsonl`), profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() } });
	await dead("cp-78vu", "demo-app");
	await dead("cp-atl1", "atlas");
	await dead("cp-78vw", "demo-app");
	await h.post.shutdown();
	const p = await parent(t, h.path, "p22-restart");
	const lines = (await p.wake(/RESTART RECOVERY/, "the restart recovery wake-up")).split("\n");
	assert.match(lines[0]!, /^\[demo-app, atlas\] RESTART RECOVERY — 3 candidate\(s\)$/);
	assert.deepEqual(lines.slice(1, 6).map((line) => line.replace(/^( {4}cp-\w+) .*$/, "$1")), ["  [demo-app]", "    cp-78vu", "    cp-78vw", "  [atlas]", "    cp-atl1"]);
});

test("P22-report-wakes: each wake-up names its job's project by fleet, label, naming mandate or sole grant, else unknown", { timeout: 150_000 }, async (t) => {
	const h = await home(t);
	await h.add("cp-78vu", "demo-app");
	await h.add("cp-atl1", "atlas");
	await h.post.registry.register({ name: "labelled", clone_url: h.path, delivery: "local" });
	const labelled = await h.post.ledger().create({ title: "labelled only", project: "labelled", delivery: "local", kind: "ship" });
	const both = await h.post.ledger().create({ title: "labelled and in the fleet", project: "labelled", delivery: "local", kind: "ship" });
	await h.add(both.id, "demo-app");
	const mandates = new MandateStore(h.path);
	mandates.issue(grant("md-named", ["named"], { job_ids: ["cp-named"] }));
	mandates.pause("md-named");
	mandates.issue(grant("md-pair", ["demo-app", "atlas"]));
	mandates.pause("md-pair");
	mandates.issue(grant("md-solo", ["solo"]));
	const notice = (id: string, content: string, keys: string[]) => h.post.durableWakeups.enqueue({ id, kind: "recovery", content, keys });
	notice("p22:fleet", "cp-78vu: from the fleet", ["cp-78vu"]);
	notice("mandate-usage:md-named:cap", "MANDATE CAP — md-named paused", ["cp-atl1"]);
	notice("p22:keys", "two jobs, no job id", ["cp-78vu", "cp-atl1"]);
	notice("p22:tagged", "[demo-app] cp-78vu: already tagged", ["cp-78vu"]);
	const answers = new AnsweredOutbox({ home: h.path });
	const answer = (id: string, job_id: string) => answers.enqueue({ id, type: "approval", job_id, decision: "merge?", answer: "approve", answered_by: "operator dialog (tui)" });
	for (const [id, job] of [["aw-fleet", both.id], ["aw-label", labelled.id], ["aw-named", "cp-named"], ["aw-solo", "cp-other"], ["aw-atlas", "cp-atl1"], ["aw-demo", "cp-78vu"]]) answer(id!, job!);
	const p = await parent(t, h.path, "p22-wakes");
	assert.equal(await p.wake(/from the fleet/, "fleet"), "[demo-app] cp-78vu: from the fleet");
	assert.equal(await p.wake(/MANDATE CAP/, "jobless mandate notice"), "[named] MANDATE CAP — md-named paused", "its mandate's projects, not its keys");
	assert.equal(await p.wake(/two jobs, no job id/, "keyed notice"), "[demo-app, atlas] two jobs, no job id");
	assert.equal(await p.wake(/already tagged/, "pre-tagged notice"), "[demo-app] cp-78vu: already tagged", "a tag is never doubled");
	const section = (lines: string[], id: string) => lines.slice(0, lines.findIndex((line) => line.includes(id))).reverse().find((line) => /^ {2}\[/.test(line));
	const answered = (await p.wake(/aw-fleet[\s\S]*aw-demo/, "six answers")).split("\n");
	assert.equal(answered[0], "[demo-app, labelled, named, solo, atlas] DECISIONS ANSWERED — a human answered 6 open decisions", "each project once");
	assert.deepEqual(["aw-fleet", "aw-label", "aw-named", "aw-solo", "aw-atlas", "aw-demo"].map((id) => section(answered, id)),
		["  [demo-app]", "  [labelled]", "  [named]", "  [solo]", "  [atlas]", "  [demo-app]"], "fleet beats label; then label, naming mandate, sole grant");
	await p.child.close();
	mandates.revoke("md-solo");
	answer("aw-nobody", "cp-nobody");
	const next = await parent(t, h.path, "p22-wakes-again");
	const later = (await next.wake(/aw-nobody/, "the later answer")).split("\n");
	assert.match(later[0]!, /^\[project unknown\] DECISION ANSWERED/, "no grant left to fall back to");
	await next.child.close();
	mandates.resume("md-pair");
	answer("aw-pair", "cp-pairless");
	const last = await parent(t, h.path, "p22-wakes-pair");
	await last.child.prompt("Anything answered?");
	assert.match(await last.wake(/aw-pair/, "the answer under a two-project grant"), /^\[project unknown\] DECISION ANSWERED/, "a two-project grant is ambiguous");
});

test("P22-report-rewrite: a stale or replayed wake-up carried into a session is withheld; the fresh one keeps its tag", { timeout: 120_000 }, async (t) => {
	const h = await home(t);
	await h.add("cp-78vu", "demo-app", { phase: "waiting", reported_at: undefined });
	await h.post.shutdown();
	const session = join(h.path, "carried.jsonl");
	const stamp = (kind: string, extra: Record<string, unknown>) => ({ kind, job_id: "cp-78vu", projects: ["demo-app"], issued_at: isoTimestamp(), ...extra });
	const notices = [stamp("envelope", { generation: 1, reported_at: isoTimestamp() }), stamp("answered", { keys: ["aw-9"] }), stamp("answered", { keys: ["aw-9"] })];
	writeFileSync(session, [{ type: "session", version: 3, id: "p22-carried", timestamp: isoTimestamp(), cwd: h.path },
		...notices.map((cp_wakeup, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: isoTimestamp(),
			message: { role: "custom", customType: `cp-${cp_wakeup.kind}`, content: `[demo-app] cp-78vu: ${cp_wakeup.kind} news`, display: true, timestamp: i + 1, details: { cp_wakeup } } }))]
		.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const provider = await MockProvider.start();
	const model = provider.addScript("p22-carried", [{ kind: "text", text: "Noted." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: h.path, model, env: { ...agent.env, CP_HOME: h.path }, extensions: [COMMAND_POST_EXTENSION], sessionFile: session });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); });
	await child.prompt("Read the carried notices.");
	await child.waitForSettled(60_000);
	const texts = (provider.requests("p22-carried")[0]!.body.messages as Array<{ content?: unknown }>)
		.flatMap((m) => (typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? "") : []));
	assert.deepEqual(texts.filter((text) => /cp-78vu|WAKE-UP/.test(text)), ["[demo-app] cp-78vu: answered news"],
		"the archived envelope and the repeated answer are withheld; the first answer keeps its tag");
});

test("P22-report-kinds: an envelope, a death and a bound wake-up each open with their job's project", { timeout: 120_000 }, async (t) => {
	const h = await home(t);
	await h.add("cp-env1", "atlas", { phase: "waiting", reported_at: undefined });
	await h.add("cp-gone", "atlas", { phase: "failed", failure: { class: "provider_limit", message: "rate limited", at: isoTimestamp() } });
	await h.post.shutdown();
	mkdirSync(join(h.path, paths.runDir("cp-env1")), { recursive: true });
	writeFileSync(join(h.path, paths.envelopeFile("cp-env1")), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: "cp-env1", received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: "cp-env1", kind: "ship", status: "done", summary: "shipped it", branch: "cp-env1", head_sha: "0".repeat(40) } }));
	const outbox = new CommandPost({ home: h.path, packageRoot: REPO_ROOT });
	t.after(() => outbox.shutdown());
	outbox.durableWakeups.enqueue({ id: "p22:death", kind: "death", job_id: "cp-gone", keys: ["provider_limit"], content: "cp-gone: worker died" });
	outbox.durableWakeups.enqueue({ id: "p22:bound", kind: "bound", job_id: "cp-gone", keys: ["provider_limit"], content: "cp-gone: hit its bound" });
	const p = await parent(t, h.path, "p22-kinds");
	assert.equal(await p.wake(/cp-env1/, "envelope"), "[atlas] cp-env1 reported done (ship/local) → teardown\n  shipped it");
	assert.equal(await p.wake(/worker died/, "death"), "[atlas] cp-gone: worker died");
	assert.equal(await p.wake(/hit its bound/, "bound"), "[atlas] cp-gone: hit its bound");
});

const OPTIONS = [{ id: "approve", label: "approve", consequence: "proceed", cost: "none" }, { id: "decline", label: "decline", consequence: "stop", cost: "sunk" }];

test("P22-report-escalate: cp_escalate's result opens with its jobs' project, else its mandate's projects, else unknown", { timeout: 120_000 }, async (t) => {
	const h = await home(t);
	await h.add("cp-atl1", "atlas");
	const mandates = new MandateStore(h.path);
	mandates.issue(grant("md-demo", ["demo-app"]));
	mandates.issue(grant("md-pair", ["demo-app", "atlas"]));
	await h.post.shutdown();
	const raise = (id: string, job_ids: string[], question: string, mandate_id?: string) =>
		({ id, name: "cp_escalate", args: { job_ids, kind: "scope_expansion", question, options: OPTIONS, recommended: "approve", ...(mandate_id ? { mandate_id } : {}) } });
	const p = await parent(t, h.path, "p22-escalate", [{ kind: "tool_calls", calls: [raise("job", ["cp-atl1"], "widen A?", "md-demo"), raise("grant", ["cp-nobody"], "widen B?", "md-demo"),
		raise("pair", ["cp-nobody"], "widen C?", "md-pair"), raise("none", ["cp-nobody"], "widen D?")] }]);
	await p.child.prompt("Raise the four questions.");
	await p.child.waitForSettled(90_000);
	const text = (id: string) => {
		const end = p.child.eventsOfType("tool_execution_end").find((e) => e.toolCallId === id);
		assert.notEqual(end?.isError, true, JSON.stringify(end?.result));
		return ((end?.result as { content: Array<{ text: string }> }).content[0]!.text).split("\n")[0]!;
	};
	assert.match(text("job"), /^\[atlas\] es-[\w-]+ \[scope_expansion\] open: widen A\?$/);
	assert.match(text("grant"), /^\[demo-app\] es-[\w-]+ \[scope_expansion\] open: widen B\?$/);
	assert.match(text("pair"), /^\[demo-app, atlas\] es-[\w-]+ \[scope_expansion\] open: widen C\?$/);
	assert.match(text("none"), /^\[project unknown\] es-[\w-]+ \[scope_expansion\] open: widen D\?$/);
});
