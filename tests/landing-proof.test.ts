/**
 * Forge PR 2, T4: the git-only landing proof against real scratch remotes.
 * No forge is asked anywhere here. Every runner records its calls, and no test
 * may see a command that writes a ref, the index, the tree or the remote.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type GitRun, type LandingProof, readLandingProof } from "../src/landing-proof.ts";
import { defaultGit, landingMoved } from "../src/teardown-head.ts";
import { advanceBase, createScratchRepo, git, rebaseMergeAndDeleteHead, type ScratchRepo, squashMergeAndDeleteHead } from "./harness/index.ts";

const MUTATING = new Set(["reset", "checkout", "switch", "commit", "update-ref", "push", "merge", "branch", "tag", "add", "rm", "restore", "stash", "rebase", "cherry-pick", "update-index", "write-tree", "symbolic-ref"]);

interface Bench {
	repo: ScratchRepo;
	calls: string[][];
	/** A linked job worktree branched from origin's current main. */
	job(id: string): string;
	run: GitRun;
}

function benchOf(t: { after(fn: () => void): void }): Bench {
	const repo = createScratchRepo({ name: "lp", files: { "README.md": "# lp\n", "src/a.ts": "a1\n", "src/b.ts": "b1\n" } });
	t.after(() => repo.cleanup());
	const calls: string[][] = [];
	return {
		repo,
		calls,
		job(id) {
			git(repo.path, "fetch", "--quiet", "origin");
			const path = join(dirname(repo.path), `wt-${id}`);
			git(repo.path, "worktree", "add", "--quiet", "--no-track", "-b", id, path, "origin/main");
			return path;
		},
		run: async (cwd, args) => {
			calls.push([...args]);
			assert.ok(!MUTATING.has(args[0] as string), `the proof never runs git ${args[0]}`);
			if (args[0] === "fetch") assert.ok(args.slice(1).every((arg) => !arg.includes(":")), "a fetch names an exact sha, never a ref destination");
			return defaultGit(cwd, args);
		},
	};
}

