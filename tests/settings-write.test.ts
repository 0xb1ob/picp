/**
 * cp-7bsr PR2: the audited owner-file transaction (src/settings-write.ts). Set and restore per owner,
 * the restore table (incl. the installer seed for auto-update), absent-file bases, refusals, dry run,
 * the intent-before-write order, rollback, crash recovery, the lock, and the audit journal's shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, SETTING_FIELDS, type SettingFileOwner, type SettingKey, type SettingsSnapshot } from "../src/contracts.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";
import { readSettings } from "../src/settings.ts";
import { acquireSettingsLock } from "../src/settings-lock.ts";
import { applySettings, INSTALLER_UPDATE_SEED, mergeRubric, RESTORE_ACTIONS, restoreShippedRubric, type SettingsApplyInput, settingsAuditFile, type SettingsWriteRequest, type SettingsWriteSeams } from "../src/settings-write.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const OWNER_FILE: Record<Exclude<SettingFileOwner, "routing">, string> = {
	"mandate-defaults": LAYOUT.mandateDefaultsFile,
	budgets: LAYOUT.budgetsFile,
	"worker-bounds": LAYOUT.workerBoundsFile,
	parent: `${LAYOUT.data}/parent.json`,
	operator: `${LAYOUT.data}/operator.json`,
	gate: LAYOUT.gateConfigFile,
	quality: `${LAYOUT.data}/quality.json`,
	capacity: `${LAYOUT.data}/capacity.json`,
	update: `${LAYOUT.data}/update.json`,
};
type Owner = keyof typeof OWNER_FILE;
const CAPACITY = { url: "https://secret-gateway.example/", path: "/v1/secret-path" };

function scratch(t: TestContext): string {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	return home.path;
}
const file = (home: string, owner: Owner) => join(home, OWNER_FILE[owner]);
const put = (home: string, owner: Owner, body: unknown) => writeFileSync(file(home, owner), typeof body === "string" ? body : JSON.stringify(body));
const json = (home: string, owner: Owner) => JSON.parse(readFileSync(file(home, owner), "utf8"));
const snap = (home: string) => readSettings(home, {});
const view = (snapshot: SettingsSnapshot, key: SettingKey) => snapshot.fields.find((row) => row.key === key);
const audit = (home: string): Array<Record<string, unknown>> => existsSync(settingsAuditFile(home)) ? readFileSync(settingsAuditFile(home), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function apply(home: string, request: SettingsWriteRequest, options: Partial<SettingsApplyInput> = {}, seams: SettingsWriteSeams = {}) {
	return applySettings(home, { request, expected_revision: snap(home).revision, dry_run: false, request_id: "req-12345678", peer: "100.64.0.1", actor: "dashboard", env: {}, ...options }, seams);
}

function listing(root: string): string[] {
	return readdirSync(root, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.map((path) => `${relative(root, path)}\t${statSync(path).mtimeMs}\t${sha(readFileSync(path))}`)
		.sort();
}

/** One existing file per owner, each with a key the transaction must keep. */
function fullHome(t: TestContext): string {
	const home = scratch(t);
	put(home, "mandate-defaults", SCAFFOLD_MANDATE_DEFAULTS);
	put(home, "budgets", { ...DEFAULT_BUDGET_CONFIG, cumulative_cost_usd: 5 });
	put(home, "worker-bounds", { wall_clock_seconds: 100 });
	put(home, "parent", { compact_at_tokens: 100 });
	put(home, "operator", { compact_at_tokens: 100, handoffs_dir: "/tmp/handoffs" });
	put(home, "gate", { schema_version: 1 });
	put(home, "quality", { model: "anthropic/claude-haiku" });
	put(home, "capacity", CAPACITY);
	put(home, "update", { enabled: true, interval_min: 15 });
	return home;
}

const SET: Partial<Record<SettingKey, unknown>> = {
	"grants.job_cap": 7,
	"budgets.spawn_cap": 5,
	"sessions.wall_clock_seconds": 200,
	"sessions.parent_compact_at_tokens": 300,
	"sessions.operator_compact_at_tokens": 400,
	"review.timeout_ms": 60_000,
	"review.quality_verify": true,
	"capacity.five_hour": 70,
	"maintenance.update_interval_min": 30,
};

