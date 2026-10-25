/**
 * P8b retained from tests/bounds.test.ts: inputs no entry point can produce. The rest of that file is pinned by
 * tests/e2e/worker-lifecycle-p8b.test.ts (docs/testing-migration/p8b.md).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { boundFailureMessage, detectHardBound, HardBoundsWatch } from "../src/bounds.ts";
import type { FleetRecord } from "../src/contracts.ts";

test("the wall-clock timer trips even when it fires 1 ms before Date.now() shows the full cap", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const failures: string[] = [];
	const record = { phase: "waiting", worktree: "/tmp/wt", branch: "b" };
	const watch = new HardBoundsWatch({
		fleet: { get: () => record } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["fleet"],
		runs: { open: () => ({ markFailure: () => {} }) } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["runs"],
		fail: async (_id, failure) => {
			failures.push(failure.class);
			return record as unknown as FleetRecord;
		},
		shutdown: async () => {},
		inspect: async () => ({ state: "clean", files: [], file_count: 0, commits_ahead: 0, observed_at: "now" }),
	});
	const worker = { onEvent: () => () => {}, closed: new Promise(() => {}) } as unknown as Parameters<typeof watch.watch>[1];
	watch.watch("cp-early", worker, { wall_clock_seconds: 20, tool_call_cap: 900 });
	now += 19_999;
	t.mock.timers.tick(20_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(failures, ["wall_clock_exceeded"]);
});

test("tool-call cap trips at the limit; wall-clock uses spawn or open-tool age", () => {
	const bounds = { wall_clock_seconds: 10, tool_call_cap: 3 };
	assert.equal(detectHardBound(bounds, { elapsedSeconds: 9, toolStarts: 2 }), undefined);
	assert.equal(detectHardBound(bounds, { elapsedSeconds: 10, toolStarts: 2 })?.class, "wall_clock_exceeded");
	assert.equal(
		detectHardBound(bounds, { elapsedSeconds: 1, toolStarts: 1, currentToolSeconds: 10 })?.class,
		"wall_clock_exceeded",
	);
	const tools = detectHardBound(bounds, { elapsedSeconds: 99, toolStarts: 3 });
	assert.equal(tools?.class, "tool_call_cap_exceeded");
	assert.match(boundFailureMessage(tools!), /tool_call_cap bound 3 starts exceeded \(measured 3 starts\)/);
});
