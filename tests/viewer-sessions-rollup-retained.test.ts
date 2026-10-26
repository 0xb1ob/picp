/**
 * Rollup units no e2e transcript can produce (P19b): a thread change inside one job's turns, an order gap a filter
 * opened, and an anchor on a run's middle turn. P19-rollup-* pin the served folds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrChip, SessionEntry } from "../src/viewer/api-types.ts";
import { rollups, rowHead, rows } from "../viewer-app/session-rows.ts";

const AT = new Date(2026, 9, 15, 9).toISOString();
const entry = (id: string, kind: SessionEntry["kind"], over: Partial<SessionEntry> = {}): SessionEntry => ({ id, at: AT, kind, who: "Assistant", text: id, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const wake = (id: string, job: string | null, over: Partial<SessionEntry> = {}) => entry(id, "system", { who: "cp-bridge", tag: "bridge", bridge: { kind: "wake", job, id: null, receipt: null }, ...over });
const relay = (id: string, text = id, over: Partial<SessionEntry> = {}) => entry(id, "say", { text, ...over });
const CHIPS: Record<string, PrChip> = {};

/** Each output row: a rollup as `subject[turn rows|turn rows]` by head ids, any other row by its head id. */
function fold(list: SessionEntry[], { days = new Map<string, string>(), order, keep }: { days?: Map<string, string>; order?: Map<string, number>; keep?: string } = {}) {
	const o = order ?? new Map(list.map((e, i) => [e.id, i]));
	return rollups(rows(list, days, o), days, o, CHIPS, keep).map(r => r.kind === "rollup" ? `${r.subject}[${r.turns.map(t => t.map(x => rowHead(x).id).join(",")).join("|")}]` : rowHead(r).id);
}

test("rollups: never across a thread change or a source gap; a run ends before the quick-reply anchor's turn", () => {
	const ids = (list: SessionEntry[]) => list.map(e => e.id);
	const two = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-b"), relay("r2")];
	const threaded = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-b", { thread: "th-x" }), relay("r2", "r2", { thread: "th-x" })];
	assert.deepEqual(fold(threaded), ids(threaded), "(e) a thread change");
	assert.deepEqual(fold(two, { order: new Map([["w1", 0], ["r1", 1], ["w2", 7], ["r2", 8]]) }), ids(two), "(e) an order gap a filter opened");
	const three = [wake("w1", "cp-b"), relay("r1"), wake("w2", "cp-b"), relay("r2"), wake("w3", "cp-b"), relay("r3")];
	assert.deepEqual(fold(three, { keep: "r2" }), ["w1", "r1", "w2", "r2", "w3", "r3"], "(g) an anchor on the middle turn folds nothing");
});