test("set per owner: each of the 9 owners changes only the named key; other keys survive; read-back is file/ok", (t) => {
	const home = fullHome(t);
	const result = apply(home, { mode: "set", changes: SET });
	assert.equal(result.status, 200, JSON.stringify(result));
	assert.equal(result.state, "applied");
	assert.equal(result.revision, snap(home).revision);
	for (const [key, value] of Object.entries(SET)) assert.deepEqual(view(result.snapshot!, key as SettingKey), { key, value, source: "file", status: "ok" }, key);
	assert.deepEqual(json(home, "mandate-defaults"), { ...SCAFFOLD_MANDATE_DEFAULTS, job_cap: 7 }, "notes and every other key kept");
	assert.deepEqual(json(home, "budgets"), { ...DEFAULT_BUDGET_CONFIG, cumulative_cost_usd: 5, spawn_cap: 5 });
	assert.deepEqual(json(home, "operator"), { compact_at_tokens: 400, handoffs_dir: "/tmp/handoffs" });
	assert.deepEqual(json(home, "quality"), { model: "anthropic/claude-haiku", verify: true });
	assert.deepEqual(json(home, "capacity"), { ...CAPACITY, quota: { five_hour: 70 } });
	assert.deepEqual(json(home, "update"), { enabled: true, interval_min: 30 });
	assert.deepEqual(json(home, "gate"), { schema_version: 1, review_timeout_ms: 60_000 });
	assert.equal(readFileSync(file(home, "gate"), "utf8"), `${JSON.stringify({ schema_version: 1, review_timeout_ms: 60_000 }, null, 2)}\n`);
	const again = apply(home, { mode: "set", changes: SET });
	assert.deepEqual([again.status, again.state], [200, "unchanged"], "the same values again write nothing");
});

test("restore table: RESTORE_ACTIONS is pinned; restore all deletes or writes per key and reads back every default", (t) => {
	assert.deepEqual(RESTORE_ACTIONS, {
		...Object.fromEntries(SETTING_FIELDS.filter((field) => field.owner === "mandate-defaults" || field.owner === "budgets").map((field) => [field.key, "default"])),
		"sessions.wall_clock_seconds": "default",
		"sessions.parent_compact_at_tokens": "default",
		"sessions.operator_compact_at_tokens": "delete",
		"models.rubric": "shipped_rubric",
		"models.parent": "delete",
		"models.operator": "delete",
		"review.timeout_ms": "delete",
		"review.quality_verify": "delete",
		"review.quality_completeness": "delete",
		"review.quality_voters": "delete",
		"review.quality_threshold": "delete",
		"capacity.five_hour": "delete",
		"capacity.seven_day": "delete",
		"capacity.balance_margin": "delete",
		"maintenance.update_enabled": "installer_seed",
		"maintenance.update_interval_min": "installer_seed",
	});
	assert.deepEqual(Object.keys(RESTORE_ACTIONS).sort(), SETTING_FIELDS.filter((field) => field.editable).map((field) => field.key).sort(), "every editable key, nothing else");
	const home = fullHome(t);
	apply(home, { mode: "set", changes: { ...SET, "capacity.seven_day": 80, "grants.ask_on": [], "budgets.warn_ratio": 0.5 } });
	const result = apply(home, { mode: "restore", all: true });
	assert.equal(result.status, 200, JSON.stringify(result));
	assert.equal(result.state, "applied");
	assert.deepEqual(json(home, "mandate-defaults"), SCAFFOLD_MANDATE_DEFAULTS);
	assert.deepEqual(json(home, "budgets"), { ...DEFAULT_BUDGET_CONFIG, cumulative_cost_usd: 5 });
	assert.deepEqual(json(home, "worker-bounds"), { wall_clock_seconds: 5400 });
	assert.deepEqual(json(home, "parent"), { compact_at_tokens: 200000 });
	assert.deepEqual(json(home, "operator"), { handoffs_dir: "/tmp/handoffs" });
	assert.deepEqual(json(home, "gate"), { schema_version: 1 });
	assert.deepEqual(json(home, "quality"), { model: "anthropic/claude-haiku" });
	assert.deepEqual(json(home, "capacity"), CAPACITY, "an emptied quota goes too");
	assert.deepEqual(json(home, "update"), { enabled: false }, "not an installed home: the catalog default, interval deleted");
	for (const field of SETTING_FIELDS.filter((row) => row.editable)) assert.deepEqual(view(result.snapshot!, field.key)?.value, field.default, field.key);
	const changes = result.changes!.map((change) => [change.key, change.action]);
	assert.ok(changes.some(([key, action]) => key === "review.timeout_ms" && action === "delete"));
	assert.ok(changes.some(([key, action]) => key === "sessions.parent_compact_at_tokens" && action === "set"));
});

