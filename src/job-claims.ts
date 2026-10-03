/**
 * cp-a9fq: who owns one job's in-flight state — a teardown or an automatic
 * recovery (cur.4.2) — so the two never interleave. A forced teardown beside a
 * revive returned (or claimed to return) a lease a revived worker stood in and
 * closed the job under it. One map per CommandPost, shared by `Teardown` and
 * `BoundedRecovery`; the loser refuses, it never waits or cancels: the winner's
 * outcome is what the operator acts on next.
 *
 * ponytail: in-process only — both owners live in the one parent process that
 * holds the WorkerManager; a cross-process lock is needed only if that changes.
 */
export type JobOwner = "teardown" | "recovery";
export type JobClaims = Map<string, JobOwner>;

/**
 * Run `work` as `owner` of `jobId`; another live claim answers `busy(holder)`
 * instead. The claim is taken synchronously, before `work`'s first await, and
 * released when it settles, thrown or not.
 */
export function withJobClaim<T>(
	claims: JobClaims | undefined,
	jobId: string,
	owner: JobOwner,
	work: () => Promise<T>,
	busy: (holder: JobOwner) => Promise<T>,
): Promise<T> {
	const holder = claims?.get(jobId);
	if (holder) return busy(holder);
	claims?.set(jobId, owner);
	return (async () => {
		try {
			return await work();
		} finally {
			claims?.delete(jobId);
		}
	})();
}
