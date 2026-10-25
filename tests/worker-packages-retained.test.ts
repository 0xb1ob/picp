/**
 * Worker-package units kept verbatim from tests/worker-packages.test.ts: pi's own resolution of fixture layouts,
 * the docs the CLI flags rest on, frozen defaults, profile overrides, the resolution race and the spawn-site scan.
 * Why each stays: testing-migration/p8f.md; the e2e is tests/e2e/worker-packages-p8f.test.ts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROLES, type WorkerProfile } from "../src/contracts.ts";
import { loadProfile } from "../src/profiles.ts";
import { assertTrustPolicy, WorkerManager } from "../src/worker-manager.ts";
import {
	activePackagesForRole,
	type DetectedWorkerPackages,
	NO_DETECTED_WORKER_PACKAGES,
	NEVER_WORKER_RESOURCES,
	NO_OPTIONAL_WORKER_PACKAGES,
	OPTIONAL_WORKER_PACKAGES,
	resolveWorkerPackages,
	ROLE_PACKAGES,
	type WorkerPackageResolution,
} from "../src/worker-packages.ts";
import { buildWorkerArgs, type WorkerProcess, type WorkerSpawnOptions } from "../src/worker-process.ts";
import { REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

function scratchRoot(): string {
	return mkdtempSync(join(tmpdir(), "cp-optpkg-"));
}

/** Add a package source to the fixture agent dir's `settings.json`, as `pi install` would. */
function configure(agentDir: string, source: string | Record<string, unknown>): void {
	const file = join(agentDir, "settings.json");
	const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown[] }) : {};
	settings.packages = [...(settings.packages ?? []), source];
	writeFileSync(file, JSON.stringify(settings), "utf8");
}

/** Install a fake npm package with the given `pi` manifest into agent dir `root`, configured unless told not to. */
function installPackage(
	root: string,
	name: string,
	manifest: { extensions?: string[]; skills?: string[] },
	options: { createFiles?: boolean; configured?: boolean } = {},
): string {
	const dir = join(root, "npm/node_modules", ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	if (options.configured !== false) configure(root, `npm:${name}`);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: manifest }), "utf8");
	if (options.createFiles !== false) {
		for (const entry of manifest.extensions ?? []) {
			const file = join(dir, entry);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, "export default {};\n", "utf8");
		}
		for (const entry of manifest.skills ?? []) {
			mkdirSync(join(dir, entry), { recursive: true });
		}
	}
	return dir;
}

function installCaveman(root: string): string {
	return installPackage(root, "pi-caveman", { extensions: ["./extensions/caveman.ts"] });
}

function installPonytail(root: string): string {
	const dir = installPackage(root, "@dietrichgebert/ponytail", {
		extensions: ["./pi-extension/index.js"],
		skills: ["./skills"],
	});
	writeSkill(join(dir, "skills"), "ponytail");
	return dir;
}

// ---------------------------------------------------------------------------
// argv helpers: plan() and spawn() build the option object separately in
// worker-manager.ts, so every argv assertion below is made against BOTH.
// ---------------------------------------------------------------------------

function implementerProfile(): WorkerProfile {
	return loadProfile(PROFILES_DIR, "implementer");
}

/** A profile with an explicit `packages:` frontmatter override. */
function withPackages(profile: WorkerProfile, packages: string[]): WorkerProfile {
	return { ...profile, frontmatter: { ...profile.frontmatter, packages } };
}

function spawnRequest(profile: WorkerProfile = implementerProfile()) {
	const worktree = mkdtempSync(join(tmpdir(), "cp-optpkg-wt-"));
	return {
		identity: { jobId: "cp-opt", kind: "ship" as const, delivery: "local" as const, runDir: worktree, worktree },
		profile,
		model: "anthropic/claude-x",
	};
}

function managerWith(
	optionalPackages: DetectedWorkerPackages,
	spawnFn?: (options: WorkerSpawnOptions) => WorkerProcess,
): WorkerManager {
	// Hermetic: a PI_LENS_HOME the test process inherited (a worker has one) must not read as the pin under test,
	// nor a host mcp.json add the read-only workers' MCP gateway (cp-fl8b; P8b e2e 04-10 covers it).
	const { PI_LENS_HOME: _inherited, ...inherited } = process.env;
	const parentEnv = { ...inherited, PI_CODING_AGENT_DIR: join(tmpdir(), "cp-optpkg-no-agent-dir") };
	return new WorkerManager({
		home: "/unused",
		parentEnv,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		...(optionalPackages === NO_DETECTED_WORKER_PACKAGES ? {} : { optionalPackages }),
		...(spawnFn ? { spawnFn } : {}),
	});
}

