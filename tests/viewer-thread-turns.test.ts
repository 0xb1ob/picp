import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import type { SessionEntry } from "../src/viewer/api-types.ts";
import { operatorThreadsFile } from "../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../src/viewer/operator-sessions.ts";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { assignThreads, INBOX_REPLAY_PREFIX } from "../src/viewer/thread-turns.ts";
import { createScratchHome } from "./harness/index.ts";

const row = (id: string, kind: SessionEntry["kind"], who: string, text = id, extra: Partial<SessionEntry> = {}): SessionEntry => ({ id, at: "2026-10-06T08:00:00Z", kind, who, text, name: null, send_id: null, tag: null, failed: false, trace: [], ...extra });
const tags = (entries: SessionEntry[]) => entries.map((e) => `${e.id}=${e.shared ? "shared" : (e.thread ?? "-")}`);

test("turn rule: a bound dc- opener files its turn; own refs win; shared entries end the turn", () => {
	const refs = new Map([["dc-20261006080000-89abcdef", "th-aaaaaaaaaaaa"], ["ans-a1b2c3d4e5f6", "th-bbbbbbbbbbbb"], ["ask-abcd", "th-cccccccccccc"]]);
	const entries = [
		row("pre", "say", "Assistant"),
		row("dash", "via", "Operator (dashboard)", "billing?", { dashboard_id: "dc-20261006080000-89abcdef" }),
		row("reply", "say", "Assistant"),
		row("tool", "tool", "assistant"),
		row("answer", "tool", "assistant", "answer", { answer_id: "ans-a1b2c3d4e5f6" }),
		row("relay", "system", "cp-bridge"),
		row("after-relay", "say", "Assistant"),
		row("tui", "say", "Operator", "from the TUI"),
		row("ask-call", "tool", "assistant", "ask", { ask_id: "ask-abcd" }),
		row("ask-card", "ask", "Operator → you", "q", { ask_id: "ask-abcd" }),
		row("asked", "say", "Assistant"),
		row("replay", "say", "Operator", `${INBOX_REPLAY_PREFIX}1 message(s) typed while this session was offline]\n- x (dc-20261006080000-89abcdef): hi`),
		row("after-replay", "say", "Assistant"),
		row("plain", "say", "Operator", "unbound"),
		row("plain-reply", "say", "Assistant"),
	];
	assignThreads(entries, refs);
	assert.deepEqual(tags(entries), [
		"pre=-", // before the first opener: own ref only
		"dash=th-aaaaaaaaaaaa",
		"reply=th-aaaaaaaaaaaa",
		"tool=th-aaaaaaaaaaaa",
		"answer=th-bbbbbbbbbbbb", // its own ref beats the turn
		"relay=shared",
		"after-relay=-", // the relay ended the turn
		"tui=th-cccccccccccc", // an unbound TUI turn takes the first own ref in it
		"ask-call=th-cccccccccccc",
		"ask-card=th-cccccccccccc",
		"asked=th-cccccccccccc",
		"replay=shared", // the inbox replay is shared, never an opener, though it names a bound dc- id
		"after-replay=-",
		"plain=-",
		"plain-reply=-",
	]);
});

test("turn rule: with no refs every entry is unthreaded and system entries are still shared", () => {
	const entries = [row("a", "say", "Operator"), row("b", "system", "compaction"), row("c", "say", "Assistant")];
	assignThreads(entries, new Map());
	assert.deepEqual(tags(entries), ["a=-", "b=shared", "c=-"]);
});

