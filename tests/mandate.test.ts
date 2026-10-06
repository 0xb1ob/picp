/**
 * Mandate store: evaluation matrix, auto-decision journal, caps, show.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import {
	isoTimestamp,
	type Mandate,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/contracts.ts";
import { escalationApproves, EscalationStore } from "../src/escalation.ts";
import {
	autoDecideCheckpoint,
	capReached,
	covers,
	formatMandate,
	evaluateAuthority,
	extractBareIssueRef,
	GRANT_USES,
	grantStanding,
	isInFlight,
	MandateError,
	MANDATE_JOBS_THIS_TURN,
	type MandateSubject,
	MandateStore,
	projectWideCapWarning,
	resolveMandateJobIds,
	resolveMandateObjectiveRef,
} from "../src/mandate.ts";
import { join } from "node:path";
import { paths } from "../src/contracts.ts";
import { SCAFFOLD_MANDATE_DEFAULTS, setMandateDefault } from "../src/mandate-defaults.ts";
import { RunRecorder } from "../src/run-artifacts.ts";
import { CommandPost } from "../src/command-post.ts";
import { awaitingListText } from "../extensions/command-post/index.ts";
import { assertReviewAllowed, raiseTokenCap } from "../src/mandate-usage.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT } from "./harness/index.ts";
import { batchRiskHigh } from "../src/risk-batch.ts";

function later(ms = 86_400_000): string {
	return isoTimestamp(new Date(Date.now() + ms));
}

function earlier(ms = 86_400_000): string {
	return isoTimestamp(new Date(Date.now() - ms));
}

function subject(over: Partial<MandateSubject> = {}): MandateSubject {
	return { kind: "ship", jobId: "cp-ship1", project: "demo", jobKind: "ship", ...over };
}

function issue(
	store: MandateStore,
	over: Parameters<MandateStore["issue"]>[0] extends infer T ? Partial<T> : never = {},
	jobs: Parameters<MandateStore["issue"]>[1] = [],
) {
	return store.issue({
		projects: ["demo"],
		objective: "ship the bump",
		expiry: later(),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		...over,
	}, jobs);
}

test("cp_mandate is parent-only", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_mandate"));
});

test("resolveMandateJobIds expands all jobs created in this turn", () => {
	assert.equal(resolveMandateJobIds(undefined, ["cp-a"]), undefined);
	assert.deepEqual(resolveMandateJobIds(["cp-a", "cp-b"], []), ["cp-a", "cp-b"]);
	assert.deepEqual(resolveMandateJobIds([MANDATE_JOBS_THIS_TURN], ["cp-a", "cp-b"]), ["cp-a", "cp-b"]);
	assert.throws(() => resolveMandateJobIds([MANDATE_JOBS_THIS_TURN], []), /no jobs created in this turn/);
	assert.throws(
		() => resolveMandateJobIds([MANDATE_JOBS_THIS_TURN, "cp-a"], ["cp-a"]),
		/cannot mix with job ids/,
	);
});

test("cp_mandate issue stores expanded this-turn job ids", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const ids = resolveMandateJobIds([MANDATE_JOBS_THIS_TURN], ["cp-one", "cp-two"]);
	const grant = issue(store, { job_ids: ids, objective: "the list" });
	assert.deepEqual(grant.job_ids, ["cp-one", "cp-two"]);
});

test("evaluateAuthority: permitted / not-permitted matrix", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store);

	const yes = evaluateAuthority(subject(), [grant]);
	assert.equal(yes.permitted, true);
	if (yes.permitted) {
		assert.equal(yes.mandateId, grant.id);
		assert.match(yes.clause, /implement for project demo/);
	}

	const mismatch = evaluateAuthority(subject({ project: "other" }), [grant]);
	assert.equal(mismatch.permitted, false);
	if (!mismatch.permitted) assert.match(mismatch.reason, /no active mandate covers/);

	const excluded = evaluateAuthority(subject({ pathHints: ["src/secrets/key.ts"] }), [
		issue(store, { exclusions: { paths: ["src/secrets"] }, objective: "except secrets" }),
	]);
	assert.equal(excluded.permitted, false);
	if (!excluded.permitted) assert.match(excluded.reason, /path src\/secrets\/key.ts is excluded/);

	const high = evaluateAuthority(subject({ risk: "high", riskProvenance: "explicit" }), [grant]);
	assert.equal(high.permitted, false);
	if (!high.permitted) assert.match(high.reason, /risk:high/);

	const inferredHigh = evaluateAuthority(subject({ risk: "high", riskProvenance: "inferred" }), [grant]);
	assert.equal(inferredHigh.permitted, false);

	const expired = evaluateAuthority(subject({ now: isoTimestamp() }), [
		issue(store, { expiry: earlier(1_000), objective: "already done", at: earlier() }),
	]);
	assert.equal(expired.permitted, false);
	if (!expired.permitted) assert.match(expired.reason, /expired/);

	const paused = store.pause(grant.id);
	const pausedEval = evaluateAuthority(subject(), [paused]);
	assert.equal(pausedEval.permitted, false);
	if (!pausedEval.permitted) assert.match(pausedEval.reason, /paused/);
	store.resume(grant.id);

	const capped = evaluateAuthority(subject({
		usageJobs: [{ job_id: "cp-a", project: "demo", usage: { cost_usd: 11, total_tokens: 1 } }],
	}), [store.require(grant.id)]);
	assert.equal(capped.permitted, false);
	if (!capped.permitted) assert.match(capped.reason, /spend cap/);

	const askOn = evaluateAuthority(subject(), [
		issue(store, { ask_on: ["plan_approval", "merge", "risk:high"], objective: "still ask" }),
	]);
	assert.equal(askOn.permitted, false);
	if (!askOn.permitted) assert.match(askOn.reason, /plan_approval/);

	const flagged = evaluateAuthority(subject({ gateFlags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false } }), [grant]);
	assert.equal(flagged.permitted, false);
	if (!flagged.permitted) assert.match(flagged.reason, /gate flags raised/);
});

test("auto-decision journals the clause; revoke leaves pending pending", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	const grant = issue(mandates);
	const checkpoints = new CheckpointStore(home.path);
	const pending = checkpoints.request({ jobId: "cp-ship1", question: "Authorize implementation of cp-ship1?" });
	const decided = autoDecideCheckpoint(checkpoints, pending, subject(), mandates);
	assert.equal(decided.decision, "approved");
	assert.equal(decided.decided_by, `mandate:${grant.id}`);
	assert.match(decided.note ?? "", /allowed_actions includes implement/);
	const shown = mandates.show(grant.id);
	assert.match(shown, /cp-ship1/);
	assert.match(shown, /allowed_actions includes implement/);

	const revokedHome = createScratchHome();
	t.after(() => revokedHome.cleanup());
	const other = new MandateStore(revokedHome.path);
	const revoked = issue(other, { objective: "revoked grant" });
	other.revoke(revoked.id);
	const still = new CheckpointStore(revokedHome.path);
	const open = still.request({ jobId: "cp-ship2", question: "Authorize implementation of cp-ship2?" });
	const left = autoDecideCheckpoint(still, open, subject({ jobId: "cp-ship2" }), other);
	assert.equal(left.decision, "pending");
	assert.equal(left.decided_by, undefined);
});

test("a raised gate flag is never mandate-decided", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	const grant = issue(mandates);
	const checkpoints = new CheckpointStore(home.path);
	const pending = checkpoints.request({ jobId: "cp-ship1", question: "Authorize implementation of cp-ship1?" });
	const flagged = autoDecideCheckpoint(
		checkpoints,
		pending,
		subject({ gateFlags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false } }),
		mandates,
	);
	assert.equal(flagged.decision, "pending");
	assert.equal(flagged.decided_by, undefined);
	assert.equal(mandates.show(grant.id).includes("cp-ship1"), false, "a flagged checkpoint is not journaled as a mandate decision");

	// blocking_unknowns is not a gate veto flag, but it still blocks the mandate.
	const unknowns = autoDecideCheckpoint(
		checkpoints,
		pending,
		subject({ gateFlags: { destructive_scope: false, scope_growth: false, blocking_unknowns: true } }),
		mandates,
	);
	assert.equal(unknowns.decision, "pending");

	// No flag raised: the mandate still auto-decides.
	const decided = autoDecideCheckpoint(
		checkpoints,
		pending,
		subject({ gateFlags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false } }),
		mandates,
	);
	assert.equal(decided.decision, "approved");
	assert.equal(decided.decided_by, `mandate:${grant.id}`);
});

test("hitting the spend cap pauses, refuses a new dispatch, and escalates once", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { spend_cap: { usd: 1, tokens: 100 }, job_cap: 10 });
	const jobs = [
		{ job_id: "cp-spent", project: "demo", phase: "held" as const, usage: { cost_usd: 1.5, total_tokens: 10 } },
	];
	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: "cp-next", project: "demo", kind: "ship" }, jobs),
		(error: Error) => {
			assert.ok(error instanceof MandateError);
			assert.match(error.message, /no new dispatch/);
			return true;
		},
	);
	const after = store.require(grant.id);
	assert.equal(after.status, "paused");
	assert.equal(after.pause_reason, "spend_cap");
	assert.equal(after.escalations.length, 1);
	assert.equal(after.escalations[0]?.kind, "spend_cap");
	await store.assertDispatchAllowed({ jobId: "cp-other", project: "other", kind: "ship" }, jobs);
	store.sweep(undefined, jobs);
	assert.equal(store.require(grant.id).escalations.length, 1, "one escalation");
	assert.match(store.show(grant.id, jobs), /spend_cap/);
});

test("MandateStore writes every instant it is handed at second precision (2026-10-06T00:05Z)", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path, { now: () => new Date("2026-07-01T07:00:20.789Z") });
	const issued = issue(store, { at: "2026-07-01T00:00:20.999Z", expiry: "2026-07-01T07:00:00Z" });
	assert.equal(issued.issued_at, "2026-07-01T00:00:20Z");
	const expired = store.sweep("2026-07-01T07:00:20.123Z").find((mandate) => mandate.id === issued.id);
	assert.deepEqual([expired?.status, expired?.escalations[0]?.at], ["expired", "2026-07-01T07:00:20Z"]);
	// The cap pause (paused_at and its escalation) from a sweep handed a millisecond instant.
	const held = [{ job_id: "cp-held", project: "demo", phase: "held", usage: { total_tokens: 100, cost_usd: 0.1 } }];
	const capped = issue(store, { at: "2026-07-01T00:00:00Z", expiry: "2026-12-31T00:00:00Z", spend_cap: { usd: 20, tokens: 1_000 } }, held);
	const grown = [{ ...held[0]!, usage: { total_tokens: 5_000, cost_usd: 0.1 } }];
	const paused = store.sweep("2026-07-01T07:00:20.456Z", grown).find((mandate) => mandate.id === capped.id);
	assert.deepEqual([paused?.status, paused?.paused_at, paused?.escalations[0]?.at], ["paused", "2026-07-01T07:00:20Z", "2026-07-01T07:00:20Z"]);
	// An operator pause under a millisecond clock.
	const operator = issue(store, { at: "2026-07-01T00:00:00Z", expiry: "2026-12-31T00:00:00Z" });
	assert.equal(store.pause(operator.id).paused_at, "2026-07-01T07:00:20Z");
	assert.throws(() => store.sweep("garbage"), (error: Error) => error instanceof MandateError && /invalid timestamp/.test(error.message));
});

test("a new grant counts only usage accrued after issue; only a zero cap is refused, and nothing is written", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	// The incident: a held job had spent 17.5M tokens; the replacement grant capped 3M paused at once.
	const held = [{ job_id: "cp-held", project: "demo", phase: "held", usage: { total_tokens: 17_550_034, cost_usd: 0.1 } }];
	const grant = issue(store, { spend_cap: { usd: 20, tokens: 3_000_000 } }, held);
	assert.equal(grant.status, "active");
	assert.deepEqual(grant.usage_baseline, [{ job_id: "cp-held", usd: 0.1, tokens: 17_550_034 }]);
	assert.equal(store.sweep(undefined, held)[0]?.status, "active", "it does not pause on its first sweep");
	const shown = store.show(grant.id, held);
	assert.match(shown, /\$0\.00 \/ \$20\.00; 0 \/ 3000000 non-cached tokens/);
	assert.match(shown, /job cap: 0 \/ 10/);
	const grown = [{ ...held[0]!, usage: { total_tokens: 20_550_034, cost_usd: 0.1 } }];
	const paused = store.sweep(undefined, grown).find((mandate) => mandate.id === grant.id);
	assert.deepEqual([paused?.status, paused?.pause_reason], ["paused", "token_cap"], "3M accrued after issue binds the 3M cap");

	const before = store.list().length;
	assert.throws(
		() => issue(store, { spend_cap: { usd: 0, tokens: 3_000_000 } }, held),
		(error: Error) => error instanceof MandateError && /refused: the usd cap leaves nothing to spend/.test(error.message),
	);
	assert.equal(store.list().length, before, "a refused grant is never written");

	// Usage outside the grant's scope is not its usage.
	assert.equal(issue(store, { projects: ["other"], spend_cap: { usd: 20, tokens: 3_000_000 } }, held).status, "active");
	assert.equal(issue(store, { job_ids: ["cp-new"], spend_cap: { usd: 20, tokens: 3_000_000 } }, held).status, "active");

	// The job cap limits new dispatches only: a grant its covered jobs already fill still carries their review and merge.
	const three = ["cp-a", "cp-b", "cp-c"].map((job_id) => ({ job_id, project: "jobs", phase: "done" }));
	assert.equal(issue(store, { projects: ["jobs"], job_cap: 3 }, three).status, "active");

	// A grant with no baseline (every grant written before usage_baseline) keeps the lifetime rule.
	const legacyHome = createScratchHome();
	t.after(() => legacyHome.cleanup());
	const legacyStore = new MandateStore(legacyHome.path);
	const legacy = issue(legacyStore, { spend_cap: { usd: 20, tokens: 3_000_000 } });
	assert.equal(legacy.usage_baseline, undefined);
	const lifetime = legacyStore.sweep(undefined, held)[0];
	assert.deepEqual([lifetime?.status, lifetime?.pause_reason], ["paused", "token_cap"]);
});

test("a project-wide grant: history never fills the job cap; new dispatches and pre-existing jobs that spend under it do", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const history = [1, 2, 3, 4, 5].map((n) => ({ job_id: `cp-h${n}`, project: "demo", kind: "ship" as const, phase: "done", usage: { cost_usd: 5, total_tokens: 1_000_000 } }));
	const grant = issue(store, { job_cap: 3, spend_cap: { usd: 100, tokens: 10_000_000 } }, history);
	assert.equal(grant.usage_baseline?.length, 5);
	assert.match(store.show(grant.id, history), /job cap: 0 \/ 3/);
	await store.assertDispatchAllowed({ jobId: "cp-n1", project: "demo", kind: "ship" }, history);

	const fresh = ["cp-n1", "cp-n2"].map((job_id) => ({ job_id, project: "demo", kind: "ship" as const, phase: "waiting" }));
	const quiet = [...history, ...fresh];
	await store.assertDispatchAllowed({ jobId: "cp-n3", project: "demo", kind: "ship" }, quiet);
	const grown = quiet.map((job) => (job.job_id === "cp-h1" ? { ...job, usage: { cost_usd: 6, total_tokens: 1_000_000 } } : job));
	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: "cp-n3", project: "demo", kind: "ship" }, grown),
		(error: Error) => error instanceof MandateError && /job cap 3 reached/.test(error.message),
	);
	assert.deepEqual(evaluateAuthority(subject({ jobId: "cp-n3", usageJobs: grown }), [store.require(grant.id)]), { permitted: false, reason: `${grant.id}: job cap reached` });
	await store.assertDispatchAllowed({ jobId: "cp-h2", project: "demo", kind: "ship" }, grown);

	const named = issue(store, { job_ids: ["cp-h1"], job_cap: 1 }, history);
	assert.match(store.show(named.id, history), /job cap: 1 \/ 1/, "a named grant counts every job it names");
});

test("projectWideCapWarning: a project-wide grant is warned that its job cap counts other mandates' jobs; a named grant is not", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const named = issue(store, { job_ids: ["cp-h1"], job_cap: 1 });
	const wide = issue(store, { job_cap: 3 });
	const now = isoTimestamp();
	assert.equal(projectWideCapWarning(named, store.list(), now), undefined);
	const warning = projectWideCapWarning(wide, store.list(), now) ?? "";
	assert.match(warning, new RegExp(`${wide.id} is project-wide.*job cap 3 counts every job.*including jobs covered by ${named.id}.*named-jobs grant`));
	assert.doesNotMatch(projectWideCapWarning(wide, [wide], now) ?? "", /including jobs covered by/);
});

test("a shrinking reading on one baselined job never funds another job's growth", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { spend_cap: { usd: 100, tokens: 3_000_000 } }, [{ job_id: "cp-a", project: "demo", phase: "done", usage: { cost_usd: 1, total_tokens: 1_000_000 } }]);
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
	const grant = issue(store, { job_ids: ["cp-rev"], spend_cap: { usd: 10, tokens: 10_000 } }, jobs);
	assert.deepEqual(grant.usage_baseline, [{ job_id: "cp-rev", usd: 0.5, tokens: 1_000, reviewer_usd: 1, reviewer_tokens: 5_000 }]);
	// Raw jobs, no reviewer runs read: a combined baseline (6,000) would read 5,000 here and miss the cap.
	assert.equal(capReached(grant, [{ ...jobs[0]!, usage: { cost_usd: 0.5, total_tokens: 11_000 } }]), "token");
	reviewer(paths.reviewRunDir("cp-rev", 2), 2_000, 0.5, 0);
	assert.match(store.show(grant.id, jobs), /; 2000 \/ 10000 non-cached tokens/);
});

test("the job cap limits new dispatches only: at 3/3 the grant stays active and its covered jobs keep review, repair and merge", async (t) => {
	// The incident: md-a70d44 paused on job_cap at 3/3 as its third job dispatched, blocking that job's own review and merge.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { job_cap: 3, ask_on: ["risk:high"], allowed_actions: ["implement", "review", "repair", "merge"] });
	const three = ["cp-a", "cp-b", "cp-c"].map((job_id) => ({ job_id, project: "demo", phase: "held" }));
	assert.equal(store.sweep(undefined, three)[0]?.status, "active", "never paused by the job cap");
	await store.assertDispatchAllowed({ jobId: "cp-c", project: "demo", kind: "ship", promotion: true }, three);
	await store.assertDispatchAllowed({ jobId: "cp-c", project: "demo", kind: "ship" }, three);
	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: "cp-d", project: "demo", kind: "ship" }, three),
		(error: Error) => error instanceof MandateError && /job cap 3 reached .* no new dispatch/.test(error.message),
	);
	for (const kind of ["diff", "merge"] as const) {
		const verdict = evaluateAuthority(subject({ kind, jobId: "cp-c", usageJobs: three }), [store.require(grant.id)]);
		assert.equal(verdict.permitted, true, `${kind} of a covered job is never stalled by the job cap`);
	}
	assert.equal(evaluateAuthority(subject({ jobId: "cp-c", usageJobs: three }), [store.require(grant.id)]).permitted, true);
	const fresh = evaluateAuthority(subject({ jobId: "cp-d", usageJobs: three }), [store.require(grant.id)]);
	assert.equal(!fresh.permitted && fresh.reason, `${grant.id}: job cap reached`);

	// A grant paused on job_cap before this rule resumes on the next sweep.
	const legacy = store.save({ ...store.require(grant.id), status: "paused", paused_at: isoTimestamp(), pause_reason: "job_cap" });
	assert.deepEqual([legacy.status, legacy.pause_reason], ["active", undefined]);
});

test("save itself refuses a token cap above the home's token_ceiling, naming defaults_set as the fix; USD never moves", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { spend_cap: { usd: 5, tokens: 1_000 } });
	const ceiling = store.tokenCeiling();
	assert.throws(
		() => store.save({ ...grant, spend_cap: { usd: 5, tokens: ceiling + 1 } }),
		(error: Error) => error instanceof MandateError && /over the home's token_ceiling 100000000.*cp_mandate defaults_set token_ceiling/.test(error.message),
	);
	assert.equal(store.require(grant.id).spend_cap.tokens, 1_000, "a refused save writes nothing");
	assert.equal(store.save({ ...grant, spend_cap: { usd: 900, tokens: ceiling } }).spend_cap.usd, 5, "at the ceiling is allowed; USD never moves");
});

test("an operator issue above token_ceiling is refused, naming defaults_set; it succeeds once the operator raises the ceiling", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const ceiling = store.tokenCeiling();
	assert.throws(
		() => issue(store, { spend_cap: { usd: 5, tokens: ceiling * 2 } }),
		(error: Error) => error instanceof MandateError && /over the home's token_ceiling 100000000 .*raise the ceiling first: cp_mandate defaults_set token_ceiling 200000000/.test(error.message),
	);
	assert.deepEqual(store.list(), [], "a refused issue writes nothing");
	setMandateDefault(home.path, "token_ceiling", String(ceiling * 2));
	const granted = issue(store, { spend_cap: { usd: 5, tokens: ceiling * 2 } });
	assert.deepEqual([granted.status, granted.spend_cap.tokens], ["active", ceiling * 2]);
});

test("revoke, a replacing grant and supersede_stale close a mandate's open escalations as superseded, with no answer", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const escalations = new EscalationStore({ home: home.path });
	const options = [{ id: "pause", label: "pause", consequence: "wait", cost: "delay" }];
	const raise = (question: string, mandate_id?: string, job = "cp-a") =>
		escalations.raise({ job_ids: [job], kind: "budget_exhausted", question, options, recommended: "pause", ...(mandate_id ? { mandate_id } : {}) });

	// Revoke: its own escalation closes, another grant's stays open.
	const revoked = issue(store, { at: earlier(60_000) });
	const other = issue(store, { objective: "other", at: earlier(50_000) });
	const mine = await raise(`${revoked.id} spend cap reached (usd 10)`, revoked.id);
	const theirs = await raise(`${other.id} spend cap reached (usd 10)`, other.id);
	store.revoke(revoked.id);
	assert.deepEqual([escalations.get(mine.id)?.status, escalations.get(mine.id)?.superseded_reason], ["superseded", `${revoked.id} was revoked`]);
	assert.equal(escalations.get(theirs.id)?.status, "open");
	assert.equal(escalations.get(mine.id)?.answer, undefined, "no operator answer recorded");

	// Replaced: a spend-capped grant, then a new grant covering the job.
	const spent = [
		{ job_id: "cp-a", project: "demo", phase: "held" },
		{ job_id: "cp-b", project: "demo", phase: "held", usage: { cost_usd: 11, total_tokens: 1 } },
	];
	store.sweep(undefined, spent);
	assert.equal(store.require(other.id).pause_reason, "spend_cap");
	const replacement = issue(store, { objective: "replacement", spend_cap: { usd: 50, tokens: 100_000 } }, spent);
	assert.equal(escalations.get(theirs.id)?.superseded_reason, `${other.id} was replaced by ${replacement.id}`);

	// Legacy: a record raised before mandate_id was recorded, naming an already-revoked grant in its title.
	const legacy = await raise(`${revoked.id} job cap reached (3)`, undefined, "cp-c");
	const unrelated = await raise("a question about no grant", undefined, "cp-c");
	assert.deepEqual(store.supersedeEscalations(spent).map((item) => item.id), [legacy.id]);
	assert.deepEqual(escalations.open().map((item) => item.id), [unrelated.id]);

	// A new budget question for the same job files under its own title, never merged into a closed record.
	const again = await raise(`${replacement.id} spend cap reached (usd 50)`, replacement.id);
	assert.notEqual(again.id, mine.id);
	assert.equal(again.question, `${replacement.id} spend cap reached (usd 50)`);
});

test("cp_awaiting list output drops an escalation once its mandate is revoked", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	const grant = issue(post.mandates, {});
	const options = [{ id: "pause", label: "pause", consequence: "wait", cost: "delay" }];
	const raised = await post.escalations.raise({ job_ids: ["cp-a"], kind: "budget_exhausted", question: `${grant.id} spend cap reached (usd 10)`, options, recommended: "pause", mandate_id: grant.id });
	assert.match((await awaitingListText(post)).text, new RegExp(raised.id), "open: listed");
	post.mandates.revoke(grant.id);
	const listed = await awaitingListText(post);
	assert.doesNotMatch(listed.text, new RegExp(raised.id), "superseded: gone from the cp_awaiting list output");
	assert.equal(listed.text, "Awaiting you: none");
});

test("expiry supersedes the grant's open escalations on the sweep that expires it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { expiry: later(1_000) });
	const escalations = new EscalationStore({ home: home.path });
	const raised = await escalations.raise({ job_ids: ["cp-a"], kind: "mission_end", question: "end?", options: [{ id: "close", label: "close", consequence: "c", cost: "none" }], recommended: "close", mandate_id: grant.id });
	store.sweep(later(2_000));
	assert.equal(store.require(grant.id).status, "expired");
	assert.equal(escalations.get(raised.id)?.superseded_reason, `${grant.id} expired`);
});

test("gate, diff-review and quality-panel reviewer spend counts toward the covering grant's USD and token caps, non-cached", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { job_ids: ["cp-rev"], spend_cap: { usd: 3, tokens: 10_000 } });
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
	assert.equal(evaluateAuthority(subject({ kind: "diff", jobId: "cp-rev", usageJobs: store.withReviewerSpend(jobs) }), [{ ...paused!, status: "active" }]).permitted, false);
});

test("assertDispatchAllowed: serial limits fresh dispatches by working jobs; a same-worker promotion never takes the slot", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { dispatch_parallelism: 1 });
	const held = [{ job_id: "cp-a", project: "demo", phase: "held", usage: { total_tokens: 10, cost_usd: 0.01 } }];
	await store.assertDispatchAllowed({ jobId: "cp-b", project: "demo", kind: "ship" }, held);
	const bWorking = [...held, { job_id: "cp-b", project: "demo", phase: "waiting" }];
	await assert.rejects(() => store.assertDispatchAllowed({ jobId: "cp-c", project: "demo", kind: "ship" }, bWorking), /dispatch-parallelism 1 is full/);
	await assert.rejects(() => store.assertDispatchAllowed({ jobId: "cp-c", project: "demo", kind: "ship" }, [...held, { job_id: "cp-b", project: "demo", phase: "launching" }]), /dispatch-parallelism 1 is full/);
	// A held, B working: repairing A is the same worker on the same job — it may overlap.
	await store.assertDispatchAllowed({ jobId: "cp-a", project: "demo", kind: "ship", promotion: true }, bWorking);
	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: "cp-a", project: "demo", kind: "ship", promotion: true, risk: "high" }, bWorking),
		/risk:high under ask_on/,
		"a promotion is still gated by risk and pauses, only not by the slot",
	);
});

test("4B2-T0: the parallelism refusal carries code parallelism_full on a real MandateError; a job-cap refusal has no code", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { dispatch_parallelism: 1 });
	const bWorking = [{ job_id: "cp-b", project: "demo", phase: "waiting" }];
	await assert.rejects(() => store.assertDispatchAllowed({ jobId: "cp-c", project: "demo", kind: "ship" }, bWorking), (error: unknown) => {
		assert.ok(error instanceof MandateError);
		assert.equal(error.code, "parallelism_full");
		assert.match(error.message, /dispatch-parallelism 1 is full/);
		return true;
	});
	const capped = createScratchHome();
	t.after(() => capped.cleanup());
	const capStore = new MandateStore(capped.path);
	issue(capStore, { job_cap: 1 });
	await assert.rejects(() => capStore.assertDispatchAllowed({ jobId: "cp-c", project: "demo", kind: "ship" }, [{ job_id: "cp-b", project: "demo", phase: "held" }]), (error: unknown) => {
		assert.ok(error instanceof MandateError);
		assert.match(error.message, /job cap 1 reached/);
		assert.equal(error.code, undefined);
		return true;
	});
});
// The one permission rule (src/mandate-permission.ts), cell by cell: status x use x in-flight. Letters follow
// GRANT_USES order — dispatch, promote, implement, review, repair, merge — P permit, R refuse, S silent. Columns:
// the job's own same-kind fleet record is working/held, that record's worker failed, no such record.
test("a revoked grant predating dispatch has no standing for review, repair or merge; revocation after dispatch still refuses", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	let now = new Date("2026-09-23T00:00:00Z");
	const store = new MandateStore(home.path, { now: () => now });
	const grant = issue(store, { at: "2026-09-22T00:00:00Z", expiry: "2026-10-01T00:00:00Z" });
	const revoked = store.revoke(grant.id);
	now = new Date("2026-09-26T08:23:00Z");
	const job = { jobId: "cp-new", project: "demo", kind: "ship" as const };
	const jobs = [{ job_id: job.jobId, project: job.project, kind: job.kind, dispatched_at: isoTimestamp(now), phase: "held" }];
	for (const use of ["review", "repair", "merge"] as const) {
		assert.deepEqual(store.assertPermitted(use, job, jobs), { active: [] }, `${use}: old revocation does not speak`);
		const older = [{ ...jobs[0]!, dispatched_at: "2026-09-22T12:00:00Z" }];
		assert.throws(() => store.assertPermitted(use, job, older), /revoked/, `${use}: revocation after dispatch still speaks`);
		const sameTime = [{ ...jobs[0]!, dispatched_at: revoked.revoked_at! }];
		assert.throws(() => store.assertPermitted(use, job, sameTime), /revoked/, "same-second uncertainty remains fail closed");
	}
	for (const kind of ["diff", "merge"] as const) {
		const decision = evaluateAuthority(subject({ kind, jobId: job.jobId, usageJobs: jobs, now: isoTimestamp(now) }), [revoked]);
		assert.equal(decision.permitted, false, "ignoring a grant never grants authority");
		if (!decision.permitted) assert.equal(decision.reason, `no active mandate covers ${job.jobId}`);
	}
	createScratchLedger({ home: home.path });
	const created = await new Ledger({ home: home.path, now: () => now }).create({ title: "later job", project: "demo", delivery: "pr", kind: "ship" });
	for (const use of ["review", "repair", "merge"] as const) {
		assert.deepEqual(store.assertPermitted(use, { ...job, jobId: created.id }), { active: [] }, `${use}: creation time is the fallback before dispatch`);
	}
});

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

test("after expiry: in-flight review, repair, same-kind promotion and failed-job continuation go on; fresh dispatch and kind changes never", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const expired = issue(store, { expiry: earlier(1_000), objective: "done", at: earlier(), spend_cap: { usd: 5, tokens: 100_000 } });
	store.sweep();
	assert.equal(store.require(expired.id).status, "expired");
	const fleet = [{ job_id: "cp-old", project: "demo", kind: "ship" as const, phase: "held" }];
	const job = (jobId = "cp-old") => ({ jobId, project: "demo", kind: "ship" as const });
	// Fresh dispatch and new jobs: refused, and no risk ask is raised for them.
	for (const fresh of [{ jobId: "cp-new1" }, { jobId: "cp-new1", risk: "high" as const }, { jobId: "cp-ghost", promotion: true }]) {
		await assert.rejects(() => store.assertDispatchAllowed({ ...job(), ...fresh }, fleet), /expired at .* no fleet record of that kind, so it is a fresh start or a kind change.*cp_mandate issue/, JSON.stringify(fresh));
	}
	await assert.rejects(() => store.assertDispatchAllowed(job(), fleet), /cp-old is in flight; continue its existing worker/);
	assert.equal(new EscalationStore({ home: home.path }).list().length, 0, "a refused start raises no risk ask");
	// A kind-changing promotion (research to ship) is not a continuation.
	const research = [{ ...fleet[0]!, kind: "research" as const }];
	await assert.rejects(() => store.assertDispatchAllowed({ ...job(), promotion: true }, research), /no fleet record of that kind/);
	// Same-kind promotion of the existing worker, and re-dispatch of a failed job, continue under the expired grant.
	await store.assertDispatchAllowed({ ...job(), promotion: true }, fleet);
	await store.assertDispatchAllowed(job(), [{ ...fleet[0]!, phase: "failed" }]);
	// repair of the in-flight job continues; another job, project or kind does not. (Reviewer starts: see the next test.)
	assert.equal(store.assertPermitted("repair", job(), fleet).continuing?.id, expired.id);
	assert.throws(() => store.assertPermitted("repair", job("cp-ghost"), fleet), /no fleet record of that kind/);
	assert.throws(() => store.assertPermitted("repair", job(), [{ ...fleet[0]!, project: "other" }]), /no fleet record/);
	assert.throws(() => store.assertPermitted("repair", job(), research), /no fleet record of that kind/);
	assert.doesNotThrow(() => assertReviewAllowed(store, job(), fleet));
	// Its caps and risk:high ask still bind the continuation; another project is untouched.
	const spent = [{ ...fleet[0]!, usage: { cost_usd: 6, total_tokens: 10 } }];
	assert.throws(() => store.assertPermitted("repair", job(), spent), /expired mandate .* spend cap reached .*no repair/);
	await assert.rejects(() => store.assertDispatchAllowed({ ...job(), promotion: true }, spent), /spend cap reached .*no promote/);
	await assert.rejects(() => store.assertDispatchAllowed({ ...job(), promotion: true, risk: "high" }, fleet), /risk:high under ask_on/);
	await store.assertDispatchAllowed({ jobId: "cp-new1", project: "other", kind: "ship" }, fleet);

	// The latest speaking grant decides: a newer expired grant without repair refuses it; an excluded kind was never governed.
	const strictHome = createScratchHome();
	t.after(() => strictHome.cleanup());
	const strict = new MandateStore(strictHome.path);
	issue(strict, { expiry: earlier(1_000), at: earlier(), allowed_actions: ["implement", "review"] });
	assert.throws(() => strict.assertPermitted("repair", job(), fleet), /repair is not an allowed action/);
	await assert.rejects(() => strict.assertDispatchAllowed({ ...job(), promotion: true }, fleet), /repair is not an allowed action/);
	issue(strict, { objective: "next round" });
	assert.equal(strict.assertPermitted("repair", job(), fleet).active.length, 1, "an active grant decides");
	const kindHome = createScratchHome();
	t.after(() => kindHome.cleanup());
	const byKind = new MandateStore(kindHome.path);
	issue(byKind, { expiry: earlier(1_000), at: earlier(), exclusions: { job_kinds: ["ship"] } });
	await byKind.assertDispatchAllowed(job("cp-new1"), fleet);

	// The expiry crossing itself, never swept by hand: a store whose clock has passed an active grant's expiry.
	const crossHome = createScratchHome();
	t.after(() => crossHome.cleanup());
	const lapsing = issue(new MandateStore(crossHome.path), { expiry: later(60_000) });
	const afterExpiry = new MandateStore(crossHome.path, { now: () => new Date(Date.now() + 120_000) });
	assert.equal(afterExpiry.require(lapsing.id).status, "active", "still active on disk before the check");
	await assert.rejects(() => afterExpiry.assertDispatchAllowed(job("cp-new1"), fleet), /expired at .* fresh start/);
	assert.equal(afterExpiry.assertPermitted("repair", job(), fleet).continuing?.id, lapsing.id);

	// A newer active grant speaks instead; a revoked-only project never refuses human dispatch.
	const fresh = issue(store, { objective: "next round" });
	await store.assertDispatchAllowed(job("cp-new1"), fleet);
	store.revoke(fresh.id);
	const otherHome = createScratchHome();
	t.after(() => otherHome.cleanup());
	const other = new MandateStore(otherHome.path);
	other.revoke(issue(other, { objective: "revoked grant" }).id);
	await other.assertDispatchAllowed({ jobId: "cp-new2", project: "demo", kind: "ship" });
});

test("a reviewer start keeps its pre-rule path under an expired grant: no fleet record, review not allowed, cap reached all pass; paused and revoked still refuse", (t) => {
	const job = { jobId: "cp-old", project: "demo", kind: "ship" as const };
	const held = [{ job_id: "cp-old", project: "demo", kind: "ship" as const, phase: "held" }];
	// label, grant overrides, then-status, fleet, reviewer start refused?, repair (the expiry policy, unchanged) refused?
	type Row = [string, Parameters<typeof issue>[1], "paused" | "revoked" | undefined, Parameters<MandateStore["assertPermitted"]>[2], RegExp | undefined, RegExp | undefined];
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
		const grant = issue(store, { expiry: status ? later() : earlier(1_000), at: earlier(), ...over });
		if (status === "paused") store.pause(grant.id);
		if (status === "revoked") store.revoke(grant.id);
		if (refused) assert.throws(() => assertReviewAllowed(store, job, jobs), refused, label);
		else {
			assert.doesNotThrow(() => assertReviewAllowed(store, job, jobs), label);
			assert.deepEqual(store.assertPermitted("review", job, jobs), { active: [] }, `${label}: the expired grant does not speak`);
		}
		if (repairRefused) assert.throws(() => store.assertPermitted("repair", job, jobs), repairRefused, `${label}: repair keeps its policy`);
		else assert.doesNotThrow(() => store.assertPermitted("repair", job, jobs), `${label}: repair keeps its policy`);
	}
	// Fresh dispatch keeps the expiry policy too.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { expiry: earlier(1_000), at: earlier() });
	assert.throws(() => store.assertPermitted("dispatch", { ...job, jobId: "cp-new" }, held), /expired at .* fresh start/);
});

test("an expired grant decides diff and merge for an in-flight job, never a ship; every other rule still binds", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const all = ["implement", "review", "repair", "merge"] as const;
	const grant = issue(store, { expiry: earlier(1_000), at: earlier(), ask_on: ["risk:high"], allowed_actions: [...all], spend_cap: { usd: 5, tokens: 100_000 } });
	store.sweep();
	const fleet = [{ job_id: "cp-old", project: "demo", phase: "held" }];
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

test("a project-wide grant covers follow-on jobs in the project; explicit job_ids still narrow it", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const wide = issue(store, { objective: "fix issue #17", job_cap: 2 });
	const done = [{ job_id: "cp-first", project: "demo", phase: "done" }];
	assert.equal(evaluateAuthority(subject({ jobId: "cp-second", usageJobs: done }), [wide]).permitted, true, "a second PR is covered");
	assert.equal(evaluateAuthority(subject({ jobId: "cp-second", project: "other", usageJobs: done }), [wide]).permitted, false);
	const full = [...done, { job_id: "cp-second", project: "demo", phase: "held" }];
	assert.deepEqual(evaluateAuthority(subject({ jobId: "cp-third", usageJobs: full }), [wide]), { permitted: false, reason: `${wide.id}: job cap reached` });
	assert.equal(evaluateAuthority(subject({ jobId: "cp-second", risk: "high", usageJobs: done }), [wide]).permitted, false, "risk:high still asks");
	const narrow = issue(store, { objective: "fix issue #17", job_ids: ["cp-first"] });
	assert.equal(evaluateAuthority(subject({ jobId: "cp-second", usageJobs: done }), [narrow]).permitted, false, "an unlisted job stays out");
	assert.equal(evaluateAuthority(subject({ jobId: "cp-first", usageJobs: done }), [narrow]).permitted, true);
});

test("cp_escalate caps option text and preserves the original consequence", async (t) => {
	const { registerMandateTools } = await import("../extensions/command-post/tools-mandate.ts");
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const previousHome = process.env.CP_HOME;
	const previousMode = process.env.CP_MODE;
	process.env.CP_HOME = home.path;
	process.env.CP_MODE = "multi";
	t.after(() => {
		if (previousHome === undefined) delete process.env.CP_HOME; else process.env.CP_HOME = previousHome;
		if (previousMode === undefined) delete process.env.CP_MODE; else process.env.CP_MODE = previousMode;
	});
	const escalations = new EscalationStore({ home: home.path });
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	registerMandateTools({ on: () => {}, registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool) } as never, {
		commandPost: () => ({ escalations }), setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined,
		createdThisTurn: [],
	} as never);
	const full = "x".repeat(300);
	const result = await tools.get("cp_escalate")!.execute("call_fake", {
		job_ids: ["cp-long-option"], kind: "product_ambiguity", question: "Choose?",
		options: [{ id: "one", label: "Choice", consequence: full, cost: "none" }], recommended: "one",
	}, undefined, undefined, { modelRegistry: {} });
	const [record] = escalations.open();
	assert.match(record!.id, /^es-/);
	assert.equal(record!.options[0]!.consequence.length, 200);
	assert.equal(record!.options[0]!.consequence.endsWith("…"), true);
	assert.equal(record!.original_text?.options?.[0]?.consequence, full);
	assert.match(result.content[0].text, /trimmed fields: options\[0\]\.consequence/);
});

test("cp_mandate objective ref is verified into a job but never pins the grant; explicit job_ids and sentinel still narrow", async () => {
	const { registerMandateTools } = await import("../extensions/command-post/tools-mandate.ts");
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) };
	const issued: Array<{ job_ids?: string[] }> = [];
	const createdThisTurn: string[] = [];
	let lookedUp = 0;
	const post = {
		home: "/nonexistent-cp-home",
		fleet: { read: () => ({ jobs: [] }) },
		registry: { get: () => ({ clone_url: "https://github.com/o/demo.git" }) },
		// The objective's issue job already exists, so no gh call is made.
		ledger: () => ({ findDuplicate: (input: { externalRef?: string }) => (lookedUp++, input.externalRef === "https://github.com/o/demo/issues/17" ? { id: "cp-issue" } : undefined) }),
		escalations: {},
		mandates: { list: () => [], issue: (input: { job_ids?: string[] }) => (issued.push(input), { id: "md-1", expiry: "2099-01-01T00:00:00Z", projects: ["demo"], job_cap: 3, ...(input.job_ids ? { job_ids: input.job_ids } : {}) }) },
	};
	const deps = { commandPost: () => post, setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined, createdThisTurn };
	registerMandateTools(pi as never, deps as never);
	const run = (job_ids?: string[]) =>
		tools.get("cp_mandate")?.execute("c", { action: "issue", projects: ["demo"], objective: "fix issue #17", ...(job_ids ? { job_ids } : {}) }, undefined, undefined, {});
	const wide = (await run()) as { content: Array<{ text: string }> };
	assert.match(wide.content[0]!.text, /warning: md-1 is project-wide, so its job cap 3 counts every job/);
	const named = (await run(["cp-x"])) as { content: Array<{ text: string }> };
	assert.doesNotMatch(named.content[0]!.text, /warning/);
	await run([MANDATE_JOBS_THIS_TURN]);
	assert.equal(lookedUp, 3, "the objective ref is resolved every time");
	assert.deepEqual(issued.map((input) => input.job_ids), [undefined, ["cp-x"], ["cp-issue"]]);
});

test("cp_mandate issue: an objective issue ref that gh reports as a PR refuses before any grant is written", async (t) => {
	const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { registerMandateTools } = await import("../extensions/command-post/tools-mandate.ts");
	const home = createScratchHome();
	t.after(() => home.cleanup());
	// A fake `gh` on PATH: the real verifyExternalRef path runs, and it answers that #17 is an open PR.
	const bin = mkdtempSync(join(tmpdir(), "cp-fake-gh-"));
	writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '{"title":"a PR","state":"open","pull_request":{}}'\n`);
	chmodSync(join(bin, "gh"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	t.after(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	});
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) };
	const issued: unknown[] = [];
	const created: unknown[] = [];
	const escalations = new EscalationStore({ home: home.path });
	const post = {
		home: home.path,
		fleet: { read: () => ({ jobs: [] }) },
		registry: { get: () => ({ clone_url: "https://github.com/o/demo.git" }) },
		ledger: () => ({ findDuplicate: () => undefined, create: (input: unknown) => (created.push(input), Promise.reject(new Error("never"))) }),
		escalations,
		mandates: { issue: (input: unknown) => (issued.push(input), { id: "md-1", expiry: "2099-01-01T00:00:00Z" }) },
	};
	const deps = { commandPost: () => post, setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined, createdThisTurn: [] };
	registerMandateTools(pi as never, deps as never);
	await assert.rejects(
		() => tools.get("cp_mandate")!.execute("c", { action: "issue", projects: ["demo"], objective: "fix issue #17" }, undefined, undefined, {}),
		(error: Error) => error instanceof MandateError && /cp_mandate issue refused: .*pr/i.test(error.message),
	);
	assert.deepEqual([issued, created], [[], []], "no grant and no job are written");
	assert.deepEqual(escalations.open().map((item) => item.kind), ["conflicting_acceptance"]);
});

test("cp_mandate issue refuses an archived project before any grant is written", async () => {
	const { registerMandateTools } = await import("../extensions/command-post/tools-mandate.ts");
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) };
	const issued: unknown[] = [];
	const post = {
		home: "/nonexistent-cp-home",
		fleet: { read: () => ({ jobs: [] }) },
		registry: { get: () => ({ clone_url: "https://example.invalid/demo.git", archived: true }) },
		mandates: { issue: (input: unknown) => (issued.push(input), { id: "md-1", expiry: "2099-01-01T00:00:00Z" }) },
	};
	registerMandateTools(pi as never, { commandPost: () => post, setLive: () => {}, refreshWidget: () => {}, projectOf: () => () => undefined, createdThisTurn: [] } as never);
	await assert.rejects(
		() => tools.get("cp_mandate")!.execute("c", { action: "issue", projects: ["demo"], objective: "ship the backlog" }, undefined, undefined, {}),
		(error: Error) => error instanceof MandateError && /archived project\(s\) demo/.test(error.message),
	);
	assert.deepEqual(issued, []);
});

test("a revoked grant that was cap-paused never refuses dispatch; the newer active grant covering the job decides", async (t) => {
	// The incident: md-7852fe was paused (spend_cap), then revoked \u2014 status revoked, pause_reason still spend_cap \u2014
	// and cp_pipeline start / cp_dispatch were refused in its name although newer active grants covered the job.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const spent = [{ job_id: "cp-old", project: "demo", phase: "held", usage: { cost_usd: 1.5, total_tokens: 10 } }];
	const old = issue(store, { spend_cap: { usd: 1, tokens: 1_000 }, at: earlier(60_000) });
	store.sweep(undefined, spent);
	const revoked = store.revoke(old.id);
	assert.deepEqual([revoked.status, revoked.pause_reason], ["revoked", "spend_cap"]);
	await store.assertDispatchAllowed({ jobId: "cp-new", project: "demo", kind: "ship" }, spent);

	const fresh = issue(store, { job_ids: ["cp-new"], spend_cap: { usd: 20, tokens: 1_000_000 } }, spent);
	await store.assertDispatchAllowed({ jobId: "cp-new", project: "demo", kind: "ship" }, spent);
	const verdict = evaluateAuthority(subject({ jobId: "cp-new", usageJobs: spent }), store.list());
	assert.equal(verdict.permitted && verdict.mandateId, fresh.id, "the active grant covering the job is the one that decides");
});

test("token caps count non-cached tokens only, past the issue-time baseline, in evaluation and in show", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	// 17.55M total of which 17.3M are cache rereads: 250k non-cached.
	const held = [{ job_id: "cp-held", project: "demo", phase: "held", usage: { total_tokens: 17_550_000, cache_read: 17_300_000, cost_usd: 0.1 } }];
	const grant = issue(store, { spend_cap: { usd: 20, tokens: 3_000_000 } }, held);
	assert.deepEqual(grant.usage_baseline, [{ job_id: "cp-held", usd: 0.1, tokens: 250_000 }]);
	assert.equal(store.sweep(undefined, held)[0]?.status, "active", "cache rereads never exhaust a grant");
	assert.match(store.show(grant.id, held), /; 0 \/ 3000000 non-cached tokens/);
	assert.equal(issue(store, { spend_cap: { usd: 20, tokens: 200_000 } }, held).status, "active", "earlier usage never counts at issue");
	const reread = [{ ...held[0]!, usage: { total_tokens: 97_550_000, cache_read: 97_300_000, cost_usd: 0.1 } }];
	assert.equal(evaluateAuthority(subject({ usageJobs: reread }), [store.require(grant.id)]).permitted, true, "cache rereads after issue never count");
	const over = [{ ...held[0]!, usage: { total_tokens: 20_550_000, cache_read: 17_300_000, cost_usd: 0.1 } }];
	const capped = evaluateAuthority(subject({ usageJobs: over }), [store.require(grant.id)]);
	assert.equal(!capped.permitted && capped.reason, `${grant.id}: token cap reached`);
});

test("a token cap is the parent's to raise within the ceiling; the USD cap never is", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, { job_ids: ["cp-run"], spend_cap: { usd: 5, tokens: 1_000 } });
	const running = [{ job_id: "cp-run", project: "demo", phase: "waiting", usage: { total_tokens: 1_500, cost_usd: 0.01 } }];
	store.sweep(undefined, running);
	assert.equal(store.require(grant.id).pause_reason, "token_cap");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(new EscalationStore({ home: home.path }).list({ kind: "budget_exhausted" }), [], "no human ask under the ceiling");

	assert.throws(
		() => raiseTokenCap(store, grant.id, { tokens: 2_000, reason: "more", usd: 50 }, running),
		(error: Error) => error instanceof MandateError && /never raise the USD cap/.test(error.message),
	);
	assert.deepEqual(store.require(grant.id).spend_cap, { usd: 5, tokens: 1_000 }, "a refused raise writes nothing");
	assert.throws(() => raiseTokenCap(store, grant.id, { tokens: 1_000, reason: "same" }), /above the current 1000/);
	assert.throws(() => raiseTokenCap(store, grant.id, { tokens: 2_000, reason: " " }), /needs a reason/);
	assert.throws(() => raiseTokenCap(store, grant.id, { tokens: SCAFFOLD_MANDATE_DEFAULTS.token_ceiling! + 1, reason: "huge" }), /over the home's token_ceiling 100000000/);

	const raised = raiseTokenCap(store, grant.id, { tokens: 2_000, reason: "one more review round" }, running);
	assert.deepEqual([raised.status, raised.spend_cap], ["active", { usd: 5, tokens: 2_000 }], "resumed; USD untouched");
	assert.match(store.show(grant.id, running), /token cap raised: .* 1000 -> 2000 \(one more review round\)/);
	await store.assertDispatchAllowed({ jobId: "cp-run", project: "demo", kind: "ship", promotion: true }, running);

	const smuggled = store.save({ ...store.require(grant.id), spend_cap: { usd: 500, tokens: 2_000 } }, running);
	assert.equal(smuggled.spend_cap.usd, 5, "no store write path moves the USD cap");

	store.revoke(grant.id);
	assert.throws(() => raiseTokenCap(store, grant.id, { tokens: 3_000, reason: "late" }), /revoked; its token cap cannot be raised/);
});

test("path and subsystem exclusions match original-task text", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = issue(store, {
		objective: "except secrets and billing",
		exclusions: { paths: ["src/secrets"], subsystems: ["billing"] },
	});
	const byPath = evaluateAuthority(
		subject({ text: "touch src/secrets/key.ts and nothing else" }),
		[grant],
	);
	assert.equal(byPath.permitted, false);
	if (!byPath.permitted) assert.match(byPath.reason, /path src\/secrets is excluded/);
	const bySub = evaluateAuthority(subject({ text: "rewrite the billing ledger" }), [grant]);
	assert.equal(bySub.permitted, false);
	if (!bySub.permitted) assert.match(bySub.reason, /subsystem billing is excluded/);
	const clean = evaluateAuthority(subject({ text: "bump the readme" }), [grant]);
	assert.equal(clean.permitted, true);
});

test("high risk is permitted only when ask_on omits it and the objective names the job", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const named = issue(store, {
		ask_on: ["merge"],
		objective: "do cp-ship1 even if high risk",
	});
	const ok = evaluateAuthority(subject({ risk: "high", riskProvenance: "inferred" }), [named]);
	assert.equal(ok.permitted, true);
	const unnamed = issue(store, { ask_on: ["merge"], objective: "do the work" });
	const no = evaluateAuthority(subject({ risk: "high" }), [unnamed]);
	assert.equal(no.permitted, false);
});

// pi-command-post-autonomy-programme-cur.2.4: ask_on: [risk:high] gates a
// direct dispatch, not only a checkpoint.

test("assertDispatchAllowed: risk:high under ask_on refuses a direct dispatch and raises one escalation; an operator-quoted decide then lets it proceed", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { ask_on: ["risk:high"], objective: "ship the bump" });
	const escalations = new EscalationStore({ home: home.path });
	const evidence = ["risk high: the task names production"];

	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: "cp-prod", project: "demo", kind: "ship", risk: "high", evidence }),
		(error: Error) => {
			assert.ok(error instanceof MandateError);
			assert.match(error.message, /risk:high under ask_on/);
			return true;
		},
	);
	const open = escalations.list({ jobId: "cp-prod" });
	assert.equal(open.length, 1, "exactly one escalation");
	assert.equal(open[0]?.kind, "risk_high_irreversible");
	assert.match(open[0]?.question ?? "", /cp-prod/);
	assert.match(open[0]?.question ?? "", /names production/);

	// A second refused attempt is idempotent \u2014 still one escalation.
	await assert.rejects(() =>
		store.assertDispatchAllowed({ jobId: "cp-prod", project: "demo", kind: "ship", risk: "high", evidence }),
	);
	assert.equal(escalations.list({ jobId: "cp-prod" }).length, 1);

	// The operator authorizes this job id only.
	const answered = await escalations.answer(open[0]?.id as string, { answer: "approve", by: "operator-quote" });
	assert.ok(escalationApproves(answered.answer ?? "", answered));

	// The same job now dispatches.
	await store.assertDispatchAllowed({ jobId: "cp-prod", project: "demo", kind: "ship", risk: "high", evidence });

	// A different job id needs its own decision.
	await assert.rejects(() =>
		store.assertDispatchAllowed({ jobId: "cp-prod-2", project: "demo", kind: "ship", risk: "high", evidence }),
	);
});

test("assertDispatchAllowed: risk:high answered 'drop' stays refused \u2014 drop is not authorization", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { ask_on: ["risk:high"], objective: "ship the bump" });
	const escalations = new EscalationStore({ home: home.path });
	const evidence = ["risk high: the task names production"];

	await assert.rejects(() =>
		store.assertDispatchAllowed({ jobId: "cp-prod-drop", project: "demo", kind: "ship", risk: "high", evidence }),
	);
	const open = escalations.list({ jobId: "cp-prod-drop" });
	assert.equal(open[0]?.recommended, "drop");

	// The operator answers with the escalation's own recommended option.
	const answered = await escalations.answer(open[0]?.id as string, { answer: "drop", by: "operator-quote" });
	assert.equal(answered.answer, "drop");

	// The job still does not dispatch \u2014 drop leaves it refused.
	await assert.rejects(
		() => store.assertDispatchAllowed({ jobId: "cp-prod-drop", project: "demo", kind: "ship", risk: "high", evidence }),
		(error: Error) => {
			assert.ok(error instanceof MandateError);
			assert.match(error.message, /risk:high under ask_on/);
			return true;
		},
	);
});

test("assertDispatchAllowed (6B-T3): one approved batch authorizes every listed job, promotion included; drop refuses them all; an open batch is named, never duplicated", async (t) => {
	for (const answer of ["approve", "drop"] as const) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const store = new MandateStore(home.path);
		issue(store, { ask_on: ["risk:high"], objective: "ship the bump" });
		const escalations = new EscalationStore({ home: home.path });
		const { ledger } = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
		const ids: string[] = [];
		for (const slug of ["b1", "b2", "out"]) ids.push((await ledger.create({ title: `example ${slug}`, project: "demo", delivery: "pr", kind: "ship", slug, risk: "high" })).id);
		const [b1, b2, outside] = ids as [string, string, string];
		const gate = (jobId: string, promotion = false) => store.assertDispatchAllowed({ jobId, project: "demo", kind: "ship", risk: "high", ...(promotion ? { promotion } : {}) });
		await assert.rejects(() => gate(b1), /risk:high under ask_on/);
		const { escalation } = await batchRiskHigh({ escalations, mandates: store, ledger }, { jobIds: [b1, b2] });

		// B3: a refused dispatch of a batched job raises nothing new and names the batch.
		const before = escalations.list().length;
		await assert.rejects(() => gate(b2), new RegExp(`${escalation.id} raised, cp_decide it with an operator quote to authorize it`));
		assert.equal(escalations.list().length, before, "no new row for a batched job");

		await escalations.answer(escalation.id, { answer, by: "operator-quote" });
		for (const jobId of [b1, b2]) {
			for (const promotion of [false, true]) {
				if (answer === "approve") await gate(jobId, promotion);
				else await assert.rejects(() => gate(jobId, promotion), /risk:high under ask_on/);
			}
		}
		await assert.rejects(() => gate(outside), /risk:high under ask_on/, "a job outside the batch still needs its own decision");
	}
});

test("assertDispatchAllowed: risk:low and a mandate without risk:high in ask_on dispatch untouched", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { ask_on: ["risk:high"], objective: "ship the bump" });
	const escalations = new EscalationStore({ home: home.path });

	// risk:low under a mandate that asks on risk:high: nothing gates it.
	await store.assertDispatchAllowed({ jobId: "cp-low", project: "demo", kind: "ship", risk: "low" });
	assert.equal(escalations.list().length, 0);

	// risk:high under a mandate whose ask_on omits risk:high: unchanged.
	const other = createScratchHome();
	t.after(() => other.cleanup());
	const store2 = new MandateStore(other.path);
	issue(store2, { ask_on: ["merge"], objective: "ship the bump" });
	await store2.assertDispatchAllowed({ jobId: "cp-high-unasked", project: "demo", kind: "ship", risk: "high" });
	assert.equal(new EscalationStore({ home: other.path }).list().length, 0);
});

test("wouldAskRiskHigh: dry-run predicate matches the gate without raising anything", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	issue(store, { ask_on: ["risk:high"], objective: "ship the bump" });
	assert.equal(store.wouldAskRiskHigh({ jobId: "cp-prod", project: "demo", kind: "ship" }, "high"), true);
	assert.equal(store.wouldAskRiskHigh({ jobId: "cp-prod", project: "demo", kind: "ship" }, "low"), false);
	assert.equal(new EscalationStore({ home: home.path }).list().length, 0, "a dry run raises nothing");
});

// -- exclusions.paths globbing + objective bare-ref resolution (pi-command-post-autonomy-programme-cur.2.6) --

test("evaluateAuthority: the scaffolded **/.env* exclusion actually refuses .env paths", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const mandate = issue(store, { exclusions: { paths: [...SCAFFOLD_MANDATE_DEFAULTS.exclude_paths] } });
	for (const path of [".env", "services/api/.env", ".env.production"]) {
		const decision = evaluateAuthority(subject({ pathHints: [path] }), [mandate]);
		assert.equal(decision.permitted, false, `${path} should be excluded`);
		if (!decision.permitted) assert.match(decision.reason, /is excluded/);
	}
	// A path that merely contains "env" without the leading dot is untouched.
	const allowed = evaluateAuthority(subject({ pathHints: ["src/environment.ts"] }), [mandate]);
	assert.equal(allowed.permitted, true);
});

