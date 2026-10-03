/**
 * `cp_teardown` — give the worktree back, and only then.
 *
 * Teardown is the one place where being wrong destroys work, so every gate is
 * fail-closed and the failure mode is always **keep everything**: the lease
 * stays, the worker stays, the fleet record stays, and the operator gets a
 * message naming the fix.
 *
 * Kind-aware gates, ported from `cmdp teardown`:
 *
 *  - **ship**: clean porcelain, the work on the job branch, AND pushed.
 *    "Pushed" is satisfied by the branch **on the remote** matching HEAD, by an
 *    upstream matching HEAD, or — the trap — by the branch being **merged and
 *    its head auto-deleted**.
 *  - **research**: clean porcelain AND no local commits beyond `origin/<base>`.
 *    Research changes nothing, so a commit is a contract violation, not work.
 *  - **ship, opted in**: after the git facts hold, a job whose pipeline record
 *    has `review.enabled` must also have a resolved diff review for this exact
 *    HEAD. Opt-in only: a job with no pipeline record, or no `review` block, is
 *    invisible to that step and tears down exactly as it always did.
 *
 * The gate is keyed on kind and **not** on delivery. `delivery:local` means "no
 * PR, and no hold" — never "do not publish": returning a lease recycles the
 * worktree, and the branch survives only in `projects/<name>`, which is a
 * disposable clone-on-demand cache. Work that lives only there is parked, not
 * delivered (T29, measured).
 *
 * The merged-and-absorbed check is the ported recovery, mechanised
 * (`reports/operating-knowledge.md#teardown-merged-auto-deleted-head-branch`):
 * absence from origin reads like "never pushed", and a **three-dot** diff still
 * shows the branch's own changes after a squash merge. The definitive test was
 * the **two-dot tree diff** `git diff <branch> origin/<base>` being empty while
 * the head branch is gone from origin: main already holds this exact content.
 *
 * cp-vk1 corrected both halves of the origin question, from two real teardowns:
 *
 *  - **The remote is asked, not a remote-tracking ref.** `refs/remotes/origin/*`
 *    in a worker worktree (a separate clone under `.treehouse/`) goes stale on
 *    its own, so a branch already deleted upstream still had a ref equal to the
 *    local tip and passed the gate as `(pushed)`. That false pass is now
 *    impossible: every "is it on origin?" question goes through `git ls-remote`.
 *  - **Landing is confirmed from the PR, not from ancestry.** Squash and rebase
 *    merges both rewrite the commit, so the two-dot tree diff is only empty
 *    while the base has not moved on — for a repo that squash-merges
 *    everything, the check could never succeed once main advanced, and the
 *    refusal's own fix ("or confirm the PR merged") named no mechanism. It has
 *    one now: `cp_merged` writes a merge receipt from what `gh pr view`
 *    reported, and this gate reads it (`merged` pass reason). The tree-diff
 *    check stays as a receipt-free fallback, and `force` stays for the
 *    genuinely unprovable case — still claiming no pass reason.
 *
 * Order matters: gates → graceful worker shutdown with an **observed** close →
 * lease return → fleet `done` → ledger close for research/answer → artifact cleanup.
 *
 * T17 amendment to the ported order (which returned the lease first): the
 * worker's cwd *is* the worktree, and `treehouse return` terminates lingering
 * processes inside it. Returning first would have treehouse kill our child and
 * turn an observed shutdown into a race. The worker goes first; then the
 * worktree has nothing left in it to terminate.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type Checkpoint,
	CheckpointSchema,
	type DiffVerdict,
	DiffVerdictSchema,
	type FleetRecord,
	isoTimestamp,
	isScriptFleetRecord,
	type JobKind,
	paths,
	validate,
} from "./contracts.ts";
import { resolveDefaultBase } from "./default-base.ts";
import { isPidAlive, type FleetStore } from "./fleet.ts";
import { resolveFinalFix } from "./final-fix.ts";
import { readReviewPassVerdict } from "./merge-ask.ts";
import { type JobClaims, type JobOwner, withJobClaim } from "./job-claims.ts";
import { type Lease, leaseFromRecord, type LeaseManager } from "./leases.ts";
import { readMergeReceipt } from "./merges.ts";
import { PipelineStore } from "./pipeline.ts";
import { readStatusFile } from "./run-artifacts.ts";
import {
	acceptedHeadFailure, closeResearchLedgers, defaultGit, forcedShutdownFacts, jobInFlight, killedUnreportedWakeup, leaseReturnFailed, type LedgerCloseOutcome,
	type TeardownCallOptions, type TeardownLedger, unmanagedLiveWorker, unreportedLiveWorker,
} from "./teardown-head.ts";
import type { RunRegistry } from "./runs.ts";
import type { DurableWakeupInput } from "./wakeup-outbox.ts";
import type { WorkerManager } from "./worker-manager.ts";

export { formatTeardown } from "./teardown-head.ts";
export type { TeardownCallOptions, TeardownLedger } from "./teardown-head.ts";

export class TeardownError extends Error {}

export const GATE_CODES = [
	"worktree_missing",
	"dirty",
	"unpushed",
	"research_commits",
	"detached",
	"no_head",
	/** delivery:local: the work is not reachable from the clone's own refs. */
	"unreachable_work",
	/** review opt-in, but no diff-review verdict exists for this job at all. */
	"review_missing",
	/** A verdict exists but is not final for this HEAD: revise, or reviewed at another commit. */
	"review_pending",
	/** The diff review escalated and no human has authorized shipping it anyway. */
	"review_escalated",
	/** A failed/waiting ship job has no accepted report or merge receipt for HEAD. */
	"unreported_head",
	/** issue #2: a live or mid-turn worker with no report for this generation. */
	"unreported_live_worker",
	/** An unowned worker with a live pid: nothing here can observe its close (cp-t9yr F1). */
	"unmanaged_live_worker",
	/**
	 * cp-vk1: origin could not be asked at all (no remote, no network, no
	 * permission), so nothing is known about whether this work is off the machine.
	 * A remote-tracking ref is NOT accepted as a substitute — that is precisely the
	 * stale-ref false pass this code exists to prevent.
	 */
	"remote_unverified",
	/** cp-a9fq: automatic recovery (or another teardown) owns this job right now. */
	"job_in_flight",
	/** cp-a9fq: treehouse did not confirm the return; the lease is kept and the job is not done. */
	"lease_return_failed",
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export interface GateFailure {
	code: GateCode;
	message: string;
	fix: string;
}