function plannedArgs(
	optionalPackages: DetectedWorkerPackages = NO_DETECTED_WORKER_PACKAGES,
	profile?: WorkerProfile,
): string[] {
	const plan = managerWith(optionalPackages).plan(spawnRequest(profile));
	assertTrustPolicy(plan.args);
	return plan.args;
}

/** The argv the spawn path would exec, captured from `spawn()` itself. */
function spawnedArgs(
	optionalPackages: DetectedWorkerPackages = NO_DETECTED_WORKER_PACKAGES,
	profile?: WorkerProfile,
): string[] {
	let captured: WorkerSpawnOptions | undefined;
	const manager = managerWith(optionalPackages, (options) => {
		captured = options;
		return { pid: 1234, closed: Promise.resolve(0), kill: () => {} } as unknown as WorkerProcess;
	});
	manager.spawn(spawnRequest(profile));
	assert.ok(captured, "spawnFn must have been called");
	const args = buildWorkerArgs(captured as WorkerSpawnOptions);
	assertTrustPolicy(args);
	return args;
}

/** Both construction paths, asserted to agree, returning the shared argv. */
function argvBothWays(
	optionalPackages: DetectedWorkerPackages = NO_DETECTED_WORKER_PACKAGES,
	profile?: WorkerProfile,
): string[] {
	const planned = plannedArgs(optionalPackages, profile);
	assert.deepEqual(spawnedArgs(optionalPackages, profile), planned, "plan() and spawn() must build the same argv");
	return planned;
}

function flagValues(args: readonly string[], flag: string): string[] {
	return args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));
}

const STUB_PI = [
	'import { statSync } from "node:fs";',
	"const argv = process.argv.slice(2);",
	"for (let i = 0; i < argv.length; i++) {",
	'\tif (argv[i] === "-e") {',
	"\t\tconst path = argv[i + 1];",
	"\t\tconst stat = statSync(path);",
	"\t\tif (!stat.isFile()) {",
	"\t\t\tconsole.error(`-e wants an entry-point file, got a directory: ${path}`);",
	"\t\t\tprocess.exit(2);",
	"\t\t}",
	"\t}",
	'\tif (argv[i] === "--skill") statSync(argv[i + 1]);',
	"}",
	"process.exit(0);",
].join("\n");

/**
 * Prove the argv is really executable and that its resource arguments are the
 * shapes the CLI takes: a stub "pi" re-checks that every `-e` value is a
 * readable FILE (pi docs/extensions.md: `pi -e ./my-extension.ts`) and that
 * every `--skill` path exists (docs/skills.md: files or directories), and the
 * process must exit 0. This is a real spawn, not a shape assertion on a list.
 */
