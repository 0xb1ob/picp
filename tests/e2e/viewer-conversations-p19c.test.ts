/**
 * Behavior 19 (P19c): the Sessions transcript's threads, the operator composer and the workbench, as `bin/cp-view`
 * serves them on a scratch home: real HTTP and the served app in its linkedom tab (DOM, text and served CSS only,
 * no layout or pixels).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { operatorThreadsFile } from "../../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { INBOX_REPLAY_PREFIX } from "../../src/viewer/thread-turns.ts";
import { type Context, type Json, jsonl, viewer, write } from "../harness/conversations.ts";

const AT = "2026-10-06T08:00:00Z";
const DC = "dc-20261006080000-89abcdef";
const msg = (message: unknown) => ({ type: "message", timestamp: AT, message });
const user = (text: string) => msg({ role: "user", content: [{ type: "text", text }] });
const said = (text: string) => msg({ role: "assistant", content: [{ type: "text", text }] });
const parentCall = (id: string, args: unknown, result: string) => [
	msg({ role: "assistant", content: [{ type: "toolCall", id, name: "cp_parent", arguments: args }] }),
	msg({ role: "toolResult", toolCallId: id, toolName: "cp_parent", content: [{ type: "text", text: result }] }),
];
const notice = (job: string, text: string) => ({ type: "custom_message", timestamp: AT, customType: "cp-bridge", content: `[cp-bridge cp-ci job=${job}]\n${text}` });
const compaction = { type: "compaction", timestamp: AT, tokensBefore: 123 };
const REPLAY = `${INBOX_REPLAY_PREFIX}1 message(s) typed while this session was offline]`;
/** The operator's turns: a dashboard message, a posted answer, a relay, a TUI ask and a duplicate answer. */
const TURNS = [
	user(`billing?\n\n[cp-dashboard ${DC} — from the dashboard; thread=billing]`),
	said("looking"),
	...parentCall("call-ans", { action: "answer", job_id: "cp-x" }, "answer: ans-a1b2c3d4e5f6 posted to the dashboard (bookkeeping only; no push)"),
	notice("cp-x", "CI green"),
	said("CI received"),
	compaction,
	user("from the TUI"),
	...parentCall("call-ask", { action: "ask", ask: {} }, JSON.stringify({ id: "ask-abcd", state: "open" })),
	said("asked"),
	...parentCall("call-dup", { action: "answer", job_id: "cp-x" }, "answer: cp-x already posted as ans-0000000000ff; nothing written"),
];
const open = (id: string, tag: string) => ({ type: "open", by: "viewer", id, at: AT, tag, peer: null });
const bind = (thread: string, kind: string, id: string) => ({ type: "bind", by: "bridge", at: AT, thread, ref: { kind, id }, peer: null });
const label = (e: Json) => `${e.kind}:${e.answer_id ?? e.ask_id ?? e.text.split("\n")[0]}=${e.shared ? "shared" : (e.thread ?? "-")}`;

/** A viewer whose operator session is `rows`, its ask-abcd open; `threads` rewrites the threads journal. */
async function threadViewer(t: Context, rows: unknown[]) {
	let stateDir = "";
	const d = await viewer(t, { at: AT, seed: (dir, home) => {
		stateDir = dir;
		const file = join(home, "session.jsonl");
		write(file, jsonl(rows));
		write(operatorSessionsFile(join(dir, "sessions")), jsonl([{ at: AT, session_file: file }]));
		write(join(dir, "operator/asks.jsonl"), jsonl([{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: AT, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] }]));
	} });
	const full = async () => (await d.get("/api/sessions?view=you&transcript=1")).body as { entries: Json[]; warnings: string[] };
	return { d, stateDir, full, threads: (lines: unknown[]) => write(operatorThreadsFile(stateDir), jsonl(lines)) };
}

// ---- thread turns ---------------------------------------------------------------------------------------------------

