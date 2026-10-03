/**
 * Diff review — materialization (Stage A) plus the reviewer-spawn
 * orchestrator (Stage B1) of cp-diffgate-redo-hxb.
 *
 * `materializeDiff()` is a bounded, three-dot diff capture against the
 * canonical clone, per Constraints §2 of the design this implements.
 * `DiffReview` is the orchestrator around it, structurally parallel to `Gate`
 * (`src/gate.ts`):
 *
 *   reviewer OBSERVES  ->  parent DECIDES
 *
 * The subject is the only difference. `Gate` reviews a filed research
 * artifact before any code exists; `DiffReview` reviews the diff a pushed
 * ship branch actually introduces. Everything after the observation — a veto
 * flag is reported (`vetoFlags: []`; none force escalate), a revise with no
 * high/high finding is downgraded to pass (`highOnlyBar`), an exhausted revise budget is escalate/policy, no-verdict is operational then
 * operational_persistent, `cause` decides what happens next — is the same
 * policy, and it is the same code: `decideGate`, `nextAction`, `capPayload`,
 * `readPriorAttempts` and `awaitVerdict` are imported from `src/gate.ts`
 * verbatim (Constraints §3). This module defines no verdict ladder of its own,
 * and adding one here would be the fork the design exists to prevent.
 *
 * One thing about the *subject* changes how long the ladder runs, and it is
 * passed into the shared code rather than reimplemented beside it: a plan gate
 * spends one revise per artifact (`GATE_MAX_REVISE`), while a ship branch is
 * reviewed until a review comes back with no unfixed findings, bounded at
 * `REVIEW_MAX_ATTEMPTS` reviews per branch (`reviewCapExhausted` is handed to
 * `readPriorAttempts`; the cap's wording is handed to `decideGate`). The last
 * permitted review never delivers another revise, and a review past the cap is
 * refused before any diff is materialized.
 *
 * What is genuinely different, and therefore lives here:
 *
 *  - the subject is a git fact, not `artifacts.has(jobId)`: the preconditions
 *    are a dispatch record, `kind:ship`, and `origin/<branch>` resolving in
 *    the canonical clone;
 *  - the diff is regenerated per attempt from `projects/<name>` — never the
 *    leased worktree, which teardown recycles the instant it is returned;
 *  - a `stat_overflow` is decided by the orchestrator with no model call at
 *    all (`escalate`/`policy`);
 *  - a `revise` promotes the live **implementer** for a fix commit on the
 *    same branch, never a second PR;
 *  - the persisted decision is a `DiffVerdict` (`head_sha` + `diff_stat`), so
 *    "has the code changed since this verdict" is answerable later.
 *
 * The diff body never leaves this module: the verdict is the interface. No
 * result field, run-log payload or promote message carries diff text — only
 * paths, counts and the reviewer's own bounded reasons.
 *
 * Source of the diff: the caller's `cwd` — the canonical project clone
 * (`projects/<name>`), fetched fresh for `branch` by the caller before this
 * runs, never the ephemeral worktree (the worktree is a lease recycled the
 * instant `cp_teardown` returns it).
 *
 * Diff shape: three-dot (merge-base), matching what a PR view shows —
 * `git diff origin/<base>...origin/<branch>` — never the two-dot form
 * `Teardown.#mergedAndAbsorbed` uses for its own, different question ("does
 * base already contain this content").
 *
 * `<base>` is re-derived with `resolveDefaultBase` (the same rule
 * `Teardown`/`Preflight` already use), not read from any persisted field:
 * neither `FleetRecordSchema` nor `PipelineRecordSchema` carries a `base`,
 * and `Project.base_branch` is genuinely decorative today (only
 * `formatProjects()` reads it) — see the design's Constraints §2 for why.
 *
 * Bounding, in this exact order:
 *  1. `git diff --name-status <range>` captured first, always, in full.
 *     Counted against `maxStatFiles` (default `DIFF_REVIEW_MAX_STAT_FILES`)
 *     BEFORE any hunk is captured. Over the cap: no diff is written and no
 *     reviewer should be spawned — the caller gets `{ ok: false, reason:
 *     "stat_overflow" }` and is expected to record that as an orchestrator-
 *     decided `escalate`/`policy`, never a model call.
 *  2. Within the cap: the full `--stat` block (never truncated) plus the
 *     full hunks for as many files as fit within `maxBytes` (default
 *     `DIFF_REVIEW_MAX_BYTES`), accumulated file-by-file in the order git
 *     reports them, never mid-hunk. Anything that does not fit is named,
 *     by path, in an explicit "Omitted" section — nothing is silently
 *     hidden.
 */

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CapacityReader } from "./capacity.ts";
import { dirname, join } from "node:path";
import {
	type Delivery,
	DIFF_REVIEW_MAX_BYTES,
	DIFF_REVIEW_MAX_STAT_FILES,
	type DiffVerdict,
	DiffVerdictSchema,
	type FleetRecord,
	type GateFlags,
	type GateReview,
	isoTimestamp,
	LAYOUT,
	paths,
	type PendingReview,
	REVIEW_MAX_ATTEMPTS,
	type RoutingConfig,
	SCHEMA_VERSION,
	type SendReceipt,
	validate,
	type WorkerProfile,
} from "./contracts.ts";
import { type GitRunner, resolveDefaultBase } from "./default-base.ts";
import type { FleetStore } from "./fleet.ts";
import {
	awaitVerdict, capPayload, copyOriginalTask, decideGate, type GateNext, nextAction, type PriorAttempts, NO_FLAGS,
	readPriorAttempts, resolveReviewTimeoutMs, reviewCapExhausted, reviewCapReason,
} from "./gate.ts";
import { requestFinalFix } from "./final-fix.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { MandateStore } from "./mandate.ts";
import { assertReviewAllowed } from "./mandate-usage.ts";
import { incompleteSubjectReasons, isCompletePass } from "./review-subject.ts";
import { assembleBrief, profileForRole, readBriefTemplate } from "./profiles.ts";
import { ProjectRegistry } from "./projects.ts";
import { type ModelProbe, resolveWithCapacity, type ReviewerRoute, reviewerRoutingEvent, reviewerRoutingInputs } from "./routing.ts";
import { RunRecorder } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import type { Sender } from "./send.ts";
import { ReviewRunsError, type ReviewRuns, type ReviewWait, type ReviewWakeup } from "./review-runs.ts";
import { taskAddendaBlock } from "./task-addenda.ts";
import type { WorkerManager } from "./worker-manager.ts";