function assertArgvSpawns(args: readonly string[]): void {
	const stub = join(mkdtempSync(join(tmpdir(), "cp-optpkg-bin-")), "stub-pi.mjs");
	writeFileSync(stub, STUB_PI, "utf8");
	const result = spawnSync(process.execPath, [stub, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, `argv must spawn cleanly: ${result.stderr}`);
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

test("neither package installed: detection is empty and never throws", async () => {
	const root = scratchRoot();
	assert.deepEqual(await resolveWorkerPackages(root), {});
	// A root that does not exist at all is the same non-event.
	assert.deepEqual(await resolveWorkerPackages(join(root, "nope")), {});
});

test("both packages installed: extensions and skills are detected per package, from their own manifests", async () => {
	const root = scratchRoot();
	const caveman = installCaveman(root);
	const ponytail = installPonytail(root);
	assert.deepEqual(await resolveWorkerPackages(root), {
		"pi-caveman": { extensions: [join(caveman, "extensions/caveman.ts")], skills: [] },
		"@dietrichgebert/ponytail": {
			extensions: [join(ponytail, "pi-extension/index.js")],
			skills: [join(ponytail, "skills/ponytail")],
		},
	});
});

test("one present, the other absent: each package is independent", async () => {
	const onlyCaveman = scratchRoot();
	const caveman = installCaveman(onlyCaveman);
	assert.deepEqual(await resolveWorkerPackages(onlyCaveman), {
		"pi-caveman": { extensions: [join(caveman, "extensions/caveman.ts")], skills: [] },
	});

	const onlyPonytail = scratchRoot();
	const ponytail = installPonytail(onlyPonytail);
	assert.deepEqual(await resolveWorkerPackages(onlyPonytail), {
		"@dietrichgebert/ponytail": {
			extensions: [join(ponytail, "pi-extension/index.js")],
			skills: [join(ponytail, "skills/ponytail")],
		},
	});
});

test("a malformed or half-installed package is skipped, not fatal", async () => {
	const root = scratchRoot();
	// Unparseable package.json.
	const broken = join(root, "pi-caveman");
	mkdirSync(broken, { recursive: true });
	writeFileSync(join(broken, "package.json"), "{ not json", "utf8");
	// Manifest names files the tree does not have.
	installPackage(
		root,
		"@dietrichgebert/ponytail",
		{ extensions: ["./gone.js"], skills: ["./gone"] },
		{ createFiles: false },
	);
	assert.deepEqual(await resolveWorkerPackages(root), {});
});

// ---------------------------------------------------------------------------
// the directory-style manifest: pi's own documented example
// ---------------------------------------------------------------------------

test("a glob or !exclusion manifest entry is skipped, and the spawn is unaffected", async () => {
	// docs/packages.md: "Arrays support glob patterns and `!exclusions`". Those
	// are not paths `-e` accepts, so they are dropped rather than passed on.
	const root = scratchRoot();
	const dir = installPackage(root, "pi-caveman", {}, { createFiles: false });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ version: "1.0.0", pi: { extensions: ["extensions/*.ts", "!extensions/legacy.ts"] } }),
		"utf8",
	);
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "extensions/legacy.ts"), "export default {};\n", "utf8");

	const found = await resolveWorkerPackages(root);
	assert.deepEqual(found, {}, "unresolvable entries fail open");
	// Fail open means: exactly the argv of a home with nothing installed.
	assert.deepEqual(argvBothWays(found), argvBothWays());
});

// ---------------------------------------------------------------------------
// the manifest contract, pinned outside our own fixtures
// ---------------------------------------------------------------------------