test("restore maintenance on an installed home: the installer seed (enabled true, interval 15), shown by dry run; otherwise false", (t) => {
	const installed = scratch(t);
	writeFileSync(join(installed, LAYOUT.data, "daemon.json"), JSON.stringify({ schema_version: 1, generated_by: "cp-install" }));
	put(installed, "update", { enabled: false, interval_min: 40 });
	const before = listing(installed);
	const preview = applySettings(installed, { request: { mode: "restore", section: "maintenance" }, expected_revision: null, dry_run: true, request_id: "req-12345678", peer: null, actor: "dashboard", env: {} });
	assert.equal(preview.state, "planned");
	assert.deepEqual(preview.changes!.map((change) => [change.key, change.action, change.old, change.new]), [
		["maintenance.update_enabled", "set", false, INSTALLER_UPDATE_SEED.enabled],
		["maintenance.update_interval_min", "set", 40, INSTALLER_UPDATE_SEED.interval_min],
	]);
	assert.deepEqual(listing(installed), before, "a dry run writes nothing");
	assert.equal(apply(installed, { mode: "restore", keys: ["maintenance.update_enabled", "maintenance.update_interval_min"] }).state, "applied");
	assert.deepEqual(json(installed, "update"), { enabled: true, interval_min: 15 });

	const plain = scratch(t);
	put(plain, "update", { enabled: true, interval_min: 40 });
	const result = apply(plain, { mode: "restore", section: "maintenance" });
	assert.deepEqual(result.changes!.map((change) => [change.key, change.action, change.new]), [["maintenance.update_enabled", "set", false], ["maintenance.update_interval_min", "delete", 15]]);
	assert.deepEqual(json(plain, "update"), { enabled: false });

	writeFileSync(join(plain, LAYOUT.data, "daemon.json"), "{nope");
	const unreadable = apply(plain, { mode: "restore", keys: ["maintenance.update_enabled"] });
	assert.equal(unreadable.status, 409, "an unreadable daemon.json is a refusal, never a guess");
	assert.match(unreadable.error ?? "", /daemon\.json is not valid JSON/);
});

test("restore on an absent owner creates nothing; section/all skip non-editable fields; naming one is 403", (t) => {
	const home = scratch(t);
	const before = listing(home);
	for (const request of [{ mode: "restore", all: true }, { mode: "restore", section: "models" }, { mode: "restore", keys: ["review.timeout_ms"] }] as SettingsWriteRequest[]) {
		const result = apply(home, request);
		assert.deepEqual([result.status, result.state], [200, "unchanged"], JSON.stringify(request));
	}
	assert.deepEqual(listing(home), before, "no owner file, no audit line, no lock left behind");
	for (const request of [{ mode: "restore", keys: ["models.allow"] }, { mode: "set", changes: { "sessions.tool_call_cap": 5 } }, { mode: "set", changes: { "models.allow": ["*/*"] } }] as SettingsWriteRequest[]) {
		assert.equal(apply(home, request).status, 403, JSON.stringify(request));
	}
	assert.equal(apply(home, { mode: "restore", section: "nope" }).status, 400);
});

test("absent bases: set on absent update.json is {enabled:false, interval_min} at 0600; absent mandate-defaults is the scaffold; absent capacity is 409", (t) => {
	const home = scratch(t);
	const result = apply(home, { mode: "set", changes: { "maintenance.update_interval_min": 20, "grants.job_cap": 4 } });
	assert.equal(result.state, "applied", JSON.stringify(result));
	assert.deepEqual(json(home, "update"), { enabled: false, interval_min: 20 });
	assert.equal(statSync(file(home, "update")).mode & 0o777, 0o600);
	assert.deepEqual(json(home, "mandate-defaults"), { ...SCAFFOLD_MANDATE_DEFAULTS, job_cap: 4 });
	const capacity = apply(home, { mode: "set", changes: { "capacity.five_hour": 50 } });
	assert.equal(capacity.status, 409);
	assert.match(capacity.error ?? "", /cp-install --gateway-url/);
	assert.equal(existsSync(file(home, "capacity")), false);
});

