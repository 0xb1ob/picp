/**
 * T12 acceptance: every policy branch of `cp_check`, and an occupied worktree
 * refused with the promote instruction.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { decideOccupancy, formatPreflight, type GitResult, Preflight, type PreflightResult } from "../src/preflight.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { createScratchHome, createScratchRepo, git, type ScratchHome, type ScratchRepo } from "./harness/index.ts";

/** A real `git` runner, for the calls a scripted fetch stub delegates through. */
function realGit(cwd: string, args: readonly string[]): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		execFile("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const status =
				error && typeof (error as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/**
 * A `GitRunner` that scripts the outcomes of successive `fetch origin` calls
 * (by status/stderr) and delegates every other git command to the real
 * binary against the scratch clone — hermetic, no network, no real ref-lock
 * race required.
 */
function scriptedFetch(fetchResults: readonly Pick<GitResult, "status" | "stderr">[]): (cwd: string, args: readonly string[]) => Promise<GitResult> {
	let call = 0;
	return async (cwd, args) => {
		if (args[0] === "fetch") {
			const next = fetchResults[Math.min(call, fetchResults.length - 1)] ?? { status: 1, stderr: "" };
			call++;
			return { status: next.status, stdout: "", stderr: next.stderr };
		}
		return realGit(cwd, args);
	};
}

function job(overrides: Partial<FleetRecord> = {}): FleetRecord {
	const jobId = overrides.job_id ?? "cp-job";
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: 4242,
			session_id: "s",
			session_file: "/tmp/s.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "mock/big",
			started_at: isoTimestamp(),
		},
		worktree: "/pool/1/demo",
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// promote-not-spawn, as pure policy
// ---------------------------------------------------------------------------

test("same worktree + same model promotes; nothing else does", () => {
	const held = job({ job_id: "cp-a", phase: "held", reported_at: isoTimestamp() });

	const promote = decideOccupancy([held], { jobId: "cp-b", project: "demo", model: "mock/big", worktree: "/pool/1/demo" });
	assert.equal(promote.kind, "promote");
	assert.match(promote.kind === "promote" ? promote.instruction : "", /cp_send cp-a/);
	assert.match(promote.kind === "promote" ? promote.instruction : "", /do not treehouse get --lease/);

	// cross-model role hop: teardown + fresh dispatch, never a promote
	const crossModel = decideOccupancy([held], {
		jobId: "cp-b",
		project: "demo",
		model: "mock/small",
		worktree: "/pool/1/demo",
	});
	assert.equal(crossModel.kind, "refuse");
	assert.match(crossModel.kind === "refuse" ? crossModel.fix : "", /new lease|tear/);

	// no model named: we cannot prove "same model", so we refuse
	assert.equal(
		decideOccupancy([held], { jobId: "cp-b", project: "demo", worktree: "/pool/1/demo" }).kind,
		"refuse",
	);

	// a second worktree on the same repo is an independent job
	assert.deepEqual(
		decideOccupancy([held], { jobId: "cp-b", project: "demo", model: "mock/big", worktree: "/pool/2/demo" }),
		{ kind: "clear" },
	);

	// the lease was returned: nothing occupies anything
	const done = job({ job_id: "cp-a", phase: "done", closed_at: isoTimestamp() });
	assert.deepEqual(
		decideOccupancy([done], { jobId: "cp-b", project: "demo", model: "mock/big", worktree: "/pool/1/demo" }),
		{ kind: "clear" },
	);
});

test("one worker per job: a job with a live worker is promoted, never re-dispatched", () => {
	const own = job({ job_id: "cp-a" });
	const promote = decideOccupancy([own], { jobId: "cp-a", project: "demo", model: "mock/big" });
	assert.equal(promote.kind, "promote");
	assert.match(promote.kind === "promote" ? promote.message : "", /already has a live/);

	const otherTree = decideOccupancy([own], {
		jobId: "cp-a",
		project: "demo",
		model: "mock/big",
		worktree: "/pool/9/demo",
	});
	assert.equal(otherTree.kind, "refuse");
	assert.match(otherTree.kind === "refuse" ? otherTree.message : "", /never holds two worktrees/);

	const hop = decideOccupancy([own], { jobId: "cp-a", project: "demo", model: "mock/small" });
	assert.equal(hop.kind, "refuse");
	assert.match(hop.kind === "refuse" ? hop.fix : "", /cp_teardown cp-a/);
});

test("script occupancy refuses replay and never offers promotion", () => {
	const script = { ...job({ job_id: "cp-script", delivery: "local" }), executor: "script", worker: undefined, script_path: "scripts/run.sh", script_process: { pid: 4242, started_at: isoTimestamp() } } as unknown as FleetRecord;
	const own = decideOccupancy([script], { jobId: "cp-script", project: "demo" });
	assert.equal(own.kind, "refuse");
	assert.match(own.kind === "refuse" ? own.fix : "", /tear.*down/);
	const other = decideOccupancy([script], { jobId: "cp-other", project: "demo", model: "mock/big", worktree: script.worktree });
	assert.equal(other.kind, "refuse");
});

// ---------------------------------------------------------------------------
// the real check against scratch git
// ---------------------------------------------------------------------------

interface Fixture {
	home: ScratchHome;
	repo: ScratchRepo;
	registry: ProjectRegistry;
	fleet: FleetStore;
	preflight: Preflight;
	clone: string;
}

async function fixture(
	t: { after(fn: () => void): void },
	name = "demo",
	opts: { git?: (cwd: string, args: readonly string[]) => Promise<GitResult>; fetchRetryDelayMs?: number } = {},
): Promise<Fixture> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name, files: { "README.md": `# ${name}\n` } });
	t.after(() => {
		home.cleanup();
		repo.cleanup();
	});
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name, clone_url: repo.remote as string });
	mkdirSync(join(home.path, LAYOUT.projects), { recursive: true });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, registry.pathOf(name)]);
	const fleet = new FleetStore({ home: home.path });
	return {
		home,
		repo,
		registry,
		fleet,
		clone: registry.pathOf(name),
		preflight: new Preflight({
			registry,
			fleet,
			...(opts.git ? { git: opts.git } : {}),
			fetchRetryDelayMs: opts.fetchRetryDelayMs ?? 1,
		}),
	};
}