/** The pi docs shipped with the installed coding agent, when resolvable. */
function piDoc(name: string): string | undefined {
	const candidates = [join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/docs", name)];
	try {
		const require_ = createRequire(import.meta.url);
		// The package's exports map may not expose package.json; the direct path
		// above is the ordinary case, this is the fallback for a hoisted install.
		candidates.push(join(require_.resolve("@earendil-works/pi-coding-agent"), "..", "..", "docs", name));
	} catch {
		// no resolvable install; the direct candidate still stands
	}
	for (const file of candidates) {
		if (existsSync(file)) return readFileSync(file, "utf8");
	}
	return undefined;
}

test("the manifest keys our fixtures write are the ones pi documents (pi, not we, reads them)", (t) => {
	const packages = piDoc("packages.md");
	if (packages === undefined) {
		t.skip("pi docs/packages.md not resolvable in this environment");
		return;
	}
	// docs/packages.md: a package declares resources under the `pi` key, as
	// `extensions` / `skills` arrays of paths relative to the package root.
	assert.match(packages, /"pi"\s*:\s*\{/, "the manifest object key");
	assert.match(packages, /"extensions"\s*:\s*\[/, "the extensions key");
	assert.match(packages, /"skills"\s*:\s*\[/, "the skills key");
	// A skills entry may be a DIRECTORY (passed through as-is). pi 0.87 documents
	// no directory *extension* entry, so expanding one is defensive only.
	assert.match(packages, /"skills"\s*:\s*\["\.\/resources\/skills"\]/, "docs show a skills DIRECTORY entry");
});

test("`-e` takes an entry-point file, and an extension directory has a documented layout", (t) => {
	const extensions = piDoc("extensions.md");
	if (extensions === undefined) {
		t.skip("pi docs/extensions.md not resolvable in this environment");
		return;
	}
	// pi 0.87 wording: `pi --extension ./hello.ts` (`-e` is its alias, per `pi --help`).
	assert.match(extensions, /pi --extension \.\/[\w-]+\.ts/, "`-e`/`--extension` is given an entry-point FILE");
	assert.match(extensions, /subdirectories containing an `index\.ts`/, "a subdirectory entry point is `<sub>/index.ts`");
});

test("`--skill` is documented as additive even with `--no-skills` (the flag combination this rests on)", (t) => {
	// pi 0.87 moved this from docs/skills.md to the CLI reference.
	const cli = piDoc("cli.md");
	if (cli === undefined) {
		t.skip("pi docs/cli.md not resolvable in this environment");
		return;
	}
	assert.match(cli, /--no-skills[\s\S]{0,200}Explicit `--skill` paths still load/, "docs/cli.md states additivity");
	// The worker spawn also rests on `-e` being `--extension` and surviving `--no-extensions`.
	assert.match(cli, /`-e`, `--extension <path>`/, "docs/cli.md: -e is --extension");
	assert.match(cli, /--no-extensions[\s\S]{0,200}Explicit `-e` paths still load/, "docs/cli.md: -e survives --no-extensions");
});

test("a really-installed optional package resolves through pi to spawnable paths (skipped when absent)", async (t) => {
	// This is the only assertion in the file that looks at the real machine, and
	// it never requires anything: on a home with neither package it skips. It
	// exists so pi resolving the real layout differently cannot hide behind fixtures.
	const root = join(homedir(), ".pi/agent");
	const installed = OPTIONAL_WORKER_PACKAGES.map((name) => join(root, "npm/node_modules", ...name.split("/"), "package.json")).filter(
		(file) => existsSync(file),
	);
	if (installed.length === 0) {
		t.skip("neither optional package is installed in this home");
		return;
	}
	// End to end on the real layout: detection yields paths, every extension it
	// yields is a file, and the argv those produce really spawns.
	const detected = await resolveWorkerPackages(root);
	const found = Object.values(detected).flatMap((entry) => [...entry.extensions, ...entry.skills]);
	assert.ok(found.length > 0, "an installed package must yield paths");
	for (const entry of Object.values(detected)) {
		for (const extension of entry.extensions) assert.ok(statSync(extension).isFile(), `${extension} is a file`);
	}
	// Every name, so the real layout is exercised whichever package is installed.
	assertArgvSpawns(argvBothWays(detected, withPackages(implementerProfile(), [...OPTIONAL_WORKER_PACKAGES])));
});

test("the shared empty default cannot be mutated by a caller", () => {
	assert.ok(Object.isFrozen(NO_OPTIONAL_WORKER_PACKAGES));
	assert.ok(Object.isFrozen(NO_OPTIONAL_WORKER_PACKAGES.extensions), "extensions array is frozen");
	assert.ok(Object.isFrozen(NO_OPTIONAL_WORKER_PACKAGES.skills), "skills array is frozen");
	assert.throws(() => (NO_OPTIONAL_WORKER_PACKAGES.extensions as string[]).push("/evil.ts"), TypeError);
	assert.throws(() => (NO_OPTIONAL_WORKER_PACKAGES.skills as string[]).push("/evil"), TypeError);
	assert.deepEqual(NO_OPTIONAL_WORKER_PACKAGES, { extensions: [], skills: [] });
	assert.ok(Object.isFrozen(NO_DETECTED_WORKER_PACKAGES));
	assert.deepEqual(NO_DETECTED_WORKER_PACKAGES, {});
});

test("the optional packages are named, with no version pinned", () => {
	assert.deepEqual([...OPTIONAL_WORKER_PACKAGES], ["pi-caveman", "@dietrichgebert/ponytail", "pi-lens", "pi-web-access", "pi-hashline-edit-pro"]);
});

// ---------------------------------------------------------------------------
// argv, on both the plan() and spawn() paths
// ---------------------------------------------------------------------------

test("neither installed: the worker argv is exactly what it was, no added flags", async () => {
	const args = argvBothWays();
	assert.equal(args.includes("--skill"), false, "no --skill when nothing is installed");
	assert.equal(flagValues(args, "-e").length, 1, "only the worker-reporter extension when nothing is installed");
	assert.deepEqual(args, argvBothWays(await resolveWorkerPackages(scratchRoot())), "an empty detection is a no-op");
	assertArgvSpawns(args);
});

// ---------------------------------------------------------------------------
// availability vs activation: role scoping (cp-role-scoped-guidance)
// ---------------------------------------------------------------------------

/** A home with both packages installed, and the paths each one contributes. */
async function homeWithBoth() {
	const root = scratchRoot();
	const caveman = join(installCaveman(root), "extensions/caveman.ts");
	const ponytailDir = installPonytail(root);
	return {
		detected: await resolveWorkerPackages(root),
		caveman,
		ponytail: join(ponytailDir, "pi-extension/index.js"),
		ponytailSkills: join(ponytailDir, "skills/ponytail"),
	};
}

test("activation is availability \u2229 role: an uninstalled or unknown name resolves to nothing", async () => {
	const { detected, ponytail } = await homeWithBoth();
	assert.deepEqual(activePackagesForRole(detected, "implementer"), {
		extensions: [ponytail],
		skills: [],
	});
	assert.deepEqual(activePackagesForRole(NO_DETECTED_WORKER_PACKAGES, "implementer"), { extensions: [], skills: [] });
	assert.deepEqual(activePackagesForRole(detected, "implementer", ["nope"]), { extensions: [], skills: [] });
});

test("profile `packages:` overrides the role default in both directions", async () => {
	const { detected, caveman } = await homeWithBoth();
	// Opt out: an implementer profile that wants nothing gets nothing.
	assert.deepEqual(activePackagesForRole(detected, "implementer", []), { extensions: [], skills: [] });
	const optedOut = argvBothWays(detected, withPackages(implementerProfile(), []));
	assert.deepEqual(flagValues(optedOut, "-e"), [WORKER_REPORTER_EXTENSION]);
	// Opt in: a profile may name a package its role does not activate
	// (except the never-lists: caveman is never loaded for a planner).
	assert.deepEqual(activePackagesForRole(detected, "implementer", ["pi-caveman"]), {
		extensions: [caveman],
		skills: [],
	});
	assert.deepEqual(activePackagesForRole(detected, "planner", ["pi-caveman"]), { extensions: [], skills: [] });
});

test("a planner and a gate-reviewer are never caveman-compressed", async () => {
	const { detected, caveman } = await homeWithBoth();
	// The artifact-producing roles: a compressed plan or verdict is the defect.
	for (const name of ["planner", "qa", "gate-reviewer"]) {
		const args = argvBothWays(detected, loadProfile(PROFILES_DIR, name));
		assert.equal(args.includes(caveman), false, `${name} must not load caveman`);
		assert.equal(flagValues(args, "-e").includes(caveman), false, `${name}: no caveman extension`);
	}
});

// ---------------------------------------------------------------------------
// cp-worker-skills: single skills, pi-lens, pi-web-access, the never-lists
// ---------------------------------------------------------------------------

function writeSkill(dir: string, name: string): string {
	const skill = join(dir, name);
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`, "utf8");
	return skill;
}


test("the package manager is the path: settings decide, the disk alone does not", async () => {
	// An npm package installed on disk but never configured is not available either.
	const root = scratchRoot();
	installPackage(root, "pi-web-access", { extensions: ["./index.ts"] }, { configured: false });
	assert.deepEqual(await resolveWorkerPackages(root), {});
});

test("a skill symlinked into ~/.pi/agent/skills still belongs to its package", async () => {
	// pi dedupes by real path and keeps the ~/.pi/agent/skills entry; a package's
	// activation must still bring that skill.
	const root = scratchRoot();
	const ponytail = installPonytail(root);
	mkdirSync(join(root, "skills"), { recursive: true });
	symlinkSync(join(ponytail, "skills/ponytail"), join(root, "skills/ponytail"));
	const detected = await resolveWorkerPackages(root);
	assert.deepEqual(detected["@dietrichgebert/ponytail"]?.skills, [join(root, "skills/ponytail")]);
});

test("a skills-only package cannot supply its extension tools", async () => {
	const root = scratchRoot();
	const lens = installPackage(root, "pi-lens", { skills: ["./skills"] });
	writeSkill(join(lens, "skills"), "pi-lens-ast-grep");
	const detected = await resolveWorkerPackages(root);
	assert.deepEqual(detected["pi-lens"]?.extensions, []);
	assert.equal(detected["pi-lens"]?.tools, undefined);
});

test("pi-lens absent: no --no-read-guard flag is added", async () => {
	const root = scratchRoot();
	installPonytail(root);
	assert.equal(argvBothWays(await resolveWorkerPackages(root)).includes("--no-read-guard"), false);
});

test("the never-list is never activated, by any role or any profile override", async () => {
	for (const name of ["writing-plans", "brainstorming", "requesting-code-review", "rpiv-ask-user-question", "pi-goal-x", "pi-subagents"]) {
		assert.ok(NEVER_WORKER_RESOURCES.includes(name), `${name} is on the never-list`);
		assert.equal(OPTIONAL_WORKER_PACKAGES.includes(name), false, `${name} is not detected`);
	}
	// Even a detection that somehow has them, and a profile naming them, yields nothing.
	const fake: DetectedWorkerPackages = Object.fromEntries(
		NEVER_WORKER_RESOURCES.map((name) => [name, { extensions: [`/x/${name}.ts`], skills: [`/x/${name}`] }]),
	);
	for (const role of ROLES) {
		assert.ok(ROLE_PACKAGES[role].every((name) => !NEVER_WORKER_RESOURCES.includes(name)), `${role} default`);
		assert.deepEqual(activePackagesForRole(fake, role, [...NEVER_WORKER_RESOURCES]), { extensions: [], skills: [] });
	}
	// Caveman is never loaded for a planner or a reviewer, even when a profile asks.
	const { detected } = await homeWithBoth();
	for (const role of ["planner", "gate-reviewer"] as const) {
		assert.deepEqual(activePackagesForRole(detected, role, ["pi-caveman"]), { extensions: [], skills: [] }, role);
	}
});

// ---------------------------------------------------------------------------
// H4 review: resolution is async, and no spawn path may outrun it silently
// ---------------------------------------------------------------------------

function pendingManager(pending: Promise<WorkerPackageResolution>, events: Array<{ kind: string; payload: Record<string, unknown> }> = []) {
	const { PI_LENS_HOME: _inherited, ...parentEnv } = process.env;
	const spawned: WorkerSpawnOptions[] = [];
	const manager = new WorkerManager({
		home: "/unused",
		parentEnv,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		optionalPackages: pending,
		recordEvent: (_jobId, kind, payload) => events.push({ kind, payload }),
		spawnFn: (options) => {
			spawned.push(options);
			return { pid: 1234, closed: new Promise(() => {}), alive: true, kill: () => {} } as unknown as WorkerProcess;
		},
	});
	return { manager, spawned, events };
}

test("a spawn started before resolution settles waits for it and still gets the role's packages", async () => {
	const { detected, ponytail } = await homeWithBoth();
	let settle: (value: WorkerPackageResolution) => void = () => {};
	const { manager, spawned, events } = pendingManager(new Promise((resolve) => { settle = resolve; }));
	// The spawn path every caller follows: `await manager.ready()`, then `spawn`.
	const early = (async () => {
		await manager.ready();
		return manager.spawn(spawnRequest());
	})();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawned.length, 0, "nothing spawns while pi is still resolving");
	settle({ packages: detected });
	const managed = await early;
	assert.deepEqual(spawned[0]?.extensions, [WORKER_REPORTER_EXTENSION, ponytail]);
	assert.equal(spawned[0]?.skills, undefined, "no --skill path reaches a worker");
	assert.equal(managed.plan.packagesError, undefined);
	assert.equal(events.length, 1, "resolved packages still warn when profile tools are unavailable");
	assert.equal(events[0]?.kind, "worker_packages_unresolved");
	assert.match(String(events[0]?.payload.error), /replace, insert, anchor_grep, undo_last_change/);
	// Cached: a later spawn does not wait again.
	await manager.ready();
});

test("every WorkerManager spawn site in src/ awaits ready() first", () => {
	const srcDir = join(REPO_ROOT, "src");
	const sites: string[] = [];
	for (const name of readdirSync(srcDir).filter((file) => file.endsWith(".ts") && file !== "worker-manager.ts")) {
		const lines = readFileSync(join(srcDir, name), "utf8").split("\n");
		lines.forEach((line, index) => {
			if (!/manager\.spawn\(\{/.test(line)) return;
			sites.push(name);
			const before = lines.slice(Math.max(0, index - 4), index).join("\n");
			assert.match(before, /await [\w.#]*manager\.ready\(\);/, `${name}:${index + 1} spawns without awaiting manager.ready()`);
		});
	}
	assert.ok(sites.length >= 6, `found the spawn sites: ${sites.join(", ")}`);
});
