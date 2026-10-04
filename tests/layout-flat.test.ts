/**
 * The flat standard home, configured for real (cp-daemon v1 P1). A home named
 * `.pi-command-post` is its own runtime root. Lives in its own file because
 * `configureLayout` is process-global: this is the one process that sees it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureLayout, currentRuntimeDir, LAYOUT, layoutFor, layoutForHome, paths, runtimeDirFor, runtimeRootFor } from "../src/contracts.ts";
import { Doctor } from "../src/doctor.ts";
import { MEMORY_FILES } from "../src/memory.ts";
import { FleetStore } from "../src/fleet.ts";
import { resolveRuntime } from "../src/mode.ts";
import { scaffoldHome } from "../src/scaffold.ts";
import { storageFindings } from "../src/storage.ts";
import { fleetJobs, readLedger, resolveStateDir, runtimeRoot } from "../src/viewer/sessions.ts";
import { REPO_ROOT } from "./harness/index.ts";

const root = mkdtempSync(join(tmpdir(), "cp-flat-"));
const home = join(root, ".pi-command-post");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("the runtime root rule is the basename, and the viewer's contracts-free copy agrees", () => {
	assert.equal(runtimeDirFor(home), "");
	assert.equal(runtimeDirFor(`${home}/`), "");
	assert.equal(runtimeDirFor(root), ".pi-command-post");
	assert.equal(runtimeDirFor("/work/pi-command-post"), ".pi-command-post");
	for (const dir of [home, root, "/work/pi-command-post", "/x/.pi-command-post"]) {
		assert.equal(runtimeRoot(dir), runtimeRootFor(dir), dir);
		assert.equal(resolveStateDir(dir), join(dir, layoutForHome("multi", dir).state), dir);
	}
	assert.equal(layoutFor("multi", "").state, "state", "a flat runtime dir is the root itself");
});

test("configureLayout(multi, flat home) puts every path directly under the home; nothing else may reconfigure it", () => {
	configureLayout("multi", home);
	assert.equal(currentRuntimeDir(), "");
	assert.equal(LAYOUT.runtimeDir, "");
	assert.equal(LAYOUT.state, "state");
	assert.equal(LAYOUT.data, "data");
	assert.equal(LAYOUT.projects, "projects");
	assert.equal(LAYOUT.jobsFile, "jobs.json");
	assert.equal(LAYOUT.operatorWorkspace, "operator");
	assert.equal(LAYOUT.fleetFile, "state/fleet.json");
	assert.equal(paths.runDir("cp-a1b2"), "state/runs/cp-a1b2");
	assert.equal(paths.projectDir("demo"), "projects/demo");
	assert.ok(Object.isFrozen(LAYOUT));
	configureLayout("multi", `${home}/`); // idempotent: same mode, same runtime root
	assert.throws(() => configureLayout("multi"), /runtime root ""; cannot switch to ".pi-command-post"/);
	assert.throws(() => configureLayout("multi", root), /runtime root/);
	// MEMORY_FILES was imported before configureLayout ran: its getters must follow the configured (flat) layout,
	// never the default nested one captured at import time.
	assert.ok(MEMORY_FILES.length > 0);
	for (const file of MEMORY_FILES) {
		assert.ok(file.path.startsWith("data/"), `${file.key}: ${file.path} is not under the flat data/`);
	}
	assert.equal(MEMORY_FILES.find((file) => file.key === "learnings")?.path, LAYOUT.learningsFile);
});

test("a flat home scaffolds data/, state/, projects/ and the ledger directly: no dotdir, no .gitignore, idempotent", () => {
	configureLayout("multi", home);
	const first = scaffoldHome({ home, env: {}, packageRoot: REPO_ROOT });
	assert.deepEqual(
		first.steps.map((step) => [step.step, step.action]),
		[
			["dir.data", "created"],
			["dir.state", "created"],
			["dir.projects", "created"],
			["routing.default", "created"],
			["mandate-defaults", "created"],
			["ledger", "created"],
		],
	);
	for (const entry of ["data", "state", "projects", "jobs.json", "data/routing.json"]) {
		assert.ok(existsSync(join(home, entry)), `${entry} is missing`);
	}
	assert.ok(!existsSync(join(home, ".pi-command-post")), "no nested runtime dotdir");
	assert.ok(!existsSync(join(home, ".gitignore")), "a flat home is not a repository");
	const second = scaffoldHome({ home, env: {}, packageRoot: REPO_ROOT });
	assert.equal(second.already_ready, true);
});

test("a flat home passes doctor's scaffold and storage checks, app/ and settings.json included", async () => {
	configureLayout("multi", home);
	scaffoldHome({ home, env: {}, packageRoot: REPO_ROOT });
	mkdirSync(join(home, "app"), { recursive: true });
	writeFileSync(join(home, "settings.json"), JSON.stringify({ schema_version: 1, mode: "multi" }));
	mkdirSync(join(home, ".beads"), { recursive: true });
	const noRun = () => assert.fail("a home without .git never runs git");
	assert.deepEqual(storageFindings(home, noRun).map((f) => [f.check, f.severity]), [["storage", "ok"]]);
	writeFileSync(join(home, "stray.md"), "notes\n");
	const [stray] = storageFindings(home, noRun);
	assert.equal(stray?.check, "storage.home");
	assert.equal(stray?.detail, "stray.md");
	rmSync(join(home, "stray.md"));

	const runtime = resolveRuntime({ cwd: home, env: { CP_HOME: home }, packageRoot: "/nonexistent/package/root" });
	assert.deepEqual([runtime.mode, runtime.home], ["multi", home]);
	const report = await new Doctor({
		home,
		packageRoot: REPO_ROOT,
		fleet: new FleetStore({ home }),
		runtime,
		which: (command) => [`/usr/local/bin/${command}`],
		run: (command, args) => (args[0] === "--version" ? { status: 0, stdout: `${command} 1.0.0`, stderr: "" } : { status: 0, stdout: "", stderr: "" }),
		env: { CP_HOME: home },
	}).run();
	for (const check of ["scaffold.data", "scaffold.state", "scaffold.projects", "storage"]) {
		assert.equal(report.findings.find((f) => f.check === check)?.severity, "ok", check);
	}
	assert.ok(!report.findings.some((f) => f.check === "home.gitignore"), "no .gitignore to check");
});

test("the viewer reads a flat home's fleet and ledger", () => {
	configureLayout("multi", home);
	scaffoldHome({ home, env: {}, packageRoot: REPO_ROOT });
	writeFileSync(join(home, LAYOUT.fleetFile), JSON.stringify({ jobs: [{ job_id: "cp-a", project: "demo", phase: "held" }] }));
	const ledger = JSON.parse(readFileSync(join(home, LAYOUT.jobsFile), "utf8")) as { jobs: unknown[] };
	ledger.jobs.push({ id: "cp-a", title: "Flat", status: "open", labels: [] });
	writeFileSync(join(home, LAYOUT.jobsFile), JSON.stringify(ledger));
	const state = { home, stateDir: resolveStateDir(home) };
	assert.equal(state.stateDir, `${home}/state`);
	assert.deepEqual(fleetJobs(state).map((job) => job.job_id), ["cp-a"]);
	assert.deepEqual(readLedger(state).get("cp-a"), { title: "Flat", status: "open" });
});