export type GateOutcome = { ok: true; reason: GatePassReason } | { ok: false; failure: GateFailure };

export type GatePassReason =
	| "pushed"
	| "upstream"
	/** A merge receipt (cp_merged) says GitHub merged this exact head. */
	| "merged"
	| "merged_head_deleted"
	| "clean_research";

export interface TeardownResult {
	job_id: string;
	torn_down: boolean;
	reason?: GatePassReason;
	worktree: string;
	branch: string;
	/** The observed exit of the worker, when there was one to shut down. */
	exit_code?: number | null;
	lease_returned: boolean;
	artifacts_removed: boolean;
	failure?: GateFailure;
	/** Force ended a live worker that never reported (issue #2). */
	killed_unreported?: true;
	/** No report was ever filed: a pass reason proves the tree, not a result. */
	unreported?: true;
	/** The research/answer ledger close failed; a re-run teardown retries it. */
	ledger_close_error?: string;
	/** A re-run teardown of a done job closed its ledger row. */
	ledger_closed?: true;
}

export interface TeardownOptions {
	home: string;
	fleet: FleetStore;
	leases: LeaseManager;
	manager: WorkerManager;
	runs: RunRegistry;
	git?: GitRunner;
	now?: () => Date;
	/** Remove `state/artifacts/<job-id>` on success. Default false: the gate module and the operator still want it. */
	removeArtifacts?: boolean;
	/** Built per call by the caller, like integrate. Absent: skip the ledger close (tests that only exercise gates). */
	ledger?: () => TeardownLedger;
	/** Durable wake-up port (CommandPost#journalDurable); absent in gate-only tests. */
	journal?: (input: DurableWakeupInput) => void;
	/** cp-a9fq: shared with BoundedRecovery so a teardown and a revive never interleave on one job. */
	claims?: JobClaims;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export class Teardown {
	readonly #options: TeardownOptions;

	constructor(options: TeardownOptions) {
		this.#options = options;
	}

	teardown(jobId: string, options: TeardownCallOptions = {}): Promise<TeardownResult> {
		return withJobClaim(this.#options.claims, jobId, "teardown", () => this.#teardown(jobId, options), (holder) => this.#teardown(jobId, options, holder));
	}

	async #teardown(jobId: string, options: TeardownCallOptions, holder?: JobOwner): Promise<TeardownResult> {
		const { fleet, leases, manager, runs } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const record = fleet.get(jobId);
		if (!record) throw new TeardownError(`no fleet record for ${jobId} — nothing to tear down`);
		if (record.phase === "done") {
			const retry = await closeResearchLedgers(this.#options.home, [record], this.#options.ledger, this.#options.journal);
			return {
				job_id: jobId,
				torn_down: false,
				worktree: record.worktree,
				branch: record.branch,
				lease_returned: false,
				artifacts_removed: false,
				...(retry.closed.length ? { ledger_closed: true as const } : {}),
				...(retry.failed[0] ? { ledger_close_error: retry.failed[0].error } : {}),
			};
		}

		const base: TeardownResult = {
			job_id: jobId,
			torn_down: false,
			worktree: record.worktree,
			branch: record.branch,
			lease_returned: false,
			artifacts_removed: false,
		};
		const inFlight = holder ? jobInFlight(jobId, holder) : undefined;
		if (inFlight) {
			runs.open(jobId).cp("teardown_refused", { ...inFlight });
			return { ...base, failure: inFlight };
		}
		if (isScriptFleetRecord(record) && !record.script_process?.exited_at && !record.script_observed_exit?.exited_at) {
			if (record.script_process && isPidAlive(record.script_process.pid)) throw new TeardownError(`${jobId}: script pid ${record.script_process.pid} is still alive with no observed exit; keep the lease and inspect it before teardown`);
			if (!options.force) throw new TeardownError(`${jobId}: script exit is unknown; keep the lease, inspect the worktree, then use --force to close it deliberately`);
		}
		const unowned = unmanagedLiveWorker(this.#options.home, record, manager.get(jobId));
		if (unowned) {
			runs.open(jobId).cp("teardown_refused", { code: unowned.code, message: unowned.message, fix: unowned.fix });
			return { ...base, failure: unowned };
		}
		// issue #2: a live worker with no report is not finished work; force past it is killed_unreported.
		const unreported = options.acceptUnreported ? undefined : unreportedLiveWorker(this.#options.home, record, manager.get(jobId));
		if (unreported && (!options.force || (options.requireAuthorization && !options.authorization))) {
			const failure = options.force ? { ...unreported, fix: `force past this needs operator_quote, a verbatim sentence from an operator message. ${unreported.fix}` } : unreported;
			runs.open(jobId).cp("teardown_refused", { code: failure.code, message: failure.message, fix: failure.fix });
			return { ...base, failure };
		}
		// --- gates (skipped only by an explicit operator force) --------------
		// `force` is operator authorization, not a shortcut: it is recorded, it
		// reports no pass reason (nothing was proven), and it exists only because
		// a job whose worktree vanished must still be closable.
		let outcome: GateOutcome | undefined;
		if (!options.force) {
			outcome = await this.checkGates(record.worktree, record.branch, record.kind);
			if (outcome.ok && record.kind === "ship" && !isScriptFleetRecord(record) &&
				(record.phase === "failed" || record.phase === "waiting")) {
				const head = (await this.#git(record.worktree, ["rev-parse", "HEAD"])).stdout.trim();
				const failure = acceptedHeadFailure(this.#options.home, record, head);
				if (failure) outcome = { ok: false, failure };
			}
			if (!outcome.ok) {
				// A refusal is not a job failure: nothing broke, the gate held.
				runs.open(jobId).cp("teardown_refused", {
					code: outcome.failure.code,
					message: outcome.failure.message,
					fix: outcome.failure.fix,
				});
				return { ...base, failure: outcome.failure };
			}
		} else {
			runs.open(jobId).cp("shutdown_requested", { job_id: jobId, forced: true, gates: "skipped by operator", ...forcedShutdownFacts(unreported, options) });
		}

		// --- the worker first: its close must be ours, and observed ----------
		let exitCode: number | null | undefined;
		const managed = manager.get(jobId);
		if (managed) {
			runs.open(jobId).cp("shutdown_requested", { job_id: jobId, ...(options.acceptUnreported ? { unreported_accepted: options.acceptUnreported } : {}) });
			const exit = await managed.worker.shutdown();
			exitCode = exit.code;
			await manager.shutdown(jobId);
		} else if (!isScriptFleetRecord(record) && record.worker.exited_at) {
			// It died before we got here; the recorded close is the fact we have.
			exitCode = record.worker.exit_code ?? null;
		}

		// --- then the lease: nothing is left inside the worktree to terminate -
		const lease: Lease = leaseFromRecord({
			worktree: record.worktree,
			project: record.project,
			...(record.lease_id ? { lease_id: record.lease_id } : {}),
		});
		// cp-a9fq: lease_returned is what treehouse confirmed, never assumed; a failed return (forced or not) keeps the job open.
		const released = await leases.release(lease, { ignoreErrors: true });
		if (!released.ok) {
			const failure = leaseReturnFailed(jobId, released.error);
			runs.open(jobId).cp("teardown_refused", { ...failure });
			return { ...base, failure, ...(exitCode !== undefined ? { exit_code: exitCode } : {}) };
		}

		// --- state last -----------------------------------------------------
		const closedAt = isoTimestamp(now());
		// Populate the fleet record's usage from the run status before closing the run.
		const runStatus = readStatusFile(this.#options.home, jobId);
		const closedRecord = await fleet.patch(jobId, {
			phase: "done",
			closed_at: closedAt,
			// cp-8km: a `force` teardown skipped the gates above, so nothing was
			// proven about this job's state — an unmerged PR must never render as
			// Shipped on a record closed this way. Every other teardown proved the
			// gate, so it is marked "gated" rather than left ambiguous by absence.
			closed_reason: options.force ? "forced" : "gated",
			...(isScriptFleetRecord(record) ? {} : { worker: {
				...record.worker,
				exited_at: exitCode !== undefined ? closedAt : record.worker.exited_at,
				...(exitCode !== undefined ? { exit_code: exitCode } : {}),
			} }),
			...(runStatus ? { usage: runStatus.usage } : {}),
		});
		if (unreported) this.#options.journal?.(killedUnreportedWakeup(this.#options.home, record, closedAt, options.authorization));
		runs.close(jobId);
		const ledgerClose = await closeResearchLedgers(this.#options.home, [closedRecord], this.#options.ledger, this.#options.journal);

		let artifactsRemoved = false;
		if (this.#options.removeArtifacts) {
			const dir = join(this.#options.home, paths.artifactDir(jobId));
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
				artifactsRemoved = true;
			}
		}

		return {
			...base,
			torn_down: true,
			...(outcome?.ok ? { reason: outcome.reason } : {}),
			...(unreported ? { killed_unreported: true as const } : {}),
			...(!isScriptFleetRecord(record) && record.reported_at === undefined ? { unreported: true as const } : {}),
			...(ledgerClose.failed[0] ? { ledger_close_error: ledgerClose.failed[0].error } : {}),
			...(exitCode !== undefined ? { exit_code: exitCode } : {}),
			lease_returned: true,
			artifacts_removed: artifactsRemoved,
		};
	}

	/**
	 * Pure-ish: runs git, decides, changes nothing.
	 *
	 * Keyed on **kind only**, deliberately. `delivery` decides whether a PR is
	 * opened and whether the parent holds the worker — it does *not* relax this
	 * gate, because `projects/<name>` is a disposable cache (gitignored,
	 * clone-on-demand) and work that exists only there has been parked, not
	 * delivered. See docs/contracts.md §Teardown.
	 */
	async checkGates(worktree: string, branch: string, kind: JobKind): Promise<GateOutcome> {
		if (!isDirectory(worktree)) {
			return {
				ok: false,
				failure: {
					code: "worktree_missing",
					message: `worktree ${worktree} is missing`,
					fix: "restore the path or fix the fleet record; never return a lease you cannot inspect",
				},
			};
		}
		const dirty = await this.#git(worktree, ["status", "--porcelain"]);
		if (dirty.stdout.trim().length > 0) {
			return {
				ok: false,
				failure: {
					code: "dirty",
					message: `dirty worktree ${worktree}`,
					fix: "keep the lease; commit or clean the tree, then retry teardown",
				},
			};
		}
		const base = await this.#defaultBase(worktree);
		const outcome =
			kind === "research" ? await this.#researchGate(worktree, branch, base) : await this.#shipGate(worktree, branch, base);
		if (!outcome.ok || kind !== "ship") return outcome;
		// The git facts hold. Only now, and only for a job that opted in, is there a
		// second question: has the diff a human will merge actually been reviewed?
		// It is a separate step on purpose — `#shipGate` stays a question about git.
		return (await this.#reviewGate(worktree, branch)) ?? outcome;
	}

	// -- gates --------------------------------------------------------------

	/** Research changes nothing: a local commit past origin/<base> is a bug. */
	async #researchGate(worktree: string, branch: string, base: string): Promise<GateOutcome> {
		const ahead = await this.#git(worktree, ["rev-list", "--count", `origin/${base}..HEAD`]);
		const count = Number.parseInt(ahead.stdout.trim() || "0", 10);
		if (ahead.status === 0 && Number.isFinite(count) && count > 0) {
			return {
				ok: false,
				failure: {
					code: "research_commits",
					message: `research branch ${branch} has ${count} local commit(s) past origin/${base}`,
					fix: "keep the lease; research changes nothing — reset the branch (or convert the job to a ship job), then retry",
				},
			};
		}
		return { ok: true, reason: "clean_research" };
	}

	/**
	 * Ship must be **pushed**, or provably already landed — for every delivery.
	 *
	 * `delivery:local` means "no PR, and the parent does not hold the worker"; it
	 * does **not** mean "do not publish". Measured reason (T29): returning a lease
	 * recycles the worktree for the next job, and the job's branch survives only
	 * in `projects/<name>` — a gitignored, clone-on-demand **cache** the system is
	 * free to delete and re-clone. Work that lives only there is parked, not
	 * delivered, so the gate asks the same question of every ship job.
	 */
	async #shipGate(worktree: string, branch: string, base: string): Promise<GateOutcome> {
		const head = (await this.#git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
		if (head.length === 0) {
			return {
				ok: false,
				failure: { code: "no_head", message: `cannot read HEAD in ${worktree}`, fix: "keep the lease; inspect the worktree" },
			};
		}

		// Before asking about origin: is the work even on the job branch? A commit
		// on a detached HEAD is lost when the slot is reused, and `unpushed` would
		// have been a misleading way to say so.
		const onBranch = await this.#onJobBranch(worktree, branch, head);
		if (onBranch) return onBranch;

		// The remote itself, never `refs/remotes/origin/<branch>` (cp-vk1): a worker
		// worktree is its own clone, its remote-tracking refs go stale on their own,
		// and a ref left behind by a branch GitHub already deleted is what made two
		// jobs tear down as "(pushed)" with nothing on origin at all.
		const remote = await this.#remoteTip(worktree, branch);
		if (!remote.ok) {
			return {
				ok: false,
				failure: {
					code: "remote_unverified",
					message: `${worktree}: cannot ask origin about ${branch} (${remote.error}) — a remote-tracking ref is not evidence`,
					fix: "keep the lease; restore access to origin and retry teardown, or force if this job's delivery cannot be verified at all",
				},
			};
		}
		if (remote.sha) {
			if (remote.sha === head) return { ok: true, reason: "pushed" };
			return {
				ok: false,
				failure: {
					code: "unpushed",
					message: `${worktree} on ${branch}: local tip ${head.slice(0, 12)} != origin/${branch} (${remote.sha.slice(0, 12)})`,
					fix: "keep the lease; push the branch, then retry teardown",
				},
			};
		}

		// A branch pushed under another name still counts, but the same rule applies:
		// the upstream is resolved to a remote branch and that branch is asked.
		const upstreamOutcome = await this.#upstreamGate(worktree, branch, head);
		if (upstreamOutcome) return upstreamOutcome;

		// Nothing is on origin. Two ways that is still fine, in order of strength.
		//
		// 1. A merge receipt: `gh pr view` said MERGED, with a merge commit, for this
		//    exact head. That is true for squash, rebase and merge commits alike,
		//    which is exactly what ancestry can never be.
		const receipt = readMergeReceipt(this.#options.home, branch);
		if (receipt) {
			if (receipt.head_sha === head) return { ok: true, reason: "merged" };
			return {
				ok: false,
				failure: {
					code: "unpushed",
					message:
						`${worktree} on ${branch}: PR ${receipt.pr_url} merged head ${receipt.head_sha.slice(0, 12)}, ` +
						`but the local tip is ${head.slice(0, 12)} — those commits landed nowhere`,
					fix: "keep the lease; push the extra commits (they are not in the merged PR), then retry teardown",
				},
			};
		}

		// 2. The receipt-free fallback: the head branch is gone from origin AND the
		//    two-dot tree diff against the base is empty, so the base already holds
		//    this exact content. True only while the base has not moved on, which is
		//    why it is the fallback and the receipt is the mechanism.
		if (await this.#mergedAndAbsorbed(worktree, base)) {
			return { ok: true, reason: "merged_head_deleted" };
		}

		// Naming the stale ref is the whole point of the third case: it is the exact
		// condition that used to pass as "(pushed)", so the refusal says so out loud.
		// Reading it for a *message* is not reading it as evidence.
		const staleRef = await this.#git(worktree, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
		const stale = staleRef.status === 0 ? staleRef.stdout.trim() : "";
		return {
			ok: false,
			failure: {
				code: "unpushed",
				message:
					stale.length > 0
						? `${worktree} branch ${branch} is not on origin (origin/${branch} survives here only as a stale remote-tracking ref at ${stale.slice(0, 12)}), and origin/${base} does not contain its content`
						: `${worktree} branch ${branch} has no upstream, is not on origin, and origin/${base} does not contain its content`,
				fix: `keep the lease; push the branch — or, if its PR merged, record it with cp_merged ${branch} (gh confirms the merge) — then retry teardown`,
			},
		};
	}

	/**
	 * The upstream branch, asked of the remote it names. Returns a verdict only
	 * when there is an upstream at all; `undefined` means "carry on".
	 *
	 * An upstream is a *configured* name, not evidence: `@{u}` resolves through
	 * the same stale remote-tracking ref the caller just refused to trust, so the
	 * sha it points at is never compared here — the remote is.
	 */
	async #upstreamGate(worktree: string, branch: string, head: string): Promise<GateOutcome | undefined> {
		const upstream = await this.#git(worktree, ["rev-parse", "--abbrev-ref", "--verify", "--quiet", "@{u}"]);
		const name = upstream.status === 0 ? upstream.stdout.trim() : "";
		if (name.length === 0) return undefined;
		const slash = name.indexOf("/");
		if (slash <= 0) return undefined;
		const remoteName = name.slice(0, slash);
		const remoteBranch = name.slice(slash + 1);
		// `origin/<branch>` was already asked and answered above.
		if (remoteName === "origin" && remoteBranch === branch) return undefined;
		const tip = await this.#remoteTip(worktree, remoteBranch, remoteName);
		if (!tip.ok || !tip.sha) return undefined;
		if (tip.sha === head) return { ok: true, reason: "upstream" };
		return {
			ok: false,
			failure: {
				code: "unpushed",
				message: `${worktree} on ${branch}: local ${head.slice(0, 12)} != ${name} (${tip.sha.slice(0, 12)})`,
				fix: "keep the lease; push the branch, then retry teardown",
			},
		};
	}

	/**
	 * What the remote itself says the branch's tip is: `sha` when it exists there,
	 * `sha: undefined` when the remote answered and does not have it, and
	 * `ok: false` when the remote could not be asked (which is never treated as
	 * absence, and never falls back to a remote-tracking ref).
	 */
	async #remoteTip(
		worktree: string,
		branch: string,
		remote = "origin",
	): Promise<{ ok: true; sha?: string } | { ok: false; error: string }> {
		const result = await this.#git(worktree, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
		if (result.status !== 0) {
			const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "git ls-remote failed";
			return { ok: false, error: detail };
		}
		const line = result.stdout
			.split("\n")
			.map((entry) => entry.trim())
			.find((entry) => entry.endsWith(`refs/heads/${branch}`));
		const sha = line?.split(/\s+/)[0];
		return sha ? { ok: true, sha } : { ok: true };
	}

	/**
	 * Is HEAD the tip of the job branch? Returns a **failure** when it is not, and
	 * `undefined` when all is well (so the caller reads as "stop here, or carry
	 * on").
	 *
	 * Measured (T29): `treehouse return` recycles the worktree — the next lease
	 * gets that same path, reset onto the base — while `refs/heads/<branch>`
	 * survives in the clone. So a commit that no branch points at becomes
	 * unreachable the moment the slot is reused, whatever the delivery. That is a
	 * different failure from "not pushed", and it deserves its own name.
	 */
	async #onJobBranch(worktree: string, branch: string, head: string): Promise<GateOutcome | undefined> {
		const ref = await this.#git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		const tip = ref.stdout.trim();
		if (ref.status !== 0 || tip.length === 0) {
			return {
				ok: false,
				failure: {
					code: "unreachable_work",
					message: `${worktree}: no local branch ${branch}, so HEAD ${head.slice(0, 12)} is reachable from nothing and is lost when the lease is reused`,
					fix: `keep the lease; put the work on ${branch} (git switch -c ${branch}), push it, then retry teardown`,
				},
			};
		}
		if (tip !== head) {
			return {
				ok: false,
				failure: {
					code: "unreachable_work",
					message: `${worktree}: HEAD ${head.slice(0, 12)} is not the tip of ${branch} (${tip.slice(0, 12)}) — a detached commit is lost when the lease is reused`,
					fix: `keep the lease; put the work on ${branch} (git switch ${branch} && git merge --ff-only ${head.slice(0, 12)}), push it, then retry teardown`,
				},
			};
		}
		return undefined;
	}

	/**
	 * The diff-review gate (cp-diffgate Stage C) — opt-in, and invisible to every
	 * job that did not opt in.
	 *
	 * Scope is deliberately narrow: a `kind:ship` job whose pipeline record carries
	 * `review.enabled === true`. A job with no pipeline record, or one whose record
	 * has no `review` block, never reaches the first `existsSync` here and tears
	 * down exactly as it did before this gate existed — verdict on disk or not.
	 * That is what keeps the gate from becoming a blocker nobody asked for.
	 *
	 * No new parameter is needed to find the record: `branch === job_id` by contract
	 * (docs/contracts.md, "Branch name for a job is the job id"), and `PipelineStore`
	 * needs only the home this `Teardown` already holds.
	 *
	 * Teardown proceeds when the latest `review-<n>.json` is `pass`, or is
	 * `escalate`/`flagged` with an **approved** second (diff) checkpoint — a human
	 * saying "ship it anyway" is the only thing that clears an escalation, because
	 * evidence is not authorization and neither is its absence.
	 *
	 * Returns `undefined` when there is nothing to refuse (out of scope, or the
	 * review cleared), so the caller reads as "carry on, or stop here".
	 */
	async #reviewGate(worktree: string, branch: string): Promise<GateOutcome | undefined> {
		const home = this.#options.home;
		const pipeline = new PipelineStore(home).findByShipId(branch);
		if (pipeline?.review?.enabled !== true) return undefined;

		const head = (await this.#git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
		const job = this.#options.fleet.get(branch); // jje.3: the one approved final-fix head clears the same hold
		if (head && job && resolveFinalFix(home, job, head).state === "accepted") return undefined;
		const latest = (head ? readReviewPassVerdict(home, branch, head) : undefined) ?? this.#latestReview(branch);
		if (!latest) {
			return {
				ok: false,
				failure: {
					code: "review_missing",
					message: `${branch} opted into diff review (pipeline ${pipeline.research_id}) and no review verdict exists`,
					fix: `keep the lease; run cp_review ${branch}, then retry teardown`,
				},
			};
		}

		// "Has the code changed since the verdict?" — asked before the verdict's own
		// value, because a pass on some other commit is not a pass on this one.
		if (head.length > 0 && latest.head_sha !== head) {
			return {
				ok: false,
				failure: {
					code: "review_pending",
					message: `${branch}: diff review attempt ${latest.attempt} judged ${latest.head_sha.slice(0, 12)}, but HEAD is ${head.slice(0, 12)}`,
					fix: `keep the lease; the branch moved since it was reviewed — run cp_review ${branch} again, then retry teardown`,
				},
			};
		}

		if (latest.diff_stat.truncated) {
			return { ok: false, failure: { code: "review_escalated", message: `${branch}: diff review attempt ${latest.attempt} has a truncated subject — omitted hunks are never review evidence`, fix: "keep the lease; stage smaller PRs and cp_review each head, then retry teardown" } };
		}
		if (latest.verdict === "pass") return undefined;

		if (latest.verdict === "revise") {
			return {
				ok: false,
				failure: {
					code: "review_pending",
					message: `${branch}: diff review attempt ${latest.attempt} asked for revisions and none has been reviewed since`,
					fix: `keep the lease; land the revisions on ${branch}, push, run cp_review ${branch} again, then retry teardown`,
				},
			};
		}

		// escalate/operational is an unfinished review, not a judgment about the
		// diff: the reviewer faulted, so the answer is another attempt.
		if (latest.cause === "operational") {
			return {
				ok: false,
				failure: {
					code: "review_pending",
					message: `${branch}: diff review attempt ${latest.attempt} escalated operationally — nothing was judged`,
					fix: `keep the lease; run cp_review ${branch} again (it picks a different model), then retry teardown`,
				},
			};
		}

		// A flagged escalate is the one an operator can clear: the reviewer found the
		// diff sound apart from the flags it is required to raise.
		if (latest.cause === "flagged" && this.#diffCheckpointApproved(branch)) return undefined;

		return {
			ok: false,
			failure: {
				code: "review_escalated",
				message: `${branch}: diff review attempt ${latest.attempt} escalated (cause: ${latest.cause ?? "none"}) and no approved diff checkpoint clears it`,
				fix: `keep the lease; this is the operator's call — have the escalation authorized (the diff checkpoint for ${branch}) or fix the diff and run cp_review ${branch} again, then retry teardown`,
			},
		};
	}

	/**
	 * The last `state/runs/<job-id>/review-<n>.json`, by attempt. Read here rather
	 * than through `readPriorAttempts` so a corrupt file is a **refusal** (no
	 * verdict is readable, so none has been given) instead of an exception thrown
	 * out of a gate whose whole contract is to keep everything and name the fix.
	 */
	#latestReview(jobId: string, max = 32): DiffVerdict | undefined {
		let latest: DiffVerdict | undefined;
		for (let attempt = 1; attempt <= max; attempt += 1) {
			const file = join(this.#options.home, paths.reviewFile(jobId, attempt));
			if (!existsSync(file)) break;
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(file, "utf8"));
			} catch {
				break;
			}
			const parsed = validate<DiffVerdict>(DiffVerdictSchema, raw);
			if (!parsed.ok) break;
			latest = parsed.value;
		}
		return latest;
	}

	/** The second, post-diff authorization: `state/checkpoints/<ship-id>.diff.json`. */
	#diffCheckpointApproved(jobId: string): boolean {
		const file = join(this.#options.home, paths.checkpointFile(jobId, "diff"));
		if (!existsSync(file)) return false;
		try {
			const parsed = validate<Checkpoint>(CheckpointSchema, JSON.parse(readFileSync(file, "utf8")));
			return parsed.ok && parsed.value.decision === "approved";
		} catch {
			return false;
		}
	}

	/**
	 * Merged-and-absorbed, by the ported rules — now the **fallback** behind the
	 * merge receipt, reached only once the caller has established (from the remote
	 * itself) that the head branch is gone:
	 *
	 *  - the **two-dot tree diff** `git diff HEAD <base sha from origin>` is empty,
	 *    so the base already holds this exact content.
	 *
	 * The base sha comes from origin itself (`git ls-remote`, via `#remoteTip`),
	 * never from `refs/remotes/origin/<base>` (cp-vk1): this is a **pass**
	 * decision, and a stale tracking ref that happens to match HEAD's tree would
	 * tear a job down as "merged" when nothing merged. It fails closed — if origin
	 * cannot be asked, or the base is not there, the answer is `false` and the
	 * caller falls through to its `unpushed` refusal. A sha origin names but this
	 * clone does not have makes `git diff` exit non-zero, which is the same `false`;
	 * no fetch is issued to repair that, because a false negative here is safe and
	 * fetching is a side effect this gate does not own.
	 *
	 * A three-dot diff is deliberately not used: after a squash merge it still
	 * shows the branch's own changes and would read as "not merged". Note the
	 * limit that made cp-vk1 necessary: this is only true while the base has not
	 * moved on since the merge, which for a repo that squash-merges everything is
	 * a narrow window. The receipt is what covers the rest.
	 */
	async #mergedAndAbsorbed(worktree: string, base: string): Promise<boolean> {
		const tip = await this.#remoteTip(worktree, base);
		if (!tip.ok || !tip.sha) return false;
		const diff = await this.#git(worktree, ["diff", "--name-only", "HEAD", tip.sha]);
		return diff.status === 0 && diff.stdout.trim().length === 0;
	}

	async #defaultBase(cwd: string): Promise<string> {
		return resolveDefaultBase((c, args) => this.#git(c, args), cwd);
	}

	async #git(cwd: string, args: readonly string[]) {
		const custom = this.#options.git;
		if (custom) return custom(cwd, args);
		return defaultGit(cwd, args);
	}

	/** Startup retry (CommandPost.reconcile) of research ledger closes a crash or a failure left open; never throws. */
	async retryLedgerCloses(): Promise<LedgerCloseOutcome> {
		try {
			const done = this.#options.fleet.list({ phase: "done", kind: "research" });
			return await closeResearchLedgers(this.#options.home, done, this.#options.ledger, this.#options.journal);
		} catch (error) {
			const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
			this.#options.journal?.({ id: "ledger-close-failed:startup", kind: "recovery",
				content: `startup ledger-close retry failed — ${detail}\n  next: cp_teardown <job> retries one job's close, or cp_job close <job> with a reason.` });
			return { closed: [], failed: [] };
		}
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