function refPorts(t: { after(fn: () => void): void }) {
	const scratch = createScratchLedger({ knownProjects: ["example-infra"] });
	t.after(() => scratch.cleanup());
	return {
		ledger: scratch.ledger,
		escalations: new EscalationStore({ home: scratch.path }),
		scratch,
	};
}

test("resolveMandateObjectiveRef: an open issue named as a bare #N mints one job with the full url", async (t) => {
	const { ledger, escalations } = refPorts(t);
	const verifyRef = async () =>
		({ status: "found", kind: "issue", state: "open", title: "real bug", url: "https://github.com/o/example-infra/issues/17" }) as const;
	const jobId = await resolveMandateObjectiveRef(
		"fix #17",
		["example-infra"],
		() => "https://github.com/o/example-infra.git",
		{ ledger, escalations, verifyRef },
	);
	assert.ok(jobId);
	const job = await ledger.show(jobId as string);
	assert.equal(job.external_ref, "https://github.com/o/example-infra/issues/17");
	assert.match(job.notes ?? "", /issue open "real bug"/);
	assert.equal(escalations.open().length, 0);
});

test("resolveMandateObjectiveRef: a merged PR named as #N refuses and escalates once", async (t) => {
	const { ledger, escalations } = refPorts(t);
	const verifyRef = async () =>
		({ status: "found", kind: "pr", state: "merged", title: "landed already", url: "https://github.com/o/example-infra/issues/17" }) as const;
	await assert.rejects(
		resolveMandateObjectiveRef("fix #17", ["example-infra"], () => "https://github.com/o/example-infra.git", { ledger, escalations, verifyRef }),
		/refused.*pr.*merged/is,
	);
	assert.deepEqual((await ledger.list({ all: true })), [], "no job was created for the bad ref");
	const open = escalations.open();
	assert.equal(open.length, 1, "one escalation, not two");
	assert.equal(open[0]?.kind, "conflicting_acceptance");
	await assert.rejects(
		resolveMandateObjectiveRef("fix #17", ["example-infra"], () => "https://github.com/o/example-infra.git", { ledger, escalations, verifyRef }),
		/refused.*pr.*merged/is,
	);
	assert.equal(escalations.open().length, 1, "a second bad attempt extends the same escalation, not a new one");
});

