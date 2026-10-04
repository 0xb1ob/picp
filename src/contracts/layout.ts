/** The home's directory layout and every `paths.*` helper; configured once per process. Import via src/contracts.ts. */

import { basename, join, resolve } from "node:path";
import { ContractError, isSafeJobId, isSafeProjectName, JOB_ID_PATTERN, PROJECT_NAME_PATTERN } from "./core.ts";
import { PENDING_REVIEW_FILE, QUALITY_PANEL_SLOT, type ReviewSurface } from "./reviews.ts";
import { CHECKPOINT_SCOPE_PATTERN, type CheckpointKind } from "./escalations.ts";
import { isSafeMandateId, MANDATE_ID_PATTERN } from "./mandates.ts";
import type { Mode } from "./modes.ts";
const CHECKPOINT_SCOPE_RE = new RegExp(CHECKPOINT_SCOPE_PATTERN);

// ---------------------------------------------------------------------------
// Directory layout — relative to the home; configured once per process
// ---------------------------------------------------------------------------

export interface Layout {
	data: string;
	state: string;
	projects: string;
	runs: string;
	artifacts: string;
	pipelines: string;
	checkpoints: string;
	/** Operator-issued bounded authority records (autonomy-programme-cur.2.1). */
	mandates: string;
	/** Structured escalations (autonomy-programme-cur.2.3). */
	escalationsFile: string;
	fleetFile: string;
	/** The declared half of Awaiting-you (cp-av8); the derived half lives in checkpoints/fleet. */
	awaitingFile: string;
	/** Answered decisions waiting to wake the parent (cp-answer-doesnt-wake). */
	answeredFile: string;
	/** Durable death/bound/recovery wake-ups (autonomy-programme-cur.1.3). */
	wakeupsFile: string;
	/** Answer cards the operator is owed (cp-6lg7). Outlives the job that earned them. */
	answerCardsFile: string;
	/** What the CI/PR watcher has already observed and announced (cp-e2d). */
	ciWatchFile: string;
	/** `cp_dispatch` requests refused only by the spawn cap, drained FIFO by the lock owner (cp-itl4 4b-2). */
	dispatchQueueFile: string;
	/** The one infra-only CI rerun claimed per job + head (unload-parent PR2, src/ci-infra-rerun.ts). */
	ciRerunsFile: string;
	/** `cp_dispatch` requests refused only by open blockers, released by the lock owner (src/dependency-dispatch.ts). */
	armedDispatchFile: string;
	/** What the status block has already reported under Shipped, per session (cp-b5eg). */
	shippedSeenFile: string;
	/**
	 * The one-parent-per-home lock (cp-epy2 §4.2). Held for the life of a parent
	 * session; a second parent on the same home is refused rather than allowed to
	 * race `fleet.json`'s whole-array read-modify-write, which cp-ga6j showed
	 * orphans live workers.
	 */
	parentLock: string;
	/** One-shot state migrations leave a marker here so they never run twice. */
	migrationsDir: string;
	/** pi's own session transcripts, one per worker key. */
	sessions: string;
	/** The runtime dotdir: one directory a single-project home can ignore wholesale (spec 2026-09-04 D2). */
	runtimeDir: string;
	/** The operator session's own workspace: tasks, handoffs, reports, scratch (cp-u3i2). */
	operatorWorkspace: string;
	/** The jobs ledger — what br's `.beads/` used to be. */
	jobsFile: string;
	/**
	 * Append-only record of the `type`/`priority` values a job carried before
	 * they were retired (2026-09-05). Written before the mutation that persists
	 * their removal, so the values survive the write that drops them.
	 */
	jobsLegacyArchive: string;
	routingFile: string;
	projectsFile: string;
	/** Rendered, human-readable view of the registry. Never read back. */
	projectsView: string;
	budgetsFile: string;
	/** Home-level mandate defaults (autonomy-programme-cur.2.5). */
	mandateDefaultsFile: string;
	gateConfigFile: string;
	workerBoundsFile: string;
	suggestFile: string;
	learningsFile: string;
	candidatesFile: string;
	archiveFile: string;
	/** Append-only audit of every promotion, rejection and retirement (curation). */
	curationLog: string;
}

