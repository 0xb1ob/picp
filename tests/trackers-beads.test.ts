import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adapterFor, TrackerError } from "../src/trackers/adapter.ts";
import { beadsAdapter, type BrRunner } from "../src/trackers/beads.ts";

function scratch(t: { after(fn: () => void): void }): { dir: string; db: string } {
	const dir = mkdtempSync(join(tmpdir(), "trackers-beads-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, ".beads"));
	const db = join(dir, ".beads", "beads.db");
	writeFileSync(db, "");
	return { dir, db };
}

const reply = (stdout: unknown, code = 0, stderr = ""): Awaited<ReturnType<BrRunner>> => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });

test("probe pins --db read-only, accepts the .beads dir, and returns the realpath of the database", async (t) => {
	const { dir, db } = scratch(t);
	const calls: Array<{ args: readonly string[]; cwd: string; timeoutMs: number }> = [];
	const adapter = beadsAdapter(async (args, opts) => (calls.push({ args, ...opts }), reply({ issues: [], total: 0 })));
	assert.equal(await adapter.probe(join(dir, ".beads")), db);
	assert.deepEqual(calls[0], { args: ["--db", db, "--no-auto-flush", "--no-auto-import", "list", "--json", "--limit", "1"], cwd: join(dir, ".beads"), timeoutMs: 10_000 });
	assert.equal(await adapter.probe(db), db);
});

test("probe refuses a relative path, a missing database without running br, and output that is not {issues:[...]}", async (t) => {
	const { dir, db } = scratch(t);
	let calls = 0;
	const run: BrRunner = async () => (calls++, reply({ issues: [] }));
	await assert.rejects(beadsAdapter(run).probe(".beads/beads.db"), /absolute path/);
	await assert.rejects(beadsAdapter(run).probe(join(dir, "missing.db")), /no beads database at .*missing\.db \(br would create one; refusing\)/);
	await assert.rejects(beadsAdapter(run).probe(join(dir, "nowhere")), TrackerError);
	assert.equal(calls, 0, "br never runs against a path that does not exist");
	await assert.rejects(beadsAdapter(async () => reply([{ id: "x" }])).probe(db), /br cannot read/);
	await assert.rejects(beadsAdapter(async () => reply("", 1, "database is locked")).probe(db), /database is locked/);
});

test("get distinguishes found, missing (exit 3 + ISSUE_NOT_FOUND) and error", async (t) => {
	const { db } = scratch(t);
	let args: readonly string[] = [];
	const row = { id: "cp-1", title: "One", status: "open", description: "Body", issue_type: "task", labels: ["x"] };
	const found = await beadsAdapter(async (a) => (args = a, reply([row]))).get(db, "cp-1");
	assert.deepEqual(args, ["--db", db, "--no-auto-flush", "--no-auto-import", "show", "cp-1", "--json"]);
	assert.deepEqual(found, { status: "found", item: row });
	assert.deepEqual(await beadsAdapter(async () => reply({ error: { code: "ISSUE_NOT_FOUND", message: "no" } }, 3)).get(db, "cp-2"), { status: "missing" });
	const failed = await beadsAdapter(async () => reply("", 1, "boom")).get(db, "cp-1");
	assert.equal(failed.status, "error");
	const mismatch = await beadsAdapter(async () => reply([{ ...row, id: "cp-other" }])).get(db, "cp-1");
	assert.deepEqual(mismatch, { status: "error", message: "br show cp-1 returned cp-other" });
	assert.equal((await beadsAdapter(async () => reply([{ id: "cp-1" }])).get(db, "cp-1")).status, "error");
	assert.equal((await beadsAdapter(async () => { throw new Error("must not run"); }).get(db, "../etc")).status, "error");
});

test("listReady runs br ready --limit 0, drops epics and deferred, and throws on a malformed row", async (t) => {
	const { db } = scratch(t);
	let args: readonly string[] = [];
	const rows = [
		{ id: "b-1", title: "t", status: "open", issue_type: "task", labels: [] },
		{ id: "b-epic", issue_type: "epic" },
		{ id: "b-later", issue_type: "task", labels: ["deferred"] },
	];
	const ready = await beadsAdapter(async (a) => (args = a, reply(rows))).listReady(db);
	assert.deepEqual(args, ["--db", db, "--no-auto-flush", "--no-auto-import", "ready", "--json", "--limit", "0"]);
	assert.deepEqual(ready.map((item) => item.id), ["b-1"]);
	await assert.rejects(beadsAdapter(async () => reply([{ id: "b-bad", labels: "deferred" }])).listReady(db), /invalid bead/);
	await assert.rejects(beadsAdapter(async () => reply({ not: "array" })).listReady(db), /array/);
	await beadsAdapter(async (a) => (args = a, reply([]))).listReady(db, { parent: "b-epic" });
	assert.deepEqual(args.slice(-2), ["--parent", "b-epic"]);
	await assert.rejects(beadsAdapter(async () => reply([])).listReady(db, { parent: "bad id" }), /invalid epic id/);
});

