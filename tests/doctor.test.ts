/**
 * T25 acceptance: degraded environments produce *specific* findings.
 *
 * Every test here breaks one thing and asserts the check id, the severity and
 * that the finding names a fix — the ported contract is that a diagnosis
 * nobody can act on is just bad news. Host tools are injected (`run`,
 * `which`), so the suite proves the policy on any machine.
 */

import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	type DoctorReport,
	EMPTY_USAGE,
	type FleetRecord,
	JOBS_SIZE_WARNING,
	LAYOUT,
	NEVER_COMMIT_PATHS,
	paths,
	SCHEMA_VERSION,
	validateDoctorReport,
	type WorkerHandle,
} from "../src/contracts.ts";
import {
	type CommandRunner,
	Doctor,
	type DoctorOptions,
	DoctorError,
	formatDoctor,
	formatDoctorJson,
	MAX_LINT_DETAIL,
	REQUIRED_TOOLS,
	whichAll,
} from "../src/doctor.ts";
import { PARENT_BRIDGE_FLAGS } from "../src/contracts.ts";
import { snapshotSessionTools } from "../src/session-tools.ts";
import { boundedList } from "../src/routing.ts";
import { FleetStore } from "../src/fleet.ts";
import { LEGACY_JOB_ID_KEY, sweepJobIdRename } from "../src/state-migrations.ts";
import { controlConfigFile, controlRecordFile, controlSocketFile } from "../src/viewer/control-files.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import type { ModelProbe } from "../src/routing.ts";
import {
	assertGolden,
	COMMAND_POST_EXTENSION,
	createScratchHome,
	hostPiVersionConflict,
	REPO_ROOT,
	type ScratchHome,
	startRpc,
	treehouseAvailable,
} from "./harness/index.ts";

const NOW = new Date("2026-08-27T12:00:00Z");

/** A healthy host: every tool present, one version each. */
function healthyRunner(overrides: Record<string, CommandResultLike> = {}): CommandRunner {
	return (command, args) => {
		const key = [command, ...args].join(" ");
		for (const [pattern, result] of Object.entries(overrides)) {
			if (key.includes(pattern)) return { status: 0, stdout: "", stderr: "", ...result };
		}
		if (args[0] === "--version") return { status: 0, stdout: `${basename(command)} 1.2.3\n`, stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};
}

interface CommandResultLike {
	status?: number | null;
	stdout?: string;
	stderr?: string;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

const ALL_PRESENT = (command: string): string[] => [`/usr/local/bin/${command}`];

interface HomeFixture {
	home: ScratchHome;
	doctor(options?: {
		run?: CommandRunner;
		which?: (command: string) => string[];
		probe?: ModelProbe;
		isPidAlive?: (pid: number) => boolean;
		packageRoot?: string;
		env?: NodeJS.ProcessEnv;
		serviceEnv?: NodeJS.ProcessEnv;
		sessionTools?: DoctorOptions["sessionTools"];
	}): Promise<DoctorReport>;
}

/** A scratch home that already has the scaffold, a .gitignore and an empty jobs document. */
function fixture(t: { after(fn: () => void): void }, options: { scaffold?: boolean; ledger?: boolean } = {}): HomeFixture {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	if (options.scaffold !== false) {
		for (const dir of [LAYOUT.data, LAYOUT.state, LAYOUT.projects] as const) mkdirSync(join(home.path, dir), { recursive: true });
		writeFileSync(join(home.path, ".gitignore"), "data/\nstate/\nprojects/\n.pi-command-post/\nnode_modules/\n");
	}
	if (options.ledger !== false) writeJobs(home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [] });
	return {
		home,
		doctor: async (opts = {}) =>
			new Doctor({
				home: home.path,
				packageRoot: opts.packageRoot ?? REPO_ROOT,
				fleet: new FleetStore({ home: home.path }),
				run: opts.run ?? healthyRunner(),
				which: opts.which ?? ALL_PRESENT,
				// Pinned, never inherited: an ambient CP_HOME (or any sibling var
				// describeHome reads) in the *worker's own* environment must not leak
				// into what the golden and the healthy-home report expect to see.
				// PI_CODING_AGENT_DIR keeps the web.search line off this machine's real pi settings.
				env: opts.env ?? { PI_CODING_AGENT_DIR: join(home.path, "pi-agent") },
				// Pinned too: the service.* lines read no units unless a test installs some, never the host's own.
				serviceEnv: opts.serviceEnv ?? { HOME: join(home.path, "user"), PI_HOME: join(home.path, "user", ".pi") },
				now: () => NOW,
				piVersion: "0.84.3",
				...(opts.probe ? { probe: opts.probe } : {}),
				...(opts.isPidAlive ? { isPidAlive: opts.isPidAlive } : {}),
				...(opts.sessionTools ? { sessionTools: opts.sessionTools } : {}),
			}).run(),
	};
}

function find(report: DoctorReport, check: string): DoctorReport["findings"] {
	return report.findings.filter((finding) => finding.check === check);
}

function writeJobs(home: string, document: unknown): void {
	mkdirSync(join(home, LAYOUT.runtimeDir), { recursive: true });
	writeFileSync(join(home, LAYOUT.jobsFile), JSON.stringify(document, null, 2));
}

const JOB_ROW = {
	id: "cp-a",
	title: "t",
	status: "open",
	labels: ["project:demo", "delivery:pr"],
	blocked_by: [],
	comments: [],
	created_at: "2026-08-27T11:00:00Z",
	updated_at: "2026-08-27T11:00:00Z",
};

function record(overrides: Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<WorkerHandle> }): FleetRecord {
	const { worker, ...rest } = overrides;
	return {
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worktree: "/worktrees/gone",
		branch: overrides.job_id,
		dispatched_at: "2026-08-27T11:00:00Z",
		usage: EMPTY_USAGE,
		...rest,
		worker: {
			pid: 4242,
			session_id: "sess",
			session_file: "/sessions/gone.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-08-27T11:00:00Z",
			...worker,
		},
	} as FleetRecord;
}

// ---------------------------------------------------------------------------
test("doctor reports parent threshold, standing orders age, context and last controls", async (t) => {
	const home = fixture(t);
	const absent = await home.doctor();
	assert.equal(find(absent, "parent.standing_orders")[0]?.severity, "warn");
	assert.match(find(absent, "parent.standing_orders")[0]?.fix ?? "", /standing-orders.md/);
	assert.match(find(absent, "parent.compact_threshold")[0]?.what ?? "", /default 200000/);
	writeFileSync(join(home.home.path, LAYOUT.data, "parent.json"), '{"compact_at_tokens":0}');
	assert.equal(find(await home.doctor(), "parent.compact_threshold")[0]?.severity, "warn");
	writeFileSync(join(home.home.path, LAYOUT.data, "parent.json"), '{"compact_at_tokens":150000}');
	writeFileSync(join(home.home.path, LAYOUT.data, "standing-orders.md"), "# Standing orders\n");
	mkdirSync(join(home.home.path, LAYOUT.sessions), { recursive: true });
	writeFileSync(join(home.home.path, LAYOUT.sessions, "cp-parent-context.json"), JSON.stringify({ contextTokens: 42000, lastCompactAt: "2026-09-25T00:00:00Z", lastRotateAt: "2026-09-25T01:00:00Z" }));
	const report = await home.doctor();
	assert.match(find(report, "parent.compact_threshold")[0]?.what ?? "", /150000/);
	assert.match(find(report, "parent.context")[0]?.what ?? "", /42000.*last compact.*last rotate/);
	assert.match(find(report, "parent.standing_orders")[0]?.what ?? "", /modified/);
});

// The healthy case, and the report contract
// ---------------------------------------------------------------------------

test("doctor warns when active pi-lens prerequisites are missing from PATH", async (t) => {
	const fixtureHome = fixture(t);
	const report = await fixtureHome.doctor({ which: (command) => REQUIRED_TOOLS.includes(command as (typeof REQUIRED_TOOLS)[number]) ? ALL_PRESENT(command) : [] });
	const finding = find(report, "pi-lens.tools")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /typescript-language-server, ast-grep/);
	assert.equal(finding?.fix, "npm i -g typescript-language-server@5.3.0 typescript @ast-grep/cli");
});

test("doctor does not warn about pi-lens prerequisites when implementer deactivates pi-lens", async (t) => {
	const fixtureHome = fixture(t);
	const root = mkdtempSync(join(tmpdir(), "cp-doctor-profiles-"));
	const profiles = join(root, "profiles");
	mkdirSync(profiles);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	cpSync(join(REPO_ROOT, "profiles", "implementer.md"), join(profiles, "implementer.md"));
	const path = join(profiles, "implementer.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("role: implementer", "role: implementer\npackages: []"));
	const report = await fixtureHome.doctor({
		packageRoot: root,
		which: (command) => REQUIRED_TOOLS.includes(command as (typeof REQUIRED_TOOLS)[number]) ? ALL_PRESENT(command) : [],
	});
	assert.deepEqual(find(report, "pi-lens.tools"), []);
});

test("doctor warns about profiles updated after code load, not older profiles", async (t) => {
	const home = fixture(t);
	const root = join(home.home.path, "package");
	cpSync(join(REPO_ROOT, "profiles"), join(root, "profiles"), { recursive: true });
	for (const name of ["implementer", "planner", "qa", "gate-reviewer"]) {
		utimesSync(join(root, "profiles", `${name}.md`), new Date(0), new Date(0));
	}
	assert.deepEqual(find(await home.doctor({ packageRoot: root }), "package.profiles_newer"), []);
	const changed = join(root, "profiles/implementer.md");
	const future = new Date(Date.now() + 60_000);
	utimesSync(changed, future, future);
	const finding = find(await home.doctor({ packageRoot: root }), "package.profiles_newer")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /profiles newer than the loaded code/);
	assert.match(finding?.detail ?? "", /implementer.md/);
	assert.match(finding?.fix ?? "", /restart the parent/);
});

test("a healthy home is ok, and every finding that is not ok names a fix", async (t) => {
	const report = await fixture(t).doctor();
	assert.equal(report.ok, true);
	assert.equal(report.counts.error, 0);
	assert.equal(report.schema_version, SCHEMA_VERSION);
	assert.ok(validateDoctorReport(report).ok);
	for (const finding of report.findings) {
		if (finding.severity !== "ok") assert.ok(finding.fix, `${finding.check} has no fix`);
	}
	for (const tool of REQUIRED_TOOLS) {
		assert.equal(find(report, `host.${tool}`)[0]?.severity, "ok");
	}
	assert.equal(find(report, "ledger.file")[0]?.severity, "ok");
	assert.match(find(report, "config.bounds.wall_clock")[0]?.what ?? "", /5400s/);
	assert.match(find(report, "config.bounds.tool_call_cap")[0]?.what ?? "", /900 starts/);
	assert.equal(find(report, "session.tools")[0]?.severity, "ok");
	assert.match(find(report, "session.tools")[0]?.what ?? "", /not recorded/);
});