test("refusals: 412 stale with the fresh snapshot, 409 invalid owner with nothing written, 400 range with per-key errors, 428 without a revision", (t) => {
	const home = fullHome(t);
	const stale = apply(home, { mode: "set", changes: { "grants.job_cap": 9 } }, { expected_revision: "0".repeat(64) });
	assert.deepEqual([stale.status, stale.state], [412, "stale"]);
	assert.equal(stale.revision, snap(home).revision);
	assert.equal(stale.snapshot?.revision, stale.revision);
	assert.equal(json(home, "mandate-defaults").job_cap, 3);
	put(home, "budgets", "{nope");
	const before = listing(home);
	const invalid = apply(home, { mode: "set", changes: { "budgets.spawn_cap": 4 } });
	assert.equal(invalid.status, 409);
	assert.match(invalid.error ?? "", /by hand first/);
	assert.deepEqual(listing(home).filter((row) => !row.startsWith(relative(home, settingsAuditFile(home)))), before.filter((row) => !row.startsWith(relative(home, settingsAuditFile(home)))));
	const range = apply(home, { mode: "set", changes: { "grants.job_cap": 0, "review.timeout_ms": 5 } });
	assert.equal(range.status, 400);
	assert.equal(range.errors?.length, 2);
	assert.ok(range.errors?.every((error) => /^(grants\.job_cap|review\.timeout_ms): /.test(error)));
	assert.equal(apply(home, { mode: "set", changes: { "nope.key": 1 } }).status, 400);
	assert.equal(apply(home, { mode: "set", changes: { "grants.job_cap": 2 } }, { expected_revision: null }).status, 428);
	const refused = audit(home).filter((line) => line.type === "refused");
	assert.deepEqual(refused.map((line) => line.status), [412, 409, 400, 400], "every refusal after the lock is one refused line");
});

test("dry run: planned changes, no file or mtime changes and no audit line", (t) => {
	const home = fullHome(t);
	const before = listing(home);
	const result = applySettings(home, { request: { mode: "set", changes: { "grants.job_cap": 5 } }, expected_revision: null, dry_run: true, request_id: "req-12345678", peer: null, actor: "dashboard", env: {} });
	assert.deepEqual([result.status, result.state], [200, "planned"]);
	assert.deepEqual(result.changes, [{ key: "grants.job_cap", file_key: "job_cap", action: "set", old: 3, old_source: "file", new: 5 }]);
	assert.deepEqual(listing(home), before);
});

test("ordering: an intent append failure is 503 and no owner byte changes", (t) => {
	const home = fullHome(t);
	const before = listing(home);
	const result = apply(home, { mode: "set", changes: { "grants.job_cap": 5 } }, {}, { append: () => { throw new Error("disk full"); } });
	assert.equal(result.status, 503);
	assert.match(result.error ?? "", /audit unwritable; nothing written/);
	assert.deepEqual(listing(home), before);
});

test("failures: a write failure on a later owner rolls earlier owners back (a created file unlinked); a read-back mismatch rolls back all", (t) => {
	const home = fullHome(t);
	const gateBefore = readFileSync(file(home, "gate"));
	const bounds = file(home, "worker-bounds");
	rmSync(bounds);
	let calls = 0;
	const failing: SettingsWriteSeams = {
		writeText: (target, text, options) => {
			calls++;
			if (target === file(home, "quality")) throw new Error(`EIO writing ${target}`);
			writeFileSync(target, text, { mode: options.mode });
		},
	};
	const result = apply(home, { mode: "set", changes: { "sessions.wall_clock_seconds": 60, "review.timeout_ms": 60_000, "review.quality_voters": 2 } }, {}, failing);
	assert.deepEqual([result.status, result.state], [500, "failed"]);
	assert.equal(calls, 3);
	assert.ok(!(result.error ?? "").includes(home), "the home path is redacted");
	assert.equal(existsSync(bounds), false, "the file this transaction created is gone");
	assert.ok(readFileSync(file(home, "gate")).equals(gateBefore), "the existing owner is byte-identical");
	const failed = audit(home).at(-1)!;
	assert.equal(failed.type, "failed");
	assert.deepEqual((failed.rolled_back as Array<{ owner: string; ok: boolean }>).map((row) => [row.owner, row.ok]), [["worker-bounds", true], ["gate", true], ["quality", true]]);

	const snapshots: SettingsWriteSeams = {
		readBack: (target, env) => {
			const read = readSettings(target, env);
			return { ...read, fields: read.fields.map((row) => row.key === "grants.job_cap" ? { ...row, value: 1 } : row) };
		},
	};
	const mandateBefore = readFileSync(file(home, "mandate-defaults"));
	const mismatch = apply(home, { mode: "set", changes: { "grants.job_cap": 6, "review.timeout_ms": 90_000 } }, {}, snapshots);
	assert.deepEqual([mismatch.status, mismatch.state], [500, "failed"]);
	assert.match(mismatch.error ?? "", /read-back disagrees: grants\.job_cap/);
	assert.ok(readFileSync(file(home, "mandate-defaults")).equals(mandateBefore));
	assert.ok(readFileSync(file(home, "gate")).equals(gateBefore));
});