test("resolveMandateObjectiveRef: no bare ref, more than one project, or a non-GitHub remote is quietly undefined", async (t) => {
	const { ledger, escalations } = refPorts(t);
	assert.equal(await resolveMandateObjectiveRef("ship the bump", ["example-infra"], () => "https://github.com/o/example-infra.git", { ledger, escalations }), undefined);
	assert.equal(await resolveMandateObjectiveRef("fix #17", ["example-infra", "other"], () => "https://github.com/o/example-infra.git", { ledger, escalations }), undefined);
	assert.equal(await resolveMandateObjectiveRef("fix #17", ["example-infra"], () => "https://example.com/o/example-infra.git", { ledger, escalations }), undefined);
});

test("extractBareIssueRef: a PR-labelled #N is prose, never issue intake; a real bare ref beside it still resolves", () => {
	for (const prose of ["replace PR #7 with same two-file patch", "pr #7", "pull request #7", "Pull  Request #7 again", "PRs #7", "PR: #7", "pull requests: #7"]) {
		assert.equal(extractBareIssueRef(prose), undefined, prose);
	}
	assert.deepEqual(extractBareIssueRef("fix #17"), { number: "17" });
	assert.deepEqual(extractBareIssueRef("fix owner/repo#17"), { number: "17", ownerRepo: "owner/repo" });
	assert.deepEqual(extractBareIssueRef("fix #17 despite PR #7"), { number: "17" });
	assert.deepEqual(extractBareIssueRef("despite PR #7, fix #17"), { number: "17" }, "the next bare match is still found");
	assert.deepEqual(extractBareIssueRef("fix APR#4"), undefined, "not a bare ref at all");
	assert.deepEqual(extractBareIssueRef("close APR #4"), undefined, "APR is not an issue-task word");
});