export class DiffReviewError extends Error {}

export interface MaterializeDiffRequest {
	/** The canonical clone, already fetched for `branch`. Never the worktree. */
	cwd: string;
	/** The pushed branch under review. */
	branch: string;
	/** Override; defaults to `resolveDefaultBase(git, cwd)`. */
	base?: string;
	/** Review only commits after this prior head; absent means the full branch diff. */
	from?: string;
	/** Absolute path the materialized diff file is written to. */
	out: string;
	git?: GitRunner;
	maxStatFiles?: number;
	maxBytes?: number;
}

export type MaterializeDiffResult =
	| {
			ok: true;
			path: string;
			base: string;
			/** Total file count from the (untruncated) stat block. */
			files: number;
			/** True when one or more files' hunks were omitted for byte budget. */
			truncated: boolean;
			omitted: string[];
	  }
	| {
			/** Orchestrator-decided: the stat overflowed before any hunk was captured. */
			ok: false;
			reason: "stat_overflow";
			base: string;
			files: number;
			cap: number;
	  };

export async function materializeDiff(request: MaterializeDiffRequest): Promise<MaterializeDiffResult> {
	const git = request.git ?? defaultGit;
	const maxStatFiles = request.maxStatFiles ?? DIFF_REVIEW_MAX_STAT_FILES;
	const maxBytes = request.maxBytes ?? DIFF_REVIEW_MAX_BYTES;
	const base = request.base ?? (await resolveDefaultBase(git, request.cwd));
	const range = request.from ? `${request.from}..origin/${request.branch}` : `origin/${base}...origin/${request.branch}`;

	const nameStatus = await git(request.cwd, ["-c", "core.quotePath=false", "diff", "--name-status", range]);
	if (nameStatus.status !== 0) {
		throw new DiffReviewError(
			`git diff --name-status ${range} failed in ${request.cwd}: ${nameStatus.stderr.trim() || "no output"}`,
		);
	}
	const files = nameStatus.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.split(/\t+/).pop() ?? line);

	if (files.length > maxStatFiles) {
		return { ok: false, reason: "stat_overflow", base, files: files.length, cap: maxStatFiles };
	}

	const statBlock = await git(request.cwd, ["-c", "core.quotePath=false", "diff", "--stat", range]);
	if (statBlock.status !== 0) {
		throw new DiffReviewError(`git diff --stat ${range} failed in ${request.cwd}: ${statBlock.stderr.trim() || "no output"}`);
	}

	const fullDiff = await git(request.cwd, ["-c", "core.quotePath=false", "diff", range]);
	if (fullDiff.status !== 0) {
		throw new DiffReviewError(`git diff ${range} failed in ${request.cwd}: ${fullDiff.stderr.trim() || "no output"}`);
	}

	const perFile = splitByFile(fullDiff.stdout);
	const omitted: string[] = [];
	const bodyParts: string[] = [];
	let used = 0;
	for (const path of files) {
		const hunk = perFile.get(path);
		// Every change has a header; a listed path with none parsed (a quoted name) was not shown: omitted.
		const size = hunk === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(hunk, "utf8");
		if (hunk !== undefined && used + size <= maxBytes) {
			bodyParts.push(hunk);
			used += size;
		} else {
			omitted.push(path);
		}
	}

	const sections = [
		`# Diff review materialization — ${request.branch} ${request.from ? `since ${request.from}` : `vs origin/${base}`}`,
		"",
		`## Stat (${files.length} file(s), full and untruncated)`,
		"",
		statBlock.stdout.trimEnd(),
		"",
		"## Hunks",
		"",
		...bodyParts,
	];
	if (omitted.length > 0) {
		sections.push(
			"",
			"## Omitted (listed in the stat above but not shown in full — byte budget exceeded)",
			"",
			...omitted.map((path) => `- ${path}`),
		);
	}
	const body = sections.join("\n");

	mkdirSync(dirname(request.out), { recursive: true });
	writeFileSync(request.out, body.endsWith("\n") ? body : `${body}\n`);

	return { ok: true, path: request.out, base, files: files.length, truncated: omitted.length > 0, omitted };
}

/** Split a unified diff into per-file chunks, keyed by the header's "b/" path. */
function splitByFile(diffText: string): Map<string, string> {
	const map = new Map<string, string>();
	if (diffText.length === 0) return map;
	const lines = diffText.split("\n");
	let current: string | undefined;
	let buf: string[] = [];
	const flush = () => {
		if (current !== undefined) map.set(current, `${buf.join("\n")}\n`);
	};
	for (const line of lines) {
		const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (match) {
			flush();
			current = match[2];
			buf = [line];
		} else {
			buf.push(line);
		}
	}
	flush();
	return map;
}