test("session.tools: expected tools are ok; a file-reading foreign tool is a warn", async (t) => {
	const home = fixture(t);
	const clean = await home.doctor({
		sessionTools: snapshotSessionTools([
			{ name: "read" },
			{ name: "bash" },
			{ name: "cp_dispatch", sourceInfo: { path: "/repo/extensions/command-post/index.ts", source: "extension" } },
		]),
	});
	assert.equal(find(clean, "session.tools")[0]?.severity, "ok");
	assert.match(find(clean, "session.tools")[0]?.what ?? "", /no foreign tools/);

	const dirty = await home.doctor({
		sessionTools: snapshotSessionTools([
			{ name: "read" },
			{ name: "lens_read", parameters: { properties: { path: { type: "string" } } } },
			{ name: "fetch_content" },
		]),
	});
	const finding = find(dirty, "session.tools")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /2 foreign tool/);
	assert.match(finding?.what ?? "", /outside guard coverage/);
	assert.match(finding?.detail ?? "", /lens_read \(file_read, outside guard coverage\)/);
	assert.match(finding?.detail ?? "", /fetch_content \(network\)/);
	assert.match(finding?.fix ?? "", /--no-extensions/);
	assert.match(finding?.fix ?? "", /warn only/);
	assert.equal(dirty.ok, true, "a foreign tool is advisory, never an error");
});

test("viewer: running is ok; not running is informational with no operator session, an advisory warn with one", async (t) => {
	const home = fixture(t);
	const running = await home.doctor({ run: healthyRunner({ "pgrep -f src/viewer/cli.ts": { stdout: "4321\n" } }) });
	assert.equal(find(running, "viewer")[0]?.severity, "ok");
	assert.match(find(running, "viewer")[0]?.what ?? "", /pid 4321/);

	const idle = await home.doctor({ run: healthyRunner({ "pgrep": { status: 1 } }) });
	const info = find(idle, "viewer")[0];
	assert.equal(info?.severity, "ok", "no operator session: not running is information, not a fault");
	assert.match(info?.what ?? "", /not running \(no operator session up; bin\/cp-operator starts it\)/);
	assert.equal(info?.fix, undefined);

	const orphaned = await home.doctor({
		run: healthyRunner({ "pgrep -f src/viewer/cli.ts": { status: 1 }, "pgrep -f src/viewer/operator.ts": { stdout: "99\n" } }),
	});
	const finding = find(orphaned, "viewer")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.fix ?? "", /tailscale ip -4.*bin\/cp-operator/);
	assert.match(finding?.fix ?? "", /CP_VIEWER_HOST/, "a pinned host is named too");
	assert.equal(orphaned.ok, true, "the viewer is optional");
});

test("dashboard-control: one line, on by default, off with {enabled:false}, a warn when the file is invalid; never a login, device or allowlist line", async (t) => {
	const home = fixture(t);
	const stateDir = join(home.home.path, LAYOUT.state);
	const on = find(await home.doctor(), "dashboard-control");
	assert.equal(on.length, 1);
	assert.equal(on[0]?.severity, "ok");
	assert.match(on[0]?.what ?? "", /^dashboard control: on \(on by default \(no data\/dashboard-control\.json\); no operator session serving it/);
	assert.doesNotMatch(JSON.stringify(on), /allowlist|login|device|user|node/i);

	mkdirSync(dirname(controlRecordFile(stateDir)), { recursive: true });
	writeFileSync(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: controlSocketFile(stateDir), token: "a".repeat(64), csrf: "b".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	assert.match(find(await home.doctor(), "dashboard-control")[0]?.what ?? "", new RegExp(`operator session pid ${process.pid} serving .*dashboard\\.sock`));

	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled": false}');
	const off = find(await home.doctor(), "dashboard-control")[0];
	assert.equal(off?.severity, "ok");
	assert.equal(off?.what, "dashboard control: off (data/dashboard-control.json has enabled:false)");

	writeFileSync(controlConfigFile(stateDir), "{not json");
	const invalid = find(await home.doctor(), "dashboard-control")[0];
	assert.equal(invalid?.severity, "warn");
	assert.match(invalid?.what ?? "", /^dashboard control: off \(.*unreadable/);
	assert.match(invalid?.fix ?? "", /remove it/);
	assert.equal(find(await home.doctor(), "viewer").length, 1, "the viewer finding is unchanged");
});

test("mode: a multi-mode report says so, with the runtime's reason", async (t) => {
	const home = fixture(t);
	const report = await home.doctor();
	const mode = report.findings.find((f) => f.check === "mode");
	assert.equal(mode?.severity, "ok");
	assert.match(mode?.what ?? "", /^multi-project mode, home /);
	assert.ok(report.findings.some((f) => f.check === "home.gitignore") || !existsSync(join(home.home.path, ".gitignore")));
	assert.ok(!report.findings.some((f) => f.check === "home.exclude"), "exclude is a single-mode finding");
});

test("golden: a broken environment reads as a work list", async (t) => {
	const home = fixture(t, { scaffold: false, ledger: false });
	const report = await home.doctor({
		which: (command) => (command === "git" ? ["/usr/bin/git"] : []),
		run: healthyRunner(),
	});
	assertGolden("doctor-broken.txt", normalizeGolden(formatDoctor(report), home.home.path));
	assert.equal(report.ok, false);
});

function normalizeGolden(text: string, homePath: string): string {
	// Paths differ per machine; the shape and the fixes are what is pinned.
	return text.split("\n").map((line) => line.replaceAll(homePath, "<HOME>").replaceAll(REPO_ROOT, "<PKG>")).join("\n");
}

test("hermetic: the host's own cp-* units and HOME never leak into the golden report", async (t) => {
	// The regression this guards: service.* read ~/.config/systemd/user from process.env, so a host
	// with the daemon installed failed the golden above while CI (no units) passed.
	const host = mkdtempSync(join(tmpdir(), "cp-doctor-host-"));
	t.after(() => rmSync(host, { recursive: true, force: true }));
	const unitDir = join(host, ".config", "systemd/user");
	mkdirSync(unitDir, { recursive: true });
	for (const name of ["cp-parent.service", "cp-view.service", "cp-health.service", "cp-health.timer"]) writeFileSync(join(unitDir, name), "ExecStart=\"/gone/node\" x\n");
	mkdirSync(join(host, ".pi", "command-post", ".pi-command-post"), { recursive: true });
	const prior = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PI_HOME: process.env.PI_HOME };
	t.after(() => {
		for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : (process.env[key] = value);
	});
	process.env.HOME = host;
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.PI_HOME;
	const home = fixture(t, { scaffold: false, ledger: false });
	const report = await home.doctor({ which: (command) => (command === "git" ? ["/usr/bin/git"] : []), run: healthyRunner() });
	assert.deepEqual(report.findings.filter((finding) => finding.check.startsWith("service.")), [], "no unit is installed in this test's world");
	assertGolden("doctor-broken.txt", normalizeGolden(formatDoctor(report), home.home.path));
});

test("hermetic: an ambient CP_HOME never leaks into the report", async (t) => {
	// The regression this guards: describeHome() defaults to process.env, so a
	// Doctor built without a pinned `env` reads whatever the *worker's own*
	// environment happens to export. Two independent workers hit this via the
	// golden test above; this test fails the same way if fixture() ever goes
	// back to falling through to process.env instead of pinning `env: {}`.
	const prevCpHome = process.env.CP_HOME;
	const prevPiHome = process.env.PI_HOME;
	process.env.CP_HOME = "/tmp/some-other-fleet";
	process.env.PI_HOME = "/tmp/some-other-pi-home";
	t.after(() => {
		if (prevCpHome === undefined) delete process.env.CP_HOME;
		else process.env.CP_HOME = prevCpHome;
		if (prevPiHome === undefined) delete process.env.PI_HOME;
		else process.env.PI_HOME = prevPiHome;
	});
	const report = await fixture(t).doctor();
	const location = find(report, "home.location")[0];
	assert.match(location?.what ?? "", /home \((?:checkout|managed)\):/, "an ambient CP_HOME/PI_HOME must not change how the home was resolved");
});

test("the report validates its own arithmetic", () => {
	const bad = {
		schema_version: SCHEMA_VERSION,
		generated_at: "2026-08-27T12:00:00Z",
		home: "/home",
		package_root: "/pkg",
		counts: { ok: 0, warn: 0, error: 0 },
		ok: true,
		findings: [{ check: "x", severity: "error", what: "broken", fix: "fix it" }],
	};
	const result = validateDoctorReport(bad);
	assert.equal(result.ok, false);
	assert.ok(result.ok === false && result.errors.some((error) => error.includes("/counts/error")));

	// A finding without a fix is refused, whatever the counts say.
	const noFix = validateDoctorReport({
		...bad,
		counts: { ok: 0, warn: 1, error: 0 },
		findings: [{ check: "x", severity: "warn", what: "degraded" }],
	});
	assert.equal(noFix.ok, false);
	assert.ok(noFix.ok === false && noFix.errors.some((error) => error.includes("must name a fix")));
});

// ---------------------------------------------------------------------------
// Host tools
// ---------------------------------------------------------------------------

test("a missing host tool is an error that says why the tool is needed", async (t) => {
	const report = await fixture(t).doctor({
		which: (command) => (command === "treehouse" ? [] : ALL_PRESENT(command)),
	});
	const finding = find(report, "host.treehouse")[0];
	assert.ok(finding);
	assert.equal(finding.severity, "error");
	assert.match(finding.fix ?? "", /only from treehouse/);
	assert.equal(report.ok, false);
});

test("two pi versions on PATH is an error; identical shims are not", async (t) => {
	// A version manager's shims are the same build behind several paths: that is
	// normal, and calling it broken would train the operator to ignore doctor.
	const shims = await fixture(t).doctor({
		which: (command) => (command === "pi" ? ["/shims/a/pi", "/shims/b/pi", "/shims/c/pi"] : ALL_PRESENT(command)),
		run: (command, args) =>
			args[0] === "--version" ? { status: 0, stdout: "pi 0.84.3\n", stderr: "" } : healthyRunner()(command, args, "/"),
	});
	assert.deepEqual(find(shims, "host.pi.conflict"), []);
	assert.match(find(shims, "host.pi")[0]?.detail ?? "", /\+2 more on PATH/);
	assert.equal(shims.ok, true);
});

// ---------------------------------------------------------------------------
// Ledger (spec 2026-09-04)
// ---------------------------------------------------------------------------

test("ledger.file: a missing document is an error naming the scaffold; a sound one is ok with a count", async (t) => {
	const fx = fixture(t, { ledger: false });
	const missing = (await fx.doctor()).findings.find((f) => f.check === "ledger.file");
	assert.equal(missing?.severity, "error");
	assert.match(missing?.fix ?? "", /start a pi session/);

	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [JOB_ROW] });
	const report = await fx.doctor();
	const file = report.findings.find((f) => f.check === "ledger.file");
	assert.equal(file?.severity, "ok");
	assert.match(file?.what ?? "", /1 job\(s\), prefix cp/);
	for (const check of ["ledger.ids", "ledger.deps", "ledger.prefix", "ledger.size"]) {
		assert.equal(report.findings.find((f) => f.check === check)?.severity, "ok", check);
	}
	assert.ok(!report.findings.some((f) => f.check === "ledger.beads_archive"), "no .beads/, no archive finding");
});

