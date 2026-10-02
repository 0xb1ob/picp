/**
 * T11 acceptance: a lease/return cycle against a scratch repo, plus the
 * fail-closed rules — treehouse is mandatory (no silent `git worktree add`),
 * returns run from outside the worktree, and a lease is a value, never a
 * retyped path.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type ExecResult, LeaseError, LeaseManager, leaseFromRecord, parseLeaseOutput } from "../src/leases.ts";
import {
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	git,
	leaseState,
	treehouse,
	treehouseAvailable,
} from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const HAS_TREEHOUSE = treehouseAvailable();
const skipWithoutTreehouse = HAS_TREEHOUSE ? false : "treehouse not on PATH";

// ---------------------------------------------------------------------------
// parsing and value discipline
// ---------------------------------------------------------------------------

test("lease output parses JSON first, path-only as a degraded fallback", () => {
	const json = parseLeaseOutput(
		'{"path":"/pool/1/demo","lease_id":"abc","lease_holder":"cp-x","leased_at":"2026-01-01T00:00:00Z"}\n',
	);
	assert.equal(json.path, "/pool/1/demo");
	assert.equal(json.lease_id, "abc");

	// older treehouse: just the path (identity unknown, and we say so by omission)
	const pathOnly = parseLeaseOutput("\n/pool/1/demo\n");
	assert.deepEqual(pathOnly, { path: "/pool/1/demo" });

	assert.deepEqual(parseLeaseOutput("no path here"), {});
	assert.deepEqual(parseLeaseOutput("{ not json }"), {});
});

test("a lease is a bound value: reconstruction requires an absolute path", () => {
	const lease = leaseFromRecord({ worktree: "/tmp", lease_id: "abc", project: "demo" });
	assert.equal(lease.lease_id, "abc");
	assert.throws(() => leaseFromRecord({ worktree: "relative/path" }), /must be absolute/);
});

test("missing treehouse is a hard error, never a silent git worktree add", async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	t.after(() => {
		home.cleanup();
		repo.cleanup();
	});
	const manager = new LeaseManager({ home: home.path, treehouseBin: "cp-definitely-not-treehouse" });
	await assert.rejects(
		() => manager.acquire(repo.path),
		(error: LeaseError) => {
			assert.match(error.message, /not on PATH/);
			assert.match(error.message, /no fallback/i);
			assert.match(error.message, /git worktree add/);
			return true;
		},
	);
});

test("returns are refused from inside the worktree", async (t) => {
	const worktree = mkdtempSync(join(tmpdir(), "cp-wt-"));
	t.after(() => rmSync(worktree, { recursive: true, force: true }));
	const calls: string[][] = [];
	const runner = async (bin: string, args: readonly string[]): Promise<ExecResult> => {
		calls.push([bin, ...args]);
		return { status: 0, stdout: "", stderr: "" };
	};

	// home inside the worktree
	const nestedHome = join(worktree, "home");
	mkdirSync(nestedHome, { recursive: true });
	const insideHome = new LeaseManager({ home: nestedHome, runner, cwd: () => "/tmp" });
	await assert.rejects(
		() => insideHome.release(leaseFromRecord({ worktree })),
		/command post home .* is inside it/,
	);

	// cwd inside the worktree
	const nestedCwd = join(worktree, "src");
	mkdirSync(nestedCwd, { recursive: true });
	const insideCwd = new LeaseManager({ home: "/tmp", runner, cwd: () => nestedCwd });
	await assert.rejects(() => insideCwd.release(leaseFromRecord({ worktree })), /current directory .* is inside it/);
	assert.deepEqual(calls, [], "nothing was executed while the policy said no");
});

test("release passes the lease identity so it cannot return someone else's worktree", async (t) => {
	// The proof below needs a path whose realpath genuinely differs — on macOS
	// tmpdir() is itself a symlink (/var -> /private/var), so a bare mkdtemp
	// path proved this by accident; on Linux /tmp is not a symlink, so the same
	// fixture proved nothing. Symlink deliberately so the proof holds on every
	// platform.
	const real = mkdtempSync(join(tmpdir(), "cp-wt-real-"));
	const worktree = `${real}-link`;
	symlinkSync(real, worktree);
	t.after(() => {
		rmSync(worktree, { force: true });
		rmSync(real, { recursive: true, force: true });
	});
	const calls: string[][] = [];
	const manager = new LeaseManager({
		home: "/tmp",
		cwd: () => "/tmp",
		runner: async (bin, args) => {
			calls.push([bin, ...args]);
			return { status: 0, stdout: "", stderr: "" };
		},
	});
	// the path travels verbatim: treehouse looks worktrees up by the path it printed
	await manager.release(leaseFromRecord({ worktree, lease_id: "abc123" }));
	assert.deepEqual(calls[0], ["treehouse", "return", "--force", "--if-lease-id", "abc123", worktree]);
	assert.notEqual(worktree, realpathSync(worktree), "fixture proves the path is not silently canonicalized");

	// no identity known (old treehouse): the guard is simply absent, not faked
	await manager.release(leaseFromRecord({ worktree }));
	assert.deepEqual(calls[1], ["treehouse", "return", "--force", worktree]);
});

test("a lease that is not a worktree of this clone is handed straight back", async (t) => {
	const home = createScratchHome();
	const mine = createScratchRepo({ name: "mine" });
	const foreign = createScratchRepo({ name: "foreign" });
	t.after(() => {
		home.cleanup();
		mine.cleanup();
		foreign.cleanup();
	});

	const calls: string[][] = [];
	const manager = new LeaseManager({
		home: home.path,
		cwd: () => home.path,
		runner: async (bin, args, cwd) => {
			calls.push([bin, ...args]);
			if (bin === "treehouse" && args[0] === "get") {
				// treehouse hands back a worktree belonging to a different repo
				return { status: 0, stdout: `${JSON.stringify({ path: foreign.path, lease_id: "bad" })}\n`, stderr: "" };
			}
			if (bin === "treehouse") return { status: 0, stdout: "", stderr: "" };
			// real git for the verification calls
			return { status: 0, stdout: git(cwd, ...args), stderr: "" };
		},
	});

	await assert.rejects(() => manager.acquire(mine.path), /belongs to another repo/);
	assert.ok(
		calls.some((call) => call[0] === "treehouse" && call[1] === "return"),
		"a lease we cannot vouch for is returned, not leaked",
	);
});

// ---------------------------------------------------------------------------
// the real cycle
// ---------------------------------------------------------------------------

test("lease/return cycle against a scratch repo", { skip: skipWithoutTreehouse, timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	// enableTreehouse hides its config via .git/info/exclude, so the tree stays
	// clean and the pool stays inside this test's temp dir.
	const pool = enableTreehouse(repo.path);
	t.after(() => {
		pool.cleanup();
		repo.cleanup();
		home.cleanup();
	});

	const manager = new LeaseManager({ home: home.path, cwd: () => home.path });
	const lease = await manager.acquire(repo.path, { holder: "cp-demo-job", project: "demo" });

	assert.ok(lease.path.startsWith(pool.root) || existsSync(lease.path), `unexpected lease path ${lease.path}`);
	assert.notEqual(lease.path, repo.path, "a job gets a linked worktree, never the primary checkout");
	assert.ok(lease.lease_id, "modern treehouse reports a lease identity");
	assert.equal(lease.project, "demo");
	assert.ok(existsSync(join(lease.path, "README.md")), "the worktree carries the repo content");
	assert.equal(await manager.belongsTo(lease.path, repo.path), true);
	assert.match(treehouse(repo.path, "status"), /leased/);

	// the same pool never hands out a leased worktree twice
	const second = await manager.acquire(repo.path, { holder: "cp-other-job" });
	assert.notEqual(second.path, lease.path, "a leased worktree is never handed out again");

	await manager.release(second);
	await manager.release(lease);
	assert.ok(!/leased/.test(treehouse(repo.path, "status")), `pool still shows a lease:\n${treehouse(repo.path, "status")}`);

	// A returned lease is RECYCLED, not deleted: the directory survives, cleaned
	// and reset, for the next job. Pinned here because the tempting assertion
	// ("the worktree is gone") is treehouse's opposite of its own contract, and a
	// live scenario once shipped with it.
	assert.equal(leaseState(repo.path, lease.path), "available", "a returned worktree is available, not held");
	assert.ok(existsSync(lease.path), "return recycles the worktree; it does not remove the directory");
	assert.ok(existsSync(join(lease.path, "README.md")), "the recycled worktree is reset to the repo content");

	// a stale lease identity cannot return a worktree that was re-leased
	const relet = await manager.acquire(repo.path, { holder: "cp-third-job" });
	if (lease.lease_id && relet.path === lease.path) {
		await assert.rejects(() => manager.release(lease), /treehouse return --force failed/);
	}
	await manager.release(relet);
});

// ---------------------------------------------------------------------------
// per-home pool root: CP_TREEHOUSE_ROOT -> `treehouse --root <path>`
//
// Two homes on one machine that clone the same remote into `projects/<name>`
// share ONE treehouse pool, because the pool key is the clone-dir basename
// plus a hash of the origin URL (cp-b8el Experiment B, reproduced below). The
// seam is a per-home `--root`; the invariant that matters more is that with
// nothing set the argv is byte-identical to what it always was.
// ---------------------------------------------------------------------------

/**
 * A real linked worktree of `repoPath`, so `LeaseManager#verify` passes with a
 * faked treehouse. Not a lease: a fixture. Leases only ever come from
 * treehouse, which is exactly what the argv tests are pinning.
 */
