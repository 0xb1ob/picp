/**
 * N4k units: a native run's measured usage and the streamed estimate for a run stopped before its result. The e2e
 * cases need `claude` on PATH and CI skips them, so the accounting the worker calls is pinned here too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { estimatedRunUsage, type NativeBaseline, nativeRunUsage, noteStreamedUsage, type StreamedUsage } from "../src/drivers/claude-usage.ts";

const MODEL = "claude-fake";
const fresh = (): NativeBaseline => ({ ledger: {}, cost_usd: 0 });
// SAFETY: only the fields the usage helpers read are set; the rest of the SDK shapes are irrelevant here.
const assistant = (id: string, usage: Record<string, number>) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: MODEL, usage } }) as unknown as SDKMessage;
const result = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) =>
	({ type: "result", subtype: "success", total_cost_usd: cost, modelUsage: { [MODEL]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, costUSD: cost } } }) as unknown as SDKResultMessage;

test("N4k: nativeRunUsage measures a result's growth over the baseline; no result stays unavailable", () => {
	assert.deepEqual(nativeRunUsage(undefined, fresh()), { status: "unavailable" });
	const measured = nativeRunUsage(result(100, 20, 10, 5, 0.25), fresh());
	assert.equal(measured.status, "complete");
	assert.deepEqual(measured.usage, { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135, cost: { total: 0.25 } });
	assert.deepEqual(measured.baseline, { ledger: { [MODEL]: { input: 115, output: 20, cache_read: 10, cache_write: 5 } }, cost_usd: 0.25 });
});

test("N4k: the estimate counts each streamed message id once, is marked estimated and is never counted again on resume", () => {
	const seen: StreamedUsage = new Map();
	// The CLI repeats one API message per content block; its output count grows between the copies.
	noteStreamedUsage(seen, assistant("m1", { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }));
	noteStreamedUsage(seen, assistant("m1", { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }));
	noteStreamedUsage(seen, assistant("m2", { input_tokens: 50, output_tokens: 30 }));
	noteStreamedUsage(seen, { type: "user", parent_tool_use_id: null, message: { role: "user", content: [] } } as unknown as SDKMessage);
	const estimate = estimatedRunUsage(seen, fresh());
	assert.deepEqual([estimate.status, estimate.cost_unknown], ["estimated", true]);
	assert.deepEqual(estimate.usage, { input: 150, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 215, cost: { total: 0 } });
	assert.deepEqual(estimate.baseline, { ledger: { [MODEL]: { input: 165, output: 50, cache_read: 10, cache_write: 5 } }, cost_usd: 0 });
	// The resume restores cumulative totals that hold the estimated turn plus 200 in / 40 out of new work.
	const resumed = result(350, 90, 10, 5, 0.9);
	const next = nativeRunUsage(resumed, estimate.baseline);
	assert.deepEqual(next.usage, { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 240, cost: { total: 0.9 } });
	// Control: the stale baseline would count the estimated 215 tokens a second time.
	assert.equal(nativeRunUsage(resumed, fresh()).usage?.totalTokens, 455);
});

test("N4k: an estimate with no streamed tokens stays unavailable; no baseline leaves the next resume unbaselined", () => {
	assert.deepEqual(estimatedRunUsage(new Map(), fresh()), { status: "unavailable" });
	const seen: StreamedUsage = new Map();
	noteStreamedUsage(seen, assistant("m1", { input_tokens: 4, output_tokens: 2 }));
	const estimate = estimatedRunUsage(seen, undefined);
	assert.deepEqual([estimate.status, estimate.usage?.totalTokens, estimate.baseline], ["estimated", 6, undefined]);
});
