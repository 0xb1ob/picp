/**
 * `cp_integrate` — the merge sequence as a resumable, parent-owned state
 * machine (cp-uug).
 * ## Why this is a tool and not a role
 * Every step between "the PR is green" and "the job is closed" is a git or `gh`
 * fact with a checkable postcondition: does GitHub require the branch updated, has CI
 * finished on the *pushed* head, did GitHub say `MERGED`, is the lease back, is
 * the br issue closed. A model placed in that loop cannot add evidence — it can
 * only add a claim, and this home has two recorded instances of exactly that
 * (`data/learnings.md`, 2026-08-31: "two of three ship envelopes claimed a
 * rebase or report that never happened"). So the sequence is code, and the only
 * judgment left in it is the one that must be a human's: whether to merge.
 * Three further reasons an *integrator worker* was rejected, all structural:
 *  - it could not wait for CI at all. `src/ci-wait.ts` refuses `gh run watch`
 *    and `gh pr checks --watch` **by name** for every worker, enforced in
 *    `extensions/worker-reporter/index.ts`'s `tool_call` hook, and that guard
 *    exists precisely because the same rule as prose already failed once. A
 *    worker-based integrator would need it weakened. A parent-side tool needs
 *    nothing weakened: the hook is a worker hook and does not run here. This
 *    module changes no line of `src/ci-wait.ts`.
 *  - it would need `cp_teardown` and a br-close capability, both in
 *    `WORKER_FORBIDDEN_TOOLS`, so the recursion guard would have to be reopened.
 *  - it would be a **second writer** to a branch whose implementer is still
 *    `held` and promotable. Here the branch has exactly one writer at any
 *    moment (§The two-writer boundary, below).
 * ## The two-writer boundary
 * 1. The implementer owns the branch while its `pr` receipt is `open` — that is
 *    what the `delivery:pr` hold is *for*.
 * 2. This tool performs only server-side or read-only git: `gh pr update-branch
 *    --rebase`, `git ls-remote`, `git merge-base --is-ancestor`, `gh run list`.
 *    It never pushes commits from a worktree.
 * 3. A conflict, or CI red after a rebase, is handed **back** to the job's own
 *    implementer with `cp_send` and a message generated in code (the shape
 *    `diffReviseMessage` established). One promote, then a human — never a
 *    third automated attempt, and never a re-dispatch behind the operator's
 *    back.
 * 4. `cp_merged` writes the receipt, which moves the `pr` receipt to `merged`,
 *    which is exactly the point at which `decideReopen` (`src/supersede.ts`)
 *    refuses any further `cp_send`. Recording the merge is a code-enforced
 *    handoff, not a convention — which is why `record` must run *after* the
 *    last promote and *before* teardown.
 * ## Authorization and holds (cp-e0c, cp-x7i, cp-4r4)
 * `cp_integrate` never forces a repository refusal: CLEAN or HAS_HOOKS after
 * green CI permits a merge; a refusal becomes an Awaiting-you reminder.
 * Unreadable permission falls back to a human CheckpointStore approval bound
 * to one PR and one head (`state/checkpoints/<job-id>.merge-<head>.json`).
 * There is no standing or blanket merge authority; a moved head needs fresh
 * CI, review and permission. See docs/contracts.md, Integration.
 *
 * IntegrationHolds stores an explicit operator pause beside the job's run.
 * Both manual and automatic calls read it at entry and immediately before
 * either merge command. A hold (or an unreadable hold) returns next: wait.
 * Release removes only the pause, never any CI, review or permission gate.
 * A merge command already issued cannot be cancelled by a later hold.
 *
 * With zero CI runs, an authoritative empty workflow list (ci-configured.ts)
 * means no CI configured and still requires repository permission. Unreadable
 * workflow configuration keeps the per-head human-checkpoint fallback.
 *
 * ## Waiting for CI
 *
 * One non-blocking `gh run list` feeds readCiForHead (src/merge-ask.ts).
 * Unfinished CI returns next: wait; the CI watcher supplies the next fact.
 * This tool never waits inside a blocking `gh run watch` call.
 *
 * ## Rescue refs, and their retention (cp-8vf6, cp-wcy5)
 *
 * The sync step keeps every head it is about to discard at
 * `refs/cp-salvage/<job-id>/<utc>` *before* it resets, and refuses the reset if
 * that ref cannot be written. Those refs are pruned at the end of a successful
 * integration by `#pruneSalvageRefs`, under one rule: **a rescue ref is deleted
 * only once its commit is provably reachable from the tip origin names for the
 * base** — never on age, never on count, never on a timer, and never for a ref
 * outside that namespace. Every unreadable answer keeps the ref, so the policy
 * is bounded where deletion is provably lossless and *reporting* everywhere
 * else: what was pruned, what was kept and why both land in the integration
 * record's facts and the run log.
 *
 * ## Shape
 *
 * `advance` performs **at most one mutating step per call** and recomputes
 * which step is due from git, `gh`, and the review store every time — never from the stored step.
 * Before merge (both `repo_derived` and `human_checkpoint`), a passing `cp_review`
 * on this head or a recorded patch-equivalent is required; otherwise `next: "review"` and nothing mutates.
 * That is what makes it resumable across a parent restart, idempotent when
 * called twice, and unable to re-merge anything on a stale record. Same pattern
 * as `Gate.gate` and `DiffReview.review`: an attempt record on disk, read back
 * to decide what already happened.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	AWAITING_DECISION_MAX_CHARS,
	type DiffVerdict,
	DiffVerdictSchema,
	type FleetRecord,
	type IntegrationNext,
	type IntegrationRecord,
	IntegrationRecordSchema,
	type IntegrationStep,
	INTEGRATE_MAX_RESOLVE,
	isoTimestamp,
	type MergeAuthority,
	type MergeStrategy,
	paths,
	REVIEW_MAX_ATTEMPTS,
	SALVAGE_PRUNE_MAX,
	SALVAGE_REF_PREFIX,
	SCHEMA_VERSION,
	validate,
} from "./contracts.ts";
import { awaitingId } from "./awaiting.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { type CiConfiguredVerdict, ghWorkflowsArgs, readCiConfigured } from "./ci-configured.ts";
import type { FleetStore } from "./fleet.ts";
import { finalFixMessage, recordFinalFixPromotion, resolveFinalFix } from "./final-fix.ts";
import { atomicWriteJson } from "./json-store.ts";
import { IntegrationHolds } from "./integration-hold.ts";
import { ghRunListArgs, parseCiRuns, readCiForHead, readReviewPassVerdict, shaMatches } from "./merge-ask.ts";
import { mainRedHold } from "./main-ci.ts";
import {
	type BranchRule,
	evaluateMergePermission,
	ghBranchRulesArgs,
	type MergePermissionVerdict,
	parseBranchRules,
	rulesRequireUpToDate,
} from "./merge-permission.ts";
import type { CommandRunner, MergeStore, RecordMergeResult } from "./merges.ts";
import { EscalationStore, raiseMergeRefused } from "./escalation.ts";
import type { RunRegistry } from "./runs.ts";
import type { TeardownResult } from "./teardown.ts";

/**
 * Just enough of `AwaitingStore` for the "merge pending" reminder (cp-e0c).
 * Injected as a thunk (not a value) because the composition root builds the
 * integrator before the awaiting store; declared as `type: "approval"`, never
 * `"authorization"` — a reminder is answerable and withdrawable, not a
 * checkpoint.
 */
export interface AwaitingLike {
	declareGated(input: {
		type: "approval";
		decision: string;
		why: string;
		blocks: string;
		job_id?: string;
		subject?: string;
		options?: string[];
	}): Promise<{ item: { id: string }; raised: boolean }>;
	withdraw(id: string): Promise<unknown>;
}

export class IntegrateError extends Error {}

/** The `gh pr view --json` fields this module asks for, and nothing else. */
export const GH_PR_INTEGRATION_FIELDS = [
	"number",
	"url",
	"state",
	"mergeable",
	"mergeStateStatus",
	"headRefName",
	"headRefOid",
	"baseRefName",
	"reviewDecision",
	"isDraft",
	"autoMergeRequest",
] as const;

interface GhPrView {
	number?: number;
	url?: string;
	state?: string;
	mergeable?: string;
	mergeStateStatus?: string;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
	reviewDecision?: string;
	isDraft?: boolean;
	autoMergeRequest?: unknown;
}

/** Just enough of `Teardown` to run the gate; injected so tests stay hermetic. */
export interface TeardownLike {
	teardown(jobId: string, options?: { force?: boolean }): Promise<TeardownResult>;
}

/** Just enough of `Ledger` to close one issue with a reason. */
export interface LedgerLike {
	close(id: string, reason: string): Promise<unknown>;
}

/** `cp_send`, as the one call this module makes on it. */
export type IntegrateSender = (jobId: string, message: string) => Promise<{ receipt: string; error?: string }>;

export interface IntegratorOptions {
	home: string;
	fleet: FleetStore;
	merges: MergeStore;
	teardown: TeardownLike;
	/** Built per call by the caller, like every other br consumer. */
	ledger: () => LedgerLike;
	/** Where `gh` and `git` run: the job's canonical project clone, resolved by
	 * the caller (which knows the registry and the worktree fallback). */
	projectDir: (project: string, worktree: string) => string;
	runs?: RunRegistry;
	/** Promote the job's own implementer. Absent means "cannot resolve, surface". */
	send?: IntegrateSender;
	/** Injected so tests never touch a real `gh` or `git`. */
	run?: CommandRunner;
	now?: () => Date;
	/**
	 * The "merge pending" reminder (cp-e0c). A thunk because the composition root
	 * builds `AwaitingStore` after this module. Absent means the reminder is
	 * skipped — the merge is still never forced either way.
	 */
	awaiting?: () => AwaitingLike;
}

export interface IntegrateRequest {
	jobId: string;
	/** PR url or number. Defaults to the job's own `pr` receipt. */
	pr?: string;
	/** Recorded on the receipt. This repo squash-merges everything. */
	strategy?: MergeStrategy;
	/** The branch a PR must be merged into for the base to count as current. */
	base?: string;
}

export interface IntegrateResult {
	job_id: string;
	branch: string;
	step: IntegrationStep;
	next: IntegrationNext;
	/** What was observed, in the order it was observed. Headlines only. */
	facts: string[];
	/** One operator-facing line. */
	reason: string;
	record: IntegrationRecord;
	pr_url?: string;
	head_sha?: string;
	/** Present when this call recorded (or re-read) the merge receipt. */
	merge?: RecordMergeResult;
	/** Present when this call ran the teardown gate. */
	teardown?: TeardownResult;
	/** Present when this call promoted the implementer. */
	resolve_receipt?: string;
	resolve_error?: string;
	/** The three end-state facts §Decision 6 asks the parent to check. */
	end_state?: EndState;
}