function linkedWorktree(repoPath: string, t: { after(fn: () => void): void }): string {
	const parent = mkdtempSync(join(tmpdir(), "cp-wt-fixture-"));
	const worktree = join(parent, "wt");
	git(repoPath, "worktree", "add", "--detach", worktree);
	t.after(() => {
		rmSync(parent, { recursive: true, force: true });
		try {
			git(repoPath, "worktree", "prune");
		} catch {
			// the repo may already be gone; the fixture dir is what matters
		}
	});
	return worktree;
}

interface ArgvProbe {
	calls: string[][];
	manager: LeaseManager;
	worktree: string;
}

function argvProbe(t: { after(fn: () => void): void }, options: { poolRoot?: string } = {}): ArgvProbe {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", withRemote: false });
	t.after(() => {
		home.cleanup();
		repo.cleanup();
	});
	const worktree = linkedWorktree(repo.path, t);
	const calls: string[][] = [];
	const manager = new LeaseManager({
		home: home.path,
		cwd: () => home.path,
		...(options.poolRoot ? { poolRoot: options.poolRoot } : {}),
		runner: async (bin, args, cwd) => {
			calls.push([bin, ...args]);
			if (bin === "treehouse" && args.includes("get")) {
				return { status: 0, stdout: `${JSON.stringify({ path: worktree, lease_id: "abc123" })}\n`, stderr: "" };
			}
			if (bin === "treehouse") return { status: 0, stdout: "", stderr: "" };
			return { status: 0, stdout: git(cwd, ...args), stderr: "" };
		},
	});
	return { calls, manager, worktree: repo.path };
}