test("crash recovery: a dangling intent is recorded once as recovered, per owner; a non-JSON last line is 503", (t) => {
	const home = fullHome(t);
	const warned = apply(home, { mode: "set", changes: { "grants.job_cap": 5 } }, {}, {
		append: (target, text) => { if (text.includes('"type":"applied"')) throw new Error("ENOSPC"); writeFileSync(target, text, { flag: "a", mode: 0o600 }); },
	});
	assert.deepEqual([warned.status, warned.state], [200, "applied"]);
	assert.match(warned.audit_warning ?? "", /recorded as recovered|records it as recovered/);
	assert.equal(audit(home).at(-1)?.type, "intent");
	const next = apply(home, { mode: "set", changes: { "budgets.spawn_cap": 6 } });
	assert.equal(next.state, "applied");
	const recovered = audit(home).filter((line) => line.type === "recovered");
	assert.equal(recovered.length, 1);
	assert.deepEqual(recovered[0]!.owners, [{ owner: "mandate-defaults", state: "applied" }]);
	apply(home, { mode: "set", changes: { "budgets.spawn_cap": 7 } });
	assert.equal(audit(home).filter((line) => line.type === "recovered").length, 1, "a second apply adds none");

	// A crash between the intent and the rename: not_written; a hand edit since: changed_since.
	const gate = readFileSync(file(home, "gate"));
	const intent = { v: 1, type: "intent", id: "st-20260101000000-deadbeef", at: "2026-01-01T00:00:00Z", actor: "dashboard", peer: null, request_id: "req-12345678", mode: "set", base_revision: "0".repeat(64), writes: [
		{ owner: "gate", path: OWNER_FILE.gate, prior_sha256: sha(gate), next_sha256: "1".repeat(64), changes: [] },
		{ owner: "quality", path: OWNER_FILE.quality, prior_sha256: "2".repeat(64), next_sha256: "3".repeat(64), changes: [] },
	] };
	writeFileSync(settingsAuditFile(home), `${JSON.stringify(intent)}\n`, { flag: "a" });
	apply(home, { mode: "set", changes: { "budgets.spawn_cap": 8 } }, { expected_revision: "0".repeat(64) });
	const lines = audit(home);
	assert.deepEqual(lines.at(-2), { v: 1, type: "recovered", id: intent.id, at: lines.at(-2)!.at, owners: [{ owner: "gate", state: "not_written" }, { owner: "quality", state: "changed_since" }] });
	assert.equal(lines.at(-1)?.status, 412, "recovery runs before the revision check");

	writeFileSync(settingsAuditFile(home), "{torn", { flag: "a" });
	const torn = apply(home, { mode: "set", changes: { "budgets.spawn_cap": 9 } });
	assert.equal(torn.status, 503);
	assert.match(torn.error ?? "", /not JSON/);
});

test("a held lock is 409 with nothing written", (t) => {
	const home = fullHome(t);
	const lock = acquireSettingsLock(home);
	assert.ok(lock.ok);
	t.after(() => lock.release());
	const result = apply(home, { mode: "set", changes: { "grants.job_cap": 5 } });
	assert.deepEqual([result.status, result.state], [409, "refused"]);
	assert.match(result.error ?? "", /another settings write holds <home>/);
	assert.equal(json(home, "mandate-defaults").job_cap, 3);
});

