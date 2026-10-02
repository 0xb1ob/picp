/**
 * `cp_revive` — relaunch (never "reattach") a fresh child bound to a dead
 * job's worktree, lease, model and session file.
 *
 * This is the mechanism `docs/contracts.md`'s `revivable` outcome always
 * promised and never had (cp-0hj / cp-8km). Everything here follows from the
 * spike that resolved the blocking unknown behind it:
 *
 *  - pi never resumes an interrupted turn on its own (no events until
 *    prompted) and repairs a dangling tool call at request-assembly time with
 *    a synthetic `isError: true` result the model will believe, whether or
 *    not the tool actually completed. Revival must never hide that from the
 *    operator (Constraint 9).
 *  - Two processes on one session file fork the transcript silently. A pid
 *    that is still alive is refused, re-probed at revive time rather than
 *    trusted from a startup classification (Constraint 8).
 *  - `--model` on resume silently overrides the session's model and can drop
 *    or flatten restored thinking blocks. Revival always passes the recorded
 *    model, profile and thinking level explicitly (Constraint 10).
 *  - A revived worker resumes idle; nothing is sent as part of revival
 *    (Constraint 6). The operator's own `cp_send` is the first turn.
 *
 * New in this pass: the session-resume spike said nothing about the
 * *repository*. A ship job killed mid-`git rebase` leaves `.git/rebase-merge`
 * behind, and resuming its session does not clean that up — the revived
 * worker would carry on believing the tree is what its transcript describes.
 * So before a plan is offered, the worktree itself is inspected; an
 * in-progress rebase/merge/cherry-pick, a detached HEAD or uncommitted
 * changes each refuse revival with the exact state named, rather than
 * silently handing an unproven worktree back to a resumed conversation.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Failure, type FleetRecord, isScriptFleetRecord, isoTimestamp, paths, type Role, type ThinkingLevel } from "./contracts.ts";
import { type FleetStore, isPidAlive } from "./fleet.ts";
import { loadProfile } from "./profiles.ts";
import type { RunRegistry } from "./runs.ts";
import { resolveJobHardBounds } from "./bounds.ts";
import { attachWorkerObservers, type WorkerObserverOptions } from "./dispatch.ts";
import type { WorkerManager } from "./worker-manager.ts";

export class ReviveError extends Error {}

export const REVIVE_REFUSAL_CODES = [
	"not_found",
	"not_revivable_phase",
	"session_missing",
	"worker_already_live",
	"pid_alive",
	"worktree_missing",
	"repo_operation_in_progress",
	"repo_detached_head",
	"envelope_unresolved",
] as const;
export type ReviveRefusalCode = (typeof REVIVE_REFUSAL_CODES)[number];

export interface ReviveRefusal {
	ok: false;
	job_id: string;
	code: ReviveRefusalCode;
	message: string;
}

/** The interrupted tool call, read from the session leaf (spike Evidence S9). */
export interface InterruptedTool {
	name: string;
	arguments: unknown;
	toolCallId: string;
}

export interface RevivePlan {
	ok: true;
	job_id: string;
	session_file: string;
	worktree: string;
	model: string;
	profile: string;
	role: Role;
	thinking?: ThinkingLevel;
	/**
	 * The tool call in flight when the worker died, when one is on the leaf.
	 * `cp_revive` must show this to the operator before it spawns anything
	 * (Constraint 9): a revived worker believes this call produced no result,
	 * whether or not it actually completed.
	 */
	interruptedTool?: InterruptedTool;
	/**
	 * Uncommitted changes were sitting in the worktree at plan time. This is the
	 * ordinary shape of a ship job mid-work — refusing on it would make revival
	 * useless for the exact case it exists for — so it is surfaced to the
	 * operator rather than refused. An in-progress rebase/merge/cherry-pick or a
	 * detached HEAD are the actual hazards (see the refusal codes) and still
	 * refuse outright.
	 */
	worktreeDirty: boolean;
	/**
	 * Set when this plan continues a `phase: failed` job on its original lease
	 * (operator continuation or bounded recovery): the failure being continued.
	 */
	continuesFailure?: Failure;
	/**
	 * cp-mub7: the failed job still has a registered (stale) worker in this
	 * process; `revive` shuts it down before spawning on the session file.
	 */
	closesWorker?: true;
}

export type RevivePlanResult = RevivePlan | ReviveRefusal;

