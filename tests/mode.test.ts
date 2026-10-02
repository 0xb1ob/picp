/**
 * Mode resolution (spec 2026-09-04 §Mode resolution; single-project mode
 * removed by cp-8knh). A table of cases over an injected git runner and real
 * scratch directories: every row names the environment, the settings file,
 * the directory shape and the expected mode/home/source. Plus the refusals
 * (every `single`, a plain repository, a former single home) and the helpers.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, type Runtime } from "../src/contracts.ts";
import {
	describeRuntime,
	type GitRunner,
	gitToplevel,
	isLegacySingleHome,
	isMultiHomeDir,
	ModeError,
	readModeSettings,
	resolveProjectArg,
	resolveRuntime,
	settingsPath,
} from "../src/mode.ts";

function scratch(prefix = "cp-mode-"): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A fake git: `toplevels` maps a cwd (or any of its descendants) to a repo toplevel. */
function fakeGit(toplevels: Record<string, string>, extras: { origin?: string; head?: string } = {}): GitRunner {
	return (cwd, args) => {
		const key = args.join(" ");
		if (key === "rev-parse --show-toplevel") {
			const hit = Object.keys(toplevels).find((root) => cwd === root || cwd.startsWith(`${root}/`));
			return hit ? toplevels[hit] : undefined;
		}
		if (key === "remote get-url origin") return extras.origin;
		if (key === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") return extras.head;
		return undefined;
	};
}

const PACKAGE_ROOT = scratch("cp-pkg-"); // stands in for the source checkout
const NO_GIT: GitRunner = () => undefined;

test("resolution table: environment, settings, directory shape -> mode, home, source", (t) => {
	const repo = scratch("cp-repo-");
	const nested = join(repo, "src", "deep");
	mkdirSync(nested, { recursive: true });
	mkdirSync(join(repo, ".git")); // a main worktree: `.git` is a directory
	const plain = scratch("cp-plain-");
	const home = scratch("cp-home-");
	mkdirSync(join(home, LAYOUT.projects), { recursive: true });
	mkdirSync(join(home, LAYOUT.state), { recursive: true });
	t.after(() => {
		for (const dir of [repo, plain, home]) rmSync(dir, { recursive: true, force: true });
	});
	const inRepo = fakeGit({ [repo]: repo }, { origin: "git@github.com:o/r.git", head: "origin/main" });

	const cases: Array<{
		name: string;
		cwd: string;
		env?: NodeJS.ProcessEnv;
		git: GitRunner;
		mode: Runtime["mode"];
		home: string;
		source: Runtime["source"];
	}> = [
		{
			name: "inside the checkout",
			cwd: join(PACKAGE_ROOT, "src"),
			git: fakeGit({ [PACKAGE_ROOT]: PACKAGE_ROOT }),
			mode: "multi",
			home: PACKAGE_ROOT,
			source: "checkout",
		},
		{ name: "CP_HOME wins over a repo", cwd: repo, env: { CP_HOME: home }, git: inRepo, mode: "multi", home, source: "CP_HOME" },
		{ name: "an existing multi home dir", cwd: home, git: NO_GIT, mode: "multi", home, source: "home-dir" },
		{ name: "not a repo, not a home: today's default", cwd: plain, git: NO_GIT, mode: "multi", home: PACKAGE_ROOT, source: "checkout" },
		{ name: "CP_MODE=multi inside a repo", cwd: repo, env: { CP_MODE: "multi" }, git: inRepo, mode: "multi", home: PACKAGE_ROOT, source: "CP_MODE" },
	];
	for (const c of cases) {
		mkdirSync(join(PACKAGE_ROOT, "src"), { recursive: true });
		const runtime = resolveRuntime({ cwd: c.cwd, env: { ...c.env }, packageRoot: PACKAGE_ROOT, git: c.git });
		assert.equal(runtime.mode, c.mode, `${c.name}: mode`);
		assert.equal(runtime.home, c.home, `${c.name}: home`);
		assert.equal(runtime.source, c.source, `${c.name}: source`);
		assert.ok(runtime.reason.length > 0, `${c.name}: reason`);
		assert.equal("repo" in runtime, false, `${c.name}: a runtime carries no repo`);
	}
	// A plain repository is no longer a home of its own: auto (explicit or default) refuses it, from any depth.
	for (const [cwd, env] of [[repo, {}], [nested, {}], [repo, { CP_MODE: "auto" }]] as const) {
		assert.throws(
			() => resolveRuntime({ cwd, env: { ...env }, packageRoot: PACKAGE_ROOT, git: inRepo }),
			(error: unknown) =>
				error instanceof ModeError &&
				error.message.startsWith(`${repo} is a git repository, not a command-post home — single-project mode was removed`) &&
				error.message.includes(`CP_MODE=multi to use ${PACKAGE_ROOT}`) &&
				!error.message.includes("not migrated"),
		);
	}
	assert.equal(existsSync(join(repo, LAYOUT.runtimeDir)), false, "a refusal scaffolds nothing");
});

test("the standard home: its app/ checkout resolves ~/.pi-command-post (flat), never app/ itself; CP_HOME still wins", (t) => {
	const user = scratch("cp-user-");
	const standard = join(user, ".pi-command-post");
	const app = join(standard, "app");
	mkdirSync(join(app, "src"), { recursive: true });
	const other = scratch("cp-other-");
	t.after(() => {
		for (const dir of [user, other]) rmSync(dir, { recursive: true, force: true });
	});
	const env = { HOME: user };
	const appGit = fakeGit({ [app]: app });

	const inside = resolveRuntime({ cwd: join(app, "src"), env, packageRoot: app, git: appGit });
	assert.deepEqual([inside.mode, inside.home, inside.source], ["multi", standard, "standard"]);
	assert.match(inside.reason, /standard home/);
	const elsewhere = resolveRuntime({ cwd: other, env, packageRoot: app, git: NO_GIT });
	assert.deepEqual([elsewhere.mode, elsewhere.home, elsewhere.source], ["multi", standard, "standard"]);
	const override = resolveRuntime({ cwd: join(app, "src"), env: { ...env, CP_HOME: other }, packageRoot: app, git: appGit });
	assert.deepEqual([override.home, override.source], [other, "CP_HOME"]);

	// The flat home is recognised by its own top-level projects/ and state/, and its settings live beside them.
	assert.equal(settingsPath(standard), join(standard, "settings.json"));
	assert.equal(isMultiHomeDir(standard), false);
	mkdirSync(join(standard, "projects"));
	mkdirSync(join(standard, "state"));
	assert.equal(isMultiHomeDir(standard), true);
	const atHome = resolveRuntime({ cwd: standard, env: {}, packageRoot: PACKAGE_ROOT, git: NO_GIT });
	assert.deepEqual([atHome.mode, atHome.home, atHome.source], ["multi", standard, "home-dir"]);
	// Any other home keeps its nested runtime root.
	assert.equal(settingsPath(other), join(other, LAYOUT.runtimeDir, "settings.json"));
});

test("a repo named .pi-command-post keeps the nested settings.json, and single there is refused (review fix)", (t) => {
	const parent = scratch("cp-dotrepo-");
	const repo = join(parent, ".pi-command-post");
	mkdirSync(join(repo, ".git"), { recursive: true });
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	assert.equal(settingsPath(repo), join(repo, LAYOUT.runtimeDir, "settings.json"));
	mkdirSync(join(repo, LAYOUT.runtimeDir));
	writeFileSync(settingsPath(repo), JSON.stringify({ schema_version: 1, mode: "single" }));
	assert.deepEqual(readModeSettings(repo), { mode: "single" }, "the persisted field still reads");
	assert.throws(
		() => resolveRuntime({ cwd: repo, env: {}, packageRoot: PACKAGE_ROOT, git: fakeGit({ [repo]: repo }) }),
		(error: unknown) =>
			error instanceof ModeError &&
			/^single-project mode was removed/.test(error.message) &&
			error.message.includes(`${settingsPath(repo)} says single`),
	);
});

test("another home's nested .pi-command-post is never taken for a flat standard home (review fix, matches storage.alias)", (t) => {
	const checkout = scratch("cp-nesthome-");
	const nested = join(checkout, ".pi-command-post");
	for (const dir of [LAYOUT.projects, LAYOUT.state]) mkdirSync(join(checkout, dir), { recursive: true });
	mkdirSync(join(checkout, ".git"));
	writeFileSync(join(checkout, ".gitignore"), ".pi-command-post/\n.beads/\n");
	t.after(() => rmSync(checkout, { recursive: true, force: true }));
	// The nested root has projects/ and state/ at its top, but it is the checkout's, not a home of its own.
	assert.equal(isMultiHomeDir(nested), false);
	assert.equal(settingsPath(nested), join(nested, LAYOUT.runtimeDir, "settings.json"));
	assert.equal(isMultiHomeDir(checkout), true);
	// Resolution goes on to git toplevel detection: the checkout is a git repository, so the launch is refused.
	assert.throws(() => resolveRuntime({ cwd: nested, env: {}, packageRoot: PACKAGE_ROOT, git: fakeGit({ [checkout]: checkout }) }), /not a command-post home/);
	// Without git, it falls back to the default home — never the nested root as "home-dir".
	const fallback = resolveRuntime({ cwd: nested, env: {}, packageRoot: PACKAGE_ROOT, git: NO_GIT });
	assert.notEqual(fallback.home, nested);
	assert.notEqual(fallback.source, "home-dir");
});

test("the settings file wins over the default and loses to CP_MODE; garbage is reported and ignored", (t) => {
	const repo = scratch("cp-repo-");
	mkdirSync(join(repo, ".git"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const inRepo = fakeGit({ [repo]: repo });

	assert.equal(readModeSettings(repo), undefined);
	const file = settingsPath(repo);
	assert.equal(file, join(repo, LAYOUT.runtimeDir, "settings.json"));
	mkdirSync(join(repo, LAYOUT.runtimeDir));
	writeFileSync(file, JSON.stringify({ schema_version: 1, mode: "multi" }));
	assert.deepEqual(readModeSettings(repo), { mode: "multi" });

	mkdirSync(join(repo, "x"), { recursive: true });
	const forcedMulti = resolveRuntime({ cwd: join(repo, "x"), packageRoot: PACKAGE_ROOT, git: inRepo, env: {} });
	assert.equal(forcedMulti.mode, "multi");
	assert.equal(forcedMulti.source, "settings");

	// CP_MODE is read first: single there is refused whatever the file says.
	assert.throws(() => resolveRuntime({ cwd: repo, packageRoot: PACKAGE_ROOT, git: inRepo, env: { CP_MODE: "single" } }), /single-project mode was removed/);

	writeFileSync(file, JSON.stringify({ schema_version: 1, mode: "auto" }));
	assert.throws(() => resolveRuntime({ cwd: repo, packageRoot: PACKAGE_ROOT, git: inRepo, env: {} }), /is a git repository, not a command-post home/);

	writeFileSync(file, "{not json");
	const garbage = readModeSettings(repo);
	assert.ok(garbage && "error" in garbage && /not JSON/.test(garbage.error));
	const fallback = resolveRuntime({ cwd: repo, packageRoot: PACKAGE_ROOT, git: inRepo, env: { CP_HOME: PACKAGE_ROOT } });
	assert.equal(fallback.source, "CP_HOME", "an unreadable settings file falls back to auto");
	assert.match(fallback.reason, /settings\.json ignored/);

	writeFileSync(file, JSON.stringify({ schema_version: 1, mode: "both" }));
	const unknown = readModeSettings(repo);
	assert.ok(unknown && "error" in unknown && /mode/.test(unknown.error));
});

test("refusals: an invalid CP_MODE, and single anywhere (env or settings, with or without a repository, in a multi home)", (t) => {
	const plain = scratch("cp-plain-");
	const overlap = scratch("cp-overlap-");
	mkdirSync(join(overlap, LAYOUT.projects), { recursive: true });
	mkdirSync(join(overlap, LAYOUT.state), { recursive: true });
	t.after(() => {
		rmSync(plain, { recursive: true, force: true });
		rmSync(overlap, { recursive: true, force: true });
	});
	assert.throws(
		() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_MODE: "dual" } }),
		(error: unknown) => error instanceof ModeError && /CP_MODE must be multi or auto/.test((error as Error).message),
	);
	const removed = (error: unknown) =>
		error instanceof ModeError && /^single-project mode was removed; the command post runs multi-project homes only: /.test(error.message);
	assert.throws(() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_MODE: "single" } }), removed);
	assert.throws(
		() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_MODE: "single" } }),
		/unset CP_MODE or set CP_MODE=multi/,
	);
	const overlapGit = fakeGit({ [overlap]: overlap });
	assert.throws(() => resolveRuntime({ cwd: overlap, packageRoot: PACKAGE_ROOT, git: overlapGit, env: { CP_MODE: "single" } }), removed);

	mkdirSync(join(plain, LAYOUT.runtimeDir));
	writeFileSync(settingsPath(plain), JSON.stringify({ schema_version: 1, mode: "single" }));
	assert.throws(() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: {} }), removed);
	assert.throws(() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: fakeGit({ [plain]: plain }), env: {} }), removed);
	// CP_MODE=multi still wins over a settings file saying single.
	assert.equal(resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_MODE: "multi" } }).mode, "multi");
	assert.deepEqual(readdirSync(join(plain, LAYOUT.runtimeDir)), ["settings.json"], "a refusal scaffolds nothing");

	// auto in a multi home is multi (home-dir), not a refusal
	assert.equal(resolveRuntime({ cwd: overlap, packageRoot: PACKAGE_ROOT, git: overlapGit, env: {} }).source, "home-dir");
});