test("extractBareIssueRef: only explicit issue-task contexts count; incidental status numbers do not (bead b-qbi.2)", () => {
	for (const prose of ["after #220 merged, tidy the docs", "ship the follow-up to #220", "land it as in PR #7 and #9", "cp-jxqp #3 of 5"]) {
		assert.equal(extractBareIssueRef(prose), undefined, prose);
	}
	for (const [text, number] of [["fix issue #17", "17"], ["issue #17", "17"], ["Fixes #17", "17"], ["closes: #17", "17"], ["resolve #17", "17"], ["#17", "17"], ["after #220 merged, fix #17", "17"]] as const) {
		assert.deepEqual(extractBareIssueRef(text), { number }, text);
	}
	assert.deepEqual(extractBareIssueRef("target owner/repo#21"), { number: "21", ownerRepo: "owner/repo" });
	assert.deepEqual(extractBareIssueRef("see owner/repo#21"), { number: "21", ownerRepo: "owner/repo" }, "a qualified ref stays explicit");
});

test("resolveMandateObjectiveRef: incidental #N never verifies; fix issue #N verifies exactly once", async (t) => {
	const { ledger, escalations } = refPorts(t);
	let calls = 0;
	const verifyRef = async () => {
		calls += 1;
		return { status: "found", kind: "issue", state: "open", title: "real bug", url: "https://github.com/o/example-infra/issues/17" } as const;
	};
	const cloneUrl = () => "https://github.com/o/example-infra.git";
	for (const prose of ["replace PR #7 with same two-file patch", "after #220 merged, tidy the docs"]) {
		assert.equal(await resolveMandateObjectiveRef(prose, ["example-infra"], cloneUrl, { ledger, escalations, verifyRef }), undefined, prose);
	}
	assert.equal(calls, 0);
	assert.deepEqual(await ledger.list({ all: true }), []);
	assert.equal(escalations.open().length, 0);
	const jobId = await resolveMandateObjectiveRef("fix issue #17", ["example-infra"], cloneUrl, { ledger, escalations, verifyRef });
	assert.ok(jobId);
	assert.equal(calls, 1);
	assert.equal((await ledger.show(jobId as string)).external_ref, "https://github.com/o/example-infra/issues/17");
});

