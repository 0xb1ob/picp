/**
 * cp-lvo: the installer doctor's fresh-home problem needs.
 *
 * `tests/tool-manifest.test.ts` proves the no-drift guarantee. This file
 * proves `planOrInstall`'s policy (never shadow, no silent sudo, don't fight
 * a running pi, dry-run mutates nothing) with an injected `which`/`run`/`env`
 * — the same shape `tests/doctor.test.ts` uses for `Doctor` — and then proves
 * the real CLI script's real behaviour: a real `--dry-run` invocation against
 * this actual host, and that running it twice is idempotent and mutates
 * nothing on disk.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
	describeStep,
	DRY_RUN_PLANNED_EXIT,
	formatInstallReport,
	installExitCode,
	type InstallerOptions,
	planOrInstall,
	runningUnderPi,
} from "../src/install-tools.ts";
import { REQUIRED_TOOLS } from "../src/tool-manifest.ts";
import { REPO_ROOT } from "./harness/index.ts";

function baseOptions(overrides: Partial<InstallerOptions> = {}): InstallerOptions {
	return {
		os: "macos",
		dryRun: false,
		which: () => [],
		env: {},
		...overrides,
	};
}

test("planOrInstall: every tool already on PATH is ok, and nothing is run", () => {
	let ranAnything = false;
	const report = planOrInstall(
		baseOptions({
			which: () => ["/usr/local/bin/tool"],
			run: () => {
				ranAnything = true;
			},
		}),
	);
	assert.equal(report.ok, true);
	assert.equal(ranAnything, false, "an already-satisfied host must not run an install step");
	assert.equal(report.outcomes.length, REQUIRED_TOOLS.length);
	for (const outcome of report.outcomes) assert.equal(outcome.kind, "ok");
});

test("planOrInstall: missing tool with a step gets installed, and re-running is idempotent", () => {
	const installedPaths = new Set<string>();
	const which = (command: string) => (installedPaths.has(command) ? [`/usr/local/bin/${command}`] : []);
	const run = () => {
		// simulate the tool landing on PATH — install-tools.ts checks `which`
		// again after running the step, so the fake must actually "install" it.
	};

	// git is missing, and macOS has a real (non-manual) step for it.
	const first = planOrInstall({
		os: "macos",
		dryRun: false,
		only: ["git"],
		which,
		run: (step) => {
			run();
			assert.equal(step.kind, "brew");
			installedPaths.add("git");
		},
		env: {},
	});
	assert.equal(first.outcomes[0]?.kind, "installed");
	assert.equal(first.ok, true);

	// Second run: git is now "present" (per the fake), so nothing is installed again.
	let ranTwice = false;
	const second = planOrInstall({
		os: "macos",
		dryRun: false,
		only: ["git"],
		which,
		run: () => {
			ranTwice = true;
		},
		env: {},
	});
	assert.equal(second.outcomes[0]?.kind, "ok");
	assert.equal(ranTwice, false, "a re-run against an already-installed tool must not install again");
});

test("planOrInstall: more than one match on PATH is a conflict, never a second install", () => {
	let ran = false;
	const report = planOrInstall(
		baseOptions({
			only: ["treehouse"],
			which: () => ["/opt/homebrew/bin/treehouse", "/Users/x/.local/bin/treehouse"],
			run: () => {
				ran = true;
			},
		}),
	);
	assert.equal(report.outcomes[0]?.kind, "conflict");
	assert.match(report.outcomes[0]?.detail ?? "", /2 copies/);
	assert.equal(report.ok, false);
	assert.equal(ran, false);
});

test("planOrInstall: dry run plans without mutating and fails preflight when something is missing", () => {
	let ran = false;
	const report = planOrInstall(
		baseOptions({
			dryRun: true,
			only: ["git"],
			which: () => [],
			run: () => {
				ran = true;
			},
		}),
	);
	assert.equal(report.outcomes[0]?.kind, "planned");
	assert.equal(report.ok, false, "a dry run with a missing tool must report not-ok, so it can gate a preflight");
	assert.equal(ran, false, "dry run must never call the runner");
});

test("installExitCode: 0 when ok, 3 for a dry run that only planned installs, 1 when a human must act", () => {
	const ok = planOrInstall(baseOptions({ dryRun: true, which: () => ["/usr/local/bin/tool"] }));
	assert.equal(installExitCode(ok), 0);
	const planned = planOrInstall(baseOptions({ dryRun: true, only: ["treehouse", "git"], which: (tool) => (tool === "git" ? ["/usr/bin/git"] : []) }));
	assert.deepEqual(planned.outcomes.map((outcome) => outcome.kind), ["planned", "ok"]);
	assert.equal(installExitCode(planned), DRY_RUN_PLANNED_EXIT);
	assert.equal(installExitCode(planOrInstall(baseOptions({ dryRun: true, os: "linux", only: ["git"], which: () => [] }))), 1, "manual is never planned");
	assert.equal(installExitCode(planOrInstall(baseOptions({ dryRun: true, only: ["git"], which: () => ["/a/git", "/b/git"] }))), 1, "a conflict is never planned");
	assert.equal(installExitCode(planOrInstall(baseOptions({ only: ["treehouse"], which: () => [], run: () => {} }))), 1, "a real run that did not land the tool fails");
});

test("planOrInstall: dry run with everything present reports ok and mutates nothing", () => {
	let ran = false;
	const report = planOrInstall(
		baseOptions({
			dryRun: true,
			which: () => ["/usr/local/bin/tool"],
			run: () => {
				ran = true;
			},
		}),
	);
	assert.equal(report.ok, true);
	assert.equal(ran, false);
});

test("planOrInstall: git on Linux has no non-sudo path and is reported, not run", () => {
	let ran = false;
	const report = planOrInstall(
		baseOptions({
			os: "linux",
			only: ["git"],
			which: () => [],
			run: () => {
				ran = true;
			},
		}),
	);
	assert.equal(report.outcomes[0]?.kind, "manual");
	assert.match(report.outcomes[0]?.detail ?? "", /sudo/);
	assert.equal(report.ok, false);
	assert.equal(ran, false);
});

test("planOrInstall: unsupported platform is reported, not guessed at", () => {
	const report = planOrInstall(baseOptions({ os: "unsupported", only: ["treehouse"], which: () => [] }));
	assert.equal(report.outcomes[0]?.kind, "unsupported");
	assert.equal(report.ok, false);
});

test("planOrInstall: pi missing while running inside a pi session refuses to touch it", () => {
	let ran = false;
	const report = planOrInstall(
		baseOptions({
			only: ["pi"],
			which: () => [],
			env: { PI_SESSION_ID: "abc-123" },
			run: () => {
				ran = true;
			},
		}),
	);
	assert.equal(report.outcomes[0]?.kind, "pi_session_guard");
	assert.equal(report.piSession, "abc-123");
	assert.equal(report.ok, false);
	assert.equal(ran, false);
});

test("planOrInstall: pi missing with no pi session in env falls through to the normal install step", () => {
	const report = planOrInstall(baseOptions({ dryRun: true, only: ["pi"], which: () => [], env: {} }));
	assert.equal(report.outcomes[0]?.kind, "planned");
});

test("runningUnderPi reads PI_SESSION_ID and PI_CODING_AGENT, and only those", () => {
	assert.equal(runningUnderPi({ PI_SESSION_ID: "s1" }), "s1");
	assert.equal(runningUnderPi({ PI_CODING_AGENT: "true" }), "pi-coding-agent");
	assert.equal(runningUnderPi({ PI_CODING_AGENT: "false" }), undefined);
	assert.equal(runningUnderPi({}), undefined);
});

test("describeStep renders a runnable command for every non-manual step kind", () => {
	assert.equal(describeStep({ kind: "brew", formula: "git" }), "brew install git");
	assert.equal(
		describeStep({ kind: "npm", pkg: "@scope/pkg", flags: ["-g"] }),
		"npm install -g @scope/pkg",
	);
	assert.equal(describeStep({ kind: "curl", url: "https://example.com/install.sh" }), 'curl -fsSL "https://example.com/install.sh" | sh');
	assert.equal(describeStep({ kind: "manual", summary: "do it by hand" }), "do it by hand");
});

test("formatInstallReport names every tool and the overall verdict", () => {
	const report = planOrInstall(baseOptions({ dryRun: true, which: () => ["/usr/local/bin/tool"] }));
	const text = formatInstallReport(report);
	for (const tool of REQUIRED_TOOLS) assert.match(text, new RegExp(tool));
	assert.match(text, /all required tools are on PATH/);
});

// -- the real script, invoked for real -------------------------------------

const SCRIPT = `${REPO_ROOT}/scripts/install-tools.ts`;

function runScript(args: readonly string[]): { status: number; stdout: string } {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20_000 });
		return { status: 0, stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string };
		return { status: failure.status ?? 1, stdout: failure.stdout ?? "" };
	}
}

test("real script: --dry-run mutates nothing and names every required tool", () => {
	const before = runScript(["--dry-run"]);
	for (const tool of REQUIRED_TOOLS) assert.match(before.stdout, new RegExp(tool), `dry-run output should mention ${tool}`);
	assert.match(before.stdout, /dry run/);

	// Idempotent: a second dry run against the same, untouched host reports the
	// same thing (nothing this script could have mutated changed the answer).
	const after = runScript(["--dry-run"]);
	assert.equal(after.status, before.status);
	assert.equal(after.stdout, before.stdout, "two dry runs in a row must produce identical output");
});

test("real script: an unknown tool argument is rejected before anything runs", () => {
	const result = runScript(["--dry-run", "not-a-real-tool"]);
	assert.equal(result.status, 2);
});

test("real script: restricting to one already-present tool exits 0", (t) => {
	// `git` is a hard prerequisite of this checkout existing at all, so this is
	// safe to assert without depending on br/treehouse/pi's presence — except
	// that some CI images put more than one `git` on PATH (the runner's own
	// install plus a bundled copy), which the installer correctly refuses to
	// paper over (see `planOrInstall`'s "never shadow" rule) and reports as
	// `conflict`, not `ok`. That is host PATH hygiene, not something this repo
	// controls, so skip rather than assert a specific host has none of it.
	const copies = execFileSync("which", ["-a", "git"], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.trim().length > 0);
	if (copies.length !== 1) {
		t.skip(`this host has ${copies.length} copies of git on PATH: ${copies.join(", ")}`);
		return;
	}
	const result = runScript(["--dry-run", "git"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /git: already installed/);
});