test("a former single-project home is refused as CP_HOME and as a launch directory, and names its state", (t) => {
	const legacy = scratch("cp-legacy-");
	t.after(() => rmSync(legacy, { recursive: true, force: true }));
	mkdirSync(join(legacy, ".git", "info"), { recursive: true });
	mkdirSync(join(legacy, LAYOUT.state), { recursive: true });
	assert.equal(isLegacySingleHome(legacy), false, "no exclude line: not evidence");
	writeFileSync(join(legacy, ".git", "info", "exclude"), "# git ls-files --others\n.pi-command-post/\n");
	assert.equal(isLegacySingleHome(legacy), true);

	assert.throws(
		() => resolveRuntime({ cwd: PACKAGE_ROOT, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_HOME: legacy } }),
		(error: unknown) =>
			error instanceof ModeError &&
			error.message.startsWith(`${legacy} is a former single-project home — single-project mode was removed`) &&
			error.message.includes("not migrated"),
	);
	assert.throws(
		() => resolveRuntime({ cwd: legacy, packageRoot: PACKAGE_ROOT, git: fakeGit({ [legacy]: legacy }), env: {} }),
		(error: unknown) =>
			error instanceof ModeError &&
			error.message.includes("is a git repository, not a command-post home") &&
			error.message.includes(`${legacy}/.pi-command-post/ holds a former single-project home's state, which is not migrated`),
	);
	assert.equal(existsSync(join(legacy, LAYOUT.projects)), false, "the refusal never scaffolds projects/");
	assert.equal(existsSync(join(legacy, ".gitignore")), false, "nor a .gitignore");

	// A multi home (projects/ present) is never taken for a former single one.
	mkdirSync(join(legacy, LAYOUT.projects));
	assert.equal(isLegacySingleHome(legacy), false);
});

