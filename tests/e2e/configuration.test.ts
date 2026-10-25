/**
 * Behavior 14 (configuration), P16: a parent's first session on a scratch home, its mode resolution, the br_id state
 * sweep, USER.md delivery and /doctor's home, storage and migration findings, through real pi parents loaded from a
 * copy of this package (so a parent with no CP_HOME never resolves this checkout as its home).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { type DoctorReport, LAYOUT } from "../../src/contracts.ts";
import { Ledger } from "../../src/ledger.ts";
import { MandateStore } from "../../src/mandate.ts";
import { JOB_ID_MIGRATION_MARKER } from "../../src/state-migrations.ts";
import { createViewer } from "../../src/viewer/server.ts";
import { resolveStateDir } from "../../src/viewer/sessions.ts";
import {
	type AgentDir,
	advanceBase,
	createAgentDir,
	createScratchRepo,
	git,
	MockProvider,
	type MockToolCall,
	type PiChild,
	REPO_ROOT,
	type RpcRecord,
	type ScratchRepo,
	type ScriptStep,
	startPiChild,
} from "../harness/index.ts";

type Finding = DoctorReport["findings"][number];

interface Rig {
	root: string;
	app: string;
	ext: string;
	remote: string;
	provider: MockProvider;
	agent: AgentDir;
	t: TestContext;
}

let scripts = 0;

/** A scratch root holding this checkout's files committed at `.pi-command-post/app` with a bare origin. */
async function rig(t: TestContext, prefix: string): Promise<Rig> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	t.after(async () => {
		agent.cleanup();
		await provider.stop();
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	});
	const app = join(root, ".pi-command-post", "app");
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
	for (const file of files.split("\0").filter((entry) => entry && existsSync(join(REPO_ROOT, entry)))) {
		mkdirSync(dirname(join(app, file)), { recursive: true });
		copyFileSync(join(REPO_ROOT, file), join(app, file));
	}
	git(app, "init", "-b", "main", "--quiet");
	git(app, "add", "-A");
	git(app, "commit", "-m", "package", "--quiet");
	const remote = join(root, "origin.git");
	git(root, "init", "--bare", "-b", "main", "--quiet", remote);
	git(app, "remote", "add", "origin", remote);
	git(app, "push", "--quiet", "-u", "origin", "main");
	return { root, app, ext: join(app, "extensions/command-post/index.ts"), remote, provider, agent, t };
}

/** A parent pi on this rig's package; `steps` script its model. Closed when the test ends. */
function open(r: Rig, cwd: string, env: NodeJS.ProcessEnv, steps?: ScriptStep[], ext = r.ext): PiChild {
	const model = steps ? r.provider.addScript(`p16-${(scripts += 1)}`, steps) : undefined;
	if (steps) r.agent.writeModels(r.provider);
	const child = startPiChild({ cwd, ...(model ? { model } : {}), extensions: [ext], env: { ...r.agent.env, CP_HOME: "", CP_MODE: "", ...env } });
	r.t.after(() => child.close());
	return child;
}

const notes = (session: PiChild, from = 0): string[] =>
	session.records().slice(from).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));

/** Send a slash command and wait for the notify that answers it. */
async function command(session: PiChild, message: string, answer: (text: string) => boolean): Promise<string> {
	const from = session.records().length;
	session.send({ id: `c${from}`, type: "prompt", message });
	const isAnswer = (r: RpcRecord) => r.type === "extension_ui_request" && r.method === "notify" && answer(String(r.message));
	await session.waitFor((r) => session.records().indexOf(r) >= from && isAnswer(r), 120_000);
	return notes(session, from).find(answer)!;
}

const version = (session: PiChild) => command(session, "/cp-version", (text) => text.startsWith("picp "));
const doctor = async (session: PiChild) => JSON.parse(await command(session, "/doctor --json", (text) => text.trimStart().startsWith("{"))) as DoctorReport;
const finding = (report: DoctorReport, check: string): Finding | undefined => report.findings.find((f) => f.check === check);

/** `turns` model turns that each call cp_next once (the first also calls `extra`), then answer "done". */
const nextTurns = (turns: number, extra: MockToolCall[] = []): ScriptStep[] =>
	Array.from({ length: turns }, (_, i): ScriptStep[] => [
		{ kind: "tool_calls", calls: [{ id: `n${i}`, name: "cp_next", args: {} }, ...(i === 0 ? extra : [])] },
		{ kind: "text", text: "done" },
	]).flat();

/** Prompt the next scripted turn and return what its cp_next call answered. */
async function askNext(session: PiChild): Promise<string> {
	const from = session.records().length;
	await session.prompt("what next?");
	const isNext = (r: RpcRecord) => r.type === "tool_execution_end" && r.toolName === "cp_next";
	const end = await session.waitFor((r) => session.records().indexOf(r) >= from && isNext(r), 120_000);
	await session.waitFor((r) => session.records().indexOf(r) >= from && r.type === "agent_end", 120_000);
	return JSON.stringify(end.result);
}

