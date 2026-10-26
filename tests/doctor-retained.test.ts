/**
 * doctor.test.ts cases kept as units (P14c): the doctor-broken golden and the fixture guards that keep it hermetic,
 * the report contract, a Doctor with no model registry (every /doctor has one) or a
 * throwing pi probe (probePi never throws), and an unwritable scaffold (root's access(2) never refuses a write).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DoctorReport, LAYOUT, SCHEMA_VERSION, validateDoctorReport } from "../src/contracts.ts";
import { type CommandRunner, Doctor, type DoctorOptions, DoctorError, formatDoctor } from "../src/doctor.ts";
import { FleetStore } from "../src/fleet.ts";
import type { ModelProbe } from "../src/routing.ts";
import { assertGolden, createScratchHome, REPO_ROOT, type ScratchHome } from "./harness/index.ts";

const NOW = new Date("2026-08-27T12:00:00Z");

/** A healthy host: every tool present, one version each. */
function healthyRunner(overrides: Record<string, CommandResultLike> = {}): CommandRunner {
	return (command, args) => {
		const key = [command, ...args].join(" ");
		for (const [pattern, result] of Object.entries(overrides)) {
			if (key.includes(pattern)) return { status: 0, stdout: "", stderr: "", ...result };
		}
		if (args[0] === "--version") return { status: 0, stdout: `${basename(command)} 1.2.3\n`, stderr: "" };
		if (command === "npm" && args[0] === "view") return { status: 0, stdout: "{}", stderr: "" };
		if (command === "gh" && args[0] === "pr") return { status: 0, stdout: "[]", stderr: "" };
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

test("without a live registry, model availability is unprobed — never 'missing'", async (t) => {
	const report = await fixture(t).doctor();
	const finding = find(report, "models.probe")[0];
	assert.equal(finding?.severity, "ok");
	assert.match(finding?.what ?? "", /not probed/);
	assert.equal(report.ok, true);
});

test("an invalid report is a crash, never a rendered lie", () => {
	assert.ok(DoctorError.prototype instanceof Error);
	const result = validateDoctorReport({ schema_version: SCHEMA_VERSION });
	assert.equal(result.ok, false);
});

test("doctor reports a throwing pi probe as incompatible, not as unreadable piCompat", async (t) => {
	const home = fixture(t);
	const doctor = (packageRoot: string, piProbe: () => never) =>
		new Doctor({ home: home.home.path, packageRoot, fleet: new FleetStore({ home: home.home.path }), run: healthyRunner(), which: ALL_PRESENT, env: {}, now: () => NOW, piProbe }).run();
	const boom = (): never => {
		throw new Error("spawn exploded");
	};
	const [thrown] = find(await doctor(REPO_ROOT, boom), "host.pi.compat");
	assert.equal(thrown?.severity, "error");
	assert.match(thrown?.fix ?? "", /install a pi in the supported range/); // the incompatible state's fix, not old's
	assert.match(thrown?.what ?? "", /probe failed: spawn exploded/);
	assert.doesNotMatch(thrown?.what ?? "", /unreadable/);
	const empty = mkdtempSync(join(tmpdir(), "cp-nopkg-"));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	const [control] = find(await doctor(empty, boom), "host.pi.compat");
	assert.match(control?.what ?? "", /unreadable/);
});

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
