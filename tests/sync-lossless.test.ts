/**
 * cp-8vf6 acceptance, against **real git**: when may `cp_integrate`'s sync step
 * reset a leased worktree that holds commits `origin/<branch>` does not?
 *
 * `tests/integrate.test.ts` asks the same questions through an injected argv
 * runner, which is the right tool for "which question was asked" but cannot
 * answer the one that decides whether work is destroyed: *does git itself give
 * the two heads the same cumulative patch-id after the base moved underneath
 * them?* So here `git` is real — a scratch clone, a bare remote and a linked
 * worktree, in the same shape the fleet runs in — and only `gh` is mocked.
 *
 * The fixture is the shape of all 7 false refusals of 2026-09-01: the lease
 * sits on the branch's pre-rebase head, origin's tip is the rebased head, and
 * the base carries the branch's content through a squash merge.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, type Receipt } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { Integrator, type LedgerLike, type TeardownLike } from "../src/integrate.ts";
import type { CommandRunner } from "../src/merges.ts";
import { MergeStore } from "../src/merges.ts";
import { RunRegistry } from "../src/runs.ts";
import type { TeardownResult } from "../src/teardown.ts";
import { createScratchHome, createScratchRepo, git, type ScratchRepo } from "./harness/index.ts";

const BR = "cp-sync1";
const PR_URL = "https://github.com/o/r/pull/99";
const PR_RECEIPT: Receipt = { kind: "pr", status: "open", title: `PR for ${BR}`, url: PR_URL };

/** A file long enough that two edits can be far apart, and numbered so a shift shows. */
function longFile(marker: string): string {
	const lines = [];
	for (let i = 1; i <= 30; i += 1) lines.push(i === 25 ? `line 25 ${marker}` : `line ${i}`);
	return `${lines.join("\n")}\n`;
}

const GIT_ENV: NodeJS.ProcessEnv = {
	GIT_AUTHOR_NAME: "cp test",
	GIT_AUTHOR_EMAIL: "cp@test.invalid",
	GIT_COMMITTER_NAME: "cp test",
	GIT_COMMITTER_EMAIL: "cp@test.invalid",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
};

/**
 * Real `git`, mocked `gh`. Every call is logged as `"<bin> <args…>"`, so the
 * questions the proof asked are as assertable here as in the argv suite — and
 * the answers are git's, not a fixture's.
 */
function realGitRunner(calls: string[], pr: () => unknown): CommandRunner {
	return async (cwd, bin, args, options) => {
		calls.push(`${bin} ${args.join(" ")}`);
		if (bin === "gh") {
			if (args[0] === "pr" && args[1] === "view") return { status: 0, stdout: JSON.stringify(pr()), stderr: "" };
			throw new Error(`unexpected gh call: gh ${args.join(" ")}`);
		}
		if (bin !== "git") throw new Error(`unexpected binary: ${bin}`);
		return await new Promise((resolvePromise) => {
			const child = execFile(
				bin,
				[...args],
				{ cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const code = (error as { code?: unknown } | null)?.code;
					resolvePromise({
						status: typeof code === "number" ? code : error ? 1 : 0,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
					});
				},
			);
			if (options?.stdin !== undefined) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(options.stdin);
			}
		});
	};
}

interface Fixture {
	repo: ScratchRepo;
	/** The leased worktree: a linked worktree of the clone, as every lease is. */
	lease: string;
	/** The head the lease sits on before anything is reset. */
	leaseHead: string;
	/** The branch's pre-rebase head — the same sha even when the lease was resynced. */
	preRebaseHead: string;
	/** What origin's tip for the branch is after the server-side rebase. */
	rebased: string;
	/** The squash merge commit on the base. */
	mergeCommit: string;
	home: string;
	calls: string[];
	teardowns: string[];
	integrator(options?: { base?: string }): Integrator;
	leaseGit(...args: string[]): string;
	cleanup(): void;
}