const RUNTIME_DIR = ".pi-command-post";

/**
 * The runtime root rule (cp-daemon v1 P1, docs/storage.md): a home whose own
 * basename is `.pi-command-post` (the standard home `~/.pi-command-post`) *is*
 * the runtime root; any other home keeps it at `<home>/.pi-command-post/`.
 * Decided by the path alone — never by probing, never with a fallback.
 */
export function runtimeDirFor(home: string): "" | typeof RUNTIME_DIR {
	return basename(resolve(home)) === RUNTIME_DIR ? "" : RUNTIME_DIR;
}

/** The absolute runtime root of a home: the home itself or `<home>/.pi-command-post`. */
export function runtimeRootFor(home: string): string {
	return join(resolve(home), runtimeDirFor(home));
}

/** The layout a home has: flat when the home is the runtime root itself, else nested. */
export function layoutForHome(mode: Mode, home: string): Layout {
	return layoutFor(mode, runtimeDirFor(home));
}

/**
 * The layout for a runtime dir. One runtime root (cp-u3i2): every home-local
 * file lives under the gitignored runtime dotdir, so a home has exactly one
 * directory to exclude and a project repository no clash with its own
 * `data/` or `state/`. A flat home (`runtimeDir` `""`) is that root itself.
 * The mode parameter (always `multi`) stays so every caller keeps its shape.
 */
export function layoutFor(mode: Mode, runtimeDir: string = RUNTIME_DIR): Layout {
	const at = (path: string): string => (runtimeDir ? `${runtimeDir}/${path}` : path);
	const data = at("data");
	const state = at("state");
	const projects = at("projects");
	return {
		data,
		state,
		projects,
		runs: `${state}/runs`,
		artifacts: `${state}/artifacts`,
		pipelines: `${state}/pipelines`,
		checkpoints: `${state}/checkpoints`,
		mandates: `${state}/mandates`,
		escalationsFile: `${state}/escalations.json`,
		fleetFile: `${state}/fleet.json`,
		awaitingFile: `${state}/awaiting.json`,
		answeredFile: `${state}/answered.json`,
		wakeupsFile: `${state}/wakeups.json`,
		answerCardsFile: `${state}/answer-cards.json`,
		ciWatchFile: `${state}/ci-watch.json`,
		dispatchQueueFile: `${state}/dispatch-queue.json`,
		ciRerunsFile: `${state}/ci-reruns.json`,
		armedDispatchFile: `${state}/armed-dispatches.json`,
		shippedSeenFile: `${state}/status-block-shipped.json`,
		parentLock: `${state}/parent.lock`,
		migrationsDir: `${state}/.migrations`,
		sessions: `${state}/sessions`,
		runtimeDir,
		operatorWorkspace: at("operator"),
		jobsFile: at("jobs.json"),
		jobsLegacyArchive: at("jobs-legacy-fields.jsonl"),
		routingFile: `${data}/routing.json`,
		projectsFile: `${data}/projects.json`,
		projectsView: `${data}/projects.md`,
		budgetsFile: `${data}/budgets.json`,
		mandateDefaultsFile: `${data}/mandate-defaults.json`,
		gateConfigFile: `${data}/gate.json`,
		workerBoundsFile: `${data}/worker-bounds.json`,
		suggestFile: `${data}/suggest.json`,
		learningsFile: `${data}/learnings.md`,
		candidatesFile: `${data}/candidates.md`,
		archiveFile: `${data}/archive.md`,
		curationLog: `${data}/curation.jsonl`,
	};
}

/** Paths that must never be committed or pushed (T19 guard). The mode parameter is always `multi`. */
export function neverCommitFor(mode: Mode): string[] {
	return [`${RUNTIME_DIR}/`, ".beads/"];
}