/** One parent's whole life: start, /cp-version (startup notices precede it), then close. */
async function launch(r: Rig, cwd: string, env: NodeJS.ProcessEnv, ext = r.ext): Promise<{ version: string; notes: string[] }> {
	const session = open(r, cwd, env, undefined, ext);
	try {
		const line = await version(session);
		return { version: line, notes: notes(session) };
	} finally {
		await session.close();
	}
}

/** The pre-rename state a home written before the br_id -> job_id sweep holds, plus what the sweep must leave alone. */
function seedLegacy(home: string): void {
	const put = (relative: string, text: string) => {
		mkdirSync(dirname(join(home, relative)), { recursive: true });
		writeFileSync(join(home, relative), text);
	};
	put(`${LAYOUT.checkpoints}/cp-a.json`, JSON.stringify({ br_id: "cp-a", decision: "pending", list: [{ br_id: "cp-b" }, "br_id"] }));
	put(`${LAYOUT.runs}/cp-a/status.json`, JSON.stringify({ br_id: "cp-a", phase: "working", deep: { x: { br_id: null } } }));
	put(`${LAYOUT.runs}/cp-a/gate-1/verdict.json`, JSON.stringify({ br_id: "cp-a", verdict: "pass" }));
	put(`${LAYOUT.runs}/cp-a/events.jsonl`, [
		JSON.stringify({ seq: 1, br_id: "cp-a", type: "spawned", payload: { br_id: "cp-a" } }),
		"this line is not json {",
		JSON.stringify({ seq: 2, br_id: "cp-a", type: "text", payload: { text: "the string br_id stays" } }),
		"",
	].join("\n"));
	put(`${LAYOUT.runs}/cp-x/status.json`, '{"br_id": "cp-x", broken');
	put(`${LAYOUT.sessions}/2026-09-01.jsonl`, JSON.stringify({ br_id: "cp-a" }));
	put(`${LAYOUT.awaitingFile}.bak-1`, JSON.stringify({ br_id: "cp-a" }));
	put(`${LAYOUT.runs}/cp-a/brief.md`, "Job br_id cp-a");
}

