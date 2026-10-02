import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatVersionLine, PACKAGE_ROOT, readPackageIdentity } from "../extensions/command-post/index.ts";
import { isInside, LAYOUT, LEDGER_PREFIX_PATTERN, NEVER_COMMIT_PATHS } from "../src/contracts.ts";
import { describeHome, isManagedInstall, isStandardApp, legacyManagedHome, resolveHome, standardHome } from "../src/home.ts";
import { formatScaffold, resolveLedgerPrefix, scaffoldHome } from "../src/scaffold.ts";
import { createScratchHome } from "./harness/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("PACKAGE_ROOT resolves to the repo root", () => {
	assert.equal(PACKAGE_ROOT, REPO_ROOT);
});

test("readPackageIdentity reads name and version from the manifest", () => {
	const identity = readPackageIdentity();
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		name: string;
		version: string;
	};
	assert.equal(identity.name, "pi-command-post");
	assert.equal(identity.version, manifest.version);
	assert.equal(identity.root, REPO_ROOT);
	assert.match(formatVersionLine(identity), /^pi-command-post \d+\.\d+\.\d+ \(root: \//);
});

test("readPackageIdentity fails closed on a missing manifest", () => {
	assert.throws(() => readPackageIdentity(join(REPO_ROOT, "does-not-exist")), /cannot read/);
});

test("pi manifest declares the parent extension and not the worker extension", () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		pi: { extensions: string[]; skills: string[]; prompts: string[] };
		keywords: string[];
	};
	assert.deepEqual(manifest.pi.extensions, ["./extensions/command-post/index.ts"]);
	// Recursion guard starts here: the worker extension is never manifest-loaded.
	assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("worker-reporter")));
	assert.ok(manifest.keywords.includes("pi-package"));
});

test("package directory skeleton exists", () => {
	for (const dir of [
		"extensions/command-post",
		"extensions/worker-reporter",
		"skills",
		"prompts",
		"profiles",
		"src",
		"docs",
		"tests",
	]) {
		assert.ok(existsSync(join(REPO_ROOT, dir)), `missing ${dir}`);
	}
});

test("gitignore keeps runtime state out of the repo", () => {
	const ignored = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8")
		.split("\n")
		.map((line) => line.trim());
	// cp-u3i2: exactly the one runtime root plus br's `.beads/`; the shipped
	// default rubric template now lives in tracked `defaults/`, so `data/` needs
	// no negation and no top-level entry at all.
	assert.deepEqual(NEVER_COMMIT_PATHS, [".pi-command-post/", ".beads/"]);
	for (const entry of [...NEVER_COMMIT_PATHS, "node_modules/"]) {
		assert.ok(ignored.includes(entry), `missing .gitignore entry ${entry}`);
	}
	for (const gone of ["/data/*", "!/data/routing.default.json", "state/", "projects/"]) {
		assert.ok(!ignored.includes(gone), `.gitignore still lists the old root ${gone}`);
	}
	assert.ok(existsSync(join(REPO_ROOT, "defaults/routing.default.json")), "the shipped default template lives in defaults/");
});

// ---------------------------------------------------------------------------
// T30: where the home is, and why
// ---------------------------------------------------------------------------

