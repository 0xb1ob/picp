/** Retained from tests/relay-scope.test.ts (P9b): envelope inputs no fake parent emits; see testing-migration/p9.md. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { envelopeSummaryOf, withEnvelopeSummaries } from "../src/relay-scope.ts";

test("issue #2: only an accepted, well-formed cp-envelope rides on the relay, and the last per job wins", () => {
	const message = (details: Record<string, unknown>, customType = "cp-envelope") => ({ role: "custom", customType, details });
	const good = { job_id: "cp-9b9f", accepted: true, status: "done", summary: "npm, Node v24" };
	const e = envelopeSummaryOf(message(good));
	assert.equal(envelopeSummaryOf(message({ ...good, accepted: false })), undefined);
	assert.equal(envelopeSummaryOf(message(good, "cp-recovery")), undefined);
	assert.equal(envelopeSummaryOf(message({ ...good, job_id: "../bad id" })), undefined);
	assert.equal(envelopeSummaryOf(message({ ...good, summary: "  " })), undefined);
	assert.equal(withEnvelopeSummaries("unchanged", []), "unchanged");
	const twice = withEnvelopeSummaries("t", [e!, { ...e!, summary: "second" }]);
	assert.equal(twice, "t\n\nenvelope cp-9b9f (done), verbatim: second");
});
