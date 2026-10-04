/**
 * t3code adoption 7: a hidden baseline ref per job. Dispatch captures the
 * worktree's HEAD at a ref outside `refs/heads/*` (so no branch listing,
 * `git push` or `git branch` touches it), revive shows it, teardown deletes it.
 * There is deliberately no restore: nothing here resets a worktree.
 */

import type { GitRunner } from "./revive.ts";

export function checkpointRef(jobId: string): string {
	return `refs/cp-checkpoints/${jobId}`;
}

/** Point the job's checkpoint ref at HEAD. Never throws; a failure is returned, not hidden. */
export async function captureCheckpoint(git: GitRunner, worktree: string, jobId: string): Promise<{ ref: string; sha: string } | { error: string }> {
	const ref = checkpointRef(jobId);
	try {
		const head = await git(worktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
		const sha = head.stdout.trim();
		if (head.status !== 0 || sha === "") return { error: `HEAD could not be read in ${worktree}` };
		const update = await git(worktree, ["update-ref", ref, sha]);
		return update.status === 0 ? { ref, sha } : { error: update.stderr.trim() || `git update-ref ${ref} failed` };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/** The sha a checkpoint ref points at, or undefined when it is missing or unreadable. */
export async function readCheckpoint(git: GitRunner, worktree: string, ref: string): Promise<string | undefined> {
	try {
		const result = await git(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Delete the ref. A missing ref (or worktree) is not an error: true only when git confirmed a delete. */
export async function deleteCheckpoint(git: GitRunner, worktree: string, ref: string): Promise<boolean> {
	try {
		return (await git(worktree, ["update-ref", "-d", ref])).status === 0;
	} catch {
		return false;
	}
}