function commit(worktree: string, files: Record<string, string | null>, message = "work"): string {
	for (const [path, content] of Object.entries(files)) {
		const target = join(worktree, path);
		if (content === null) unlinkSync(target);
		else {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", message);
	return git(worktree, "rev-parse", "HEAD");
}

/** Push the job branch, as a worker would. */
function push(worktree: string, id: string): void {
	git(worktree, "push", "--quiet", "origin", id);
}

/** Change main on origin from a throwaway clone (another job, or a human). */
function onOrigin(repo: ScratchRepo, edit: (dir: string) => void, message = "on origin"): string {
	const clone = mkdtempSync(join(tmpdir(), "cp-lp-"));
	try {
		git(clone, "clone", "--quiet", repo.remote as string, "work");
		const work = join(clone, "work");
		edit(work);
		git(work, "add", "-A");
		git(work, "commit", "--quiet", "--allow-empty", "-m", message);
		git(work, "push", "--quiet", "origin", "main");
		return git(work, "rev-parse", "HEAD");
	} finally {
		rmSync(clone, { recursive: true, force: true });
	}
}

const isAncestor = (cwd: string, a: string, b: string) => defaultGit(cwd, ["merge-base", "--is-ancestor", a, b]).then((r) => r.status === 0);
const landed = (proof: LandingProof) => (proof.result === "landed" ? proof.evidence : assert.fail(`expected landed, got ${JSON.stringify(proof)}`));

test("landed: merge, multi-commit squash, rebase onto an advanced base and a later edit, all with the branch deleted", { timeout: 120_000 }, async (t) => {
	const b = benchOf(t);
	const { repo } = b;

	// An ordinary merge commit: the head stays an ancestor.
	const merged = b.job("cp-merge");
	const mergedHead = commit(merged, { "src/a.ts": "a2\n" });
	push(merged, "cp-merge");
	onOrigin(repo, (work) => {
		git(work, "merge", "--no-ff", "--quiet", "-m", "merge cp-merge", "origin/cp-merge");
	});
	git(repo.remote as string, "branch", "-D", "cp-merge");
	assert.equal(landed(await readLandingProof(b.run, merged, mergedHead, "main")).method, "ancestry");

	// Two commits squashed into one new sha, with unrelated base changes before and after.
	advanceBase(repo, "docs/before.md", "# before\n");
	const squashed = b.job("cp-squash");
	commit(squashed, { "src/b.ts": "b2\n" });
	const squashHead = commit(squashed, { "src/new.ts": "n1\n", "src/a.ts": null });
	push(squashed, "cp-squash");
	const squash = squashMergeAndDeleteHead(repo, "cp-squash");
	advanceBase(repo, "docs/after.md", "# after\n");
	assert.equal(await isAncestor(squashed, squashHead, squash), false, "a squash rewrites the commit");
	const viaTip = landed(await readLandingProof(b.run, squashed, squashHead, "main"));
	assert.equal(viaTip.method, "path_tree");
	assert.equal(viaTip.base_sha, git(squashed, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], "the base sha is origin's own");
	assert.ok(await isAncestor(squashed, viaTip.witness, viaTip.base_sha), "the witness is reachable from the advertised tip");
	assert.equal(viaTip.paths, 3, "every changed path, deletions included");
	assert.ok(b.calls.some((args) => args[0] === "fetch" && args.includes(viaTip.base_sha)), "a missing base object is fetched by exact sha");

	// A later edit of a touched file: an older base commit, at or after the squash, is the witness.
	advanceBase(repo, "src/b.ts", "b3\n");
	const later = landed(await readLandingProof(b.run, squashed, squashHead, "main"));
	assert.notEqual(later.witness, later.base_sha);
	assert.ok(await isAncestor(squashed, squash, later.witness));

	// Rebase onto a base that moved first: a rewritten sha.
	const rebased = b.job("cp-rebase");
	const rebaseHead = commit(rebased, { "src/c.ts": "c1\n" });
	push(rebased, "cp-rebase");
	advanceBase(repo, "docs/first.md", "# first\n");
	const replayed = rebaseMergeAndDeleteHead(repo, "cp-rebase");
	assert.notEqual(replayed, rebaseHead);
	assert.equal(await isAncestor(rebased, rebaseHead, replayed), false);
	assert.equal(landed(await readLandingProof(b.run, rebased, rebaseHead, "main")).witness, replayed);
});

test("landed: path names with spaces, newlines and pathspec magic are compared literally", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const odd = { "dir with space/new\nline.txt": "x\n", "star*[ab].txt": "y\n", ":(glob)lead.txt": "z\n" };
	const job = b.job("cp-odd");
	const head = commit(job, odd);
	push(job, "cp-odd");
	squashMergeAndDeleteHead(b.repo, "cp-odd");
	advanceBase(b.repo, "docs/after.md", "# after\n");
	assert.equal(landed(await readLandingProof(b.run, job, head, "main")).paths, 3);
});

test("not proven: partial, near-miss and extra content never pass", { timeout: 120_000 }, async (t) => {
	const b = benchOf(t);
	const { repo } = b;
	const notProven = async (id: string, files: Record<string, string | null>, land: (dir: string) => void, prepare?: (worktree: string) => void) => {
		const job = b.job(id);
		prepare?.(job);
		const head = commit(job, files);
		onOrigin(repo, land, `land ${id}`);
		const proof = await readLandingProof(b.run, job, head, "main");
		assert.equal(proof.result, "not_proven", `${id}: ${JSON.stringify(proof)}`);
	};
	await notProven("cp-partial", { "src/a.ts": "a9\n", "src/b.ts": "b9\n" }, (dir) => writeFileSync(join(dir, "src/a.ts"), "a9\n"));
	await notProven("cp-space", { "src/a.ts": "x = 1;\n" }, (dir) => writeFileSync(join(dir, "src/a.ts"), "x =  1;\n"));
	await notProven("cp-binary", { "img.bin": "\u0000\u0001\u0002" }, (dir) => writeFileSync(join(dir, "img.bin"), "\u0000\u0001\u0003"));
	await notProven("cp-mode", { "run.sh": "echo hi\n" }, (dir) => writeFileSync(join(dir, "run.sh"), "echo hi\n"), (job) => {
		writeFileSync(join(job, "run.sh"), "echo hi\n");
		chmodSync(join(job, "run.sh"), 0o755);
	});
	await notProven("cp-link", {}, (dir) => writeFileSync(join(dir, "link"), "src/a.ts"), (job) => symlinkSync("src/a.ts", join(job, "link")));
	await notProven("cp-delete", { "src/b.ts": null }, (dir) => writeFileSync(join(dir, "docs.md"), "unrelated\n"));
	await notProven("cp-rename", { "src/b.ts": null, "src/moved.ts": "b1\n" }, (dir) => writeFileSync(join(dir, "src/moved.ts"), "b1\n"));

	// A squash-merged head with one more commit on top: the extra commit landed nowhere.
	const extra = b.job("cp-extra");
	commit(extra, { "src/a.ts": "e1\n" });
	push(extra, "cp-extra");
	squashMergeAndDeleteHead(repo, "cp-extra");
	const later = commit(extra, { "src/a.ts": "e2\n" });
	assert.equal((await readLandingProof(b.run, extra, later, "main")).result, "not_proven");
});

test("not proven: a stale tracking ref that held the squash is not the base origin advertises", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const job = b.job("cp-stale");
	const head = commit(job, { "src/a.ts": "s1\n" });
	push(job, "cp-stale");
	const squash = squashMergeAndDeleteHead(b.repo, "cp-stale");
	git(job, "fetch", "--quiet", "origin");
	assert.equal(git(job, "rev-parse", "refs/remotes/origin/main"), squash, "the local tracking ref holds the squash");
	git(b.repo.remote as string, "update-ref", "refs/heads/main", `${squash}^`);
	advanceBase(b.repo, "docs/elsewhere.md", "# moved elsewhere\n");
	assert.equal((await readLandingProof(b.run, job, head, "main")).result, "not_proven");
});