test("audit journal: 0600, actor dashboard, peer, request_id and old→new; no url, path, key or home in any line", (t) => {
	const home = fullHome(t);
	apply(home, { mode: "set", changes: { "capacity.five_hour": 60, "grants.job_cap": 4 } }, { env: { CP_GATEWAY_ADMIN_KEY: "sk-test-secret" } });
	apply(home, { mode: "restore", section: "capacity" }, { env: { CP_GATEWAY_ADMIN_KEY: "sk-test-secret" } });
	assert.equal(statSync(settingsAuditFile(home)).mode & 0o777, 0o600);
	const lines = audit(home);
	assert.deepEqual(lines.map((line) => line.type), ["intent", "applied", "intent", "applied"]);
	const intent = lines[0] as { actor: string; peer: string; request_id: string; writes: Array<{ owner: string; changes: Array<{ key: string; old: unknown; new: unknown; action: string }> }> };
	assert.deepEqual([intent.actor, intent.peer, intent.request_id], ["dashboard", "100.64.0.1", "req-12345678"]);
	assert.deepEqual(intent.writes.map((write) => [write.owner, write.changes.map((change) => [change.key, change.old, change.new, change.action])]), [
		["mandate-defaults", [["grants.job_cap", 3, 4, "set"]]],
		["capacity", [["capacity.five_hour", 90, 60, "set"]]],
	]);
	const text = readFileSync(settingsAuditFile(home), "utf8");
	for (const secret of ["sk-test-secret", "secret-gateway", "/v1/secret-path", home]) assert.ok(!text.includes(secret), `audit leaks ${secret}`);
});

test("Settings writes preserve the hand-added PR3 policy keys (cp-7re9)", (t) => {
	const home = scratch(t);
	const policy = { scope_policy: "named_jobs_only", deny_projects: ["demo"] };
	put(home, "worker-bounds", { wall_clock_seconds: 100, allow_dispatch_override: false });
	put(home, "mandate-defaults", { ...SCAFFOLD_MANDATE_DEFAULTS, ...policy });
	const owners = (home: string) => Object.fromEntries(snap(home).owners.map((owner) => [owner.owner, owner.state]));
	assert.deepEqual([owners(home)["worker-bounds"], owners(home)["mandate-defaults"]], ["valid", "valid"]);
	const set = apply(home, { mode: "set", changes: { "sessions.wall_clock_seconds": 200, "grants.job_cap": 7 } });
	assert.deepEqual([set.status, set.state], [200, "applied"], JSON.stringify(set));
	assert.deepEqual(json(home, "worker-bounds"), { wall_clock_seconds: 200, allow_dispatch_override: false });
	assert.deepEqual(json(home, "mandate-defaults"), { ...SCAFFOLD_MANDATE_DEFAULTS, job_cap: 7, ...policy });
	const restore = apply(home, { mode: "restore", all: true });
	assert.deepEqual([restore.status, restore.state], [200, "applied"], JSON.stringify(restore));
	assert.deepEqual(json(home, "worker-bounds"), { wall_clock_seconds: 5400, allow_dispatch_override: false });
	assert.deepEqual(json(home, "mandate-defaults"), { ...SCAFFOLD_MANDATE_DEFAULTS, ...policy });

	// A flag-only file is a valid owner; a set adds the field beside the flag.
	const flagOnly = scratch(t);
	put(flagOnly, "worker-bounds", { allow_dispatch_override: false });
	assert.equal(owners(flagOnly)["worker-bounds"], "valid");
	const added = apply(flagOnly, { mode: "set", changes: { "sessions.wall_clock_seconds": 200 } });
	assert.equal(added.status, 200, JSON.stringify(added));
	assert.deepEqual(json(flagOnly, "worker-bounds"), { allow_dispatch_override: false, wall_clock_seconds: 200 });

	// A non-boolean flag makes the owner invalid: the write is refused and the bytes stay.
	const broken = scratch(t);
	put(broken, "worker-bounds", { allow_dispatch_override: "no" });
	const before = readFileSync(file(broken, "worker-bounds"));
	const refused = apply(broken, { mode: "set", changes: { "sessions.wall_clock_seconds": 200 } });
	assert.equal(refused.status, 409, JSON.stringify(refused));
	assert.deepEqual(readFileSync(file(broken, "worker-bounds")), before);
});