/**
 * The live layout. Holds the multi values until `configureLayout` runs, so
 * every existing path and every test is unchanged; `paths.*` read
 * it at call time. Frozen once configured.
 */
export const LAYOUT: Layout = layoutFor("multi");
export const NEVER_COMMIT_PATHS: string[] = neverCommitFor("multi");

let layoutMode: Mode | undefined;
let layoutRuntimeDir: string = RUNTIME_DIR;

/**
 * Fix the layout for this process. Idempotent for the same mode and runtime
 * root; anything else is refused, because half a process on one layout and
 * half on another is two homes in one directory. A home passes itself so a
 * flat home (`runtimeDirFor`) gets the flat layout; without a home the layout
 * is nested exactly as before.
 */
export function configureLayout(mode: Mode, home?: string): Layout {
	const runtimeDir = home !== undefined ? runtimeDirFor(home) : RUNTIME_DIR;
	if (layoutMode !== undefined) {
		if (layoutMode !== mode) {
			throw new ContractError(`layout already configured for ${layoutMode}; cannot switch to ${mode} in this process`);
		}
		if (layoutRuntimeDir !== runtimeDir) {
			throw new ContractError(
				`layout already configured for ${layoutMode} with runtime root ${JSON.stringify(layoutRuntimeDir)}; cannot switch to ${JSON.stringify(runtimeDir)} in this process`,
			);
		}
		return LAYOUT;
	}
	Object.assign(LAYOUT, layoutFor(mode, runtimeDir));
	NEVER_COMMIT_PATHS.splice(0, NEVER_COMMIT_PATHS.length, ...neverCommitFor(mode));
	Object.freeze(LAYOUT);
	Object.freeze(NEVER_COMMIT_PATHS);
	layoutMode = mode;
	layoutRuntimeDir = runtimeDir;
	return LAYOUT;
}

export function currentLayoutMode(): Mode | undefined {
	return layoutMode;
}

/** The runtime dir this process's layout uses: `""` for a flat home, else `.pi-command-post`. */
export function currentRuntimeDir(): string {
	return layoutRuntimeDir;
}

function requireAttempt(attempt: number): number {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new ContractError(`attempt/generation must be a positive integer, got ${attempt}`);
	}
	return attempt;
}

function requireJobId(jobId: string): string {
	if (!isSafeJobId(jobId)) {
		throw new ContractError(
			`unsafe job id ${JSON.stringify(jobId)}: must match ${JOB_ID_PATTERN} (no slashes, no dots, no traversal)`,
		);
	}
	return jobId;
}

function requireCheckpointScope(scope: string | undefined): string {
	const value = (scope ?? "").trim().toLowerCase();
	if (!CHECKPOINT_SCOPE_RE.test(value)) {
		throw new ContractError(
			`a merge authorization must name the head sha it approves; ${JSON.stringify(scope ?? "")} does not match ${CHECKPOINT_SCOPE_PATTERN}`,
		);
	}
	return value;
}

/**
 * The inverse of `paths.checkpointFile`: which job, which kind and (for a
 * merge) which head sha a checkpoint file name names.
 *
 * It exists because `CheckpointStore.listPending()` reads a directory and has
 * to say which job id each file belongs to. A job id can hold no dot
 * (`JOB_ID_PATTERN`), so the first dot is an unambiguous separator and this can
 * be exact rather than a prefix-strip guess. `undefined` means "not a
 * checkpoint file", which is a skip and never a throw.
 */
