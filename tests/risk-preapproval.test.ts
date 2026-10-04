/**
 * Operator risk:high pre-approval on a mandate (unload-parent PR0): a covered job's risk:high dispatch or promotion
 * proceeds with no escalation and one audit row; uncovered jobs, scripts, hard stops and every merge path are unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isoTimestamp, type Mandate } from "../src/contracts.ts";
import { DecideError, requireOperatorQuote } from "../src/decide.ts";
import { EscalationStore } from "../src/escalation.ts";
import { evaluateAuthority, MandateError, MandateStore } from "../src/mandate.ts";
import { hardStops, preapprovalCovers, preapprovalRecord, quoteSha } from "../src/risk-preapproval.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const QUOTE = "Pre-approve risk high for this mission's jobs.";
const later = (ms = 86_400_000) => isoTimestamp(new Date(Date.now() + ms));

function grant(store: MandateStore, over: Partial<Parameters<MandateStore["issue"]>[0]> = {}): Mandate {
	return store.issue({ projects: ["demo"], objective: "ship the mission", expiry: later(), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["merge", "risk:high"], ...over });
}

function verified(jobIds?: string[]) {
	return preapprovalRecord(requireOperatorQuote(QUOTE, { operatorTexts: [`ok. ${QUOTE}`] }), jobIds, isoTimestamp());
}

async function setup(t: { after: (fn: () => void) => void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const { ledger } = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const mandate = grant(store);
	const job = await ledger.create({ title: "example risky", project: "demo", delivery: "pr", kind: "ship", slug: "risky" });
	return { home, store, ledger, mandate, job, escalations: new EscalationStore({ home: home.path }) };
}

test("hardStops: affirmative force push, publishing, deletion and credential acts stop; negated mentions do not", () => {
	assert.match(hardStops("force push to main").join(), /force push/);
	assert.match(hardStops("then run `git push --force-with-lease origin cp-x`").join(), /force push/);
	assert.match(hardStops("npm publish the package").join(), /external publishing/);
	assert.match(hardStops("deploy to production after merge").join(), /external publishing/);
	assert.match(hardStops("rm -rf the cache dir").join(), /data deletion/);
	assert.match(hardStops("purge customer data older than 30d").join(), /data deletion/);
	assert.match(hardStops("copy ~/.ssh keys to the box").join(), /credential handling/);
	assert.match(hardStops("rotate the GitHub token").join(), /credential handling/);
	assert.deepEqual(hardStops("no force-push"), []);
	assert.deepEqual(hardStops("Never npm publish from a worker."), []);
	assert.deepEqual(hardStops("do not print secrets"), []);
	assert.deepEqual(hardStops("add a token cap and delete the stale helper"), [], "risk words that are no hard stop");
});

test("preapprovalCovers: named_jobs names ids; mandate_jobs covers the grant's ids or jobs created at/after issue in its projects", () => {
	const base = { issued_at: "2026-01-01T00:00:00Z", projects: ["demo"] } as Mandate;
	const named = { ...base, risk_preapproval: verified(["cp-a"]) };
	assert.equal(preapprovalCovers(named, { jobId: "cp-a", project: "demo" }, undefined), true);
	assert.equal(preapprovalCovers(named, { jobId: "cp-b", project: "demo" }, "2026-02-01T00:00:00Z"), false);
	const wide = { ...base, risk_preapproval: verified() };
	assert.equal(wide.risk_preapproval?.scope, "mandate_jobs");
	assert.equal(preapprovalCovers(wide, { jobId: "cp-b", project: "demo" }, "2026-01-01T00:00:00.500Z"), true);
	assert.equal(preapprovalCovers(wide, { jobId: "cp-b", project: "demo" }, "2025-12-31T23:59:59.999Z"), false, "created before the grant");
	assert.equal(preapprovalCovers(wide, { jobId: "cp-b", project: "other" }, "2026-02-01T00:00:00Z"), false, "outside the grant's projects");
	assert.equal(preapprovalCovers(wide, { jobId: "cp-b", project: "demo" }, undefined), false, "no ledger record");
	assert.equal(preapprovalCovers({ ...wide, job_ids: ["cp-a"] }, { jobId: "cp-a", project: "demo" }, undefined), true);
	assert.equal(preapprovalCovers({ ...wide, job_ids: ["cp-a"] }, { jobId: "cp-b", project: "demo" }, "2026-02-01T00:00:00Z"), false);
	assert.equal(preapprovalCovers(base, { jobId: "cp-a", project: "demo" }, "2026-02-01T00:00:00Z"), false, "no pre-approval");
});

test("a quote not found in operator messages is refused; a found one records who decided", () => {
	assert.throws(() => requireOperatorQuote(QUOTE, { operatorTexts: ["something else entirely."] }), DecideError);
	const record = verified(["cp-a", "cp-a"]);
	assert.deepEqual([record.operator_quote, record.decided_by, record.scope, record.job_ids], [QUOTE, "operator-quote", "named_jobs", ["cp-a"]]);
});

test("a covered risk:high dispatch and promotion raise no escalation and append one audit row each, shown by cp_mandate show", async (t) => {
	const { store, mandate, job, escalations } = await setup(t);
	store.preapproveRisk(mandate.id, verified());
	assert.equal(store.wouldAskRiskHigh({ jobId: job.id, project: "demo", kind: "ship", pathHints: ["fix the prod auth flow"] }, "high"), false);
	await store.assertDispatchAllowed({ jobId: job.id, project: "demo", kind: "ship", risk: "high", pathHints: ["fix the prod auth flow"], evidence: ["risk high: the task names production"] });
	await store.assertDispatchAllowed({ jobId: job.id, project: "demo", kind: "ship", risk: "high", promotion: true });
	assert.equal(escalations.list().length, 0, "no escalation");
	const rows = store.require(mandate.id).risk_preapproved ?? [];
	assert.deepEqual(rows.map((row) => [row.job_id, row.use, row.decided_by, row.quote_sha]), [
		[job.id, "dispatch", "operator-delegated", quoteSha(QUOTE)],
		[job.id, "promote", "operator-delegated", quoteSha(QUOTE)],
	]);
	assert.deepEqual(rows[0]?.evidence, ["risk high: the task names production"]);
	assert.ok(!JSON.stringify(rows).includes(QUOTE), "audit rows carry the quote hash, never the quote");
	const shown = store.show(mandate.id);
	assert.match(shown, /risk:high pre-approved \(dispatch\/promote only, never merge\)/);
	assert.match(shown, new RegExp(`dispatch ${job.id} \\(operator-delegated\\): risk high`));
});

test("uncovered jobs, scripts and hard-stop text escalate exactly as without a pre-approval", async (t) => {
	const { store, ledger, mandate, job, escalations } = await setup(t);
	const other = await ledger.create({ title: "example other", project: "demo", delivery: "pr", kind: "ship", slug: "other" });
	store.preapproveRisk(mandate.id, verified([job.id]));
	const gate = (jobId: string, over: { pathHints?: string[]; script?: boolean } = {}) => store.assertDispatchAllowed({ jobId, project: "demo", kind: "ship", risk: "high", evidence: ["risk high"], ...over });

	await assert.rejects(() => gate(other.id), /risk:high under ask_on/, "a job the pre-approval does not name");
	await assert.rejects(() => gate("cp-unknown"), /risk:high under ask_on/, "a job with no ledger record");
	assert.equal(escalations.list({ jobId: other.id })[0]?.question.includes("hard stop"), false, "uncovered evidence unchanged");

	const pushing = { pathHints: ["Rebase, then force push to main."] };
	assert.equal(store.wouldAskRiskHigh({ jobId: job.id, project: "demo", ...pushing }, "high"), true);
	await assert.rejects(() => gate(job.id, pushing), /risk:high under ask_on/);
	assert.match(escalations.list({ jobId: job.id, kind: "risk_high_irreversible" })[0]?.question ?? "", /hard stop force push: force push/);
	await assert.rejects(() => gate(job.id, { script: true }), /risk:high under ask_on/, "a script dispatch");
	assert.equal(store.wouldAskRiskHigh({ jobId: job.id, project: "demo", script: true }, "high"), true);
	assert.equal(store.require(mandate.id).risk_preapproved, undefined, "nothing audited for a refusal");

	// A negated hard stop is no hard stop.
	const fresh = await setup(t);
	fresh.store.preapproveRisk(fresh.mandate.id, verified([fresh.job.id]));
	await fresh.store.assertDispatchAllowed({ jobId: fresh.job.id, project: "demo", kind: "ship", risk: "high", pathHints: ["Ship it; no force-push and never npm publish."] });
	assert.equal(fresh.escalations.list().length, 0);
});

test("caps still bind a pre-approved job, and a refusal writes no audit row", async (t) => {
	const { store, mandate, job } = await setup(t);
	const serial = grant(store, { dispatch_parallelism: 1 });
	store.preapproveRisk(mandate.id, verified([job.id]));
	store.preapproveRisk(serial.id, verified([job.id]));
	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: job.id, project: "demo", kind: "ship", risk: "high" }, [{ job_id: "cp-busy", project: "demo", phase: "waiting" }]),
		/dispatch-parallelism 1 is full/,
	);
	assert.equal(store.require(serial.id).risk_preapproved, undefined);
});

test("a pre-approval never reaches a merge or a checkpoint, and never widens or outlives a grant", async (t) => {
	const { store, mandate, job } = await setup(t);
	const withPre = grant(store, { allowed_actions: ["plan", "implement", "review", "repair", "merge"], risk_preapproval: verified() });
	const subject = { jobId: job.id, project: "demo", jobKind: "ship" as const, now: isoTimestamp() };
	assert.deepEqual(evaluateAuthority({ ...subject, kind: "merge" }, [withPre]), { permitted: false, reason: `${withPre.id}: ask_on includes merge` });
	assert.match(String((evaluateAuthority({ ...subject, kind: "ship", risk: "high" }, [withPre]) as { reason?: string }).reason), /risk:high is never auto-permitted/);
	assert.equal(evaluateAuthority({ ...subject, kind: "merge" }, [{ ...withPre, ask_on: ["risk:high"] }]).permitted, true, "control: the same grant without ask_on merge permits");

	const named = grant(store, { job_ids: [job.id] });
	assert.throws(() => store.preapproveRisk(named.id, verified(["cp-elsewhere"])), /does not cover cp-elsewhere/);
	store.revoke(mandate.id);
	assert.throws(() => store.preapproveRisk(mandate.id, verified()), MandateError);
	const issued = grant(store, { risk_preapproval: verified() });
	assert.equal(store.require(issued.id).risk_preapproval?.operator_quote, QUOTE, "issue writes the pre-approval with the grant");
});

test("cp_mandate preapprove_risk verifies the quote against operator messages before writing; show prints it", async (t) => {
	const { registerMandateTools } = await import("../extensions/command-post/tools-mandate.ts");
	const { store, mandate, job } = await setup(t);
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) };
	const post = { home: store.home, mandates: store, fleet: { read: () => ({ jobs: [] }) }, runs: {} };
	registerMandateTools(pi as never, { commandPost: () => post, setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined, createdThisTurn: [] } as never);
	const ctx = (text: string) => ({ sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: text } }] } });
	const run = (params: Record<string, unknown>, said: string) => tools.get("cp_mandate")!.execute("c", { action: "preapprove_risk", mandate_id: mandate.id, operator_quote: QUOTE, ...params }, undefined, undefined, ctx(said));

	await assert.rejects(() => run({}, "go ahead with whatever."), DecideError);
	assert.equal(store.require(mandate.id).risk_preapproval, undefined, "a quote not found writes nothing");
	const result = (await run({ job_ids: [job.id] }, QUOTE)) as { content: Array<{ text: string }> };
	assert.match(result.content[0]!.text, new RegExp(`risk:high pre-approved by operator-quote for ${job.id}: dispatch and promotion only, never merge`));
	assert.deepEqual(store.require(mandate.id).risk_preapproval?.job_ids, [job.id]);
	assert.match(store.show(mandate.id), /Pre-approve risk high for this mission's jobs\./);
});
