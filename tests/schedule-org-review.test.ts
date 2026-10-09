/**
 * cp-org-pr-review schedules (docs/contracts.md, *Org PR-review schedules*): the description config, add/update/move
 * under the skill floor and the parallelism note, and the seed's operator pre-approval carried onto a fire grant only
 * for a verified dashboard Run now click — every other fire stays gated.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT, type RiskPreapproval } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { preapprovedRow, quoteSha } from "../src/risk-preapproval.ts";
import { ScheduleControl, verifiedRunNowClick } from "../src/schedule-control.ts";
import { carriedPreapproval } from "../src/schedule-grant.ts";
import { orgReviewConfig, Scheduler } from "../src/scheduler.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { controlConfigFile } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const T0 = new Date("2026-07-01T07:03:00Z");
const PID = 4242;
const QUOTE = "I approve the org PR reviews this schedule runs";

function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path, { now: () => clock.now });
	const fleet = new FleetStore({ home: home.path });
	const scheduler = new Scheduler({
		home: home.path, ledger: () => ledger, mandates, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path, now: () => clock.now, startedAt: T0,
		mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }), controlPid: PID,
	});
	const stateDir = join(home.path, LAYOUT.state);
	const pre = (extra: Partial<RiskPreapproval> = {}): RiskPreapproval => ({ operator_quote: QUOTE, decided_by: "operator-quote", scope: "mandate_jobs", granted_at: "2026-06-01T00:00:00Z", ...extra });
	const grant = (extra: Partial<Parameters<MandateStore["issue"]>[0]> = {}) =>
		mandates.issue({ projects: ["demo"], objective: "org reviews", expiry: "2026-12-31T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 2, dispatch_parallelism: 3, at: "2026-06-01T00:00:00Z", schedule_grant: true, ...extra });
	let n = 0;
	const request = (scheduleId: string, extra: Record<string, unknown> = {}) => {
		const id = `sc-${clock.now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${(++n).toString(16).padStart(8, "0")}`;
		appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id, at: clock.now.toISOString(), peer: "100.64.0.9", op: "run_now", schedule_id: scheduleId, ...extra } as never);
		return id;
	};
	const control = () => new ScheduleControl({ stateDir, scheduler, now: () => clock.now, pid: PID, log: () => {} });
	return { clock, ledger, mandates, scheduler, stateDir, pre, grant, request, control };
}

const org = { manual: true as const, project: "demo", title: "Org review", kind: "research" as const, delivery: "local" as const, skill: "cp-org-pr-review" };
const CONFIG = "Review the org queue.\norg: acme\nTeam: core\nhold: https://github.com/acme/api/pull/7";

test("orgReviewConfig: one org, optional user, bare distinct teams, held PRs in the org, max_reviewers 1-3, prose ignored", () => {
	assert.deepEqual(orgReviewConfig(`${CONFIG}\nuser: octo-cat\nmax_reviewers: 2`), { org: "acme", user: "octo-cat", teams: ["core"], holds: ["https://github.com/acme/api/pull/7"], max_reviewers: 2 });
	assert.equal(orgReviewConfig("org: acme").max_reviewers, 3, "default and cap");
	const refusals: [string, RegExp][] = [
		["prose only", /needs exactly one description line "org: <github-org>"; found 0/],
		["org: acme\norg: other", /found 2/],
		["org: -bad-", /is not a GitHub login/],
		["org: acme\nuser: a\nuser: b", /at most one user: line/],
		["org: acme\nteam: acme/core", /give the bare team slug/],
		["org: acme\nteam: core\nteam: core", /team: core is listed twice/],
		[`org: acme\n${Array.from({ length: 11 }, (_, i) => `team: t${i}`).join("\n")}`, /at most 10 team: lines; found 11/],
		["org: acme\nhold: https://github.com/other/api/pull/7", /is not in acme/],
		["org: acme\nhold: https://github.com/acme/api/issues/7", /is not a PR url/],
		["org: acme\nmax_reviewers: 4", /over the cap 3/],
		["org: acme\nmax_reviewers: 0", /under 1/],
		["org: acme\nmax_reviewers: two", /not an integer/],
		["org: acme\npr: https://github.com/acme/api/pull/1", /pr: lines belong to cp-pr-review/],
	];
	for (const [text, message] of refusals) assert.throws(() => orgReviewConfig(text), (error: Error) => error.message.startsWith("cp-org-pr-review: ") && message.test(error.message));
});

test("add: the config is validated, the job cap floors at max_reviewers + 2, a low parallelism is named, and only this skill takes a mandate_jobs pre-approval seed", async (t) => {
	const { mandates, scheduler, pre, grant } = bench(t);
	await assert.rejects(scheduler.add({ ...org, name: "bad", mandate_id: grant().id, description: "no config" }), /cp-org-pr-review: needs exactly one/);
	const added = await scheduler.add({ ...org, name: "org", mandate_id: grant({ dispatch_parallelism: 2 }).id, description: CONFIG });
	assert.equal(added.grant_template?.job_cap, 5, "3 reviewers + 1 synthesis + the anchor");
	assert.match(added.notes!.join("; "), /job cap raised from 2 to 5/);
	assert.match(added.notes!.join("; "), /dispatch_parallelism 2 is below max_reviewers 3: at most 2 reviewers run at once/);
	assert.equal(added.grant_template?.dispatch_parallelism, 2, "code never raises parallelism");
	const two = await scheduler.add({ ...org, name: "two", mandate_id: grant().id, description: `${CONFIG}\nmax_reviewers: 2` });
	assert.equal(two.grant_template?.job_cap, 4);
	assert.ok(!two.notes?.some((note) => note.includes("dispatch_parallelism")), "3 at once covers 2 reviewers");

	const seed = grant({ risk_preapproval: pre() });
	const cleared = await scheduler.add({ ...org, name: "cleared", mandate_id: seed.id, description: CONFIG });
	assert.match(cleared.notes!.join("; "), new RegExp(`risk:high pre-approval \\[${quoteSha(QUOTE)}\\] is not copied into the template`));
	assert.ok(!("risk_preapproval" in (cleared.grant_template ?? {})) && !JSON.stringify(cleared.grant_template).includes(QUOTE), "the template never holds the pre-approval");
	assert.equal(mandates.require(seed.id).risk_preapproval?.operator_quote, QUOTE, "the seed keeps it");
	await assert.rejects(scheduler.add({ ...org, name: "named", mandate_id: grant({ risk_preapproval: pre({ scope: "named_jobs", job_ids: ["cp-abcd"] }) }).id, description: CONFIG }), /names jobs \(named_jobs\)/);
	await assert.rejects(scheduler.add({ name: "plain", project: "demo", manual: true, title: "plain", kind: "research", delivery: "local", mandate_id: grant({ risk_preapproval: pre() }).id }), /carries a risk:high pre-approval; a fire grant template never inherits one/);
});

test("update: switches an ordinary manual schedule onto the skill under add's rules, refused while a run is open", async (t) => {
	const { ledger, scheduler, pre, grant } = bench(t);
	const plain = await scheduler.add({ name: "plain", project: "demo", manual: true, title: "plain", kind: "research", delivery: "answer", mandate_id: grant().id });
	await assert.rejects(scheduler.update(plain.id, {}), /needs at least one of/);
	await assert.rejects(scheduler.update("sch-ffffff", { title: "x" }), /no schedule sch-ffffff/);
	await assert.rejects(scheduler.update(plain.id, { skill: "cp-org-pr-review", description: CONFIG }), /skill needs a manual schedule with kind research, delivery local/);
	await assert.rejects(scheduler.update(plain.id, { skill: "cp-org-pr-review", delivery: "local", description: "org: acme\nmax_reviewers: 9" }), /over the cap 3/);
	const updated = await scheduler.update(plain.id, { skill: "cp-org-pr-review", delivery: "local", description: CONFIG, title: "  Org review  " });
	assert.deepEqual([updated.schedule.job.skill, updated.schedule.job.title, updated.schedule.job.delivery, updated.schedule.grant_template?.job_cap], ["cp-org-pr-review", "Org review", "local", 5]);
	assert.match(updated.notes.join("; "), /job cap raised from 2 to 5/);
	assert.deepEqual([scheduler.list()[0]?.id, scheduler.list()[0]?.trigger.type], [plain.id, "manual"], "same schedule, same trigger");

	const fired = await scheduler.fireNow(plain.id, "sc-1");
	assert.equal(fired.outcome, "fired");
	await assert.rejects(scheduler.update(plain.id, { description: `${CONFIG}\nmax_reviewers: 1` }), new RegExp(`has an open run \\(${fired.job_id}\\)`));
	await ledger.close(fired.job_id as string, "test");
	const lowered = await scheduler.update(plain.id, { description: `${CONFIG}\nmax_reviewers: 1` });
	assert.equal(lowered.schedule.grant_template?.job_cap, 5, "a floor is raised, never lowered");

	const cleared = await scheduler.add({ ...org, name: "cleared", mandate_id: grant({ risk_preapproval: pre() }).id, description: CONFIG });
	await assert.rejects(scheduler.update(cleared.id, { skill: "cp-self-review" }), /carries a risk:high pre-approval, which only a cp-org-pr-review schedule may name/);
});

test("a verified dashboard Run now click carries the seed's pre-approval to that fire's jobs; every other fire stays gated", async (t) => {
	const { clock, ledger, mandates, scheduler, pre, grant, request, control } = bench(t);
	const seed = grant({ risk_preapproval: pre() });
	const schedule = await scheduler.add({ ...org, name: "org", mandate_id: seed.id, description: CONFIG });
	const id = request(schedule.id);
	const [fired] = await control().pass();
	assert.equal(fired?.outcome, "fired");
	const fire = mandates.require(fired?.mandate_id as string);
	assert.notEqual(fire.id, seed.id);
	assert.deepEqual([fire.risk_preapproval?.operator_quote, fire.risk_preapproval?.decided_by, fire.risk_preapproval?.scope], [QUOTE, "operator-delegated", "mandate_jobs"]);
	assert.match(fire.risk_preapproval?.delegation_rule ?? "", new RegExp(`^run_now ${id} \\(peer 100\\.64\\.0\\.9\\): seed ${seed.id} pre-approval \\[${quoteSha(QUOTE)}\\] carried to this fire's schedule:${schedule.id} jobs$`));
	assert.match(JSON.stringify(fired), new RegExp(`carried for run_now ${id}`));
	assert.deepEqual(preapprovedRow(fire, "cp-abcd", "dispatch", T0.toISOString(), ["risk evidence"]).evidence, [`fire run_now ${id}`, "risk evidence"]);
	// A reviewer the parent creates under this run passes ask_on risk:high with no escalation.
	const reviewer = await ledger.create({ title: `Org PR review R1/1 [${fired?.job_id}]`, project: "demo", kind: "research", delivery: "local", labels: [`schedule:${schedule.id}`, "risk:high"] });
	assert.equal(mandates.wouldAskRiskHigh({ jobId: reviewer.id, project: "demo", kind: "research" }, "high"), false);

	// The next fire, via cp_schedule run_now (a chat quote), is gated: no pre-approval on its grant.
	await ledger.close(reviewer.id, "test");
	await ledger.close(fired?.job_id as string, "test");
	clock.now = new Date(T0.getTime() + 60_000);
	const chat = await scheduler.fireNow(schedule.id, { via: "cp_schedule", tool_call_id: "call-1", operator_quote: "run the org review now", decided_by: "operator-quote", source_sha: "0123456789ab" });
	assert.equal(chat.outcome, "fired");
	assert.equal(mandates.require(chat.mandate_id as string).risk_preapproval, undefined);
	assert.match(JSON.stringify(chat), /no risk:high pre-approval carried \(not a dashboard Run now \(cp_schedule\)\)/);
	const gated = await ledger.create({ title: `Org PR review R1/1 [${chat.job_id}]`, project: "demo", kind: "research", delivery: "local", labels: [`schedule:${schedule.id}`, "risk:high"] });
	assert.equal(mandates.wouldAskRiskHigh({ jobId: gated.id, project: "demo", kind: "research" }, "high"), true);
	await ledger.close(gated.id, "test");
	await ledger.close(chat.job_id as string, "test");

	// A string trigger with no journal record (or any unverified click) is gated too.
	clock.now = new Date(T0.getTime() + 120_000);
	const forged = await scheduler.fireNow(schedule.id, "sc-20260701070500-deadbeef");
	assert.equal(forged.outcome, "fired");
	assert.equal(mandates.require(forged.mandate_id as string).risk_preapproval, undefined);
	assert.match(JSON.stringify(forged), /is not a verified dashboard click: 0 request lines/);
});

test("U6: an operator-delegated seed pre-approval carries on a verified click as well, with its send id kept", async (t) => {
	const { ledger, mandates, scheduler, pre, grant, request, control } = bench(t);
	const sendId = "ps-20260701070000-0123abcd";
	const seed = grant({ risk_preapproval: pre({ decided_by: "operator-delegated", delegation_rule: "main session gates org reviews", send_id: sendId }) });
	const schedule = await scheduler.add({ ...org, name: "org", mandate_id: seed.id, description: CONFIG });
	const id = request(schedule.id);
	const [fired] = await control().pass();
	assert.equal(fired?.outcome, "fired");
	const fire = mandates.require(fired?.mandate_id as string);
	assert.deepEqual([fire.risk_preapproval?.operator_quote, fire.risk_preapproval?.decided_by, fire.risk_preapproval?.send_id], [QUOTE, "operator-delegated", sendId]);
	assert.match(fire.risk_preapproval?.delegation_rule ?? "", new RegExp(`^run_now ${id} \\(peer 100\\.64\\.0\\.9\\): seed ${seed.id} pre-approval`));
	const reviewer = await ledger.create({ title: `Org PR review R1/1 [${fired?.job_id}]`, project: "demo", kind: "research", delivery: "local", labels: [`schedule:${schedule.id}`, "risk:high"] });
	assert.equal(mandates.wouldAskRiskHigh({ jobId: reviewer.id, project: "demo", kind: "research" }, "high"), false);
});

test("a seed with no pre-approval, and another skill, carry nothing", async (t) => {
	const { mandates, scheduler, grant, request, control } = bench(t);
	const schedule = await scheduler.add({ ...org, name: "org", mandate_id: grant().id, description: CONFIG });
	request(schedule.id);
	const [fired] = await control().pass();
	assert.equal(mandates.require(fired?.mandate_id as string).risk_preapproval, undefined);
	assert.match(JSON.stringify(fired), /no risk:high pre-approval carried \(seed md-[^ ]+ records no operator pre-approval\)/);
	assert.equal(carriedPreapproval({ skill: "cp-self-review", scheduleId: schedule.id, seed: undefined, trigger: { via: "dashboard", request_id: "x", peer: null }, click: { ok: true, peer: "p" }, at: T0.toISOString() }), undefined);
});

test("verifiedRunNowClick: only the viewer's one run_now request for this schedule, claimed once by this parent within 120 s, no outcome, control on", (t) => {
	const { stateDir, request, clock } = bench(t);
	const claim = (id: string, extra: Record<string, unknown> = {}) => appendScheduleControlLine(stateDir, { type: "claimed", by: "parent", id, at: clock.now.toISOString(), pid: PID, ...extra } as never);
	const ok = request("sch-aaaaaa");
	claim(ok);
	assert.deepEqual(verifiedRunNowClick(stateDir, ok, "sch-aaaaaa", PID), { ok: true, peer: "100.64.0.9" });
	const why = (id: string, schedule = "sch-aaaaaa", pid = PID) => { const click = verifiedRunNowClick(stateDir, id, schedule, pid); return click.ok ? "ok" : click.why; };
	assert.match(why("sc-1"), /is not a dashboard request id/);
	assert.match(why(ok, "sch-bbbbbb"), /names "sch-aaaaaa", not sch-bbbbbb/);
	assert.match(why(ok, "sch-aaaaaa", 1), /not this parent \(pid 1\)/);
	const unclaimed = request("sch-aaaaaa");
	assert.match(why(unclaimed), /0 claims after the request/);
	const twice = request("sch-aaaaaa");
	claim(twice);
	claim(twice);
	assert.match(why(twice), /2 claims after the request/);
	const enable = request("sch-aaaaaa", { op: "enable" });
	claim(enable);
	assert.match(why(enable), /is "enable", not run_now/);
	const parent = request("sch-aaaaaa", { by: "parent" });
	claim(parent);
	assert.match(why(parent), /written by "parent", not the viewer/);
	const peerless = request("sch-aaaaaa", { peer: "" });
	claim(peerless);
	assert.match(why(peerless), /records no peer/);
	const late = request("sch-aaaaaa");
	claim(late, { at: new Date(clock.now.getTime() + 121_000).toISOString() });
	assert.match(why(late), /outside 0-120000 ms/);
	const done = request("sch-aaaaaa");
	claim(done);
	appendScheduleControlLine(stateDir, { type: "outcome", by: "parent", id: done, at: clock.now.toISOString(), state: "done", reason: "x" } as never);
	assert.match(why(done), /already has an outcome/);
	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled": false}');
	assert.match(why(ok), /dashboard control is off/);
});
