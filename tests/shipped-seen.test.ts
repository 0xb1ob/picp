/**
 * cp-b5eg: the status block's Shipped memory survives an extension reload.
 *
 * The defect these tests pin is not in `renderShipped` — that function was
 * always correct and is pure. It was in where the already-shown set lived: a
 * `Set` in the extension's activation closure, reset in the `session_start`
 * handler, which pi also fires with `reason: "reload"` for a *rebind inside the
 * same session*. Any reload dropped the memory, so the very next block replayed
 * the whole session's shipped history (~80 rows observed) and every block after
 * it collapsed again, because the replaying render refilled the set.
 *
 * The regression test is
 * "a reloaded extension in the same session still collapses Shipped": it
 * constructs a second `ShippedSeenStore` for the same session id, which is what
 * a reload does, and fails against the old in-closure design.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	LAYOUT,
	SHIPPED_SEEN_KEEP_SESSIONS,
	SHIPPED_SEEN_MAX_IDS,
	type StatusSnapshot,
	type WorkerHandle,
} from "../src/contracts.ts";
import { assembleStatus, type StatusFacts } from "../src/status.ts";
import { REPO_ROOT } from "./harness/index.ts";
import { renderSessionStatusBlock, ShippedSeenStore } from "../src/shipped-seen.ts";
import type { StatusBlockInput } from "../src/status-block.ts";

const NOW = "2026-09-02T12:00:00Z";
const SESSION = "sess-parent-1";

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-shipped-seen-"));
	return dir;
}

function shipped(jobId: string, pull: number): FleetRecord {
	return {
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "done",
		worktree: `/home/operator/.treehouse/demo/${jobId}`,
		branch: jobId,
		dispatched_at: "2026-09-02T11:00:00Z",
		usage: { ...EMPTY_USAGE },
		job_id: jobId,
		closed_at: NOW,
		closed_reason: "gated",
		reported_at: NOW,
		receipts: [{ kind: "pr", status: "merged", title: `PR for ${jobId}`, url: `https://github.com/acme/repo/pull/${pull}` }],
		worker: {
			pid: 4242,
			session_id: `sess-${jobId}`,
			session_file: `/sessions/${jobId}.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-09-02T11:00:00Z",
			exited_at: NOW,
			exit_code: 0,
		} as WorkerHandle,
	} as FleetRecord;
}

function snapshot(records: FleetRecord[], overrides: Partial<StatusFacts> = {}): StatusSnapshot {
	return assembleStatus({
		home: "/home/operator/pi-command-post",
		generated_at: NOW,
		include: "all",
		records,
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
		...overrides,
	});
}

/** The observed shape: the render that replayed also changed awaiting and labels. */
function withJudgment(jobId: string): StatusBlockInput {
	return {
		labels: [{ job_id: jobId, label: "the status block's Shipped section" }],
		awaiting: [
			{
				type: "approval",
				decision: "Ship cp-x, drop it, or open a follow-up?",
				why: "the research finished and nothing is dispatched",
				blocks: "the follow-up job",
			},
		],
	};
}

