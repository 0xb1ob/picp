/**
 * T30 acceptance: the clean-machine simulation.
 *
 * The question this answers is the one an operator actually faces: *I cloned
 * this and pointed pi at it — does it work, and where does my state go?* So the
 * package under test is a **fresh git clone** of this repository in a temp
 * directory, with no `node_modules` of its own (pi bundles the five peer
 * packages) and no `data/`, `state/`, `projects/` or ledger.
 *
 * What is proven:
 *  1. the package loads in a real pi process from a clone that has never had an
 *     `npm install`;
 *  2. `session_start` scaffolds the home — dirs, .gitignore, and an empty jobs
 *     ledger — and says what it did;
 *  3. the fleet tools and commands are actually registered (a package that
 *     loads but registers nothing is not installed, it is inert);
 *  4. `/doctor` runs on the fresh home and reports it as dispatchable;
 *  5. running it a second time changes nothing (scaffolding is idempotent);
 *  6. an *installed* package's home lands outside the clone pi resets on update.
 *
 * `node --test tests/e2e/packaging.test.ts`
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { DoctorReport } from "../../src/contracts.ts";
import { describeHome } from "../../src/home.ts";
import { hostPiVersionConflict, REPO_ROOT, startRpc, treehouseAvailable } from "../harness/index.ts";
import { LAYOUT } from "../../src/contracts.ts";

interface CleanMachine {
	/** A copy of this checkout's tracked files: the package, as installed. */
	clone: string;
	/** A fresh, empty home. */
	home: string;
	cleanup(): void;
}

/**
 * `standard` (cp-daemon v1 P1) places the package where the installer does,
 * `<HOME>/.pi-command-post/app`, and the home is the flat standard home around
 * it; `env` is what that session needs (a scratch `HOME`, no `CP_HOME`).
 */
function cleanMachine(shape: "cp-home" | "standard" = "cp-home"): CleanMachine & { env: NodeJS.ProcessEnv } {
	const root = mkdtempSync(join(tmpdir(), "cp-clean-"));
	const standard = shape === "standard";
	const clone = standard ? join(root, ".pi-command-post", "app") : join(root, "package");
	const home = standard ? join(root, ".pi-command-post") : join(root, "home");
	const env: NodeJS.ProcessEnv = standard ? { HOME: root, CP_HOME: "", CP_MODE: "" } : { CP_HOME: home };
	// The package is every **tracked** file of this checkout, copied out: what an
	// operator would install from this state of the repository, including work that
	// is not committed yet. (Cloning HEAD instead would silently test the previous
	// release — which is how this test first passed while proving nothing.)
	// Deliberately no `npm install` and no runtime dirs: pi bundles the five peer
	// packages, so a package that needs an install to *load* is a packaging bug
	// this test must catch.
	// `--others --exclude-standard` includes files that are new but not ignored:
	// a module added in this change is part of the package even before it is
	// committed, and a simulation that skipped it would test the previous release.
	const tracked = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	)
		.split("\0")
		.filter((entry) => entry.length > 0);
	for (const file of tracked) {
		const target = join(clone, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(REPO_ROOT, file), target);
	}
	mkdirSync(home, { recursive: true });
	return {
		clone,
		home,
		env,
		cleanup() {
			rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		},
	};
}