// P16-scaffold: scaffold.test.ts and layout-flat.test.ts through first sessions; a refused prefix writes no ledger.
test("P16-scaffold: a first session scaffolds a fresh home once, an operator's own files and an existing ledger are never rewritten, and a bad CP_LEDGER_PREFIX writes no ledger", { timeout: 300_000 }, async (t) => {
	const r = await rig(t, "cp-p16-scaffold-");
	const { root, app } = r;
	const fresh = join(root, "fresh");
	const first = await launch(r, root, { CP_HOME: fresh, CP_LEDGER_PREFIX: "   " });
	const announced = first.notes.find((text) => text.startsWith("command post home"));
	assert.ok(announced, first.notes.join("\n"));
	const steps = announced.split("\n").slice(1).map((line) => line.trim());
	assert.deepEqual(steps.map((line) => line.replace(/ — .*$/, "")), [
		"+ dir.runtime: created", "+ dir.data: created", "+ dir.state: created", "+ dir.projects: created",
		"+ gitignore: created", "+ routing.default: created", "+ mandate-defaults: created", "+ ledger: created",
	]);
	assert.match(announced, /^command post home \(CP_HOME\): /);
	assert.match(first.version, new RegExp(`^picp \\d+\\.\\d+\\.\\d+ \\(root: ${app}`), "the version names this package and its root");
	assert.match(readFileSync(join(fresh, ".gitignore"), "utf8"), /^\.pi-command-post\/$/m);
	assert.deepEqual(JSON.parse(readFileSync(join(fresh, LAYOUT.jobsFile), "utf8")), { schema_version: 1, prefix: "cp", jobs: [] }, "a blank prefix is cp");
	assert.deepEqual(JSON.parse(readFileSync(join(fresh, LAYOUT.routingFile), "utf8")), JSON.parse(readFileSync(join(app, "defaults/routing.default.json"), "utf8")));
	assert.equal(existsSync(join(fresh, "USER.md")), false, "the scaffold never creates USER.md");
	const ledger = readFileSync(join(fresh, LAYOUT.jobsFile), "utf8");
	writeFileSync(join(fresh, "USER.md"), "# mine\nhands off\n");
	const second = await launch(r, root, { CP_HOME: fresh, CP_LEDGER_PREFIX: "cps" });
	assert.ok(!second.notes.some((text) => text.startsWith("command post home")), "a scaffolded home is not scaffolded again");
	assert.equal(readFileSync(join(fresh, LAYOUT.jobsFile), "utf8"), ledger, "an existing ledger keeps its prefix");
	assert.equal(readFileSync(join(fresh, "USER.md"), "utf8"), "# mine\nhands off\n", "an existing USER.md is never rewritten");

	const owned = join(root, "owned");
	mkdirSync(join(owned, LAYOUT.data), { recursive: true });
	writeFileSync(join(owned, ".gitignore"), "# mine\n");
	const mine = JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [] });
	writeFileSync(join(owned, LAYOUT.routingFile), mine);
	const prefixed = await launch(r, root, { CP_HOME: owned, CP_LEDGER_PREFIX: "cps" });
	const ownedSteps = prefixed.notes.find((text) => text.startsWith("command post home")) ?? "";
	assert.doesNotMatch(ownedSteps, /gitignore|routing\.default/, "present steps are not announced");
	assert.match(ownedSteps, /\+ ledger: created — .*prefix cps/);
	assert.equal(readFileSync(join(owned, ".gitignore"), "utf8"), "# mine\n");
	assert.equal(readFileSync(join(owned, LAYOUT.routingFile), "utf8"), mine);
	assert.equal(JSON.parse(readFileSync(join(owned, LAYOUT.jobsFile), "utf8")).prefix, "cps");

	for (const bad of ["CP", "1cp", "toolongprefix", "cp-x", "c p"]) {
		const home = join(root, `bad-${bad.replace(/\W/g, "_")}`);
		const refused = await launch(r, root, { CP_HOME: home, CP_LEDGER_PREFIX: bad });
		assert.match(refused.notes.find((text) => text.startsWith("command post home")) ?? "", /! ledger: failed — CP_LEDGER_PREFIX=.* is not a usable ledger prefix/, bad);
		assert.equal(existsSync(join(home, LAYOUT.jobsFile)), false, `no ledger for ${bad}`);
	}

	// The standard home: the package at ~/.pi-command-post/app scaffolds the flat home around it, never a nested dotdir.
	const standard = join(root, ".pi-command-post");
	const flat = await launch(r, join(app, "src"), { HOME: root });
	assert.match(flat.version, new RegExp(`multi-project mode, home ${standard} \\(source: standard; .*standard home`));
	assert.deepEqual((flat.notes.find((text) => text.startsWith("command post home")) ?? "").split("\n").slice(1).map((line) => line.trim().replace(/ — .*$/, "")), [
		"+ dir.data: created", "+ dir.state: created", "+ dir.projects: created", "+ routing.default: created", "+ mandate-defaults: created", "+ ledger: created",
	]);
	for (const absent of [".pi-command-post", ".gitignore"]) assert.equal(existsSync(join(standard, absent)), false, `a flat home has no ${absent}`);
	assert.equal(existsSync(join(app, ".pi-command-post")), false, "app/ is never a home");
	const other = join(root, "other");
	assert.match((await launch(r, join(app, "src"), { HOME: root, CP_HOME: other })).version, new RegExp(`home ${other} \\(source: CP_HOME`));
	const relaunched = await launch(r, join(app, "src"), { HOME: root });
	assert.ok(!relaunched.notes.some((text) => text.startsWith("command post home")), "a flat home is scaffolded once");

	rmSync(join(app, "defaults", "routing.default.json"));
	const bare = await launch(r, root, { CP_HOME: join(root, "bare") });
	assert.match(bare.notes.find((text) => text.startsWith("command post home")) ?? "", /· routing\.default: skipped — no shipped default at /);
	assert.equal(existsSync(join(root, "bare", LAYOUT.routingFile)), false);
	assert.ok(existsSync(join(root, "bare", LAYOUT.jobsFile)), "a skipped default fails nothing else");

	// A package with no manifest fails closed: /cp-version names the file instead of printing an identity.
	rmSync(join(app, "package.json"));
	const unnamed = open(r, root, { CP_HOME: join(root, "bare") });
	unnamed.send({ id: "unnamed", type: "prompt", message: "/cp-version" });
	const refused = await unnamed.waitFor((record) => JSON.stringify(record).includes("cannot read"), 120_000);
	assert.match(JSON.stringify(refused), new RegExp(`pi-command-post: cannot read ${join(app, "package.json")}: ENOENT`));
	assert.ok(!notes(unnamed).some((text) => text.startsWith("picp ")), "no identity is invented");
});

