/**
 * cp-xmw2 S1: the operator thread journal (`state/operator/threads.jsonl`): its fold (`readThreads`), the tag rule
 * (`normalizeThreadTag`) and the writer (`appendThreadLine`, `bindThread`). Hermetic: a scratch home, no model.
 */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { appendThreadLine, bindThread } from "../src/viewer/control-audit.ts";
import { normalizeThreadTag, operatorThreadsFile, readThreads, THREADS_MAX_BYTES, type ThreadLine } from "../src/viewer/control-files.ts";
import { createScratchHome } from "./harness/index.ts";

const A = "th-0123456789ab";
const B = "th-ba9876543210";
const DC = "dc-20261006080000-89abcdef";
const ANS = "ans-a1b2c3d4e5f6";
const ASK = "ask-0a1b";
const T0 = "2026-10-06T08:00:00Z";
const T1 = "2026-10-06T08:01:10Z";
const T2 = "2026-10-06T09:00:00Z";

function bench(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const file = operatorThreadsFile(stateDir);
	const append = (line: ThreadLine) => assert.deepEqual(appendThreadLine(stateDir, line), { ok: true });
	const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row) as ThreadLine);
	return { stateDir, file, append, lines };
}

test("normalizeThreadTag: trim, ASCII-lowercase, whitespace runs to '-'; anything else that is not a tag is null", () => {
	assert.equal(normalizeThreadTag("Billing Bug"), "billing-bug");
	assert.equal(normalizeThreadTag("  Q3   plan\tB "), "q3-plan-b");
	assert.equal(normalizeThreadTag("x".repeat(32)), "x".repeat(32));
	for (const bad of ["-x", "x".repeat(33), "", "   ", "bad tag!", "café", "a_b", null, 7, undefined]) assert.equal(normalizeThreadTag(bad), null, String(bad));
});

test("a missing journal is exists:false with nothing in it; nothing creates the file until a thread is used", (t) => {
	const b = bench(t);
	const read = readThreads(b.stateDir);
	assert.deepEqual([read.exists, read.threads, read.refs.size, read.skipped, read.error], [false, [], 0, 0, null]);
	assert.equal(existsSync(b.file), false);
});

test("fold: open, bind and done in line order; a later bind reopens; the newest bind of a ref wins", (t) => {
	const b = bench(t);
	b.append({ type: "open", by: "viewer", id: A, at: T0, tag: "billing-bug", peer: "100.64.0.7" });
	b.append({ type: "bind", by: "viewer", at: T0, thread: A, ref: { kind: "dashboard", id: DC }, peer: "100.64.0.7" });
	b.append({ type: "bind", by: "bridge", at: T1, thread: A, ref: { kind: "answer", id: ANS }, peer: null });
	b.append({ type: "done", by: "viewer", id: A, at: T2, peer: "100.64.0.7" });
	let read = readThreads(b.stateDir);
	assert.equal(read.error, null);
	assert.equal(read.skipped, 0);
	const [thread] = read.threads;
	assert.deepEqual(thread, {
		id: A, tag: "billing-bug", opened_at: T0, last_bind_line: 2, last_at: T1, done_line: 3, done_at: T2,
		refs: [{ ref: { kind: "dashboard", id: DC }, at: T0, line: 1 }, { ref: { kind: "answer", id: ANS }, at: T1, line: 2 }],
	});
	assert.ok(thread!.done_line! > thread!.last_bind_line!, "done after the last bind");
	assert.deepEqual([...read.refs], [[`dashboard:${DC}`, A], [`answer:${ANS}`, A]]);

	b.append({ type: "open", by: "bridge", id: B, at: T2, tag: "other", peer: null });
	b.append({ type: "bind", by: "bridge", at: T2, thread: B, ref: { kind: "answer", id: ANS }, peer: null });
	b.append({ type: "bind", by: "bridge", at: T2, thread: A, ref: { kind: "ask", id: ASK }, peer: null });
	read = readThreads(b.stateDir);
	assert.equal(read.refs.get(`answer:${ANS}`), B, "the newest bind wins");
	const a = read.threads.find((item) => item.id === A)!;
	assert.equal(a.last_bind_line, 6);
	assert.ok(a.done_line! < a.last_bind_line!, "a later bind reopens the thread");
});