/**
 * The 2026-09-01 shape, built with real git:
 *
 *  1. `main` has a 30-line file; the branch changes line 25 in two commits and
 *     pushes;
 *  2. the lease is a linked worktree sitting on that pushed head;
 *  3. `main` gains five lines at the *top* — unrelated churn that shifts every
 *     hunk header in the branch's diff, which is precisely what defeats the
 *     cheaper proofs (`git diff --raw` blob shas, plain diff text);
 *  4. the branch is rebased onto that main server-side and force-pushed, so
 *     `origin/<branch>` is a set of new objects the lease has never held;
 *  5. `main` squash-merges the branch, so the base carries the content and no
 *     individual patch-id survives.
 */
async function fixture(
	t: { after(fn: () => void | Promise<void>): void },
	options: {
		extra?: (lease: string, repo: ScratchRepo) => void;
		conflictingRebase?: boolean;
		/**
		 * Resync the lease to the sha origin names before the run, so the sync step
		 * is a no-op and the retention policy at the end of `#finish` (cp-wcy5) is
		 * what the test is looking at.
		 */
		leaseInSync?: boolean;
	} = {},
): Promise<Fixture> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "src/app.txt": longFile("original") } });
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const calls: string[] = [];
	const teardowns: string[] = [];

	// 1. the branch, two commits, pushed.
	repo.git("checkout", "--quiet", "-b", BR);
	repo.write("src/app.txt", longFile("branch step one"));
	repo.commitAll("branch: step one");
	repo.write("src/app.txt", longFile("branch step two"));
	repo.commitAll("branch: step two");
	repo.git("push", "--quiet", "-u", "origin", BR);
	repo.git("checkout", "--quiet", repo.branch);

	// 2. the lease: a linked worktree of this clone, on the pushed head.
	const lease = join(repo.path, "..", `lease-${BR}`);
	repo.git("worktree", "add", "--quiet", lease, BR);

	// 3. unrelated churn at the top of the same file, on the base.
	const churn = mkdtempSync(join(tmpdir(), "cp-base-"));
	git(churn, "clone", "--quiet", repo.remote ?? "", "work");
	const churnWork = join(churn, "work");
	git(churnWork, "checkout", "--quiet", repo.branch);
	const shifted = `${["added a", "added b", "added c", "added d", "added e"].join("\n")}\n${longFile("original")}`;
	writeFile(join(churnWork, "src/app.txt"), shifted);
	git(churnWork, "add", "-A");
	git(churnWork, "commit", "--quiet", "-m", "base: unrelated churn above the branch's hunk");
	git(churnWork, "push", "--quiet", "origin", repo.branch);

	// 4. the server-side rebase, force-pushed onto origin/<branch>.
	git(churnWork, "checkout", "--quiet", "-B", "replay", `origin/${BR}`);
	if (options.conflictingRebase) {
		// A rebase whose conflict someone resolved: the cumulative diff genuinely
		// changed, so the proof must refuse.
		git(churnWork, "reset", "--hard", `origin/${repo.branch}`);
		writeFile(join(churnWork, "src/app.txt"), shifted.replace("line 25 original", "line 25 resolved by hand"));
		git(churnWork, "add", "-A");
		git(churnWork, "commit", "--quiet", "-m", "branch: rebased with a hand-resolved conflict");
	} else {
		git(churnWork, "rebase", "--quiet", `origin/${repo.branch}`);
	}
	git(churnWork, "push", "--quiet", "--force", "origin", `replay:${BR}`);
	const rebased = git(churnWork, "rev-parse", "HEAD");

	// 5. the squash merge onto the base.
	git(churnWork, "checkout", "--quiet", repo.branch);
	git(churnWork, "merge", "--squash", "replay");
	git(churnWork, "commit", "--quiet", "-m", `squash merge ${BR} (#99)`);
	const mergeCommit = git(churnWork, "rev-parse", "HEAD");
	git(churnWork, "push", "--quiet", "origin", repo.branch);
	rmSync(churn, { recursive: true, force: true });

	const preRebaseHead = git(lease, "rev-parse", "HEAD");
	if (options.leaseInSync) {
		git(lease, "fetch", "--quiet", "origin", BR);
		git(lease, "reset", "--hard", "--quiet", rebased);
	}

	options.extra?.(lease, repo);

	await fleet.add({
		job_id: BR,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		reported_at: isoTimestamp(),
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: lease,
		branch: BR,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		receipts: [PR_RECEIPT],
	});

	const teardown: TeardownLike = {
		async teardown(jobId) {
			teardowns.push(jobId);
			await fleet.patch(jobId, { phase: "done", closed_reason: "gated", closed_at: isoTimestamp() });
			return {
				job_id: jobId,
				torn_down: true,
				reason: "pushed",
				worktree: lease,
				branch: BR,
				lease_returned: true,
				artifacts_removed: false,
			} satisfies TeardownResult;
		},
	};
	const ledger: LedgerLike = {
		async close() {
			return {};
		},
	};

	const self: Fixture = {
		repo,
		lease,
		leaseHead: git(lease, "rev-parse", "HEAD"),
		preRebaseHead,
		rebased,
		mergeCommit,
		home: home.path,
		calls,
		teardowns,
		leaseGit: (...args) => git(lease, ...args),
		integrator(integratorOptions = {}) {
			const run = realGitRunner(calls, () => ({
				number: 99,
				url: PR_URL,
				state: "MERGED",
				mergeable: "MERGEABLE",
				mergedAt: "2026-09-01T10:00:00Z",
				mergeCommit: { oid: mergeCommit },
				headRefName: BR,
				headRefOid: rebased,
				baseRefName: integratorOptions.base ?? repo.branch,
			}));
			return new Integrator({
				home: home.path,
				fleet,
				merges: new MergeStore({ home: home.path, fleet, runs, run }),
				teardown,
				ledger: () => ledger,
				projectDir: () => repo.path,
				runs,
				run,
			});
		},
		cleanup() {
			runs.closeAll();
			try {
				repo.git("worktree", "remove", "--force", lease);
			} catch {
				// The reset/teardown paths may have left it however they left it; the
				// scratch root is removed wholesale below either way.
			}
			repo.cleanup();
			home.cleanup();
		},
	};
	t.after(() => self.cleanup());
	return self;
}