test("ledger.file: not JSON or the wrong shape is an error with the parser's words", async (t) => {
	const fx = fixture(t, { ledger: false });
	mkdirSync(join(fx.home.path, LAYOUT.runtimeDir), { recursive: true });
	writeFileSync(join(fx.home.path, LAYOUT.jobsFile), "{nope");
	const notJson = (await fx.doctor()).findings.find((f) => f.check === "ledger.file");
	assert.equal(notJson?.severity, "error");
	assert.match(notJson?.what ?? "", /not JSON/);

	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [{ id: "cp-a" }] });
	const badShape = (await fx.doctor()).findings.find((f) => f.check === "ledger.file");
	assert.equal(badShape?.severity, "error");
	assert.match(badShape?.detail ?? "", /\/jobs\/0/);
});

test("ledger.file: a document that still carries the retired type and priority fields is ok", async (t) => {
	const fx = fixture(t, { ledger: false });
	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [{ ...JOB_ROW, type: "epic", priority: 2 }] });
	const report = await fx.doctor();
	const file = report.findings.find((f) => f.check === "ledger.file");
	assert.equal(file?.severity, "ok");
	assert.match(file?.what ?? "", /1 job\(s\), prefix cp/);
	for (const check of ["ledger.ids", "ledger.deps"]) {
		assert.equal(report.findings.find((f) => f.check === check)?.severity, "ok", check);
	}
});

test("ledger.ids and ledger.deps report duplicates, foreign prefixes, unknown blockers and cycles separately", async (t) => {
	const fx = fixture(t, { ledger: false });
	writeJobs(fx.home.path, {
		schema_version: SCHEMA_VERSION,
		prefix: "cp",
		jobs: [JOB_ROW, JOB_ROW, { ...JOB_ROW, id: "cp-b", blocked_by: ["cp-zzz", "cp-c"] }, { ...JOB_ROW, id: "cp-c", blocked_by: ["cp-b"] }],
	});
	const report = await fx.doctor();
	const ids = report.findings.find((f) => f.check === "ledger.ids");
	assert.equal(ids?.severity, "error");
	assert.match(ids?.detail ?? "", /duplicate id cp-a/);
	const deps = report.findings.find((f) => f.check === "ledger.deps");
	assert.equal(deps?.severity, "error");
	assert.match(deps?.detail ?? "", /unknown cp-zzz/);
	assert.match(deps?.detail ?? "", /dependency cycle/);
	assert.match(deps?.fix ?? "", /cp_job dep_remove/);
});

test("ledger.prefix warns when the environment disagrees with the document; ledger.size warns past the cap", async (t) => {
	const fx = fixture(t, { ledger: false });
	const jobs = Array.from({ length: JOBS_SIZE_WARNING + 1 }, (_, i) => ({ ...JOB_ROW, id: `cp-${i.toString(36).padStart(4, "0")}` }));
	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs });
	const report = await fx.doctor({ env: { CP_HOME: fx.home.path, CP_LEDGER_PREFIX: "cps" } });
	const prefix = report.findings.find((f) => f.check === "ledger.prefix");
	assert.equal(prefix?.severity, "warn");
	assert.match(prefix?.what ?? "", /CP_LEDGER_PREFIX=cps but the document mints cp-/);
	const size = report.findings.find((f) => f.check === "ledger.size");
	assert.equal(size?.severity, "warn");
	assert.match(size?.what ?? "", new RegExp(`${JOBS_SIZE_WARNING + 1} jobs`));
});

test("ledger.beads_archive: a leftover .beads/ beside a populated document is a warning that says it is safe to delete", async (t) => {
	const fx = fixture(t, { ledger: false });
	mkdirSync(join(fx.home.path, ".beads"), { recursive: true });
	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [JOB_ROW] });
	const finding = (await fx.doctor()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.fix ?? "", /safe to delete/);

	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [] });
	const empty = (await fx.doctor()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(empty?.severity, "ok");
	assert.match(empty?.what ?? "", /not imported yet/);
	assert.match(empty?.fix ?? "", /\/cp-jobs import-beads/);
});