/**
 * `recovering: true` is the one door `BoundedRecovery` uses (cur.4.2 review,
 * finding 1): it lets `plan`/`revive` act on a job `FailureAnnouncer.fail` has
 * already moved to `phase: failed`, because `fail` runs first (synchronously,
 * before `shutdown`/any close-observer race) and bounded recovery's own hooks
 * run after that write completes. Nobody else should set it \u2014 `cp_revive`
 * and `/cp-revive` never do.
 *
 * `continueFailed: true` is the operator's explicit door (cp_revive
 * `continue_failed`, `/cp-revive <id> --continue-failed`): continue a failed
 * job on its original session, worktree and lease instead of a takeover job.
 * Same refusal ladder; journaled as `continuation: "operator"`, distinct from
 * bounded recovery, and never touches the automatic attempt counter.
 */
export interface RevivePlanOptions {
	recovering?: boolean;
	continueFailed?: boolean;
}

export interface ReviveResult {
	job_id: string;
	pid: number;
	session_file: string;
	model: string;
	interruptedTool?: InterruptedTool;
	worktreeDirty: boolean;
	continuedFailure?: Failure;
}

export type GitRunner = (
	cwd: string,
	args: readonly string[],
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export interface WorktreeState {
	dirty: boolean;
	detachedHead: boolean;
	inProgressOp?: "rebase" | "merge" | "cherry-pick";
	clean: boolean;
}

export interface ReviverOptions {
	/** Command post home; run dirs and profiles are resolved from here. */
	home: string;
	profilesDir: string;
	fleet: FleetStore;
	manager: WorkerManager;
	runs: RunRegistry;
	/** Wired identically to Dispatcher, so observation can never diverge. */
	intake?: WorkerObserverOptions["intake"];
	failures?: WorkerObserverOptions["failures"];
	settle?: WorkerObserverOptions["settle"];
	bounds?: WorkerObserverOptions["bounds"];
	onUsage?: WorkerObserverOptions["onUsage"];
	isPidAlive?: (pid: number) => boolean;
	fileExists?: (path: string) => boolean;
	git?: GitRunner;
	now?: () => Date;
}

async function safely(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch {
		// Cleanup failures must never mask the original error.
	}
}

async function defaultGit(
	cwd: string,
	args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolvePromise) => {
		execFile("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			const status = typeof code === "number" ? code : error ? 1 : 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/**
 * Is the worktree safe to hand back to a resumed conversation? A revived
 * worker resumes idle (Constraint 6) and its transcript says nothing about
 * what happened to the repository while it was dead — so any of these three
 * states is a hazard the operator must resolve first, not something a
 * silently-resumed conversation should discover on its own.
 */
export async function inspectWorktree(worktree: string, git: GitRunner = defaultGit): Promise<WorktreeState> {
	const status = await git(worktree, ["status", "--porcelain"]);
	const dirty = status.status === 0 && status.stdout.trim().length > 0;
	const symbolic = await git(worktree, ["symbolic-ref", "-q", "HEAD"]);
	const detachedHead = symbolic.status !== 0;

	let inProgressOp: WorktreeState["inProgressOp"];
	const gitDirResult = await git(worktree, ["rev-parse", "--git-dir"]);
	if (gitDirResult.status === 0) {
		const raw = gitDirResult.stdout.trim();
		const gitDir = raw.length > 0 ? (isAbsolute(raw) ? raw : join(worktree, raw)) : undefined;
		if (gitDir) {
			if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
				inProgressOp = "rebase";
			} else if (existsSync(join(gitDir, "MERGE_HEAD"))) {
				inProgressOp = "merge";
			} else if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) {
				inProgressOp = "cherry-pick";
			}
		}
	}

	return { dirty, detachedHead, inProgressOp, clean: !dirty && !detachedHead && !inProgressOp };
}

interface SessionEntry {
	type?: string;
	message?: { role?: string; toolCallId?: string; content?: unknown };
}

/**
 * The interrupted tool call, if the session's leaf is a dangling one (spike
 * Evidence S1, S9): an assistant message whose last `toolCall` has no matching
 * `toolResult` entry after it. Best-effort and read-only; a session this
 * cannot parse yields no tool rather than a thrown error, since this is
 * operator-facing context, not a gate.
 */
export function readInterruptedTool(sessionFile: string, fileExists: (path: string) => boolean = existsSync): InterruptedTool | undefined {
	if (!fileExists(sessionFile)) return undefined;
	let lines: string[];
	try {
		lines = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
	} catch {
		return undefined;
	}
	const resolvedToolCallIds = new Set<string>();
	for (const line of lines) {
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message?.role === "toolResult" && typeof entry.message.toolCallId === "string") {
			resolvedToolCallIds.add(entry.message.toolCallId);
		}
	}
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		let entry: SessionEntry;
		try {
			entry = JSON.parse(lines[index] as string) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = Array.isArray(entry.message.content) ? (entry.message.content as unknown[]) : [];
		for (const item of content) {
			const call = item as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (call?.type === "toolCall" && typeof call.id === "string" && !resolvedToolCallIds.has(call.id)) {
				return { name: call.name ?? "unknown", arguments: call.arguments, toolCallId: call.id };
			}
		}
		// The most recent assistant message resolved (or held no tool call at
		// all): whatever ended the session, it was not a dangling tool call.
		return undefined;
	}
	return undefined;
}

