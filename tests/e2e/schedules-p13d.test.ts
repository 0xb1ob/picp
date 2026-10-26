/**
 * Behavior 12 (Schedules), P13d: the schedule migrations a parent runs at session start and a legacy schedule run's
 * authority, in real pi parents on a scratch home seeded with pre-native state, with a mock LLM. Read back from disk.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { MandateStore } from "../../src/mandate.ts";
import { refused, synthesizedApproval, templateFromSeed } from "../../src/schedule-grant.ts";
import { SCHEDULE_POLICY_IMPORT_MARKER, SCHEDULE_TEMPLATE_MIGRATION_MARKER } from "../../src/schedule-migrations.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { openScheduleRunStore } from "../../src/schedule-runs.ts";
import { appendScheduleControlLine } from "../../src/viewer/control-audit.ts";
import { readScheduleControl, type ScheduleControlFields, type ScheduleControlOp } from "../../src/viewer/control-files.ts";
import { readScheduleFile, type Schedule } from "../../src/viewer/schedule-core.ts";
import { isNativePolicy, nativePolicyDraft, policyFromLegacy, type LegacySchedulePolicy, type NativeSchedulePolicy } from "../../src/viewer/schedule-policy.ts";
import type { ScheduleRun } from "../../src/viewer/schedule-run-core.ts";
import {
	COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, MOCK_PROVIDER_ID,
	MockProvider, type MockToolCall, type PiChild, type RpcRecord, type ScriptStep, startPiChild, waitFor,
} from "../harness/index.ts";

type End = RpcRecord & { toolCallId: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } };
const DAY = 86_400_000;

/** A scratch home with project demo on a treehouse pool and a mock provider for every pi, as in schedules.test.ts. */
async function schedulesHome(t: TestContext) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	const clone = registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 8 });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const parents: PiChild[] = [];
	t.after(async () => { for (const child of parents) await child.close(); agent.cleanup(); await provider.stop(); pool.cleanup(); repo.cleanup(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
	let serial = 0;
	const stateDir = join(home.path, LAYOUT.state);
	const schedulesFile = join(stateDir, "schedules.json");
	const model = (name: string, steps: ScriptStep[]) => {
		const id = provider.addScript(`p13d-${name}-${serial++}`, steps, { onExhausted: "repeat" });
		agent.writeModels(provider);
		return id;
	};
	return {
		home: home.path, stateDir, schedulesFile, ledger: scratch.ledger, model,
		schedules: (): Schedule[] => existsSync(schedulesFile) ? readScheduleFile(schedulesFile) : [],
		runs: () => openScheduleRunStore(home.path),
		mandates: () => new MandateStore(home.path),
		/** A parent pi on this home: prompts `prompt` (the operator's words), runs `steps`, then settles each later turn. */
		async parent(prompt: string, steps: ScriptStep[]): Promise<PiChild> {
			const child = startPiChild({ cwd: home.path, model: model("parent", [...steps, { kind: "text", text: "P13d parent settled." }]),
				env: { ...agent.env, CP_HOME: home.path, CP_VIEWER_HOST: "127.0.0.1" }, extensions: [COMMAND_POST_EXTENSION] });
			parents.push(child);
			await child.prompt(prompt);
			await child.waitForSettled(90_000);
			return child;
		},
		async closeParents() { for (const child of parents.splice(0)) await child.close(); },
	};
}

const ends = (child: PiChild): Map<string, End[]> => {
	const byId = new Map<string, End[]>();
	for (const end of child.eventsOfType("tool_execution_end") as End[]) byId.set(end.toolCallId, [...(byId.get(end.toolCallId) ?? []), end]);
	return byId;
};
const said = (end: End | undefined): string => end?.result?.content?.map((part) => part.text ?? "").join("\n") ?? JSON.stringify(end);
const schedule = (id: string, args: Record<string, unknown> | (() => Record<string, unknown>)): MockToolCall =>
	({ id, name: "cp_schedule", args: typeof args === "function" ? () => args() : args });
/** Call `id`'s result: `ok` must not be an error, `refused` must be one; either way it matches `pattern`. */
function checkCall(child: PiChild, id: string, outcome: "ok" | "refused", pattern: RegExp): string {
	const end = ends(child).get(id)?.[0];
	assert.ok(end, `${id}: no tool result`);
	assert.equal(end.isError === true, outcome === "refused", `${id}: ${said(end)}`);
	assert.match(said(end), pattern, id);
	return said(end);
}
/** What a parent told the operator outside its turns: notify requests (RPC) and stderr. */
const told = (child: PiChild): string => [...child.records().filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message)), child.stderr()].join("\n");

/** The Schedules page's side of the control journal: append a request as the viewer does, wait for its answer. */
function dashboard(stateDir: string) {
	let serial = 0;
	return async (op: ScheduleControlOp, scheduleId: string, fields: ScheduleControlFields = {}) => {
		const at = new Date();
		const id = `sc-${at.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${String(++serial).padStart(8, "0")}`;
		assert.equal(appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id, at: at.toISOString(), peer: "127.0.0.1", op, schedule_id: scheduleId, ...fields }).ok, true);
		const entry = await waitFor(() => readScheduleControl(stateDir).requests.find((row) => row.id === id), (row) => row !== undefined && !["queued", "applying"].includes(row.state), { timeoutMs: 15_000, what: `${id} answered` });
		return [entry?.state, entry?.reason ?? ""] as const;
	};
}

const bytes = (file: string) => readFileSync(file);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
type Backup = { source: string; backup: string | null; sha256: string | null };