test("fold: a second open of one tag aliases to the first id; binds and done to either id land in one thread", (t) => {
	const b = bench(t);
	b.append({ type: "open", by: "viewer", id: A, at: T0, tag: "race", peer: null });
	b.append({ type: "open", by: "bridge", id: B, at: T0, tag: "race", peer: null });
	b.append({ type: "bind", by: "bridge", at: T1, thread: B, ref: { kind: "answer", id: ANS }, peer: null });
	b.append({ type: "bind", by: "viewer", at: T1, thread: A, ref: { kind: "dashboard", id: DC }, peer: null });
	b.append({ type: "done", by: "viewer", id: B, at: T2, peer: null });
	const read = readThreads(b.stateDir);
	assert.equal(read.skipped, 0);
	assert.deepEqual(read.threads.map((item) => [item.id, item.tag, item.refs.length, item.done_at]), [[A, "race", 2, T2]]);
	assert.deepEqual([...read.refs], [[`answer:${ANS}`, A], [`dashboard:${DC}`, A]]);
});

test("fold: bad lines, unknown threads, bad refs, repeated open ids and unknown types count in skipped; a repeat bind is ignored", (t) => {
	const b = bench(t);
	b.append({ type: "open", by: "viewer", id: A, at: T0, tag: "one", peer: null });
	b.append({ type: "bind", by: "viewer", at: T0, thread: A, ref: { kind: "dashboard", id: DC }, peer: null });
	b.append({ type: "bind", by: "viewer", at: T1, thread: A, ref: { kind: "dashboard", id: DC }, peer: null }); // repeat: ignored, not counted
	const raw = [
		"not json",
		"null",
		JSON.stringify({ type: "open", by: "viewer", id: A, at: T1, tag: "again", peer: null }), // repeated id
		JSON.stringify({ type: "open", by: "viewer", id: "th-xyz", at: T1, tag: "bad-id", peer: null }),
		JSON.stringify({ type: "open", by: "viewer", id: B, at: T1, tag: "Bad Tag", peer: null }),
		JSON.stringify({ type: "bind", by: "viewer", at: T1, thread: B, ref: { kind: "dashboard", id: DC }, peer: null }), // unknown thread
		JSON.stringify({ type: "bind", by: "viewer", at: T1, thread: A, ref: { kind: "dashboard", id: "dc-1" }, peer: null }),
		JSON.stringify({ type: "bind", by: "viewer", at: T1, thread: A, ref: { kind: "answer", id: "ans-short" }, peer: null }),
		JSON.stringify({ type: "bind", by: "viewer", at: T1, thread: A, ref: { kind: "job", id: "../cp-1" }, peer: null }),
		JSON.stringify({ type: "bind", by: "viewer", at: T1, thread: A, ref: { kind: "dashboard", id: [DC] }, peer: null }),
		JSON.stringify({ type: "done", by: "viewer", id: B, at: T1, peer: null }), // unknown thread
		JSON.stringify({ type: "done", by: "bridge", id: A, at: T1, peer: null }), // done is the viewer's
		JSON.stringify({ type: "rename", by: "viewer", id: A, at: T1, tag: "two", peer: null }), // reserved
		JSON.stringify({ type: "done", by: "viewer", id: A, at: "2026-10-06T09:00:00.123Z", peer: null }), // bad at
		JSON.stringify({ type: "done", by: "someone", id: A, at: T1, peer: null }), // bad by
		JSON.stringify({ type: "done", by: "viewer", id: A, at: T1 }), // no peer
	];
	appendFileSync(b.file, `${raw.join("\n")}\n`);
	const read = readThreads(b.stateDir);
	assert.equal(read.skipped, raw.length);
	assert.deepEqual(read.threads.map((item) => [item.id, item.tag, item.refs.length, item.last_bind_line, item.last_at, item.done_line]), [[A, "one", 1, 1, T0, null]]);
});