test("clean machine: a fresh clone loads, scaffolds its home and is dispatchable", { timeout: 240_000 }, async (t) => {
	const machine = cleanMachine();
	t.after(() => machine.cleanup());

	assert.ok(!existsSync(join(machine.clone, "node_modules")), "the simulation must not rely on an npm install");
	for (const dir of ["data", "state", "projects", ".pi-command-post"]) {
		assert.ok(!existsSync(join(machine.home, dir)), `${dir}/ should not exist before the first session`);
	}

	const extension = join(machine.clone, "extensions/command-post/index.ts");
	// `--no-approve` (never trust project-local files) and `--no-session`: the
	// same trust posture every other suite uses, and the one an operator gets in
	// a directory they just cloned.
	const rpc = startRpc({
		cwd: machine.clone,
		args: ["--no-approve", "--no-session", "-e", extension],
		env: { CP_HOME: machine.home },
	});
	t.after(async () => {
		await rpc.close();
	});

	// 1. It loads, and the scaffold announces itself (the first session is the
	//    only one that has anything to say).
	const scaffolded = await rpc.waitFor(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			String(record.message).includes("command post home"),
		90_000,
	);
	const message = String(scaffolded.message);
	assert.match(message, /dir\.state: created/, message);
	assert.match(message, /dir\.projects: created/, message);
	assert.match(message, /ledger: created/, message);

	// 2. On disk, in the home the operator chose — never in the package.
	for (const dir of [LAYOUT.data, LAYOUT.state, LAYOUT.projects]) {
		assert.ok(existsSync(join(machine.home, dir)), `${dir}/ was not scaffolded`);
	}
	assert.ok(existsSync(join(machine.home, ".gitignore")), "a home without a .gitignore can leak the fleet");
	assert.match(readFileSync(join(machine.home, ".gitignore"), "utf8"), /^\.pi-command-post\//m);
	assert.ok(existsSync(join(machine.home, ".pi-command-post/jobs.json")), "the scaffold should have created the ledger");
	assert.ok(!existsSync(join(machine.clone, LAYOUT.state)), "nothing runtime is written into the package");

	// 3. The commands exist, and they come from the *clone*. A package that loads
	//    but registers nothing is inert, not installed. (pi has no "list tools"
	//    RPC command, so tool registration is asserted in-process by
	//    tests/contract.test.ts; here the surfaces a human touches are the proof,
	//    and each one's path shows which copy of the code answered.)
	rpc.send({ id: "cmds", type: "get_commands" });
	const commands = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds", 30_000)) as {
		success?: boolean;
		data?: { commands?: Array<{ name: string; sourceInfo?: { path?: string } }> };
	};
	assert.equal(commands.success, true, `get_commands failed: ${JSON.stringify(commands)}`);
	const registered = commands.data?.commands ?? [];
	const commandNames = registered.map((command) => command.name);
	for (const name of ["cp-version", "status", "doctor", "watch", "cp-awaiting", "memory"]) {
		assert.ok(commandNames.includes(name), `/${name} is not registered (have: ${commandNames.join(", ")})`);
	}
	const version = registered.find((command) => command.name === "cp-version");
	assert.ok(
		(version?.sourceInfo?.path ?? "").startsWith(machine.clone),
		`the command came from ${version?.sourceInfo?.path}, not from the package under test`,
	);

	// 4. Doctor's verdict on a machine that just installed this.
	//
	// Note for whoever sees this fail under `npm test` and not under `node --test`:
	// npm puts `node_modules/.bin` first on PATH, so the devDependency's `pi` and
	// the host `pi` both answer here. When they differ, `host.pi.conflict` fires
	// and it is *right* — the shell's PATH order really would decide which pi a
	// worker gets. The fix is to keep the pinned devDependency and the installed
	// pi on the same version (cp-q0g), not to soften the check.
	rpc.send({ id: "doctor", type: "prompt", message: "/doctor --json" });
	const doctorNotify = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).trimStart().startsWith("{"),
		120_000,
	);
	const report = JSON.parse(String(doctorNotify.message)) as DoctorReport;
	assert.equal(report.home, machine.home);
	// host.pi.conflict is a real finding about *this host*, not about the package:
	// npm puts the pinned devDependency's pi ahead of the installed one, and when
	// the two versions differ doctor is right to say PATH order decides. Exclude
	// exactly that finding here, with the reason printed; every other error still
	// fails the test.
	const piConflict = hostPiVersionConflict();
	if (piConflict) {
		console.log(`packaging: tolerating host.pi.conflict — more than one pi version on PATH (${piConflict})`);
	}
	const errors = report.findings.filter(
		(finding) => finding.severity === "error" && !(piConflict && finding.check === "host.pi.conflict"),
	);
	// "Dispatchable" is a claim about a host that actually has treehouse and
	// authenticated models — CI (ubuntu-latest, `npm ci` only, no `pi auth`) is
	// deliberately not that host, the same way it was never a `br` host before
	// this build dropped br. Assert the strict "zero errors" claim only where it
	// can be true; every other assertion in this test (scaffold, registration,
	// idempotence) still runs unconditionally on every machine, CI included.
	if (treehouseAvailable()) {
		assert.deepEqual(
			errors.map((finding) => finding.check),
			[],
			`a clean machine with the host tools installed should be dispatchable: ${errors.map((f) => `${f.check}: ${f.what}`).join("; ")}`,
		);
	} else {
		console.log(
			`packaging: treehouse not on PATH — skipping the "fully dispatchable" assertion (${errors.map((f) => f.check).join(", ") || "no errors anyway"})`,
		);
	}
	// Whatever else it says, the home is where we think it is and doctor knows why.
	const location = report.findings.find((finding) => finding.check === "home.location");
	assert.equal(location?.severity, "ok");
	assert.match(String(location?.what), /home \(CP_HOME\)/);
	for (const dir of ["data", "state", "projects"]) {
		assert.equal(
			report.findings.find((finding) => finding.check === `scaffold.${dir}`)?.severity,
			"ok",
			`${dir}/ should be reported present after the first session`,
		);
	}
});

