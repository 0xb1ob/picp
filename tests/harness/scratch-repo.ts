/**
 * Scratch git fixtures: a working clone plus an optional bare "remote" so
 * push/merge/head-deleted cases are testable without network or GitHub.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ScratchRepoOptions {
	name?: string;
	/** Files committed in the initial commit. Defaults to a README. */
	files?: Record<string, string>;
	/** Create a bare remote and push `main` to it. Default true. */
	withRemote?: boolean;
	branch?: string;
}

export interface ScratchRepo {
	/** Working clone path (stands in for `projects/<name>`). */
	path: string;
	/** Bare remote path, when created. */
	remote?: string;
	name: string;
	branch: string;
	git(...args: string[]): string;
	gitIn(cwd: string, ...args: string[]): string;
	write(relativePath: string, content: string): void;
	commitAll(message: string): string;
	/** `git ls-remote --heads` branch names on the remote. */
	remoteBranches(): string[];
	isClean(): boolean;
	head(ref?: string): string;
	cleanup(): void;
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

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV },
	}).trim();
}

export function createScratchRepo(options: ScratchRepoOptions = {}): ScratchRepo {
	const root = mkdtempSync(join(tmpdir(), "cp-repo-"));
	const name = options.name ?? "demo";
	const branch = options.branch ?? "main";
	const path = join(root, name);
	mkdirSync(path, { recursive: true });

	git(path, "init", "-b", branch, "--quiet");
	git(path, "config", "user.name", "cp test");
	git(path, "config", "user.email", "cp@test.invalid");
	git(path, "config", "commit.gpgsign", "false");

	const files = options.files ?? { "README.md": `# ${name}\n` };
	const repo: ScratchRepo = {
		path,
		name,
		branch,
		git: (...args) => git(path, ...args),
		gitIn: (cwd, ...args) => git(cwd, ...args),
		write(relativePath, content) {
			const target = join(path, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		},
		commitAll(message) {
			git(path, "add", "-A");
			git(path, "commit", "-m", message, "--quiet");
			return git(path, "rev-parse", "HEAD");
		},
		remoteBranches() {
			if (!repo.remote) return [];
			return git(path, "ls-remote", "--heads", "origin")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => line.split("refs/heads/")[1] ?? "")
				.filter((value) => value.length > 0);
		},
		isClean() {
			return git(path, "status", "--porcelain") === "";
		},
		head(ref = "HEAD") {
			return git(path, "rev-parse", ref);
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};

	for (const [relativePath, content] of Object.entries(files)) {
		repo.write(relativePath, content);
	}
	repo.commitAll("initial commit");

	if (options.withRemote !== false) {
		const remote = join(root, `${name}.git`);
		// Pin the bare remote's initial branch to match `branch` explicitly:
		// leaving it to git's own default (version-dependent — some git
		// versions update an unborn HEAD to the first pushed branch, some
		// don't) left the remote's HEAD on the wrong branch name on CI
		// runners whose git differed from a local machine's, so any clone
		// of it checked out an empty "master"/"main" instead of `branch`.
		git(root, "init", "--bare", "-b", branch, "--quiet", remote);
		git(path, "remote", "add", "origin", remote);
		git(path, "push", "--quiet", "-u", "origin", branch);
		repo.remote = remote;
	}

	return repo;
}

/**
 * Simulate a squash-merge with head deletion (the teardown trap from T17).
 * Returns the merge commit on the base, which is what a merge receipt records.
 */
export function squashMergeAndDeleteHead(repo: ScratchRepo, featureBranch: string): string {
	if (!repo.remote) throw new Error("squashMergeAndDeleteHead requires a remote");
	const clone = mkdtempSync(join(tmpdir(), "cp-merge-"));
	const work = join(clone, "work");
	git(clone, "clone", "--quiet", repo.remote, "work");
	git(work, "checkout", "--quiet", repo.branch);
	git(work, "merge", "--squash", `origin/${featureBranch}`);
	git(work, "commit", "-m", `squash merge ${featureBranch}`, "--quiet");
	const mergeCommit = git(work, "rev-parse", "HEAD");
	git(work, "push", "--quiet", "origin", repo.branch);
	git(work, "push", "--quiet", "origin", "--delete", featureBranch);
	rmSync(clone, { recursive: true, force: true });
	return mergeCommit;
}

/**
 * Simulate GitHub's *rebase* merge with head deletion (cp-vk1): the branch's
 * commits are replayed onto the base as new objects, so — exactly like a squash
 * — the head oid is never an ancestor of the base afterwards.
 */
export function rebaseMergeAndDeleteHead(repo: ScratchRepo, featureBranch: string): string {
	if (!repo.remote) throw new Error("rebaseMergeAndDeleteHead requires a remote");
	const clone = mkdtempSync(join(tmpdir(), "cp-rebase-"));
	const work = join(clone, "work");
	git(clone, "clone", "--quiet", repo.remote, "work");
	git(work, "checkout", "--quiet", "-B", "replay", `origin/${featureBranch}`);
	git(work, "rebase", "--quiet", `origin/${repo.branch}`);
	git(work, "push", "--quiet", "origin", `replay:${repo.branch}`);
	const mergeCommit = git(work, "rev-parse", "HEAD");
	git(work, "push", "--quiet", "origin", "--delete", featureBranch);
	rmSync(clone, { recursive: true, force: true });
	return mergeCommit;
}

/** Land an unrelated commit on the base, so the base has moved on since a merge. */
export function advanceBase(repo: ScratchRepo, file: string, content: string): string {
	if (!repo.remote) throw new Error("advanceBase requires a remote");
	const clone = mkdtempSync(join(tmpdir(), "cp-base-"));
	const work = join(clone, "work");
	git(clone, "clone", "--quiet", repo.remote, "work");
	git(work, "checkout", "--quiet", repo.branch);
	const target = join(work, file);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
	git(work, "add", "-A");
	git(work, "commit", "-m", `advance ${file}`, "--quiet");
	const head = git(work, "rev-parse", "HEAD");
	git(work, "push", "--quiet", "origin", repo.branch);
	rmSync(clone, { recursive: true, force: true });
	return head;
}