test("fold: a torn last line is ignored; an oversized or unreadable journal is an error that names the file", (t) => {
	const b = bench(t);
	b.append({ type: "open", by: "viewer", id: A, at: T0, tag: "one", peer: null });
	appendFileSync(b.file, `{"type":"bind","by":"viewer","at":"${T1}","thread":"${A}"`);
	const torn = readThreads(b.stateDir);
	assert.deepEqual([torn.threads.length, torn.skipped, torn.error], [1, 0, null]);

	writeFileSync(b.file, Buffer.alloc(THREADS_MAX_BYTES + 1, 0x20));
	const big = readThreads(b.stateDir);
	assert.equal(big.exists, true);
	assert.deepEqual(big.threads, []);
	assert.match(big.error ?? "", /threads\.jsonl is \d+ bytes, over the 16777216 byte cap; move it aside/);

	const dir = bench(t);
	mkdirSync(dir.file, { recursive: true });
	assert.match(readThreads(dir.stateDir).error ?? "", /threads\.jsonl: /);
});

test("bindThread: opens a tag once, binds, is idempotent per ref, writes 0600 under a 0700 dir", (t) => {
	const b = bench(t);
	const first = bindThread(b.stateDir, { tag: "billing-bug", ref: { kind: "dashboard", id: DC }, by: "viewer", peer: "100.64.0.7", at: T0 });
	assert.ok(first.ok);
	assert.match(first.thread, /^th-[a-f0-9]{12}$/);
	assert.deepEqual([first.tag, first.opened], ["billing-bug", true]);
	assert.equal(statSync(b.file).mode & 0o777, 0o600);
	assert.equal(statSync(join(b.stateDir, "operator")).mode & 0o777, 0o700);

	const second = bindThread(b.stateDir, { tag: "billing-bug", ref: { kind: "answer", id: ANS }, by: "bridge", peer: null, at: T1 });
	assert.deepEqual(second, { ok: true, thread: first.thread, tag: "billing-bug", opened: false });
	const again = bindThread(b.stateDir, { tag: "billing-bug", ref: { kind: "answer", id: ANS }, by: "bridge", peer: null, at: T2 });
	assert.deepEqual(again, second);
	assert.deepEqual(b.lines(), [
		{ type: "open", by: "viewer", id: first.thread, at: T0, tag: "billing-bug", peer: "100.64.0.7" },
		{ type: "bind", by: "viewer", at: T0, thread: first.thread, ref: { kind: "dashboard", id: DC }, peer: "100.64.0.7" },
		{ type: "bind", by: "bridge", at: T1, thread: first.thread, ref: { kind: "answer", id: ANS }, peer: null },
	]);
	const read = readThreads(b.stateDir);
	assert.deepEqual([read.skipped, read.threads.length, read.refs.get(`dashboard:${DC}`), read.refs.get(`answer:${ANS}`)], [0, 1, first.thread, first.thread]);
});

