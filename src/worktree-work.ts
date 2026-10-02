/**
 * What a settled worker left on disk (cp-0dhw) — the observation behind the
 * automatic recovery prompt.
 *
 * The defect: a worker that settles without filing an envelope is recorded
 * `unreported`, and that one word covered two opposite situations. Seven jobs
 * in one day settled with real work sitting in the worktree — one of them 834
 * insertions across 12 files and $8.56 of spend — and every recovery was
 * hand-driven: the parent noticed, ran `git status` in the worktree by hand,
 * and sent a promote naming what it saw. This module is that `git status`, done
 * once, at the settle boundary, and recorded as a fact.
 *
 * Everything here is **read-only about the worktree**, by construction: the
 * only git subcommands it can issue are `status`, `rev-list` and `ls-remote`.
 * Nothing in the recovery path may delete, reset or clean a worktree — that is
 * the whole reason the seven recoveries were worth automating rather than
 * replacing with a teardown.
 *
 * It is also fail-safe in one direction only: anything it cannot establish is
 * `unknown`, and `unknown` never triggers a prompt. Evidence prompts; ignorance
 * does not.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isoTimestamp, UNREPORTED_WORK_FILES_SHOWN, type UnreportedWork } from "./contracts.ts";

export interface GitOutput {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type WorkGitRunner = (cwd: string, args: readonly string[]) => Promise<GitOutput>;

/** The only subcommands this module may ever issue. Read-only, all three. */
export const WORKTREE_READ_ONLY_GIT: readonly string[] = Object.freeze(["status", "rev-list", "ls-remote"]);

/**
 * The guard, where the command is issued rather than where it is composed. A
 * settled worker's worktree is the only copy of work that has not been pushed;
 * an observation that could mutate it is not an observation.
 */
export function assertReadOnlyGit(args: readonly string[]): void {
	const subcommand = args[0] ?? "";
	if (!WORKTREE_READ_ONLY_GIT.includes(subcommand)) {
		throw new Error(`inspectWorktreeWork may only run ${WORKTREE_READ_ONLY_GIT.join("/")}, not "${subcommand}"`);
	}
}

export interface InspectWorktreeOptions {
	git?: WorkGitRunner;
	gitBin?: string;
	timeoutMs?: number;
	now?: () => Date;
	/** Skip the one network call (`git ls-remote`). Tests and offline homes. */
	askOrigin?: boolean;
	exists?: (path: string) => boolean;
}

/**
 * Look at a job's worktree and say what is in it. Never throws: a failure to
 * observe is itself an observation (`unknown`, with the reason).
 */
export async function inspectWorktreeWork(
	worktree: string,
	branch: string,
	options: InspectWorktreeOptions = {},
): Promise<UnreportedWork> {
	const at = isoTimestamp((options.now ?? (() => new Date()))());
	const unknown = (reason: string): UnreportedWork => ({
		state: "unknown",
		files: [],
		file_count: 0,
		commits_ahead: 0,
		observed_at: at,
		reason,
	});

	const exists = options.exists ?? ((path: string) => existsSync(path));
	if (!worktree || !exists(worktree)) return unknown(`${worktree || "(no worktree)"} does not exist`);

	const run = (args: readonly string[]) => runGit(worktree, args, options);

	let porcelain: GitOutput;
	try {
		porcelain = await run(["status", "--porcelain"]);
	} catch (error) {
		return unknown(`git status failed: ${String(error)}`);
	}
	if (porcelain.status !== 0) {
		return unknown(`git status --porcelain exited ${String(porcelain.status)}: ${lastLine(porcelain.stderr)}`);
	}

	const files = parsePorcelain(porcelain.stdout);

	// Commits the remote does not have. `--not --remotes=origin` is deliberate:
	// it needs no base branch and no upstream (a freshly leased worktree has
	// neither), and a stale remote-tracking ref can only ever make it *over*
	// count, which surfaces work rather than hiding it.
	let commitsAhead = 0;
	const ahead = await run(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]).catch(() => undefined);
	if (ahead?.status === 0) {
		const parsed = Number.parseInt(ahead.stdout.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) commitsAhead = parsed;
	}

	// One bounded question to origin, and never a remote-tracking ref: those go
	// stale inside a leased worktree (cp-vk1). A failure leaves the field absent,
	// which says "not asked", not "not there".
	let branchOnOrigin: boolean | undefined;
	if (options.askOrigin !== false && branch) {
		const remote = await run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).catch(() => undefined);
		if (remote?.status === 0) branchOnOrigin = remote.stdout.trim().length > 0;
	}

	const state: UnreportedWork["state"] = files.length > 0 ? "dirty" : commitsAhead > 0 ? "unpushed" : "clean";
	return {
		state,
		files: files.slice(0, UNREPORTED_WORK_FILES_SHOWN),
		file_count: files.length,
		commits_ahead: commitsAhead,
		...(branchOnOrigin === undefined ? {} : { branch_on_origin: branchOnOrigin }),
		observed_at: at,
	};
}

/**
 * `git status --porcelain` lines to paths. A rename reports `old -> new`; the
 * new path is the one an operator (and the worker) needs to see.
 */
export function parsePorcelain(stdout: string): string[] {
	const files: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const raw = line.slice(3).trim();
		const arrow = raw.indexOf(" -> ");
		const path = arrow === -1 ? raw : raw.slice(arrow + 4);
		const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
		if (unquoted.length > 0) files.push(unquoted.slice(0, 400));
	}
	return files;
}

async function runGit(cwd: string, args: readonly string[], options: InspectWorktreeOptions): Promise<GitOutput> {
	assertReadOnlyGit(args);
	const custom = options.git;
	if (custom) return custom(cwd, args);
	return new Promise<GitOutput>((resolve) => {
		execFile(
			options.gitBin ?? "git",
			[...args],
			{ cwd, timeout: options.timeoutMs ?? 20_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = (error as { code?: unknown } | null)?.code;
				resolve({
					status: typeof code === "number" ? code : error ? 1 : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				});
			},
		);
	});
}

function lastLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.at(-1) ?? ""
	);
}