test("unknown: missing inputs, broken commands, odd history and every budget keep the lease", { timeout: 120_000 }, async (t) => {
	const b = benchOf(t);
	const job = b.job("cp-unknown");
	commit(job, { "src/a.ts": "u1\n" });
	const head = commit(job, { "src/b.ts": "u2\n" });
	push(job, "cp-unknown");
	squashMergeAndDeleteHead(b.repo, "cp-unknown");
	advanceBase(b.repo, "src/a.ts", "later\n");
	advanceBase(b.repo, "docs/x.md", "# x\n");
	const bent = (bend: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string } | undefined): GitRun =>
		async (cwd, args) => bend(args) ?? b.run(cwd, args);
	const unknown = async (label: string, proof: Promise<LandingProof>, detail: RegExp) => {
		const result = await proof;
		assert.equal(result.result, "unknown", `${label}: ${JSON.stringify(result)}`);
		assert.match(result.result === "unknown" ? result.detail : "", detail, label);
	};
	await unknown("absent base", readLandingProof(b.run, job, head, "no-such-base"), /advertises no no-such-base/);
	await unknown("origin unreachable", readLandingProof(bent((a) => (a[0] === "ls-remote" ? { status: 128, stdout: "", stderr: "fatal: unreachable" } : undefined)), job, head, "main"), /could not be asked/);
	await unknown("object unavailable", readLandingProof(bent((a) => (a[0] === "fetch" ? { status: 128, stdout: "", stderr: "no" } : a[0] === "cat-file" ? { status: 1, stdout: "", stderr: "" } : undefined)), job, head, "main"), /could not be fetched/);
	await unknown("command failure", readLandingProof(bent((a) => (a[0] === "merge-base" ? { status: 128, stdout: "", stderr: "fatal: bad object" } : undefined)), job, head, "main"), /git merge-base failed/);
	await unknown("shallow", readLandingProof(bent((a) => (a[0] === "rev-parse" && a[1] === "--is-shallow-repository" ? { status: 0, stdout: "true\n", stderr: "" } : undefined)), job, head, "main"), /shallow/);
	await unknown("ambiguous fork", readLandingProof(bent((a) => (a[0] === "merge-base" && a[1] === "--all" ? { status: 0, stdout: `${"a".repeat(40)}\n${"b".repeat(40)}\n`, stderr: "" } : undefined)), job, head, "main"), /2 merge bases/);
	await unknown("path cap", readLandingProof(b.run, job, head, "main", { limits: { paths: 1 } }), /over the 1-path limit/);
	await unknown("candidate cap", readLandingProof(b.run, job, head, "main", { limits: { candidates: 2 } }), /search limit/);
	await unknown("output cap", readLandingProof(b.run, job, head, "main", { limits: { outputBytes: 10 } }), /output exceeded/);
	let now = 0;
	await unknown("time cap", readLandingProof(b.run, job, head, "main", { limits: { commandMs: 2_500 }, clock: () => (now += 1_000) }), /ms budget/);
	assert.equal(landed(await readLandingProof(b.run, job, head, "main")).method, "path_tree", "the same job lands with the default limits");

	// A job whose commits cancel out has no content to find.
	const noop = b.job("cp-noop");
	commit(noop, { "src/a.ts": "tmp\n" });
	const noopHead = commit(noop, { "src/a.ts": "later\n" });
	advanceBase(b.repo, "docs/y.md", "# y\n");
	await unknown("zero aggregate diff", readLandingProof(b.run, noop, noopHead, "main"), /changes nothing/);
});

test("the pre-release recheck refuses a proof whose HEAD moved or whose tree went dirty", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const job = b.job("cp-race");
	const head = commit(job, { "src/a.ts": "r1\n" });
	push(job, "cp-race");
	squashMergeAndDeleteHead(b.repo, "cp-race");
	const evidence = landed(await readLandingProof(b.run, job, head, "main"));
	assert.equal(await landingMoved(b.run, job, evidence), undefined, "unchanged: the proof still describes the worktree");
	writeFileSync(join(job, "late.txt"), "late\n");
	assert.equal((await landingMoved(b.run, job, evidence))?.code, "landing_unverified", "a dirty tree after the proof keeps the lease");
	commit(job, {}, "late commit");
	assert.equal((await landingMoved(b.run, job, evidence))?.code, "landing_unverified", "a moved HEAD keeps the lease");
});
