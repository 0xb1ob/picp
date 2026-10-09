import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_USAGE, type FleetRecord, type Mandate } from "../src/contracts.ts";
import { writeFileSync } from "node:fs";
import { MandateStore, evaluateAuthority, mandateSpend, type MandateUsageJob } from "../src/mandate.ts";
import { selectGrant } from "../src/mandate-permission.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { cpNext } from "../src/next.ts";
import type { Ledger } from "../src/ledger.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const now = "2026-10-09T12:00:00Z";
const job = { jobId: "cp-target", project: "demo", kind: "ship" as const };
const counted: MandateUsageJob[] = ["cp-a", "cp-b", "cp-c"].map((job_id) => ({ job_id, project: "demo", kind: "ship", phase: "held" }));
function permutations<T>(items: T[]): T[][] {
	return items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest])) : [[]];
}
function bench() {
	const home = createScratchHome();
	const store = new MandateStore(home.path, { now: () => new Date(now) });
	const base = { projects: ["demo"], objective: job.jobId, expiry: "2026-10-10T12:00:00Z", spend_cap: { usd: 100, tokens: 100_000 }, job_cap: 3, allowed_actions: ["implement", "review", "repair", "merge"] as Mandate["allowed_actions"], ask_on: [] };
	const older = store.issue({ ...base, id: "md-111111", at: "2026-10-08T12:00:00Z", job_ids: [job.jobId, ...counted.map((row) => row.job_id)] });
	const supplement = store.issue({ ...base, id: "md-222222", at: now, job_ids: [job.jobId] });
	return { home, store, older, supplement };
}

test("full named grant yields to supplement for dispatch, advice and implement in either order", async (t) => {
	const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
	for (const order of permutations([older, supplement])) {
		store.list = () => order.map((grant) => store.require(grant.id));
		assert.equal((await store.assertDispatchAllowed(job, counted)).selected?.id, supplement.id);
		assert.equal(store.selection("dispatch", job, counted)?.grant.id, supplement.id);
		const verdict = evaluateAuthority({ ...job, kind: "ship", jobKind: "ship", now, usageJobs: counted }, order);
		assert.ok(verdict.permitted); assert.equal(verdict.mandateId, supplement.id);
	}
});

function flight(job_id: string): FleetRecord {
	return { job_id, project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "held", reported_at: now, worker: { pid: process.pid, session_id: "test", session_file: "/test/session.jsonl", profile: "implementer", role: "implementer", model: "a/model", started_at: now }, branch: job_id, worktree: `/test/${job_id}`, dispatched_at: now, usage: EMPTY_USAGE };
}

test("cpNext partitions the incident job under the same supplement in either order", async (t) => {
	const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger;
	const created = await ledger.create({ title: "incident", project: "demo", delivery: "pr", kind: "ship" });
	const doc = ledger.read();
	writeFileSync(ledger.file, JSON.stringify({ ...doc, jobs: doc.jobs.map((row) => row.id === created.id ? { ...row, id: job.jobId } : row) }));
	const fleet = new FleetStore({ home: home.path });
	for (const row of counted) await fleet.add(flight(row.job_id));
	for (const order of permutations([older, supplement])) {
		store.list = () => order.map((grant) => store.require(grant.id));
		const next = await cpNext({ ledger: ledger as Ledger, fleet, mandates: store, escalations: new EscalationStore({ home: home.path }), now: () => new Date(now) }, "demo");
		assert.deepEqual([next.action.kind, next.action.job_id, next.mandate?.id], ["dispatch", job.jobId, supplement.id]);
		assert.deepEqual((next.others ?? []).flatMap((view) => view.ready), []);
		assert.equal((await store.assertDispatchAllowed(job, fleet.read().jobs)).selected?.id, next.mandate?.id);
	}
});

