/**
 * cp-org-pr-review schedules (docs/contracts.md, *Org PR-review schedules*): the description config, a native add under
 * the skill floor, and the dashboard Run now click check. PR4 retired the fire grant that carried a seed's pre-approval.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { ScheduleControl, verifiedRunNowClick } from "../src/schedule-control.ts";
import type { NativeAddLimits } from "../src/schedule-native-add.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { orgReviewConfig, Scheduler } from "../src/scheduler.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { controlConfigFile } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT } from "./harness/index.ts";

const T0 = new Date("2026-07-01T07:03:00Z");
const PID = 4242;

function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const runs = openScheduleRunStore(home.path);
	const mandates = new MandateStore(home.path, { runs, now: () => clock.now });
	const fleet = new FleetStore({ home: home.path });
	const scheduler = new Scheduler({
		home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path, now: () => clock.now, startedAt: T0,
		mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }), controlPid: PID,
	});
	const stateDir = join(home.path, LAYOUT.state);
	let n = 0;
	const request = (scheduleId: string, extra: Record<string, unknown> = {}) => {
		const id = `sc-${clock.now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${(++n).toString(16).padStart(8, "0")}`;
		appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id, at: clock.now.toISOString(), peer: "100.64.0.9", op: "run_now", schedule_id: scheduleId, ...extra } as never);
		return id;
	};
	const control = () => new ScheduleControl({ stateDir, scheduler, now: () => clock.now, pid: PID, log: () => {} });
	return { clock, runs, scheduler, stateDir, request, control };
}

const org = { manual: true as const, project: "demo", title: "Org review", kind: "research" as const, delivery: "local" as const, skill: "cp-org-pr-review" };
const CONFIG = "Review the org queue.\norg: acme\nTeam: core\nhold: https://github.com/acme/api/pull/7";
const native = (limits: NativeAddLimits, tool_call_id = "call-add") => ({ action: { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id, quote_sha: tool_call_id === "call-add" ? "abcdef123456" : "0123456789ab" } }, limits });

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

test("add: the config is validated, the run's job cap floors at max_reviewers + 2, and code never raises parallelism", async (t) => {
	const { scheduler, runs } = bench(t);
	await assert.rejects(scheduler.add({ ...org, name: "bad", native: native({ child_jobs: 2 }), description: "no config" }), /cp-org-pr-review: needs exactly one/);
	const added = await scheduler.add({ ...org, name: "org", native: native({ child_jobs: 2, parallelism: 2 }), description: CONFIG });
	assert.deepEqual([runs.activePolicy(added.id)?.limits.child_jobs, runs.activePolicy(added.id)?.limits.parallelism], [5, 2], "3 reviewers + 1 synthesis + the anchor");
	const two = await scheduler.add({ ...org, name: "two", native: native({ child_jobs: 2 }, "call-two"), description: `${CONFIG}\nmax_reviewers: 2` });
	assert.equal(runs.activePolicy(two.id)?.limits.child_jobs, 4);
	assert.equal(runs.activePolicy(two.id)?.recipe_config?.max_reviewers, 2);
});

test("update: refused without a field, on an unknown id, and on a native schedule (save_policy owns it)", async (t) => {
	const { scheduler } = bench(t);
	const plain = await scheduler.add({ name: "plain", project: "demo", manual: true, title: "plain", kind: "research", delivery: "answer", native: native({}) });
	await assert.rejects(scheduler.update(plain.id, {}), /needs at least one of/);
	await assert.rejects(scheduler.update("sch-ffffff", { title: "x" }), /no schedule sch-ffffff/);
	await assert.rejects(scheduler.update(plain.id, { skill: "cp-org-pr-review", delivery: "local", description: CONFIG }), /use save_policy/);
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

// The reviewer's approval gate reads CI from Actions runs and attempt jobs at the exact head. A rollup/checks gate
// coming back, or no-run/incomplete evidence counting as green, would let an approval land on unseen CI.
test("the org-review recipe gates approval on exact-head Actions runs and jobs, never rollup or checks", () => {
	const text = readFileSync(join(REPO_ROOT, "skills/cp-org-pr-review/SKILL.md"), "utf8");
	const brief = text.slice(text.indexOf("## Reviewer task template"), text.indexOf("## S1 task template")).replace(/\n\s*/g, " ");
	const gate = brief.slice(brief.indexOf("4. CI is all green"), brief.indexOf("5. zero unresolved"));
	assert.match(gate, /actions\/runs\?head_sha=<sha>&per_page=100&page=<n>/);
	assert.match(gate, /actions\/runs\/<id>\/attempts\/<run_attempt>\/jobs\?per_page=100&page=<n>/);
	assert.match(gate, /No runs, an unreadable or incomplete page, or any run still queued or in progress is not green/);
	assert.match(gate, /Never fall back to the Checks API, commit statuses or `statusCheckRollup`/);
	assert.doesNotMatch(gate.replace(/Never fall back[^;]*;/, ""), /statusCheckRollup|check-runs|\/status(?:es)?\b|`SUCCESS`/);
});
