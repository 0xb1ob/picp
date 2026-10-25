/**
 * cp_decide units P10e kept verbatim from tests/decide.test.ts: each names, in docs/testing-migration/p10e.md or
 * b02.md, the entry point no e2e has. Everything reachable moved to tests/e2e/decisions-p10e.test.ts.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore, deriveFromEscalations, type ResolvedAwaitingItem } from "../src/awaiting.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { type DecisionBasis, type Mandate, isoTimestamp, paths } from "../src/contracts.ts";
import { decide } from "../src/decide.ts";
import { EscalationStore, raiseMissionEnd } from "../src/escalation.ts";
import { capReached, evaluateAuthority, GRANT_USES, grantStanding, isInFlight, MandateError, type MandateSubject, MandateStore } from "../src/mandate.ts";
import { assertReviewAllowed } from "../src/mandate-usage.ts";
import { RunRecorder } from "../src/run-artifacts.ts";
import { createScratchHome } from "./harness/index.ts";

function later(ms = 86_400_000): string {
	return isoTimestamp(new Date(Date.now() + ms));
}

function deps(home: string, over: Partial<Parameters<typeof decide>[1]> = {}) {
	const ship = new CheckpointStore(home);
	const diff = new CheckpointStore(home, { kind: "diff" });
	const merge = new CheckpointStore(home, { kind: "merge" });
	const awaiting = new AwaitingStore({ home });
	const mandates = new MandateStore(home);
	return {
		ship,
		diff,
		merge,
		awaiting,
		mandates,
		bundle: {
			items: [] as ResolvedAwaitingItem[],
			ship,
			diff,
			merge,
			answerDeclared: (item: ResolvedAwaitingItem, answer: string, by: string, basis: DecisionBasis) =>
				awaiting.answerResolved(item, { answer, by, basis }),
			mandates,
			lookupJob: (jobId: string) => ({ project: "demo", jobKind: "ship" as const, jobId }),
			usageJobs: () => [],
			operatorTexts: ["Please approve the plan. Ship it today."],
			...over,
		},
	};
}

// Kept by P2e from tests/mandate.test.ts (retained): permission tables, accounting edges, reviewer spend, instants and
// legacy grant shapes no e2e drives. 02-2, 02-13, 02-15 and 02-17 pin the reachable outcomes beside them.
const earlier = (ms = 86_400_000) => isoTimestamp(new Date(Date.now() - ms));
function issueGrant(
	store: MandateStore,
	over: Parameters<MandateStore["issue"]>[0] extends infer T ? Partial<T> : never = {},
	jobs: Parameters<MandateStore["issue"]>[1] = [],
) {
	return store.issue({ projects: ["demo"], objective: "ship the bump", expiry: later(), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ...over }, jobs);
}

test("a shrinking reading on one baselined job never funds another job's growth", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issueGrant(store, { spend_cap: { usd: 100, tokens: 3_000_000 } }, [{ job_id: "cp-a", project: "demo", phase: "done", usage: { cost_usd: 1, total_tokens: 1_000_000 } }]);
	const after = [
		{ job_id: "cp-a", project: "demo", phase: "waiting", usage: { cost_usd: 0, total_tokens: 0 } },
		{ job_id: "cp-b", project: "demo", phase: "waiting", usage: { cost_usd: 1, total_tokens: 3_000_000 } },
	];
	assert.equal(capReached(store.require(grant.id), after), "token");
});

test("worker accrual is never masked by a reviewer baseline", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const reviewer = (dir: string, tokens: number, usd: number, cacheRead: number) => {
		const recorder = RunRecorder.open({ home: home.path, jobId: "cp-rev", dir: join(home.path, dir) });
		recorder.pi({ type: "message_end", message: { role: "assistant", usage: { input: tokens, output: 0, cacheRead, totalTokens: tokens + cacheRead, cost: { total: usd } } } } as never);
		recorder.close();
	};
	reviewer(paths.reviewRunDir("cp-rev", 1), 5_000, 1, 0);
	const jobs = [{ job_id: "cp-rev", project: "demo", phase: "held", usage: { cost_usd: 0.5, total_tokens: 1_000 } }];
	const grant = issueGrant(store, { job_ids: ["cp-rev"], spend_cap: { usd: 10, tokens: 10_000 } }, jobs);
	assert.deepEqual(grant.usage_baseline, [{ job_id: "cp-rev", usd: 0.5, tokens: 1_000, reviewer_usd: 1, reviewer_tokens: 5_000 }]);
	// Raw jobs, no reviewer runs read: a combined baseline (6,000) would read 5,000 here and miss the cap.
	assert.equal(capReached(grant, [{ ...jobs[0]!, usage: { cost_usd: 0.5, total_tokens: 11_000 } }]), "token");
	reviewer(paths.reviewRunDir("cp-rev", 2), 2_000, 0.5, 0);
	assert.match(store.show(grant.id, jobs), /; 2000 \/ 10000 non-cached tokens/);
});

test("gate, diff-review and quality-panel reviewer spend counts toward the covering grant's USD and token caps, non-cached", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issueGrant(store, { job_ids: ["cp-rev"], spend_cap: { usd: 3, tokens: 10_000 } });
	const jobs = [{ job_id: "cp-rev", project: "demo", phase: "held", usage: { cost_usd: 1, total_tokens: 1_000, cache_read: 0 } }];
	const reviewer = (dir: string, tokens: number, usd: number, cacheRead: number) => {
		const recorder = RunRecorder.open({ home: home.path, jobId: "cp-rev", dir: join(home.path, dir) });
		recorder.pi({ type: "message_end", message: { role: "assistant", usage: { input: tokens, output: 0, cacheRead, totalTokens: tokens + cacheRead, cost: { total: usd } } } } as never);
		recorder.close();
	};
	reviewer(paths.gateRunDir("cp-rev", 1), 2_000, 0.5, 90_000);
	reviewer(paths.reviewRunDir("cp-rev", 1), 3_000, 0.5, 90_000);
	reviewer(paths.qualityRunDir("cp-rev", "verify"), 1_000, 0.25, 0);
	assert.match(store.show(grant.id, jobs), /\$2\.25 \/ \$3\.00; 7000 \/ 10000 non-cached tokens/, "cache reads never count");
	assert.equal(store.require(grant.id).status, "active");

	reviewer(paths.reviewRunDir("cp-rev", 2), 1_000, 1, 0);
	const paused = store.sweep(undefined, jobs)[0];
	assert.deepEqual([paused?.status, paused?.pause_reason], ["paused", "spend_cap"], "reviewer spend alone crossed the USD cap");
	const subject: MandateSubject = { kind: "diff", jobId: "cp-rev", project: "demo", jobKind: "ship", usageJobs: store.withReviewerSpend(jobs) };
	assert.equal(evaluateAuthority(subject, [{ ...paused!, status: "active" }]).permitted, false);
});

test("MandateStore writes every instant it is handed at second precision (2026-10-06T00:05Z)", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path, { now: () => new Date("2026-07-01T07:00:20.789Z") });
	const issued = issueGrant(store, { at: "2026-07-01T00:00:20.999Z", expiry: "2026-07-01T07:00:00Z" });
	assert.equal(issued.issued_at, "2026-07-01T00:00:20Z");
	const expired = store.sweep("2026-07-01T07:00:20.123Z").find((mandate) => mandate.id === issued.id);
	assert.deepEqual([expired?.status, expired?.escalations[0]?.at], ["expired", "2026-07-01T07:00:20Z"]);
	// The cap pause (paused_at and its escalation) from a sweep handed a millisecond instant.
	const held = [{ job_id: "cp-held", project: "demo", phase: "held", usage: { total_tokens: 100, cost_usd: 0.1 } }];
	const capped = issueGrant(store, { at: "2026-07-01T00:00:00Z", expiry: "2026-12-31T00:00:00Z", spend_cap: { usd: 20, tokens: 1_000 } }, held);
	const grown = [{ ...held[0]!, usage: { total_tokens: 5_000, cost_usd: 0.1 } }];
	const paused = store.sweep("2026-07-01T07:00:20.456Z", grown).find((mandate) => mandate.id === capped.id);
	assert.deepEqual([paused?.status, paused?.paused_at, paused?.escalations[0]?.at], ["paused", "2026-07-01T07:00:20Z", "2026-07-01T07:00:20Z"]);
	// pause(id, reason) takes no instant: it stamps from the store clock, so this pins the clock path only.
	const operator = issueGrant(store, { at: "2026-07-01T00:00:00Z", expiry: "2026-12-31T00:00:00Z" });
	assert.equal(store.pause(operator.id).paused_at, "2026-07-01T07:00:20Z");
	assert.throws(() => store.sweep("garbage"), (error: Error) => error instanceof MandateError && /invalid timestamp/.test(error.message));
});

test("a grant with no usage_baseline keeps the lifetime rule", (t) => {
	// Every grant written before usage_baseline existed; no entry point writes one now.
	const held = [{ job_id: "cp-held", project: "demo", phase: "held", usage: { total_tokens: 17_550_034, cost_usd: 0.1 } }];
	const legacyHome = createScratchHome();
	t.after(() => legacyHome.cleanup());
	const legacyStore = new MandateStore(legacyHome.path);
	const legacy = issueGrant(legacyStore, { spend_cap: { usd: 20, tokens: 3_000_000 } });
	assert.equal(legacy.usage_baseline, undefined);
	const lifetime = legacyStore.sweep(undefined, held)[0];
	assert.deepEqual([lifetime?.status, lifetime?.pause_reason], ["paused", "token_cap"]);
});

test("a grant paused on job_cap before this rule resumes on the next save", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issueGrant(store, { job_cap: 3, ask_on: ["risk:high"], allowed_actions: ["implement", "review", "repair", "merge"] });
	const legacy = store.save({ ...store.require(grant.id), status: "paused", paused_at: isoTimestamp(), pause_reason: "job_cap" });
	assert.deepEqual([legacy.status, legacy.pause_reason], ["active", undefined]);
});

// The one permission rule (src/mandate-permission.ts), cell by cell, letters in GRANT_USES order: P permit, R refuse,
// S silent. Columns: the job's own same-kind record is working/held, its worker failed, no such record.
test("grantStanding: the complete status x use x in-flight matrix", () => {
	const now = isoTimestamp();
	// SAFETY: a literal carrying every required Mandate field; grantStanding is pure and reads no disk shape beyond these.
	const base = {
		schema_version: 1, id: "md-000000", issued_by: { channel: "operator_chat" }, issued_at: earlier(), expiry: later(), projects: ["demo"],
		objective: "o", allowed_actions: ["plan", "implement", "review", "repair", "merge"], spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10,
		ask_on: [], status: "active", decisions: [], escalations: [],
	} as unknown as Mandate;
	const past = { expiry: earlier(1_000) };
	const rows: Array<[string, Partial<Mandate>, string, string, string]> = [
		["active", {}, "PPPPPP", "PPPPPP", "PPPPPP"],
		["operator-paused", { status: "paused", pause_reason: "operator" }, "SSRRSR", "SSRRSR", "SSRRSR"],
		["cap-paused (spend)", { status: "paused", pause_reason: "spend_cap" }, "RRRRRR", "RRRRRR", "RRRRRR"],
		["cap-paused (token)", { status: "paused", pause_reason: "token_cap" }, "RRRRRR", "RRRRRR", "RRRRRR"],
		["revoked", { status: "revoked" }, "SSRRRR", "SSRRRR", "SSRRRR"],
		["expired (stored)", { status: "expired", ...past }, "RPRPPP", "PPRPPP", "RRRRRR"],
		["expired (active, unswept crossing)", past, "RPRPPP", "PPRPPP", "RRRRRR"],
		["operator-paused past expiry", { status: "paused", pause_reason: "operator", ...past }, "RSRRSR", "SSRRSR", "RRRRRR"],
		["cap-paused past expiry", { status: "paused", pause_reason: "spend_cap", ...past }, "RRRRRR", "RRRRRR", "RRRRRR"],
		["revoked past expiry", { status: "revoked", ...past }, "SSRRRR", "SSRRRR", "SSRRRR"],
		["expired, only implement allowed", { status: "expired", ...past, allowed_actions: ["implement"] }, "RRRRRR", "PRRRRR", "RRRRRR"],
		["expired, only repair allowed", { status: "expired", ...past, allowed_actions: ["repair"] }, "RPRRPR", "RPRRPR", "RRRRRR"],
	];
	const letter = { permit: "P", refuse: "R", silent: "S", none: "-" } as const;
	for (const [label, over, held, failed, fresh] of rows) {
		const grant = { ...base, ...over } as Mandate;
		for (const [state, flight, expected] of [["held", { inFlight: true }, held], ["failed", { inFlight: true, failed: true }, failed], ["no record", { inFlight: false }, fresh]] as const) {
			const got = GRANT_USES.map((use) => letter[grantStanding(grant, use, { jobId: "cp-a", project: "demo", jobKind: "ship", ...flight }, now).standing]).join("");
			assert.equal(got, expected, `${label}, ${state}`);
		}
	}
	for (const out of [{ project: "other" }, { jobKind: "research" as const }]) {
		const grant = { ...base, exclusions: { job_kinds: ["research"] } } as Mandate;
		assert.equal(grantStanding(grant, "review", { jobId: "cp-a", project: "demo", jobKind: "ship", inFlight: true, ...out }, now).standing, "none", "not covered: no standing");
	}
	// In flight means the job's own record: same id, same project, same kind.
	const fleet = [{ job_id: "cp-a", project: "demo", kind: "research" as const, phase: "held" }];
	assert.equal(isInFlight({ jobId: "cp-a", project: "demo", jobKind: "research" }, fleet), true);
	assert.equal(isInFlight({ jobId: "cp-a", project: "demo", jobKind: "ship" }, fleet), false, "research to ship is a kind change");
	assert.equal(isInFlight({ jobId: "cp-a", project: "other", jobKind: "research" }, fleet), false);
});

test("a reviewer start keeps its pre-rule path under an expired grant: no fleet record, review not allowed, cap reached all pass; paused and revoked still refuse", async (t) => {
	const job = { jobId: "cp-old", project: "demo", kind: "ship" as const };
	const held = [{ job_id: "cp-old", project: "demo", kind: "ship" as const, phase: "held" }];
	// label, grant overrides, then-status, fleet, reviewer start refused?, repair (the expiry policy, unchanged) refused?
	type Row = [string, Parameters<typeof issueGrant>[1], "paused" | "revoked" | undefined, Parameters<MandateStore["assertPermitted"]>[2], RegExp | undefined, RegExp | undefined];
	const cases: Row[] = [
		["expired, no fleet record", {}, undefined, [], undefined, /no fleet record of that kind/],
		["expired, review not an allowed action", { allowed_actions: ["implement", "repair"] }, undefined, held, undefined, undefined],
		["expired, spend cap reached", { spend_cap: { usd: 5, tokens: 100_000 } }, undefined, [{ ...held[0]!, usage: { cost_usd: 6, total_tokens: 10 } }], undefined, /spend cap reached/],
		["expired, token cap reached", { spend_cap: { usd: 5, tokens: 100 } }, undefined, [{ ...held[0]!, usage: { cost_usd: 0, total_tokens: 500 } }], undefined, /token cap reached/],
		["paused (operator)", {}, "paused", held, /is paused .*no new reviewer spend/, undefined],
		["revoked", {}, "revoked", held, /is revoked .*no new reviewer spend/, /is revoked .*no repair/],
	];
	for (const [label, over, status, jobs, refused, repairRefused] of cases) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const store = new MandateStore(home.path);
		const grant = issueGrant(store, { expiry: status ? later() : earlier(1_000), at: earlier(), ...over });
		if (status === "paused") store.pause(grant.id);
		if (status === "revoked") store.revoke(grant.id);
		if (refused) await assert.rejects(() => assertReviewAllowed(store, job, jobs), refused, label);
		else {
			await assert.doesNotReject(() => assertReviewAllowed(store, job, jobs), label);
			assert.deepEqual(store.assertPermitted("review", job, jobs), {}, `${label}: the expired grant does not speak`);
		}
		if (repairRefused) assert.throws(() => store.assertPermitted("repair", job, jobs), repairRefused, `${label}: repair keeps its policy`);
		else assert.doesNotThrow(() => store.assertPermitted("repair", job, jobs), `${label}: repair keeps its policy`);
	}
	// Fresh dispatch keeps the expiry policy too.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issueGrant(store, { expiry: earlier(1_000), at: earlier() });
	assert.throws(() => store.assertPermitted("dispatch", { ...job, jobId: "cp-new" }, held), /expired at .* fresh start/);
});

// Kept from tests/mandate.test.ts by P3 (P2e review): multi-grant ordering and the rules that still bind an expired
// grant's continuation. 02-17 pins the single-grant diff/ship decision and the expiry refusals beside them.
test("an expired grant decides diff and merge for an in-flight job, never a ship; every other rule still binds", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const all = ["implement", "review", "repair", "merge"] as const;
	const grant = issueGrant(store, { expiry: earlier(1_000), at: earlier(), ask_on: ["risk:high"], allowed_actions: [...all], spend_cap: { usd: 5, tokens: 100_000 } });
	store.sweep();
	const fleet = [{ job_id: "cp-old", project: "demo", phase: "held" }];
	const subject = (over: Partial<MandateSubject> = {}): MandateSubject => ({ kind: "ship", jobId: "cp-ship1", project: "demo", jobKind: "ship", ...over });
	const judge = (over: Partial<MandateSubject>, grants = store.list()) =>
		evaluateAuthority(subject({ jobId: "cp-old", usageJobs: fleet, ...over }), grants);

	for (const kind of ["diff", "merge"] as const) {
		const verdict = judge({ kind });
		assert.equal(verdict.permitted && verdict.mandateId, grant.id, `${kind} of an in-flight job continues`);
		if (verdict.permitted) assert.match(verdict.clause, /expired grant continues in-flight cp-old/);
	}
	const ship = judge({ kind: "ship" });
	assert.equal(!ship.permitted && ship.reason, `${grant.id} has expired`, "a first ship authorization never rides an expired grant");
	const freshJob = judge({ kind: "diff", jobId: "cp-new" });
	assert.equal(!freshJob.permitted && freshJob.reason, `${grant.id} has expired`, "no fleet record: not a continuation");
	assert.equal(judge({ kind: "diff", project: "other" }).permitted, false);

	// Exclusions, risk:high, caps, ask_on merge and allowed actions are unchanged.
	const high = judge({ kind: "diff", risk: "high" });
	assert.equal(!high.permitted && /risk:high/.test(high.reason), true);
	const spent = [{ ...fleet[0]!, usage: { cost_usd: 6, total_tokens: 10 } }];
	assert.deepEqual(judge({ kind: "merge", usageJobs: spent }), { permitted: false, reason: `${grant.id}: spend cap reached` });
	const asks = { ...grant, id: "md-aaaaaa", ask_on: ["merge" as const] };
	assert.deepEqual(judge({ kind: "merge" }, [asks]), { permitted: false, reason: "md-aaaaaa: ask_on includes merge" });
	const excluded = { ...grant, id: "md-bbbbbb", exclusions: { paths: ["src/secrets"] } };
	assert.equal(judge({ kind: "diff", pathHints: ["src/secrets/key.ts"] }, [excluded]).permitted, false);
	const noMerge = { ...grant, id: "md-cccccc", allowed_actions: ["implement" as const, "review" as const] };
	assert.deepEqual(judge({ kind: "merge" }, [noMerge]), { permitted: false, reason: "md-cccccc has expired" });

	// Any active grant decides; otherwise the latest speaking grant does.
	const revoked = { ...grant, id: "md-dddddd", status: "revoked" as const, expiry: later() };
	assert.equal(judge({ kind: "diff" }, [revoked, grant]).permitted, true, "an older revoked grant does not stall the in-flight job");
	assert.equal(judge({ kind: "diff" }, [grant, revoked]).permitted, false, "a newer revoked grant refuses its review");
	const paused = { ...grant, id: "md-eeeeee", status: "paused" as const, pause_reason: "spend_cap", expiry: later() };
	assert.deepEqual(judge({ kind: "diff" }, [grant, paused]), { permitted: false, reason: "md-eeeeee is paused (spend_cap)" });
	const active = { ...grant, id: "md-ffffff", status: "active" as const, expiry: later(), ask_on: ["merge" as const] };
	assert.deepEqual(judge({ kind: "merge" }, [grant, active]), { permitted: false, reason: "md-ffffff: ask_on includes merge" });
	const newer = judge({ kind: "diff" }, [grant, active]);
	assert.equal(newer.permitted && newer.mandateId, "md-ffffff", "the active grant decides, not the expired one");
});

test("after expiry: risk:high still gates the continuation; a newer expired grant without repair refuses it; a revoked-only project never refuses dispatch", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issueGrant(store, { expiry: earlier(1_000), objective: "done", at: earlier(), spend_cap: { usd: 5, tokens: 100_000 } });
	store.sweep();
	const fleet = [{ job_id: "cp-old", project: "demo", kind: "ship" as const, phase: "held" }];
	const job = (jobId = "cp-old") => ({ jobId, project: "demo", kind: "ship" as const });
	await assert.rejects(() => store.assertDispatchAllowed({ ...job(), promotion: true, risk: "high" }, fleet), /risk:high under ask_on/);

	// The latest speaking grant decides: a newer expired grant without repair refuses it.
	const strictHome = createScratchHome();
	t.after(() => strictHome.cleanup());
	const strict = new MandateStore(strictHome.path);
	issueGrant(strict, { expiry: earlier(1_000), at: earlier(), allowed_actions: ["implement", "review"] });
	assert.throws(() => strict.assertPermitted("repair", job(), fleet), /repair is not an allowed action/);
	await assert.rejects(() => strict.assertDispatchAllowed({ ...job(), promotion: true }, fleet), /repair is not an allowed action/);

	// A revoked-only project never refuses human dispatch.
	const otherHome = createScratchHome();
	t.after(() => otherHome.cleanup());
	const other = new MandateStore(otherHome.path);
	other.revoke(issueGrant(other, { objective: "revoked grant" }).id);
	await other.assertDispatchAllowed({ jobId: "cp-new2", project: "demo", kind: "ship" });
});

test("risk:high requires operator text", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ship, mandates, bundle } = deps(home.path, {
		lookupJob: () => ({ project: "demo", jobKind: "ship", risk: "high" }),
	});
	const grant = mandates.issue({
		projects: ["demo"],
		objective: "ship the bump",
		expiry: later(),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
	});
	ship.request({ jobId: "cp-ship1", question: "Authorize implementation?" });
	await assert.rejects(
		() =>
			decide({ target: "cp-ship1", decision: "approve", basis: { mandate: grant.id, clause: "x" } }, bundle),
		/risk:high requires operator text/,
	);
});

async function missionEndBench(home: string) {
	const escalations = new EscalationStore({ home });
	const base = deps(home);
	const grant = (objective: string) =>
		base.mandates.issue({ projects: ["demo"], objective, expiry: later(), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, job_ids: ["cp-a"] });
	const target = grant("finished");
	const unrelated = grant("unrelated");
	const raised = await raiseMissionEnd(escalations, { jobIds: ["cp-a"], mandateId: target.id, summary: "landed 1, dropped 0, cost $1.00" });
	const bundle = (): Parameters<typeof decide>[1] => ({
		...base.bundle,
		items: deriveFromEscalations(escalations.open()),
		operatorTexts: [`close ${raised.id}`, `extend ${raised.id}`],
		answerEscalation: (id, answer, by) => escalations.answer(id, { answer, by }),
		getEscalation: (id) => escalations.get(id),
	});
	return { escalations, mandates: base.mandates, target, unrelated, raised, bundle };
}

test("a close whose revoke failed after the answer converges on the same call retried", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { escalations, mandates, target, unrelated, raised, bundle } = await missionEndBench(home.path);
	const revoke = mandates.revoke.bind(mandates);
	let failures = 1;
	mandates.revoke = (id: string) => {
		if (failures-- > 0) throw new Error("disk full");
		return revoke(id);
	};
	const call = () => decide({ target: raised.id, decision: "close", basis: { operator_quote: "close" } }, bundle());
	await assert.rejects(call, /disk full/);
	assert.deepEqual([escalations.get(raised.id)?.status, mandates.get(target.id)?.status], ["answered", "active"], "the partial write");
	assert.equal(bundle().items.length, 0, "no longer an Awaiting row, yet still addressable by id");
	const retried = await call();
	assert.match(retried.text, /revoked/);
	assert.equal(mandates.get(target.id)?.status, "revoked");
	assert.equal(mandates.get(unrelated.id)?.status, "active");
	await call();
	assert.equal(mandates.get(target.id)?.status, "revoked", "a third call is a no-op");
});