test("poolRoot unset: no --root appears anywhere in the argv (backwards compatibility)", async (t) => {
	const probe = argvProbe(t);
	const lease = await probe.manager.acquire(probe.worktree, { holder: "cp-argv", project: "demo" });
	await probe.manager.release(lease);

	const treehouseCalls = probe.calls.filter((call) => call[0] === "treehouse");
	assert.deepEqual(treehouseCalls[0], ["treehouse", "get", "--lease", "--json", "--lease-holder", "cp-argv"]);
	assert.deepEqual(treehouseCalls[1], ["treehouse", "return", "--force", "--if-lease-id", "abc123", lease.path]);
	assert.ok(
		!probe.calls.some((call) => call.includes("--root")),
		`unset config must be byte-identical to today: ${JSON.stringify(probe.calls)}`,
	);
});

test("poolRoot set: --root leads the argv for acquire AND release", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-poolroot-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const probe = argvProbe(t, { poolRoot: root });
	const lease = await probe.manager.acquire(probe.worktree, { holder: "cp-argv", project: "demo" });
	await probe.manager.release(lease);

	const treehouseCalls = probe.calls.filter((call) => call[0] === "treehouse");
	// A lease returned to the wrong pool is a leak, so both directions are pinned.
	assert.deepEqual(treehouseCalls[0], [
		"treehouse",
		"--root",
		root,
		"get",
		"--lease",
		"--json",
		"--lease-holder",
		"cp-argv",
	]);
	assert.deepEqual(treehouseCalls[1], [
		"treehouse",
		"--root",
		root,
		"return",
		"--force",
		"--if-lease-id",
		"abc123",
		lease.path,
	]);
	// git is asked about the worktree, never with a treehouse flag.
	assert.ok(!probe.calls.some((call) => call[0] === "git" && call.includes("--root")));
});