/**
 * The parent's whole verification after delegation: a record that could only
 * exist if the sequence happened. Cheap local reads, no network.
 */
export interface EndState {
	/** `state/runs/<job-id>/merge.json` exists and validates. */
	merge_receipt: boolean;
	/** Fleet: `phase: done`, `closed_reason: gated` (never `forced`), pr receipt `merged`. */
	fleet_done: boolean;
	closed_reason?: string;
	pr_receipt_status?: string;
	/** The br issue was closed with a reason by this tool. */
	br_closed: boolean;
}

const DEFAULT_BASE = "main";

export class Integrator {
	readonly #options: IntegratorOptions;
	readonly #resolving = new Set<string>();

	constructor(options: IntegratorOptions) {
		this.#options = options;
	}

	file(jobId: string): string {
		return join(this.#options.home, paths.integrationFile(jobId));
	}

	/** The record, or `undefined`. Total: an unreadable file is "no record". */
	get(jobId: string): IntegrationRecord | undefined {
		let file: string;
		try {
			file = this.file(jobId);
		} catch {
			return undefined;
		}
		if (!existsSync(file)) return undefined;
		try {
			const parsed = validate<IntegrationRecord>(IntegrationRecordSchema, JSON.parse(readFileSync(file, "utf8")));
			return parsed.ok ? parsed.value : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * One step, chosen from facts. Never throws for an operational reason: a
	 * `gh` that 403s, a missing binary and a refused teardown all end in a
	 * recorded step with a `next` the caller can act on, because a tool that
	 * throws out of the middle of a merge leaves nobody able to say what state
	 * the merge is in. Contract violations (an unknown job, a job that is not a
	 * `delivery:pr` ship job) still throw: those are caller errors, and nothing
	 * has been touched.
	 */
	async advance(request: IntegrateRequest): Promise<IntegrateResult> {
		const { fleet } = this.#options;
		const jobId = request.jobId;
		const record = fleet.get(jobId);
		if (!record) {
			throw new IntegrateError(`no fleet record for ${jobId} — integration is a step in a job this home dispatched`);
		}
		if (record.kind !== "ship" || record.delivery !== "pr") {
			throw new IntegrateError(
				`${jobId} is ${record.kind}/${record.delivery}; cp_integrate merges a delivery:pr ship job's PR and nothing else`,
			);
		}
		const branch = record.branch;
		const cwd = this.#options.projectDir(record.project, record.worktree);
		const facts: string[] = [];
		const held = this.#held(jobId, branch);
		if (held) return held;

		// --- the fast path: already recorded merged, so only the tail is left ---
		const receipt = this.#options.merges.get(jobId);
		if (receipt) {
			facts.push(`merge receipt: ${receipt.pr_url} merged as ${receipt.merge_commit_sha.slice(0, 12)}`);
			// No `gh pr view` on this path, so no `baseRefName` to carry: `#finish`
			// falls back to the request's base, then `main`.
			return this.#finish({ jobId, branch, cwd, facts, prUrl: receipt.pr_url, headSha: receipt.head_sha, request });
		}

		// --- the PR, as GitHub reports it --------------------------------------
		const pr = request.pr?.trim() || prUrlFromReceipts(record.receipts) || branch;
		const view = await this.#viewPr(cwd, pr);
		if (!view.ok) {
			return this.#write({
				jobId,
				branch,
				step: "start",
				next: view.next,
				facts: [...facts, view.detail],
				reason: view.reason,
			});
		}
		const state = (view.value.state ?? "").toUpperCase();
		const prUrl = view.value.url ?? pr;
		// Only a real object name is carried forward: everything downstream (the
		// checkpoint's file name, the record's `head_sha`) is schema-bound to hex, and
		// a surprising value from gh must degrade to "no head" rather than throw out
		// of the middle of a merge.
		const head = hexSha(view.value.headRefOid);
		facts.push(`gh: ${prUrl} is ${state || "in an unknown state"}${head ? ` at ${head.slice(0, 12)}` : ""}`);

		if (view.value.headRefName && view.value.headRefName !== branch) {
			return this.#write({
				jobId,
				branch,
				step: "start",
				next: "surface",
				facts,
				...(prUrl ? { prUrl } : {}),
				reason:
					`${prUrl} merges ${view.value.headRefName}, but ${jobId}'s branch is ${branch} — that PR is not this ` +
					"job's delivery, so nothing was touched. Pass the right PR, or fix the fleet record.",
			});
		}

