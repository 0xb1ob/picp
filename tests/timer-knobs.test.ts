import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_WATCH_MAX_BACKOFF_MS } from "../src/contracts.ts";
import { hostProbeMs, reattachFirstMs, reattachMaxMs } from "../src/bridge-reattach.ts";
import { hostEscalationTickMs } from "../src/parent-host.ts";
import { parentCompactHoldMs } from "../src/parent-compact-hold.ts";
import {
	ciWatchDeliveryRetryMs,
	reviewMergeWindowMs,
	reviewSuppressionMs,
	verdictDeliveryRetryMs,
} from "../src/timer-knobs.ts";

const knobs = [
	["CP_VERDICT_DELIVERY_RETRY_SECONDS", verdictDeliveryRetryMs, 120_000],
	["CP_CI_WATCH_DELIVERY_RETRY_SECONDS", ciWatchDeliveryRetryMs, 120_000],
	["CP_REVIEW_SUPPRESSION_SECONDS", reviewSuppressionMs, 1_200_000],
	["CP_REVIEW_MERGE_WINDOW_SECONDS", reviewMergeWindowMs, 30_000],
	["CP_PARENT_COMPACT_HOLD_SECONDS", parentCompactHoldMs, 270_000],
	["CP_HOST_ESCALATION_TICK_SECONDS", hostEscalationTickMs, 10_000],
	["CP_HOST_PROBE_SECONDS", hostProbeMs, 60_000],
	["CP_BRIDGE_REATTACH_FIRST_SECONDS", reattachFirstMs, 1_000],
	["CP_BRIDGE_REATTACH_MAX_SECONDS", reattachMaxMs, 30_000],
] as const;

for (const [name, read, dflt] of knobs) {
	test(`${name}: default, override, garbage`, () => {
		assert.equal(read({}), dflt);
		if (name === "CP_REVIEW_SUPPRESSION_SECONDS") assert.ok(read({}) > CI_WATCH_MAX_BACKOFF_MS, "default suppression outlasts watcher backoff");
		assert.equal(read({ [name]: "2" }), 2000);
		for (const bad of ["nope", "0", "-5", "", "Infinity"]) assert.equal(read({ [name]: bad }), dflt);
	});
}