test("resolveMandateObjectiveRef: an explicit issue context naming a PR still refuses as wrong kind", async (t) => {
	const { ledger, escalations } = refPorts(t);
	const verifyRef = async () =>
		({ status: "found", kind: "pr", state: "open", title: "a PR", url: "https://github.com/o/example-infra/pull/7" }) as const;
	await assert.rejects(
		resolveMandateObjectiveRef("fix issue #7", ["example-infra"], () => "https://github.com/o/example-infra.git", { ledger, escalations, verifyRef }),
		/refused/,
	);
	assert.equal(escalations.open()[0]?.kind, "conflicting_acceptance");
});

test("resolveMandateObjectiveRef: PR prose never calls verifyRef, creates nothing, raises nothing", async (t) => {
	const { ledger, escalations } = refPorts(t);
	let calls = 0;
	const verifyRef = async () => {
		calls += 1;
		return { status: "found", kind: "pr", state: "merged", title: "x", url: "https://github.com/o/example-infra/pull/7" } as const;
	};
	const cloneUrl = () => "https://github.com/o/example-infra.git";
	assert.equal(await resolveMandateObjectiveRef("replace PR #7 with same two-file patch", ["example-infra"], cloneUrl, { ledger, escalations, verifyRef }), undefined);
	assert.equal(calls, 0);
	assert.deepEqual(await ledger.list({ all: true }), []);
	assert.equal(escalations.open().length, 0);
});

