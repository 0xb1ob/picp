/**
 * `cp_check` — the pre-dispatch preflight.
 *
 * It answers exactly one question — *may this job be dispatched here, right
 * now?* — and it answers with facts:
 *
 *  1. **Canonical clone.** Delegated to the project registry (T10): the clone
 *     is at `projects/<name>`, is a primary clone, and does not belong to
 *     another repo.
 *  2. **Git preflight.** Origin matches the registration, `origin/<base>`
 *     exists after a fetch, the primary checkout is on the base branch, and a
 *     target worktree is a linked worktree of *this* clone, is not the primary
 *     checkout, and is clean.
 *  3. **Occupancy → promote-not-spawn.** Ported rule: same repo + the same
 *     worktree still held + the same model means **promote the existing
 *     worker**, never dispatch and never take a second lease. A cross-model
 *     role hop is teardown plus a fresh dispatch, so it is refused here.
 *
 * The check never dispatches, never leases, never writes fleet state. It is
 * fail-closed: anything it cannot establish is a `fail` finding with a fix.
 */

import { execFile } from "node:child_process";
import { type FleetRecord, isScriptFleetRecord, type JobPhase } from "./contracts.ts";
import { resolveDefaultBase } from "./default-base.ts";
import type { FleetStore } from "./fleet.ts";
import { canonicalDir } from "./json-store.ts";
import { ProjectError, type ProjectRegistry, sameRemote } from "./projects.ts";

/** Job phases that still hold a worker and a lease. */
export const LIVE_PHASES: readonly JobPhase[] = Object.freeze(["waiting", "held"]);