/** Deliberately not `repo.write`: these land in the lease or a throwaway clone. */
function writeFile(path: string, content: string | Buffer): void {
	writeFileSync(path, content);
}

/** The salvage refs the sync step wrote, as `<ref> <sha>` pairs. */
function salvageRefs(lease: string): Array<[string, string]> {
	const listed = git(lease, "for-each-ref", "--format=%(refname) %(objectname)", "refs/cp-salvage");
	return listed.length === 0
		? []
		: listed.split("\n").map((line) => {
				const [ref, sha] = line.split(" ");
				return [ref ?? "", sha ?? ""] as [string, string];
			});
}

// ---------------------------------------------------------------------------

test("the 7 refusals of 2026-09-01, replayed against real git: the reset now proceeds", async (t) => {
	const f = await fixture(t);

	// The shape is real before anything runs: the lease holds commits origin's
	// tip does not, which is what refused seven times. (The fetch is the sync
	// step's own first move; here it is only so the assertion can resolve the
	// rebased sha, which was pushed from elsewhere.)
	f.leaseGit("fetch", "--quiet", "origin", BR);
	assert.equal(Number(f.leaseGit("rev-list", "--count", `${f.rebased}..HEAD`)), 2);
	assert.notEqual(f.leaseHead, f.rebased);
	assert.ok(f.leaseGit("status", "--porcelain").length === 0, "the lease is clean");

	const result = await f.integrator().advance({ jobId: BR });
	assert.equal(result.next, "done", result.reason);
	assert.equal(f.leaseGit("rev-parse", "HEAD"), f.rebased, "the lease must now sit on the sha origin named");
	assert.equal(f.teardowns.length, 1, "the whole point: teardown is reached, not a hand-proved refusal");

	// Nothing was destroyed: the discarded head is on a ref, in the shared clone.
	const refs = salvageRefs(f.lease);
	assert.equal(refs.length, 1, "exactly one rescue ref");
	const [ref, sha] = refs[0]!;
	assert.match(ref, new RegExp(`^refs/cp-salvage/${BR}/`));
	assert.equal(sha, f.leaseHead, "the rescue ref must point at the head that was discarded");
	assert.equal(git(f.repo.path, "rev-parse", ref), f.leaseHead, "and be visible in the clone the lease belongs to");

	// The questions, not just the outcome: the base tip came from origin, both
	// sides were identified by patch-id, and no remote-tracking ref was read.
	assert.ok(
		f.calls.includes(`git ls-remote --heads origin ${f.repo.branch}`),
		"the base tip must be asked of origin itself",
	);
	assert.equal(f.calls.filter((line) => line === "git patch-id --stable").length, 2);
	assert.equal(
		f.calls.filter((line) => line.startsWith("git reset")).length,
		1,
		"exactly one reset, and only after the proof",
	);
	assert.ok(!f.calls.some((line) => line.includes("refs/remotes/")), "the sync step never reads refs/remotes/*");
	assert.ok(
		!f.calls.some((line) => line.startsWith("git ") && !line.includes("--is-ancestor") && line.includes(`origin/${f.repo.branch}`)),
		"the base is a sha from origin, never `origin/<base>`",
	);

	// The fact the parent relays names the discard and where it is recoverable.
	const fact = result.facts.find((line) => line.includes("worktree reset to"));
	assert.ok(fact, "the sync fact is missing");
	assert.match(fact, /2 pre-rebase commit\(s\) were discarded/);
	assert.match(fact, new RegExp(`kept at refs/cp-salvage/${BR}/`));
});