const unavailable: Array<[string, Partial<Mandate>]> = [
	["both full", { job_ids: [job.jobId, ...counted.map((row) => row.job_id)] }],
	["project-wide", { job_ids: [] }],
	["kind excluded", { exclusions: { job_kinds: ["ship"] } }],
	["operator paused", { status: "paused", pause_reason: "operator" }],
	["cap paused", { status: "paused", pause_reason: "spend_cap" }],
	["revoked", { status: "revoked" }],
	["expired", { expiry: now }],
	["schedule-only", { schedule_grant: true }],
	["does not name target", { job_ids: ["cp-other"] }],
];
for (const [name, over] of unavailable) {
	test(`ineligible supplement (${name}) leaves the original job-cap refusal in every order`, async (t) => {
		const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
		store.save({ ...supplement, ...over });
		for (const order of permutations([older, supplement])) {
			store.list = () => order.map((grant) => store.require(grant.id));
			assert.equal(store.selection("dispatch", job, counted)?.grant.id, older.id);
			await assert.rejects(store.assertDispatchAllowed(job, counted), new RegExp(`${older.id} job cap 3 reached`));
		}
	});
}

test("under-cap original, omitted jobs, and first eligible supplement preserve deterministic order", (t) => {
	const { home, older, supplement } = bench(); t.after(() => home.cleanup());
	const target = { ...job, jobKind: job.kind, inFlight: false };
	const third = { ...supplement, id: "md-333333", issued_at: "2026-10-09T13:00:00Z" };
	for (const order of permutations([older, supplement, third])) {
		assert.equal(selectGrant(order, "dispatch", target, now)?.grant.id, older.id, "omitted jobs keep legacy selection");
		assert.equal(selectGrant(order, "dispatch", target, now, counted.slice(0, 2))?.grant.id, older.id, "room under original");
		assert.equal(selectGrant(order, "dispatch", target, now, counted)?.grant.id, supplement.id, "first eligible in sorted order");
		assert.equal(selectGrant(order.map((grant) => grant.id === supplement.id ? { ...grant, job_ids: older.job_ids } : grant), "dispatch", target, now, counted)?.grant.id, third.id, "skip full supplement");
	}
});

test("cap-paused original does not shadow active supplement in either order", async (t) => {
	const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
	store.pause(older.id, "spend_cap");
	for (const order of permutations([older, supplement])) {
		store.list = () => order.map((grant) => store.require(grant.id));
		assert.equal((await store.assertDispatchAllowed(job, counted)).selected?.id, supplement.id);
	}
});

test("current job is excluded from selection headroom; accounting and continuations stay stable after re-dispatch", async (t) => {
	const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
	store.save({ ...supplement, job_cap: 1 });
	for (const order of permutations([older, supplement])) {
		store.list = () => order.map((grant) => store.require(grant.id));
		for (const dispatched_at of ["2026-10-09T12:00:00Z", "2026-10-09T14:00:00Z"]) {
			const jobs = [...counted, { job_id: job.jobId, project: "demo", kind: "ship" as const, phase: "held", dispatched_at, usage: { cost_usd: 2, total_tokens: 20 }, reviewer_usage: { cost_usd: 1, total_tokens: 10 } }];
			assert.deepEqual(mandateSpend(older, jobs), { usd: 3, tokens: 30, jobs: 4, inFlight: 0 });
			assert.deepEqual(mandateSpend(supplement, jobs), { usd: 3, tokens: 30, jobs: 1, inFlight: 0 });
			for (const use of ["review", "repair", "merge", "promote"] as const) assert.equal(store.assertPermitted(use, job, jobs).selected?.id, supplement.id);
			assert.equal((await store.assertDispatchAllowed({ ...job, promotion: true }, jobs)).selected?.id, supplement.id);
			assert.equal((await store.assertDispatchAllowed(job, jobs.map((row) => row.job_id === job.jobId ? { ...row, phase: "failed" } : row))).selected?.id, supplement.id);
			for (const kind of ["diff", "merge"] as const) {
				const verdict = evaluateAuthority({ ...job, kind, jobKind: "ship", now, usageJobs: jobs }, store.list());
				assert.ok(verdict.permitted); assert.equal(verdict.mandateId, supplement.id);
			}
			assert.equal(store.selection("repair", job, jobs.slice(1))?.grant.id, older.id, "original-dispatched target keeps original while room remains without it");
		}
	}
	store.save({ ...store.require(older.id), job_cap: 4 });
	assert.equal(store.selection("dispatch", job, counted)?.grant.id, older.id, "operator cap raise returns selection to original (documented edge)");
});

