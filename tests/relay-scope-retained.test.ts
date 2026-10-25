/** Retained from tests/relay-scope.test.ts (P9b): relays no entry point builds; see testing-migration/p9.md. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { initJobsDocument, Ledger } from "../src/ledger.ts";
import { deliverableRelay } from "../src/relay-scope.ts";
import { createScratchHome } from "./harness/index.ts";

const relay = (fields: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "", receipt: { level: null, reached: [] }, paths: [], ...fields });

// No producer stamps jobIds on an escalation or error relay (cp-bridge sets them on wakes only), so only this
// direct call reaches the kind guard in deliverableRelay.
test("cp-hhuf P1: a wake about scheduled jobs only is not relayed; escalations, errors and mixed turns still are", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initJobsDocument(home.path, "cp");
	const ledger = new Ledger({ home: home.path });
	const scheduled = (await ledger.create({ title: "Weather", project: "demo", kind: "research", delivery: "answer", labels: ["schedule:sch-aaaaaa"] })).id;
	const deliver = (fields: Partial<BridgeRelay>) => deliverableRelay(home.path, relay(fields));
	assert.ok(deliver({ kind: "escalation", jobId: scheduled, jobIds: [scheduled] }), "an escalation for the same job still relays");
	assert.ok(deliver({ kind: "error", jobId: scheduled, jobIds: [scheduled] }), "so does an error");
});