export function parseCheckpointFileName(
	fileName: string,
): { jobId: string; kind: CheckpointKind; scope?: string } | undefined {
	if (!fileName.endsWith(".json")) return undefined;
	const base = fileName.slice(0, -".json".length);
	const dot = base.indexOf(".");
	const jobId = dot === -1 ? base : base.slice(0, dot);
	if (!isSafeJobId(jobId)) return undefined;
	if (dot === -1) return { jobId, kind: "ship" };
	const suffix = base.slice(dot + 1);
	if (suffix === "diff") return { jobId, kind: "diff" };
	if (suffix.startsWith("merge-")) {
		const scope = suffix.slice("merge-".length);
		if (!CHECKPOINT_SCOPE_RE.test(scope)) return undefined;
		return { jobId, kind: "merge", scope };
	}
	if (suffix.startsWith("final-fix-")) {
		const scope = suffix.slice("final-fix-".length);
		return CHECKPOINT_SCOPE_RE.test(scope) ? { jobId, kind: "final_fix", scope } : undefined;
	}
	return undefined;
}

/** All run-artifact and artifact-store paths, relative to the command post home. */
export const paths = Object.freeze({
	runDir(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}`;
	},
	eventsFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/events.jsonl`;
	},
	statusFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/status.json`;
	},
	scriptResultFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/script-result.json`;
	},
	envelopeFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/envelope.json`;
	},
	/**
	 * A previous envelope generation, archived when a promote reopened the slot.
	 * Moving it aside is what makes the worker's write-once `envelope.json`
	 * writable again — the record itself is never destroyed.
	 */
	supersededEnvelopeFile(jobId: string, generation: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/envelope-superseded-${requireAttempt(generation)}.json`;
	},
	/** The same, for a rejection record left behind by an exhausted worker. */
	supersededRejectionFile(jobId: string, generation: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/envelope-rejected-superseded-${requireAttempt(generation)}.json`;
	},
	/**
	 * Where intake quarantines an envelope it refused (pi-command-post-uad).
	 * Moving it aside is what reopens the worker's write-once slot for one
	 * corrected report of the SAME generation; the refused record is never
	 * destroyed, so the rejection stays auditable.
	 *
	 * `ordinal` is how that stays true across a crash (pi-command-post-snj): the
	 * quarantine file is written before the correction budget is stamped, so an
	 * interrupted refusal can leave `envelope-invalid-<generation>.json` behind
	 * with the budget unspent. The retry takes the next free name —
	 * `envelope-invalid-<generation>-2.json` — instead of overwriting the
	 * evidence the earlier refusal preserved.
	 */
	invalidEnvelopeFile(jobId: string, generation: number, ordinal = 1): string {
		const base = `${LAYOUT.runs}/${requireJobId(jobId)}/envelope-invalid-${requireAttempt(generation)}`;
		return requireAttempt(ordinal) === 1 ? `${base}.json` : `${base}-${ordinal}.json`;
	},
	/** Reviewer-written verdict (control message, not an artifact body). */
	verdictFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/verdict.json`;
	},
	briefFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/brief.md`;
	},
	/**
	 * Bounded recovery's per-job, per-class attempt counter
	 * (pi-command-post-autonomy-programme-cur.4.2). Persisted in the run dir so
	 * a parent restart cannot re-grant the one-per-class bound.
	 */
	recoveryAttemptsFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/recovery-attempts.json`;
	},
	/** The one canonical clone for a project. */
	projectDir(name: string): string {
		if (!isSafeProjectName(name)) {
			throw new ContractError(`unsafe project name ${JSON.stringify(name)}: must match ${PROJECT_NAME_PATTERN}`);
		}
		return `${LAYOUT.projects}/${name}`;
	},
	artifactDir(jobId: string): string {
		return `${LAYOUT.artifacts}/${requireJobId(jobId)}`;
	},
	/** The two-job link, keyed by the research job that starts the pipeline. */
	pipelineFile(researchId: string): string {
		return `${LAYOUT.pipelines}/${requireJobId(researchId)}.json`;
	},
	/**
	 * The journaled authorization, keyed by the job it authorizes.
	 *
	 * `kind` defaults to `"ship"`, reproducing today's exact path for every
	 * existing call site (`paths.checkpointFile(jobId)`), so this is a
	 * backward-compatible addition, not a migration. A second, post-diff
	 * authorization against the same `ship_id` needs its own file —
	 * `CheckpointStore.decide` refuses to overwrite an existing answer — so a
	 * caller that wants that second checkpoint passes `"diff"` explicitly.
	 */
	checkpointFile(jobId: string, kind: CheckpointKind = "ship", scope?: string): string {
		const id = requireJobId(jobId);
		if (kind === "merge") {
			// cp-uug: a merge authorization is bound to the commit it approves, so the
			// sha is in the *file name*, not in a field a later head could be compared
			// against and quietly inherit. A force-push after the answer therefore has
			// no authorization at all, rather than a stale one.
			return `${LAYOUT.checkpoints}/${id}.merge-${requireCheckpointScope(scope)}.json`;
		}
		// jje.3: the final fix is bound to the capped head the same way.
		if (kind === "final_fix") return `${LAYOUT.checkpoints}/${id}.final-fix-${requireCheckpointScope(scope)}.json`;
		if (scope !== undefined) {
			throw new ContractError(`only a merge or final_fix checkpoint is scoped; ${kind} for ${id} must not carry one`);
		}
		return `${LAYOUT.checkpoints}/${id}${kind === "diff" ? ".diff" : ""}.json`;
	},
	mandateFile(id: string): string {
		if (!isSafeMandateId(id)) {
			throw new ContractError(`unsafe mandate id ${JSON.stringify(id)}: must match ${MANDATE_ID_PATTERN}`);
		}
		return `${LAYOUT.mandates}/${id}.json`;
	},
	/** The implementer's task file: the research artifact, handed over by path. */
	taskFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/task.md`;
	},
	/**
	 * The task this job was dispatched with, frozen by the parent at dispatch
	 * (pi-command-post-worker-prompt-reliability-do8.3).
	 *
	 * Written once per dispatch from the dispatch request itself — the inline
	 * `task`, or the full body of a `taskFile` — and never from anything a
	 * worker produced. That is what makes it a trustworthy source for the plan
	 * gate: the artifact's own `Goal` section is the planner's restatement of
	 * the task, so scoring coverage against it can never detect a requirement
	 * the planner narrowed or dropped.
	 *
	 * Distinct from `taskFile` above, which is the *ship* job's handover
	 * document (a gated artifact, framed). This one is the *original* input.
	 */
	originalTaskFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/original-task.md`;
	},
	/**
	 * A previous frozen-task generation, archived when a valid promotion
	 * (`cp_send` with `task`/`taskFile`, mode `prompt`) replaced it
	 * (cp-promote-task-record). Moving it aside is what keeps `originalTaskFile`
	 * a single current file while none of the operator's prior scope is ever
	 * destroyed — the same pattern `supersededEnvelopeFile` already keeps.
	 */
	supersededOriginalTaskFile(jobId: string, generation: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/original-task-superseded-${requireAttempt(generation)}.md`;
	},
	/** Authorized scope additions, frozen at append time; never replace the original task. */
	taskAddendaFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/task-addenda.jsonl`;
	},
	/** The opt-in quality pass: one report per job, written once. */
	qualityFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/quality.json`;
	},
	/**
	 * The observed merge of this job's PR (cp-vk1). Written by `cp_merged` from
	 * what `gh pr view` reported; read by the teardown gate, which is how a
	 * squash- or rebase-merged PR is confirmed landed without `force`.
	 */
	mergeFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/merge.json`;
	},
	/**
	 * What `cp_integrate` has already done for this job (cp-uug). Continuity and
	 * bounded counters only: the step that is *due* is recomputed from git and
	 * `gh` on every call, so a stale record can never re-merge anything.
	 */
	integrationFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/integration.json`;
	},
	/**
	 * Append-only journal of operator questions for this job (T31). One line per
	 * exchange: what was asked, what came back, who answered, when. "We asked and
	 * nobody answered" has to be a readable fact, not silence.
	 */
	questionsFile(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/questions.jsonl`;
	},
	/** The console approval of a plan, pinned to the artifact hash (spec 2026-09-13). */
	reviewApproval(jobId: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/review-approval.json`;
	},
	/** Each voter is a worker with its own run dir under the job's run. */
	qualityRunDir(jobId: string, slot: string): string {
		if (!/^[a-z][a-z0-9_-]{0,32}$/.test(slot)) {
			throw new ContractError(`unsafe quality slot ${JSON.stringify(slot)}`);
		}
		return `${LAYOUT.runs}/${requireJobId(jobId)}/quality-${slot}`;
	},
	artifactFile(jobId: string): string {
		return `${LAYOUT.artifacts}/${requireJobId(jobId)}/report.md`;
	},
	gateFile(jobId: string, attempt: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/gate-${requireAttempt(attempt)}.json`;
	},
	/**
	 * The pre-cap decision, written only when `gate-<n>.json` had to drop
	 * reasons or revisions to fit the schema's bounds — so a truncated verdict
	 * is never the only surviving copy (cp-yg2).
	 */
	gateFileRaw(jobId: string, attempt: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/gate-${requireAttempt(attempt)}-raw.json`;
	},
	/**
	 * The reviewer worker's own run directory for one gate attempt. Each attempt
	 * gets its own, because `verdict.json` is write-once by contract and a second
	 * attempt must not be refused by the first one's record.
	 */
	gateRunDir(jobId: string, attempt: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/gate-${requireAttempt(attempt)}`;
	},
	gateVerdictFile(jobId: string, attempt: number): string {
		return `${paths.gateRunDir(jobId, attempt)}/verdict.json`;
	},
	/** Scratch cwd handed to the reviewer: never the worktree, never the store. */
	gateScratchDir(jobId: string, attempt: number): string {
		return `${paths.gateRunDir(jobId, attempt)}/review`;
	},
	/** Diff-review's own attempt file, parallel to `gateFile` but never confused with it. */
	reviewFile(jobId: string, attempt: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/review-${requireAttempt(attempt)}.json`;
	},
	/** A passing verdict inherited by a patch-identical head without spending an attempt. */
	reviewEquivalenceFile(jobId: string, headSha: string): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/review-equivalent-${requireCheckpointScope(headSha)}.json`;
	},
	/** The reviewer worker's own run directory for one diff-review attempt. */
	reviewRunDir(jobId: string, attempt: number): string {
		return `${LAYOUT.runs}/${requireJobId(jobId)}/review-${requireAttempt(attempt)}`;
	},
	reviewVerdictFile(jobId: string, attempt: number): string {
		return `${paths.reviewRunDir(jobId, attempt)}/verdict.json`;
	},
	/** Scratch cwd handed to the diff reviewer: contains only the materialized diff. */
	reviewScratchDir(jobId: string, attempt: number): string {
		return `${paths.reviewRunDir(jobId, attempt)}/review`;
	},
	/**
	 * The attempt directory a pending review lives in: the gate's and the diff
	 * review's own run directories, and the quality panel's reserved slot. The
	 * panel runs once per job, so its attempt is always 1.
	 */
	reviewAttemptDir(jobId: string, surface: ReviewSurface, attempt: number): string {
		switch (surface) {
			case "gate":
				return paths.gateRunDir(jobId, attempt);
			case "review":
				return paths.reviewRunDir(jobId, attempt);
			case "quality":
				if (attempt !== 1) {
					throw new ContractError(`the quality panel runs once per job; attempt ${attempt} is not a thing`);
				}
				return paths.qualityRunDir(requireJobId(jobId), QUALITY_PANEL_SLOT);
		}
	},
	pendingReviewFile(jobId: string, surface: ReviewSurface, attempt: number): string {
		return `${paths.reviewAttemptDir(jobId, surface, attempt)}/${PENDING_REVIEW_FILE}`;
	},
});