function fixture(t: { after: (fn: () => void) => void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const dir = mkdtempSync(join(tmpdir(), "cp-thread-turns-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	const at = "2026-10-06T08:00:00Z";
	const message = (m: unknown) => JSON.stringify({ type: "message", timestamp: at, message: m });
	const toolCall = (id: string, args: unknown, result: string) => [
		message({ role: "assistant", content: [{ type: "toolCall", id, name: "cp_parent", arguments: args }] }),
		message({ role: "toolResult", toolCallId: id, toolName: "cp_parent", content: [{ type: "text", text: result }] }),
	];
	writeFileSync(
		file,
		[
			message({ role: "user", content: [{ type: "text", text: "billing?\n\n[cp-dashboard dc-20261006080000-89abcdef — from the dashboard]" }] }),
			message({ role: "assistant", content: [{ type: "text", text: "looking" }] }),
			...toolCall("call-ans", { action: "answer", job_id: "cp-x" }, "answer: ans-a1b2c3d4e5f6 posted to the dashboard (bookkeeping only; no push)"),
			JSON.stringify({ type: "custom_message", timestamp: at, customType: "cp-bridge", content: "[cp-bridge cp-ci job=cp-x]\nCI green" }),
			message({ role: "user", content: [{ type: "text", text: "from the TUI" }] }),
			...toolCall("call-ask", { action: "ask", ask: {} }, JSON.stringify({ id: "ask-abcd", state: "open" })),
			message({ role: "assistant", content: [{ type: "text", text: "asked" }] }),
			...toolCall("call-dup", { action: "answer", job_id: "cp-x" }, "answer: cp-x already posted as ans-0000000000ff; nothing written"),
		].join("\n") + "\n",
	);
	const record = operatorSessionsFile(join(stateDir, "sessions"));
	mkdirSync(dirname(record), { recursive: true });
	writeFileSync(record, JSON.stringify({ at, session_file: file }) + "\n");
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	writeFileSync(join(stateDir, "operator/asks.jsonl"), JSON.stringify({ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: at, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] }) + "\n");
	const view = () => sessionsView({ home: home.path, stateDir }, "you", null, { transcript: true, now: Date.parse(at) })!;
	return { stateDir, view };
}

test("Full transcript: entries carry the thread their turn or own ref is filed under; relays stay shared", (t) => {
	const { stateDir, view } = fixture(t);
	const open = (id: string, tag: string) => ({ type: "open", by: "viewer", id, at: "2026-10-06T08:00:00Z", tag, peer: null });
	const bind = (thread: string, kind: string, id: string) => ({ type: "bind", by: "bridge", at: "2026-10-06T08:00:00Z", thread, ref: { kind, id }, peer: null });
	writeFileSync(
		operatorThreadsFile(stateDir),
		[
			open("th-aaaaaaaaaaaa", "billing"),
			open("th-cccccccccccc", "caps"),
			bind("th-aaaaaaaaaaaa", "dashboard", "dc-20261006080000-89abcdef"),
			bind("th-cccccccccccc", "ask", "ask-abcd"),
			bind("th-aaaaaaaaaaaa", "answer", "ans-0000000000ff"),
			bind("th-cccccccccccc", "answer", "ans-0000000000ff"), // bound twice: the newest bind wins
		]
			.map((line) => JSON.stringify(line))
			.join("\n") + "\n",
	);
	const full = view();
	assert.deepEqual(full.warnings, []);
	assert.deepEqual(
		full.entries.map((e) => `${e.kind}:${e.answer_id ?? e.ask_id ?? e.text}=${e.shared ? "shared" : (e.thread ?? "-")}`),
		[
			"via:billing?=th-aaaaaaaaaaaa",
			"say:looking=th-aaaaaaaaaaaa",
			"tool:ans-a1b2c3d4e5f6=th-aaaaaaaaaaaa", // posted answer id parsed; unbound, so it takes the turn's thread
			"system:CI green=shared",
			"say:from the TUI=th-cccccccccccc",
			"tool:ask-abcd=th-cccccccccccc",
			"ask:ask-abcd=th-cccccccccccc",
			"say:asked=th-cccccccccccc",
			"tool:ans-0000000000ff=th-cccccccccccc", // the duplicate text's first id, filed by its newest bind
		],
	);
});

test("Full transcript: a missing threads journal adds no thread and no warning; an unreadable one is named", (t) => {
	const { stateDir, view } = fixture(t);
	const missing = view();
	assert.deepEqual(missing.warnings, []);
	assert.ok(missing.entries.every((e) => e.thread === undefined));
	assert.deepEqual(missing.entries.filter((e) => e.shared).map((e) => e.kind), ["system"]);
	mkdirSync(operatorThreadsFile(stateDir)); // a directory: unreadable
	const unreadable = view();
	assert.equal(unreadable.warnings.length, 1);
	assert.match(unreadable.warnings[0]!, /^threads unavailable: .*threads\.jsonl/);
	assert.ok(unreadable.entries.every((e) => e.thread === undefined));
	assert.equal(unreadable.entries.length, missing.entries.length, "the transcript itself still renders");
});