test("ledger.beads_archive: a .beads/ that an active tracker connection uses is ok and never advised for deletion", async (t) => {
	const fx = fixture(t, { ledger: false });
	const beads = join(fx.home.path, ".beads");
	mkdirSync(beads, { recursive: true });
	writeFileSync(join(beads, "beads.db"), "");
	writeJobs(fx.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [JOB_ROW] });
	const connection = { id: "demo-beads", project: "demo", adapter: "beads", endpoint: realpathSync(join(beads, "beads.db")), intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z" };
	const trackers = (connections: object[]) => {
		mkdirSync(join(fx.home.path, LAYOUT.data), { recursive: true });
		writeFileSync(join(fx.home.path, LAYOUT.data, "trackers.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, connections }));
	};

	trackers([connection]);
	const live = (await fx.doctor()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(live?.severity, "ok", JSON.stringify(live));
	assert.match(live?.what ?? "", /live endpoint of tracker demo-beads/);
	assert.doesNotMatch(`${live?.what} ${live?.fix}`, /safe to delete/);

	trackers([{ ...connection, status: "disconnected", disconnected_at: "2026-09-02T00:00:00Z" }]);
	const archive = (await fx.doctor()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(archive?.severity, "warn");
	assert.match(archive?.fix ?? "", /safe to delete/);

	writeFileSync(join(fx.home.path, LAYOUT.data, "trackers.json"), "{nope");
	const unreadable = (await fx.doctor()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(unreadable?.severity, "warn");
	assert.match(unreadable?.fix ?? "", /do not delete/);
});

test("state.job_id_migration: a pre-rename fleet file is an error until the sweep runs", async (t) => {
	const home = fixture(t);
	mkdirSync(join(home.home.path, LAYOUT.state), { recursive: true });
	writeFileSync(
		join(home.home.path, LAYOUT.fleetFile),
		// Deliberately the pre-rename key: this fixture is what the sweep moves.
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-08-27T00:00:00Z",
			jobs: [{ [LEGACY_JOB_ID_KEY]: "cp-old" }],
		}),
	);
	const before = await home.doctor();
	const finding = find(before, "state.job_id_migration")[0];
	assert.equal(finding?.severity, "error");
	assert.match(finding?.fix ?? "", /sweep once and writes state\/\.migrations/);

	sweepJobIdRename({ home: home.home.path });
	const after = await home.doctor();
	assert.equal(find(after, "state.job_id_migration")[0]?.severity, "ok");
});

// ---------------------------------------------------------------------------
// Package resources
// ---------------------------------------------------------------------------

test("package resources are checked against the real package", async (t) => {
	const report = await fixture(t).doctor();
	assert.equal(find(report, "package.worker_reporter")[0]?.severity, "ok");
	assert.equal(find(report, "package.profiles")[0]?.severity, "ok");
	assert.equal(find(report, "package.briefs")[0]?.severity, "ok");
	assert.deepEqual(find(report, "package.roles"), [], "three roles, one profile each");
});

test("a package with no profiles is an error for every role", async (t) => {
	const empty = createScratchHome();
	t.after(() => empty.cleanup());
	const report = await fixture(t).doctor({ packageRoot: empty.path });
	assert.equal(find(report, "package.worker_reporter")[0]?.severity, "error");
	assert.equal(find(report, "package.roles").length, 3);
	for (const finding of find(report, "package.roles")) {
		assert.equal(finding.severity, "error");
		// cp-u3o4: the wording changed with the tiebreak (a role must *resolve*),
		// and "none at all" is still its own sentence.
		assert.match(finding.what, /no profile for role/);
	}
	assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("absent config is fine; invalid config is an error naming the file", async (t) => {
	const home = fixture(t);
	const clean = await home.doctor();
	assert.equal(find(clean, "config.routing")[0]?.severity, "ok");

	writeFileSync(join(home.home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: "everything" }));
	writeFileSync(join(home.home.path, LAYOUT.budgetsFile), "{ nope");
	const broken = await home.doctor();
	assert.equal(find(broken, "config.routing")[0]?.severity, "error");
	assert.match(find(broken, "config.routing")[0]?.fix ?? "", /routing\.json/);
	assert.equal(find(broken, "config.budgets")[0]?.severity, "error");
	assert.equal(broken.ok, false);
});

test("config.gate: absent is fine, invalid names the file, and the resolved timeout is visible", async (t) => {
	const home = fixture(t);
	const clean = await home.doctor();
	assert.equal(find(clean, "config.gate")[0]?.severity, "ok");
	assert.match(find(clean, "config.gate")[0]?.what ?? "", /no \.pi-command-post\/data\/gate\.json/);
	assert.match(
		find(clean, "config.gate.review_timeout_ms")[0]?.what ?? "",
		/300000ms \(default\)/,
		"absent config resolves to the built-in default, visibly",
	);

	writeFileSync(join(home.home.path, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: 1, review_timeout_ms: 60_000 }));
	const withOverride = await home.doctor();
	assert.equal(find(withOverride, "config.gate")[0]?.severity, "ok");
	assert.match(find(withOverride, "config.gate.review_timeout_ms")[0]?.what ?? "", /60000ms/);
	assert.doesNotMatch(find(withOverride, "config.gate.review_timeout_ms")[0]?.what ?? "", /default/);

	writeFileSync(join(home.home.path, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: 1, review_timeout_ms: 0 }));
	const broken = await home.doctor();
	assert.equal(find(broken, "config.gate")[0]?.severity, "error");
	assert.equal(broken.ok, false);
});

test("an empty routing allowlist is honoured as written, and flagged", async (t) => {
	const home = fixture(t);
	writeFileSync(
		join(home.home.path, LAYOUT.routingFile),
		JSON.stringify({ schema_version: 1, allow: [], rubric: [] }),
	);
	const report = await home.doctor();
	const finding = find(report, "config.routing.allow")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /no model may be used/);
});

// ---------------------------------------------------------------------------
// Effective per-job budget ceiling (cp-sr5): min(profile, data/budgets.json)
// is a silent clamp unless doctor says so, checkable before dispatch rather
// than discovered when cp_send is refused.
// ---------------------------------------------------------------------------

test("raising data/budgets.json alone (profile untouched) is not clamped", async (t) => {
	const home = fixture(t);
	// Real profiles ask for 50_000_000 tokens; a config raised to match or
	// exceed that must read as "not clamped", not silently ignored.
	writeFileSync(
		join(home.home.path, LAYOUT.budgetsFile),
		JSON.stringify({ schema_version: 1, per_job_tokens: 100_000_000, per_job_cost_usd: 100, warn_ratio: 0.8, spawn_cap: 10 }),
	);
	const report = await home.doctor();
	const finding = find(report, "config.budget.implementer")[0];
	assert.equal(finding?.severity, "ok");
	assert.match(finding?.what ?? "", /not clamped/);
});

test("raising only data/budgets.json below a profile's own budget surfaces the clamp", async (t) => {
	const home = fixture(t);
	// The profile still asks for 50_000_000 (profiles/implementer.md on disk is
	// untouched); only the fleet ceiling moved, and it moved DOWN — the min()
	// in resolveJobBudget silently wins here unless doctor says so.
	writeFileSync(
		join(home.home.path, LAYOUT.budgetsFile),
		JSON.stringify({ schema_version: 1, per_job_tokens: 1_000, per_job_cost_usd: 1, warn_ratio: 0.8, spawn_cap: 10 }),
	);
	const report = await home.doctor();
	const finding = find(report, "config.budget.implementer")[0];
	assert.equal(finding?.severity, "warn", "a raise the config clamps must not read as ok");
	assert.match(finding?.what ?? "", /clamped by the fleet ceiling to 1000 tokens/);
	assert.match(finding?.detail ?? "", /clamped on: tokens/);
	assert.match(finding?.fix ?? "", /data\/budgets\.json/);
	assert.equal(report.ok, true, "a clamp is advisory, not a reason a home cannot dispatch");
});

test("raising only a profile's own budget above the (untouched) fleet default surfaces the clamp", async (t) => {
	const home = fixture(t);
	// No data/budgets.json at all: the fleet falls back to DEFAULT_BUDGET_CONFIG
	// (50_000_000 as of cp-8aj). A profile asking for even more is clamped right
	// back down to that default — raising the profile alone did nothing, and
	// doctor must say so rather than reporting "not clamped".
	const profilesDir = join(home.home.path, "profiles");
	mkdirSync(profilesDir, { recursive: true });
	for (const src of ["implementer", "planner", "gate-reviewer"]) {
		const original = readFileSync(join(REPO_ROOT, "profiles", `${src}.md`), "utf8");
		const greedy =
			src === "implementer" ? original.replace(/budget: \{[^}]*\}/, "budget: { tokens: 999000000, cost_usd: 999 }") : original;
		writeFileSync(join(profilesDir, `${src}.md`), greedy);
	}
	mkdirSync(join(home.home.path, "prompts/briefs"), { recursive: true });
	for (const template of ["brief-ship", "brief-research", "brief-gate"]) {
		writeFileSync(join(home.home.path, "prompts/briefs", `${template}.md`), "stub\n");
	}
	const reporter = join(home.home.path, "extensions/worker-reporter");
	mkdirSync(reporter, { recursive: true });
	writeFileSync(join(reporter, "index.ts"), "export default {};\n");
	const report = await home.doctor({ packageRoot: home.home.path });
	const finding = find(report, "config.budget.implementer")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /clamped by the fleet ceiling/);
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

test("without a live registry, model availability is unprobed — never 'missing'", async (t) => {
	const report = await fixture(t).doctor();
	const finding = find(report, "models.probe")[0];
	assert.equal(finding?.severity, "ok");
	assert.match(finding?.what ?? "", /not probed/);
	assert.equal(report.ok, true);
});

test("a live registry checks real auth: an unreachable model fails, loudly", async (t) => {
	const home = fixture(t);
	// Nothing is available: every role must fail, and the fix names `pi auth`.
	const none = await home.doctor({ probe: { isAvailable: () => false } });
	for (const role of ["planner", "implementer", "gate-reviewer"] as const) {
		const finding = find(none, `models.${role}`)[0];
		assert.ok(finding, `no finding for ${role}`);
		assert.equal(finding.severity, "error");
		assert.match(finding.fix ?? "", /pi auth/);
	}
	assert.equal(none.ok, false);

	// Everything available: green, and no fallback noise.
	const all = await home.doctor({ probe: { isAvailable: () => true } });
	for (const role of ["planner", "implementer", "gate-reviewer"] as const) {
		assert.equal(find(all, `models.${role}`)[0]?.severity, "ok");
	}
	assert.equal(all.ok, true);

	// A route whose every candidate is unreachable is still an error, and it names
	// each candidate and the gate that refused it. "Only a cheaper model is
	// reachable" was never a warning: a quiet downgrade would run the job on a
	// model nobody chose (cp-eff), and an *ordered* ladder is the opposite —
	// candidates somebody wrote down, in the order they wrote them.
	const haikuOnly: ModelProbe = { isAvailable: (model) => model.includes("haiku") };
	const stuck = await home.doctor({ probe: haikuOnly });
	const planner = find(stuck, "models.planner")[0];
	assert.ok(planner);
	assert.equal(planner.severity, "error");
	assert.match(planner.detail ?? "", /no usable model/);
	assert.match(planner.detail ?? "", /every candidate for profile planner was refused/);
	for (const candidate of ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"]) {
		assert.ok((planner.detail ?? "").includes(`${candidate} (availability)`), `${candidate} must be named`);
	}
	assert.match(planner.fix ?? "", /pi auth|routing\.json/);
	assert.equal(stuck.ok, false);
});

test("one authenticated provider is green, and the finding says which fallback carried it", async (t) => {
	// pi-command-post-0a9: the whole point of the ladder is that a one-provider
	// machine resolves every route — and that an operator can still see that
	// today's Anthropic policy is running on OpenAI.
	const home = fixture(t);
	const openaiOnly: ModelProbe = { isAvailable: (model) => model.startsWith("openai/") };
	const report = await home.doctor({ probe: openaiOnly });
	for (const who of ["planner", "implementer", "gate-reviewer", "qa"] as const) {
		const finding = find(report, `models.${who}`)[0];
		assert.ok(finding, `no finding for ${who}`);
		assert.equal(finding.severity, "ok", `${who}: ${finding.detail ?? finding.what}`);
		assert.match(finding.what, /openai\//);
		assert.match(finding.what, /fallback from anthropic\//);
	}
});

test("a project-scoped rubric row is really resolved, not skipped by a synthetic probe", async (t) => {
	// cp-2bm: rubric rows can name a project (cp-cxt), so probing with
	// project="doctor" reported the model a *fake* job would get — a home with
	// per-repo policy could be told it was green while a real project's model was
	// unauthenticated. Here `web` routes to a model nothing can reach.
	const home = fixture(t);
	mkdirSync(join(home.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.home.path, LAYOUT.projectsFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-08-27T12:00:00Z",
			projects: [
				{
					name: "web",
					clone_url: "git@example.com:acme/web.git",
					delivery: "pr",
					registered_at: "2026-08-27T12:00:00Z",
				},
				{
					name: "api",
					clone_url: "git@example.com:acme/api.git",
					delivery: "pr",
					registered_at: "2026-08-27T12:00:00Z",
				},
			],
		}),
	);
	writeFileSync(
		join(home.home.path, LAYOUT.routingFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			allow: ["anthropic/*", "pinned/*"],
			rubric: [
				{ id: "web-ship", role: "implementer", project: "web", model: "pinned/only-for-web" },
				{ id: "big-ship", role: "implementer", scope: ["L"], model: "pinned/only-for-big-jobs" },
			],
		}),
	);

	// Everything except the project pin is reachable.
	const report = await home.doctor({ probe: { isAvailable: (model) => !model.startsWith("pinned/") } });

	// The role default is still reported, and it is fine — that is exactly how the
	// old probe could say green.
	assert.equal(find(report, "models.implementer")[0]?.severity, "ok");

	// The project whose row names an unreachable model gets its own finding, and
	// it is an error: a real project that cannot run is not green, however healthy
	// the role default looks. That contrast is the whole point of the check.
	const scoped = find(report, "models.implementer.web")[0];
	assert.ok(scoped, `no per-project finding: ${report.findings.map((f) => f.check).join(", ")}`);
	assert.equal(scoped.severity, "error");
	assert.match(scoped.what, /implementer in web/);
	assert.match(scoped.detail ?? "", /pinned\/only-for-web/);
	assert.match(scoped.fix ?? "", /routing\.json/);
	assert.equal(report.ok, false);
	assert.equal(find(report, "models.implementer")[0]?.severity, "ok", "the role default was fine all along");

	// A project that resolves the same as the role default adds no row: one line
	// per role per project would bury the finding that matters.
	assert.deepEqual(find(report, "models.implementer.api"), []);
	assert.deepEqual(find(report, "models.planner.web"), []);

	// Routing T5: the L-only row is no longer "unexercised" prose — it is really
	// resolved, so its unreachable model is an error of its own beside the S/low
	// row that passes. Nothing is left to warn about, because nothing was skipped.
	assert.deepEqual(find(report, "models.rubric"), [], "every row was reachable from a registered project and the scope/risk grid");
	const implementer = find(report, "models.implementer");
	const big = implementer.find((finding) => (finding.detail ?? "").includes("pinned/only-for-big-jobs"));
	assert.ok(big, `the L-only row was not exercised: ${implementer.map((f) => f.what).join(" | ")}`);
	assert.equal(big.severity, "error");
	assert.match(big.detail ?? "", /scope\/risk: L\/low, L\/high/, "the finding names the combinations that produced it");
	assert.ok(
		!implementer.some((finding) => (finding.detail ?? "").includes("S/low") && finding.severity === "error"),
		"S/low still routes to a reachable model — the big row's failure must not be attributed to it",
	);
});

test("routing T5: the whole scope/risk grid is exercised, and identical answers share one finding", async (t) => {
	const home = fixture(t);
	mkdirSync(join(home.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.home.path, LAYOUT.routingFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			allow: ["anthropic/*", "pinned/*"],
			rubric: [{ id: "risky-ship", role: "implementer", risk: "high", model: "pinned/only-for-risky" }],
		}),
	);
	const report = await home.doctor({ probe: { isAvailable: (model) => !model.startsWith("pinned/") } });

	// The high-risk row is unreachable; every low-risk combination is fine. Both
	// facts are reported, and each of them exactly once.
	const implementer = find(report, "models.implementer");
	assert.equal(implementer.length, 2, `expected one ok row and one error row, got: ${implementer.map((f) => f.what).join(" | ")}`);
	const ok = implementer.find((finding) => finding.severity === "ok");
	const broken = implementer.find((finding) => finding.severity === "error");
	assert.match(ok?.detail ?? "", /scope\/risk: S\/low, M\/low, L\/low/);
	assert.match(broken?.detail ?? "", /scope\/risk: S\/high, M\/high, L\/high/);
	assert.match(broken?.detail ?? "", /pinned\/only-for-risky/);
	assert.equal(report.ok, false);

	// A role no row touches keeps its single line: six identical answers are one
	// finding, not six.
	assert.equal(find(report, "models.planner").length, 1);
});

