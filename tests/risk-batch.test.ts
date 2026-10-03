/**
 * cp-itl4 6b (6B-T1): `batchRiskHigh` validates everything before any write, then raises one approve/drop
 * record and withdraws the per-job rows — raise first.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isoTimestamp } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { MandateStore } from "../src/mandate.ts";
import { batchRiskHigh } from "../src/risk-batch.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const PROJECT = "example-app";
const EVIDENCE = ["risk high: the task names production"];

function grant(mandates: MandateStore, jobIds?: string[]) {
	return mandates.issue({
		projects: [PROJECT],
		objective: "ship the example change",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 20,
		ask_on: ["risk:high"],
		...(jobIds ? { job_ids: jobIds } : {}),
	});
}

async function setup(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ledger } = createScratchLedger({ home: home.path, knownProjects: [PROJECT] });
	const mandates = new MandateStore(home.path);
	const escalations = new EscalationStore({ home: home.path });
	const job = async (slug: string, risk?: "high") =>
		(await ledger.create({ title: `example ${slug}`, project: PROJECT, delivery: "pr", kind: "ship", slug, ...(risk ? { risk } : {}) })).id;
	/** A per-job open row, the way a refused dispatch raises it. */
	const refuse = (jobId: string) =>
		assert.rejects(() => mandates.assertDispatchAllowed({ jobId, project: PROJECT, kind: "ship", risk: "high", evidence: EVIDENCE }), /risk:high under ask_on/);
	const bytes = () => (existsSync(escalations.file) ? readFileSync(escalations.file, "utf8") : "<absent>");
	const deps = { escalations, mandates, ledger };
	return { home, ledger, mandates, escalations, job, refuse, bytes, deps };
}

test("batchRiskHigh: every refusal writes nothing; a valid batch is one sorted approve/drop record and the per-job rows withdrawn", async (t) => {
	const s = await setup(t);
	const mandate = grant(s.mandates);
	const labelled = await s.job("labelled", "high");
	const rowB = await s.job("row-b");
	const rowC = await s.job("row-c");
	const plain = await s.job("plain");
	await s.refuse(rowB);
	await s.refuse(rowC);
	const before = s.bytes();
	assert.equal(s.escalations.open().length, 2);

	const refusals: [string[], RegExp][] = [
		[[labelled], /needs 2\.\.16 job ids, got 1/],
		[Array.from({ length: 17 }, (_, i) => `cp-x${i}`), /got 17/],
		[[labelled, labelled], /duplicate job ids: /],
		[[labelled, "cp-zzz9"], /unknown job ids: cp-zzz9/],
		[[labelled, plain], new RegExp(`not risk:high gated .*${plain}`)],
	];
	for (const [jobIds, pattern] of refusals) {
		await assert.rejects(() => batchRiskHigh(s.deps, { jobIds }), pattern);
		assert.equal(s.bytes(), before, `refusal ${pattern} wrote nothing`);
	}
	await assert.rejects(() => batchRiskHigh(s.deps, { jobIds: [rowB, rowC], mandateId: "md-000000" }), /asking mandate is/);
	assert.equal(s.bytes(), before);

	const { escalation, withdrawn } = await batchRiskHigh(s.deps, { jobIds: [rowC, labelled, rowB] });
	assert.deepEqual(escalation.job_ids, [labelled, rowB, rowC].sort());
	assert.deepEqual(escalation.options.map((option) => option.id), ["approve", "drop"]);
	assert.equal(escalation.recommended, "drop");
	assert.equal(escalation.kind, "risk_high_irreversible");
	assert.equal(escalation.mandate_id, mandate.id);
	assert.match(escalation.question, /^3 jobs risk:high under ask_on/);
	assert.match(escalation.question, /names production/);
	assert.match(escalation.question, new RegExp(`${labelled} \\(risk:high label\\)`));
	assert.equal(withdrawn.length, 2);
	assert.deepEqual(s.escalations.open().map((item) => item.id), [escalation.id], "only the batch stays open");
});

test("batchRiskHigh: mixed asking mandates and an already-approved job are refused with nothing written", async (t) => {
	const s = await setup(t);
	const a = await s.job("a", "high");
	const b = await s.job("b", "high");
	grant(s.mandates, [a]);
	grant(s.mandates, [b]);
	await s.refuse(a);
	const before = s.bytes();
	await assert.rejects(() => batchRiskHigh(s.deps, { jobIds: [a, b] }), /one asking mandate must cover every job/);
	assert.equal(s.bytes(), before);

	const t2 = await setup(t);
	grant(t2.mandates);
	const x = await t2.job("x");
	const y = await t2.job("y", "high");
	await t2.refuse(x);
	await t2.escalations.answer(t2.escalations.open()[0]!.id, { answer: "approve", by: "operator-quote" });
	const approvedBefore = t2.bytes();
	await assert.rejects(() => batchRiskHigh(t2.deps, { jobIds: [x, y] }), new RegExp(`already approved: ${x}`));
	assert.equal(t2.bytes(), approvedBefore);
});

test("batchRiskHigh: the batch is raised before any withdraw, so a failing withdraw leaves it open", async (t) => {
	const s = await setup(t);
	grant(s.mandates);
	const a = await s.job("a");
	const b = await s.job("b");
	await s.refuse(a);
	await s.refuse(b);
	const real = s.escalations;
	const escalations = {
		list: (filter?: Parameters<EscalationStore["list"]>[0]) => real.list(filter),
		raise: (input: Parameters<EscalationStore["raise"]>[0]) => real.raise(input),
		withdraw: async () => {
			throw new Error("withdraw failed");
		},
	} as unknown as EscalationStore;
	await assert.rejects(() => batchRiskHigh({ ...s.deps, escalations }, { jobIds: [a, b] }), /withdraw failed/);
	const batch = s.escalations.open().find((item) => item.job_ids.length === 2);
	assert.ok(batch, "the batch record is open");
	assert.equal(s.escalations.open().length, 3, "duplicates, never a lost question");
});