test("models.parent/models.operator: set into an absent file keeps parent compaction on; null unsets; restore deletes; bad refs are 400", (t) => {
	const home = scratch(t);
	const set = apply(home, { mode: "set", changes: { "models.parent": "anthropic/claude-opus-5-5", "models.operator": "openai/gpt-5" } });
	assert.deepEqual([set.status, set.state], [200, "applied"], JSON.stringify(set));
	assert.deepEqual(json(home, "parent"), { compact_at_tokens: 200000, model: "anthropic/claude-opus-5-5" }, "the absent-file threshold is written beside the model");
	assert.deepEqual(json(home, "operator"), { model: "openai/gpt-5" });
	assert.deepEqual(view(set.snapshot!, "models.parent"), { key: "models.parent", value: "anthropic/claude-opus-5-5", source: "file", status: "ok" });
	assert.deepEqual(view(set.snapshot!, "sessions.parent_compact_at_tokens"), { key: "sessions.parent_compact_at_tokens", value: 200000, source: "file", status: "ok" });
	assert.equal(set.snapshot!.owners.find((row) => row.owner === "parent")?.state, "valid");

	// Unset with an env pin present: the key goes, never a stored null, and the read-back is the pin.
	const unset = apply(home, { mode: "set", changes: { "models.parent": null } }, { env: { CP_PARENT_MODEL: "env/parent" } });
	assert.deepEqual([unset.status, unset.state], [200, "applied"], JSON.stringify(unset));
	assert.deepEqual(json(home, "parent"), { compact_at_tokens: 200000 });
	assert.deepEqual(unset.changes!.map((change) => [change.key, change.action, change.new]), [["models.parent", "delete", null]]);
	assert.deepEqual(view(unset.snapshot!, "models.parent"), { key: "models.parent", value: "env/parent", source: "env", status: "ok" });
	assert.deepEqual([apply(home, { mode: "set", changes: { "models.parent": null } }).state], ["unchanged"]);

	const restored = apply(home, { mode: "restore", keys: ["models.parent", "models.operator"] });
	assert.deepEqual([restored.status, restored.state], [200, "applied"], JSON.stringify(restored));
	assert.deepEqual(json(home, "operator"), {});
	for (const value of ["nope", "a b/c", "", 5]) {
		const bad = apply(home, { mode: "set", changes: { "models.operator": value } });
		assert.equal(bad.status, 400, JSON.stringify(value));
		assert.match(bad.errors?.[0] ?? "", /^models\.operator: /);
	}
});