test("routing T5: two projects that share one unreachable answer are both named, never silently deduped", async (t) => {
	const home = fixture(t);
	mkdirSync(join(home.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.home.path, LAYOUT.projectsFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-08-27T12:00:00Z",
			projects: ["web", "mobile", "api"].map((name) => ({
				name,
				clone_url: `git@example.com:acme/${name}.git`,
				delivery: "pr",
				registered_at: "2026-08-27T12:00:00Z",
			})),
		}),
	);
	// Two projects routed to the same unreachable model by two different rows:
	// their grids answer identically, which used to mean only the first was
	// reported and the second was named nowhere at all.
	writeFileSync(
		join(home.home.path, LAYOUT.routingFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			allow: ["anthropic/*", "pinned/*"],
			rubric: [
				{ id: "web-ship", role: "implementer", project: "web", model: "pinned/shared" },
				{ id: "mobile-ship", role: "implementer", project: "mobile", model: "pinned/shared" },
			],
		}),
	);
	const broken = await home.doctor({ probe: { isAvailable: (model) => !model.startsWith("pinned/") } });

	// Unreachable: the refusal names the row that chose the model, so the two
	// projects are two different findings — and each of them says which project it
	// is about. Neither is dropped as a duplicate of the other.
	const failing = broken.findings.filter((finding) => finding.check.startsWith("models.implementer."));
	assert.deepEqual(
		failing.map((finding) => finding.check).sort(),
		["models.implementer.mobile", "models.implementer.web"],
		"a project whose model cannot be reached must never be named nowhere",
	);
	for (const finding of failing) {
		assert.equal(finding.severity, "error");
		assert.match(finding.detail ?? "", /pinned\/shared/);
	}
	assert.match(failing.find((f) => f.check.endsWith(".web"))?.what ?? "", /implementer in web:/);
	assert.match(failing.find((f) => f.check.endsWith(".mobile"))?.what ?? "", /implementer in mobile:/);
	assert.deepEqual(find(broken, "models.implementer.api"), [], "api answers the way the baseline does");
	assert.equal(broken.ok, false);

	// Reachable: both projects now resolve to the same model at the same efforts
	// for the same combinations, so the identical answer is ONE row — which names
	// both projects rather than reporting the first and hiding the second.
	const fine = await home.doctor({ probe: { isAvailable: () => true } });
	const shared = fine.findings.filter((finding) => finding.check.startsWith("models.implementer."));
	assert.equal(shared.length, 1, `expected one shared row, got: ${shared.map((f) => f.check).join(", ")}`);
	assert.equal(shared[0]?.severity, "ok");
	assert.match(shared[0]?.what ?? "", /implementer in web, mobile: pinned\/shared/);
	assert.match(shared[0]?.detail ?? "", /scope\/risk: S\/low/);
	assert.deepEqual(find(fine, "models.implementer.api"), []);

	// And every configured row was exercised, so nothing is reported as skipped.
	assert.deepEqual(find(fine, "models.rubric"), []);
});

// ---------------------------------------------------------------------------
// Routing policy lint (routing T5)
// ---------------------------------------------------------------------------

function writeRouting(home: string, rubric: unknown[], allow: string[] = ["anthropic/*", "pinned/*"]): void {
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	writeFileSync(join(home, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow, rubric }));
}

test("routing T5: a row the allowlist refuses is exercised-and-refused, never 'not exercised'", async (t) => {
	const home = fixture(t);
	mkdirSync(join(home.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.home.path, LAYOUT.projectsFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-08-27T12:00:00Z",
			projects: [
				{
					name: "web",
					clone_url: "git@example.com:acme/web.git",
					delivery: "pr",
					registered_at: "2026-08-27T12:00:00Z",
				},
			],
		}),
	);
	// The row matches `web` perfectly — it fires — and its model is outside the
	// allowlist, so `pickModel` itself refuses. Before RoutingError carried the
	// row's id, that made the row look untouched: doctor reported "not exercised:
	// register the project" about a registered project whose row had just fired.
	writeRouting(
		home.home.path,
		[{ id: "web-ship", role: "implementer", project: "web", model: "forbidden/model" }],
		["anthropic/*"],
	);
	const report = await home.doctor({ probe: { isAvailable: () => true } });

	assert.deepEqual(find(report, "models.rubric"), [], "a row that fired is exercised, whatever the allowlist then says");
	const refused = find(report, "models.implementer.web")[0];
	assert.ok(refused, `no finding for the refused row: ${report.findings.map((f) => f.check).join(", ")}`);
	assert.equal(refused.severity, "error");
	assert.match(refused.what, /implementer in web: model refused by the allowlist/);
	assert.match(refused.detail ?? "", /rubric web-ship names forbidden\/model, which the allowlist refuses/);
	// The fix is the one that applies: the allowlist, not `pi auth` for a model
	// nothing ever tried to authenticate.
	assert.match(refused.fix ?? "", /add a pattern that covers it/);
	assert.doesNotMatch(refused.fix ?? "", /pi auth/);
	assert.equal(report.ok, false);
});

test("routing T5: an unserviceable configured effort names the effort fix, not `pi auth`", async (t) => {
	const home = fixture(t);
	writeRouting(home.home.path, [
		{ id: "ship", role: "implementer", model: "anthropic/claude-sonnet-5", thinking: "xhigh" },
	]);
	const report = await home.doctor({
		probe: { isAvailable: () => true, supportedThinking: () => ["low", "medium", "high"] },
	});
	const finding = find(report, "models.implementer")[0];
	assert.equal(finding?.severity, "error");
	assert.match(finding?.what ?? "", /effort the model cannot serve/);
	assert.match(finding?.fix ?? "", /name an effort level this model serves/);
	assert.doesNotMatch(finding?.fix ?? "", /pi auth/);
	// And the row is exercised: an effort refusal is not a row nobody reached.
	assert.deepEqual(find(report, "models.rubric"), []);
});

test("routing T5: a duplicate rubric id is refused at load, and doctor names the colliding rows", async (t) => {
	const home = fixture(t);
	writeRouting(home.home.path, [
		{ id: "ship", role: "implementer", scope: ["S"], model: "anthropic/claude-haiku-4-5" },
		{ id: "ship", role: "implementer", scope: ["L"], model: "anthropic/claude-opus-5" },
	]);
	const report = await home.doctor();
	const finding = find(report, "config.routing")[0];
	assert.equal(finding?.severity, "error");
	assert.match(finding?.detail ?? "", /duplicate rubric id/);
	assert.match(finding?.detail ?? "", /rubric\[0\] -> anthropic\/claude-haiku-4-5/);
	assert.match(finding?.detail ?? "", /rubric\[1\] -> anthropic\/claude-opus-5/);
	assert.equal(report.ok, false);
	// A config that cannot be loaded is not silently re-diagnosed as a model
	// problem: #models bails out, because #config already said what is wrong.
	assert.deepEqual(find(report, "models.implementer"), []);
});

test("routing T5: a provably shadowed row warns; an overlapping one does not", async (t) => {
	const home = fixture(t);
	writeRouting(home.home.path, [
		{ id: "all-ship", role: "implementer", model: "anthropic/claude-sonnet-5" },
		{ id: "dead-ship", role: "implementer", scope: ["L"], risk: "high", model: "anthropic/claude-opus-5" },
	]);
	const shadowed = find(await home.doctor(), "config.routing.shadowed")[0];
	assert.equal(shadowed?.severity, "warn");
	assert.match(shadowed?.what ?? "", /1 rubric row\(s\) can never fire/);
	assert.match(shadowed?.detail ?? "", /dead-ship \(rubric\[1\]\) <- all-ship \(rubric\[0\]\)/);
	assert.match(shadowed?.fix ?? "", /nothing here reorders/);

	// Partial overlap is intentional narrow-to-broad policy; a row narrowed to one
	// project is not covered by a row narrowed to another; and a broad row is
	// never "shadowed" by the narrower rows above it. None of these is a shadow.
	const overlapping = fixture(t);
	writeRouting(overlapping.home.path, [
		{ id: "web-ship", role: "implementer", project: "web", scope: ["S"], model: "anthropic/claude-opus-5" },
		{ id: "api-ship", role: "implementer", project: "api", scope: ["S"], model: "anthropic/claude-opus-5" },
		{ id: "small-ship", role: "implementer", scope: ["S"], model: "anthropic/claude-haiku-4-5" },
		{ id: "most-ship", role: "implementer", scope: ["S", "M"], model: "anthropic/claude-sonnet-5" },
		{ id: "planning", role: "planner", scope: ["S"], model: "anthropic/claude-sonnet-5" },
	]);
	const clean = await overlapping.doctor();
	assert.deepEqual(find(clean, "config.routing.shadowed"), [], "partial or per-project overlap must never be reported as a full shadow");
});