function codes(result: PreflightResult): string[] {
	return result.findings.map((finding) => finding.code);
}

test("a clean canonical clone passes preflight", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const result = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big" });
	assert.equal(result.status, "ok", formatPreflight(result));
	assert.deepEqual(codes(result), []);
	assert.equal(result.base, "main");
	assert.equal(result.clone, f.clone);
});

test("an unregistered project fails before anything else runs", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const result = await f.preflight.check({ project: "ghost", jobId: "cp-new", model: "mock/big" });
	assert.equal(result.status, "fail");
	assert.deepEqual(codes(result), ["clone_not_canonical"]);
	assert.match(formatPreflight(result), /fix: register the project/);
});

test("git preflight catches a leftover branch, a wrong base and a detached primary", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);

	git(f.clone, "branch", "cp-taken");
	const taken = await f.preflight.check({ project: "demo", jobId: "cp-taken", model: "mock/big" });
	assert.equal(taken.status, "fail");
	assert.ok(codes(taken).includes("branch_exists"));

	const missingBase = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big", base: "nope" });
	assert.ok(codes(missingBase).includes("base_missing"));

	git(f.clone, "checkout", "--quiet", "-b", "side");
	const offBase = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big" });
	assert.ok(codes(offBase).includes("primary_off_base"), codes(offBase).join(","));

	git(f.clone, "checkout", "--quiet", "--detach", "HEAD");
	const detached = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big" });
	assert.ok(codes(detached).includes("primary_detached"));
});

test("a dirty primary warns; a dirty target worktree fails", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	writeFileSync(join(f.clone, "scratch.txt"), "local work\n");
	const warned = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big" });
	assert.equal(warned.status, "ok", "the operator's own tree does not block a job cut from origin/base");
	assert.deepEqual(codes(warned), ["primary_dirty"]);

	const worktree = join(f.home.path, "wt-dirty");
	git(f.clone, "worktree", "add", "--quiet", worktree, "-b", "cp-dirty");
	writeFileSync(join(worktree, "dirt.txt"), "x\n");
	const failed = await f.preflight.check({ project: "demo", jobId: "cp-dirty", model: "mock/big", worktree });
	assert.equal(failed.status, "fail");
	assert.ok(codes(failed).includes("worktree_dirty"));
});

test("a worktree from another repo, and the primary itself, are refused", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const other = createScratchRepo({ name: "other", files: { "README.md": "# other\n" } });
	t.after(() => other.cleanup());

	const foreign = join(f.home.path, "wt-foreign");
	git(other.path, "worktree", "add", "--quiet", foreign, "-b", "foreign-branch");
	const foreignResult = await f.preflight.check({ project: "demo", jobId: "cp-x", model: "mock/big", worktree: foreign });
	assert.equal(foreignResult.status, "fail");
	assert.ok(codes(foreignResult).includes("worktree_foreign"));
	assert.match(formatPreflight(foreignResult), /treehouse return --force/);

	const primaryResult = await f.preflight.check({
		project: "demo",
		jobId: "cp-x",
		model: "mock/big",
		worktree: f.clone,
	});
	assert.ok(codes(primaryResult).includes("worktree_is_primary"));

	const missing = await f.preflight.check({
		project: "demo",
		jobId: "cp-x",
		model: "mock/big",
		worktree: join(f.home.path, "nowhere"),
	});
	assert.ok(codes(missing).includes("worktree_missing"));
});