		// Merged already (by us on an earlier call, or by a human meanwhile): the
		// receipt is the observer either way, so this is a jump, not an error.
		if (state === "MERGED") {
			return this.#finish({
				jobId,
				branch,
				cwd,
				facts,
				prUrl,
				...(head ? { headSha: head } : {}),
				...(view.value.baseRefName?.trim() ? { base: view.value.baseRefName.trim() } : {}),
				request,
			});
		}
		if (state === "CLOSED") {
			return this.#write({
				jobId,
				branch,
				step: "start",
				next: "surface",
				facts,
				prUrl,
				...(head ? { headSha: head } : {}),
				reason:
					`${prUrl} is closed and was never merged. Nothing was recorded and nothing was torn down — ` +
					"reopen it, or decide with the operator whether this job is dropped.",
			});
		}

		// --- open: hazards, freshness, conflict, CI, authorization, merge ------
		const hazard = await this.#worktreeHazard(record.worktree);
		if (hazard) {
			return this.#write({
				jobId,
				branch,
				step: "start",
				next: "surface",
				facts: [...facts, hazard],
				prUrl,
				...(head ? { headSha: head } : {}),
				reason: `${jobId}: ${hazard}. Nothing is automated over a half-finished rebase — finish or abort it first.`,
			});
		}

		// The PR's *own* base, as GitHub reports it: authoritative, and better than a
		// repo-wide default that may not be what this PR targets. An explicit
		// argument still wins, and `main` is only the last resort.
		const base = request.base?.trim() || view.value.baseRefName?.trim() || DEFAULT_BASE;

		const mergeable = (view.value.mergeable ?? "").toUpperCase();
		if (mergeable === "CONFLICTING") {
			return this.#resolve({
				jobId,
				branch,
				step: "conflict",
				facts: [...facts, `gh: mergeable=CONFLICTING against ${base}`],
				prUrl,
				...(head ? { headSha: head } : {}),
				message: conflictMessage({ jobId, branch, prUrl, base }),
				reason: `${jobId}: ${prUrl} conflicts with ${base}`,
			});
		}

		// No blanket freshness gate (item 33): a stale base is not a reason to
		// rebase. CI and permission are read on the head as pushed, and only
		// GitHub's own BEHIND, or a readable rule proving an update is required,
		// triggers the server-side update below.
		if (!head) {
			return this.#write({
				jobId,
				branch,
				step: "ci",
				next: "retry",
				facts: [...facts, "gh reported no head commit for this PR"],
				prUrl,
				reason: `${jobId}: gh reported no head commit for ${prUrl}, so there is no sha to verify CI or an approval against.`,
			});
		}
		const mainRed = await mainRedHold({ home: this.#options.home, project: record.project, branch, head, ancestry: () => this.#ancestry(cwd, branch, "main"), runs: () => this.#run(cwd, "gh", ghRunListArgs(branch)) });
		if (mainRed.fact) facts.push(mainRed.fact); // k52: a red origin/main pauses every merge path below, fix-forward excepted
		if (mainRed.hold) return this.#write({ jobId, branch, step: "merge", next: "wait", facts: [...facts, mainRed.hold], prUrl, headSha: head, reason: `${jobId}: ${mainRed.hold}` });

		// CI, for the head that would merge. A completed green run on a superseded
		// sha proves nothing, and `readCiForHead` is the one place that rule lives.
		const runs = await this.#run(cwd, "gh", ghRunListArgs(branch));
		if (runs.status !== 0) {
			return this.#write({
				jobId,
				branch,
				step: "ci",
				next: "retry",
				facts: [...facts, firstLine(runs)],
				prUrl,
				headSha: head,
				reason: `${jobId}: could not read CI for ${branch} (${firstLine(runs)}). Nothing was merged.`,
			});
		}
		const runsParsed = safeParseRuns(runs.stdout);
		const ci = readCiForHead({ branch, headSha: head, runs: runsParsed });
		facts.push(`ci: ${ci.ci} — ${ci.reason}`);
		/** Set only when the repository itself answered "no workflows" (`src/ci-configured.ts`). */
		let noCi: CiConfiguredVerdict | undefined;
		if (ci.ci === "failed") {
			return this.#resolve({
				jobId,
				branch,
				step: "ci",
				facts,
				prUrl,
				headSha: head,
				message: ciFailedMessage({ jobId, branch, prUrl, reason: ci.reason }),
				// cp-gmy's rule, restated as code: a red head is never a merge ask.
				reason: `${jobId}: ${ci.reason}. No merge, and no merge authorization was requested.`,
			});
		}
		if (ci.ci !== "green") {
			// cp-e0c/C7 and cp-no-ci-repo-derived: zero observable runs for this branch
			// is not a transient `retry`, and it is not one condition either. Ask the
			// repository what workflows it *has*, because "no runs" is what an
			// unreadable `gh` looks like too.
			if (ci.ci === "unknown" && runsParsed.length === 0) {
				const configured = readCiConfigured(await this.#run(cwd, "gh", ghWorkflowsArgs()));
				facts.push(`ci configuration: ${configured.state} (${configured.cause}) — ${configured.reason}`);
				if (configured.state !== "none") {
					// (b) CI could not be read — runs may exist and may be red. The per-head
					// human checkpoint is the honest exit, exactly as before: an unreadable
					// signal is never permission.
					return this.#fallback({
						jobId,
						branch,
						facts,
						prUrl,
						head,
						evidence: [
							`no CI runs are observable for ${branch}`,
							configured.reason,
							"squash merge, head branch deleted only after teardown",
						],
						reasonPrefix: `${jobId}: no CI runs are observable for ${branch}, so cp_integrate cannot verify green on its own`,
						request,
						cwd,
						draft: view.value.isDraft === true,
					});
				}
				// (a) the repository has no CI configured, established positively: nothing
				// will ever run on this head, so there is no verdict to wait for and none
				// to ask a human to stand in for. Fall through to the repo-derived
				// permission read below — which still refuses everything the repository
				// itself refuses, and still surfaces that refusal as merge pending.
				noCi = configured;
			} else {
				return this.#write({
					jobId,
					branch,
					step: "ci",
					next: ci.ci === "unknown" ? "retry" : "wait",
					facts,
					prUrl,
					headSha: head,
					reason: `${jobId}: ${ci.reason}. Nothing was merged; call cp_integrate again once CI finishes on ${head.slice(0, 12)}.`,
				});
			}
		}
		const ciEvidence = noCi ? `no CI configured: ${noCi.reason}` : `CI ${ci.reason}`;

		// Permission, repo-derived (cp-e0c, answering cp-x7i): read whether GitHub
		// itself would take the merge unforced, re-reading `gh pr view` at the
		// latest possible moment (after CI is seen green) so the head comparison
		// below catches a force-push between the two reads.
		const permView = await this.#viewPr(cwd, pr);
		if (!permView.ok) {
			return this.#write({
				jobId,
				branch,
				step: "permit",
				next: permView.next,
				facts: [...facts, permView.detail],
				prUrl,
				headSha: head,
				reason: permView.reason,
			});
		}
		const permHead = hexSha(permView.value.headRefOid);
		if (!permHead || !shaMatches(permHead, head)) {
			return this.#write({
				jobId,
				branch,
				step: "permit",
				next: "wait",
				facts: [...facts, `head moved to ${permHead ?? "an unresolvable commit"} during the permission check`],
				prUrl,
				...(permHead ? { headSha: permHead } : { headSha: head }),
				reason: `${jobId}: the pushed head moved during the permission check. Nothing was merged; call cp_integrate again to re-verify CI on the new head.`,
			});
		}
		if (permView.value.autoMergeRequest) {
			return this.#write({
				jobId,
				branch,
				step: "permit",
				next: "surface",
				facts: [...facts, "auto-merge is armed on this PR"],
				prUrl,
				headSha: head,
				reason:
					`${jobId}: auto-merge is armed on ${prUrl}. cp_integrate never arms or relies on auto-merge — that would let ` +
					"GitHub merge it later, unattended, which is exactly the standing authority cp-x7i forbids. Disable it " +
					"(gh pr merge --disable-auto) and call cp_integrate again; nothing was re-issued.",
			});
		}

		const mergeStateStatus = (permView.value.mergeStateStatus ?? "").toUpperCase();
		let rules: readonly BranchRule[] | undefined;
		/** A readable rule requires an up-to-date branch, and git says it is not. */
		let ruleRequiresUpdate = false;
		if (mergeStateStatus === "BLOCKED") {
			const rulesResult = await this.#run(cwd, "gh", ghBranchRulesArgs(base));
			if (rulesResult.status === 0) rules = parseBranchRules(rulesResult.stdout);
			if (rulesRequireUpToDate(rules)) {
				// Unreadable ancestry (`undefined`) is never proof: no speculative rebase.
				const fresh = await this.#ancestry(cwd, branch, base);
				facts.push(
					`rules: ${base} requires up-to-date branches; origin/${base} is ${
						fresh === undefined ? "of unreadable ancestry to" : fresh ? "an ancestor of" : "not an ancestor of"
					} origin/${branch}`,
				);
				ruleRequiresUpdate = fresh === false;
			}
		}
		const verdict = evaluateMergePermission({
			branch,
			headSha: head,
			pr: {
				state: permView.value.state,
				isDraft: permView.value.isDraft,
				mergeable: permView.value.mergeable,
				mergeStateStatus: permView.value.mergeStateStatus,
				reviewDecision: permView.value.reviewDecision,
				headRefOid: permView.value.headRefOid,
				autoMergeRequest: permView.value.autoMergeRequest,
			},
			rules,
		});
		facts.push(`permission: ${verdict.permission}${verdict.cause ? ` (${verdict.cause})` : ""} — ${verdict.reason}`);
		this.#event(jobId, "integration_permitted", {
			step: "permit",
			permission: verdict.permission,
			cause: verdict.cause ?? null,
			merge_state_status: verdict.merge_state_status ?? null,
			review_decision: verdict.review_decision ?? null,
			head_sha: head,
		});
		// jje.5: an unreviewed draft is an intentional hold (next: review), never a merge-pending reminder.
		if (verdict.cause === "draft") return (await this.#reviewRequired({ jobId, branch, facts, prUrl, head })) ?? this.#ready({ jobId, branch, facts, prUrl, head, cwd });

		if (verdict.permission === "pending" && (verdict.cause === "behind" || ruleRequiresUpdate)) {
			// `gh pr update-branch --rebase` is server-side: it advances
			// origin/<branch> without touching any worktree, which is what keeps this
			// from being a second writer in the clobber sense.
			const updated = await this.#run(cwd, "gh", ["pr", "update-branch", "--rebase", prUrl]);
			if (updated.status !== 0) {
				return this.#write({
					jobId,
					branch,
					step: "fresh",
					next: "retry",
					facts: [...facts, firstLine(updated)],
					prUrl,
					headSha: head,
					reason: `${jobId}: could not update ${prUrl} onto ${base} (${firstLine(updated)}). Nothing else was touched.`,
				});
			}
			return this.#write({
				jobId,
				branch,
				step: "fresh",
				next: "advance",
				facts: [...facts, `updated ${prUrl} onto ${base} (server-side rebase)`],
				prUrl,
				// Deliberately *not* carrying the old head forward: the update moved it,
				// so CI and cp_review must pass again on the new commit. Reading the new
				// head is the next call's first job.
				reason:
					`${jobId}: GitHub requires ${prUrl} to be up to date with ${base}, so it was updated server-side. Its head ` +
					"moved: CI and cp_review must pass on the new commit. Call cp_integrate again.",
			});
		}

		if (verdict.permission === "retry") {
			return this.#write({
				jobId,
				branch,
				step: "permit",
				next: "retry",
				facts,
				prUrl,
				headSha: head,
				reason: `${jobId}: ${verdict.reason} Nothing was merged; call cp_integrate again.`,
			});
		}
		if (verdict.permission === "pending") {
			// The repository itself refuses this merge (cp-x7i): never forced, no
			// checkpoint minted — only a reminder that the merge is pending on the
			// repo's own rules, exactly what the operator asked for.
			await this.#remind(jobId, prUrl, verdict);
			return this.#write({
				jobId,
				branch,
				step: "permit",
				next: "surface",
				facts,
				prUrl,
				headSha: head,
				reason: `${jobId}: ${prUrl} is ready but GitHub will not take the merge yet — ${verdict.reason}`,
			});
		}
		if (verdict.permission === "unreadable") {
			// This home cannot read whether the repo permits the merge: the named
			// fallback is the per-head human checkpoint, exactly as it worked before
			// this rule existed.
			return this.#fallback({
				jobId,
				branch,
				facts,
				prUrl,
				head,
				evidence: [
					`currency of ${branch} with ${base} not verified (GitHub's merge verdict is unreadable)`,
					ciEvidence,
					verdict.reason,
					"squash merge, head branch deleted only after teardown",
				],
				reasonPrefix: `${jobId}: ${verdict.reason}`,
				request,
				cwd,
			});
		}

		const blocked = await this.#reviewRequired({ jobId, branch, facts, prUrl, head });
		if (blocked) return blocked;

		// permitted: withdraw any open "merge pending" reminder, then merge.
		// **No `--delete-branch`**: teardown's strongest pass reason (`pushed`)
		// needs origin/<branch> to still exist, and deleting it first is what
		// forced `force`. `--match-head-commit` makes the head binding server-side
		// and atomic — the mechanical replacement for what the removed checkpoint's
		// file name used to guarantee.
		await this.#withdrawReminder(jobId, prUrl);
		const authority: MergeAuthority = {
			kind: "repo_derived",
			head_sha: head,
			...(verdict.merge_state_status ? { merge_state_status: verdict.merge_state_status } : {}),
			...(verdict.review_decision ? { review_decision: verdict.review_decision } : {}),
			...(rules ? { rules_source: `gh api repos/{owner}/{repo}/rules/branches/${base}`, rules: rules.map((rule) => rule.type) } : {}),
			decided_at: isoTimestamp(this.#now()),
		};
		const strategy: MergeStrategy = request.strategy ?? "squash";
		const heldBeforeMerge = this.#held(jobId, branch);
		if (heldBeforeMerge) return heldBeforeMerge;
		const merged = await this.#run(cwd, "gh", [
			"pr",
			"merge",
			prUrl,
			`--${strategy === "unknown" ? "squash" : strategy}`,
			"--match-head-commit",
			head,
		]);
		if (merged.status !== 0) {
			return this.#write({
				jobId,
				branch,
				step: "merge",
				next: "retry",
				facts: [...facts, firstLine(merged)],
				prUrl,
				headSha: head,
				reason: `${jobId}: gh refused to merge ${prUrl} (${firstLine(merged)}). Nothing was recorded.`,
			});
		}
		this.#event(jobId, "integration_advanced", { step: "merge", pr_url: prUrl, head_sha: head, strategy });
		return this.#write({
			jobId,
			branch,
			step: "merge",
			next: "advance",
			facts: [...facts, `merged ${prUrl} (${strategy}, head branch kept for teardown)`],
			prUrl,
			headSha: head,
			mergeAuthority: authority,
			reason: `${jobId}: ${prUrl} merged. Call cp_integrate again to record the receipt, tear down and close.`,
		});
	}

	/** No passing `cp_review` on this head (or a recorded patch-equivalent) → stop, mutate nothing. */
	async #reviewRequired(input: {
		jobId: string;
		branch: string;
		facts: string[];
		prUrl: string;
		head: string;
	}): Promise<IntegrateResult | undefined> {
		const { jobId, branch, facts, prUrl, head } = input;
		if (readReviewPassVerdict(this.#options.home, jobId, head)) return undefined;
		if (this.#flaggedDiffAuthorized(jobId, head)) return undefined;
		const short = head.slice(0, 12);
		const common = { jobId, branch, step: "review" as const, prUrl, headSha: head };
		// jje.3: at the cap, one operator-approved final fix is the only exit, never a sixth review.
		const job = this.#options.fleet.get(jobId);
		const fix = job ? resolveFinalFix(this.#options.home, job, head, { now: this.#now(), prUrl }) : { state: "none" as const };
		if (fix.state === "accepted") {
			facts.push(fix.reason);
			return undefined;
		}
		if (fix.state === "approved") {
			let error = this.#options.send ? undefined : "no sender is wired";
			try {
				const sent = this.#options.send ? await this.#options.send(jobId, finalFixMessage(fix)) : undefined;
				error ??= sent?.error;
			} catch (thrown) {
				error = (thrown as Error).message;
			}
			if (error) return this.#write({ ...common, next: "surface", facts: [...facts, `final fix not promoted: ${error}`], resolveError: error, reason: `${fix.reason} The promote failed (${error}); the operator's call.` });
			const record = recordFinalFixPromotion(this.#options.home, this.#options.fleet.get(jobId) ?? (job as FleetRecord), fix, this.#now());
			this.#event(jobId, "integration_advanced", { step: "review", final_fix: "promoted", capped_head: record.capped_head, fix_generation: record.fix_generation, decided_by: record.decided_by });
			return this.#write({ ...common, next: "resolve", facts: [...facts, `final fix promoted once (fix generation ${record.fix_generation})`], reason: `${fix.reason} Wait for its report; only that reported head may merge.` });
		}
		if (fix.state !== "none") {
			return this.#write({ ...common, next: fix.state === "promoted" ? "resolve" : "surface", facts: [...facts, `review: ${fix.state} final fix`], reason: fix.reason });
		}
		return this.#write({
			...common,
			next: "review",
			facts: [...facts, `review: no pass on ${short}`],
			reason:
				`${jobId}: no passing cp_review on ${short}. Run cp_review on that head, or authorize a flagged escalate via the diff checkpoint; never re-review an unchanged one. Nothing was merged.`,
		});
	}

	/** jje.5: the reviewed head of a draft → `gh pr ready` once, then re-read; an unconfirmed head goes back to draft (`--undo`), or surfaces. */
	async #ready(input: { jobId: string; branch: string; facts: string[]; prUrl: string; head: string; cwd: string }): Promise<IntegrateResult> {
		const { jobId, prUrl, head } = input, ready = await this.#run(input.cwd, "gh", ["pr", "ready", prUrl]);
		const view = ready.status === 0 ? await this.#viewPr(input.cwd, prUrl) : undefined;
		const now = view?.ok ? hexSha(view.value.headRefOid) : undefined;
		const undo = view && !(now && shaMatches(now, head)) ? await this.#run(input.cwd, "gh", ["pr", "ready", "--undo", prUrl]) : undefined;
		const moved = view?.ok ? `head moved to ${now ?? "an unresolvable commit"} after gh pr ready` : `head unconfirmed after gh pr ready (${view?.detail})`;
		const [next, fact] = !view ? ["surface" as const, `gh pr ready refused: ${firstLine(ready)}`] : undo || !view.ok ? (undo?.status === 0 ? [view.ok ? ("wait" as const) : view.next, `${moved}; returned to draft`] : ["surface" as const, `${moved}; gh pr ready --undo refused (${undo ? firstLine(undo) : "not run"}), so an unreviewed head reads ready`])
			: view.value.isDraft === true ? ["surface" as const, "gh pr ready succeeded but the PR still reads as a draft"]
			: ["advance" as const, `marked ${prUrl} ready for review at ${head.slice(0, 12)}`];
		if (view) this.#event(jobId, "integration_advanced", { step: "ready", pr_url: prUrl, head_sha: head, undone: undo?.status === 0 });
		return this.#write({ jobId, branch: input.branch, step: "permit", next, facts: [...input.facts, fact], prUrl, headSha: now ?? head, reason: `${jobId}: ${fact}. ${next === "advance" ? "Call cp_integrate again: CI and merge permission are re-read before any merge." : "Nothing was merged and nothing retries this."}` });
	}

	/** Teardown's clearance: a complete-subject `escalate`/`flagged` on this head plus an approved `kind: "diff"` checkpoint. */
	#flaggedDiffAuthorized(jobId: string, head: string): boolean {
		const checkpoint = new CheckpointStore(this.#options.home, { kind: "diff" }).get(jobId);
		if (checkpoint?.decision !== "approved") return false;
		for (let attempt = REVIEW_MAX_ATTEMPTS; attempt >= 1; attempt -= 1) {
			const file = join(this.#options.home, paths.reviewFile(jobId, attempt));
			if (!existsSync(file)) continue;
			try {
				const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(file, "utf8")));
				if (!parsed.ok || !shaMatches(parsed.value.head_sha, head)) continue;
				return parsed.value.verdict === "escalate" && parsed.value.cause === "flagged" && !parsed.value.diff_stat.truncated;
			} catch {
				continue;
			}
		}
		return false;
	}

	/**
	 * The fallback path (cp-e0c): this home could not read whether the
	 * repository permits the merge — mergeStateStatus is unreadable, or the CI
	 * state could not be read at all for this branch. The per-head, per-PR human
	 * checkpoint survives exactly as it worked before this rule existed. An
	 * approved checkpoint here still never bypasses a repo refusal: this path is
	 * only reached when the repo's own verdict could not be read at all, never
	 * when it read `pending`.
	 *
	 * cp-no-ci-repo-derived narrowed the CI half of that: a repository that
	 * *positively* reports zero workflows never reaches here, because nothing
	 * will ever run on any head and there is no verdict for a human to stand in
	 * for. Only an **unreadable** CI configuration does.
	 */
	async #fallback(input: {
		jobId: string;
		branch: string;
		facts: string[];
		prUrl: string;
		head: string;
		evidence: string[];
		reasonPrefix: string;
		request: IntegrateRequest;
		cwd: string;
		draft?: boolean;
	}): Promise<IntegrateResult> {
		const { jobId, branch, facts, prUrl, head, request, cwd } = input;
		const blocked = await this.#reviewRequired({ jobId, branch, facts, prUrl, head });
		if (blocked) return blocked;
		if (input.draft) return this.#ready({ jobId, branch, facts, prUrl, head, cwd });
		const checkpoints = this.#checkpoints();
		const scope = scopeOf(head);
		const existing = checkpoints.get(jobId, { scope });
		if (!existing) {
			checkpoints.request({
				jobId,
				scope,
				question: `Merge ${prUrl} for ${jobId} at ${head.slice(0, 12)}?`,
				evidence: input.evidence,
			});
			return this.#write({
				jobId,
				branch,
				step: "authorize",
				next: "surface",
				facts: [...facts, `merge authorization requested for ${head.slice(0, 12)} (pending)`],
				prUrl,
				headSha: head,
				reason:
					`${input.reasonPrefix}. A merge authorization for ${head.slice(0, 12)} is now pending. ` +
					"Only a human answers it (/cp-decide, /cp-authorize, /cp-decline) — evidence is not authorization.",
			});
		}
		if (existing.decision !== "approved") {
			return this.#write({
				jobId,
				branch,
				step: "authorize",
				next: "surface",
				facts: [...facts, `merge authorization for ${head.slice(0, 12)} is ${existing.decision}`],
				prUrl,
				headSha: head,
				reason:
					existing.decision === "declined"
						? `${jobId}: the merge of ${head.slice(0, 12)} was declined by ${existing.decided_by ?? "a human"}. Nothing was merged.`
						: `${jobId}: the merge of ${head.slice(0, 12)} is still awaiting a human. Nothing was merged.`,
			});
		}

		// Approved: merge, deliberately without `--delete-branch` (see the
		// permitted path above for why), and record which checkpoint permitted it.
		// `--match-head-commit` is passed here for the same reason as on the
		// permitted path, and it matters more (cp-n1a): the only other thing tying
		// this human's "yes" to a commit is the checkpoint's file name, which a
		// force-push landing after the answer cannot invalidate. The flag makes the
		// binding server-side and atomic, so a moved head is refused by GitHub
		// instead of merging a commit nobody authorized.
		const authority: MergeAuthority = {
			kind: "human_checkpoint",
			head_sha: head,
			checkpoint_file: paths.checkpointFile(jobId, "merge", scope),
			decided_at: existing.decided_at ?? isoTimestamp(this.#now()),
		};
		const strategy: MergeStrategy = request.strategy ?? "squash";
		const heldBeforeMerge = this.#held(jobId, branch);
		if (heldBeforeMerge) return heldBeforeMerge;
		const merged = await this.#run(cwd, "gh", [
			"pr",
			"merge",
			prUrl,
			`--${strategy === "unknown" ? "squash" : strategy}`,
			"--match-head-commit",
			head,
		]);
		if (merged.status !== 0) {
			return this.#write({
				jobId,
				branch,
				step: "merge",
				next: "retry",
				facts: [...facts, firstLine(merged)],
				prUrl,
				headSha: head,
				approvedHead: head,
				reason:
					`${jobId}: gh refused to merge ${prUrl} at the authorized head ${head.slice(0, 12)} ` +
					`(${firstLine(merged)}). Nothing was merged and nothing was recorded — if the head has moved, ` +
					"the next cp_integrate call re-reads it, re-checks CI and mints a new per-head authorization.",
			});
		}
		this.#event(jobId, "integration_advanced", { step: "merge", pr_url: prUrl, head_sha: head, strategy });
		return this.#write({
			jobId,
			branch,
			step: "merge",
			next: "advance",
			facts: [...facts, `merged ${prUrl} (${strategy}, head branch kept for teardown)`],
			prUrl,
			headSha: head,
			approvedHead: head,
			mergeAuthority: authority,
			reason: `${jobId}: ${prUrl} merged. Call cp_integrate again to record the receipt, tear down and close.`,
		});
	}

	/** Declare (or update) the "merge pending" reminder. Best-effort: an
	 * unwritable awaiting store must never fail a merge decision that already
	 * held. */
	async #remind(jobId: string, prUrl: string, verdict: MergePermissionVerdict): Promise<void> {
		try {
			await raiseMergeRefused(new EscalationStore({ home: this.#options.home }), {
				jobId,
				prUrl,
				reason: verdict.reason,
			});
		} catch {
			// Same as the awaiting reminder: never fail a merge decision that already held.
		}
		const awaiting = this.#options.awaiting?.();
		if (!awaiting) return;
		try {
			await awaiting.declareGated({
				type: "approval",
				subject: `merge-pending pr ${prUrl}`,
				decision: boundedDecision(`merge pending: ${verdict.reason}`),
				why: "cp_integrate never forces a merge the repository refuses (no --admin, no bypass).",
				blocks: `${jobId} cannot land until GitHub accepts the merge`,
				options: ["Satisfied on GitHub — retry the merge", "Leave it pending", "Drop this PR"],
				job_id: jobId,
			});
		} catch {
			// Never fails the surfaced result: the reminder is best-effort, the
			// refusal to merge is not.
		}
	}

	/** Withdraw the "merge pending" reminder once the repo permits the merge. */
	async #withdrawReminder(jobId: string, prUrl: string): Promise<void> {
		const awaiting = this.#options.awaiting?.();
		if (!awaiting) return;
		// Same {job_id,type,subject} identity `declareGated` keys on (cp-nx7), computed
		// directly so withdrawal never has to declare a row just to learn its id.
		const subject = `merge-pending pr ${prUrl}`;
		const id = awaitingId({ type: "approval", job_id: jobId, subject, decision: subject });
		try {
			await awaiting.withdraw(id);
		} catch {
			// No open reminder to withdraw, or the store refused it (e.g. already
			// answered) — either way, a merge that happened must never be undone by a
			// bookkeeping failure.
		}
	}

	// -- the tail: record -> sync -> teardown -> delete head -> close ---------

	/**
	 * Everything after GitHub says MERGED. Order is the contract (cp-vk1 #76 and
	 * the parent's own correction): record, sync the leased worktree, tear down
	 * while origin/<branch> still exists, delete the head, close the issue.
	 */
	async #finish(input: {
		jobId: string;
		branch: string;
		cwd: string;
		facts: string[];
		prUrl?: string;
		headSha?: string;
		/** The PR's own base, when GitHub was asked on this call. */
		base?: string;
		request: IntegrateRequest;
	}): Promise<IntegrateResult> {
		const { jobId, branch, cwd, facts } = input;
		const fleet = this.#options.fleet;
		// Same precedence as the open path: an explicit argument wins, then the base
		// GitHub reports for this PR, then `main`. The sync step's losslessness proof
		// needs it, and a wrong guess there can only *refuse* — the proof compares
		// two heads against whatever base it was given, and no match means no reset.
		const base = input.request.base?.trim() || input.base?.trim() || DEFAULT_BASE;

		// 1. record — idempotent by construction (`MergeStore.record` returns
		//    `recorded: false` for an existing receipt), which is what makes the
		//    whole `advance` safely re-runnable. The authority — which rule
		//    permitted this merge — is read back from the `permit` step's own
		//    record, never recomputed: this call may be a parent restart with no
		//    memory of that decision at all, and its absence (a PR merged
		//    externally, or by `cp_merged`) is itself the honest fact.
		const priorAuthority = this.get(jobId)?.merge_authority;
		let merge: RecordMergeResult;
		try {
			merge = await this.#options.merges.record({
				jobId,
				...(input.prUrl ? { pr: input.prUrl } : {}),
				strategy: input.request.strategy ?? "squash",
				cwd,
				by: "cp_integrate",
				...(priorAuthority ? { authority: priorAuthority } : {}),
			});
		} catch (error) {
			return this.#write({
				jobId,
				branch,
				step: "record",
				next: "retry",
				facts: [...facts, (error as Error).message.split("\n")[0] ?? "merge could not be recorded"],
				...(input.prUrl ? { prUrl: input.prUrl } : {}),
				...(input.headSha ? { headSha: input.headSha } : {}),
				reason: `${jobId}: the merge could not be recorded — ${(error as Error).message.split("\n")[0]}`,
			});
		}
		if (merge.recorded) {
			facts.push(`receipt written: ${paths.mergeFile(jobId)}`);
			this.#event(jobId, "integration_advanced", { step: "record", pr_url: merge.receipt.pr_url });
		}

		const record = fleet.get(jobId);
		const done = record?.phase === "done";
		// The one place a stored step is read rather than recomputed, and only for
		// the last, non-destructive link: br has no cheap "is it closed?" this module
		// already holds, and re-closing a closed issue is an error, not a no-op. So a
		// second `advance` after a finished integration is a genuine no-op (§Test 2).
		const alreadyClosed = this.get(jobId)?.step === "done";

		// 2. sync — a server-side rebase leaves the leased worktree behind origin,
		//    and the teardown gate compares the *local* HEAD to the remote tip.
		//    cp-vk1 made the remote question honest; it does not move the local tip.
		if (!done && record && isDirectory(record.worktree)) {
			const sync = await this.#syncWorktree({ jobId, worktree: record.worktree, branch, base });
			if (sync.acted) facts.push(sync.detail);
			if (sync.failed) {
				return this.#write({
					jobId,
					branch,
					step: "sync",
					next: "surface",
					facts: [...facts, sync.detail],
					prUrl: merge.receipt.pr_url,
					headSha: merge.receipt.head_sha,
					merge,
					reason:
						`${jobId}: the leased worktree could not be brought back to origin/${branch} (${sync.detail}). ` +
						"Teardown would refuse as unpushed; fix it in place rather than reaching for force.",
				});
			}
		}

		// 3. teardown — while origin/<branch> still exists, so the gate can pass on
		//    the strong `pushed` reason and the receipt is belt-and-braces.
		let teardown: TeardownResult | undefined;
		if (!done) {
			teardown = await this.#options.teardown.teardown(jobId);
			if (teardown.failure) {
				return this.#write({
					jobId,
					branch,
					step: "teardown",
					next: "surface",
					facts: [...facts, `teardown refused: ${teardown.failure.code} — ${teardown.failure.message}`],
					prUrl: merge.receipt.pr_url,
					headSha: merge.receipt.head_sha,
					merge,
					teardown,
					reason: `${jobId}: teardown refused (${teardown.failure.code}). ${teardown.failure.fix}`,
				});
			}
			facts.push(`teardown passed: ${teardown.reason ?? "no reason recorded"}`);
			this.#event(jobId, "integration_advanced", { step: "teardown", reason: teardown.reason ?? null });
		}

		// 4. delete the head — only now, and only if it is still there.
		const onRemote = await this.#branchOnRemote(cwd, branch);
		if (onRemote === true) {
			const deleted = await this.#run(cwd, "git", ["push", "origin", "--delete", branch]);
			if (deleted.status !== 0) {
				return this.#write({
					jobId,
					branch,
					step: "delete_head",
					next: "retry",
					facts: [...facts, firstLine(deleted)],
					prUrl: merge.receipt.pr_url,
					headSha: merge.receipt.head_sha,
					merge,
					...(teardown ? { teardown } : {}),
					reason:
						`${jobId}: merged and torn down, but origin/${branch} could not be deleted (${firstLine(deleted)}). ` +
						"Everything else stands; retry, or delete it on GitHub.",
				});
			}
			facts.push(`deleted origin/${branch}`);
		} else if (onRemote === false) {
			facts.push(`origin/${branch} is already gone`);
		}

		// 5. close the br issue, with a reason. Always a reason (AGENTS.md §Backlog).
		let brClosed = alreadyClosed;
		try {
			if (!alreadyClosed) {
				await this.#options.ledger().close(jobId, `merged: ${merge.receipt.pr_url}`);
				brClosed = true;
				facts.push(`job ${jobId} closed: merged: ${merge.receipt.pr_url}`);
			}
		} catch (error) {
			return this.#write({
				jobId,
				branch,
				step: "close",
				next: "retry",
				facts: [...facts, (error as Error).message.split("\n")[0] ?? "job close failed"],
				prUrl: merge.receipt.pr_url,
				headSha: merge.receipt.head_sha,
				merge,
				...(teardown ? { teardown } : {}),
				reason:
					`${jobId}: merged, torn down and the head deleted, but the job is still open ` +
					`(${(error as Error).message.split("\n")[0]}). Retry, or close it by hand with a reason.`,
			});
		}

		// 6. prune the rescue refs the sync step wrote, and only the ones the base
		//    itself now provably carries (cp-wcy5). Read-only unless a commit is an
		//    ancestor of the tip origin names for the base; never fails the
		//    integration, because a ref that could not be pruned is a ref that was
		//    kept, which is the safe outcome.
		facts.push(...(await this.#pruneSalvageRefs({ cwd, base, jobId })));

		const endState = this.endState(jobId, { brClosed });
		this.#event(jobId, "integration_advanced", { step: "done", ...endState });
		return this.#write({
			jobId,
			branch,
			step: "done",
			next: "done",
			facts,
			prUrl: merge.receipt.pr_url,
			headSha: merge.receipt.head_sha,
			merge,
			...(teardown ? { teardown } : {}),
			endState,
			reason:
				`${jobId} integrated: ${merge.receipt.pr_url} merged as ${merge.receipt.merge_commit_sha.slice(0, 12)}, ` +
				"receipt recorded, lease returned, head deleted, job closed.",
		});
	}

	/**
	 * The three facts §Decision 6 leaves the parent to check, read from disk.
	 * Returned by `advance` so the check is "read the tool's own result" rather
	 * than a re-derivation of the sequence.
	 */
	endState(jobId: string, options: { brClosed?: boolean } = {}): EndState {
		const record = this.#options.fleet.get(jobId);
		const prReceipt = (record?.receipts ?? []).find((entry) => entry.kind === "pr");
		return {
			merge_receipt: this.#options.merges.get(jobId) !== undefined,
			fleet_done: record?.phase === "done" && record.closed_reason !== "forced",
			...(record?.closed_reason ? { closed_reason: record.closed_reason } : {}),
			...(prReceipt?.status ? { pr_receipt_status: prReceipt.status } : {}),
			br_closed: options.brClosed === true,
		};
	}

	// -- the one hand-back path ----------------------------------------------

	/** Wait for active repairs; promote once, then surface a completed failure to the operator. */
	async #resolve(input: {
		jobId: string;
		branch: string;
		step: IntegrationStep;
		facts: string[];
		prUrl?: string;
		headSha?: string;
		message: string;
		reason: string;
	}): Promise<IntegrateResult> {
		const common = {
			jobId: input.jobId,
			branch: input.branch,
			step: input.step,
			...(input.prUrl ? { prUrl: input.prUrl } : {}),
			...(input.headSha ? { headSha: input.headSha } : {}),
		};
		if (this.#resolving.has(input.jobId) || this.#options.fleet.get(input.jobId)?.phase === "waiting") {
			return this.#write({
				...common,
				next: "resolve",
				facts: [...input.facts, "the implementer is already working; no further promotion"],
				reason: `${input.reason} The implementer is already working; wait for its report.`,
			});
		}
		const prior = this.get(input.jobId)?.resolve_attempts ?? 0;

		if (prior >= INTEGRATE_MAX_RESOLVE) {
			return this.#write({
				...common,
				next: "surface",
				facts: [...input.facts, `the implementer has already been promoted ${prior} time(s) for this`],
				reason: `${input.reason} The implementer was already asked once; this is the operator's call now.`,
			});
		}
		const send = this.#options.send;
		if (!send) {
			return this.#write({
				...common,
				next: "surface",
				facts: [...input.facts, "no sender is wired, so nothing was promoted"],
				reason: `${input.reason} There is no way to promote the implementer from here — surfacing instead.`,
			});
		}
		let receipt: string | undefined;
		let error: string | undefined;
		this.#resolving.add(input.jobId);
		try {
			const outcome = await send(input.jobId, input.message);
			receipt = outcome.receipt;
			if (outcome.error) error = outcome.error;
		} catch (thrown) {
			error = (thrown as Error).message;
		} finally {
			this.#resolving.delete(input.jobId);
		}

		if (error || !receipt) {
			// No live implementer (or a refused delivery): this is the operator's,
			// and a replacement is never dispatched in its place.
			return this.#write({
				...common,
				next: "surface",
				facts: [...input.facts, `promote not delivered: ${error ?? "no receipt"}`],
				resolveError: error ?? "no receipt",
				reason: `${input.reason} The implementer could not be promoted (${error ?? "no receipt"}) — this is the operator's call.`,
			});
		}
		return this.#write({
			...common,
			next: "resolve",
			facts: [...input.facts, `implementer promoted (${receipt})`],
			resolveReceipt: receipt,
			bumpResolve: true,
			reason: `${input.reason} The implementer was promoted to fix it on ${input.branch}; wait for its report.`,
		});
	}

	// -- facts ---------------------------------------------------------------

	async #viewPr(
		cwd: string,
		pr: string,
	): Promise<{ ok: true; value: GhPrView } | { ok: false; next: IntegrationNext; reason: string; detail: string }> {
		const result = await this.#run(cwd, "gh", ["pr", "view", pr, "--json", GH_PR_INTEGRATION_FIELDS.join(",")]);
		if (result.status !== 0) {
			const detail = firstLine(result);
			// A missing binary is not a rate limit: one is the operator's to fix and
			// the other is a retry. `force` is named here as the *honest* exit for a
			// merge this machine cannot observe — never as automation.
			const missing = /ENOENT|command not found|not found/i.test(detail);
			return {
				ok: false,
				next: missing ? "surface" : "retry",
				detail,
				reason: missing
					? `gh is not available in ${cwd} (${detail}). Nothing was touched. Install it (node scripts/install-tools.ts gh); ` +
						"if the merge can never be observed from this machine, cp_teardown force is the honest exit — it proves nothing, and records that."
					: `could not read PR ${pr} with gh in ${cwd} (${detail}). Nothing was mutated; retry.`,
			};
		}
		try {
			return { ok: true, value: JSON.parse(result.stdout) as GhPrView };
		} catch {
			return {
				ok: false,
				next: "retry",
				detail: "gh returned output that is not JSON",
				reason: `gh returned output that is not JSON for PR ${pr}. Nothing was mutated.`,
			};
		}
	}

	/** Is `origin/<base>` already an ancestor of `origin/<branch>`? */
	async #ancestry(cwd: string, branch: string, base: string): Promise<boolean | undefined> {
		const fetched = await this.#run(cwd, "git", ["fetch", "origin", "--prune"]);
		if (fetched.status !== 0) return undefined;
		const result = await this.#run(cwd, "git", [
			"merge-base",
			"--is-ancestor",
			`origin/${base}`,
			`origin/${branch}`,
		]);
		if (result.status === 0) return true;
		if (result.status === 1) return false;
		// Any other exit is "could not ask", and an unanswerable question must
		// never look like "it is fresh" — but it must not trigger a rebase either.
		return undefined;
	}

	async #branchOnRemote(cwd: string, branch: string): Promise<boolean | undefined> {
		const result = await this.#run(cwd, "git", ["ls-remote", "--heads", "origin", branch]);
		if (result.status !== 0) return undefined;
		return result.stdout.trim().length > 0;
	}

	/**
	 * Bring the leased worktree back to the sha origin reports for `<branch>`
	 * when a server-side rebase left it behind. Only ever a **fast-forward** to
	 * what origin already holds — this never invents a commit and never pushes.
	 *
	 * Which sha that is comes from **origin itself** (`git ls-remote`), and the
	 * reset names that sha rather than `refs/remotes/origin/<branch>` (cp-vk1,
	 * cp-p0r): the guard below already compares HEAD against the `ls-remote` sha,
	 * so acting on a ref would act on a different answer from the one that was
	 * verified. It fails closed the same way #71 does — an unreadable or absent
	 * answer from origin is not permission to move anything, and there is
	 * deliberately no fallback to the tracking ref.
	 *
	 * `git reset --hard` is the one destructive call in this module, so it is
	 * guarded twice and both guards fail closed:
	 *
	 *  - a **dirty** tree is never reset — uncommitted work is not this tool's to
	 *    discard;
	 *  - a tree holding **commits origin does not have** is never reset either,
	 *    *unless* those commits can be proven lossless (below). A clean worktree
	 *    is not the same as a worktree with nothing to lose: an implementer that
	 *    committed and did not push has work that exists in exactly one place,
	 *    and `reset --hard` would be the only event that ever destroyed work in
	 *    this system. `rev-list --count <remote>..HEAD` must be 0 — i.e. HEAD is
	 *    an ancestor of the remote tip — and a count that cannot be read is
	 *    treated as "do not touch it", not as zero.
	 *
	 * **The losslessness proof (cp-8vf6).** That second guard refused 7 times on
	 * 2026-09-01 (cp-p0r, cp-rs1, cp-jqk3, cp-bw4, cp-nz95 among them) — a 33%
	 * refusal rate — and every one of those refusals was literally correct and
	 * substantively a false alarm: the commits the worktree held were the
	 * branch's own **pre-rebase** versions, whose content origin had already
	 * absorbed through the server-side rebase and the squash merge. The parent
	 * then proved losslessness by hand, seven times for seven. The guard is right
	 * to refuse without proof; what it now does is *obtain* the proof, with
	 * `#absorbedIntoBase`, and refuse exactly as before when it cannot.
	 */
	async #syncWorktree(input: {
		jobId: string;
		worktree: string;
		branch: string;
		base: string;
	}): Promise<{ acted: boolean; failed: boolean; detail: string }> {
		const { jobId, worktree, branch, base } = input;
		const fetched = await this.#run(worktree, "git", ["fetch", "origin", branch]);
		if (fetched.status !== 0) {
			return { acted: false, failed: false, detail: `could not fetch origin/${branch} in the worktree` };
		}
		const local = (await this.#run(worktree, "git", ["rev-parse", "HEAD"])).stdout.trim();
		const remote = (await this.#run(worktree, "git", ["ls-remote", "--heads", "origin", branch])).stdout.trim().split(/\s+/)[0] ?? "";
		if (remote.length === 0) {
			// Origin could not be asked, or does not have the branch. That is a
			// refusal, not an invitation to reach for `refs/remotes/origin/<branch>`
			// instead: nothing here is reset without a sha origin itself named.
			return { acted: false, failed: false, detail: `origin did not name a tip for ${branch}, so the worktree was left alone` };
		}
		if (local.length === 0 || shaMatches(local, remote)) {
			return { acted: false, failed: false, detail: "worktree already matches origin" };
		}
		const dirty = await this.#run(worktree, "git", ["status", "--porcelain"]);
		if (dirty.stdout.trim().length > 0) {
			return {
				acted: false,
				failed: true,
				detail: "the worktree is dirty, so it was not reset — uncommitted work is never discarded here",
			};
		}
		// Compared against the sha `ls-remote` just reported, not against a
		// remote-tracking ref: cp-vk1's rule, and the reason this cannot be fooled by
		// a stale `refs/remotes/origin/<branch>`. That ref goes stale on its own, and
		// in this layout every lease is a *linked worktree of one shared clone*, so it
		// can also be moved by another lease's fetch between this one's fetch and its
		// reset.
		const ahead = await this.#run(worktree, "git", ["rev-list", "--count", `${remote}..HEAD`]);
		const count = Number.parseInt(ahead.stdout.trim(), 10);
		if (ahead.status !== 0 || !Number.isFinite(count)) {
			return {
				acted: false,
				failed: true,
				detail: `could not tell whether the worktree holds commits origin/${branch} does not (${firstLine(ahead)}) — it was not reset`,
			};
		}
		let absorbed = "";
		if (count > 0) {
			// The only path on which this function discards a commit. It runs the
			// proof the parent used to run by hand, and every one of its steps fails
			// closed: an unreadable base, a missing merge base, a diff that will not
			// read, an empty diff, a patch-id git declines to give, or two ids that
			// differ all end in the same refusal the code has always made.
			const proof = await this.#absorbedIntoBase({ worktree, base, local, remote });
			if (!proof.proven) {
				return {
					acted: false,
					failed: true,
					detail:
						`the worktree holds ${count} commit(s) origin/${branch} does not, and they could not be proven to be ` +
						`already in ${base} (${proof.why}), so it was not reset — resetting would be the only thing in this ` +
						"system that ever destroyed work",
				};
			}
			// A proven-lossless reset is still reversible: the discarded head is
			// written to a ref *before* the reset and named in the fact, so recovery
			// is `git reset --hard <ref>` rather than reflog archaeology. No ref, no
			// reset — this is the last guard, and it fails closed like the others.
			const salvage = await this.#salvageRef(worktree, jobId, local);
			if (!salvage.ref) {
				return {
					acted: false,
					failed: true,
					detail:
						`the worktree holds ${count} commit(s) origin/${branch} does not; their content is already in ${base}, ` +
						`but ${local.slice(0, 12)} could not be kept on a rescue ref first (${salvage.why}), so it was not reset`,
				};
			}
			absorbed =
				` — ${count} pre-rebase commit(s) were discarded: their cumulative diff is the one ${base} already carries ` +
				`(patch-id ${proof.id.slice(0, 12)}), and ${local.slice(0, 12)} is kept at ${salvage.ref}`;
		}
		// The reset names the verified sha, so the commit the worktree lands on is the
		// one the guard above cleared — and the postcondition teardown checks
		// (`remote.sha === head`, src/teardown.ts) is the same fact. Resetting to the
		// ref would also fail outright in a clone whose refspec does not fetch this
		// branch (`--single-branch`, `--depth`), where `ls-remote` answers fine.
		const reset = await this.#run(worktree, "git", ["reset", "--hard", remote]);
		if (reset.status !== 0) {
			return { acted: false, failed: true, detail: firstLine(reset) };
		}
		return {
			acted: true,
			failed: false,
			detail: `worktree reset to ${remote.slice(0, 12)}, the sha origin names for ${branch}${absorbed}`,
		};
	}

	/**
	 * Is everything the worktree holds already in the base — content-wise?
	 *
	 * The proof is the **cumulative branch diff's patch-id**: for the local head
	 * and for the sha origin names, `git diff <merge-base with the base tip> <head>
	 * | git patch-id --stable`, compared. Equal, non-empty ids mean the two heads
	 * carry the same change against the same base — which is exactly what a
	 * server-side rebase produces and what the 7 refusals of 2026-09-01 all were
	 * (validated 7-for-7 against that history, plus three constructed controls).
	 *
	 * Cheaper questions were tried and are not sound: `git cherry` compares
	 * per-commit patch-ids and a squash merge collapses N commits into one, so it
	 * still refused 3 of the 7; `git diff <stale head> <merge commit>` is never
	 * empty because the stale head sits on an older base; and `git diff --raw`
	 * blob shas differ under a rebase whenever the *pre*-image moved, refusing 4
	 * of the 7. `patch-id --stable` ignores line numbers, blob shas and
	 * whitespace, which is why it survives the base moving underneath.
	 *
	 * What it proves is **content**, not history: a passing proof discards commit
	 * identity (shas, boundaries, committer times). In a squash-merge repository
	 * the merge already discarded those. It also refuses, correctly, when a
	 * server-side rebase resolved a conflict — the cumulative diff genuinely
	 * changed then, and no reset is licensed.
	 */
	async #absorbedIntoBase(input: {
		worktree: string;
		base: string;
		local: string;
		remote: string;
	}): Promise<{ proven: true; id: string } | { proven: false; why: string }> {
		const { worktree, base, local, remote } = input;
		// The base tip comes from **origin itself**, exactly as the branch tip does
		// (cp-vk1, cp-p0r): a proof that read `refs/remotes/origin/<base>` would
		// reintroduce the bug PR #71 fixed, one question over, and would be worth
		// less than no proof at all — it decides whether work is discarded.
		const tip = await this.#run(worktree, "git", ["ls-remote", "--heads", "origin", base]);
		const baseTip = hexSha(tip.stdout.trim().split(/\s+/)[0] ?? "");
		if (tip.status !== 0 || !baseTip) {
			return { proven: false, why: `origin did not name a tip for ${base}, so there is nothing to prove it against` };
		}
		// The base's objects have to be present locally for `merge-base` to answer.
		// Asked after ls-remote on purpose: a base that moves in between is fetched
		// *ahead* of the sha being proven against, which keeps that sha resolvable.
		const fetched = await this.#run(worktree, "git", ["fetch", "origin", base]);
		if (fetched.status !== 0) {
			return { proven: false, why: `${base} could not be fetched from origin (${firstLine(fetched)})` };
		}
		const mine = await this.#cumulativePatchId(worktree, baseTip, local);
		if (!mine.id) return { proven: false, why: mine.why ?? "the worktree's cumulative diff could not be identified" };
		const theirs = await this.#cumulativePatchId(worktree, baseTip, remote);
		if (!theirs.id) return { proven: false, why: theirs.why ?? "origin's cumulative diff could not be identified" };
		if (mine.id !== theirs.id) {
			return {
				proven: false,
				why:
					`the worktree's cumulative diff (patch-id ${mine.id.slice(0, 12)}) is not the one origin's tip carries ` +
					`(${theirs.id.slice(0, 12)})`,
			};
		}
		return { proven: true, id: mine.id };
	}

	/** `git diff <merge-base(base, rev)> <rev> | git patch-id --stable`, or why not. */
	async #cumulativePatchId(worktree: string, baseTip: string, rev: string): Promise<{ id?: string; why?: string }> {
		const mergeBase = await this.#run(worktree, "git", ["merge-base", baseTip, rev]);
		const anchor = hexSha(mergeBase.stdout.trim().split(/\s+/)[0] ?? "");
		if (mergeBase.status !== 0 || !anchor) {
			return { why: `${rev.slice(0, 12)} and the tip origin names for the base share no readable merge base` };
		}
		// Every flag here removes a way the diff could describe something other than
		// the bytes: no colour, no external driver, no textconv (which can hide a
		// file's real content), no rename detection (config-dependent), and `--binary`
		// so a binary change is a delta in the patch rather than "files differ".
		const diff = await this.#run(worktree, "git", [
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--binary",
			anchor,
			rev,
		]);
		if (diff.status !== 0) {
			return { why: `the cumulative diff of ${rev.slice(0, 12)} could not be read (${firstLine(diff)})` };
		}
		if (diff.stdout.trim().length === 0) {
			// Two empty diffs are trivially equal and prove nothing about the commits
			// between them, so an empty one is never half of a proof.
			return { why: `${rev.slice(0, 12)} has an empty cumulative diff against the base, which proves nothing` };
		}
		const patchId = await this.#run(worktree, "git", ["patch-id", "--stable"], { stdin: diff.stdout });
		const id = hexSha(patchId.stdout.trim().split(/\s+/)[0] ?? "");
		if (patchId.status !== 0 || !id) {
			return { why: `git patch-id gave no id for the cumulative diff of ${rev.slice(0, 12)}` };
		}
		return { id };
	}

	/**
	 * Keep the head about to be discarded on a ref, so a wrong proof is undoable.
	 * Pruned only by `#pruneSalvageRefs`, and only once the commit is provably
	 * reachable from the base (cp-wcy5).
	 */
	async #salvageRef(worktree: string, jobId: string, head: string): Promise<{ ref?: string; why?: string }> {
		// `:` is not legal in a ref name, so the timestamp is dashed.
		const stamp = isoTimestamp(this.#now()).replaceAll(":", "-");
		const ref = `${SALVAGE_REF_PREFIX}${jobId}/${stamp}`;
		const written = await this.#run(worktree, "git", ["update-ref", ref, head]);
		if (written.status !== 0) return { why: firstLine(written) };
		return { ref };
	}

	/**
	 * The retention policy for `refs/cp-salvage/*` (cp-wcy5), run at the end of a
	 * successful integration — the same tool that wrote those refs, at the one
	 * moment the base has demonstrably moved.
	 *
	 * **The single rule: a rescue ref is deleted only once its commit is provably
	 * reachable from the tip origin names for the base.** Never on age, never on
	 * count, never on a timer. The ref exists because a commit was discarded from
	 * a worktree; if it is not reachable from somewhere else, that ref may be the
	 * only thing keeping it alive, and deleting it would be the one operation in
	 * this system that destroys work — the same asymmetry `#syncWorktree` is built
	 * around. `SALVAGE_PRUNE_MAX` bounds the work per call and nothing else: the
	 * listing is sorted by refname, so the refs beyond it are kept and are the
	 * same remainder the next integration examines first. So this is deliberately
	 * a *policy that usually keeps*: in a
	 * squash-merge repository a pre-rebase head is never an ancestor of the base,
	 * so the refs the 2026-09-01 shape produces are kept and **reported**, not
	 * quietly deleted. What is bounded is the litter that is provably redundant.
	 *
	 * Why here and not in `/doctor`: this is the writer's own scope, it already
	 * holds the job's base and its clone, it runs exactly once per merge (no
	 * timer, no sweep), and its facts land in the integration record and the run
	 * log the parent already relays. `/doctor` would have to re-derive the base
	 * and would report a deletion nobody asked for at a moment nothing changed.
	 *
	 * Every question is the authoritative one, and every unreadable answer keeps
	 * the ref:
	 *
	 *  - the base tip comes from **origin itself** (`git ls-remote`), never
	 *    `origin/<base>` — PR #71 (cp-p0r) and PR #85 (cp-uv5) are exactly this
	 *    lesson, and here it decides whether a rescue ref is destroyed;
	 *  - reachability is `git merge-base --is-ancestor <ref sha> <base tip>`;
	 *    exit 0 prunes, exit 1 keeps, and **any other exit keeps** — an
	 *    unanswerable question is not permission;
	 *  - the delete is `git update-ref -d <ref> <sha>`, which git applies only if
	 *    the ref still points at the sha that was proven, so a ref another lease
	 *    moved in between is not deleted on a stale proof;
	 *  - only names under `refs/cp-salvage/` are ever passed to a delete, checked
	 *    in code (`isSalvageRef`) after `for-each-ref` already scoped the listing.
	 */
	async #pruneSalvageRefs(input: { cwd: string; base: string; jobId: string }): Promise<string[]> {
		const { cwd, base, jobId } = input;
		// `--sort=refname` is not cosmetic: the bound below is a slice, so the
		// listing has to be deterministic for "the remainder is examined next time"
		// to mean anything. Refname order is `<job-id>/<utc>`, which is stable across
		// calls and independent of how git happens to store the refs.
		const listed = await this.#run(cwd, "git", [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"--sort=refname",
			SALVAGE_REF_PREFIX,
		]);
		if (listed.status !== 0) {
			return [`rescue refs under ${SALVAGE_REF_PREFIX} could not be listed (${firstLine(listed)}), so none was pruned`];
		}
		const all = listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				const [ref, objectName] = line.split(/\s+/);
				return { ref: ref ?? "", sha: hexSha(objectName) };
			})
			.filter((entry): entry is { ref: string; sha: string } => isSalvageRef(entry.ref) && entry.sha !== undefined);
		if (all.length === 0) return [];
		// A bound on the work, never on the retention: the overflow is kept, and
		// because the listing is sorted by refname it is the same remainder the next
		// integration examines — first, and minus whatever it prunes.
		const refs = all.slice(0, SALVAGE_PRUNE_MAX);
		const overflow = all.length - refs.length;

		// The base tip, from origin itself. An unreadable answer keeps everything —
		// the same fail-closed shape as the proof that wrote these refs.
		const tip = await this.#run(cwd, "git", ["ls-remote", "--heads", "origin", base]);
		const baseTip = hexSha(tip.stdout.trim().split(/\s+/)[0] ?? "");
		if (tip.status !== 0 || !baseTip) {
			return [
				`${all.length} rescue ref(s) kept — origin did not name a tip for ${base}, so nothing under ` +
					`${SALVAGE_REF_PREFIX} could be proven reachable and nothing was deleted`,
			];
		}
		// The tip's objects have to be here for `merge-base` to answer; fetched after
		// ls-remote, for the same reason the proof does it in that order.
		const fetched = await this.#run(cwd, "git", ["fetch", "origin", base]);
		if (fetched.status !== 0) {
			return [
				`${all.length} rescue ref(s) kept — ${base} could not be fetched from origin (${firstLine(fetched)}), ` +
					"so reachability could not be established",
			];
		}

		const pruned: string[] = [];
		const kept: string[] = [];
		for (const { ref, sha } of refs) {
			const reachable = await this.#run(cwd, "git", ["merge-base", "--is-ancestor", sha, baseTip]);
			if (reachable.status === 1) {
				kept.push(`${ref} (${sha.slice(0, 12)} is not reachable from ${base})`);
				continue;
			}
			if (reachable.status !== 0) {
				kept.push(`${ref} (reachability could not be read: ${firstLine(reachable)})`);
				continue;
			}
			// Bound to the sha that was proven: git refuses the delete if the ref moved.
			const deleted = await this.#run(cwd, "git", ["update-ref", "-d", ref, sha]);
			if (deleted.status !== 0) {
				kept.push(`${ref} (it could not be deleted: ${firstLine(deleted)})`);
				continue;
			}
			pruned.push(`${ref} -> ${sha.slice(0, 12)}`);
		}

		const facts: string[] = [];
		if (pruned.length > 0) {
			facts.push(
				`${pruned.length} rescue ref(s) pruned — each commit is an ancestor of ${baseTip.slice(0, 12)}, the sha ` +
					`origin names for ${base}: ${pruned.join(", ")}`,
			);
		}
		if (kept.length > 0) {
			facts.push(
				`${kept.length} rescue ref(s) kept — a discarded commit that is not reachable elsewhere may exist only on ` +
					`its rescue ref: ${kept.join(", ")}`,
			);
		}
		if (overflow > 0) {
			facts.push(`${overflow} further rescue ref(s) were not examined this call (bound ${SALVAGE_PRUNE_MAX}) and are kept`);
		}
		if (pruned.length > 0 || kept.length > 0) {
			this.#event(jobId, "integration_advanced", {
				step: "prune_salvage",
				base,
				base_tip: baseTip,
				pruned,
				kept,
				not_examined: overflow,
			});
		}
		return facts;
	}

	/**
	 * A half-finished rebase or merge in the leased worktree. Never automated
	 * over — the same hazard `src/revive.ts` refuses to relaunch through.
	 *
	 * The git directory is resolved rather than assumed: a treehouse worktree's
	 * `.git` is a **file** holding `gitdir: <path>`, so looking for
	 * `<worktree>/.git/rebase-merge` would silently find nothing in exactly the
	 * layout every job actually runs in.
	 */
	async #worktreeHazard(worktree: string): Promise<string | undefined> {
		const gitDir = resolveGitDir(worktree);
		if (!gitDir) return undefined;
		for (const [entry, what] of [
			["rebase-merge", "an interactive rebase is in progress"],
			["rebase-apply", "a rebase is in progress"],
			["MERGE_HEAD", "a merge is in progress"],
			["CHERRY_PICK_HEAD", "a cherry-pick is in progress"],
		] as const) {
			if (existsSync(join(gitDir, entry))) return `${what} in ${worktree}`;
		}
		return undefined;
	}

	// -- record ---------------------------------------------------------------

	#write(input: {
		jobId: string;
		branch: string;
		step: IntegrationStep;
		next: IntegrationNext;
		facts: string[];
		reason: string;
		prUrl?: string;
		headSha?: string;
		approvedHead?: string;
		mergeAuthority?: MergeAuthority;
		merge?: RecordMergeResult;
		teardown?: TeardownResult;
		resolveReceipt?: string;
		resolveError?: string;
		bumpResolve?: boolean;
		endState?: EndState;
	}): IntegrateResult {
		const prior = this.get(input.jobId);
		const at = isoTimestamp(this.#now());
		const facts = input.facts.slice(-20).map((fact) => fact.slice(0, 400));
		const record: IntegrationRecord = {
			schema_version: SCHEMA_VERSION,
			job_id: input.jobId,
			branch: input.branch,
			step: input.step,
			next: input.next,
			...(input.prUrl ? { pr_url: input.prUrl } : {}),
			...(input.headSha ? { head_sha: input.headSha } : {}),
			...(input.approvedHead ?? prior?.approved_head ? { approved_head: input.approvedHead ?? prior?.approved_head } : {}),
			...(input.mergeAuthority ?? prior?.merge_authority ? { merge_authority: input.mergeAuthority ?? prior?.merge_authority } : {}),
			resolve_attempts: Math.min((prior?.resolve_attempts ?? 0) + (input.bumpResolve ? 1 : 0), 20),
			facts: facts.length > 0 ? facts : ["no facts recorded"],
			reason: input.reason.slice(0, 600),
			started_at: prior?.started_at ?? at,
			updated_at: at,
		};
		const parsed = validate<IntegrationRecord>(IntegrationRecordSchema, record);
		if (!parsed.ok) {
			throw new IntegrateError(`refusing to write an invalid integration record for ${input.jobId}:\n  ${parsed.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file(input.jobId), parsed.value);
		if (input.next === "surface") {
			this.#event(input.jobId, "integration_surfaced", { step: input.step, reason: parsed.value.reason });
		}
		return {
			job_id: input.jobId,
			branch: input.branch,
			step: input.step,
			next: input.next,
			facts: parsed.value.facts,
			reason: parsed.value.reason,
			record: parsed.value,
			...(input.prUrl ? { pr_url: input.prUrl } : {}),
			...(input.headSha ? { head_sha: input.headSha } : {}),
			...(input.merge ? { merge: input.merge } : {}),
			...(input.teardown ? { teardown: input.teardown } : {}),
			...(input.resolveReceipt ? { resolve_receipt: input.resolveReceipt } : {}),
			...(input.resolveError ? { resolve_error: input.resolveError } : {}),
			...(input.endState ? { end_state: input.endState } : {}),
		};
	}

	#checkpoints(): CheckpointStore {
		return new CheckpointStore(this.#options.home, { kind: "merge" });
	}

	#event(
		jobId: string,
		kind: "integration_advanced" | "integration_surfaced" | "integration_permitted",
		payload: Record<string, unknown>,
	): void {
		try {
			this.#options.runs?.open(jobId).cp(kind, { job_id: jobId, ...payload });
		} catch {
			// A run log that cannot be written must never fail a merge that happened.
		}
	}

	#held(jobId: string, branch: string): IntegrateResult | undefined {
		let reason: string;
		try {
			const hold = new IntegrationHolds(this.#options.home).get(jobId);
			if (!hold) return undefined;
			reason = `${jobId}: integration held: ${hold.reason}. Release the hold before continuing.`;
		} catch (error) {
			reason = `${jobId}: ${(error as Error).message}. Integration waits until the hold can be read or explicitly released.`;
		}
		return this.#write({ jobId, branch, step: "merge", next: "wait", facts: [reason], reason });
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	async #run(cwd: string, bin: string, args: readonly string[], options?: { stdin?: string }) {
		const custom = this.#options.run;
		if (custom) return custom(cwd, bin, args, options);
		return defaultRun(cwd, bin, args, options);
	}
}

// ---------------------------------------------------------------------------
// The promote texts — generated in code, never composed by a model
// ---------------------------------------------------------------------------

/**
 * The first line of any hand-back: **resync the clone**. A server-side rebase
 * (`gh pr update-branch`) advances `origin/<branch>` and leaves the worker's
 * own clone behind it, so a worker that rebases without resetting first will
 * conflict with its own already-rebased commits.
 */
function resyncPreamble(branch: string): string[] {
	return [
		`First, resync: \`git fetch origin && git reset --hard origin/${branch}\`. The branch was advanced on the server,`,
		"so your clone is behind origin and a rebase from where you are would conflict with your own commits.",
	];
}

/** A conflicting PR, handed back to the author who knows both sides. */
export function conflictMessage(input: { jobId: string; branch: string; prUrl: string; base: string }): string {
	return [
		`${input.jobId}: ${input.prUrl} conflicts with ${input.base} and cannot be merged.`,
		"",
		...resyncPreamble(input.branch),
		"",
		`Then \`git rebase origin/${input.base}\` and resolve the conflicts so **both sides survive**. Never weaken a test`,
		"or delete code to make a conflict go away; if you cannot keep both, stop and report blocked with the exact",
		"conflict and what you tried.",
		"",
		`Run the project's checks on the rebased tree, then \`git push --force-with-lease\` to ${input.branch} — never a`,
		"second PR, never a new branch. Reply with one line naming the new head sha.",
		"Your envelope slot was reopened when this was delivered, so you may call report_result once more.",
	].join("\n");
}

/** A red head, handed back. Never a merge, and never a merge ask (cp-gmy). */
export function ciFailedMessage(input: { jobId: string; branch: string; prUrl: string; reason: string }): string {
	return [
		`${input.jobId}: CI is red on the pushed head of ${input.prUrl} — ${input.reason}.`,
		"",
		...resyncPreamble(input.branch),
		"",
		"Then fix the cause on this same branch with one more commit, run the project's checks, and",
		"`git push --force-with-lease`. Do not wait for or poll CI: the parent verifies it against the sha you report.",
		"Reply with one line naming what you changed and the new head sha.",
		"Your envelope slot was reopened when this was delivered, so you may call report_result once more.",
	].join("\n");
}

/** One relayable block per call. Facts travel; a diff never does. */
export function formatIntegration(result: IntegrateResult): string {
	const lines = [`${result.job_id} integrate: ${result.step} -> ${result.next}`, `  ${result.reason}`];
	for (const fact of result.facts) lines.push(`  - ${fact}`);
	const authority = result.record.merge_authority;
	if (authority) {
		lines.push(
			`  authority: ${authority.kind}` +
				`${authority.merge_state_status ? ` (mergeStateStatus=${authority.merge_state_status})` : ""} at ${authority.head_sha.slice(0, 12)}`,
		);
	}
	if (result.end_state) {
		lines.push(
			`  end state: receipt=${result.end_state.merge_receipt} fleet_done=${result.end_state.fleet_done}` +
				`${result.end_state.closed_reason ? ` (${result.end_state.closed_reason})` : ""} br_closed=${result.end_state.br_closed}`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A checkpoint scope: 12 hex chars of the head sha, lower case. */
function scopeOf(headSha: string): string {
	return headSha.slice(0, 12);
}

/**
 * Is this a ref `cp_integrate`'s retention policy may delete? Only a name
 * strictly under `refs/cp-salvage/`, with no path traversal and no trailing
 * slash — the second guard behind `for-each-ref`'s own scoping, because the
 * argument to a delete must be checked by the code that issues it (cp-wcy5).
 */
export function isSalvageRef(ref: string): boolean {
	return (
		ref.startsWith(SALVAGE_REF_PREFIX) &&
		ref.length > SALVAGE_REF_PREFIX.length &&
		!ref.endsWith("/") &&
		!ref.includes("..") &&
		!/\s/.test(ref)
	);
}

/** A git object name, normalised, or `undefined` if it is not one. */
function hexSha(value: string | undefined): string | undefined {
	const sha = (value ?? "").trim().toLowerCase();
	return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
}

function safeParseRuns(stdout: string) {
	try {
		return parseCiRuns(stdout);
	} catch {
		return [];
	}
}

/** `AwaitingItem.decision` is bounded to `AWAITING_DECISION_MAX_CHARS` (100). */
function boundedDecision(text: string): string {
	return text.length <= AWAITING_DECISION_MAX_CHARS ? text : `${text.slice(0, AWAITING_DECISION_MAX_CHARS - 1)}…`;
}

function firstLine(result: { stdout: string; stderr: string }): string {
	return ((result.stderr || result.stdout).trim().split("\n")[0] ?? "no output").slice(0, 300);
}

function prUrlFromReceipts(receipts: readonly { kind: string; url?: string }[] | undefined): string | undefined {
	return (receipts ?? []).find((receipt) => receipt.kind === "pr" && receipt.url)?.url;
}

function isDirectory(path: string): boolean {
	try {
		return path.length > 0 && existsSync(path);
	} catch {
		return false;
	}
}

/**
 * The worktree's real git directory: `<worktree>/.git` when it is a directory,
 * and the path inside it when `.git` is the one-line `gitdir:` file every
 * linked worktree (i.e. every leased one) has. `undefined` when there is none.
 */
function resolveGitDir(worktree: string): string | undefined {
	if (!isDirectory(worktree)) return undefined;
	const dotGit = join(worktree, ".git");
	try {
		if (!existsSync(dotGit)) return undefined;
		if (statSync(dotGit).isDirectory()) return dotGit;
		const pointer = readFileSync(dotGit, "utf8").trim();
		const match = pointer.match(/^gitdir:\s*(.+)$/m);
		if (!match?.[1]) return undefined;
		const target = match[1].trim();
		return isAbsolute(target) ? target : join(worktree, target);
	} catch {
		return undefined;
	}
}

function defaultRun(cwd: string, bin: string, args: readonly string[], options?: { stdin?: string }) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
		const child = execFile(bin, [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const status = typeof error?.code === "number" ? error.code : error ? 1 : 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
		if (options?.stdin !== undefined) {
			// A child that exits before reading it all (or one that is not there at
			// all) must not turn into an unhandled EPIPE: the exit status is the
			// answer, and it arrives through the callback above either way.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.stdin);
		}
	});
}