test("routing T5: configured effort the model cannot serve is an error; unknown metadata is not", async (t) => {
	const home = fixture(t);
	writeRouting(home.home.path, [
		{ id: "risky-ship", role: "implementer", risk: "high", model: "anthropic/claude-opus-5", thinking: "xhigh" },
	]);

	// The probe answers: every shipped profile's own level is served, and the
	// level the rubric row asks for is not.
	const known: ModelProbe = {
		isAvailable: () => true,
		supportedThinking: () => ["low", "medium", "high"],
	};
	const report = await home.doctor({ probe: known });
	const drift = find(report, "config.routing.effort")[0];
	assert.equal(drift?.severity, "error");
	assert.match(drift?.what ?? "", /1 configured model\/effort pair\(s\)/);
	assert.match(drift?.detail ?? "", /rubric row risky-ship asks for thinking=xhigh on anthropic\/claude-opus-5/);
	assert.match(drift?.detail ?? "", /available: low, medium, high/);
	assert.match(drift?.fix ?? "", /never substitutes/);
	assert.equal(report.ok, false);

	// A profile's own configured level is checked the same way, and named as the
	// profile it came from: gate-reviewer.md asks opus for `high`.
	const opusIsWeak = await home.doctor({
		probe: {
			isAvailable: () => true,
			supportedThinking: (model) => (model.includes("opus") ? ["low", "medium"] : ["low", "medium", "high", "xhigh"]),
		},
	});
	const both = find(opusIsWeak, "config.routing.effort")[0];
	assert.equal(both?.severity, "error");
	assert.match(both?.detail ?? "", /profile gate-reviewer asks for thinking=high on anthropic\/claude-opus-5/);
	assert.match(both?.detail ?? "", /rubric row risky-ship asks for thinking=xhigh/);

	// The same config against a probe with no metadata: ignorance is never proof,
	// so nothing is called unsupported and the home stays green.
	const blind = await home.doctor({ probe: { isAvailable: () => true } });
	assert.equal(find(blind, "config.routing.effort")[0]?.severity, "ok");
	assert.equal(blind.counts.error, 0, formatDoctor(blind));

	// And with no live registry at all there is no effort claim in either direction.
	assert.deepEqual(find(await home.doctor(), "config.routing.effort"), []);
});

// ---------------------------------------------------------------------------
// Routing T5: the bounds hold when the config is big (the report must not crash)
// ---------------------------------------------------------------------------

/** A name at the contract's own limit: project names run to 64 characters. */
function longName(prefix: string, index: number): string {
	const tail = `${index}`.padStart(2, "0");
	return `${prefix}-${"x".repeat(64 - prefix.length - 1 - tail.length)}${tail}`;
}

test("routing T5: over every bound — many projects, many dead rows — the report stays valid and self-counting", async (t) => {
	const home = fixture(t);
	mkdirSync(join(home.home.path, LAYOUT.data), { recursive: true });
	const projects = Array.from({ length: 14 }, (_, index) => longName("proj", index + 1));
	writeFileSync(
		join(home.home.path, LAYOUT.projectsFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-08-27T12:00:00Z",
			projects: projects.map((name) => ({
				name,
				clone_url: `git@example.com:acme/${name}.git`,
				delivery: "pr",
				registered_at: "2026-08-27T12:00:00Z",
			})),
		}),
	);
	// Every project routed to the same model (one shared row naming 14 projects),
	// plus 14 rows for an unregistered project (unexercised) and 14 dead rows
	// behind a broad planner row (shadowed) — all with maximum-length ids.
	writeRouting(home.home.path, [
		...projects.map((name) => ({ id: longName("row", projects.indexOf(name) + 1), role: "implementer", project: name, model: "pinned/shared" })),
		...Array.from({ length: 14 }, (_, index) => ({
			id: longName("unreached", index + 1),
			role: "implementer",
			project: "never-registered",
			model: "pinned/nowhere",
		})),
		{ id: "planning", role: "planner", model: "pinned/plan" },
		...Array.from({ length: 14 }, (_, index) => ({
			id: longName("dead", index + 1),
			role: "planner",
			scope: ["L"],
			risk: "high",
			model: "pinned/never",
		})),
	]);

	// The report is produced at all: `validateDoctorReport` refuses a finding whose
	// check/what/detail/fix breaks the contract, and `Doctor.run` throws on that —
	// so this test fails loudly if any bound is dropped.
	const report = await home.doctor({ probe: { isAvailable: () => true } });
	assert.ok(validateDoctorReport(report).ok);
	for (const finding of report.findings) {
		assert.ok(finding.check.length <= 64, `check over the bound: ${finding.check}`);
		assert.ok(finding.what.length <= 200, `what over the bound: ${finding.what}`);
		assert.ok((finding.detail ?? "").length <= 2000, `detail over the bound on ${finding.check}`);
		assert.ok((finding.fix ?? "").length <= 500, `fix over the bound on ${finding.check}`);
	}

	// The shared row names ten projects and counts the other four; the count is of
	// what is actually missing from the line, not of "everything past the cap".
	const shared = report.findings.filter((finding) => finding.check.startsWith("models.implementer."));
	assert.equal(shared.length, 1, `expected one shared row, got ${shared.length}`);
	const listed = (shared[0]?.what ?? "").match(/proj-/g)?.length ?? 0;
	const hidden = Number(/\(\+(\d+) more\)/.exec(shared[0]?.what ?? "")?.[1] ?? "0");
	assert.equal(listed + hidden, projects.length, `the count must describe the list: ${shared[0]?.what}`);
	assert.ok(listed >= 1 && listed <= MAX_LINT_DETAIL, `listed ${listed} project(s)`);

	// The unexercised rows: the 14 for an unregistered project plus the 14 dead
	// ones (a shadowed row never fires, so it is never exercised either), with
	// bounded detail and the same self-counting rule.
	const unexercised = find(report, "models.rubric")[0];
	assert.equal(unexercised?.severity, "warn");
	// 14 for the unregistered project + 14 dead rows, minus none: a shadowed row
	// never fires, so it is never exercised either.
	assert.match(unexercised?.what ?? "", /28 rubric row\(s\) were not exercised/);
	assertSelfCounting(unexercised?.detail ?? "", /-> /g, 28);

	// And the shadowed rows, the same way: the 13 duplicate-selector rows behind
	// the first of their kind, plus the 14 dead ones behind the broad planner row.
	const shadowed = find(report, "config.routing.shadowed")[0];
	assert.equal(shadowed?.severity, "warn");
	assert.match(shadowed?.what ?? "", /27 rubric row\(s\) can never fire/);
	assertSelfCounting(shadowed?.detail ?? "", / <- /g, 27);
});

/** A bounded list names some entries and counts the rest: the two must add up. */
function assertSelfCounting(text: string, entry: RegExp, total: number): void {
	const shown = (text.match(entry) ?? []).length;
	const hidden = Number(/\(\+(\d+) more\)/.exec(text)?.[1] ?? "0");
	assert.ok(shown <= MAX_LINT_DETAIL, `listed ${shown} entries, over MAX_LINT_DETAIL: ${text}`);
	assert.equal(shown + hidden, total, `the count must describe the list: ${text}`);
}

test("routing T5: boundedList counts what it dropped, whichever bound dropped it", () => {
	const items = Array.from({ length: 14 }, (_, index) => `item-${index + 1}`);
	// The count bound.
	const byCount = boundedList(items, { max: 10, cap: 2000 });
	assert.equal((byCount.match(/item-/g) ?? []).length, 10);
	assert.match(byCount, /\(\+4 more\)/);
	// The length bound: fewer items fit, and the count grows to match — never a
	// truncated line with a number that describes some other, longer line.
	const byLength = boundedList(items, { max: 10, cap: 40 });
	assert.ok(byLength.length <= 40, `over the cap: ${byLength}`);
	const shown = (byLength.match(/item-/g) ?? []).length;
	const hidden = Number(/\(\+(\d+) more\)/.exec(byLength)?.[1] ?? "0");
	assert.equal(shown + hidden, items.length, byLength);
	// Nothing to bound is nothing to count.
	assert.equal(boundedList(["only"], { max: 10 }), "only");
	assert.equal(boundedList([]), "");
});

// ---------------------------------------------------------------------------
// Scaffold and hygiene
// ---------------------------------------------------------------------------

test("a missing scaffold is advisory; an unwritable one is an error", async (t) => {
	const fresh = await fixture(t, { scaffold: false }).doctor();
	for (const key of ["data", "state", "projects"]) {
		assert.equal(find(fresh, `scaffold.${key}`)[0]?.severity, "warn");
	}
	assert.equal(fresh.ok, true, "a home that has not run yet is not broken");

	// The self-hosted CI runner runs as root, and root ignores directory modes.
	if (process.getuid?.() === 0) return t.skip("root ignores directory modes");
	const home = fixture(t);
	const stateDir = join(home.home.path, LAYOUT.state);
	chmodSync(stateDir, 0o500);
	try {
		const locked = await home.doctor();
		const finding = find(locked, "scaffold.state")[0];
		assert.equal(finding?.severity, "error");
		assert.match(finding?.what ?? "", /not writable/);
	} finally {
		// Restored here, not in an `after` hook: the home's own cleanup hook runs
		// first and would leave nothing to chmod.
		chmodSync(stateDir, 0o700);
	}
});

test("the one runtime root plus .beads covers runtime state", async (t) => {
	const home = fixture(t);
	writeFileSync(join(home.home.path, ".gitignore"), ".pi-command-post/\n.beads/\n");
	const finding = find(await home.doctor(), "home.gitignore")[0];
	assert.equal(finding?.severity, "ok");
});

test("a .gitignore that lists only the old top-level roots warns about the runtime root", async (t) => {
	const home = fixture(t);
	writeFileSync(join(home.home.path, ".gitignore"), "/data/*\nstate/\nprojects/\n.beads/\n");
	const finding = find(await home.doctor(), "home.gitignore")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /\.pi-command-post\//);
});

test("a .gitignore that does not cover runtime state is a warning", async (t) => {
	const home = fixture(t);
	writeFileSync(join(home.home.path, ".gitignore"), "node_modules/\n");
	const report = await home.doctor();
	const finding = find(report, "home.gitignore")[0];
	assert.equal(finding?.severity, "warn");
	// cp-rnr: every NEVER_COMMIT_PATHS root is demanded, `.beads/` included — the
	// guard refuses to stage all of them, so an omission is a real gap.
	for (const entry of NEVER_COMMIT_PATHS) {
		assert.ok((finding?.what ?? "").includes(entry), `${entry} is not demanded: ${finding?.what}`);
	}
});

// ---------------------------------------------------------------------------
// Fleet consistency (read-only: doctor reports, reconcile repairs)
// ---------------------------------------------------------------------------

