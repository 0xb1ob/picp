import assert from "node:assert/strict";
import { test } from "node:test";
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
] as const;

for (const [name, read, dflt] of knobs) {
	test(`${name}: default, override, garbage`, () => {
		assert.equal(read({}), dflt);
		assert.equal(read({ [name]: "2" }), 2000);
		for (const bad of ["nope", "0", "-5", "", "Infinity"]) assert.equal(read({ [name]: bad }), dflt);
	});
}