function latestContentReview(home: string, jobId: string, decisions: readonly unknown[]): DiffVerdict | undefined {
	const verdicts = decisions.map((decision) => decision as DiffVerdict);
	try {
		for (const name of readdirSync(join(home, paths.runDir(jobId)))) {
			if (!name.startsWith("review-equivalent-") || !name.endsWith(".json")) continue;
			try {
				const parsed = validate<DiffVerdict>(
					DiffVerdictSchema,
					JSON.parse(readFileSync(join(home, paths.runDir(jobId), name), "utf8")),
				);
				if (parsed.ok) verdicts.push(parsed.value);
			} catch {}
		}
	} catch {}
	return verdicts
		.filter((verdict) => (verdict.verdict === "pass" || verdict.verdict === "revise") && !verdict.diff_stat.truncated)
		.sort((a, b) => a.decided_at.localeCompare(b.decided_at))
		.at(-1);
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A prior head is a delta baseline only along the branch's own history: an ancestor of the
 * pushed head with the same fork point from the base. A rebase breaks ancestry; merging the base
 * moves the fork point, and either would put upstream changes in a two-dot delta. Any git failure
 * or malformed sha means no delta: the full three-dot subject is reviewed. */
async function deltaBaselineHolds(git: GitRunner, cwd: string, base: string, branch: string, previousHead: string): Promise<boolean> {
	if (!SHA.test(previousHead)) return false;
	const head = `refs/remotes/origin/${branch}`;
	if ((await git(cwd, ["merge-base", "--is-ancestor", previousHead, head])).status !== 0) return false;
	const forkPoint = async (rev: string): Promise<string | undefined> => {
		const result = await git(cwd, ["merge-base", "--all", `refs/remotes/origin/${base}`, rev]);
		const shas = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
		return result.status === 0 && shas.length > 0 && shas.every((sha) => SHA.test(sha)) ? shas.join(" ") : undefined;
	};
	const before = await forkPoint(previousHead);
	return before !== undefined && before === (await forkPoint(head));
}

async function patchId(cwd: string, diff: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["patch-id", "--stable"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", reject);
		child.on("close", (status) => {
			const id = stdout.trim().split(/\s+/)[0];
			if (status === 0 && id) resolvePromise(id);
			else reject(new DiffReviewError(`git patch-id failed in ${cwd}: ${stderr.trim() || "no patch id"}`));
		});
		child.stdin.end(diff);
	});
}