test("a corrupt fleet file is an error that protects the jobs", async (t) => {
	const home = fixture(t);
	writeFileSync(join(home.home.path, LAYOUT.fleetFile), "{ truncated");
	const report = await home.doctor();
	const finding = find(report, "fleet.file")[0];
	assert.equal(finding?.severity, "error");
	assert.match(finding?.fix ?? "", /still in br and in state\/runs/);
});

test("a dead worker, a vanished worktree and a missing run dir each get their own finding", async (t) => {
	const home = fixture(t);
	const fleet = new FleetStore({ home: home.home.path });
	const sessionFile = join(home.home.path, "session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	await fleet.add(record({ job_id: "cp-dead", worker: { pid: 4242, session_file: sessionFile } }));
	mkdirSync(join(home.home.path, paths.runDir("cp-dead")), { recursive: true });
	await fleet.add(record({ job_id: "cp-noruns", worker: { pid: 4243 } }));

	const report = await home.doctor({ isPidAlive: () => false });
	const workers = find(report, "fleet.worker");
	assert.equal(workers.length, 2);
	const dead = workers.find((finding) => finding.what.includes("cp-dead"));
	assert.ok(dead);
	assert.equal(dead.severity, "warn", "doctor reports; reconcile is what changes a phase");
	assert.match(dead.detail ?? "", /session survives/);
	assert.match(dead.fix ?? "", /cp_revive cp-dead/);
	const noSession = workers.find((finding) => finding.what.includes("cp-noruns"));
	assert.match(noSession?.fix ?? "", /re-dispatch or tear/);

	assert.equal(find(report, "fleet.run_dir").length, 1, "only the job with no run directory");
	assert.match(find(report, "fleet.run_dir")[0]?.what ?? "", /cp-noruns/);
	assert.equal(find(report, "fleet.worktree").length, 2, "both fixtures point at a worktree that is gone");
	assert.match(find(report, "fleet.worktree")[0]?.fix ?? "", /--force/);
	assert.equal(report.ok, true, "a wrecked fleet is recoverable, so it is not an error");
});

test("doctor names script exits and still checks their worktrees", async (t) => {
	const home = fixture(t);
	await new FleetStore({ home: home.home.path }).add({
		...record({ job_id: "cp-script", delivery: "local" }), worker: undefined, executor: "script", script_path: "scripts/verify.sh",
		script_process: { pid: 4242, started_at: "2026-08-27T12:00:00Z", exited_at: "2026-08-27T12:00:00Z", exit_code: 0 },
	} as unknown as FleetRecord);
	mkdirSync(join(home.home.path, paths.runDir("cp-script")), { recursive: true });
	const report = await home.doctor({ isPidAlive: () => false });
	assert.match(find(report, "fleet.worker")[0]?.what ?? "", /cp-script script scripts\/verify\.sh \(pid 4242\): exited .* \(0\)/);
	assert.equal(find(report, "fleet.worktree").length, 1);
});

test("a live worker and finished jobs produce no fleet noise", async (t) => {
	const home = fixture(t);
	const fleet = new FleetStore({ home: home.home.path });
	const worktree = join(home.home.path, "worktree");
	mkdirSync(worktree, { recursive: true });
	await fleet.add(record({ job_id: "cp-live", worktree, worker: { pid: process.pid } }));
	await fleet.add(
		record({
			job_id: "cp-done",
			phase: "done",
			closed_at: "2026-08-27T11:30:00Z",
			reported_at: "2026-08-27T11:20:00Z",
			worker: { exited_at: "2026-08-27T11:30:00Z" },
		}),
	);
	mkdirSync(join(home.home.path, paths.runDir("cp-live")), { recursive: true });
	mkdirSync(join(home.home.path, paths.runDir("cp-done")), { recursive: true });

	const report = await home.doctor({ isPidAlive: (pid) => pid === process.pid });
	assert.deepEqual(find(report, "fleet.worker"), [], "a live worker is not a finding");
	assert.deepEqual(find(report, "fleet.worktree"), [], "a torn-down job's worktree is meant to be gone");
	assert.equal(find(report, "fleet.file")[0]?.what, "fleet: 2 record(s)");
});

// ---------------------------------------------------------------------------
// Formatting and PATH scanning
// ---------------------------------------------------------------------------

test("the human format leads with what is broken and ends with the verdict", async (t) => {
	const report = await fixture(t).doctor({ which: () => [] });
	const text = formatDoctor(report);
	assert.match(text, /^DOCTOR BROKEN/);
	assert.ok(text.indexOf("✗") < text.indexOf("✓"), "errors come before the green rows");
	assert.match(text, /cannot dispatch until the errors above are fixed$/);
	assert.equal(JSON.parse(formatDoctorJson(report)).ok, false);
});

test("whichAll finds every match in PATH order and ignores non-executables", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const first = join(home.path, "first");
	const second = join(home.path, "second");
	mkdirSync(first);
	mkdirSync(second);
	writeFileSync(join(first, "tool"), "#!/bin/sh\n");
	chmodSync(join(first, "tool"), 0o755);
	writeFileSync(join(second, "tool"), "#!/bin/sh\n");
	chmodSync(join(second, "tool"), 0o755);
	writeFileSync(join(second, "notexec"), "plain\n");

	assert.deepEqual(whichAll("tool", { PATH: `${first}:${second}` }), [join(first, "tool"), join(second, "tool")]);
	assert.deepEqual(whichAll("notexec", { PATH: second }), []);
	assert.deepEqual(whichAll("tool", { PATH: "" }), []);
	assert.deepEqual(whichAll("tool", {}), []);
});

test("whichAll counts one file reached through a symlinked PATH dir (usrmerge /bin -> /usr/bin) once", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const usrBin = join(home.path, "usr-bin");
	const bin = join(home.path, "bin");
	mkdirSync(usrBin);
	symlinkSync(usrBin, bin);
	writeFileSync(join(usrBin, "tool"), "#!/bin/sh\n");
	chmodSync(join(usrBin, "tool"), 0o755);

	assert.deepEqual(whichAll("tool", { PATH: `${usrBin}:${bin}` }), [join(usrBin, "tool")]);
	assert.deepEqual(whichAll("tool", { PATH: `${bin}:${usrBin}` }), [join(bin, "tool")]);
});

test(
	"/doctor runs in a real pi session and reports on the live home",
	{
		timeout: 120_000,
		// This spawns a real pi session against the real host, so — unlike every
		// other check in this file, which injects `run`/`which` precisely so the
		// policy is provable anywhere — it genuinely needs treehouse on PATH for
		// `report.ok` to be true.
		skip: treehouseAvailable() ? false : "needs treehouse on PATH",
	},
	async (t) => {
	const home = createScratchHome();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path },
	});
	// Close the child before removing the home it writes into: a cleanup hook
	// that throws skips every later hook (cp-widget-test-hangs).
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});

	// H7: both requests go out at once, so pi's cold start sits under the one 90 s notify wait.
	rpc.send({ id: "cmds", type: "get_commands" });
	rpc.send({ id: "run", type: "prompt", message: "/doctor --json" });
	const notify = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).trimStart().startsWith("{"),
		90_000,
	);
	const commands = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds")) as {
		data?: { commands?: Array<{ name: string }> };
	};
	assert.ok((commands.data?.commands ?? []).some((command) => command.name === "doctor"), "/doctor is not registered");
	const report = JSON.parse(String(notify.message)) as DoctorReport;
	assert.ok(validateDoctorReport(report).ok, "/doctor --json emitted an off-contract report");
	assert.equal(report.home, home.path);
	// A live session has a model registry, so availability is really probed.
	assert.deepEqual(find(report, "models.probe"), []);
	assert.ok(
		report.findings.some((finding) => finding.check.startsWith("models.")),
		`no model findings: ${report.findings.map((finding) => finding.check).join(",")}`,
	);
	// T30: `session_start` now scaffolds the home (data/, state/, projects/, and a
	// ledger when br is there), so by the time doctor runs a fresh home is *ready*
	// rather than merely tolerated. Before T30 these were warn/"created on first
	// use".
	for (const key of ["data", "state", "projects"]) {
		assert.equal(find(report, `scaffold.${key}`)[0]?.severity, "ok", `${key}/ should be scaffolded at session start`);
	}
	// And doctor says which home it is using and why — the packaging trap (a home
	// inside a package clone pi will reset) is an error, not a note.
	assert.equal(find(report, "home.location")[0]?.severity, "ok");
	assert.match(String(find(report, "home.location")[0]?.what), /home \((?:CP_HOME|checkout|managed)\)/);
	// A host with two pi versions on PATH (npm puts the pinned devDependency's pi
	// ahead of the installed one) legitimately trips host.pi.conflict. Tolerate
	// exactly that finding, with the reason printed, and nothing else.
	const piConflict = hostPiVersionConflict();
	// CI installs treehouse but never has model credentials (no `pi auth`), so
	// every route is refused there: tolerate exactly the `models.*` findings on CI.
	const noModelAuth = process.env.GITHUB_ACTIONS === "true";
	const errors = report.findings
		.filter((finding) => finding.severity === "error" && !(noModelAuth && finding.check.startsWith("models.")))
		.map((finding) => finding.check);
	if (noModelAuth) console.log("doctor: CI has no pi auth — tolerating models.* findings");
	if (piConflict) {
		console.log(`doctor: tolerating host.pi.conflict — more than one pi version on PATH (${piConflict})`);
		assert.deepEqual(errors, ["host.pi.conflict"], "a fresh home passes apart from this host's pi version conflict");
	} else if (noModelAuth) {
		assert.deepEqual(errors, [], "a fresh home passes apart from model auth on CI");
	} else {
		assert.equal(report.ok, true, "a fresh home passes");
	}

	const done = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
	assert.equal(done.success, true);
});

const FOREIGN_FILE_TOOL = join(REPO_ROOT, "tests/fixtures/foreign-file-tool.ts");

async function doctorJsonFromRpc(
	t: { after(fn: () => void | Promise<void>): void },
	args: string[],
): Promise<DoctorReport> {
	const home = createScratchHome();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", ...args],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});
	rpc.send({ id: "run", type: "prompt", message: "/doctor --json" });
	const notify = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).trimStart().startsWith("{"),
		90_000,
	);
	const report = JSON.parse(String(notify.message)) as DoctorReport;
	assert.ok(validateDoctorReport(report).ok, "/doctor --json emitted an off-contract report");
	return report;
}