test("the dangerous inverse: a commit whose content the base does not carry still refuses, and the work survives", async (t) => {
	const f = await fixture(t, {
		extra: (lease) => {
			// An implementer that committed and did not push: real work, in exactly
			// one place. Nothing in this job may discard it.
			writeFile(join(lease, "src/unpushed.txt"), "work that exists nowhere else\n");
			git(lease, "add", "-A");
			git(lease, "commit", "--quiet", "-m", "wip: not pushed anywhere");
		},
	});
	const before = f.leaseGit("rev-parse", "HEAD");

	const result = await f.integrator().advance({ jobId: BR });
	assert.equal(result.step, "sync");
	assert.equal(result.next, "surface");
	assert.equal(f.teardowns.length, 0);
	assert.ok(!f.calls.some((line) => line.startsWith("git reset")), "no reset may be issued at all");
	assert.deepEqual(salvageRefs(f.lease), [], "nothing was salvaged because nothing was discarded");

	// The work is still there, in the tree and in history.
	assert.equal(f.leaseGit("rev-parse", "HEAD"), before);
	assert.ok(existsSync(join(f.lease, "src/unpushed.txt")));
	assert.equal(readFileSync(join(f.lease, "src/unpushed.txt"), "utf8"), "work that exists nowhere else\n");
	assert.match(result.reason, /could not be proven to be already in main/);
	assert.match(result.reason, /fix it in place rather than reaching for force/);
});