const RUBRIC = [
	{ id: "risky", role: "researcher", risk: "high", model: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt-6.1-sol"], thinking: "xhigh", note: "legacy role word" },
	{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-opus-5-5" },
	{ id: "custom", role: "implementer", project: "demo", scope: ["S"], model: "openai/gpt-5", fallbacks: ["anthropic/claude-haiku"] },
];
const ROUTING_DOC = { schema_version: 1, allow: ["anthropic/*", "openai/*"], deny_by_role: { implementer: ["openai/gpt-4*"] }, rubric: RUBRIC };
const routingFile = (home: string) => join(home, LAYOUT.routingFile);
const routing = (home: string) => JSON.parse(readFileSync(routingFile(home), "utf8"));

test("models.rubric set: only model, fallbacks and thinking change in place; legacy roles, allow and deny_by_role survive", (t) => {
	const home = scratch(t);
	writeFileSync(routingFile(home), JSON.stringify(ROUTING_DOC));
	const rows = structuredClone(view(snap(home), "models.rubric")!.value) as Array<Record<string, unknown>>;
	assert.equal(rows[0]!.role, "planner", "the snapshot shows the legacy word mapped forward");
	rows[0]!.model = "openai/gpt-6.1-sol";
	rows[0]!.fallbacks = [];
	rows[1]!.thinking = "high";
	rows[1]!.fallbacks = ["openai/gpt-6.1-sol"];
	delete rows[2]!.fallbacks;
	const result = apply(home, { mode: "set", changes: { "models.rubric": rows } });
	assert.deepEqual([result.status, result.state], [200, "applied"], JSON.stringify(result));
	assert.deepEqual(routing(home), {
		...ROUTING_DOC,
		rubric: [
			{ id: "risky", role: "researcher", risk: "high", model: "openai/gpt-6.1-sol", thinking: "xhigh", note: "legacy role word" },
			{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-opus-5-5", thinking: "high", fallbacks: ["openai/gpt-6.1-sol"] },
			{ id: "custom", role: "implementer", project: "demo", scope: ["S"], model: "openai/gpt-5" },
		],
	});
	assert.equal(view(result.snapshot!, "models.rubric")?.source, "file");
	assert.deepEqual([apply(home, { mode: "set", changes: { "models.rubric": view(snap(home), "models.rubric")!.value } }).state], ["unchanged"]);

	const before = readFileSync(routingFile(home));
	const fixed = structuredClone(view(snap(home), "models.rubric")!.value) as Array<Record<string, unknown>>;
	fixed[1]!.role = "implementer";
	fixed[2]!.note = "edited";
	const immutable = apply(home, { mode: "set", changes: { "models.rubric": fixed } });
	assert.equal(immutable.status, 400, JSON.stringify(immutable));
	assert.deepEqual(immutable.errors, ["row reviews: only model, fallbacks and thinking may change", "row custom: only model, fallbacks and thinking may change"]);
	const current = view(snap(home), "models.rubric")!.value as Array<Record<string, unknown>>;
	const reordered = apply(home, { mode: "set", changes: { "models.rubric": [current[1], current[0], current[2]] } });
	assert.equal(reordered.status, 400);
	assert.deepEqual(reordered.errors, ["row risky: only model, fallbacks and thinking may change", "row reviews: only model, fallbacks and thinking may change"]);
	const shorter = apply(home, { mode: "set", changes: { "models.rubric": current.slice(0, 2) } });
	assert.equal(shorter.status, 400);
	assert.match(shorter.errors?.[0] ?? "", /2 rows sent for 3/);
	assert.equal(apply(home, { mode: "set", changes: { "models.rubric": [{ ...current[0], model: "" }, current[1], current[2]] } }).status, 400, "schema-invalid rows never reach the merge");
	assert.ok(readFileSync(routingFile(home)).equals(before), "every refusal leaves the bytes");
	assert.throws(() => mergeRubric(RUBRIC, [{ ...RUBRIC[0], role: "planner", id: "other" }]), /only model, fallbacks and thinking/);
});

test("models.rubric restore: the shipped model/fallbacks/thinking per matching row id; other rows untouched; absent routing.json is 409 / no-op", (t) => {
	const home = scratch(t);
	const template = { schema_version: 1, allow: ["*/*"], rubric: [
		{ id: "risky", role: "planner", risk: "high", model: "anthropic/claude-opus-5-5", thinking: "high" },
		{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-sonnet-5-5", fallbacks: ["openai/gpt-6.1-sol"] },
		{ id: "shipped-only", role: "implementer", model: "anthropic/claude-haiku" },
	] };
	writeFileSync(routingFile(home), JSON.stringify(ROUTING_DOC));
	const seams: SettingsWriteSeams = { shippedRouting: () => template };
	const result = apply(home, { mode: "restore", keys: ["models.rubric"] }, {}, seams);
	assert.deepEqual([result.status, result.state], [200, "applied"], JSON.stringify(result));
	assert.deepEqual(routing(home).rubric, [
		{ id: "risky", role: "researcher", risk: "high", model: "anthropic/claude-opus-5-5", thinking: "high", note: "legacy role word" },
		{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-sonnet-5-5", fallbacks: ["openai/gpt-6.1-sol"] },
		RUBRIC[2],
	], "fallbacks the template lacks are deleted; the hand-added row stays; a template-only row is not added");
	assert.deepEqual(routing(home).deny_by_role, ROUTING_DOC.deny_by_role);
	assert.deepEqual(restoreShippedRubric([{ id: "x", role: "planner", model: "a/b" }], template), [{ id: "x", role: "planner", model: "a/b" }]);

	const unreadable = apply(home, { mode: "restore", keys: ["models.rubric"] }, {}, { shippedRouting: () => { throw new Error("ENOENT"); } });
	assert.equal(unreadable.status, 409);
	assert.match(unreadable.error ?? "", /shipped routing defaults .* unreadable/);

	// The real shipped template: an edited copy of it restores to the file byte-for-byte in value.
	const shipped = JSON.parse(readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"));
	const edited = structuredClone(shipped);
	edited.rubric[0].model = "openai/gpt-5";
	delete edited.rubric[1].fallbacks;
	edited.rubric[2].thinking = "low";
	writeFileSync(routingFile(home), JSON.stringify(edited));
	const real = apply(home, { mode: "restore", section: "models" });
	assert.deepEqual([real.status, real.state], [200, "applied"], JSON.stringify(real));
	assert.deepEqual(routing(home), shipped);

	const absent = scratch(t);
	const before = listing(absent);
	const refused = apply(absent, { mode: "set", changes: { "models.rubric": [] } });
	assert.equal(refused.status, 409);
	assert.match(refused.error ?? "", /routing\.json is absent: worker routing uses each profile's model/);
	assert.deepEqual([apply(absent, { mode: "restore", keys: ["models.rubric"] }).state], ["unchanged"]);
	assert.equal(existsSync(routingFile(absent)), false);
	assert.deepEqual(listing(absent).filter((row) => !row.startsWith(relative(absent, settingsAuditFile(absent)))), before);
});