test("a second render in the same session collapses Shipped to the count, not the rows", () => {
	const dir = home();
	try {
		const store = new ShippedSeenStore({ home: dir });
		const snap = snapshot([shipped("cp-one", 1), shipped("cp-two", 2)]);

		const first = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });
		assert.match(first.text, /Shipped:\n {2}- cp-one/);
		assert.match(first.text, /cp-two/);
		assert.deepEqual(first.warnings, []);

		const second = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });
		assert.match(second.text, /Shipped: none new \(2 already reported\)/);
		assert.ok(!second.text.includes("pull/1"), "a repeated Shipped row leaked through");
		assert.ok(!second.text.includes("pull/2"), "a repeated Shipped row leaked through");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the collapse holds when the render also changes the awaiting set and supplies new labels", () => {
	const dir = home();
	try {
		const store = new ShippedSeenStore({ home: dir });
		const snap = snapshot([shipped("cp-one", 1)]);

		renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });
		const second = renderSessionStatusBlock({
			store,
			sessionId: SESSION,
			snapshot: snap,
			input: withJudgment("cp-one"),
		});

		assert.match(second.text, /Shipped: none new \(1 already reported\)/);
		assert.ok(!second.text.includes("pull/1"), "labels/awaiting must not resurrect a reported Shipped row");
		// The awaiting change itself still rendered: this is not a "nothing happened" pass.
		assert.match(second.text, /Ship cp-x, drop it, or open a follow-up\?/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("REGRESSION (cp-b5eg): a reloaded extension in the same session still collapses Shipped", () => {
	const dir = home();
	try {
		const snap = snapshot([shipped("cp-one", 1), shipped("cp-two", 2)]);
		// The first extension instance renders the block and reports both rows.
		const before = new ShippedSeenStore({ home: dir });
		const first = renderSessionStatusBlock({ store: before, sessionId: SESSION, snapshot: snap });
		assert.match(first.text, /Shipped:\n {2}- cp-one/);

		// `/reload` (or any rebind): session_shutdown, a NEW extension instance,
		// session_start with reason "reload" — same session, same session id, and
		// every in-closure variable gone. This is the render that replayed.
		const afterReload = new ShippedSeenStore({ home: dir });
		const second = renderSessionStatusBlock({
			store: afterReload,
			sessionId: SESSION,
			snapshot: snap,
			input: withJudgment("cp-one"),
		});

		assert.match(second.text, /Shipped: none new \(2 already reported\)/);
		assert.ok(!second.text.includes("pull/1"), "the session's shipped history replayed after a reload");
		assert.ok(!second.text.includes("pull/2"), "the session's shipped history replayed after a reload");
		assert.deepEqual(second.warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a job shipped between two renders appears exactly once, in the second", () => {
	const dir = home();
	try {
		const store = new ShippedSeenStore({ home: dir });
		const before = snapshot([shipped("cp-one", 1)]);
		const after = snapshot([shipped("cp-one", 1), shipped("cp-new", 9)]);

		const first = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: before });
		assert.match(first.text, /Shipped:\n {2}- cp-one/);
		assert.ok(!first.text.includes("cp-new"));

		const second = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: after });
		assert.match(second.text, /Shipped:\n {2}- cp-new — cp-new: https:\/\/github\.com\/acme\/repo\/pull\/9/);
		assert.ok(!second.text.includes("pull/1"), "an already-reported job repeated alongside the new one");

		const third = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: after });
		assert.match(third.text, /Shipped: none new \(2 already reported\)/);
		assert.ok(!third.text.includes("pull/9"), "the new job repeated on the render after it was reported");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a genuinely new session starts empty — the memory is keyed by session id", () => {
	const dir = home();
	try {
		const store = new ShippedSeenStore({ home: dir });
		const snap = snapshot([shipped("cp-one", 1)]);
		renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });

		const fresh = renderSessionStatusBlock({ store, sessionId: "sess-parent-2", snapshot: snap });
		assert.match(fresh.text, /Shipped:\n {2}- cp-one/);
		// …and the first session's memory is untouched by the second's.
		const back = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });
		assert.match(back.text, /Shipped: none new \(1 already reported\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a corrupt memory names the file and the remedy, is rebuilt, and recovers on the next render", () => {
	const dir = home();
	try {
		const file = join(dir, LAYOUT.shippedSeenFile);
		mkdirSync(join(dir, LAYOUT.state), { recursive: true });
		writeFileSync(file, "{ not json", "utf8");
		const store = new ShippedSeenStore({ home: dir });
		const snap = snapshot([shipped("cp-one", 1)]);

		const first = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });
		assert.match(first.text, /Shipped:\n {2}- cp-one/, "a corrupt memory must degrade to a replay, never to a throw");
		const said = first.warnings.join(" | ");
		// Actionable, not just true: the warning names the file and the remedy.
		assert.match(said, /Shipped memory unreadable/);
		assert.ok(said.includes(LAYOUT.shippedSeenFile), `the warning must name the file, got: ${said}`);
		assert.match(said, /safe to delete/);
		assert.match(said, /rebuilt/);

		// Rebuilt, so the degradation is one render long and not permanent: a fresh
		// instance (a reload) reads a valid file and collapses.
		const afterReload = new ShippedSeenStore({ home: dir });
		const second = renderSessionStatusBlock({ store: afterReload, sessionId: SESSION, snapshot: snap });
		assert.match(second.text, /Shipped: none new \(1 already reported\)/);
		assert.deepEqual(second.warnings, [], "the memory was rebuilt; nothing should still be degraded");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rebind that DOES change the session id replays once, and neither throws nor corrupts the store", () => {
	// The evidence for cp-b5eg is that a reload keeps the session id (see
	// docs/contracts.md §The status block's Shipped memory). This pins the other
	// branch anyway: if a rebind ever produced a *new* id, the contract says a new
	// session reports everything once, and nothing may be lost or thrown doing it.
	const dir = home();
	try {
		const snap = snapshot([shipped("cp-one", 1), shipped("cp-two", 2)]);
		const before = new ShippedSeenStore({ home: dir });
		const first = renderSessionStatusBlock({ store: before, sessionId: SESSION, snapshot: snap });
		assert.match(first.text, /Shipped:\n {2}- cp-one/);

		const afterRebind = new ShippedSeenStore({ home: dir });
		const second = renderSessionStatusBlock({ store: afterRebind, sessionId: "sess-parent-after-rebind", snapshot: snap });
		assert.match(second.text, /Shipped:\n {2}- cp-one/, "a new session id reports the set once");
		assert.deepEqual(second.warnings, [], "a replay is the contract here, not a degradation");

		// The store is intact and still holds BOTH sessions: a replay must not be a
		// rewrite of somebody else's memory.
		const file = JSON.parse(readFileSync(join(dir, LAYOUT.shippedSeenFile), "utf8")) as {
			sessions: { session_id: string; shipped_ids: string[] }[];
		};
		assert.deepEqual(
			file.sessions.map((session) => session.session_id).sort(),
			[SESSION, "sess-parent-after-rebind"].sort(),
		);
		// …and the original session still collapses when it renders again.
		const back = renderSessionStatusBlock({ store: before, sessionId: SESSION, snapshot: snap });
		assert.match(back.text, /Shipped: none new \(2 already reported\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the Shipped memory is written the way cp-nqj established: tmp -> fsync -> rename, never a truncating call", () => {
	// PR #86 (cp-nqj) closed this exact class of bug for the memory files:
	// `writeFileSync` opens O_TRUNC, so the target is zero bytes between the open
	// and the write and a kill in that window destroys it. This store is a
	// whole-file JSON document with the same exposure, so it uses the same
	// mechanism (`atomicWriteJson` -> `atomicWriteText`), and this guard keeps it
	// that way — a truncated write here is also the most likely way the corrupt
	// file the store now has to heal would ever come about.
	const source = readFileSync(join(REPO_ROOT, "src/shipped-seen.ts"), "utf8");
	const imported = /import\s*\{([^}]*)\}\s*from\s*"node:fs"/.exec(source)?.[1] ?? "";
	assert.ok(
		!/\bwriteFileSync\b/.test(imported),
		"src/shipped-seen.ts must not import writeFileSync: it opens O_TRUNC (cp-nqj)",
	);
	assert.match(source, /atomicWriteJson/, "the whole-file write goes through the tmp -> fsync -> rename path");
});

test("a second writer on the same home does not drop the first session's entry", () => {
	// Two parents (or a parent and its reloaded self) sharing one home: the write
	// is a read-modify-write with no lock, so this pins the sequential case that
	// must never lose anything — each writer re-reads before it writes, and only
	// its own entry is replaced.
	const dir = home();
	try {
		const one = new ShippedSeenStore({ home: dir });
		const two = new ShippedSeenStore({ home: dir });
		one.record("sess-a", ["cp-a1", "cp-a2"]);
		two.record("sess-b", ["cp-b1"]);
		one.record("sess-a", ["cp-a3"]);

		const file = JSON.parse(readFileSync(join(dir, LAYOUT.shippedSeenFile), "utf8")) as {
			sessions: { session_id: string; shipped_ids: string[] }[];
		};
		const a = file.sessions.find((session) => session.session_id === "sess-a");
		const b = file.sessions.find((session) => session.session_id === "sess-b");
		assert.deepEqual(a?.shipped_ids, ["cp-a1", "cp-a2", "cp-a3"]);
		assert.deepEqual(b?.shipped_ids, ["cp-b1"], "the other writer's entry was dropped");
		// Both stores agree with the file, from disk, not from their own mirrors.
		assert.deepEqual([...two.shown("sess-a").ids].sort(), ["cp-a1", "cp-a2", "cp-a3"]);
		assert.deepEqual([...one.shown("sess-b").ids], ["cp-b1"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the store bounds itself: sessions and ids per session", () => {
	const dir = home();
	try {
		const store = new ShippedSeenStore({ home: dir });
		for (let i = 0; i < SHIPPED_SEEN_KEEP_SESSIONS + 4; i += 1) {
			store.record(`sess-${i}`, [`cp-${i}`]);
		}
		const file = JSON.parse(readFileSync(join(dir, LAYOUT.shippedSeenFile), "utf8")) as {
			sessions: { session_id: string; shipped_ids: string[] }[];
		};
		assert.equal(file.sessions.length, SHIPPED_SEEN_KEEP_SESSIONS);
		// The newest sessions are the ones kept.
		assert.equal(file.sessions.at(-1)?.session_id, `sess-${SHIPPED_SEEN_KEEP_SESSIONS + 3}`);

		const many = Array.from({ length: SHIPPED_SEEN_MAX_IDS + 20 }, (_, i) => `cp-many-${i}`);
		store.record("sess-many", many);
		const second = JSON.parse(readFileSync(join(dir, LAYOUT.shippedSeenFile), "utf8")) as {
			sessions: { session_id: string; shipped_ids: string[] }[];
		};
		const bounded = second.sessions.find((session) => session.session_id === "sess-many");
		assert.equal(bounded?.shipped_ids.length, SHIPPED_SEEN_MAX_IDS);
		// The most recent ids survive: an id still in a snapshot must not be dropped.
		assert.equal(bounded?.shipped_ids.at(-1), `cp-many-${SHIPPED_SEEN_MAX_IDS + 19}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a write that fails cannot un-report a row this process already printed", () => {
	const dir = home();
	try {
		const store = new ShippedSeenStore({ home: dir });
		const snap = snapshot([shipped("cp-one", 1)]);
		renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });

		// The file is now corrupt (a torn manual edit, a hand-fix gone wrong): reads
		// throw, but this process still knows what it printed.
		writeFileSync(join(dir, LAYOUT.shippedSeenFile), "{ not json", "utf8");
		const second = renderSessionStatusBlock({ store, sessionId: SESSION, snapshot: snap });
		assert.match(second.text, /Shipped: none new \(1 already reported\)/);
		assert.ok(second.warnings.length > 0, "a degraded memory must be said out loud");
		assert.ok(second.warnings.join(" ").includes(LAYOUT.shippedSeenFile), "the warning must name the file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