test("a binary-only unpushed change is not invisible to the proof: it refuses too", async (t) => {
	const f = await fixture(t, {
		extra: (lease) => {
			writeFile(join(lease, "src/blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]));
			git(lease, "add", "-A");
			git(lease, "commit", "--quiet", "-m", "wip: a binary blob, unpushed");
		},
	});
	const before = f.leaseGit("rev-parse", "HEAD");
	const result = await f.integrator().advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.ok(!f.calls.some((line) => line.startsWith("git reset")));
	assert.equal(f.leaseGit("rev-parse", "HEAD"), before);
	assert.ok(existsSync(join(f.lease, "src/blob.bin")));
});

test("a rebase whose conflict was resolved by hand changed the content, so it refuses", async (t) => {
	const f = await fixture(t, { conflictingRebase: true });
	const result = await f.integrator().advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.ok(!f.calls.some((line) => line.startsWith("git reset")), "a changed cumulative diff is not a proof");
	assert.match(result.reason, /is not the one origin's tip carries/);
	assert.equal(f.teardowns.length, 0);
});

test("a base origin does not have proves nothing, and is never looked up as a tracking ref", async (t) => {
	const f = await fixture(t);
	const result = await f.integrator({ base: "release-42" }).advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.ok(!f.calls.some((line) => line.startsWith("git reset")));
	assert.match(result.reason, /origin did not name a tip for release-42/);
	assert.ok(
		!f.calls.some((line) => line.startsWith("git ") && line.includes("origin/release-42")),
		"an unreadable base is never a reason to reach for the ref",
	);
	assert.deepEqual(salvageRefs(f.lease), []);
});

// ---------------------------------------------------------------------------
// cp-wcy5: the retention policy for those rescue refs, against real git.
//
// The refs cp-8vf6 writes accumulate one per proven reset, and nothing pruned
// them. Deletion here has to be as safe as the write was, so exactly one thing
// licenses it: the commit is **provably reachable** from the tip origin names
// for the base. Real git is the only witness that can answer that — a mocked
// `merge-base --is-ancestor` would be asserting the fixture, not git.
// ---------------------------------------------------------------------------

/** The rescue refs whose commits are still readable objects, as `<ref> <type>`. */
function refType(repo: string, ref: string): string {
	return git(repo, "cat-file", "-t", ref);
}

test("a rescue ref whose commit the base carries is pruned; one it does not carry survives, object and all", async (t) => {
	const f = await fixture(t, { leaseInSync: true });

	// Two rescue refs of the shape `#syncWorktree` writes, in the shared clone:
	//  - one on a commit the base provably carries (main's own first commit);
	//  - one on the branch's pre-rebase head, which a squash merge means the base
	//    will never contain — the case where the ref may be the only copy.
	const reachable = git(f.repo.path, "rev-list", "--max-parents=0", "HEAD");
	const reachableRef = "refs/cp-salvage/cp-old1/2026-09-01T10-00-00Z";
	const orphanRef = `refs/cp-salvage/${BR}/2026-09-01T11-00-00Z`;
	git(f.repo.path, "update-ref", reachableRef, reachable);
	git(f.repo.path, "update-ref", orphanRef, f.preRebaseHead);
	// And refs this policy must never touch, in three near-miss shapes.
	git(f.repo.path, "update-ref", "refs/cp-salvage-old/cp-x/2026", reachable);
	git(f.repo.path, "update-ref", "refs/keepme", reachable);
	const branchesBefore = git(f.repo.path, "for-each-ref", "--format=%(refname)", "refs/heads");

	const result = await f.integrator().advance({ jobId: BR });
	assert.equal(result.next, "done", result.reason);

	// The reachable one is gone; the orphan is still there, still resolves, and
	// its commit is still a readable object with its content intact.
	const refs = new Map(salvageRefs(f.lease));
	assert.equal(refs.has(reachableRef), false, "a commit the base carries is redundant, so its ref is pruned");
	assert.equal(refs.get(orphanRef), f.preRebaseHead, "an unreachable commit's ref must survive");
	assert.equal(git(f.repo.path, "rev-parse", orphanRef), f.preRebaseHead);
	assert.equal(refType(f.repo.path, orphanRef), "commit");
	assert.match(
		git(f.repo.path, "show", `${f.preRebaseHead}:src/app.txt`),
		/line 25 branch step two/,
		"the discarded work is still readable through the ref that was kept",
	);

	// Nothing outside refs/cp-salvage/ was touched, and no delete named one.
	assert.equal(git(f.repo.path, "rev-parse", "refs/cp-salvage-old/cp-x/2026"), reachable);
	assert.equal(git(f.repo.path, "rev-parse", "refs/keepme"), reachable);
	assert.equal(git(f.repo.path, "for-each-ref", "--format=%(refname)", "refs/heads"), branchesBefore);
	const deletes = f.calls.filter((line) => line.startsWith("git update-ref -d"));
	assert.deepEqual(deletes, [`git update-ref -d ${reachableRef} ${reachable}`], "one delete, bound to the proven sha");

	// The authoritative question, asked of origin — never a remote-tracking ref.
	assert.ok(
		f.calls.includes(`git ls-remote --heads origin ${f.repo.branch}`),
		"the base tip must come from origin itself (PR #71, PR #85)",
	);
	const baseTip = git(f.repo.path, "ls-remote", "--heads", "origin", f.repo.branch).split(/\s+/)[0] ?? "";
	assert.match(baseTip, /^[0-9a-f]{40}$/);
	assert.ok(
		f.calls.includes(`git merge-base --is-ancestor ${reachable} ${baseTip}`),
		"reachability is proven against the sha origin named, not against a ref",
	);
	assert.ok(
		f.calls.includes(`git merge-base --is-ancestor ${f.preRebaseHead} ${baseTip}`),
		"and asked for every ref, not inferred from the first answer",
	);

	// What the operator sees: both lists, with a reason each.
	const pruned = result.facts.find((line) => line.includes("rescue ref(s) pruned"));
	assert.ok(pruned, `no prune fact in ${JSON.stringify(result.facts)}`);
	assert.ok(pruned.includes(reachableRef));
	assert.match(pruned, new RegExp(`the sha origin names for ${f.repo.branch}`));
	const kept = result.facts.find((line) => line.includes("rescue ref(s) kept"));
	assert.ok(kept, "a kept ref must be reported: a silently deleted one is indistinguishable from a lost one");
	assert.ok(kept.includes(orphanRef));
	assert.match(kept, new RegExp(`is not reachable from ${f.repo.branch}`));
});

test("an origin that cannot be asked keeps every rescue ref, and it is the ls-remote answer that decided", async (t) => {
	const f = await fixture(t, { leaseInSync: true });
	const reachable = git(f.repo.path, "rev-list", "--max-parents=0", "HEAD");
	const ref = "refs/cp-salvage/cp-old1/2026-09-01T10-00-00Z";
	git(f.repo.path, "update-ref", ref, reachable);
	// Origin is unreachable: the one question that licenses a delete cannot be
	// answered, even though this commit genuinely is in the base.
	git(f.repo.path, "remote", "set-url", "origin", join(f.repo.path, "..", "nowhere.git"));

	const result = await f.integrator().advance({ jobId: BR });

	assert.ok(
		f.calls.includes(`git ls-remote --heads origin ${f.repo.branch}`),
		"origin was asked, which is the question whose failure kept the ref",
	);
	assert.ok(
		!f.calls.some((line) => line.startsWith("git update-ref -d")),
		"an unreadable answer is never permission to delete",
	);
	assert.ok(
		!f.calls.some((line) => line.startsWith("git ") && !line.includes("--is-ancestor") && line.includes(`origin/${f.repo.branch}`)),
		"and never a fallback to refs/remotes/origin/<base>",
	);
	assert.equal(git(f.repo.path, "rev-parse", ref), reachable, "the ref still resolves");
	assert.equal(refType(f.repo.path, ref), "commit");
	const kept = result.facts.find((line) => line.includes("rescue ref(s) kept"));
	assert.ok(kept, `no kept fact in ${JSON.stringify(result.facts)}`);
	assert.match(kept, new RegExp(`origin did not name a tip for ${f.repo.branch}`));
});

test("a base origin does not have prunes nothing at all", async (t) => {
	const f = await fixture(t, { leaseInSync: true });
	const reachable = git(f.repo.path, "rev-list", "--max-parents=0", "HEAD");
	const ref = "refs/cp-salvage/cp-old1/2026-09-01T10-00-00Z";
	git(f.repo.path, "update-ref", ref, reachable);

	const result = await f.integrator({ base: "release-42" }).advance({ jobId: BR });

	assert.ok(!f.calls.some((line) => line.startsWith("git update-ref -d")));
	assert.equal(git(f.repo.path, "rev-parse", ref), reachable);
	assert.ok(result.facts.some((line) => /rescue ref\(s\) kept/.test(line)));
});