test("a relative poolRoot is refused: treehouse resolves it from the repo root", () => {
	assert.throws(
		() => new LeaseManager({ home: "/tmp", poolRoot: "pool" }),
		(error: LeaseError) => {
			assert.match(error.message, /absolute/);
			assert.match(error.message, /CP_TREEHOUSE_ROOT/);
			return true;
		},
	);
	// The unset case is not a refusal: it is today's behaviour.
	assert.ok(new LeaseManager({ home: "/tmp" }));
});

/**
 * Cleanup that runs LAST-IN-FIRST-OUT. `t.after` hooks run in registration
 * order, so a lease acquired after a temp-dir hook was registered would be
 * returned into a directory that is already gone; these tests hand a lease
 * back before the pool it came from is deleted.
 */
function cleanupStack(t: { after(fn: () => Promise<void> | void): void }): (fn: () => Promise<void> | void) => void {
	const stack: Array<() => Promise<void> | void> = [];
	t.after(async () => {
		for (const fn of stack.reverse()) {
			try {
				await fn();
			} catch {
				// Cleanup is best-effort; the assertions already ran.
			}
		}
	});
	return (fn) => {
		stack.push(fn);
	};
}

test(
	"integration: --root overrides TREEHOUSE_ROOT (the assumption the whole seam rests on)",
	{ skip: skipWithoutTreehouse, timeout: 120_000 },
	async (t) => {
		const onCleanup = cleanupStack(t);
		const home = createScratchHome();
		onCleanup(() => home.cleanup());
		const repo = createScratchRepo({ name: "rooted", files: { "README.md": "# rooted\n" } });
		onCleanup(() => repo.cleanup());
		const rootA = mkdtempSync(join(tmpdir(), "cp-root-a-"));
		const rootB = mkdtempSync(join(tmpdir(), "cp-root-b-"));
		onCleanup(() => {
			rmSync(rootA, { recursive: true, force: true });
			rmSync(rootB, { recursive: true, force: true });
		});

		const manager = new LeaseManager({
			home: home.path,
			cwd: () => home.path,
			poolRoot: rootB,
			// The env says A; the flag says B. Documented, never measured until now.
			env: { ...process.env, TREEHOUSE_ROOT: rootA },
		});
		const lease = await manager.acquire(repo.path, { holder: "cp-root-probe", project: "rooted" });
		onCleanup(async () => {
			await manager.release(lease, { ignoreErrors: true });
		});
		assert.ok(
			realpathSync(lease.path).startsWith(realpathSync(rootB)),
			`--root must win over TREEHOUSE_ROOT: lease landed at ${lease.path}, expected under ${rootB}`,
		);
	},
);

/** Two homes, one remote, one `projects/demo` basename each: the pool key. */
function twoHomes(t: { after(fn: () => Promise<void> | void): void }): {
	onCleanup: (fn: () => Promise<void> | void) => void;
	cloneA: string;
	cloneB: string;
	homeA: string;
	homeB: string;
} {
	const onCleanup = cleanupStack(t);
	const upstream = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	onCleanup(() => upstream.cleanup());
	const homeA = createScratchHome();
	const homeB = createScratchHome();
	onCleanup(() => {
		homeA.cleanup();
		homeB.cleanup();
	});
	const cloneA = join(homeA.path, LAYOUT.projects, "demo");
	const cloneB = join(homeB.path, LAYOUT.projects, "demo");
	mkdirSync(dirname(cloneA), { recursive: true });
	mkdirSync(dirname(cloneB), { recursive: true });
	git(homeA.path, "clone", "--quiet", upstream.remote as string, cloneA);
	git(homeB.path, "clone", "--quiet", upstream.remote as string, cloneB);
	return { onCleanup, cloneA, cloneB, homeA: homeA.path, homeB: homeB.path };
}

