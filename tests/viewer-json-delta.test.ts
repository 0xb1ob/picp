import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDelta, diffJson } from "../src/viewer/json-delta.ts";

const rows = Array.from({ length: 700 }, (_, i) => ({ id: `cp-${i}`, title: `job ${i} ${"long text ".repeat(5)}`, cost: i }));
const oneChanged = rows.map((r) => (r.id === "cp-7" ? { ...r, cost: 9999 } : r));
const PAIRS: Array<[string, unknown, unknown]> = [
	["identical", { a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }],
	["700 rows, 1 changed", { rows }, { rows: oneChanged }],
	["700 rows, 1 added at the front", { rows }, { rows: [{ id: "cp-new", title: "new", cost: 0 }, ...rows] }],
	["700 rows, 1 removed", { rows }, { rows: rows.filter((r) => r.id !== "cp-300") }],
	["700 rows, reordered", { rows }, { rows: [...rows].reverse() }],
	["job_id-keyed rows", [{ job_id: "a", n: 1 }, { job_id: "b", n: 2 }], [{ job_id: "b", n: 3 }, { job_id: "c", n: 1 }]],
	["duplicate ids", [{ id: "a", n: 1 }, { id: "a", n: 2 }], [{ id: "a", n: 1 }, { id: "a", n: 3 }]],
	["arrays of primitives", { xs: [1, 2, 3] }, { xs: [1, 3, 2, 4] }],
	["nested key add and delete", { o: { keep: 1, gone: 2, deep: { x: 1 } } }, { o: { keep: 1, deep: { x: 2, y: [] }, added: "z" } }],
	["key order change", { a: 1, b: 2 }, { b: 2, a: 1 }],
	["null to object", { x: null }, { x: { y: 1 } }],
	["object to null", { x: { y: 1 } }, { x: null }],
	["integer-like and __proto__ keys", JSON.parse('{"b":1,"2":0}'), JSON.parse('{"b":2,"2":0,"1":5,"__proto__":{"p":1}}')],
	["top-level scalar", 1, "one"],
];

test("applyDelta(a, diffJson(a, b)) serializes byte-identical to b, key order included", () => {
	for (const [name, a, b] of PAIRS) {
		const before = JSON.stringify(a);
		assert.equal(JSON.stringify(applyDelta(a, diffJson(a, b) ?? {})), JSON.stringify(b), name);
		assert.equal(JSON.stringify(a), before, `${name}: the base is never mutated`);
	}
	assert.equal(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), undefined);
	assert.deepEqual(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 }), { v: { b: 2, a: 1 } }, "a key-order change is a whole value");
	assert.deepEqual(diffJson([{ id: "a" }, { id: "a" }], [{ id: "a", n: 1 }]), { v: [{ id: "a", n: 1 }] }, "duplicate ids are not keyed");
	const small = JSON.stringify(diffJson({ rows }, { rows: oneChanged }));
	assert.ok(small.length < 2048, `a 1-row change must stay small, got ${small.length}`);
});

test("applyDelta throws on a delta that does not fit its base", () => {
	assert.throws(() => applyDelta([{ id: "a" }], { key: "id", put: [{ id: "b" }] }), /unknown key in put/);
	assert.throws(() => applyDelta([{ id: "a" }], { key: "id", put: [], ids: ["a", "zz"] }), /unknown id/);
	assert.throws(() => applyDelta(5, { sub: { x: { v: 1 } } }), /non-object/);
	assert.throws(() => applyDelta({}, { sub: { x: { v: 1 } } }), /sub on missing key/);
	assert.throws(() => applyDelta({ a: 1 }, { key: "id", put: [] }), /malformed array delta/);
});