/** Replies in order; records every argv. */
function script(replies: Array<Awaited<ReturnType<BrRunner>>>): { run: BrRunner; calls: Array<readonly string[]> } {
	const calls: Array<readonly string[]> = [];
	return { calls, run: async (args) => (calls.push(args), replies.shift() ?? reply("", 99, "unexpected br call")) };
}

test("close pins --db, never forces, and trusts only a read-back that says closed", async (t) => {
	const { db } = scratch(t);
	const open = [{ id: "b-1", title: "t", status: "open", issue_type: "task" }];
	const closed = [{ id: "b-1", title: "t", status: "closed", issue_type: "task" }];
	const ok = script([reply(open), reply([{ id: "b-1", status: "closed" }]), reply(closed)]);
	assert.deepEqual(await beadsAdapter(ok.run).close(db, "b-1", "CP cp-x merged"), { status: "applied" });
	assert.deepEqual(ok.calls[1], ["--db", db, "close", "b-1", "--reason", "CP cp-x merged", "--json"]);
	assert.ok(ok.calls.every((args) => !args.includes("--force") && !args.includes("--bypass-policy")));
	assert.deepEqual(await beadsAdapter(script([reply(closed)]).run).close(db, "b-1", "r"), { status: "already" });
	assert.deepEqual(await beadsAdapter(script([reply(open), reply({ error: { code: "NOTHING_TO_DO" } }, 3)]).run).close(db, "b-1", "r"), { status: "already" });
	assert.equal((await beadsAdapter(script([reply(open), reply([]), reply(open)]).run).close(db, "b-1", "r")).status, "retryable", "acknowledged but still open");
	assert.equal((await beadsAdapter(script([reply(open), reply("", 1, "locked")]).run).close(db, "b-1", "r")).status, "retryable");
	assert.equal((await beadsAdapter(script([reply({ error: { code: "ISSUE_NOT_FOUND" } }, 3)]).run).close(db, "b-1", "r")).status, "refused");
	const gone = script([]);
	assert.equal((await beadsAdapter(gone.run).close(join(db, "..", "missing.db"), "b-1", "r")).status, "retryable");
	assert.equal(gone.calls.length, 0, "br never runs against a database that does not exist");
});

test("comment lists first, dedupes by marker, and holds an acknowledged add it cannot see as ambiguous", async (t) => {
	const { db } = scratch(t);
	// Row shape captured from br 0.5.7 against a scratch `br init` database.
	const row = (text: string) => ({ id: 1, issue_id: "b-1", author: "cp", text, created_at: "2026-09-27T03:32:12Z" });
	const ok = script([reply([]), reply(row("CP [cp:abc]")), reply([row("CP [cp:abc]")])]);
	assert.deepEqual(await beadsAdapter(ok.run).comment(db, "b-1", "CP [cp:abc]", "[cp:abc]"), { status: "applied" });
	assert.deepEqual(ok.calls[0], ["--db", db, "--no-auto-flush", "--no-auto-import", "comments", "b-1", "--json"]);
	assert.deepEqual(ok.calls[1], ["--db", db, "comments", "add", "b-1", "--message", "CP [cp:abc]", "--json"]);
	const seen = script([reply([row("older CP [cp:abc]")])]);
	assert.deepEqual(await beadsAdapter(seen.run).comment(db, "b-1", "CP [cp:abc]", "[cp:abc]"), { status: "already" });
	assert.equal(seen.calls.length, 1, "a marker already present is never re-appended");
	assert.equal((await beadsAdapter(script([reply([]), reply(row("x")), reply([])]).run).comment(db, "b-1", "CP [cp:abc]", "[cp:abc]")).status, "ambiguous");
	assert.equal((await beadsAdapter(script([reply([]), reply("", 1, "locked")]).run).comment(db, "b-1", "CP [cp:abc]", "[cp:abc]")).status, "retryable");
	assert.equal((await beadsAdapter(script([reply({ error: { code: "ISSUE_NOT_FOUND" } }, 3)]).run).comment(db, "b-1", "t", "[cp:abc]")).status, "refused");
});

test("adapterFor refuses github visibly until B6", () => {
	assert.equal(adapterFor("beads").name, "beads");
	assert.throws(() => adapterFor("github"), (error: unknown) => error instanceof TrackerError && /github: adapter not implemented \(B6\)/.test(error.message));
});