test("P19-thread-turns: a bound dashboard opener files its turn, an own ref wins, relays and inbox replays stay shared", { timeout: 120_000 }, async (t) => {
	const rows = [said("pre"), ...TURNS, user(`${REPLAY}\n- x (${DC}): hi`), said("after replay"), user("unbound"), said("plain reply")];
	const { stateDir, full, threads } = await threadViewer(t, rows);
	const missing = await full();
	assert.deepEqual(missing.warnings, []);
	assert.ok(missing.entries.every((e) => e.thread === undefined), "no journal, no refs: every entry is unthreaded");
	assert.deepEqual(missing.entries.filter((e) => e.shared).map((e) => e.kind), ["system", "system", "say"]);
	mkdirSync(operatorThreadsFile(stateDir), { recursive: true }); // a directory: unreadable
	const unreadable = await full();
	assert.equal(unreadable.warnings.length, 1);
	assert.match(unreadable.warnings[0]!, /^threads unavailable: .*threads\.jsonl/);
	assert.ok(unreadable.entries.every((e) => e.thread === undefined));
	assert.equal(unreadable.entries.length, missing.entries.length, "the transcript itself still renders");
	rmSync(operatorThreadsFile(stateDir), { recursive: true });
	const journal = [open("th-aaaaaaaaaaaa", "billing"), open("th-cccccccccccc", "caps"), bind("th-aaaaaaaaaaaa", "dashboard", DC), bind("th-cccccccccccc", "ask", "ask-abcd"), bind("th-aaaaaaaaaaaa", "answer", "ans-0000000000ff"), bind("th-cccccccccccc", "answer", "ans-0000000000ff")];
	threads(journal);
	const filed = await full();
	assert.deepEqual(filed.warnings, []);
	assert.deepEqual(filed.entries.map(label), [
		"say:pre=-",
		"via:billing?=th-aaaaaaaaaaaa",
		"say:looking=th-aaaaaaaaaaaa",
		"tool:ans-a1b2c3d4e5f6=th-aaaaaaaaaaaa",
		"system:CI green=shared",
		"say:CI received=-",
		"system:Context compacted (123 tokens before)=shared",
		"say:from the TUI=th-cccccccccccc",
		"tool:ask-abcd=th-cccccccccccc",
		"ask:ask-abcd=th-cccccccccccc",
		"say:asked=th-cccccccccccc",
		"tool:ans-0000000000ff=th-cccccccccccc",
		`say:${REPLAY}=shared`,
		"say:after replay=-",
		"say:unbound=-",
		"say:plain reply=-",
	]);
	threads([...journal, open("th-bbbbbbbbbbbb", "answers"), bind("th-bbbbbbbbbbbb", "answer", "ans-a1b2c3d4e5f6")]);
	const own = (await full()).entries.map(label);
	assert.deepEqual(own.slice(1, 4), ["via:billing?=th-aaaaaaaaaaaa", "say:looking=th-aaaaaaaaaaaa", "tool:ans-a1b2c3d4e5f6=th-bbbbbbbbbbbb"]);
});

test("P19-thread-jobs: bound job notices open their own turn; unbound notices, compactions and replays stay shared", { timeout: 120_000 }, async (t) => {
	const replay = user(`${REPLAY}\n- later\n[cp-dashboard ${DC} — from the dashboard; thread=billing]`);
	const rows = [...TURNS, notice("cp-y", "other job"), said("other reply"), notice("cp-unbound", "unbound"), said("loose"), compaction, said("after"), replay];
	const { full, threads } = await threadViewer(t, rows);
	threads([open("th-bbbbbbbbbbbb", "billing"), bind("th-bbbbbbbbbbbb", "job", "cp-x"), open("th-dddddddddddd", "other"), bind("th-dddddddddddd", "job", "cp-y")]);
	const { entries, warnings } = await full();
	assert.deepEqual(warnings, []);
	assert.deepEqual(entries.slice(3, 5).map(label), ["system:CI green=th-bbbbbbbbbbbb", "say:CI received=th-bbbbbbbbbbbb"]);
	assert.deepEqual(entries.slice(-8).map(label), [
		"tool:ans-0000000000ff=-",
		"system:other job=th-dddddddddddd",
		"say:other reply=th-dddddddddddd",
		"system:unbound=shared",
		"say:loose=-",
		"system:Context compacted (123 tokens before)=shared",
		"say:after=-",
		`say:${REPLAY}=shared`,
	]);
	assert.equal(entries.at(-1)!.who, "Operator");
});

test("P19-thread-refs: job binds and dashboard, ask or answer binds with the same id never cross-file entries or replies", { timeout: 120_000 }, async (t) => {
	const refs = [{ kind: "dashboard", id: DC }, { kind: "ask", id: "ask-abcd" }, { kind: "answer", id: "ans-a1b2c3d4e5f6" }];
	const jobThread = "th-bbbbbbbbbbbb", legacyThread = "th-aaaaaaaaaaaa";
	const replies = refs.flatMap((ref) => [notice(ref.id, `notice ${ref.kind}`), said(`reply ${ref.kind}`)]);
	const { full, threads } = await threadViewer(t, [...TURNS, ...replies, notice("ans-0000000000ff", "unbound job"), said("unbound reply")]);
	const journal = [open(jobThread, "jobs"), open(legacyThread, "legacy"), ...refs.map((ref) => bind(jobThread, "job", ref.id))];
	threads(journal);
	const legacy = (e: Json) => e.dashboard_id || e.ask_id || e.answer_id === refs[2]!.id || e.text === "looking" || e.text === "asked";
	const onlyJobs = await full();
	assert.ok(onlyJobs.entries.filter(legacy).every((e) => e.thread === undefined), "job-only binds must not own matching legacy entries or their turns");
	threads([...journal, ...refs.map((ref) => bind(legacyThread, ref.kind, ref.id)), bind(legacyThread, "answer", "ans-0000000000ff")]);
	const both = await full();
	assert.deepEqual(both.warnings, []);
	assert.equal(both.entries.find((e) => e.bridge?.job === "ans-0000000000ff")!.shared, true, "an answer binding cannot open a job turn");
	assert.equal(both.entries.find((e) => e.text === "unbound reply")!.thread, undefined);
	assert.ok(both.entries.filter(legacy).every((e) => e.thread === legacyThread));
	assert.deepEqual(refs.map((ref) => [both.entries.find((e) => e.bridge?.job === ref.id)!, both.entries.find((e) => e.text === `reply ${ref.kind}`)!].map(label)), [
		[`system:notice dashboard=${jobThread}`, `say:reply dashboard=${jobThread}`],
		[`system:notice ask=${jobThread}`, `say:reply ask=${jobThread}`],
		[`system:notice answer=${jobThread}`, `say:reply answer=${jobThread}`],
	]);
});