function refuse(jobId: string, code: ReviveRefusalCode, message: string): ReviveRefusal {
	return { ok: false, job_id: jobId, code, message };
}

/**
 * A failed job whose envelope slot is in a state a resumed worker cannot report
 * through: an envelope intake never accepted (the worker is told "already
 * filed") or the worker's own rejection record (the next intake fails the job
 * again). Neither is silently overwritten \u2014 the operator resolves it by hand.
 * An ACCEPTED envelope is fine: `cp_send` supersedes it (src/supersede.ts).
 */
function unresolvedEnvelope(home: string, record: FleetRecord, fileExists: (path: string) => boolean): string | undefined {
	const envelope = join(home, paths.envelopeFile(record.job_id));
	if (record.reported_at === undefined && fileExists(envelope)) return `an envelope intake never accepted sits at ${envelope}`;
	const rejected = join(home, paths.runDir(record.job_id), "envelope-rejected.json");
	if (fileExists(rejected)) return `the worker's envelope rejection record sits at ${rejected}`;
	return undefined;
}

export class Reviver {
	readonly #options: ReviverOptions;

	constructor(options: ReviverOptions) {
		this.#options = options;
	}

	/**
	 * Pure(ish): decides whether `jobId` can be revived, re-checking every fact
	 * against the world right now rather than trusting a startup classification
	 * (Constraint 8). Never spawns anything.
	 */
	async plan(jobId: string, options?: RevivePlanOptions): Promise<RevivePlanResult> {
		const record = this.#options.fleet.get(jobId);
		if (!record) return refuse(jobId, "not_found", `no fleet record for ${jobId}`);
		if (isScriptFleetRecord(record)) return refuse(jobId, "not_revivable_phase", `${jobId} is a script job; an unobserved exit cannot be replayed`);
		const revivablePhases: readonly typeof record.phase[] = options?.recovering || options?.continueFailed
			? ["held", "waiting", "failed"]
			: ["held", "waiting"];
		if (!revivablePhases.includes(record.phase)) {
			return refuse(
				jobId,
				"not_revivable_phase",
				options?.recovering
					? `${jobId} is ${record.phase}; a bounded recovery attempt only revives a held, waiting or (its own just-failed) job`
					: record.phase === "failed"
						? `${jobId} is failed (${record.failure?.class ?? "no class recorded"}); continue it on its original lease with ` +
							`cp_revive ${jobId} continue_failed:true (plan first) \u2014 never a takeover job or a fresh dispatch`
						: `${jobId} is ${record.phase}; only a held, waiting or (with continue_failed) failed job with a dead worker is revivable`,
			);
		}

		const fileExists = this.#options.fileExists ?? existsSync;
		if (record.phase === "failed" && options?.continueFailed) {
			const unresolved = unresolvedEnvelope(this.#options.home, record, fileExists);
			if (unresolved) {
				return refuse(
					jobId,
					"envelope_unresolved",
					`${jobId}: ${unresolved} \u2014 a continued worker could not report through it. Nothing was moved; ` +
						"inspect it and move it aside by hand, then retry.",
				);
			}
		}
		if (!fileExists(record.worker.session_file)) {
			return refuse(
				jobId,
				"session_missing",
				`${jobId}'s session file ${record.worker.session_file || "(none recorded)"} is gone \u2014 there is nothing to revive from`,
			);
		}

		// cp-mub7: a failed job's registered worker is stale, not live work — the
		// job is already failed, and cp_send refuses it for that reason and points
		// here. The operator's continue_failed door closes it instead of refusing,
		// or the two tools send the caller in a circle. Only this door: bounded
		// recovery waits out the bound path's own shutdown.
		const registered = this.#options.manager.get(jobId);
		const closesWorker =
			registered !== undefined && record.phase === "failed" && options?.continueFailed === true && !options.recovering;
		if (registered && !closesWorker) {
			return refuse(
				jobId,
				"worker_already_live",
				`${jobId} already has a live worker registered in this process \u2014 nothing to revive`,
			);
		}

		const alive = this.#options.isPidAlive ?? isPidAlive;
		const ownPid = closesWorker && registered?.worker.pid === record.worker.pid;
		if (!ownPid && alive(record.worker.pid)) {
			return refuse(
				jobId,
				"pid_alive",
				`${jobId}'s pid ${record.worker.pid} is still alive \u2014 reviving now would put two processes on ` +
					`${record.worker.session_file}, which forks the transcript silently and neither can see the other's ` +
					"branch. Investigate the live process first (it may be reachable from another session).",
			);
		}

		if (!existsSync(record.worktree)) {
			return refuse(jobId, "worktree_missing", `${jobId}'s worktree ${record.worktree} is gone \u2014 nothing to revive into`);
		}

		const git = this.#options.git ?? defaultGit;
		const worktreeState = await inspectWorktree(record.worktree, git);
		if (worktreeState.inProgressOp) {
			return refuse(
				jobId,
				"repo_operation_in_progress",
				`${record.worktree} has a ${worktreeState.inProgressOp} in progress \u2014 resuming the session now would hand ` +
					"control back to a worker whose transcript says nothing about it. Finish or abort the " +
					`${worktreeState.inProgressOp} by hand, then retry.`,
			);
		}
		if (worktreeState.detachedHead) {
			return refuse(
				jobId,
				"repo_detached_head",
				`${record.worktree} is on a detached HEAD, not ${record.branch} \u2014 inspect and fix the checkout before reviving.`,
			);
		}

		const interruptedTool = readInterruptedTool(record.worker.session_file, fileExists);
		return {
			ok: true,
			job_id: jobId,
			session_file: record.worker.session_file,
			worktree: record.worktree,
			model: record.worker.model,
			profile: record.worker.profile,
			role: record.worker.role,
			worktreeDirty: worktreeState.dirty,
			...(record.routing?.thinking ? { thinking: record.routing.thinking } : {}),
			...(interruptedTool ? { interruptedTool } : {}),
			...(record.phase === "failed" && record.failure ? { continuesFailure: record.failure } : {}),
			...(closesWorker ? { closesWorker: true as const } : {}),
		};
	}

	/**
	 * Relaunch a fresh child on the plan's session file. Sends nothing
	 * (Constraint 6): the process lands idle, which is what a resumed `pi
	 * --mode rpc --session <file>` does anyway (spike Evidence S3). Registers
	 * with `WorkerManager` before any fleet write, and rolls the spawn back if
	 * the fleet patch fails, so a crash mid-revival can never leave a live
	 * worker the fleet does not know about (symmetric with `Dispatcher#dispatch`).
	 */
	async revive(jobId: string, options?: RevivePlanOptions): Promise<ReviveResult> {
		const plan = await this.plan(jobId, options);
		if (!plan.ok) {
			throw new ReviveError(`cannot revive ${jobId} (${plan.code}): ${plan.message}`);
		}
		const record = this.#options.fleet.require(jobId);
		// Only `recovering` or `continueFailed` let a failed record through `plan`.
		const continuing = record.phase === "failed";
		const now = this.#options.now ?? (() => new Date());
		const profile = loadProfile(this.#options.profilesDir, plan.profile);

		// cp-mub7: two processes on one session file fork it — the stale worker goes first.
		if (plan.closesWorker) await this.#options.manager.shutdown(jobId);
		await this.#options.manager.ready();
		const managed = this.#options.manager.spawn({
			identity: {
				jobId,
				kind: record.kind,
				delivery: record.delivery,
				runDir: this.#options.runs.open(jobId).runDir,
				worktree: record.worktree,
			},
			profile,
			model: plan.model,
			...(plan.thinking ? { thinking: plan.thinking } : {}),
			sessionFile: plan.session_file,
			// No `brief`: a revived worker resumes idle. `report_result` stays
			// write-once (worker-reporter), so nothing here can double-report.
		});

		try {
			const recorder = this.#options.runs.open(jobId);
			// The marker goes in FIRST, before a single event of the new process can
			// be teed (cp-0wq7): it is what reopens the projection's liveness after
			// the previous attempt's observed close, and an event that lands ahead of
			// it is an event about a process the projection still thinks is dead.
			recorder.cp("worker_revived", {
				pid: managed.worker.pid,
				session_file: plan.session_file,
				model: plan.model,
				...(plan.interruptedTool ? { interrupted_tool: plan.interruptedTool } : {}),
				...(continuing
					? { continuation: options?.recovering ? "bounded_recovery" : "operator", ...(record.failure ? { prior_failure: record.failure } : {}) }
					: {}),
			});
			attachWorkerObservers({
				recorder,
				worker: managed.worker,
				jobId,
				...(this.#options.intake ? { intake: this.#options.intake } : {}),
				...(this.#options.settle ? { settle: this.#options.settle } : {}),
				...(this.#options.failures ? { failures: this.#options.failures } : {}),
				...(this.#options.bounds
					? { bounds: this.#options.bounds, hardBounds: record.bounds ?? resolveJobHardBounds() }
					: {}),
				...(this.#options.onUsage ? { onUsage: this.#options.onUsage } : {}),
			});
			const worker = { ...record.worker, pid: managed.worker.pid as number, started_at: isoTimestamp(now()) };
			if (options?.recovering || continuing) {
				// This record entered `revive()` as `phase: failed` (bounded recovery or
				// operator continuation): the worker just relaunched, so `failed` is no
				// longer true and must not stay the fleet's belief. Cleared only now, in
				// one atomic `mutate` after a successful spawn \u2014 a spawn that throws
				// leaves the failure and the lease exactly as they were. `mutate`, not
				// `patch` (`patch` skips `undefined` and can never erase `failure`).
				await this.#options.fleet.mutate((jobs) => {
					const job = jobs.find((candidate) => candidate.job_id === jobId);
					if (!job) return;
					job.phase = "waiting";
					delete job.failure;
					job.worker = worker;
				});
			} else {
				await this.#options.fleet.patch(jobId, { worker });
			}
		} catch (error) {
			// The fleet must never disagree with the manager: a worker the fleet
			// does not know about is exactly the deadlock this module exists to
			// close, in reverse.
			await safely(() => this.#options.manager.shutdown(jobId));
			throw new ReviveError(`revive ${jobId}: spawned but failed to record it (${(error as Error).message}); worker shut down`);
		}

		return {
			job_id: jobId,
			pid: managed.worker.pid as number,
			session_file: plan.session_file,
			model: plan.model,
			worktreeDirty: plan.worktreeDirty,
			...(plan.interruptedTool ? { interruptedTool: plan.interruptedTool } : {}),
			...(plan.continuesFailure ? { continuedFailure: plan.continuesFailure } : {}),
		};
	}
}

/** Operator-facing one-liner for a refusal, or the plan about to be acted on. */
export function formatRevivePlan(result: RevivePlanResult): string {
	if (!result.ok) {
		return `${result.job_id}: revive refused (${result.code}) \u2014 ${result.message}`;
	}
	const tool = result.interruptedTool
		? ` \u2014 interrupted tool: ${result.interruptedTool.name}(${JSON.stringify(result.interruptedTool.arguments)}); ` +
			"the revived worker will be told this call produced no result, whether or not it actually completed"
		: "";
	const dirty = result.worktreeDirty ? " \u2014 the worktree has uncommitted changes (ordinary mid-work state, not refused)" : "";
	const failed = result.continuesFailure
		? ` \u2014 continues failed job (${result.continuesFailure.class}: ${result.continuesFailure.message}) on its original ` +
			"worktree and lease; the automatic recovery counter is not reset"
		: "";
	return `${result.job_id}: revivable (${result.model}, session ${result.session_file})${failed}${tool}${dirty}`;
}

export function formatReviveResult(result: ReviveResult): string {
	const tool = result.interruptedTool ? ` (interrupted: ${result.interruptedTool.name})` : "";
	const dirty = result.worktreeDirty ? " (worktree has uncommitted changes)" : "";
	const failed = result.continuedFailure ? ` (continued from failed: ${result.continuedFailure.class})` : "";
	return `${result.job_id} revived${failed}: pid ${result.pid}, session ${result.session_file}${tool}${dirty} \u2014 idle; send it a message to continue`;
}