test(
	"integration: one shared root puts two homes' clones in ONE pool (the collision)",
	{ skip: skipWithoutTreehouse, timeout: 120_000 },
	async (t) => {
		const { onCleanup, cloneA, cloneB, homeA, homeB } = twoHomes(t);
		const shared = mkdtempSync(join(tmpdir(), "cp-shared-root-"));
		onCleanup(() => rmSync(shared, { recursive: true, force: true }));

		const env = { ...process.env, TREEHOUSE_ROOT: shared };
		const managerA = new LeaseManager({ home: homeA, cwd: () => homeA, env });
		const managerB = new LeaseManager({ home: homeB, cwd: () => homeB, env });
		const leaseA = await managerA.acquire(cloneA, { holder: "cp-home-a", project: "demo" });
		onCleanup(async () => {
			await managerA.release(leaseA, { ignoreErrors: true });
		});
		const leaseB = await managerB.acquire(cloneB, { holder: "cp-home-b", project: "demo" });
		onCleanup(async () => {
			await managerB.release(leaseB, { ignoreErrors: true });
		});

		// One pool directory (`<root>/.treehouse/<basename>-<origin hash>`) for
		// both homes: they draw slots from one pool and share its counter, which
		// is how a home gets handed a worktree of the OTHER home's clone once a
		// slot is recycled (`#verify` then refuses it — safe, and mystifying).
		assert.equal(
			dirname(dirname(realpathSync(leaseA.path))),
			dirname(dirname(realpathSync(leaseB.path))),
			`two homes, one pool: ${leaseA.path} vs ${leaseB.path}`,
		);
	},
);

test(
	"integration: distinct poolRoots give each home its own pool and its own clone",
	{ skip: skipWithoutTreehouse, timeout: 120_000 },
	async (t) => {
		const { onCleanup, cloneA, cloneB, homeA, homeB } = twoHomes(t);
		const rootA = mkdtempSync(join(tmpdir(), "cp-pool-a-"));
		const rootB = mkdtempSync(join(tmpdir(), "cp-pool-b-"));
		const shared = mkdtempSync(join(tmpdir(), "cp-shared-root-"));
		onCleanup(() => {
			for (const dir of [rootA, rootB, shared]) rmSync(dir, { recursive: true, force: true });
		});

		// Same ambient TREEHOUSE_ROOT for both (today's single-pool default);
		// only the per-home poolRoot separates them.
		const env = { ...process.env, TREEHOUSE_ROOT: shared };
		const managerA = new LeaseManager({ home: homeA, cwd: () => homeA, poolRoot: rootA, env });
		const managerB = new LeaseManager({ home: homeB, cwd: () => homeB, poolRoot: rootB, env });
		const leaseA = await managerA.acquire(cloneA, { holder: "cp-home-a", project: "demo" });
		onCleanup(async () => {
			await managerA.release(leaseA, { ignoreErrors: true });
		});
		const leaseB = await managerB.acquire(cloneB, { holder: "cp-home-b", project: "demo" });
		onCleanup(async () => {
			await managerB.release(leaseB, { ignoreErrors: true });
		});

		assert.ok(
			realpathSync(leaseA.path).startsWith(realpathSync(rootA)),
			`home A's lease must live under its own root: ${leaseA.path}`,
		);
		assert.ok(
			realpathSync(leaseB.path).startsWith(realpathSync(rootB)),
			`home B's lease must live under its own root: ${leaseB.path}`,
		);
		// The proof the seam works: each worktree belongs to its own home's clone.
		const commonA = git(leaseA.path, "rev-parse", "--git-common-dir");
		const commonB = git(leaseB.path, "rev-parse", "--git-common-dir");
		assert.notEqual(commonA, commonB, "two pools, two clones: a lease must never point at the other home's repo");
		assert.equal(realpathSync(commonA), realpathSync(join(cloneA, ".git")));
		assert.equal(realpathSync(commonB), realpathSync(join(cloneB, ".git")));
	},
);