test("the source checkout with state/, no projects/ and an exclude line still resolves multi (never taken for a former single home)", (t) => {
	const checkout = scratch("cp-legacy-checkout-");
	t.after(() => rmSync(checkout, { recursive: true, force: true }));
	mkdirSync(join(checkout, ".git", "info"), { recursive: true });
	mkdirSync(join(checkout, LAYOUT.state), { recursive: true });
	mkdirSync(join(checkout, "src"));
	writeFileSync(join(checkout, ".git", "info", "exclude"), ".pi-command-post/\n");
	assert.equal(isLegacySingleHome(checkout), true, "the same four facts as a former single home");
	const git = fakeGit({ [checkout]: checkout });
	for (const env of [{}, { CP_MODE: "multi" }, { CP_MODE: "auto" }]) {
		const runtime = resolveRuntime({ cwd: join(checkout, "src"), env, packageRoot: checkout, git });
		assert.deepEqual([runtime.mode, runtime.home], ["multi", checkout], JSON.stringify(env));
	}
	// Only CP_HOME naming such a directory is refused as a former single home.
	assert.throws(
		() => resolveRuntime({ cwd: join(checkout, "src"), env: { CP_HOME: checkout }, packageRoot: checkout, git }),
		/is a former single-project home/,
	);
	assert.throws(
		() => resolveRuntime({ cwd: join(checkout, "src"), env: { CP_HOME: checkout, CP_MODE: "multi" }, packageRoot: checkout, git }),
		/is a former single-project home/,
		"CP_MODE=multi does not bypass the CP_HOME check",
	);
});

