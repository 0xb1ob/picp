import assert from "node:assert/strict";
import test from "node:test";
import { assignShards, startOrder } from "../scripts/test-shards.ts";

// `check:shards` and `files` weigh a file missing from the timing table at the table's median (20 here).
// Weighed as zero, d would pair with b and a with c.
test("an untimed test file weighs the timing table's median when shards are assigned", () => {
	assert.deepEqual(assignShards(["a", "b", "c", "d"], { a: 10, b: 30, c: 20 }, 2), [["a", "b"], ["c", "d"]]);
});

// `test:shard` starts heaviest first (untimed c weighs the median, 2); an alphabetical start left big files last.
test("a shard starts its files longest-first, untimed files at the median", () => {
	assert.deepEqual(startOrder(["a", "b", "c"], { a: 1, b: 3 }), ["b", "c", "a"]);
});
