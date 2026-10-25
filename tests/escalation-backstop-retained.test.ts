/** A wake relay never writes the escalation-relay ledger (P10b): no consumer shows it, so it stays a unit. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { escalationRelayLedgerFile, noteBridgeRelay } from "../src/escalation-backstop.ts";
import { createScratchHome } from "./harness/index.ts";

test("T5b: noteBridgeRelay notes bridge escalations only", (t) => {
	const relay = (fields: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "", receipt: { level: null, reached: [] }, paths: [], ...fields });
	const other = createScratchHome();
	t.after(() => other.cleanup());
	noteBridgeRelay(other.path, "multi", relay({ jobId: "cp-job" }));
	assert.equal(existsSync(escalationRelayLedgerFile(other.path, "multi")), false, "a wake relay writes nothing");
	noteBridgeRelay(other.path, "multi", relay({ kind: "escalation", escalationId: "es-bbbb22" }));
	const written = JSON.parse(readFileSync(escalationRelayLedgerFile(other.path, "multi"), "utf8")) as { items: Array<{ id: string; via: string }> };
	assert.deepEqual(written.items.map(({ id, via }) => ({ id, via })), [{ id: "es-bbbb22", via: "bridge" }]);
});
