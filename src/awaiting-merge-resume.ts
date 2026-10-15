/**
 * awaiting_merge PR2: resume a parked job into the ship loop — same job id, branch, session, reviews and usage —
 * on a fresh lease; the historical worktree is never touched. A failure before the worker runs returns the new lease
 * and restores the parked record exactly, so a refused resume loses nothing.
 */

import { existsSync } from "node:fs";
import type { FleetRecord } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { type JobClaims, withJobClaim } from "./job-claims.ts";
import type { Lease, LeaseManager } from "./leases.ts";
import { checkoutBoundBranch } from "./pr-bind.ts";
import type { RunRegistry } from "./runs.ts";
import { defaultGit } from "./teardown-head.ts";

export const RESUME_REFUSAL_CODES = ["not_parked", "job_in_flight", "session_missing", "clone_unavailable", "lease_failed", "branch_missing", "checkout_failed", "spawn_failed"] as const;
export type ResumeRefusalCode = (typeof RESUME_REFUSAL_CODES)[number];

export class ResumeError extends Error {
	readonly code: ResumeRefusalCode;
	constructor(code: ResumeRefusalCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface ResumeResult {
	job_id: string;
	worktree: string;
	head_sha: string;
	salvaged?: string;
	/** Prepended to the resuming message: the worker's transcript still names its old worktree. */
	note: string;
}

type Git = (cwd: string, args: readonly string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export interface ResumeOptions {
	fleet: FleetStore;
	leases: Pick<LeaseManager, "acquire" | "release">;
	runs: RunRegistry;
	/** The project's verified canonical clone (`ProjectRegistry#assertCanonicalClone`); throws when unusable. */
	clone: (project: string) => string;
	/** Relaunches the job's own session in its recorded worktree (`Reviver#revive`), with every observer attached. */
	revive: (jobId: string) => Promise<unknown>;
	git?: Git;
	claims?: JobClaims;
	now?: () => Date;
	fileExists?: (path: string) => boolean;
}

export class AwaitingMergeResume {
	readonly #options: ResumeOptions;

	constructor(options: ResumeOptions) {
		this.#options = options;
	}

	resume(jobId: string): Promise<ResumeResult> {
		return withJobClaim(this.#options.claims, jobId, "resume", () => this.#resume(jobId), async (holder) => {
			throw new ResumeError("job_in_flight", `${jobId}: ${holder} is in flight on this job; retry once it settles`);
		});
	}

	async #resume(jobId: string): Promise<ResumeResult> {
		const { fleet, leases } = this.#options;
		const parkedRecord = fleet.get(jobId);
		const parked = parkedRecord?.awaiting_merge;
		if (!parkedRecord || parkedRecord.phase !== "awaiting_merge" || !parked) {
			throw new ResumeError("not_parked", `${jobId} is ${parkedRecord?.phase ?? "not in the fleet"}, not awaiting_merge; nothing to resume`);
		}
		const original = structuredClone(parkedRecord);
		const session = original.worker.session_file;
		if (!session || !(this.#options.fileExists ?? existsSync)(session)) {
			throw new ResumeError("session_missing", `${jobId}'s session file ${session || "(none recorded)"} is gone; it stays parked — a fresh worker context is never fabricated`);
		}
		let clone: string;
		try {
			clone = this.#options.clone(original.project);
		} catch (error) {
			throw new ResumeError("clone_unavailable", `${jobId}: ${(error as Error).message}`);
		}
		let lease: Lease;
		try {
			lease = await leases.acquire(clone, { holder: jobId, project: original.project });
		} catch (error) {
			throw new ResumeError("lease_failed", `${jobId}: ${(error as Error).message}; it stays parked`);
		}
		const giveBack = async (code: ResumeRefusalCode, why: string): Promise<never> => {
			const returned = await leases.release(lease, { ignoreErrors: true });
			throw new ResumeError(code, `${jobId}: ${why}; it stays parked${returned.ok ? "" : ` (and the new lease ${lease.path} was not returned: ${returned.error})`}`);
		};

		const branch = original.branch;
		const fetched = await this.#git(lease.path, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
		if (fetched.status !== 0) return giveBack("branch_missing", `origin has no readable ${branch} (${fetched.stderr.trim().split("\n").at(-1) ?? ""})`);
		const tip = (await this.#git(lease.path, ["rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim();
		let salvaged: string | undefined;
		try {
			salvaged = (await checkoutBoundBranch({ git: this.#git, worktree: lease.path, jobId, head: branch, headSha: tip, now: this.#now() })).salvaged;
		} catch (error) {
			return giveBack("checkout_failed", (error as Error).message);
		}

		// Held again on the new lease; the dead handle is cleared so the revived one is not read as exited.
		await fleet.mutate((jobs) => {
			const job = jobs.find((candidate) => candidate.job_id === jobId);
			if (!job || job.phase !== "awaiting_merge") throw new ResumeError("not_parked", `${jobId} moved to ${job?.phase ?? "missing"} during resume`);
			job.phase = "held";
			job.worktree = lease.path;
			if (lease.lease_id) job.lease_id = lease.lease_id;
			delete job.awaiting_merge;
			delete job.worker.exited_at;
			delete job.worker.exit_code;
		});
		try {
			await this.#options.revive(jobId);
		} catch (error) {
			await this.#restore(original);
			return giveBack("spawn_failed", (error as Error).message);
		}
		this.#options.runs.open(jobId).cp("awaiting_merge_resumed", {
			cycle: parked.cycle, parked_head: parked.head_sha, head_sha: tip, worktree: lease.path, ...(parked.pending ? { pending: parked.pending } : {}), ...(salvaged ? { salvaged } : {}),
		});
		const moved = tip === parked.head_sha ? "" : ` The branch moved since the handoff (${parked.head_sha.slice(0, 12)} → ${tip.slice(0, 12)}): CI and review run again on it.`;
		return {
			job_id: jobId, worktree: lease.path, head_sha: tip, ...(salvaged ? { salvaged } : {}),
			note: `[resumed from awaiting_merge] Your worktree is now ${lease.path} on ${branch} at ${tip.slice(0, 12)}; ${original.worktree} is no longer yours — work only in the new path.${moved}`,
		};
	}

	async #restore(original: FleetRecord): Promise<void> {
		await this.#options.fleet.mutate((jobs) => {
			const index = jobs.findIndex((job) => job.job_id === original.job_id);
			if (index !== -1) jobs[index] = original;
		});
	}

	#git: Git = (cwd, args) => (this.#options.git ?? defaultGit)(cwd, args);

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}
}

