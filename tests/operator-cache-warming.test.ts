import assert from "node:assert/strict";
import { test } from "node:test";
import bridgeExtension from "../extensions/cp-bridge/index.ts";

// cp-c1ur N8: pi's idle estimate stopped refreshes, so 5-minute operator gaps paid full cache writes. The bridge
// overrides a stop with warm whenever one avoided miss pays for the refresh, and leaves pi's decision otherwise.
test("the operator bridge keeps its prompt cache warm while a refresh is cheaper than a miss", async () => {
	const handlers: Array<(event: unknown) => unknown> = [];
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown) => unknown) => { if (event === "cache_warming_decision") handlers.push(handler); },
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	assert.equal(handlers.length, 1, "exactly one cache_warming_decision handler");
	const decide = (warmCost: number, missCost: number) =>
		handlers[0]!({ type: "cache_warming_decision", warmCost, missCost, continuationProbability: 0.15, action: "stop" });
	assert.deepEqual(await decide(0.03, 0.3), { action: "warm" });
	assert.equal(await decide(0.03, 0.02), undefined, "a refresh dearer than the miss keeps pi's stop");
	assert.equal(await decide(0, 0), undefined, "unknown economics keep pi's stop");
});