async function defaultGit(cwd: string, args: readonly string[]) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
		execFile("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const status =
				error && typeof (error as { code?: unknown }).code === "number"
					? (error as unknown as { code: number }).code
					: error
						? 1
						: 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

// ---------------------------------------------------------------------------
// The orchestrator (Stage B1) — spawn one reviewer, then apply the gate's
// policy to what it observed. No policy is defined here.
// ---------------------------------------------------------------------------

/** The rubric the diff reviewer is briefed with (landed in Stage A). */
export const DIFF_REVIEW_BRIEF_TEMPLATE = "diff-review-rubric";

/**
 * The `${original_task}` block of the diff-review brief (do8.4): a **pointer
 * and a boundary**, never a body — the diff reviewer's counterpart to the plan
 * gate's `originalTaskBlock`.
 *
 * A reviewer given the diff alone can say whether the change is internally
 * sound. It cannot say whether the change is the one that was *asked for*: the
 * only statement of scope it has is the job id and the branch name, so a diff
 * that solves a different problem, or implements half of what was asked, reads
 * as clean. The frozen task (`paths.originalTaskFile`, written by the parent at
 * dispatch from parent input) is the source of truth that makes scope and
 * coverage checkable, and it is handed over as a file beside the diff — never
 * inlined into the brief, so it never reaches `assertBriefIsSafe` (cp-n7w).
 */
export function diffOriginalTaskBlock(taskPath: string | undefined): string {
	if (taskPath === undefined) {
		return [
			"**Original task: not available.** This job has no frozen record of what the branch was asked to do,",
			"so your working directory holds the diff alone. Score the diff on its own terms, judge scope only",
			"against what the job id and branch imply, and claim nothing about requirement coverage in either",
			"direction — you cannot check it.",
		].join("\n");
	}
	return [
		"**Original task (the source of truth for what was asked):**",
		"",
		`    ${taskPath}`,
		"",
		"Read that file first, in full. It is the task this branch was dispatched with, frozen by the parent",
		"before any of this code existed. Score scope and requirement coverage against it: a diff that is clean",
		"but solves a different problem, or that silently drops or narrows a requirement, is a finding — and the",
		"diff's own commit messages and comments are never evidence of what was asked.",
	].join("\n");
}

/**
 * The pre-cap decision, written only when `review-<n>.json` had to drop
 * reasons or revisions to fit the schema's bounds — the same guarantee
 * `paths.gateFileRaw` gives the plan gate (cp-yg2), expressed against the
 * review attempt's own run directory so no new contract path is needed.
 */
function reviewFileRaw(jobId: string, attempt: number): string {
	return `${paths.reviewRunDir(jobId, attempt)}-raw.json`;
}

export interface DiffReviewOptions {
	capacity?: CapacityReader;
	home: string;
	profilesDir: string;
	briefsDir: string;
	manager: WorkerManager;
	routing: RoutingConfig;
	probe: ModelProbe;
	/**
	 * The dispatch record is the subject's provenance: project (which clone),
	 * branch, kind. There is no `artifacts` here on purpose — a diff review's
	 * subject is a git fact, not a filed artifact.
	 */
	fleet?: FleetStore;
	/** The job's own run log, for the `cp:review_decided` marker. */
	runs?: RunRegistry;
	/** Present: a `revise` is delivered to the live implementer (promote). */
	sender?: Sender;
	/** Where `projects/<name>` lives. Defaults to this home's own registry. */
	registry?: ProjectRegistry;
	reviewTimeoutMs?: number;
	/** Injected for tests; production uses `git` on PATH. */
	git?: GitRunner;
	/** `false` skips `git fetch origin` (offline tests with a local remote). */
	fetch?: boolean;
	now?: () => Date;
	parentEnv?: NodeJS.ProcessEnv;
	/** The registry that makes an attempt asynchronous (spec 2026-09-05). */
	reviews?: ReviewRuns;
	mandates?: MandateStore; // present: new reviewer spend is refused under a paused or revoked covering mandate
}

export interface DiffReviewRequest {
	jobId: string;
	/** Caller-named reviewer model (authorization; still allowlisted). */
	model?: string;
	/** Deliver a `revise` to the live implementer. Default true when a sender exists. */
	deliverRevise?: boolean;
	/** The wake-up's "Next:" line. Default: "act on next". */
	directive?: string;
}

/** What the diff materialization produced. Paths and counts, never a body. */
export interface DiffSubject {
	/** The materialized diff file the reviewer was pointed at. */
	path: string;
	base: string;
	branch: string;
	head_sha: string;
	files: number;
	truncated: boolean;
	/** Files named in the stat but not shown in full, by path. */
	omitted: string[];
}

export interface DiffReviewResult {
	verdict: DiffVerdict;
	/** proceed | revise | retry (different model) | surface (stop looping). */
	next: GateNext;
	/** `state/runs/<job-id>/review-<attempt>.json`. */
	path: string;
	/** Absent when no reviewer was spawned (a stat overflow decides itself). */
	model?: string;
	/** The reviewer's raw observation, when there was one. */
	review?: GateReview;
	/** The subject, when one was materialized. */
	diff?: DiffSubject;
	/** Set when a `revise` was pushed to the still-live implementer. */
	revise_receipt?: SendReceipt;
	revise_error?: string;
}

/** `cp_review` returned before the verdict exists (spec 2026-09-05). */
export interface DiffReviewWait extends ReviewWait {
	surface: "review";
	head_sha: string;
}
export type DiffReviewStart = DiffReviewResult | DiffReviewWait;
export function isDiffReviewWait(value: DiffReviewStart): value is DiffReviewWait {
	return (value as DiffReviewWait).next === "wait" && (value as DiffReviewWait).surface === "review";
}

/**
 * One diff review attempt, end to end.
 *
 * Deliberately NOT a subclass of `Gate` and deliberately not a copy of it: the
 * shared half is imported (policy, attempt bookkeeping, the verdict wait), and
 * only the subject differs.
 */
export class DiffReview {
	readonly #options: DiffReviewOptions;
	/** See `Gate.#finished`: the blocking test helper's view of one attempt. */
	readonly #finished = new Map<number, DiffReviewResult>();

	constructor(options: DiffReviewOptions) {
		this.#options = options;
	}

	async start(request: DiffReviewRequest): Promise<DiffReviewStart> {
		const { home, manager } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const jobId = request.jobId;
		const git = this.#options.git ?? defaultGit;

		// 1. Preconditions. Each refusal names the fix; none of them is a verdict,
		// because there is nothing to have an opinion about yet.
		const record = this.#options.fleet?.get(jobId);
		if (!record) {
			throw new DiffReviewError(
				`no dispatch record for ${jobId} — cannot review. A diff review reads the job's project, branch and kind ` +
					`from its fleet record; dispatch the job first (cp_dispatch), then review the branch it pushed.`,
			);
		}
		if (record.kind !== "ship") {
			throw new DiffReviewError(
				`${jobId} is kind:${record.kind} — cannot review a diff for a job that changes no code. ` +
					`Only a ship job pushes a branch; gate a research artifact with cp_gate instead.`,
			);
		}
		const branch = record.branch;
		const clone = await this.#clone(record.project);
		if (this.#options.fetch !== false) {
			const fetched = await git(clone, ["fetch", "origin"]);
			if (fetched.status !== 0) {
				throw new DiffReviewError(
					`git fetch origin failed in ${clone}: ${fetched.stderr.trim() || "no output"} — cannot review. ` +
						`Fix the clone's origin remote (git -C ${clone} remote -v), then review again.`,
				);
			}
		}
		const remote = await git(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
		const headSha = remote.stdout.trim();
		if (remote.status !== 0 || headSha.length === 0) {
			throw new DiffReviewError(
				`branch not pushed — cannot review: origin/${branch} does not resolve in ${clone}. ` +
					`Push the branch from the worktree (git push -u origin ${branch}) — the leased worktree is recycled at ` +
					`teardown, so a review always reads the canonical clone — then review again.`,
			);
		}

		// 2. Attempt bookkeeping, from disk: the review cap survives a restart.
		// `capExhausted` is this subject's rule (reviews per branch), not the plan
		// gate's (revises per artifact) — same reader, same ladder, different budget.
		const inFlight = this.#options.reviews?.pending(jobId, "review");
		if (inFlight) {
			throw new ReviewRunsError(
				`${jobId} already has a diff review in flight on ${inFlight.subject?.head_sha ?? "unknown head"} (attempt ${inFlight.attempt}, started ${inFlight.started_at}) — ` +
					"wait for its cp-verdict wake-up instead of starting another; do not re-issue",
				inFlight,
			);
		}
		const prior = readPriorAttempts(home, jobId, paths.reviewFile, DiffVerdictSchema, {
			capExhausted: reviewCapExhausted,
		});
		const attempt = prior.attempt;
		if (attempt > REVIEW_MAX_ATTEMPTS) {
			throw new DiffReviewError(
				`${jobId} has already had ${prior.decisions.length} diff reviews on ${branch} — the cap is ` +
					`${REVIEW_MAX_ATTEMPTS} per branch (REVIEW_MAX_ATTEMPTS) and review ${REVIEW_MAX_ATTEMPTS} already ` +
					`surfaced to the operator. Reviewing again would loop: this is the operator's call now — read ` +
					`${paths.reviewFile(jobId, prior.decisions.length)} for the last verdict, then accept the diff, ` +
					`hand the branch back with a scope decision, answer its one final-fix checkpoint, or drop it.`,
			);
		}
		const base = await resolveDefaultBase(git, clone);
		const fullRange = `origin/${base}...origin/${branch}`;
		const full = await git(clone, ["diff", fullRange]);
		if (full.status !== 0) throw new DiffReviewError(`git diff ${fullRange} failed in ${clone}: ${full.stderr.trim() || "no output"}`);
		const currentPatchId = await patchId(clone, full.stdout);
		const priorPass = prior.decisions
			.map((decision) => decision as DiffVerdict)
			.findLast((decision) => isCompletePass(decision) && decision.patch_id === currentPatchId);
		if (priorPass) {
			const verdict: DiffVerdict = {
				...priorPass,
				head_sha: headSha,
				decided_at: isoTimestamp(now()),
				equivalent_to: { head_sha: priorPass.head_sha, attempt: priorPass.attempt },
			};
			return this.#persist({ jobId, attempt: priorPass.attempt, verdict, equivalence: true });
		}
		const last = prior.decisions.at(-1) as DiffVerdict | undefined;
		// The orchestrator's own incomplete-subject stop: the same head is the same subject, never re-spent.
		if (last?.head_sha === headSha && last.cause === "policy" && last.diff_stat.truncated && !last.model) {
			return { verdict: last, next: nextAction(last), path: join(home, paths.reviewFile(jobId, last.attempt)) };
		}

		// Past here a reviewer may spawn: a paused or revoked covering grant refuses the spend (the free equivalence pass above stays).
		if (this.#options.mandates) assertReviewAllowed(this.#options.mandates, { jobId, project: record.project, kind: record.kind }, this.#options.fleet?.read().jobs ?? []);

		const previous = latestContentReview(home, jobId, prior.decisions);
		// Delta only along the branch's own history: a rebase or a merge of the base would carry upstream changes.
		const deltaFrom = previous && previous.head_sha !== headSha && (await deltaBaselineHolds(git, clone, base, branch, previous.head_sha))
			? previous.head_sha
			: undefined;
		const runDir = join(home, paths.reviewRunDir(jobId, attempt));
		const scratch = join(home, paths.reviewScratchDir(jobId, attempt));
		mkdirSync(scratch, { recursive: true });

		// 3. A changed head is reviewed as a delta. Keep the bounded full diff in
		// scratch so the reviewer can inspect it when prior findings make that necessary.
		const materialized = await materializeDiff({
			cwd: clone,
			branch,
			base,
			...(deltaFrom ? { from: deltaFrom } : {}),
			out: join(scratch, "diff.md"),
			...(this.#options.git ? { git: this.#options.git } : {}),
		});
		if (deltaFrom && previous) {
			await materializeDiff({
				cwd: clone,
				branch,
				base,
				out: join(scratch, "full-diff.md"),
				...(this.#options.git ? { git: this.#options.git } : {}),
			});
			writeFileSync(join(scratch, "prior-verdict.json"), `${JSON.stringify(previous, null, 2)}\n`);
		}

		// 4. An incomplete subject is decided here, with no model call at all: a stat
		// overflow, or hunks omitted for bytes. An omitted file is never review evidence.
		if (!materialized.ok || materialized.truncated) {
			const capped = capPayload(incompleteSubjectReasons(materialized), undefined);
			const verdict: DiffVerdict = {
				schema_version: SCHEMA_VERSION,
				job_id: jobId,
				attempt,
				verdict: "escalate",
				cause: "policy",
				flags: { ...NO_FLAGS },
				reasons: capped.reasons,
				decided_at: isoTimestamp(now()),
				head_sha: headSha,
				diff_stat: { files: materialized.files, truncated: true },
			};
			return this.#persist({ jobId, attempt, verdict, raw: capped.raw });
		}

		const diff: DiffSubject = {
			path: materialized.path,
			base: materialized.base,
			branch,
			head_sha: headSha,
			files: materialized.files,
			truncated: materialized.truncated,
			omitted: materialized.omitted,
		};

		// 5. One reviewer, a bounded packet, a scratch cwd that holds nothing else:
		// the materialized diff and — when the job has one — the frozen original
		// task it was dispatched with (do8.4). Both are files; neither is inlined.
		const taskCopy = copyOriginalTask({ home, jobId, scratch });
		const profile = profileForRole(this.#options.profilesDir, "gate-reviewer");
		const route = await this.#route(profile, jobId, record, request.model);
		const model = route.decision.model;
		const brief = assembleBrief({
			profile,
			template: readBriefTemplate(this.#options.briefsDir, DIFF_REVIEW_BRIEF_TEMPLATE),
			templatePath: DIFF_REVIEW_BRIEF_TEMPLATE,
			values: {
				job_id: jobId,
				project: record.project,
				branch,
				artifact_path: diff.path,
				original_task: diffOriginalTaskBlock(taskCopy) + taskAddendaBlock({ home, jobId, scratch }),
				review_context: deltaFrom && previous
					? `This is a delta review since ${deltaFrom}. Read prior-verdict.json first, then diff.md. The prior findings remain branch-wide evidence. If this delta touches or may invalidate one, read full-diff.md before deciding.`
					: "This is the first review on the branch; diff.md is the complete branch diff.",
			},
		});
		writeFileSync(join(runDir, "brief.md"), brief);

		const recorder = RunRecorder.open({ home, jobId, dir: runDir });
		// The decision this attempt is about to spawn, recorded once (cp-reviewer-routing).
		recorder.cp("routing_resolved", reviewerRoutingEvent({ surface: "review", attempt, ...route }));
		const key = `${jobId}#review-${attempt}`;
		const timeoutMs = this.#options.reviewTimeoutMs ?? resolveReviewTimeoutMs(home);
		const deadline = isoTimestamp(new Date(now().getTime() + timeoutMs));
		const deliverRevise = request.deliverRevise ?? true;
		const directive = request.directive ?? "act on next";
		const subject = { head_sha: headSha, branch, files: diff.files, truncated: diff.truncated };

		await manager.ready();
		let managed: ReturnType<WorkerManager["spawn"]>;
		try {
			managed = manager.spawn({
				key,
				identity: {
					jobId,
					// The reviewer only reads: it is a research-shaped worker whatever
					// the job under review is, exactly as in `Gate.start`.
					kind: "research",
					delivery: (record.delivery ?? "pr") as Delivery,
					runDir,
					worktree: scratch,
				},
				profile,
				model,
				// Model and effort are one decision; the spawn gets both (cp-reviewer-routing).
				...(route.decision.thinking ? { thinking: route.decision.thinking } : {}),
				brief,
				sessionDir: join(home, LAYOUT.sessions),
				sessionName: key,
				...(this.#options.parentEnv ? { parentEnv: this.#options.parentEnv } : {}),
			});
		} catch (error) {
			recorder.close();
			return (
				await this.finish({
					jobId,
					attempt,
					model,
					prior,
					branch,
					subject,
					diff,
					patchId: currentPatchId,
					...(deltaFrom ? { deltaFrom } : {}),
					outcome: { operational: `reviewer could not run: ${(error as Error).message}` },
					deliverRevise,
					directive,
				})
			).result;
		}
		recorder.markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
		recorder.attach(managed.worker);
		const worker = managed.worker;

		const wait = async (): Promise<{ review?: GateReview; operational?: string }> => {
			const receipt = await worker.send(brief);
			recorder.cp("prompt_sent", { receipt: receipt.receipt, bytes: brief.length });
			if (receipt.receipt === "failed") {
				return { operational: `reviewer refused the brief: ${receipt.error ?? "unknown error"}` };
			}
			return awaitVerdict({
				jobId,
				verdictFile: join(home, paths.reviewVerdictFile(jobId, attempt)),
				rejectedFile: join(runDir, "verdict-rejected.json"),
				timeoutMs,
				worker,
			});
		};
		const finish = async (outcome: { review?: GateReview; operational?: string }) =>
			this.finish({
				jobId,
				attempt,
				model,
				prior,
				branch,
				subject,
				diff,
				patchId: currentPatchId,
				...(deltaFrom ? { deltaFrom } : {}),
				outcome,
				deliverRevise,
				directive,
				managedKey: key,
				recorder,
			});

		const reviews = this.#options.reviews;
		if (!reviews) {
			let outcome: { review?: GateReview; operational?: string };
			try {
				outcome = await wait();
			} catch (error) {
				outcome = { operational: `reviewer wait failed: ${(error as Error).message}` };
			}
			return (await finish(outcome)).result;
		}
		return {
			...reviews.start({
				jobId,
				surface: "review",
				attempt,
				model,
				...(worker.pid !== undefined ? { pid: worker.pid } : {}),
				deadline,
				subject,
				wait,
				finish: async (outcome) => (await finish(outcome)).wakeup,
			}),
			surface: "review",
			head_sha: headSha,
		};
	}

	/** Everything after the wait, unchanged: shut down, decide, persist, deliver a revise. */
	async finish(input: {
		jobId: string;
		attempt: number;
		model: string;
		prior: PriorAttempts;
		branch: string;
		subject: { head_sha: string; branch: string; files: number; truncated: boolean };
		diff?: DiffSubject;
		patchId?: string;
		deltaFrom?: string;
		outcome: { review?: GateReview; operational?: string };
		deliverRevise: boolean;
		directive: string;
		managedKey?: string;
		recorder?: RunRecorder;
	}): Promise<{ result: DiffReviewResult; wakeup: ReviewWakeup }> {
		const now = this.#options.now ?? (() => new Date());
		if (input.managedKey) await this.#options.manager.shutdown(input.managedKey);
		input.recorder?.close();
		const { review, operational } = input.outcome;
		// Policy — imported, never re-implemented. `rubric` (cp-950e, the plan rubric) and
		// `decision_summary` are gate-only output: `DiffVerdictSchema` admits no extra
		// properties, and carrying the summary through made `#persist` throw on a valid pass.
		const { raw, rubric: _rubric, decision_summary: _summary, ...decided } = decideGate({
			jobId: input.jobId,
			attempt: input.attempt,
			prior: input.prior,
			model: input.model,
			capReason: reviewCapReason(input.attempt, input.branch),
			vetoFlags: [],
			highOnlyBar: true,
			...(review ? { review } : {}),
			...(operational ? { operational } : {}),
			at: isoTimestamp(now()),
		});
		const verdict: DiffVerdict = {
			...decided,
			head_sha: input.subject.head_sha,
			...(input.patchId ? { patch_id: input.patchId } : {}),
			...(input.deltaFrom ? { delta_from: input.deltaFrom } : {}),
			diff_stat: { files: input.subject.files, truncated: input.subject.truncated },
		};
		const result = this.#persist({
			jobId: input.jobId,
			attempt: input.attempt,
			verdict,
			...(raw ? { raw } : {}),
			model: input.model,
			...(input.diff ? { diff: input.diff } : {}),
			...(review ? { review } : {}),
		});
		if (result.next === "revise" && input.deliverRevise) await this.#deliverRevise(result);
		// jje.3: a complete fifth review with findings declares its one operator-only exit.
		const prUrl = this.#options.fleet?.get(input.jobId)?.receipts?.find((receipt) => receipt.kind === "pr")?.url;
		requestFinalFix(this.#options.home, { verdict, ...(review ? { review } : {}), ...(prUrl ? { prUrl } : {}) });
		this.#finished.set(input.attempt, result);
		return {
			result,
			wakeup: {
				jobId: input.jobId,
				surface: "review",
				attempt: input.attempt,
				headSha: input.subject.head_sha,
				content: diffReviewDirective(result, input.directive),
				details: result as unknown as Record<string, unknown>,
			},
		};
	}

	/** An attempt whose reviewer died with a previous parent: decided operational from its recorded subject. */
	async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined> {
		if (!pending.subject) return undefined;
		const prior = readPriorAttempts(this.#options.home, pending.job_id, paths.reviewFile, DiffVerdictSchema, {
			capExhausted: reviewCapExhausted,
		});
		if (prior.attempt !== pending.attempt) return undefined;
		return (
			await this.finish({
				jobId: pending.job_id,
				attempt: pending.attempt,
				model: pending.model,
				prior,
				branch: pending.subject.branch,
				subject: pending.subject,
				outcome: { operational: reason },
				deliverRevise: false,
				directive: "act on next",
			})
		).wakeup;
	}

	/** Blocking convenience for tests only; see `Gate.gateAndWait`. */
	async reviewAndWait(request: DiffReviewRequest): Promise<DiffReviewResult> {
		const started = await this.start(request);
		if (!isDiffReviewWait(started)) return started;
		const reviews = this.#options.reviews;
		if (!reviews) throw new DiffReviewError("reviewAndWait needs a ReviewRuns registry");
		reviews.handBack(started.key);
		await reviews.settled(started.key);
		const finished = this.#finished.get(started.attempt);
		if (finished) return finished;
		const prior = readPriorAttempts(this.#options.home, request.jobId, paths.reviewFile, DiffVerdictSchema, {
			capExhausted: reviewCapExhausted,
		});
		const verdict = prior.decisions[started.attempt - 1] as DiffVerdict | undefined;
		if (!verdict) {
			throw new DiffReviewError(`review ${started.attempt} for ${request.jobId} left no decision on disk`);
		}
		return {
			verdict,
			next: nextAction(verdict),
			path: join(this.#options.home, paths.reviewFile(request.jobId, started.attempt)),
			model: started.model,
		};
	}

	/**
	 * The ship branch's head commit right now, from the same source `review()`
	 * reads: `origin/<branch>` in the canonical clone, never a leased worktree.
	 *
	 * This is the freshness signal a caller needs before it may treat a persisted
	 * `DiffVerdict` as still describing the code: `head_sha` is the commit that
	 * verdict actually read, so a verdict whose `head_sha` is no longer the head
	 * is a verdict about code nobody is shipping any more (Constraints §3 — an
	 * artifact-mtime-style freshness test is the wrong signal for a diff).
	 *
	 * `undefined` means "cannot answer": no dispatch record, not a ship job, the
	 * clone or its remote is unreachable, or the branch does not resolve because
	 * it was never pushed. That is a fact for the caller to report and hold on,
	 * never a verdict and never a reason to proceed.
	 */
	async headSha(jobId: string): Promise<string | undefined> {
		const record = this.#options.fleet?.get(jobId);
		if (!record || record.kind !== "ship") return undefined;
		const git = this.#options.git ?? defaultGit;
		let clone: string;
		try {
			clone = await this.#clone(record.project);
		} catch {
			return undefined;
		}
		if (this.#options.fetch !== false) {
			const fetched = await git(clone, ["fetch", "origin"]);
			if (fetched.status !== 0) return undefined;
		}
		const remote = await git(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${record.branch}`]);
		const head = remote.stdout.trim();
		return remote.status === 0 && head.length > 0 ? head : undefined;
	}

	/** The canonical clone for this project, cloned on demand if it is missing. */
	async #clone(project: string): Promise<string> {
		const registry = this.#options.registry ?? new ProjectRegistry({ home: this.#options.home });
		const ensured = await registry.ensureClone(project);
		return ensured.path;
	}

	/**
	 * The reviewer's whole routing decision — model and effort — with the subject
	 * ship job's own scope/risk as its inputs (cp-reviewer-routing). The reviewer
	 * only reads, but what it reads is that job's diff: an L/high ship route is an
	 * L/high review, and a rubric row scoped to it must be able to fire.
	 *
	 * Same rule as `Gate.#route`: a repeat operational fault becomes
	 * `operational_persistent` and lands on the operator instead of quietly
	 * retrying elsewhere (cp-eff). The ordered `fallbacks` of
	 * pi-command-post-0a9 are resolution-time and change nothing here — a
	 * reviewer that ran on a fallback records it in `attempted`, and a retry
	 * re-runs the same decision.
	 */
	async #route(profile: WorkerProfile, jobId: string, record: FleetRecord, override?: string): Promise<ReviewerRoute> {
		const inputs = reviewerRoutingInputs(record);
		const decision = await resolveWithCapacity(
			{
				profile,
				jobId,
				project: record.project,
				kind: "research",
				...(inputs.scope ? { scope: inputs.scope } : {}),
				...(inputs.risk ? { risk: inputs.risk } : {}),
				...(override ? { override } : {}),
			},
			this.#options.routing,
			this.#options.probe,
			this.#options.capacity,
		);
		return { decision, inputs };
	}

	/**
	 * Validate, write, and record. The run log learns the outcome (verdict,
	 * cause, next, counts) and never the diff.
	 */
	#persist(input: {
		jobId: string;
		attempt: number;
		verdict: DiffVerdict;
		raw?: { reasons: string[]; revisions?: string[] };
		model?: string;
		review?: GateReview;
		diff?: DiffSubject;
		equivalence?: boolean;
	}): DiffReviewResult {
		const { home } = this.#options;
		const { jobId, attempt, verdict } = input;
		const validated = validate<DiffVerdict>(DiffVerdictSchema, verdict);
		if (!validated.ok) {
			throw new DiffReviewError(
				`diff review decision for ${jobId} violates the contract:\n  ${validated.errors.join("\n  ")}`,
			);
		}
		const path = join(home, input.equivalence ? paths.reviewEquivalenceFile(jobId, verdict.head_sha) : paths.reviewFile(jobId, attempt));
		atomicWriteJson(path, verdict);
		// Something was too big for the schema and got capped: the note in
		// `reasons` says so, and the full decision still has to be recoverable.
		if (input.raw) {
			atomicWriteJson(join(home, reviewFileRaw(jobId, attempt)), {
				...verdict,
				reasons: input.raw.reasons,
				...(input.raw.revisions ? { revisions: input.raw.revisions } : {}),
			});
		}

		const result: DiffReviewResult = {
			verdict,
			next: nextAction(verdict),
			path,
			...(input.model ? { model: input.model } : {}),
			...(input.review ? { review: input.review } : {}),
			...(input.diff ? { diff: input.diff } : {}),
		};

		this.#options.runs?.open(jobId).cp("review_decided", {
			attempt,
			verdict: verdict.verdict,
			cause: verdict.cause,
			next: result.next,
			head_sha: verdict.head_sha,
			files: verdict.diff_stat.files,
			truncated: verdict.diff_stat.truncated,
			path,
			...(input.model ? { model: input.model } : {}),
		});
		return result;
	}

	/**
	 * A revise is a promote, not a new dispatch and never a second PR: the
	 * implementer is still alive on the branch it pushed, so the fix is one more
	 * commit there. If it is not alive, that is reported — never quietly re-run,
	 * and never re-dispatched behind the operator's back (`Gate.#deliverRevise`).
	 */
	async #deliverRevise(result: DiffReviewResult): Promise<void> {
		const sender = this.#options.sender;
		if (!sender) return;
		try {
			const receipt = await sender.send({
				jobId: result.verdict.job_id,
				message: diffReviseMessage(result.verdict),
				purpose: "repair",
			});
			result.revise_receipt = receipt.receipt;
			if (receipt.error) result.revise_error = receipt.error;
		} catch (error) {
			result.revise_error = (error as Error).message;
		}
		if (result.revise_error) {
			// An undelivered revise is nobody's action item until a human picks it
			// up: there is no worker to fix the diff and re-running the review would
			// only spend the cap on the same commit.
			result.next = "surface";
		}
	}
}

/** The promote text: the reviewer's revisions, verbatim and bounded. */
export function diffReviseMessage(verdict: DiffVerdict): string {
	const remaining = Math.max(REVIEW_MAX_ATTEMPTS - verdict.attempt, 0);
	const lines = [
		`Diff review of ${verdict.job_id} at ${verdict.head_sha.slice(0, 12)} (attempt ${verdict.attempt}): revise.`,
		"",
		"Revisions required:",
		...(verdict.revisions ?? []).map((revision) => `- ${revision}`),
		"",
		"Reasons given:",
		...verdict.reasons.map((reason) => `- ${reason}`),
		"",
		`Fix this on the same branch (${verdict.job_id}) with one more commit and push it — never a second PR, never a new`,
		"branch. Run the project's checks before you push; then reply here with one line naming what you changed.",
		"Only a changed head commit can be re-reviewed. Your envelope slot was reopened when this promote was delivered,",
		"so if the fix changes what your envelope said you may call report_result once more and it will be accepted.",
		`This was review ${verdict.attempt} of ${REVIEW_MAX_ATTEMPTS} on this branch: the pushed fix is reviewed again, ` +
			`and ${remaining === 1 ? "1 review remains" : `${remaining} reviews remain`} before remaining findings go to the ` +
			"operator instead of back to you. Fix everything named above in this one commit.",
	];
	return lines.join("\n");
}

/** One relayable block per decision. The verdict travels; the diff never does. */
export function formatDiffReview(result: DiffReviewResult): string {
	const { verdict } = result;
	const head = `${verdict.job_id} diff review attempt ${verdict.attempt}: ${verdict.verdict}${
		verdict.cause ? ` (cause: ${verdict.cause})` : ""
	} [${result.model ?? "no reviewer spawned"}] -> ${result.next}`;
	const lines = [
		head,
		`  subject: ${verdict.head_sha.slice(0, 12)} (${verdict.diff_stat.files} file(s)${
			verdict.diff_stat.truncated ? ", truncated" : ""
		})`,
		`  review ${verdict.attempt} of ${REVIEW_MAX_ATTEMPTS} on ${verdict.job_id}`,
	];
	const flags = (Object.keys(verdict.flags) as Array<keyof GateFlags>).filter((flag) => verdict.flags[flag]);
	if (flags.length > 0) lines.push(`  flags: ${flags.join(", ")}`);
	for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
	if (verdict.revisions?.length) {
		lines.push("  revisions:");
		for (const revision of verdict.revisions) lines.push(`    - ${revision}`);
	}
	if (result.revise_receipt) lines.push(`  revise delivered: ${result.revise_receipt}`);
	if (result.revise_error) lines.push(`  revise NOT delivered: ${result.revise_error}`);
	return lines.join("\n");
}

/** The wake-up body: the decision, then one line saying what to do with it. */
export function diffReviewDirective(result: DiffReviewResult, directive: string): string {
	return `${formatDiffReview(result)}\nNext: ${directive}.`;
}

/**
 * What `cp_review action:status` prints: the pending attempt, if any, and every
 * decision. The sibling of `formatGateStatus` and deliberately beside it in
 * shape, so the two surfaces cannot drift into describing the same fact
 * differently.
 */
export function formatDiffReviewStatus(
	jobId: string,
	status: { pending?: PendingReview; decisions: readonly DiffVerdict[] },
): string {
	const lines = [
		`${jobId} diff review: ${status.decisions.length} decided attempt(s)${
			status.pending ? `, attempt ${status.pending.attempt} running (deadline ${status.pending.deadline})` : ""
		}`,
	];
	for (const decision of status.decisions) {
		lines.push(
			`  ${decision.attempt}: ${decision.verdict}${decision.cause ? ` (${decision.cause})` : ""} at ${decision.decided_at}`,
		);
	}
	return lines.join("\n");
}

/** What is on disk for this job's diff review: the pending attempt and every decision. */
export function diffReviewStatusOf(
	home: string,
	jobId: string,
	pending: PendingReview | undefined,
): { pending?: PendingReview; decisions: DiffVerdict[] } {
	const decisions = readPriorAttempts(home, jobId, paths.reviewFile, DiffVerdictSchema, {
		capExhausted: reviewCapExhausted,
	}).decisions as DiffVerdict[];
	return { ...(pending ? { pending } : {}), decisions };
}

/** One block for a tool result that returned `wait`. */
export function formatReviewWait(wait: DiffReviewWait): string {
	return (
		`review attempt ${wait.attempt} on head ${wait.head_sha.slice(0, 12)} is running [${wait.model}] -> wait\n` +
		`  deadline: ${wait.deadline}\n` +
		"  End the turn; a cp-verdict wake-up will arrive with the verdict. Do not call status to wait."
	);
}