test("P13d native migration at parent start: legacy schedules become native revisions with no grant, operator stops and unsafe scopes stay off until saved or adopted, open legacy work defers until drained, the snapshot restores, and add refuses an unknown skill, a missing quote or a missing GitHub repo", { timeout: 300_000 }, async (t) => {
	const h = await schedulesHome(t);
	const AT = isoTimestamp();
	const worker = h.model("worker", [{ kind: "text", text: "P13d worker received." }]);
	const mandates = h.mandates(), runs = h.runs();
	const migrations = join(h.home, LAYOUT.migrationsDir);
	mkdirSync(migrations, { recursive: true });
	// A home past the template and v2 import migrations: only the native migration is new to it.
	for (const marker of [SCHEDULE_TEMPLATE_MIGRATION_MARKER, SCHEDULE_POLICY_IMPORT_MARKER]) writeFileSync(join(migrations, marker), `${AT}\n`);
	const rows: Schedule[] = [];
	let n = 0;
	/** A legacy grant-backed row as the pre-native add saved it. */
	const legacy = (name: string, over: Partial<Schedule> = {}, seedExtra: Partial<Parameters<MandateStore["issue"]>[0]> = {}): Schedule => {
		const seed = mandates.issue({ projects: ["demo"], objective: name, expiry: isoTimestamp(new Date(Date.now() + 30 * DAY)), spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 8,
			dispatch_parallelism: 3, schedule_grant: true, allowed_actions: ["plan", "implement", "merge"], ...seedExtra });
		const job = over.job ?? { title: name, kind: "research", delivery: "answer" };
		const derived = templateFromSeed(seed, synthesizedApproval(seed, "cp_schedule add"), AT, job);
		if (refused(derived)) throw new Error(derived.refusal);
		const row = { id: `sch-${(0xabc000 + ++n).toString(16)}`, name, project: "demo", mandate_id: seed.id, grant_template: derived.template, trigger: { type: "manual" }, job, enabled: true, created_at: AT, ...over } as Schedule;
		rows.push(row);
		return row;
	};
	const runOf = (policy: LegacySchedulePolicy, id: string, phase: "running" | "closed"): ScheduleRun => ({
		schema_version: 1, id, schedule_id: policy.schedule_id, policy_revision: policy.revision, policy, trigger: { via: "cp_schedule", at: AT, tool_call_id: `call-${id}` },
		anchor_job_id: null, members: [], phase, outcome: phase === "closed" ? "completed" : null, started_at: AT, deadline_at: isoTimestamp(new Date(Date.now() + 7 * DAY)),
		...(phase === "closed" ? { closed_at: AT } : {}), risk_preapproved: [], authority_log: [], cap_notices: [],
	}) as ScheduleRun;

	// E9: schema 2, no pointer, an active legacy revision 2 and a closed run.
	const e9 = { id: "sch-514530", name: "self-review", project: "demo", trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" }, enabled: true, created_at: AT } as Schedule;
	rows.push(e9);
	const rev1 = policyFromLegacy({ ...e9, mandate_id: "md-514530" }, { seed_mandate_id: "md-514530", channel: "operator_chat", objective: "self-review", expiry_hours: 36, spend_usd: 40,
		spend_tokens: 10_000_000, job_cap: 8, allowed_actions: ["plan", "review"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "run the self-review", decided_by: "operator-quote", approved_at: AT } });
	const rev2: LegacySchedulePolicy = { ...rev1, revision: 2, limits: { ...rev1.limits, parallelism: 6, run_hours: 168 }, exclusions: { paths: ["secrets/"], job_kinds: ["ship"] },
		model_policy: { mode: "pinned", by_role: { implementer: "openai/gpt-6.1-sol", planner: "openai/gpt-6.1-sol", reviewer: "openai/gpt-6.1-sol" } } };
	await runs.savePolicyRevision(rev1);
	await runs.savePolicyRevision(rev2, { at: AT, provenance: rev2.provenance });
	const e9Run = runOf(rev2, "run-20261020000000-aaaaaa", "closed");
	await runs.createRun(e9Run);
	const cron = legacy("cron", { trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" } });
	const watch = legacy("watch", { trigger: { type: "watch", script_path: "scripts/check.sh", every_seconds: 300, on: "changed" } });
	const manual = legacy("manual");
	const script = legacy("script", { job: { title: "script", kind: "ship", delivery: "local", script_path: "scripts/job.sh" } });
	const pr = legacy("pr", { job: { title: "pr", kind: "ship", delivery: "pr" } });
	const pipeline = legacy("pipeline", { job: { title: "pipeline", kind: "research", delivery: "pipeline" } });
	const gated = legacy("gated", { job: { title: "gated", kind: "research", delivery: "pipeline" } }, { ask_on: ["plan_approval", "merge", "risk:high"] });
	const adopted = legacy("adopted", { job: { title: "adopted", kind: "research", delivery: "pipeline" } }, { ask_on: ["plan_approval", "merge", "risk:high"] });
	const disabled = legacy("disabled", { enabled: false });
	const revoked = legacy("revoked"), paused = legacy("paused"), missing = legacy("missing"), corrupt = legacy("corrupt");
	const byRun = legacy("open run"), byJob = legacy("open job");
	const bare = { id: "sch-abcfff", name: "bare", project: "demo", trigger: { type: "manual" }, job: { title: "bare", kind: "research", delivery: "answer" }, enabled: true, created_at: AT } as Schedule;
	rows.push(bare);
	mandates.revoke(revoked.mandate_id!, { by: "operator", operator_quote: "stop it", decided_by: "operator-quote" });
	mandates.pause(paused.mandate_id!);
	rmSync(mandates.file(missing.mandate_id!));
	writeFileSync(mandates.file(corrupt.mandate_id!), "{not json");
	// The editor saved a native revision for `adopted` that nobody adopted yet.
	const adoptedDraft = nativePolicyDraft(policyFromLegacy(adopted, adopted.grant_template!, mandates.get(adopted.mandate_id)!),
		{ revision: 1, saved_at: AT, saved_by: "operator-quote", provenance: { channel: "cp_schedule", tool_call_id: "tool-save", quote_sha: "abcdef654321" } });
	await runs.savePolicyRevision(adoptedDraft);
	const frozen = policyFromLegacy(byRun, byRun.grant_template!);
	await runs.savePolicyRevision(frozen);
	const openRunId = "run-20261020000000-bbbbbb";
	await runs.createRun(runOf(frozen, openRunId, "running"));
	const oldFire = await h.ledger.create({ title: "old fire", project: "demo", kind: "ship", delivery: "pr", labels: [`schedule:${byJob.id}`] });
	writeFileSync(h.schedulesFile, JSON.stringify({ schema_version: 2, schedules: rows }));
	const before = new Map([h.schedulesFile, runs.policiesFile, runs.runsFile, mandates.file(cron.mandate_id!)].map((file) => [file, bytes(file)]));
	const grants = mandates.list().length;

	const first = await h.parent("P13d: Add the other-skill schedule. Add the prs schedule.", [{ kind: "tool_calls", calls: [
		schedule("run-missing", { action: "run_now", id: missing.id }),
		schedule("run-cron", { action: "run_now", id: cron.id, overrides: { model: worker } }),
		schedule("run-open", { action: "run_now", id: byJob.id }),
		schedule("run-e9", { action: "run_now", id: e9.id, overrides: { model: worker, parallelism: 1 } }),
		schedule("cp-other", { action: "add", name: "other-skill", project: "demo", manual: true, title: "other", kind: "research", delivery: "local", skill: "cp-other", operator_quote: "Add the other-skill schedule." }),
		schedule("no-quote", { action: "add", name: "no quote", project: "demo", manual: true, title: "self", kind: "research", delivery: "local", skill: "cp-self-review" }),
		schedule("no-repo", { action: "add", name: "prs", project: "demo", manual: true, title: "PR review", kind: "research", delivery: "local", skill: "cp-pr-review",
			description: "pr: https://github.com/acme/demo/pull/1", operator_quote: "Add the prs schedule." }),
	] }]);
	const notice = told(first);
	const migrated = (s: Schedule, revision: number) => assert.ok(notice.includes(`${s.id}: native revision ${revision} active; no grant minted`), `${s.name}: ${notice}`);
	const row = (s: Schedule) => h.schedules().find((entry) => entry.id === s.id)!;

	// E9 becomes native revision 3 with identical scope and caps; old revisions and closed runs stay as they were.
	migrated(e9, 3);
	const active = runs.activePolicy(e9.id) as NativeSchedulePolicy;
	assert.ok(isNativePolicy(active));
	assert.deepEqual([active.revision, active.saved_by, active.mode, active.kinds, active.effects], [3, "migration", "report-only", ["research"], ["board_publish"]]);
	assert.deepEqual(active.limits, { usd: 40, tokens: 10_000_000, child_jobs: 8, parallelism: 6, run_hours: 168 });
	for (const key of ["project", "recipe", "recipe_config", "trigger", "exclusions", "model_policy"] as const) assert.deepEqual(active[key], rev2[key], key);
	assert.deepEqual(h.runs().policyRecord(e9.id)!.revisions.slice(0, 2), [rev1, rev2], "old revisions are kept unchanged");
	const { result: _delivered, ...closedRun } = h.runs().run(e9Run.id)!;
	assert.deepEqual(closedRun, e9Run, "closed runs are untouched (the parent's result delivery aside)");
	assert.deepEqual(row(e9), e9, "id, name, trigger and recipe are preserved");
	// Saved pins are run defaults, not a ceiling: a run now overrides them, still with no grant.
	checkCall(first, "run-e9", "ok", /fired: created cp-/);
	const e9Open = h.runs().openRun(e9.id)!;
	assert.deepEqual([e9Open.execution?.effective, e9Open.policy_revision], [{ model: worker, parallelism: 1 }, 3]);

	// Old grant-backed fixtures: converted with their bounds, pointers retired by the system.
	for (const s of [cron, watch, manual, script, pr, pipeline, disabled]) {
		migrated(s, 1);
		const policy = h.runs().activePolicy(s.id)!;
		assert.ok(isNativePolicy(policy), s.name);
		assert.deepEqual([policy.trigger, policy.recipe.title, policy.limits.usd, policy.limits.child_jobs, policy.limits.parallelism], [s.trigger, s.job.title, 20, 8, 3], s.name);
		assert.deepEqual([row(s).mandate_id, row(s).grant_template], [undefined, undefined], s.name);
		assert.equal(h.mandates().get(s.mandate_id)?.revoked_by?.by, "system", `${s.name}: the retired pointer is revoked by the system`);
	}
	assert.deepEqual([(h.runs().activePolicy(pr.id) as NativeSchedulePolicy).mode, h.runs().activePolicy(pipeline.id)!.effects], ["write", ["pipeline", "pull_request"]]);
	assert.equal(row(disabled).enabled, false, "a disabled schedule stays disabled");
	for (const s of [revoked, paused]) {
		assert.equal(h.runs().activePolicy(s.id), undefined, `${s.name}: an operator stop is never undone`);
		assert.match(row(s).last_skip?.reason ?? "", /^native migration: operator stop on md-.+ preserved: native revision 1 is saved, adopt it to resume$/);
	}
	assert.equal(h.mandates().get(paused.mandate_id)?.status, "paused");
	assert.match(notice, new RegExp(`${gated.id}: needs scope edit: the legacy grant asked for plan approval before implementing`));
	assert.match(notice, new RegExp(`${missing.id}: needs setup: seed grant md-\\S+ is missing; no authority is inferred`));
	assert.match(notice, new RegExp(`${corrupt.id}: needs setup: a legacy grant of ${corrupt.id} is unreadable`));
	assert.match(notice, new RegExp(`${bare.id}: needs setup: no saved policy or grant template`));
	assert.ok(row(gated).grant_template, "a skipped schedule keeps its legacy rows readable");
	checkCall(first, "run-missing", "ok", new RegExp(`\\(${missing.id}\\) skipped: run now not recorded: native migration: needs setup: seed grant`));
	checkCall(first, "run-cron", "ok", /fired: created cp-/);
	assert.equal(h.mandates().list().length, grants, "neither a refused nor a native fire mints a grant");

	// Open legacy work defers its schedule under its original authority, and holds the marker back.
	assert.match(notice, new RegExp(`${byRun.id}: open legacy run or job; continues under its original authority, migrates once drained`));
	assert.match(notice, new RegExp(`${byJob.id}: open legacy run or job`));
	assert.equal(existsSync(join(migrations, "2027-01-schedule-native.done")), false, "a deferred schedule holds the marker back");
	assert.equal(h.mandates().get(byRun.mandate_id)?.status, "active", "a deferred pointer is not retired");
	checkCall(first, "run-open", "ok", new RegExp(`legacy run ${oldFire.id} is still open: it continues under its original authority`));

	// The add refusals P13c's 12-12 did not carry: nothing is written for any of them.
	checkCall(first, "cp-other", "refused", /Validation failed for tool "cp_schedule":\n {2}- skill: must be equal to one of the allowed values/);
	checkCall(first, "no-quote", "refused", /cp_schedule add needs operator_quote/);
	checkCall(first, "no-repo", "refused", /needs the project's GitHub repo/);
	assert.deepEqual(h.schedules().filter((entry) => ["other-skill", "no quote", "prs"].includes(entry.name)), [], "a refused add writes nothing");

	// A migration-skipped schedule saved natively later, or adopting a saved native revision, keeps no legacy row.
	const ask = dashboard(h.stateDir);
	const draft = policyFromLegacy(gated, gated.grant_template!, h.mandates().get(gated.mandate_id)!);
	assert.equal((await ask("save_policy", gated.id, { revision: 0, policy: draft }))[0], "done");
	assert.equal((await ask("adopt", adopted.id, { revision: 1 }))[0], "done");
	for (const s of [gated, adopted]) {
		assert.ok(isNativePolicy(h.runs().activePolicy(s.id)!), s.name);
		assert.deepEqual([row(s).mandate_id, row(s).grant_template, row(s).last_skip], [undefined, undefined, undefined], s.name);
		assert.equal(h.mandates().get(s.mandate_id)?.status, "revoked", `${s.name}: the retired pointer is revoked`);
	}
	const manifestFile = join(migrations, "2027-01-schedule-native.backup.json");
	const firstManifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Backup[];
	await h.closeParents();

	// The legacy run and job drain; the next parent converts both and writes the marker.
	await h.runs().closeRun(openRunId, "completed", isoTimestamp());
	await h.ledger.close(oldFire.id, "drained");
	const second = await h.parent("P13d: second process.", []);
	assert.match(told(second), new RegExp(`${byRun.id}: native revision 2 active; no grant minted`), "the converted revision follows the frozen legacy one");
	assert.match(told(second), new RegExp(`${byJob.id}: native revision 1 active; no grant minted`));
	assert.ok(existsSync(join(migrations, "2027-01-schedule-native.done")));
	assert.deepEqual(h.runs().run(openRunId)?.policy, frozen, "the old run keeps its original authority");
	const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Backup[];
	assert.deepEqual(manifest.slice(0, firstManifest.length), firstManifest, "the first snapshot is never replaced");
	const policies = bytes(h.runs().policiesFile);
	await h.closeParents();
	const third = await h.parent("P13d: third process.", []);
	assert.doesNotMatch(told(third), /native schedule migration/, "a repeat migration says nothing");
	assert.deepEqual(bytes(h.runs().policiesFile), policies, "a repeat migration writes no policy");
	await h.closeParents();

	// The rollback manifest: verified 0600 snapshots; restoring it gives the readable pre-migration stores.
	for (const entry of manifest.filter((r) => r.backup)) {
		assert.equal(statSync(entry.backup!).mode & 0o777, 0o600);
		assert.equal(sha(entry.backup!), entry.sha256);
	}
	assert.deepEqual(manifest.filter((r) => !r.backup).map((r) => r.source), [mandates.file(missing.mandate_id!)], "absent stores are named");
	for (const entry of manifest) if (entry.backup) copyFileSync(entry.backup, entry.source); else rmSync(entry.source, { force: true });
	rmSync(join(migrations, "2027-01-schedule-native.done"));
	for (const [file, original] of before) assert.deepEqual(bytes(file), original, file);
	assert.equal(readScheduleFile(h.schedulesFile).find((s) => s.id === cron.id)?.grant_template?.seed_mandate_id, cron.mandate_id, "the restored legacy row reads");
	assert.equal(h.mandates().get(cron.mandate_id)?.status, "active");
});

test("P13d template and v2 import migrations at parent start: every seed with bounds derives a template, a broken seed skips by name, rewritten stores are snapshotted, stops and open jobs are kept, the next process finishes and a third says nothing", { timeout: 300_000 }, async (t) => {
	const h = await schedulesHome(t);
	const migrations = join(h.home, LAYOUT.migrationsDir);
	const past = new Date(Date.now() - 10 * DAY), AT = isoTimestamp(past);
	const seeds = new MandateStore(h.home, { now: () => past });
	const issue = (objective: string, extra: Partial<Parameters<MandateStore["issue"]>[0]> = {}) => seeds.issue({ projects: ["demo"], objective, expiry: isoTimestamp(new Date(Date.now() + 30 * DAY)),
		spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 8, dispatch_parallelism: 3, at: AT, schedule_grant: true, allowed_actions: ["plan", "implement", "merge"], ...extra });
	const pre = { operator_quote: "Approve safe org PRs", decided_by: "operator-quote" as const, scope: "mandate_jobs" as const, granted_at: AT };
	const rows: Schedule[] = [];
	/** A v1 row; `template` false leaves the template migration to derive one. */
	const row = (id: string, seed: string, job: Partial<Schedule["job"]> = {}, template = true, trigger: Schedule["trigger"] = { type: "manual" }): Schedule => {
		const jobOf = { title: id, kind: "research", delivery: "answer", ...job } as Schedule["job"];
		const mandate = seeds.get(seed);
		const derived = template && mandate ? templateFromSeed(mandate, synthesizedApproval(mandate, "cp_schedule add"), AT, jobOf) : undefined;
		if (derived && refused(derived)) throw new Error(derived.refusal);
		const entry = { id, name: id, project: "demo", mandate_id: seed, ...(derived ? { grant_template: derived.template } : {}), trigger, job: jobOf, enabled: true, created_at: AT } as Schedule;
		rows.push(entry);
		return entry;
	};
	// Template-migration seeds: revoked by the operator, the parent or pre-provenance, expired, pre-approved, a skill.
	const revoked = issue("nightly triage"), byParent = issue("parent triage"), bare = issue("bare triage");
	seeds.revoke(revoked.id, { by: "operator", operator_quote: "revoke the triage seed", decided_by: "operator-quote" });
	seeds.revoke(byParent.id, { by: "parent" });
	seeds.revoke(bare.id);
	const expired = issue("expired triage", { expiry: isoTimestamp(new Date(past.getTime() + 2 * DAY)) });
	const preapproved = issue("pre-approved triage", { risk_preapproval: pre });
	const skill = issue("self-review", { job_cap: 2 });
	const projectWide = issue("project-wide", { schedule_grant: undefined });
	const garbled = issue("garbled");
	row("sch-aaaaa1", revoked.id, {}, false, { type: "cron", cron: "0 9 * * *", tz: "UTC" });
	row("sch-aaaaa2", expired.id, {}, false);
	row("sch-aaaaa3", preapproved.id, {}, false);
	row("sch-aaaaa4", skill.id, { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" }, false);
	row("sch-aaaaa5", "md-ffffff", {}, false);
	row("sch-aaaaa6", garbled.id, {}, false);
	row("sch-aaaaa7", bare.id, {}, false);
	row("sch-aaaaa8", projectWide.id, {}, false);
	row("sch-aaaaa9", byParent.id, {}, false);
	// The v2 import's rows, saved with templates as the pre-PR4 add did.
	const ok = row("sch-bbbbb1", issue("importable").id);
	const pipeline = row("sch-bbbbb2", issue("pipeline").id, { delivery: "pipeline" });
	const stopped = row("sch-bbbbb3", issue("stopped").id), paused = row("sch-bbbbb4", issue("paused").id), deferred = row("sch-bbbbb5", issue("deferred").id);
	const cleared = row("sch-bbbbb6", issue("cleared", { risk_preapproval: pre }).id, { skill: "cp-org-pr-review", delivery: "local", description: "org: acme\nmax_reviewers: 3" });
	const plain = row("sch-bbbbb7", issue("plain").id, { skill: "cp-org-pr-review", delivery: "local", description: "org: acme" });
	const stoppedOrg = row("sch-bbbbb8", issue("stopped org", { risk_preapproval: pre }).id, { skill: "cp-org-pr-review", delivery: "local", description: "org: acme" });
	seeds.revoke(stopped.mandate_id!, { by: "operator", operator_quote: "stop it", decided_by: "operator-quote" });
	seeds.revoke(stoppedOrg.mandate_id!, { by: "operator", operator_quote: "stop org", decided_by: "operator-quote" });
	seeds.pause(paused.mandate_id!);
	writeFileSync(seeds.file(garbled.id), "{not json");
	const open = await h.ledger.create({ title: "old run", project: "demo", kind: "research", delivery: "answer", labels: [`schedule:${deferred.id}`] });
	mkdirSync(h.stateDir, { recursive: true });
	writeFileSync(h.schedulesFile, JSON.stringify({ schema_version: 1, schedules: rows }));
	const originals = new Map([h.schedulesFile, seeds.file(revoked.id), seeds.file(ok.mandate_id!)].map((file) => [file, bytes(file)]));

	const first = await h.parent("P13d: first process.", []);
	const notice = told(first);
	const line = (text: string) => notice.split("\n").find((entry) => entry.startsWith(`  ${text}`)) ?? "";
	const legacyOf = (s: Schedule) => h.runs().policyRecord(s.id)!.revisions[0] as LegacySchedulePolicy;
	const rowOf = (s: Schedule) => h.schedules().find((entry) => entry.id === s.id)!;

	// The template migration: a revoked, expired, pre-approved or parent-revoked seed still yields its bounds.
	assert.match(notice, /schedules migrated to a fresh grant per fire \(6 migrated, 3 skipped\)/);
	assert.match(line("sch-aaaaa1"), new RegExp(`^  sch-aaaaa1: template from ${revoked.id} — merge removed from allowed_actions`));
	assert.deepEqual(legacyOf(rows[0]!).approval, { operator_quote: "nightly triage", decided_by: "operator-delegated",
		delegation_rule: `schedule migration: the objective of seed grant ${revoked.id}, quoted verbatim`, approved_at: legacyOf(rows[0]!).approval.approved_at });
	assert.match(line("sch-aaaaa2"), /each fire grant lives 48 h from its fire \(the seed's lifetime\)/);
	assert.match(line("sch-aaaaa3"), /the seed's risk:high pre-approval is not carried/);
	assert.match(line("sch-aaaaa4"), /job cap raised from 2 to 8/);
	assert.equal(legacyOf(rows[3]!).limits.child_jobs, 8, "a skill template is raised to its fan-out plus anchor");
	assert.match(line("sch-aaaaa9"), new RegExp(`^  sch-aaaaa9: template from ${byParent.id}`));
	assert.match(notice, /sch-aaaaa5: schedule sch-aaaaa5 has no grant template \(migration: seed grant md-ffffff is missing\), so no fire can mint a fresh grant/);
	assert.match(notice, new RegExp(`sch-aaaaa6: schedule sch-aaaaa6 has no grant template \\(migration: seed grant ${garbled.id} cannot be parsed`));
	assert.match(notice, new RegExp(`sch-aaaaa8: schedule sch-aaaaa8 has no grant template \\(migration: ${projectWide.id} is not a schedule grant\\)`));
	assert.ok(existsSync(join(migrations, SCHEDULE_TEMPLATE_MIGRATION_MARKER)));

	// The v2 import: snapshots of the pre-session stores, legacy revisions with template bounds, the pointer retired.
	const v2 = JSON.parse(readFileSync(join(migrations, "2026-12-schedule-policy-v2.backup.json"), "utf8")) as Backup[];
	for (const [file, original] of originals) assert.deepEqual(bytes(v2.find((r) => r.source === file)!.backup!), original, file);
	assert.match(v2.find((r) => r.source === h.schedulesFile)!.backup!, /schedules\.v1\..+\.json$/);
	for (const entry of v2.filter((r) => r.backup)) assert.deepEqual([statSync(entry.backup!).mode & 0o777, sha(entry.backup!)], [0o600, entry.sha256]);
	assert.match(line("sch-bbbbb1"), /^  sch-bbbbb1: policy active; no grant minted$/);
	const imported = legacyOf(ok);
	assert.deepEqual(imported.limits, { usd: 20, tokens: 2_000_000, child_jobs: 8, parallelism: 3, run_hours: 168 });
	assert.deepEqual([imported.approval, imported.ask_on, imported.exclusions], [ok.grant_template!.approval, ok.grant_template!.ask_on, ok.grant_template!.exclusions ?? {}]);
	assert.deepEqual(imported.provenance, { channel: "migration", legacy_seed: ok.mandate_id });
	assert.deepEqual([JSON.parse(readFileSync(h.schedulesFile, "utf8")).schema_version, rowOf(ok).mandate_id, rowOf(ok).grant_template], [2, undefined, undefined]);
	assert.equal(h.mandates().get(ok.mandate_id)?.revoked_by?.by, "system");
	assert.ok(legacyOf(cleared).effects.includes("org_review_approve"), "dashboard-only org-review clearance is imported");
	assert.deepEqual([legacyOf(cleared).effect_channels.org_review_approve, legacyOf(cleared).recipe_config?.max_reviewers, legacyOf(cleared).limits.parallelism, legacyOf(cleared).limits.child_jobs],
		[["dashboard"], 3, 3, 8]);
	assert.deepEqual([plain, stoppedOrg].map((s) => legacyOf(s).effects.includes("org_review_approve")), [false, false], "no clearance without a live pre-approved seed");
	assert.match(notice, /sch-bbbbb2: stays on per-fire grants/);
	assert.match(notice, /sch-aaaaa5: needs setup: no template to import; open the editor/);
	for (const s of [stopped, paused]) {
		assert.match(notice, new RegExp(`${s.id}: operator stop on ${s.mandate_id} preserved; adopt to resume`));
		assert.deepEqual([h.runs().activePolicy(s.id), rowOf(s).enabled], [undefined, true], s.name);
	}
	assert.match(notice, /sch-bbbbb5: open legacy\/run job; retry next session start/);
	assert.equal(existsSync(join(migrations, SCHEDULE_POLICY_IMPORT_MARKER)), false, "an open job holds the import marker back");
	const revisions = (s: Schedule) => h.runs().policyRecord(s.id)?.revisions.length;
	const stoppedRevisions = revisions(stopped);
	await h.closeParents();

	// The open job drains; the next process imports it and writes the marker, without duplicating a stopped revision.
	await h.ledger.close(open.id, "drained");
	const second = await h.parent("P13d: second process.", []);
	assert.match(told(second), /schedule policy v2 import \(\d+ migrated, \d+ skipped, 0 deferred\)[^]*\n {2}sch-bbbbb5: policy active; no grant minted\n/);
	assert.ok(existsSync(join(migrations, SCHEDULE_POLICY_IMPORT_MARKER)));
	assert.ok(h.runs().activePolicy(deferred.id));
	// KD-P13d-stop-revisions: between a deferred import and its retry the native migration saves a revision, so the
	// retry's resume check misses and a stopped schedule gains a legacy and a native revision per deferred start.
	assert.deepEqual([revisions(stopped), revisions(paused)], [stoppedRevisions! + 2, stoppedRevisions! + 2], "known defect: two more");
	assert.equal(h.mandates().get(paused.mandate_id)?.status, "paused");
	// schedules.json is left out: the parent's cron tick stamps its checkpoint there.
	const stores = () => [h.runs().policiesFile, seeds.file(ok.mandate_id!), seeds.file(stopped.mandate_id!)].map(bytes);
	const settled = stores();
	await h.closeParents();
	const third = await h.parent("P13d: third process.", []);
	assert.doesNotMatch(told(third), /schedules migrated|schedule policy v2 import/, "the markers make a re-run say nothing");
	assert.deepEqual(stores(), settled, "the markers make a re-run touch nothing");
	await h.closeParents();

	// Rollback after drain: the v2 snapshot restores the pre-session stores byte for byte.
	for (const entry of v2) if (entry.backup) copyFileSync(entry.backup, entry.source); else rmSync(entry.source, { force: true });
	for (const [file, original] of originals) assert.deepEqual(bytes(file), original, file);
});

test("P13d migrations fail closed at parent start: a home with no schedules writes only the marker; a backup directory that is a file or a damaged snapshot stops the import before any store is rewritten", { timeout: 180_000 }, async (t) => {
	const h = await schedulesHome(t);
	const migrations = join(h.home, LAYOUT.migrationsDir);
	const empty = await h.parent("P13d: empty home.", []);
	assert.ok(existsSync(join(migrations, SCHEDULE_TEMPLATE_MIGRATION_MARKER)), "no schedules file: the marker alone");
	assert.doesNotMatch(told(empty), /schedules migrated/);
	await h.closeParents();
	// A pre-import home: its later migrations have not run yet.
	for (const marker of [SCHEDULE_POLICY_IMPORT_MARKER, "2027-01-schedule-native.done"]) rmSync(join(migrations, marker));

	const seeds = h.mandates(), AT = isoTimestamp();
	const seed = seeds.issue({ projects: ["demo"], objective: "backup failure", expiry: isoTimestamp(new Date(Date.now() + 30 * DAY)), spend_cap: { usd: 20, tokens: 2_000_000 },
		job_cap: 8, dispatch_parallelism: 3, schedule_grant: true });
	const job = { title: "backup failure", kind: "research", delivery: "answer" } as Schedule["job"];
	const derived = templateFromSeed(seed, synthesizedApproval(seed, "cp_schedule add"), AT, job);
	if (refused(derived)) throw new Error(derived.refusal);
	writeFileSync(h.schedulesFile, JSON.stringify({ schema_version: 1, schedules: [{ id: "sch-ddddd1", name: "backup failure", project: "demo", mandate_id: seed.id,
		grant_template: derived.template, trigger: { type: "manual" }, job, enabled: true, created_at: AT }] }));
	const stores = () => [bytes(h.schedulesFile), bytes(seeds.file(seed.id)), h.runs().policyRecord("sch-ddddd1")];
	const original = stores();
	// A file where the backup directory goes: mkdir fails as root too.
	const backups = join(migrations, "backups");
	rmSync(backups, { recursive: true, force: true });
	writeFileSync(backups, "not a directory");
	const blocked = await h.parent("P13d: blocked backup.", []);
	assert.match(told(blocked), /schedule policy import failed for .*: .*(EEXIST|ENOTDIR)/);
	assert.deepEqual(stores(), original, "no schedule, grant or policy write after a failed backup");
	await h.closeParents();

	// A snapshot whose bytes no longer match its manifest hash.
	rmSync(backups);
	mkdirSync(backups, { recursive: true });
	const snapshot = join(backups, "schedules.v1.damaged.json");
	writeFileSync(snapshot, "damaged snapshot", { mode: 0o600 });
	writeFileSync(join(migrations, "2026-12-schedule-policy-v2.backup.json"), JSON.stringify([{ source: h.schedulesFile, backup: snapshot, sha256: sha(h.schedulesFile) }]));
	const damaged = await h.parent("P13d: damaged snapshot.", []);
	assert.match(told(damaged), /schedule policy import failed for .*: schedule import backup verification failed: .*schedules\.v1\.damaged\.json/);
	assert.equal(existsSync(join(migrations, SCHEDULE_POLICY_IMPORT_MARKER)), false);
	// KD-P13d-tick-after-failed-import: the session-start return does not stop the tick, whose native sweep then converts
	// the schedule. Its own snapshot proves the failed import rewrote nothing first.
	const native = JSON.parse(readFileSync(join(migrations, "2027-01-schedule-native.backup.json"), "utf8")) as Backup[];
	assert.deepEqual([bytes(native.find((r) => r.source === h.schedulesFile)!.backup!), bytes(native.find((r) => r.source === seeds.file(seed.id))!.backup!)], original.slice(0, 2));
	assert.deepEqual(h.runs().policyRecord("sch-ddddd1")?.revisions.map((r) => [r.revision, isNativePolicy(r)]), [[1, true]], "no import revision was saved");
	assert.match(told(damaged), /native schedule migration \(1 migrated/, "known defect: a tick runs after the failed import");
});

test("P13d legacy run authority through cp_dispatch: a draining legacy run asks risk:high once under its own attribution, an operator start pre-approves its members but never a hard stop, exclusions and non-members refuse, and no grant is spent", { timeout: 180_000 }, async (t) => {
	const h = await schedulesHome(t);
	const runs = h.runs(), at = isoTimestamp(new Date(Date.now() - 600_000)), click = "sc-20261010030653-11806a8e";
	const worker = h.model("worker", [{ kind: "text", text: "P13d worker received." }]);
	const grant = h.mandates().issue({ projects: ["demo"], objective: "Other work", expiry: isoTimestamp(new Date(Date.now() + DAY)), spend_cap: { usd: 20, tokens: 2000 }, job_cap: 4,
		allowed_actions: ["implement", "review", "repair"], ask_on: ["merge", "risk:high"] });
	const grantBytes = bytes(h.mandates().file(grant.id));
	/** A running legacy run of schedule `sid`, as a pre-native fire left it, with ledger jobs admitted as members. */
	const legacyRun = async (sid: string, trigger: ScheduleRun["trigger"], members: Array<{ title: string; description?: string }>, over: Partial<LegacySchedulePolicy> = {}) => {
		const policy = { ...policyFromLegacy({ id: sid, name: sid, project: "demo", mandate_id: "md-123456", enabled: true, created_at: at, trigger: { type: "manual" }, job: { title: sid, kind: "ship", delivery: "pr" } }, {
			seed_mandate_id: "md-123456", channel: "operator_chat", objective: "Nightly work", expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 8,
			allowed_actions: ["implement", "review", "repair"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run nightly work", decided_by: "operator-quote", approved_at: at } }), ...over };
		await runs.savePolicyRevision(policy);
		const jobs = await Promise.all(members.map((m) => h.ledger.create({ ...m, project: "demo", kind: "ship", delivery: "pr", labels: [`schedule:${sid}`, ...(over.exclusions ? [] : ["risk:high"])] })));
		const run = { schema_version: 1, id: `run-20261010030655-${sid.slice(4)}`, schedule_id: sid, policy_revision: 1, policy, trigger, anchor_job_id: jobs[0]!.id,
			members: jobs.map((job) => ({ job_id: job.id, role: null, admitted_at: at })), phase: "running", outcome: null, started_at: at,
			deadline_at: isoTimestamp(new Date(Date.now() + 3_600_000)), risk_preapproved: [], authority_log: [], cap_notices: [],
			...(trigger.via === "slot" ? {} : { risk_preapproval: { operator_quote: "Run nightly work", decided_by: "operator-quote", scope: "mandate_jobs", granted_at: at } }) } as ScheduleRun;
		await runs.createRun(run);
		return { run, jobs };
	};
	const timer = await legacyRun("sch-a00001", { via: "slot", at, slot: at, missed: false }, [{ title: "timer member" }]);
	await runs.activatePolicy("sch-a00001", 1, at, { channel: "dashboard", request_id: "sc-test" });
	const outsider = await h.ledger.create({ title: "not admitted", project: "demo", kind: "ship", delivery: "pr", labels: ["schedule:sch-a00001"] });
	const started = await legacyRun("sch-a00002", { via: "dashboard", at, slot: at, missed: false, request_id: click }, [{ title: "operator member" }, { title: "dangerous", description: "force push the branch" }]);
	const excluded = await legacyRun("sch-a00003", { via: "slot", at }, [{ title: "excluded member" }], { exclusions: { job_kinds: ["ship"] } });
	const called = await legacyRun("sch-a00004", { via: "cp_schedule", at, slot: at, missed: false, tool_call_id: "call-1", quote_sha: "0123456789ab" }, [{ title: "called member" }]);
	const dispatch = (id: string, jobId: string, risk = "high") => ({ id, name: "cp_dispatch", args: { job_id: jobId, task: "Bump x.", model: worker, risk, queue: false, when_ready: false } });
	const [member, dangerous] = started.jobs;
	const parent = await h.parent("P13d: dispatch the run members.", [
		{ kind: "tool_calls", calls: [dispatch("timer", timer.jobs[0]!.id)] },
		{ kind: "tool_calls", calls: [dispatch("timer-again", timer.jobs[0]!.id)] },
		{ kind: "tool_calls", calls: [dispatch("operator", member!.id)] },
		{ kind: "tool_calls", calls: [dispatch("dangerous", dangerous!.id)] },
		{ kind: "tool_calls", calls: [dispatch("called", called.jobs[0]!.id)] },
		{ kind: "tool_calls", calls: [dispatch("excluded", excluded.jobs[0]!.id, "low")] },
		{ kind: "tool_calls", calls: [dispatch("outsider", outsider.id)] },
	]);
	const escalations = (jobId: string) => new EscalationStore({ home: h.home }).list({ jobId, kind: "risk_high_irreversible" });

	// A timer run asks risk:high under the run's attribution, once across two dispatches.
	checkCall(parent, "timer", "refused", new RegExp(`schedule-run ${timer.run.id}: risk:high requires operator text`));
	checkCall(parent, "timer-again", "refused", /risk:high requires operator text/);
	const [ask, ...more] = escalations(timer.jobs[0]!.id);
	assert.deepEqual([ask?.mandate_id, more.length], [timer.run.id, 0], "one ask, attributed to the run");
	assert.match(ask!.mandate_clause ?? "", new RegExp(`^${timer.run.id} \\(schedule sch-a00001, policy rev 1\\): ask_on includes risk:high$`));
	assert.ok(ask!.question.includes(`Started by the timer (slot ${at})`), ask!.question);

	// A verified operator start pre-approves its member's dispatch, audited with the click; a hard stop still asks.
	checkCall(parent, "operator", "ok", /dispatched/);
	assert.deepEqual(escalations(member!.id), [], "no ask for a pre-approved member");
	const audited = runs.run(started.run.id)!;
	assert.deepEqual(audited.risk_preapproved.map((r) => [r.job_id, r.decided_by, r.evidence[0]]), [[member!.id, "operator", `fire run_now ${click}`]]);
	assert.ok(readFileSync(join(h.home, paths.briefFile(member!.id)), "utf8").includes(`Started by the operator via dashboard Run now (request ${click}, ${at})`));
	checkCall(parent, "dangerous", "refused", new RegExp(`${dangerous!.id}: schedule-run ${started.run.id}: risk:high requires operator text`));
	assert.match(escalations(dangerous!.id)[0]?.mandate_clause ?? "", /hard stop; no standing approval covers it/);
	assert.match(escalations(dangerous!.id)[0]?.question ?? "", new RegExp(`Started by the operator via dashboard Run now \\(request ${click}, `));
	checkCall(parent, "called", "ok", /dispatched/);
	assert.deepEqual(runs.run(called.run.id)!.risk_preapproved.map((r) => r.evidence[0]), ["fire run_now call-1"]);
	assert.ok(readFileSync(join(h.home, paths.briefFile(called.jobs[0]!.id)), "utf8").includes(`Started by the operator via cp_schedule run_now (call call-1, ${at})`));

	// Exclusions and non-members refuse with their codes in the run's audit; the operator-chat grant is never touched.
	checkCall(parent, "excluded", "refused", /ship is excluded/);
	assert.deepEqual(runs.run(excluded.run.id)!.authority_log.map((r) => [r.use, r.code]), [["dispatch", "kind_excluded"]]);
	checkCall(parent, "outsider", "refused", new RegExp(`${outsider.id}: activated schedule sch-a00001 requires run membership`));
	assert.deepEqual(audited.authority_log.filter((r) => r.decision === "permit").map((r) => [r.use, r.job_id]), [["dispatch", member!.id]]);
	assert.deepEqual(bytes(h.mandates().file(grant.id)), grantBytes, "no grant spent or mutated");
});