test("isMultiHomeDir needs both .pi-command-post/projects/ and .pi-command-post/state/", (t) => {
	const dir = scratch();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(isMultiHomeDir(dir), false);
	// Legacy-layout negative fixture: top-level projects/ + state/ is no longer evidence (cp-u3i2).
	mkdirSync(join(dir, "state"));
	mkdirSync(join(dir, "projects"));
	assert.equal(isMultiHomeDir(dir), false);
	mkdirSync(join(dir, ".pi-command-post/state"), { recursive: true });
	assert.equal(isMultiHomeDir(dir), false);
	mkdirSync(join(dir, ".pi-command-post/projects"), { recursive: true });
	assert.equal(isMultiHomeDir(dir), true);
});

test("describeRuntime and resolveProjectArg: multi line, project required", () => {
	const multi: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "checkout" };
	assert.match(describeRuntime(multi), /^multi-project mode, home \/h \(source: checkout; checkout\)$/);
	assert.equal(resolveProjectArg(multi, "demo", "cp_job create"), "demo");
	assert.equal(resolveProjectArg(multi, " demo ", "cp_job create"), "demo");
	assert.throws(() => resolveProjectArg(multi, undefined, "cp_job create"), /cp_job create needs `project`/);
	assert.throws(() => resolveProjectArg(multi, "  ", "cp_job create"), /cp_job create needs `project`/);
});

test("gitToplevel against a real repository resolves symlinks and returns undefined outside one", (t) => {
	const dir = scratch("cp-real-");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	mkdirSync(join(dir, "a", "b"), { recursive: true });
	assert.equal(gitToplevel(join(dir, "a", "b")), dir);
	const outside = scratch("cp-outside-");
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	assert.equal(gitToplevel(outside), undefined);
});

test("a real repository is refused at resolution, before anything is scaffolded", (t) => {
	const root = scratch("cp-realrepo-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	assert.throws(() => resolveRuntime({ cwd: root, env: {}, packageRoot: PACKAGE_ROOT }), /is a git repository, not a command-post home/);
	assert.equal(existsSync(join(root, ".pi-command-post")), false);
	// CP_MODE=multi is still a way out.
	assert.equal(resolveRuntime({ cwd: root, env: { CP_MODE: "multi" }, packageRoot: PACKAGE_ROOT }).mode, "multi");
});