for (const approved of [false, true]) {
	test(`selected supplement owns risk approval and audit (approved=${approved}) in either order`, async (t) => {
		const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
		const pre = { operator_quote: "Approve the risky work.", decided_by: "operator-quote" as const, scope: "named_jobs" as const, job_ids: [job.jobId], granted_at: now };
		store.save({ ...older, ask_on: ["risk:high"] }); store.preapproveRisk(older.id, pre);
		store.save({ ...supplement, ask_on: ["risk:high"] });
		if (approved) store.preapproveRisk(supplement.id, pre);
		for (const order of permutations([older, supplement])) {
			store.list = () => order.map((grant) => store.require(grant.id));
			assert.equal(store.wouldAskRiskHigh(job, "high", counted), !approved);
			if (approved) assert.equal((await store.assertDispatchAllowed({ ...job, risk: "high" }, counted)).selected?.id, supplement.id);
			else {
				await assert.rejects(store.assertDispatchAllowed({ ...job, risk: "high" }, counted), /risk:high under ask_on/);
				assert.equal(new EscalationStore({ home: home.path }).open().find((row) => row.job_ids.includes(job.jobId))?.mandate_id, supplement.id);
			}
			assert.equal(store.require(older.id).risk_preapproved, undefined);
		}
		if (approved) {
			assert.deepEqual(store.require(supplement.id).risk_preapproved?.map((row) => row.use), ["dispatch", "dispatch"]);
			await assert.rejects(store.assertDispatchAllowed({ ...job, risk: "high", pathHints: ["delete production data"] }, counted), /risk:high under ask_on/, "hard stop still gates");
		}
	});
}

test("selected supplement denial cannot fall back to weaker policy in any permutation", async (t) => {
	const { home, store, older, supplement } = bench(); t.after(() => home.cleanup());
	const weaker = store.issue({ projects: ["demo"], objective: job.jobId, expiry: supplement.expiry, spend_cap: supplement.spend_cap, job_cap: 3, id: "md-333333", at: "2026-10-09T13:00:00Z", job_ids: [job.jobId], allowed_actions: ["implement", "review", "repair", "merge"], ask_on: [] });
	const cases: Array<[Partial<Mandate>, Partial<Parameters<typeof evaluateAuthority>[0]>, RegExp]> = [
		[{ exclusions: { paths: ["src/secret"] } }, { pathHints: ["src/secret.ts"] }, /path src\/secret.ts is excluded/],
		[{ exclusions: { subsystems: ["auth"] } }, { subsystem: "auth" }, /subsystem auth is excluded/],
		[{ allowed_actions: ["review"] }, {}, /implement is not an allowed action/],
		[{ ask_on: ["plan_approval"] }, {}, /ask_on includes plan_approval/],
		[{ ask_on: ["risk:high"] }, { risk: "high" }, /risk:high/],
		[{ spend_cap: { usd: 1, tokens: 100_000 } }, { usageJobs: [...counted, { job_id: job.jobId, project: "demo", usage: { cost_usd: 1, total_tokens: 1 } }] }, /spend cap reached/],
	];
	for (const [over, input, reason] of cases) for (const order of permutations([older, { ...supplement, ...over }, weaker])) {
		const verdict = evaluateAuthority({ ...job, kind: "ship", jobKind: "ship", now, usageJobs: counted, ...input }, order);
		assert.equal(verdict.permitted, false);
		if (!verdict.permitted) { assert.match(verdict.reason, new RegExp(supplement.id)); assert.match(verdict.reason, reason); }
	}
	store.save({ ...supplement, job_ids: [job.jobId, "cp-slot"], dispatch_parallelism: 1 });
	const jobs = [...counted, { job_id: "cp-slot", project: "demo", phase: "waiting" }];
	for (const order of permutations([older, supplement, weaker])) {
		store.list = () => order.map((grant) => store.require(grant.id));
		await assert.rejects(store.assertDispatchAllowed(job, jobs), (error: unknown) => {
			assert.ok(error instanceof Error); assert.equal((error as { code?: string }).code, "parallelism_full"); assert.match(error.message, new RegExp(supplement.id)); return true;
		});
	}
});