test(
	"bridge launcher: --no-extensions + command-post reports zero foreign tools",
	{ timeout: 120_000 },
	async (t) => {
		const report = await doctorJsonFromRpc(t, [...PARENT_BRIDGE_FLAGS, "-e", COMMAND_POST_EXTENSION]);
		const finding = find(report, "session.tools")[0];
		assert.equal(finding?.severity, "ok", finding?.what);
		assert.match(finding?.what ?? "", /no foreign tools/);
	},
);

test(
	"a file-reading foreign tool is named as outside guard coverage",
	{ timeout: 120_000 },
	async (t) => {
		const report = await doctorJsonFromRpc(t, [
			"--no-extensions",
			"-e",
			COMMAND_POST_EXTENSION,
			"-e",
			FOREIGN_FILE_TOOL,
		]);
		const finding = find(report, "session.tools")[0];
		assert.equal(finding?.severity, "warn", finding?.what);
		assert.match(finding?.detail ?? finding?.what ?? "", /lens_read/);
		assert.match(finding?.detail ?? "", /outside guard coverage/);
		assert.match(finding?.fix ?? "", /--no-extensions/);
	},
);

test("an invalid report is a crash, never a rendered lie", () => {
	assert.ok(DoctorError.prototype instanceof Error);
	const result = validateDoctorReport({ schema_version: SCHEMA_VERSION });
	assert.equal(result.ok, false);
});

test("cp-txbb: a cp-daemon home with the 6 legacy units left over keeps the parent's /doctor report valid (service.legacy_units lists them in detail)", async (t) => {
	const home = fixture(t);
	const unitDir = join(home.home.path, "xdg", "systemd/user");
	mkdirSync(unitDir, { recursive: true });
	const units = ["cp-parent.service", "cp-view.service", "cp-health.service", "cp-health.timer", "cp-update.service", "cp-update.timer", "cp-operator.service"];
	for (const name of units) writeFileSync(join(unitDir, name), `ExecStart="${process.execPath}" x\n`);
	const paths = daemonPaths(home.home.path);
	mkdirSync(paths.dataDir, { recursive: true });
	writeFileSync(paths.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "systemd", node: process.execPath, app: home.home.path, home: home.home.path, path: "/bin", port: 7300 }));
	const report = await home.doctor({ run: healthyRunner({ "systemctl --user is-active": { stdout: "active\n" } }), serviceEnv: { XDG_CONFIG_HOME: join(home.home.path, "xdg"), PI_HOME: join(home.home.path, "pi") } });
	assert.ok(validateDoctorReport(report).ok, "the bridge diagnostic path validates the same report");
	const legacy = find(report, "service.legacy_units")[0]!;
	assert.equal(legacy.severity, "warn");
	assert.equal(legacy.what, `6 legacy unit(s) in ${unitDir}`);
	for (const name of units.slice(0, 6)) assert.match(legacy.detail ?? "", new RegExp(name.replace(".", "\\.")));
	assert.equal(find(report, "service.daemon")[0]?.severity, "ok");
	assert.equal(find(report, "service.node")[0]?.what, "the node binary cp-daemon runs exists");
});

// ---------------------------------------------------------------------------
// cp-epy2 §4.2: the parent lock and the worktree pool
// ---------------------------------------------------------------------------

/** A registry with one project, so the pool check has something to ask about. */
function registerDemo(homePath: string): void {
	writeFileSync(
		join(homePath, LAYOUT.projectsFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-08-27T11:00:00Z",
			projects: [
				{
					name: "demo",
					clone_url: "git@example.com:o/demo.git",
					delivery: "pr",
					registered_at: "2026-08-27T11:00:00Z",
				},
			],
		}),
	);
}

test("parent.lock: absent is ok, a live foreign holder and a stale one are findings", async (t) => {
	const home = fixture(t);
	// Absent: the ordinary case for a home nobody has started a parent in.
	const none = await home.doctor();
	assert.equal(find(none, "parent.lock")[0]?.severity, "ok");
	assert.match(find(none, "parent.lock")[0]?.what ?? "", /no parent lock/);

	const lockPath = join(home.home.path, LAYOUT.parentLock);
	mkdirSync(join(home.home.path, LAYOUT.state), { recursive: true });
	const write = (pid: number) =>
		writeFileSync(
			lockPath,
			`${JSON.stringify({ schema_version: SCHEMA_VERSION, pid, started_at: "2026-08-27T11:00:00Z", home: home.home.path })}\n`,
		);

	// A live holder that is not this process: one parent per home is a contract.
	write(4242);
	const live = await home.doctor({ isPidAlive: () => true });
	const liveFinding = find(live, "parent.lock")[0];
	assert.equal(liveFinding?.severity, "warn");
	assert.match(liveFinding?.what ?? "", /another parent process holds this home \(pid 4242\)/);
	assert.match(liveFinding?.fix ?? "", /one parent per home/);

	// A dead holder: reclaimable, and doctor says by whom.
	const stale = await home.doctor({ isPidAlive: () => false });
	const staleFinding = find(stale, "parent.lock")[0];
	assert.equal(staleFinding?.severity, "warn");
	assert.match(staleFinding?.what ?? "", /stale parent lock: pid 4242 is not alive/);
	assert.match(staleFinding?.fix ?? "", /session_start reclaims it/);

	// Unreadable: refused rather than assumed free, so it must be visible.
	writeFileSync(lockPath, "not json at all\n");
	const junk = await home.doctor({ isPidAlive: () => true });
	const junkFinding = find(junk, "parent.lock")[0];
	assert.equal(junkFinding?.severity, "warn");
	assert.match(junkFinding?.fix ?? "", /rm /);

	// This session's own lock is not a fault.
	write(process.pid);
	const mine = await home.doctor({ isPidAlive: () => true });
	assert.equal(find(mine, "parent.lock")[0]?.severity, "ok");
	assert.match(find(mine, "parent.lock")[0]?.what ?? "", /held by this session/);
});

test("pool: a foreign worktree in a project's pool is a finding naming both paths", async (t) => {
	const home = fixture(t);
	const clone = join(home.home.path, LAYOUT.projects, "demo");
	mkdirSync(clone, { recursive: true });
	registerDemo(home.home.path);

	// One pool entry that belongs to this clone, one that belongs elsewhere.
	const mine = join(home.home.path, "pool", "1", "demo");
	const foreign = join(home.home.path, "pool", "2", "demo");
	for (const dir of [mine, foreign]) mkdirSync(dir, { recursive: true });
	const run: CommandRunner = (command, args, cwd) => {
		if (command === "treehouse" && args.includes("status")) {
			return { status: 0, stdout: JSON.stringify([{ path: mine }, { path: foreign }]), stderr: "" };
		}
		if (command === "git" && args[0] === "rev-parse") {
			const common = cwd === foreign ? "/somewhere/else/demo/.git" : `${clone}/.git`;
			return { status: 0, stdout: `${common}\n`, stderr: "" };
		}
		return healthyRunner()(command, args, cwd);
	};
	const report = await home.doctor({ run });
	const finding = find(report, "pool.demo")[0];
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.what ?? "", /1 worktree\(s\) in demo's pool belong to another clone/);
	assert.ok(finding?.detail?.includes(foreign), "the finding names the foreign worktree");
	assert.ok(finding?.detail?.includes("/somewhere/else/demo/.git"), "and the clone it really belongs to");
	assert.match(finding?.fix ?? "", /CP_TREEHOUSE_ROOT/);
});

test("pool: a pool that is all ours is ok, and no pool at all is silent", async (t) => {
	const home = fixture(t);
	const clone = join(home.home.path, LAYOUT.projects, "demo");
	const mine = join(home.home.path, "pool", "1", "demo");
	mkdirSync(mine, { recursive: true });
	registerDemo(home.home.path);

	const ours: CommandRunner = (command, args, cwd) => {
		if (command === "treehouse" && args.includes("status")) {
			return { status: 0, stdout: JSON.stringify([{ path: mine }]), stderr: "" };
		}
		if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${clone}/.git\n`, stderr: "" };
		return healthyRunner()(command, args, cwd);
	};
	mkdirSync(clone, { recursive: true });
	const ok = await home.doctor({ run: ours });
	assert.equal(find(ok, "pool.demo")[0]?.severity, "ok");

	// An empty pool, a treehouse that fails, and unparseable output are all
	// questions doctor could not ask — never a fault it invents.
	for (const stdout of ["[]", "not json", ""]) {
		const empty = await home.doctor({
			run: (command, args, cwd) =>
				command === "treehouse" && args.includes("status")
					? { status: 0, stdout, stderr: "" }
					: ours(command, args, cwd),
		});
		assert.deepEqual(find(empty, "pool.demo"), [], `expected silence for ${JSON.stringify(stdout)}`);
	}
	const failed = await home.doctor({
		run: (command, args, cwd) =>
			command === "treehouse" && args.includes("status") ? { status: 1, stdout: "", stderr: "no pool" } : ours(command, args, cwd),
	});
	assert.deepEqual(find(failed, "pool.demo"), []);
	// And a home with no registry at all is silent too (the fixture default).
	const noRegistry = await fixture(t).doctor();
	assert.deepEqual(noRegistry.findings.filter((f) => f.check.startsWith("pool.")), []);
});

test("pool: the probe asks the same pool the leases come from (--root)", async (t) => {
	const home = fixture(t);
	const clone = join(home.home.path, LAYOUT.projects, "demo");
	mkdirSync(clone, { recursive: true });
	registerDemo(home.home.path);
	const calls: string[][] = [];
	const run: CommandRunner = (command, args, cwd) => {
		calls.push([command, ...args]);
		if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${clone}/.git\n`, stderr: "" };
		if (command === "treehouse" && args.includes("status")) return { status: 0, stdout: "[]", stderr: "" };
		return healthyRunner()(command, args, cwd);
	};

	await home.doctor({ run });
	assert.ok(
		calls.some((call) => call[0] === "treehouse" && call[1] === "status"),
		"with no pool root configured the argv carries no --root",
	);
	assert.ok(!calls.some((call) => call.includes("--root")));

	calls.length = 0;
	await new Doctor({
		home: home.home.path,
		packageRoot: REPO_ROOT,
		fleet: new FleetStore({ home: home.home.path }),
		run,
		which: ALL_PRESENT,
		env: {},
		now: () => NOW,
		poolRoot: "/pools/home-b",
	}).run();
	assert.ok(
		calls.some((call) => call[0] === "treehouse" && call[1] === "--root" && call[2] === "/pools/home-b"),
		`the pool root must reach treehouse: ${JSON.stringify(calls.filter((c) => c[0] === "treehouse"))}`,
	);
});