test("an occupied worktree is refused with the promote instruction", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const worktree = join(f.home.path, "wt-held");
	git(f.clone, "worktree", "add", "--quiet", worktree, "-b", "cp-held");
	await f.fleet.add(
		job({
			job_id: "cp-held",
			phase: "held",
			reported_at: isoTimestamp(),
			worktree,
			branch: "cp-held",
			worker: { ...job().worker, model: "mock/big" },
		}),
	);

	const promote = await f.preflight.check({ project: "demo", jobId: "cp-followup", model: "mock/big", worktree });
	assert.equal(promote.status, "promote", formatPreflight(promote));
	assert.equal(promote.promote?.job_id, "cp-held");
	assert.equal(promote.promote?.model, "mock/big");
	assert.match(promote.promote?.instruction ?? "", /cp_send cp-held/);
	assert.ok(codes(promote).includes("occupied_promote"));

	const hop = await f.preflight.check({ project: "demo", jobId: "cp-followup", model: "mock/small", worktree });
	assert.equal(hop.status, "fail", "a cross-model hop is not a promote");
	assert.ok(codes(hop).includes("occupied_refuse"));
	assert.equal(hop.promote, undefined);

	// a fresh lease elsewhere in the same repo stays legal
	const independent = await f.preflight.check({ project: "demo", jobId: "cp-other", model: "mock/small" });
	assert.equal(independent.status, "ok", formatPreflight(independent));
});

test("a fetch failure and an origin mismatch both fail closed", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	git(f.clone, "remote", "set-url", "origin", join(f.home.path, "does-not-exist.git"));

	const result = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big", fetch: true });
	assert.equal(result.status, "fail");
	assert.ok(codes(result).includes("origin_mismatch"), codes(result).join(","));
	assert.ok(codes(result).includes("fetch_failed"), codes(result).join(","));
});

test("a fetch that fails on ref-lock contention and then succeeds resolves without a finding", { timeout: 60_000 }, async (t) => {
	const contention = scriptedFetch([
		{ status: 1, stderr: "! 25068e4..1067438 main -> origin/main (unable to update local ref)" },
		{ status: 1, stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at 25068e4 but expected 1067438" },
		{ status: 0, stderr: "" },
	]);
	const f = await fixture(t, "demo", { git: contention });

	const result = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big", fetch: true });
	assert.equal(result.status, "ok", formatPreflight(result));
	assert.ok(!codes(result).includes("fetch_failed"), codes(result).join(","));
	assert.ok(!codes(result).includes("fetch_contention"), codes(result).join(","));
});

test("ref-lock contention that never clears fails closed with its own code, not the remote fix", { timeout: 60_000 }, async (t) => {
	const alwaysContended = scriptedFetch([
		{ status: 1, stderr: "error: cannot lock ref 'refs/remotes/origin/main': unable to update local ref" },
	]);
	const f = await fixture(t, "demo", { git: alwaysContended });

	const result = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big", fetch: true });
	assert.equal(result.status, "fail");
	assert.ok(codes(result).includes("fetch_contention"), codes(result).join(","));
	assert.ok(!codes(result).includes("fetch_failed"), codes(result).join(","));
	const finding = result.findings.find((f2) => f2.code === "fetch_contention");
	assert.match(finding?.fix ?? "", /contention|retry/i);
	assert.doesNotMatch(finding?.fix ?? "", /reachable origin remote/);
});

test("an unreachable remote still fails with the remote-oriented fix, not contention", { timeout: 60_000 }, async (t) => {
	const unreachable = scriptedFetch([{ status: 128, stderr: "fatal: could not read from remote repository." }]);
	const f = await fixture(t, "demo", { git: unreachable });

	const result = await f.preflight.check({ project: "demo", jobId: "cp-new", model: "mock/big", fetch: true });
	assert.equal(result.status, "fail");
	assert.ok(codes(result).includes("fetch_failed"), codes(result).join(","));
	assert.ok(!codes(result).includes("fetch_contention"), codes(result).join(","));
	const finding = result.findings.find((f2) => f2.code === "fetch_failed");
	assert.match(finding?.fix ?? "", /reachable origin remote/);
});