test("an installed package never keeps its state inside its own clone", () => {
	// The trap this exists to close: `pi install git:...` clones to
	// ~/.pi/agent/git/<host>/<path>, and pi "resets and cleans the clone" when it
	// reconciles a ref (docs/packages.md). A home in there loses the fleet, the
	// ledger, the run logs and every artifact on the next `pi update`.
	const installed = "/Users/someone/.pi/agent/git/github.com/user/pi-command-post";
	assert.equal(isManagedInstall(installed), true);
	const managed = describeHome({ HOME: "/Users/someone", PI_HOME: "/Users/someone/.pi" }, installed);
	assert.equal(managed.source, "managed");
	// cp-daemon v1 P1: the managed ~/.pi/command-post is retired; an installed package uses the standard home.
	assert.equal(managed.home, "/Users/someone/.pi-command-post");
	assert.equal(managed.home, standardHome({ HOME: "/Users/someone" }));
	assert.equal(legacyManagedHome({ PI_HOME: "/Users/someone/.pi" }), "/Users/someone/.pi/command-post");
	assert.ok(!isInside(managed.home, installed), "the home must be outside the clone pi resets");
	assert.match(managed.reason, /resets its clone on update/);

	// The standard home's own checkout resolves the standard home, never app/ itself.
	const standard = describeHome({ HOME: "/Users/someone" }, "/Users/someone/.pi-command-post/app");
	assert.equal(standard.source, "standard");
	assert.equal(standard.home, "/Users/someone/.pi-command-post");
	assert.equal(isStandardApp("/Users/someone/.pi-command-post/app", { HOME: "/Users/someone" }), true);
	assert.equal(isStandardApp(REPO_ROOT, { HOME: "/Users/someone" }), false);
	assert.equal(describeHome({ HOME: "/Users/someone", CP_HOME: "/tmp/fleet-two" }, "/Users/someone/.pi-command-post/app").source, "CP_HOME");

	// Every install location pi uses, plus a node_modules copy.
	for (const root of [
		"/x/.pi/agent/npm/node_modules/pi-command-post",
		"/x/project/.pi/git/github.com/user/repo",
		"/x/project/.pi/npm/node_modules/repo",
		"/x/project/node_modules/pi-command-post",
	]) {
		assert.equal(isManagedInstall(root), true, `${root} should be treated as installed`);
	}

	// A source checkout owns its own directory: state stays with it.
	assert.equal(isManagedInstall(REPO_ROOT), false);
	const checkout = describeHome({}, REPO_ROOT);
	assert.equal(checkout.source, "checkout");
	assert.equal(checkout.home, REPO_ROOT);

	// CP_HOME wins over both, because an operator may run several fleets.
	const override = describeHome({ CP_HOME: "/tmp/fleet-two" }, installed);
	assert.equal(override.source, "CP_HOME");
	assert.equal(override.home, "/tmp/fleet-two");
	assert.equal(resolveHome({ CP_HOME: "/tmp/fleet-two" }), "/tmp/fleet-two");
});

// ---------------------------------------------------------------------------
// T30: self-scaffold
// ---------------------------------------------------------------------------

test("scaffolding a fresh home creates what a dispatch needs, once", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const first = scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	assert.equal(first.already_ready, false);
	assert.deepEqual(
		first.steps.map((step) => [step.step, step.action]),
		[
			["dir.runtime", "created"],
			["dir.data", "created"],
			["dir.state", "created"],
			["dir.projects", "created"],
			["gitignore", "created"],
			["routing.default", "created"],
			["mandate-defaults", "created"],
			["ledger", "created"],
		],
	);
	for (const dir of [LAYOUT.data, LAYOUT.state, LAYOUT.projects, LAYOUT.runtimeDir]) {
		assert.ok(existsSync(join(home.path, dir)), `${dir} was not created`);
	}
	const ignored = readFileSync(join(home.path, ".gitignore"), "utf8");
	for (const entry of NEVER_COMMIT_PATHS) assert.ok(ignored.includes(entry), `.gitignore misses ${entry}`);
	assert.deepEqual(JSON.parse(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8")), { schema_version: 1, prefix: "cp", jobs: [] });
	const routingStep = first.steps.find((step) => step.step === "routing.default");
	assert.equal(routingStep?.action, "created");
	const copied = JSON.parse(readFileSync(join(home.path, LAYOUT.routingFile), "utf8"));
	// cp-routing-t4: six rows — the broad low-risk planner catch-all is gone.
	assert.equal(copied.rubric.length, 6);

	// Idempotent: a second call writes nothing and says so.
	const second = scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	assert.equal(second.already_ready, true);
	assert.ok(second.steps.every((step) => step.action === "present"));
	assert.match(formatScaffold(second), /^command post home ready \(CP_HOME\): /);
});

test("an existing jobs document is never rewritten, whatever the prefix in the environment says", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.runtimeDir), { recursive: true });
	const seeded = JSON.stringify({ schema_version: 1, prefix: "cps", jobs: [] }, null, 2);
	writeFileSync(join(home.path, LAYOUT.jobsFile), seeded);
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path, CP_LEDGER_PREFIX: "other" } });
	assert.equal(report.steps.find((step) => step.step === "ledger")?.action, "present");
	assert.equal(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8"), seeded);
});