// P16-mode: mode.test.ts through /cp-version: every source of the mode, every refusal, nothing scaffolded on refusal.
test("P16-mode: CP_MODE, settings.json, the launch directory and CP_HOME resolve one multi home or refuse with the reason", { timeout: 300_000 }, async (t) => {
	const r = await rig(t, "cp-p16-mode-");
	const { root, app } = r;
	const standard = join(root, ".pi-command-post");
	const home = join(root, "home");
	const v = async (cwd: string, env: NodeJS.ProcessEnv) => (await launch(r, cwd, env)).version;
	assert.match(await v(root, { CP_HOME: home }), new RegExp(`home ${home} \\(source: CP_HOME; CP_HOME is set; it wins over every default\\)`));
	assert.match(await v(root, { CP_HOME: home, CP_MODE: "both" }), /CP_MODE must be multi or auto, got "both"/);
	assert.match(await v(root, { CP_HOME: home, CP_MODE: "single" }), /single-project mode was removed.*CP_MODE=single/);
	assert.match(await v(root, { CP_HOME: home, CP_MODE: "auto" }), /source: CP_HOME/, "auto is the default");

	const plain = join(root, "plain");
	const settings = join(plain, ".pi-command-post", "settings.json");
	mkdirSync(dirname(settings), { recursive: true });
	writeFileSync(settings, JSON.stringify({ schema_version: 1, mode: "multi" }));
	assert.match(await v(plain, { HOME: root }), new RegExp(`home ${standard} \\(source: settings; settings.json says multi; home ${standard}`));
	writeFileSync(settings, JSON.stringify({ schema_version: 1, mode: "single" }));
	assert.match(await v(plain, { HOME: root }), /single-project mode was removed; .*settings\.json says single — delete it/);
	assert.match(await v(plain, { HOME: root, CP_MODE: "multi" }), /source: CP_MODE; CP_MODE says multi/, "CP_MODE beats the settings file");
	writeFileSync(settings, "not json");
	assert.match(await v(plain, { CP_HOME: home }), /source: CP_HOME; .*\(settings\.json ignored: .*settings\.json is not JSON/);

	const repo = createScratchRepo({ withRemote: false });
	t.after(() => repo.cleanup());
	assert.match(await v(repo.path, { HOME: root }), /is a git repository, not a command-post home — single-project mode was removed/);
	assert.equal(existsSync(join(repo.path, ".pi-command-post")), false, "a refused repository is never scaffolded");
	assert.ok(repo.isClean());
	assert.match(await v(repo.path, { HOME: root, CP_MODE: "multi" }), new RegExp(`source: CP_MODE; CP_MODE says multi; home ${standard}`));

	const multiHome = join(root, "multi");
	for (const dir of ["projects", "state"]) mkdirSync(join(multiHome, ".pi-command-post", dir), { recursive: true });
	assert.match(await v(multiHome, { HOME: root }), new RegExp(`home ${multiHome} \\(source: home-dir`));
	const half = join(root, "half");
	mkdirSync(join(half, ".pi-command-post", "state"), { recursive: true });
	assert.match(await v(half, { HOME: root }), new RegExp(`home ${standard} \\(source: standard`), "state/ alone is no home");

	const legacy = createScratchRepo({ withRemote: false, name: "legacy" });
	t.after(() => legacy.cleanup());
	mkdirSync(join(legacy.path, ".pi-command-post", "state"), { recursive: true });
	appendFileSync(join(legacy.path, ".git", "info", "exclude"), "\n.pi-command-post/\n");
	assert.match(await v(root, { CP_HOME: legacy.path }), /is a former single-project home — single-project mode was removed.*; its state is not migrated/);
	assert.match(await v(legacy.path, { HOME: root }), /holds a former single-project home's state, which is not migrated/);

	// A repository named .pi-command-post keeps its nested settings.json; another home's nested root is never a home.
	const dot = join(root, "dotparent", ".pi-command-post");
	mkdirSync(join(dot, ".pi-command-post"), { recursive: true });
	git(dot, "init", "-q", "-b", "main");
	writeFileSync(join(dot, ".pi-command-post", "settings.json"), JSON.stringify({ schema_version: 1, mode: "single" }));
	assert.match(await v(dot, { HOME: root }), new RegExp(`single-project mode was removed; .*${dot}/\\.pi-command-post/settings\\.json says single`));
	for (const gitted of [true, false]) {
		const owner = join(root, gitted ? "nest-git" : "nest-plain");
		for (const dir of ["projects", "state"]) mkdirSync(join(owner, ".pi-command-post", dir), { recursive: true });
		writeFileSync(join(owner, ".gitignore"), ".pi-command-post/\n");
		if (gitted) git(owner, "init", "-q", "-b", "main");
		const nested = await v(join(owner, ".pi-command-post"), { HOME: root });
		assert.match(nested, gitted ? new RegExp(`${owner} is a git repository, not a command-post home`) : new RegExp(`home ${standard} \\(source: standard`));
	}
	const link = join(root, "link");
	symlinkSync(repo.path, link);
	mkdirSync(join(repo.path, "a", "b"), { recursive: true });
	assert.match(await v(join(link, "a", "b"), { HOME: root }), new RegExp(`^${realpathSync(repo.path)} is a git repository`, "m"), "the toplevel is resolved through the symlink");

	// An installed package (pi's git clone dir) never keeps its home inside the clone pi resets.
	const installed = join(root, ".pi", "agent", "git", "github.com", "user", "pi-command-post");
	cpSync(app, installed, { recursive: true });
	mkdirSync(join(root, "launch"));
	const managed = await launch(r, join(root, "launch"), { HOME: root }, join(installed, "extensions/command-post/index.ts"));
	assert.match(managed.version, new RegExp(`home ${standard} \\(source: managed; .*resets its clone on update`));
	assert.equal(existsSync(join(installed, ".pi-command-post")), false);
	for (const where of [".pi/agent/npm/pkg", "proj/.pi/git/github.com/user/pkg", "proj/.pi/npm/pkg", "lib/node_modules/pkg"]) {
		const copy = join(root, where);
		cpSync(installed, copy, { recursive: true });
		const other = await launch(r, join(root, "launch"), { HOME: root }, join(copy, "extensions/command-post/index.ts"));
		assert.match(other.version, new RegExp(`home ${standard} \\(source: managed;`), where);
		assert.equal(existsSync(join(copy, ".pi-command-post")), false, where);
	}
	// The source checkout is its own home, even holding state/ and an exclude line like a former single home.
	mkdirSync(join(app, ".pi-command-post", "state"), { recursive: true });
	appendFileSync(join(app, ".git", "info", "exclude"), "\n.pi-command-post/\n");
	const checkout = await v(join(app, "src"), { HOME: join(root, "elsewhere") });
	assert.match(checkout, new RegExp(`home ${app} \\(source: checkout; running inside the source checkout; the package root is the home`));
	assert.ok(existsSync(join(app, ".pi-command-post", "projects")));
});

// P16-migration: state-migrations.test.ts through session_start's sweep and /doctor's state.job_id_migration finding.
test("P16-migration: a session sweeps br_id to job_id once, leaves malformed and non-state files alone, and doctor reports what remains", { timeout: 300_000 }, async (t) => {
	const r = await rig(t, "cp-p16-migration-");
	const marker = (home: string) => join(home, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER);
	const empty = join(r.root, "empty");
	const quiet = await launch(r, r.root, { CP_HOME: empty });
	assert.ok(!quiet.notes.some((text) => text.startsWith("state migration")), "an empty home reports nothing");
	assert.ok(existsSync(marker(empty)), "an empty home still writes the marker");

	const home = join(r.root, "home");
	seedLegacy(home);
	const read = (relative: string) => readFileSync(join(home, relative), "utf8");
	const untouched = [`${LAYOUT.runs}/cp-x/status.json`, `${LAYOUT.sessions}/2026-09-01.jsonl`, `${LAYOUT.awaitingFile}.bak-1`, `${LAYOUT.runs}/cp-a/brief.md`];
	const before = untouched.map(read);
	const parent = open(r, r.root, { CP_HOME: home });
	await version(parent);
	const swept = notes(parent).find((text) => text.startsWith("state migration")) ?? "";
	assert.match(swept, new RegExp(`renamed br_id -> job_id in 3 document\\(s\\) and 1 journal\\(s\\) under ${home}`));
	assert.match(swept, /! .*cp-x\/status\.json: not JSON, left as is/);
	assert.deepEqual(JSON.parse(read(`${LAYOUT.checkpoints}/cp-a.json`)), { job_id: "cp-a", decision: "pending", list: [{ job_id: "cp-b" }, "br_id"] });
	assert.deepEqual(JSON.parse(read(`${LAYOUT.runs}/cp-a/status.json`)), { job_id: "cp-a", phase: "working", deep: { x: { job_id: null } } });
	assert.deepEqual(JSON.parse(read(`${LAYOUT.runs}/cp-a/gate-1/verdict.json`)), { job_id: "cp-a", verdict: "pass" });
	const journal = read(`${LAYOUT.runs}/cp-a/events.jsonl`).split("\n");
	assert.deepEqual(JSON.parse(journal[0] ?? ""), { seq: 1, job_id: "cp-a", type: "spawned", payload: { job_id: "cp-a" } });
	assert.equal(journal[1], "this line is not json {", "a malformed journal line is copied verbatim");
	assert.deepEqual(JSON.parse(journal[2] ?? ""), { seq: 2, job_id: "cp-a", type: "text", payload: { text: "the string br_id stays" } });
	assert.deepEqual(untouched.map(read), before, "malformed documents, sessions, backups and prose are left as they were");
	assert.ok(existsSync(marker(home)));
	const left = finding(await doctor(parent), "state.job_id_migration");
	assert.equal(left?.severity, "warn", JSON.stringify(left));
	assert.match(JSON.stringify(left), /cp-x\/status\.json/);
	await parent.close();

	writeFileSync(join(home, LAYOUT.checkpoints, "cp-late.json"), JSON.stringify({ br_id: "cp-late" }));
	const again = open(r, r.root, { CP_HOME: home });
	await version(again);
	assert.ok(!notes(again).some((text) => text.startsWith("state migration")), "behind the marker the sweep is a no-op");
	assert.equal(read(`${LAYOUT.checkpoints}/cp-late.json`), JSON.stringify({ br_id: "cp-late" }));
	assert.match(JSON.stringify(finding(await doctor(again), "state.job_id_migration")), /"warn".*cp-late\.json/);
	// The marker is read when doctor runs: without it the same files are an unswept home, an error.
	const stamp = readFileSync(marker(home));
	rmSync(marker(home));
	const unswept = finding(await doctor(again), "state.job_id_migration");
	assert.equal(unswept?.severity, "error", JSON.stringify(unswept));
	assert.match(unswept?.what ?? "", /file\(s\) still carry "br_id"/);
	assert.match(unswept?.fix ?? "", /start a pi session/);
	writeFileSync(marker(home), stamp);
	rmSync(join(home, LAYOUT.checkpoints, "cp-late.json"));
	rmSync(join(home, LAYOUT.runs, "cp-x"), { recursive: true });
	assert.equal(finding(await doctor(again), "state.job_id_migration")?.severity, "ok", "a swept home is ok");
});

// P16-user-context: user-context.test.ts through the model request a real parent sends after session_start.
test("P16-user-context: USER.md beside the package's AGENTS.md reaches the model once with its precedence, truncated when runaway, and absent, empty or unreadable files send nothing", { timeout: 300_000 }, async (t) => {
	const r = await rig(t, "cp-p16-user-");
	const home = join(r.root, "home");
	const user = join(r.app, "USER.md");
	writeFileSync(join(r.root, "USER.md"), "not beside AGENTS.md\n");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "USER.md"), "under the home\n");
	/** The bodies of every model request one parent makes for `prompts` prompts. */
	const ask = async (prompts = 1): Promise<{ bodies: string[]; notes: string[] }> => {
		const steps = Array.from({ length: prompts }, (_, i): ScriptStep => ({ kind: "text", text: `reply ${i}` }));
		const parent = open(r, r.root, { CP_HOME: home }, steps);
		for (let i = 0; i < prompts; i += 1) {
			await parent.prompt(`hello ${i}`);
			await parent.waitFor((record) => record.type === "agent_settled" && parent.records().filter((x) => x.type === "agent_settled").length > i, 120_000);
		}
		const script = r.provider.requests().at(-1)?.script ?? "";
		const bodies = r.provider.requests(script).map((request) => JSON.stringify(request.body));
		await parent.close();
		return { bodies, notes: notes(parent) };
	};
	const header = "USER.md (machine-local operator context, never versioned)";
	const absent = await ask();
	assert.equal(absent.bodies.length, 1);
	assert.ok(!absent.bodies[0]?.includes(header), "no USER.md sends nothing");
	assert.ok(!absent.bodies[0]?.includes("under the home") && !absent.bodies[0]?.includes("not beside AGENTS.md"), "only the package root's USER.md counts");
	// The parent's contract is the package's AGENTS.md, and it states USER.md's precedence.
	const contract = JSON.parse(absent.bodies[0] ?? "{}") as unknown;
	const system = JSON.stringify(contract).replace(/\\n|\s+/g, " ");
	assert.match(system, /`USER\.md` at this repo's root loads itself into your context at session start when it exists/);
	for (const phrase of [/optional and never versioned/, /can never weaken a safety, review, authorization or delivery rule/, /Authorization is delegated only through the mandate store/, /the contract wins/]) assert.match(system, phrase);

	writeFileSync(user, "  \n\t\n");
	assert.ok(!(await ask()).bodies[0]?.includes(header), "a whitespace-only USER.md is absent");
	rmSync(user);
	mkdirSync(user); // EISDIR on read, for root too (chmod 000 is a no-op for root)
	const unreadable = await ask();
	rmSync(user, { recursive: true });
	assert.ok(!unreadable.bodies[0]?.includes(header), "an unreadable USER.md is absent");
	assert.ok(!unreadable.notes.some((text) => /USER\.md/.test(text)), "and not an error the session hears about");

	writeFileSync(user, "# Operator\nPrefer small PRs; my timezone is UTC+2.\n");
	const present = await ask(2);
	assert.equal(present.bodies.length, 2);
	for (const body of present.bodies) {
		assert.equal(body.split(header).length - 1, 1, "delivered once, never re-sent per prompt");
		assert.ok(body.includes(`: ${user}`), "names the file it read");
		assert.match(body, /Precedence: AGENTS\.md and docs\/contracts\.md remain binding.*never by free prose in this file/);
		assert.ok(body.includes("Prefer small PRs; my timezone is UTC+2."));
	}
	assert.ok(!present.notes.some((text) => text.includes(header)), "background context, never a displayed notice");
	assert.equal(git(r.app, "status", "--porcelain"), "", "git never exposes USER.md at the repo root");

	writeFileSync(user, `${"x".repeat(9000)}TAIL`);
	const runaway = (await ask()).bodies[0] ?? "";
	assert.ok(runaway.includes(header) && runaway.includes("Precedence: AGENTS.md"), "truncation never cuts the precedence");
	assert.ok(runaway.includes("x".repeat(8000)) && !runaway.includes("x".repeat(8001)) && !runaway.includes("TAIL"));
	assert.match(runaway, /… truncated at 8000 characters — shorten USER\.md if the rest matters\./);
});

// P16-doctor-home: home-checkout.test.ts and storage.test.ts through /doctor --json and a model's cp_next call.
test("P16-doctor-home: doctor and cp_next warn about a clean checkout home behind main without changing it, and doctor names stray home, state, alias and handoff storage", { timeout: 300_000 }, async (t) => {
	const r = await rig(t, "cp-p16-doctor-");
	const { root, app } = r;
	const elsewhere = { HOME: join(root, "elsewhere") };
	const base = { remote: r.remote, branch: "main" } as ScratchRepo;
	const original = git(app, "rev-parse", "HEAD");
	advanceBase(base, "one.txt", "one\n");
	advanceBase(base, "two.txt", "two\n");
	git(app, "fetch", "--quiet", "origin");
	const remote = git(app, "rev-parse", "origin/main");
	const behind = "home is 2 commits behind origin/main";
	const blank: MockToolCall = { id: "c1", name: "cp_check", args: { job_id: "cp-none", project: "  " } };
	const parent = open(r, join(app, "src"), elsewhere, nextTurns(12, [blank]));
	const lag = finding(await doctor(parent), "home.checkout");
	assert.equal(lag?.severity, "warn");
	assert.equal(lag?.what, behind);
	assert.match(lag?.fix ?? "", /^git merge --ff-only origin\/main, then restart the parent at a quiet point$/);
	assert.match(await askNext(parent), new RegExp(`${behind}: git merge --ff-only origin/main, then restart the parent at a quiet point.*no active mandate`), "a warning, never a new recommendation");
	const check = await parent.waitFor((record) => record.type === "tool_execution_end" && record.toolName === "cp_check", 120_000);
	assert.match(JSON.stringify(check.result), /cp_check needs `project` \(a registered project name\)/, "a blank project is refused");
	assert.equal(git(app, "rev-parse", "HEAD"), original, "no auto-merge");
	assert.equal(git(app, "rev-parse", "origin/main"), remote, "no fetch, no push");
	assert.equal(git(app, "status", "--porcelain"), "");

	// Under an active mandate the warning rides along; the recommendation is still the ready job's dispatch.
	const job = await new Ledger({ home: app, actor: "cp-test", knownProjects: ["demo"] }).create({ title: "next task", project: "demo", delivery: "pr", kind: "ship" });
	new MandateStore(app).issue({ projects: ["demo"], objective: "ship next task", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 1 });
	const active = await askNext(parent);
	assert.match(active, new RegExp(`${behind}: git merge --ff-only origin/main`));
	assert.match(active, new RegExp(`action: dispatch ${job.id} `));
	mkdirSync(join(app, LAYOUT.data), { recursive: true });
	writeFileSync(join(app, LAYOUT.data, "update.json"), JSON.stringify({ enabled: true, interval_min: 15 }));
	assert.match(finding(await doctor(parent), "home.checkout")?.fix ?? "", /^auto-update is on \(data\/update\.json\): cp-update\.timer applies it once the fleet is idle.*by hand: git merge/);
	assert.equal(git(app, "status", "--porcelain"), "", "the config lives in the ignored runtime root");

	/** Neither /doctor nor cp_next gives lag advice in this state; `unavailable` is the missing-main warning. */
	const silent = async (state: string, unavailable = false) => {
		const unknown = "home checkout comparison with origin/main unavailable";
		const shown = finding(await doctor(parent), "home.checkout");
		assert.deepEqual([shown?.severity, shown?.what], unavailable ? ["warn", unknown] : [undefined, undefined], state);
		const said = await askNext(parent);
		assert.doesNotMatch(said, /commits behind/, `cp_next, ${state}`);
		assert.equal(said.includes(unknown), unavailable, `cp_next, ${state}`);
	};
	writeFileSync(join(app, "stray.txt"), "mine\n");
	await silent("untracked");
	assert.match(JSON.stringify(finding(await doctor(parent), "storage.home")), /"warn".*outside the runtime root \.pi-command-post\/.*stray\.txt/, "a checkout home lists what git leaves untracked");
	rmSync(join(app, "stray.txt"));
	const readme = readFileSync(join(app, "README.md"), "utf8");
	writeFileSync(join(app, "README.md"), `${readme}local edit\n`);
	await silent("modified");
	writeFileSync(join(app, "README.md"), readme);
	writeFileSync(join(app, "staged.txt"), "staged\n");
	git(app, "add", "staged.txt");
	await silent("staged");
	git(app, "rm", "-q", "--cached", "staged.txt");
	rmSync(join(app, "staged.txt"));
	const index = readFileSync(join(app, ".git", "index"));
	writeFileSync(join(app, ".git", "index"), "not an index");
	const broken = await doctor(parent);
	assert.match(JSON.stringify(finding(broken, "storage.home")), /"warn".*untracked files in the home could not be listed.*git ls-files exited/);
	writeFileSync(join(app, ".git", "index"), index);
	assert.equal(finding(await doctor(parent), "home.checkout")?.what, behind, "the restored checkout is behind again");

	git(app, "merge", "--ff-only", "--quiet", "origin/main");
	await silent("current");
	advanceBase(base, "three.txt", "three\n");
	await silent("unfetched");
	git(app, "fetch", "--quiet", "origin");
	assert.equal(finding(await doctor(parent), "home.checkout")?.what, "home is 1 commits behind origin/main");
	writeFileSync(join(app, "local.txt"), "local\n");
	git(app, "add", "local.txt");
	git(app, "commit", "-q", "-m", "local change");
	await silent("diverged");
	git(app, "merge", "-q", "--no-edit", "origin/main");
	await silent("ahead");
	git(app, "update-ref", "-d", "refs/remotes/origin/main");
	await silent("missing-main", true);
	await parent.close();

	const home = join(root, "home");
	const separate = open(r, join(app, "src"), { ...elsewhere, CP_HOME: home });
	const clean = await doctor(separate);
	assert.equal(finding(clean, "home.checkout"), undefined, "a separate home never compares the checkout");
	assert.deepEqual(clean.findings.filter((f) => f.check.startsWith("storage")).map((f) => [f.check, f.severity, f.what]), [
		["storage", "ok", "home-local files are under the runtime root, .pi-command-post/ (docs/storage.md)"],
	]);
	const leftover = join(home, "state");
	mkdirSync(leftover);
	mkdirSync(join(home, ".other-tool"));
	writeFileSync(join(home, LAYOUT.state, "notes.md"), "mine\n");
	for (const kept of ["record.json", "drain.json", "events.jsonl", "parent.lock", "parent.sock", "parent.log", "write.tmp"]) {
		writeFileSync(join(home, LAYOUT.state, kept), "{}\n");
	}
	mkdirSync(join(home, LAYOUT.runs, "cp-z"), { recursive: true });
	writeFileSync(join(home, LAYOUT.data, "operator.json"), "{ nope");
	const stray = await doctor(separate);
	const of = (check: string) => JSON.stringify(stray.findings.filter((f) => f.check === check));
	assert.match(of("storage.home"), /"warn".*2 home entries outside the runtime root.*\.other-tool.*state/);
	assert.match(of("storage.state"), /1 non-record file\(s\) at the top of \.pi-command-post\/state\/.*notes\.md.*\.pi-command-post\/operator/);
	assert.doesNotMatch(of("storage.state"), /record\.json|drain|events|parent\.|write\.tmp|runs/);
	assert.match(of("storage.handoffs_dir"), /operator\.json is not valid JSON/);
	assert.ok(existsSync(join(home, ".other-tool")) && existsSync(leftover), "doctor moves and deletes nothing");
	writeFileSync(join(home, LAYOUT.data, "operator.json"), JSON.stringify({ handoffs_dir: join(root, "outside") }));
	assert.match(JSON.stringify(finding(await doctor(separate), "storage.handoffs_dir")), /handoffs_dir is outside the home/);
	writeFileSync(join(home, LAYOUT.data, "operator.json"), JSON.stringify({ handoffs_dir: join(home, "handoffs") }));
	assert.equal(finding(await doctor(separate), "storage.handoffs_dir"), undefined, "inside the home is fine");
	await separate.close();

	const nested = join(home, ".pi-command-post");
	const alias = open(r, root, { CP_HOME: nested });
	const aliased = async () => JSON.stringify(finding(await doctor(alias), "storage.alias") ?? {});
	assert.match(await aliased(), new RegExp(`another home's runtime root; use ${home} as the home.*\\(\\.gitignore lists`));
	const ignore = readFileSync(join(home, ".gitignore"), "utf8");
	writeFileSync(join(home, ".gitignore"), "");
	assert.equal(await aliased(), "{}", "no evidence, no alias");
	mkdirSync(join(home, ".git", "info"), { recursive: true });
	writeFileSync(join(home, ".git", "info", "exclude"), "/.pi-command-post\n");
	assert.match(await aliased(), new RegExp(`use ${home} as the home.*\\(\\.git/info/exclude lists`));
	rmSync(join(home, ".git"), { recursive: true });
	writeFileSync(join(home, ".gitignore"), ignore);
	await alias.close();
	// The flat standard home with app/ and settings.json: doctor's scaffold and storage checks pass; the viewer reads it.
	const standard = join(root, ".pi-command-post");
	const flatPath = (relative: string) => join(standard, relative.replace(/^\.pi-command-post\//, ""));
	writeFileSync(join(standard, "settings.json"), JSON.stringify({ schema_version: 1, mode: "multi" }));
	const flat = open(r, join(app, "src"), { HOME: root });
	const flatReport = await doctor(flat);
	assert.equal(finding(flatReport, "storage.alias"), undefined, "the standard home is not an alias");
	for (const check of ["scaffold.data", "scaffold.state", "scaffold.projects", "storage"]) assert.equal(finding(flatReport, check)?.severity, "ok", check);
	assert.equal(finding(flatReport, "home.gitignore"), undefined, "a flat home has no .gitignore to check");
	writeFileSync(join(standard, "stray.md"), "notes\n");
	assert.equal(finding(await doctor(flat), "storage.home")?.detail, "stray.md");
	await flat.close();
	writeFileSync(flatPath(LAYOUT.fleetFile), JSON.stringify({ jobs: [{ job_id: "cp-a", project: "demo", phase: "held" }] }));
	const ledger = JSON.parse(readFileSync(flatPath(LAYOUT.jobsFile), "utf8")) as { jobs: unknown[] };
	ledger.jobs.push({ id: "cp-a", title: "Flat", status: "open", labels: [] });
	writeFileSync(flatPath(LAYOUT.jobsFile), JSON.stringify(ledger));
	const viewer = createViewer({ home: standard, stateDir: resolveStateDir(standard), host: "127.0.0.1", port: 0, log: () => {} });
	await new Promise<void>((resolve) => viewer.listen(0, "127.0.0.1", resolve));
	t.after(() => viewer.close());
	assert.equal(resolveStateDir(standard), flatPath(LAYOUT.state));
	const jobs = await (await fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/api/jobs`)).text();
	assert.match(jobs, /"cp-a"/);
	assert.match(jobs, /Flat/);
});