test("bindThread never throws: a bad tag or ref writes nothing; an unreadable journal or failed append is an error", (t) => {
	const b = bench(t);
	const ref = { kind: "ask", id: ASK } as const;
	const badTag = bindThread(b.stateDir, { tag: "Billing Bug", ref, by: "bridge", peer: null, at: T0 });
	assert.deepEqual(badTag, { ok: false, error: 'thread tag "Billing Bug" is not normalized (1-32 of a-z 0-9 -, first a letter or digit)' });
	const badRef = bindThread(b.stateDir, { tag: "ok", ref: { kind: "ask", id: "ask-XYZ" }, by: "bridge", peer: null, at: T0 });
	assert.equal(badRef.ok, false);
	assert.equal(existsSync(b.file), false);

	mkdirSync(b.file, { recursive: true });
	const unreadable = bindThread(b.stateDir, { tag: "ok", ref, by: "bridge", peer: null, at: T0 });
	assert.equal(unreadable.ok, false);
	assert.match(unreadable.ok ? "" : unreadable.error, /threads\.jsonl: /);

	const readOnly = bench(t);
	readOnly.append({ type: "open", by: "viewer", id: A, at: T0, tag: "ok", peer: null });
	chmodSync(readOnly.file, 0o400);
	if (process.getuid?.() !== 0) assert.deepEqual(bindThread(readOnly.stateDir, { tag: "ok", ref, by: "bridge", peer: null, at: T1 }), { ok: false, error: `${readOnly.file}: EACCES` });
});

test("job refs fold like other refs: valid job contract ids, newest bind wins, repeats are idempotent", (t) => {
	const b = bench(t);
	const bind = (tag: string, id: string) => bindThread(b.stateDir, { tag, ref: { kind: "job", id }, by: "bridge", peer: null, at: T0 });
	for (const id of ["cp-one", "other_TWO-2", "9", "x".repeat(128)]) assert.ok(bind("one", id).ok);
	assert.equal(b.lines().length, 5);
	assert.ok(bind("one", "cp-one").ok);
	assert.equal(b.lines().length, 5);
	const moved = bind("two", "cp-one");
	assert.ok(moved.ok);
	const read = readThreads(b.stateDir);
	assert.equal(read.skipped, 0);
	assert.equal(read.refs.get("job:cp-one"), moved.thread);
	for (const id of ["", "../cp-one", "cp/one", "cp.one", "x".repeat(129)]) assert.equal(bind("bad", id).ok, false);
	assert.equal(b.lines().length, 7, "invalid refs open no thread");
});

test("job ids matching legacy ref ids bind, deduplicate and move independently by kind", (t) => {
	const b = bench(t);
	const refs = [{ kind: "dashboard", id: DC }, { kind: "ask", id: ASK }, { kind: "answer", id: ANS }] as const;
	const bind = (tag: string, ref: (typeof refs)[number] | { kind: "job"; id: string }) => bindThread(b.stateDir, { tag, ref, by: "bridge", peer: null, at: T1 });
	for (const ref of refs) {
		assert.ok(bind("one", ref).ok);
		assert.ok(bind("one", { kind: "job", id: ref.id }).ok);
	}
	assert.equal(b.lines().length, 7, "each kind gets its own unchanged journal bind line");
	assert.equal(readThreads(b.stateDir).threads[0]!.refs.length, 6, "the fold retains both kinds in one thread");
	for (const ref of refs) {
		assert.ok(bind("one", ref).ok);
		assert.ok(bind("one", { kind: "job", id: ref.id }).ok);
	}
	assert.equal(b.lines().length, 7, "repeats are idempotent per kind and id");
	for (const ref of refs) assert.ok(bind("two", ref).ok);
	const read = readThreads(b.stateDir);
	assert.equal(read.skipped, 0);
	assert.equal(read.refs.size, 6);
	for (const ref of refs) {
		assert.equal(read.refs.get(`${ref.kind}:${ref.id}`), read.threads[1]!.id);
		assert.equal(read.refs.get(`job:${ref.id}`), read.threads[0]!.id, "moving the legacy ref leaves the job filed");
	}
	assert.ok(bind("two", { kind: "job", id: DC }).ok);
	assert.ok(bind("one", { kind: "job", id: DC }).ok);
	assert.equal(readThreads(b.stateDir).threads[1]!.refs.length, 4, "a distinct job ref is retained alongside the dashboard ref");
	assert.equal(readThreads(b.stateDir).refs.get(`dashboard:${DC}`), read.threads[1]!.id, "moving the job leaves the dashboard filed");
});