test("an operator's own data/routing.json is never overwritten by the shipped default", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const mine = JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [] });
	writeFileSync(join(home.path, LAYOUT.routingFile), mine);

	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, ledger: false });
	assert.equal(report.steps.find((step) => step.step === "routing.default")?.action, "present");
	assert.equal(readFileSync(join(home.path, LAYOUT.routingFile), "utf8"), mine);
});

test("a package root with no shipped default is a skip, not a failure", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const emptyPackageRoot = mkdtempSync(join(tmpdir(), "cp-no-template-"));
	t.after(() => rmSync(emptyPackageRoot, { recursive: true, force: true }));

	const report = scaffoldHome({
		home: home.path,
		env: { CP_HOME: home.path },
		ledger: false,
		packageRoot: emptyPackageRoot,
	});
	const routingStep = report.steps.find((step) => step.step === "routing.default");
	assert.equal(routingStep?.action, "skipped");
	assert.ok(!existsSync(join(home.path, LAYOUT.routingFile)));
	assert.ok(!report.steps.some((step) => step.action === "failed"));
});

test("a home's own .gitignore is never rewritten", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeFileSync(join(home.path, ".gitignore"), "# mine\n");
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	assert.equal(readFileSync(join(home.path, ".gitignore"), "utf8"), "# mine\n");
	assert.equal(report.steps.find((step) => step.step === "gitignore")?.action, "present");
});

test("the ledger step can be turned off for a home that will never dispatch", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, ledger: false });
	assert.ok(!report.steps.some((step) => step.step === "ledger"));
	assert.ok(!existsSync(join(home.path, LAYOUT.jobsFile)));
});

// ---------------------------------------------------------------------------
// cp-epy2 §4.2: a per-home br prefix (CP_LEDGER_PREFIX)
//
// The prefix is the first component of every job id, and a job id **is** the
// git branch a worker pushes. Two homes both minting `cp-…` against one remote
// can mint the same branch name for two different jobs (cp-b8el), so a home
// that shares a machine gets its own namespace. Unset must stay `cp`.
// ---------------------------------------------------------------------------

test("CP_LEDGER_PREFIX unset or empty: the document is created with prefix cp", (t) => {
	for (const env of [{}, { CP_LEDGER_PREFIX: "" }, { CP_LEDGER_PREFIX: "   " }]) {
		const home = createScratchHome();
		scaffoldHome({ home: home.path, env: { CP_HOME: home.path, ...env } });
		assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8")).prefix, "cp");
		home.cleanup();
	}
	assert.deepEqual(resolveLedgerPrefix({}), { prefix: "cp" });
	assert.deepEqual(resolveLedgerPrefix({ CP_LEDGER_PREFIX: "" }), { prefix: "cp" });
});

test("CP_LEDGER_PREFIX=cps: the document records that prefix", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path, CP_LEDGER_PREFIX: "cps" } });
	assert.equal(report.steps.find((step) => step.step === "ledger")?.action, "created");
	assert.match(report.steps.find((step) => step.step === "ledger")?.detail ?? "", /prefix cps/);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8")).prefix, "cps");
	assert.deepEqual(resolveLedgerPrefix({ CP_LEDGER_PREFIX: "cps" }), { prefix: "cps" });
});

test("an invalid CP_LEDGER_PREFIX is refused and no document is written", (t) => {
	for (const bad of ["CP", "1cp", "toolongprefix", "cp-x", "c p"]) {
		const home = createScratchHome();
		const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path, CP_LEDGER_PREFIX: bad } });
		const ledger = report.steps.find((step) => step.step === "ledger");
		assert.equal(ledger?.action, "failed", `${bad} must be refused`);
		assert.match(ledger?.detail ?? "", new RegExp(LEDGER_PREFIX_PATTERN.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
		assert.ok(!existsSync(join(home.path, LAYOUT.jobsFile)), `a document was written for ${bad}`);
		home.cleanup();
	}
	assert.ok("error" in resolveLedgerPrefix({ CP_LEDGER_PREFIX: "cp-x" }));
});
