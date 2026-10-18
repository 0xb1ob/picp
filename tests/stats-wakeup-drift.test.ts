import assert from "node:assert/strict";
import test from "node:test";
import { FACT_WAKE_TYPES, STALE_WAKEUP_HEADLINE as VIEWER_STALE } from "../src/viewer/stats-series.ts";
import { STALE_WAKEUP_HEADLINE, WAKEUP_CUSTOM_TYPES } from "../src/wakeups.ts";

// The viewer boundary forbids importing ../wakeups.ts, so stats-series.ts mirrors these; a drifted copy would
// silently stop counting a stale or repeated wake as wasted on the Stats Parent panel (#327).
test("the Stats Parent panel's wake-up mirrors equal src/wakeups.ts", () => {
	assert.deepEqual([...FACT_WAKE_TYPES].sort(), Object.values(WAKEUP_CUSTOM_TYPES).sort());
	assert.equal(VIEWER_STALE, STALE_WAKEUP_HEADLINE);
});
