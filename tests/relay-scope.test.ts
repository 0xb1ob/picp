import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { initJobsDocument, Ledger } from "../src/ledger.ts";
import { deliverableRelay, envelopeSummaryOf, withEnvelopeSummaries } from "../src/relay-scope.ts";
import { createScratchHome } from "./harness/index.ts";

const relay = (fields: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "", receipt: { level: null, reached: [] }, paths: [], ...fields });

test("cp-hhuf P1: a wake about scheduled jobs only is not relayed; escalations, errors and mixed turns still are", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initJobsDocument(home.path, "cp");
	const ledger = new Ledger({ home: home.path });
	const scheduled = (await ledger.create({ title: "Weather", project: "demo", kind: "research", delivery: "answer", labels: ["schedule:sch-aaaaaa"] })).id;
	const plain = (await ledger.create({ title: "Other", project: "demo", kind: "research", delivery: "answer" })).id;
	const deliver = (fields: Partial<BridgeRelay>) => deliverableRelay(home.path, relay(fields));
	assert.equal(deliver({ jobId: scheduled, jobIds: [scheduled] }), undefined, "a scheduled wake is dropped");
	assert.ok(deliver({ kind: "escalation", jobId: scheduled, jobIds: [scheduled] }), "an escalation for the same job still relays");
	assert.ok(deliver({ kind: "error", jobId: scheduled, jobIds: [scheduled] }), "so does an error");
	assert.ok(deliver({ jobId: plain, jobIds: [scheduled, plain] }), "a mixed turn still relays");
	assert.ok(deliver({ jobId: plain, jobIds: [plain] }), "an unscheduled wake relays");
	assert.ok(deliver({ text: "no stamp" }), "a wake with no job relays");
	assert.ok(deliverableRelay(join(home.path, "missing"), relay({ jobIds: [scheduled] })), "an unreadable ledger drops nothing");
});

test("issue #2: an accepted cp-envelope's own summary rides on the relay, verbatim", () => {
	const message = (details: Record<string, unknown>, customType = "cp-envelope") => ({ role: "custom", customType, details });
	const good = { job_id: "cp-9b9f", accepted: true, status: "done", summary: "npm, Node v24" };
	const e = envelopeSummaryOf(message(good));
	assert.deepEqual(e, { jobId: "cp-9b9f", status: "done", summary: "npm, Node v24" });
	assert.equal(envelopeSummaryOf(message({ ...good, accepted: false })), undefined);
	assert.equal(envelopeSummaryOf(message(good, "cp-recovery")), undefined);
	assert.equal(envelopeSummaryOf(message({ ...good, job_id: "../bad id" })), undefined);
	assert.equal(envelopeSummaryOf(message({ ...good, summary: "  " })), undefined);
	assert.ok(withEnvelopeSummaries("The worker confirmed: pnpm", [e!]).endsWith("\n\nenvelope cp-9b9f (done), verbatim: npm, Node v24"));
	assert.equal(withEnvelopeSummaries("unchanged", []), "unchanged");
	const twice = withEnvelopeSummaries("t", [e!, { ...e!, summary: "second" }]);
	assert.equal(twice, "t\n\nenvelope cp-9b9f (done), verbatim: second");
});