test("clean machine: the second session changes nothing", { timeout: 240_000 }, async (t) => {
	const machine = cleanMachine();
	t.after(() => machine.cleanup());
	const extension = join(machine.clone, "extensions/command-post/index.ts");

	const first = startRpc({
		cwd: machine.clone,
		args: ["--no-approve", "--no-session", "-e", extension],
		env: { CP_HOME: machine.home },
	});
	await first.waitFor(
		(record) => record.type === "extension_ui_request" && String(record.message ?? "").includes("command post home"),
		90_000,
	);
	await first.close();
	const ledgerBefore = readFileSync(join(machine.home, ".pi-command-post/jobs.json"), "utf8");

	// A second session must not announce a scaffold, because there is nothing to
	// do: `session_start` speaks only when it created or failed something.
	const second = startRpc({
		cwd: machine.clone,
		args: ["--no-approve", "--no-session", "-e", extension],
		env: { CP_HOME: machine.home },
	});
	t.after(async () => {
		await second.close();
	});
	second.send({ id: "version", type: "prompt", message: "/cp-version" });
	const version = await second.waitFor(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			// H7: the /cp-version reply, not a "parent lock: reclaimed" notice first.
			String(record.message).includes("mode, home"),
		90_000,
	);
	assert.match(
		String(version.message),
		/multi-project mode, home .+ \(source: CP_HOME/,
		"cp-version names the mode, the home and why",
	);
	assert.ok(
		!second.records().some((record) => String(record.message ?? "").includes("dir.state: created")),
		"a scaffolded home must not be scaffolded again",
	);
	assert.equal(readFileSync(join(machine.home, ".pi-command-post/jobs.json"), "utf8"), ledgerBefore, "the ledger is untouched");
});

test("clean machine: an installed package keeps state outside the clone pi resets", () => {
	// No process needed: this is the rule that decides where the state of every
	// `pi install git:...` lands, and it is pure.
	const installed = "/Users/someone/.pi/agent/git/github.com/user/pi-command-post";
	const resolution = describeHome({ HOME: "/Users/someone", PI_HOME: "/Users/someone/.pi" }, installed);
	assert.equal(resolution.source, "managed");
	// cp-daemon v1 P1: the standard home, never the retired ~/.pi/command-post.
	assert.equal(resolution.home, "/Users/someone/.pi-command-post");
	assert.ok(!resolution.home.startsWith(installed));
});

test("clean machine: the standard app at ~/.pi-command-post/app scaffolds the flat standard home, once", { timeout: 240_000 }, async (t) => {
	const machine = cleanMachine("standard");
	const extension = join(machine.clone, "extensions/command-post/index.ts");
	const sessions: ReturnType<typeof startRpc>[] = [];
	const start = () => {
		const session = startRpc({ cwd: machine.clone, args: ["--no-approve", "--no-session", "-e", extension], env: machine.env });
		sessions.push(session);
		return session;
	};
	// Close every pi before removing the scratch HOME it writes into.
	t.after(async () => {
		for (const session of sessions) await session.close();
		machine.cleanup();
	});

	const first = start();
	const scaffolded = await first.waitFor(
		(record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes("command post home"),
		90_000,
	);
	const message = String(scaffolded.message);
	assert.match(message, /command post home \(standard\)/, message);
	assert.doesNotMatch(message, /dir\.runtime|gitignore/, message);
	for (const dir of ["data", "state", "projects", "jobs.json"]) {
		assert.ok(existsSync(join(machine.home, dir)), `${dir} was not scaffolded directly under the standard home`);
	}
	for (const absent of [".pi-command-post", ".gitignore"]) {
		assert.ok(!existsSync(join(machine.home, absent)), `a flat home has no ${absent}`);
	}
	assert.ok(!existsSync(join(machine.clone, LAYOUT.runtimeDir)), "app/ is never a home");
	await first.close();
	const ledgerBefore = readFileSync(join(machine.home, "jobs.json"), "utf8");

	const second = start();
	second.send({ id: "version", type: "prompt", message: "/cp-version" });
	const version = await second.waitFor(
		(record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes("mode, home"),
		90_000,
	);
	assert.match(String(version.message), /multi-project mode, home .+\.pi-command-post \(source: standard/);
	assert.ok(!second.records().some((record) => String(record.message ?? "").includes("dir.state: created")), "a scaffolded home must not be scaffolded again");
	assert.equal(readFileSync(join(machine.home, "jobs.json"), "utf8"), ledgerBefore, "the ledger is untouched");
});
