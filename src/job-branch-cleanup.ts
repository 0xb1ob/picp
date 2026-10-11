/** cp-bw4's branch undo, moved out of dispatch.ts verbatim; `dispatch.ts` re-exports it for its importers. */
import { JOB_ID_PATTERN } from "./contracts.ts";
import type { GitRunner } from "./dispatch.ts";

/** What `cleanupCreatedJobBranch` did, and why. Journaled as `job_branch_cleaned`. */
export interface JobBranchCleanup {
	deleted: boolean;
	/** The sha the branch pointed at when it was removed. Only when deleted. */
	at?: string;
	/** Why it was left alone, or why the removal failed. Only when NOT deleted. */
	note?: string;
}

/**
 * cp-bw4: undo the branch **this dispatch** created, and only when deleting it
 * provably destroys nothing.
 *
 * The guard is deliberately narrow, because this runs inside a `catch` — the
 * one place the code already knows an assumption failed:
 *
 *  - the caller must have observed `#createJobBranch` succeed in this call
 *    (that is the caller's `branchCreatedHere` flag, never inferred here from
 *    the branch merely existing);
 *  - the branch name must be a job id. It always is — it is the job id — so a
 *    name that is not is a bug upstream, and a delete is the last thing that
 *    should run on it. Nothing is executed at all in that case;
 *  - the branch tip must equal `origin/<base>`, i.e. no commit was ever made on
 *    it. A branch with commits, or a tip that cannot be read, is left alone.
 *
 * Never throws: the caller wraps it in `safely()` like every other cleanup.
 * Exported so the guard is testable without a lease, a ledger or a worker.
 */
export async function cleanupCreatedJobBranch(options: {
	git: GitRunner;
	worktree: string;
	branch: string;
	base: string;
}): Promise<JobBranchCleanup> {
	const { git, worktree, branch, base } = options;
	if (!new RegExp(JOB_ID_PATTERN).test(branch)) {
		return { deleted: false, note: `refusing to remove ${branch} in ${worktree}: not a job id` };
	}
	const left = (why: string): JobBranchCleanup => ({
		deleted: false,
		note: `branch ${branch} was left in place at ${worktree} (${why}) — remove it by hand before re-dispatching`,
	});

	const tip = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	const baseTip = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]);
	const head = tip.stdout.trim();
	const anchor = baseTip.stdout.trim();
	if (tip.status !== 0 || head === "") return left("its tip could not be read");
	if (baseTip.status !== 0 || anchor === "") return left(`origin/${base} could not be read`);
	if (head !== anchor) return left("it has commits on it");

	const detached = await git(worktree, ["switch", "--detach", anchor]);
	if (detached.status !== 0) return left(`the worktree could not leave it: ${lastLine(detached.stderr)}`);
	const deleted = await git(worktree, ["branch", "-D", branch]);
	if (deleted.status !== 0) return left(`the delete failed: ${lastLine(deleted.stderr)}`);
	return { deleted: true, at: head };
}

export function lastLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.at(-1) ?? ""
	);
}