test("schedlater S3: covers matrix — a schedule grant covers only its own schedule's jobs, any other grant no scheduled job", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const base = { projects: ["demo"], objective: "nightly", expiry: later(), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5 };
	const schedule = store.issue({ ...base, schedule_grant: true });
	const wide = store.issue(base);
	assert.equal(store.require(schedule.id).schedule_grant, true, "the flag is persisted");
	assert.equal(wide.schedule_grant, undefined);
	const plain = { jobId: "cp-p1", project: "demo", jobKind: "ship" as const };
	const ours = { ...plain, jobId: "cp-s1", scheduleId: "sch-abc123", scheduleMandate: schedule.id };
	const theirs = { ...plain, jobId: "cp-s2", scheduleId: "sch-def456", scheduleMandate: "md-999999" };
	const unknown = { ...plain, jobId: "cp-s3", scheduleId: "sch-aaa111" };
	assert.deepEqual([plain, ours, theirs, unknown].map((job) => covers(schedule, job)), [false, true, false, false]);
	assert.deepEqual([plain, ours, theirs, unknown].map((job) => covers(wide, job)), [true, false, false, false]);
	assert.equal(covers(schedule, { ...ours, project: "other" }), false, "project still binds");
	assert.match(formatMandate(schedule), /schedule grant: covers only the jobs of the one schedule naming it/);
	// The authority path reads the same rule: an unrelated checkpoint is never decided under a schedule grant.
	const grants = [store.require(schedule.id)];
	assert.equal(evaluateAuthority(subject({ jobId: "cp-s1", scheduleId: "sch-abc123", scheduleMandate: schedule.id }), grants).permitted, true);
	assert.equal(evaluateAuthority(subject({ jobId: "cp-p1" }), grants).permitted, false);
});