export const CHECK_CODES = [
	"clone_not_canonical",
	"origin_mismatch",
	"fetch_failed",
	"fetch_contention",
	"base_missing",
	"primary_detached",
	"primary_off_base",
	"primary_dirty",
	"worktree_missing",
	"worktree_foreign",
	"worktree_is_primary",
	"worktree_dirty",
	"branch_exists",
	"occupied_promote",
	"occupied_refuse",
	"model_unknown",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export const CHECK_STATUSES = ["ok", "promote", "fail"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckFinding {
	code: CheckCode;
	/** `fail` blocks the dispatch; `warn` is operator information. */
	level: "fail" | "warn";
	message: string;
	fix?: string;
}

export interface PromoteInstruction {
	job_id: string;
	worktree: string;
	model: string;
	profile: string;
	phase: JobPhase;
	instruction: string;
}

export interface PreflightResult {
	status: CheckStatus;
	project: string;
	clone?: string;
	base?: string;
	worktree?: string;
	/** The branch a new lease would get: the job id. */
	branch: string;
	findings: CheckFinding[];
	promote?: PromoteInstruction;
}

export interface PreflightRequest {
	project: string;
	jobId: string;
	/**
	 * Resolved model. Occupancy is fail-closed without it: "same model" cannot
	 * be asserted about a model nobody named.
	 */
	model?: string;
	/** A lease we already hold (or intend to reuse). */
	worktree?: string;
	base?: string;
	/** Run `git fetch origin` first. Default true; tests and offline runs skip. */
	fetch?: boolean;
}

// ---------------------------------------------------------------------------
// Occupancy — the ported promote-not-spawn rule, as a pure function
// ---------------------------------------------------------------------------

export type OccupancyDecision =
	| { kind: "clear" }
	| { kind: "promote"; job: FleetRecord; message: string; instruction: string }
	| { kind: "refuse"; job: FleetRecord; message: string; fix: string };

export interface OccupancyInput {
	jobId: string;
	project: string;
	model?: string;
	worktree?: string;
}

function isLive(job: FleetRecord): boolean {
	return LIVE_PHASES.includes(job.phase);
}

/**
 * Promote-not-spawn, ported verbatim in meaning:
 *
 *   same repo AND same worktree still held AND same model
 *     -> promote (send the existing worker a new brief)
 *   worktree returned, or an independent job (other repo / second worktree)
 *     -> new lease
 *
 * Plus the invariant this build adds: **one worker per job**. A job that
 * already has a live worker is promoted, never given a second one.
 */
export function decideOccupancy(jobs: readonly FleetRecord[], input: OccupancyInput): OccupancyDecision {
	const live = jobs.filter(isLive);
	const target = input.worktree ? canonicalDir(input.worktree) : undefined;

	const own = live.find((job) => job.job_id === input.jobId);
	if (own) {
		const ownWorktree = canonicalDir(own.worktree);
		if (target && target !== ownWorktree) {
			return {
				kind: "refuse",
				job: own,
				message: `${input.jobId} already holds ${own.worktree} (phase ${own.phase}); a job never holds two worktrees`,
				fix: `dispatch into ${own.worktree}, or tear the job down first (cp_teardown ${input.jobId})`,
			};
		}
		if (isScriptFleetRecord(own)) {
			return { kind: "refuse", job: own, message: `${own.job_id} already holds script ${own.script_path} on ${own.worktree}`, fix: `tear ${own.job_id} down before dispatch; a script cannot be promoted or replayed` };
		}
		if (input.model && own.worker.model !== input.model) {
			return {
				kind: "refuse",
				job: own,
				message: `${input.jobId} has a live ${own.worker.model} worker but this dispatch wants ${input.model}`,
				fix: `a cross-model role hop is teardown + fresh dispatch, never a promote: cp_teardown ${input.jobId} first`,
			};
		}
		return {
			kind: "promote",
			job: own,
			message: `${input.jobId} already has a live ${own.worker.model} worker on ${own.worktree} (phase ${own.phase})`,
			instruction: `promote it: cp_send ${input.jobId} with the new brief. Do not dispatch, do not take a second lease.`,
		};
	}

	if (!target) return { kind: "clear" };

	const occupant = live.find((job) => canonicalDir(job.worktree) === target);
	if (!occupant) return { kind: "clear" };

	if (isScriptFleetRecord(occupant)) {
		return { kind: "refuse", job: occupant, message: `${occupant.job_id} is running script ${occupant.script_path} in ${occupant.worktree}`, fix: `take a new lease or tear ${occupant.job_id} down; scripts cannot be promoted` };
	}
	if (!input.model) {
		return {
			kind: "refuse",
			job: occupant,
			message: `${occupant.job_id} occupies ${occupant.worktree} and no model was named for this dispatch`,
			fix: "resolve the model first: promote requires proving it is the same model",
		};
	}
	if (occupant.worker.model !== input.model) {
		return {
			kind: "refuse",
			job: occupant,
			message: `${occupant.worktree} is held by ${occupant.job_id} running ${occupant.worker.model}, not ${input.model}`,
			fix: `take a new lease for ${input.jobId}, or tear ${occupant.job_id} down; a cross-model hop is never a promote`,
		};
	}
	return {
		kind: "promote",
		job: occupant,
		message: `${occupant.worktree} is still held by ${occupant.job_id} on the same model (${occupant.worker.model})`,
		instruction: `promote it: cp_send ${occupant.job_id} with the new brief. Do not dispatch, do not treehouse get --lease.`,
	};
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

export interface PreflightOptions {
	registry: ProjectRegistry;
	fleet: FleetStore;
	gitBin?: string;
	timeoutMs?: number;
	git?: GitRunner;
	/** Bounded retries for a fetch that fails on ref-lock contention. Default 3. */
	fetchRetries?: number;
	/** Backoff between contention retries, in ms. Default 200. */
	fetchRetryDelayMs?: number;
	/** Injectable sleep, for hermetic tests. Default `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * A fetch failure caused by a concurrent writer on the shared canonical
 * clone racing this fetch's ref update — not a broken or unreachable remote.
 * Git reports this as "unable to update local ref", "cannot lock ref", or a
 * generic "... failed to lock" on the affected ref line.
 */
function isRefLockContention(stderr: string): boolean {
	return /unable to update local ref|cannot lock ref|failed to lock ref|reference already locked/i.test(stderr);
}

export class Preflight {
	readonly #options: PreflightOptions;

	constructor(options: PreflightOptions) {
		this.#options = options;
	}

	async check(request: PreflightRequest): Promise<PreflightResult> {
		const findings: CheckFinding[] = [];
		const result: PreflightResult = {
			status: "ok",
			project: request.project,
			branch: request.jobId,
			findings,
			...(request.worktree ? { worktree: request.worktree } : {}),
		};

		// 1. canonical clone (T10 owns the facts)
		let clone: string;
		try {
			const project = this.#options.registry.require(request.project);
			clone = this.#options.registry.assertCanonicalClone(request.project);
			result.clone = clone;
			const origin = this.#options.registry.originUrl(request.project);
			if (origin && !sameRemote(origin, project.clone_url)) {
				findings.push({
					code: "origin_mismatch",
					level: "fail",
					message: `projects/${request.project} origin is ${origin}, registered as ${project.clone_url}`,
					fix: "fix the registration or retire the extra checkout; never lease from a repo you did not register",
				});
			}
		} catch (error) {
			findings.push({
				code: "clone_not_canonical",
				level: "fail",
				message: error instanceof ProjectError ? error.message : String(error),
				fix: `register the project and clone it into projects/${request.project}`,
			});
			return finish(result);
		}

		// 2. git preflight
		const base = request.base ?? (await this.#defaultBase(clone));
		result.base = base;

		if (request.fetch !== false) {
			const fetched = await this.#fetchWithRetry(clone);
			if (fetched.status !== 0) {
				if (fetched.contention) {
					findings.push({
						code: "fetch_contention",
						level: "fail",
						message: `git fetch origin kept losing a ref-lock race in ${clone} after ${fetched.attempts} attempts: ${lastLine(fetched.stderr) || "no output"}`,
						fix: "another worker is fetching the same canonical clone at once (ref-lock contention, not a broken remote); retry the dispatch",
					});
				} else {
					findings.push({
						code: "fetch_failed",
						level: "fail",
						message: `git fetch origin failed in ${clone}: ${lastLine(fetched.stderr) || "no output"}`,
						fix: "add a reachable origin remote (a job branch is cut from origin/<base>), then retry",
					});
				}
			}
		}
		const baseRef = await this.#git(clone, ["rev-parse", "--verify", "--quiet", `origin/${base}`]);
		if (baseRef.status !== 0) {
			findings.push({
				code: "base_missing",
				level: "fail",
				message: `origin/${base} does not exist in ${clone}`,
				fix: "set origin/HEAD, or pass a base branch that exists on origin",
			});
		}

		const primary = await this.#primaryWorktree(clone);
		if (primary) {
			const branch = await this.#branchOf(primary);
			if (!branch) {
				findings.push({
					code: "primary_detached",
					level: "fail",
					message: `primary checkout ${primary} is detached (want ${base})`,
					fix: `git -C ${primary} switch ${base}`,
				});
			} else if (branch !== base) {
				findings.push({
					code: "primary_off_base",
					level: "fail",
					message: `primary checkout ${primary} is on ${branch}, want ${base}`,
					fix: `git -C ${primary} switch ${base} — the canonical clone stays on the base branch`,
				});
			}
			if (!(await this.#isClean(primary))) {
				// A dirty primary does not endanger a linked worktree cut from
				// origin/<base>; it is the operator's business, so: warn, not fail.
				findings.push({
					code: "primary_dirty",
					level: "warn",
					message: `primary checkout ${primary} has local changes`,
				});
			}
		}

		// 3. the target worktree, when one was named
		if (request.worktree) {
			await this.#checkWorktree(request.worktree, clone, findings);
		} else {
			// A leftover branch would make the lease step fail after taking a lease.
			const existing = await this.#git(clone, ["rev-parse", "--verify", "--quiet", `refs/heads/${request.jobId}`]);
			if (existing.status === 0) {
				findings.push({
					code: "branch_exists",
					level: "fail",
					message: `branch ${request.jobId} already exists in ${clone}`,
					fix: "pick a new job id or delete the leftover branch; a job branch is always the job id",
				});
			}
		}

		// 4. occupancy / promote-not-spawn
		const decision = decideOccupancy(this.#options.fleet.read().jobs, {
			jobId: request.jobId,
			project: request.project,
			...(request.model ? { model: request.model } : {}),
			...(request.worktree ? { worktree: request.worktree } : {}),
		});
		if (decision.kind === "promote") {
			findings.push({ code: "occupied_promote", level: "fail", message: decision.message, fix: decision.instruction });
			if (isScriptFleetRecord(decision.job)) return finish(result);
			result.promote = {
				job_id: decision.job.job_id,
				worktree: decision.job.worktree,
				model: decision.job.worker.model,
				profile: decision.job.worker.profile,
				phase: decision.job.phase,
				instruction: decision.instruction,
			};
		} else if (decision.kind === "refuse") {
			findings.push({ code: "occupied_refuse", level: "fail", message: decision.message, fix: decision.fix });
		}

		return finish(result);
	}

	// -- git helpers --------------------------------------------------------

	async #checkWorktree(worktree: string, clone: string, findings: CheckFinding[]): Promise<void> {
		const wt = canonicalDir(worktree);
		const common = await this.#gitCommonDir(wt);
		if (!common) {
			findings.push({
				code: "worktree_missing",
				level: "fail",
				message: `${worktree} is not a git worktree`,
				fix: "take a lease with the lease module; never hand a worker a path git does not know",
			});
			return;
		}
		const cloneCommon = await this.#gitCommonDir(clone);
		if (cloneCommon && common !== cloneCommon) {
			findings.push({
				code: "worktree_foreign",
				level: "fail",
				message: `${worktree} belongs to another repo (git-common-dir ${common}, expected ${cloneCommon})`,
				fix: "treehouse return --force the bad worktree, fix the registration, then re-lease",
			});
			return;
		}
		const primary = await this.#primaryWorktree(clone);
		if (primary && canonicalDir(primary) === wt) {
			findings.push({
				code: "worktree_is_primary",
				level: "fail",
				message: `${worktree} is the primary checkout, not a linked worktree`,
				fix: "lease a worktree from the pool; the canonical clone is never a job's cwd",
			});
			return;
		}
		if (!(await this.#isClean(wt))) {
			findings.push({
				code: "worktree_dirty",
				level: "fail",
				message: `${worktree} has uncommitted changes before the job started`,
				fix: "return the lease (or clean the tree) — a worker starts from a clean tree, always",
			});
		}
	}

	/**
	 * Retry a fetch that fails on ref-lock contention against the shared
	 * canonical clone. Bounded retries with a small backoff; any other cause
	 * (unreachable remote, auth failure, ...) fails on the first attempt.
	 */
	async #fetchWithRetry(clone: string): Promise<{ status: number | null; stderr: string; contention: boolean; attempts: number }> {
		const maxAttempts = Math.max(1, this.#options.fetchRetries ?? 3);
		const delayMs = this.#options.fetchRetryDelayMs ?? 200;
		const sleep = this.#options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

		let last: GitResult = { status: 1, stdout: "", stderr: "" };
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			last = await this.#git(clone, ["fetch", "origin"]);
			if (last.status === 0) return { status: 0, stderr: "", contention: false, attempts: attempt };
			if (!isRefLockContention(last.stderr)) {
				return { status: last.status, stderr: last.stderr, contention: false, attempts: attempt };
			}
			if (attempt < maxAttempts) await sleep(delayMs);
		}
		return { status: last.status, stderr: last.stderr, contention: true, attempts: maxAttempts };
	}

	async #defaultBase(clone: string): Promise<string> {
		return resolveDefaultBase((cwd, args) => this.#git(cwd, args), clone);
	}

	async #primaryWorktree(clone: string): Promise<string | undefined> {
		const result = await this.#git(clone, ["worktree", "list", "--porcelain"]);
		if (result.status !== 0) return undefined;
		for (const line of result.stdout.split("\n")) {
			if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
		}
		return undefined;
	}

	async #branchOf(cwd: string): Promise<string | undefined> {
		const result = await this.#git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		const value = result.stdout.trim();
		return result.status === 0 && value.length > 0 ? value : undefined;
	}

	async #isClean(cwd: string): Promise<boolean> {
		const result = await this.#git(cwd, ["status", "--porcelain"]);
		return result.status === 0 && result.stdout.trim().length === 0;
	}

	async #gitCommonDir(cwd: string): Promise<string | undefined> {
		const result = await this.#git(cwd, ["rev-parse", "--git-common-dir"]);
		if (result.status !== 0) return undefined;
		const raw = result.stdout.trim();
		if (raw.length === 0) return undefined;
		return canonicalDir(raw.startsWith("/") ? raw : `${cwd}/${raw}`);
	}

	async #git(cwd: string, args: readonly string[]): Promise<GitResult> {
		const custom = this.#options.git;
		if (custom) return custom(cwd, args);
		return new Promise<GitResult>((resolvePromise) => {
			execFile(
				this.#options.gitBin ?? "git",
				[...args],
				{ cwd, timeout: this.#options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const code = (error as NodeJS.ErrnoException | null)?.code;
					const status = typeof code === "number" ? code : error ? 1 : 0;
					resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				},
			);
		});
	}
}

function finish(result: PreflightResult): PreflightResult {
	const failed = result.findings.some((finding) => finding.level === "fail");
	result.status = !failed ? "ok" : result.promote ? "promote" : "fail";
	return result;
}

/** One operator-readable block; `fix` lines are the point of the whole thing. */
export function formatPreflight(result: PreflightResult): string {
	const header = `cp_check ${result.project} ${result.branch}: ${result.status}`;
	const lines = result.findings.map(
		(finding) => `  [${finding.level}] ${finding.code}: ${finding.message}${finding.fix ? `\n         fix: ${finding.fix}` : ""}`,
	);
	return [header, ...lines].join("\n");
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
