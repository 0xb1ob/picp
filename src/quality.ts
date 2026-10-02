/**
 * Research quality pass — a cheap panel before the expensive gate.
 *
 * Ported from pi-dynamic-workflows' `verify()` and `completenessCheck()`:
 *
 *  - **verify** — N cheap voters, one lens each, and a threshold over their
 *    votes. Disagreement is the signal; a single opinion is not.
 *  - **completenessCheck** — one pass asking whether the artifact covers the
 *    task it was given, listing what is missing.
 *
 * Both are **off by default** and opted into per job. The point of the pass is
 * to spend a few cents catching an artifact that would waste a frontier gate
 * run and a human's authorization — not to add ceremony to every job.
 *
 * T22 amendments to the borrowed pattern, both forced by this build's contracts:
 *
 *  1. `verify(item)` there votes on one *finding*. Extracting findings would
 *     mean either reading the artifact in the parent (forbidden, T19) or a
 *     fourth role with a fourth terminating tool (a contract change). Here each
 *     voter votes on the whole artifact **through one lens**, which is where
 *     per-finding disagreement actually shows up, and the tally is per lens.
 *  2. A voter is a `gate-reviewer` worker with a different brief, so the panel
 *     reuses the one terminating tool that role owns (`report_verdict`). No new
 *     role, no new schema, no new plumbing.
 *
 * A voter that never votes **abstains**, and an abstention counts in the
 * denominator: a panel that could not answer has not approved anything.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CapacityReader } from "./capacity.ts";
import { join } from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import {
	DEFAULT_QUALITY_THRESHOLD,
	DEFAULT_QUALITY_VOTERS,
	type Delivery,
	type GateReview,
	isoTimestamp,
	LAYOUT,
	type JobRouting,
	paths,
	type PendingReview,
	QUALITY_PANEL_SLOT,
	type QualityConfig,
	QualityConfigSchema,
	type QualityLens,
	QUALITY_LENSES,
	type QualityReport,
	QualityReportSchema,
	type QualityVote,
	type RoutingConfig,
	SCHEMA_VERSION,
	validate,
	type WorkerProfile,
} from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { awaitVerdict } from "./gate.ts";
import { type ReviewRuns, type ReviewWait, type ReviewWakeup } from "./review-runs.ts";
import { atomicWriteJson } from "./json-store.ts";
import { assembleBrief, profileForRole, readBriefTemplate } from "./profiles.ts";
import { type ModelProbe, resolveWithCapacity, type ReviewerRoute, reviewerRoutingEvent, reviewerRoutingInputs } from "./routing.ts";
import { RunRecorder } from "./run-artifacts.ts";
import type { WorkerManager } from "./worker-manager.ts";

export class QualityError extends Error {}

/** How long one voter may take before it abstains. */
export const DEFAULT_VOTE_TIMEOUT_MS = 180_000;

/** Off. Every field of the opt-in has to be asked for. */
export const QUALITY_OFF: QualityConfig = Object.freeze({ verify: false, completeness: false });

// ---------------------------------------------------------------------------
// The math (pure)
// ---------------------------------------------------------------------------

export interface Tally {
	sound: boolean;
	sound_count: number;
	total: number;
	ratio: number;
	threshold: number;
}

/**
 * `sound` when the fraction of sound votes reaches the threshold.
 *
 * Fail-closed choices, both deliberate:
 *  - the denominator is every vote *cast or expected*, so abstentions count
 *    against the artifact;
 *  - an empty panel is never sound, whatever the threshold says (a threshold of
 *    0 with no voters would otherwise "approve" nothing at all).
 */
export function tallyVotes(votes: readonly QualityVote[], threshold: number = DEFAULT_QUALITY_THRESHOLD): Tally {
	if (!(threshold >= 0 && threshold <= 1)) {
		throw new QualityError(`threshold must be between 0 and 1, got ${threshold}`);
	}
	const total = votes.length;
	const soundCount = votes.filter((vote) => vote.sound && vote.abstained !== true).length;
	const ratio = total === 0 ? 0 : soundCount / total;
	return {
		sound: total > 0 && ratio >= threshold,
		sound_count: soundCount,
		total,
		ratio,
		threshold,
	};
}

/** The lenses handed to `n` voters: distinct first, then round-robin. */
export function lensesFor(voters: number): QualityLens[] {
	if (!Number.isInteger(voters) || voters < 1) {
		throw new QualityError(`voters must be a positive integer, got ${voters}`);
	}
	return Array.from({ length: voters }, (_unused, index) => QUALITY_LENSES[index % QUALITY_LENSES.length] as QualityLens);
}

/** Everything the planner is asked to fix, deduplicated and bounded. */
export function fixesFrom(report: Omit<QualityReport, "fixes">, max = 20): string[] {
	const fixes: string[] = [];
	for (const vote of report.verify?.votes ?? []) {
		if (vote.sound || vote.abstained) continue;
		for (const reason of vote.reasons) {
			const line = `[${vote.lens}] ${reason}`;
			if (!fixes.includes(line)) fixes.push(line);
		}
	}
	for (const missing of report.completeness?.missing ?? []) {
		const line = `[completeness] ${missing}`;
		if (!fixes.includes(line)) fixes.push(line);
	}
	return fixes.slice(0, max);
}

/** Effective config: file defaults, then the job's opt-in, then explicit args. */
export function resolveQualityConfig(...layers: Array<QualityConfig | undefined>): QualityConfig {
	let config: QualityConfig = { ...QUALITY_OFF };
	for (const layer of layers) {
		if (!layer) continue;
		config = { ...config, ...layer };
	}
	return config;
}

export function loadQualityConfig(home: string): QualityConfig | undefined {
	const file = join(home, LAYOUT.data, "quality.json");
	if (!existsSync(file)) return undefined;
	const parsed = validate<QualityConfig>(QualityConfigSchema, JSON.parse(readFileSync(file, "utf8")));
	if (!parsed.ok) {
		throw new QualityError(`${file} violates the quality contract:\n  ${parsed.errors.join("\n  ")}`);
	}
	return parsed.value;
}

export function isEnabled(config: QualityConfig): boolean {
	return config.verify === true || config.completeness === true;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface QualityOptions {
	capacity?: CapacityReader;
	home: string;
	profilesDir: string;
	briefsDir: string;
	artifacts: ArtifactStore;
	manager: WorkerManager;
	routing: RoutingConfig;
	probe: ModelProbe;
	fleet?: FleetStore;
	voteTimeoutMs?: number;
	now?: () => Date;
	/** The registry that makes the panel asynchronous (spec 2026-09-05). */
	reviews?: ReviewRuns;
}

export interface QualityRequest {
	jobId: string;
	/** The task the artifact was written for (completeness needs it). */
	task: string;
	config: QualityConfig;
	/** The wake-up's "Next:" line. Default: "act on next". */
	directive?: string;
}

/** The panel returned before its report exists (spec 2026-09-05). */
export interface QualityWait extends ReviewWait {
	surface: "quality";
}
export type QualityStart = QualityReport | QualityWait | undefined;
export function isQualityWait(value: QualityStart): value is QualityWait {
	return value !== undefined && (value as QualityWait).next === "wait" && (value as QualityWait).surface === "quality";
}

export class QualityPass {
	readonly #options: QualityOptions;

	constructor(options: QualityOptions) {
		this.#options = options;
	}

	/** The report on disk, if this job has already had its one pass. */
	read(jobId: string): QualityReport | undefined {
		const file = join(this.#options.home, paths.qualityFile(jobId));
		if (!existsSync(file)) return undefined;
		const parsed = validate<QualityReport>(QualityReportSchema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok) {
			throw new QualityError(`${file} violates the quality report contract:\n  ${parsed.errors.join("\n  ")}`);
		}
		return parsed.value;
	}

	/**
	 * One pass per job, whatever the outcome (unchanged), now asynchronous: the
	 * panel is one pending attempt in `quality-panel/`, its votes run
	 * sequentially inside the background waiter, and one wake-up follows the
	 * report. An existing report is returned as is.
	 */
	async start(request: QualityRequest): Promise<QualityStart> {
		const config = request.config;
		if (!isEnabled(config)) return undefined;
		const existing = this.read(request.jobId);
		if (existing) return existing;
		const { artifacts, reviews } = this.#options;
		if (!artifacts.has(request.jobId)) {
			throw new QualityError(`no artifact for ${request.jobId} — nothing to check`);
		}
		const pending = reviews?.pending(request.jobId, "quality");
		if (pending) {
			throw new QualityError(
				`${request.jobId} already has a quality panel in flight (started ${pending.started_at}) — wait for its cp-verdict wake-up`,
			);
		}
		const directive = request.directive ?? "act on next";
		const profile = profileForRole(this.#options.profilesDir, "gate-reviewer");
		// Resolved once, at the start of the attempt, and carried through every voter
		// (cp-reviewer-routing): a panel that re-resolved per voter could attribute a
		// running voter to a model an edited config named after it had spawned.
		const route = await this.#route(profile, request, this.#options.fleet?.get(request.jobId));
		const model = route.decision.model;
		const votes =
			(config.verify === true ? (config.voters ?? DEFAULT_QUALITY_VOTERS) : 0) + (config.completeness === true ? 1 : 0);
		const timeoutMs = (this.#options.voteTimeoutMs ?? DEFAULT_VOTE_TIMEOUT_MS) * Math.max(1, votes);
		const now = this.#options.now ?? (() => new Date());
		const deadline = isoTimestamp(new Date(now().getTime() + timeoutMs));

		const wait = () => this.#panel(request, route);
		const finish = async (report: QualityReport): Promise<ReviewWakeup> => {
			// The registry substitutes `{ operational }` when the waiter throws; for
			// the panel that is not a report, and no report is written for it.
			const failed = (report as unknown as { operational?: string }).operational;
			if (failed) {
				return {
					jobId: request.jobId,
					surface: "quality",
					attempt: 1,
					content: `${request.jobId}: the quality panel failed — ${failed}. No report was written; advance to run the panel again.`,
					details: { job_id: request.jobId, failed },
				};
			}
			return {
				jobId: request.jobId,
				surface: "quality",
				attempt: 1,
				content: `${formatQuality(report)}\nNext: ${directive}.`,
				details: report as unknown as Record<string, unknown>,
			};
		};

		if (!reviews) {
			// No registry (a unit test of the pieces): run the panel inline. The
			// report is on disk when `#panel` returns.
			await wait();
			return this.read(request.jobId);
		}
		mkdirSync(join(this.#options.home, paths.qualityRunDir(request.jobId, QUALITY_PANEL_SLOT)), { recursive: true });
		return {
			...reviews.start<QualityReport>({
				jobId: request.jobId,
				surface: "quality",
				attempt: 1,
				model,
				deadline,
				wait,
				finish,
			}),
			surface: "quality",
		};
	}

	/** The whole panel: votes, completeness, tally, the write-once report. Runs in the background. */
	async #panel(request: QualityRequest, route: ReviewerRoute): Promise<QualityReport> {
		const config = request.config;
		const at = isoTimestamp((this.#options.now ?? (() => new Date()))());
		const verify = config.verify === true ? await this.#verify(request, route) : undefined;
		const completeness = config.completeness === true ? await this.#completeness(request, route) : undefined;
		const partial: Omit<QualityReport, "fixes"> = {
			schema_version: SCHEMA_VERSION,
			job_id: request.jobId,
			ran_at: at,
			passed: (verify?.sound ?? true) && (completeness?.complete ?? true),
			...(verify ? { verify } : {}),
			...(completeness ? { completeness } : {}),
		};
		const fixes = fixesFrom(partial);
		const report: QualityReport = { ...partial, ...(fixes.length > 0 ? { fixes } : {}) };
		const validated = validate<QualityReport>(QualityReportSchema, report);
		if (!validated.ok) {
			throw new QualityError(`quality report for ${request.jobId} violates the contract:\n  ${validated.errors.join("\n  ")}`);
		}
		atomicWriteJson(join(this.#options.home, paths.qualityFile(request.jobId)), report);
		return report;
	}

	/**
	 * A panel whose voters died with a previous parent never happened: no
	 * report is written (a write-once report of all-abstained votes would hold
	 * the job back for a fault that was nobody's), so the next advance runs the
	 * panel again. The wake-up says exactly that.
	 */
	async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined> {
		if (this.read(pending.job_id)) return undefined;
		return {
			jobId: pending.job_id,
			surface: "quality",
			attempt: 1,
			content: `${pending.job_id}: the quality panel (started ${pending.started_at}) was lost — ${reason}. No report was written; advance the pipeline to run the panel again.`,
			details: { job_id: pending.job_id, orphaned: true, reason },
		};
	}

	/** Blocking convenience for tests only; see `Gate.gateAndWait`. */
	async runAndWait(request: QualityRequest): Promise<QualityReport | undefined> {
		const started = await this.start(request);
		if (!isQualityWait(started)) return started;
		const reviews = this.#options.reviews;
		if (!reviews) throw new QualityError("runAndWait needs a ReviewRuns registry");
		reviews.handBack(started.key);
		await reviews.settled(started.key);
		return this.read(request.jobId);
	}

	// -- verify --------------------------------------------------------------

	async #verify(request: QualityRequest, route: ReviewerRoute): Promise<QualityReport["verify"]> {
		const voters = request.config.voters ?? DEFAULT_QUALITY_VOTERS;
		const threshold = request.config.threshold ?? DEFAULT_QUALITY_THRESHOLD;
		const lenses = lensesFor(voters);
		// Sequential on purpose: voters share the fleet's spawn cap with the
		// workers actually doing the job, and a panel is not worth a refused
		// dispatch elsewhere.
		const votes: QualityVote[] = [];
		for (const [index, lens] of lenses.entries()) {
			votes.push(await this.#vote(request, route, lens, index));
		}
		const tally = tallyVotes(votes, threshold);
		return { ...tally, votes };
	}

	async #vote(request: QualityRequest, route: ReviewerRoute, lens: QualityLens, index: number): Promise<QualityVote> {
		const outcome = await this.#review(request, route, {
			slot: `verify-${index + 1}`,
			template: "quality-verify",
			values: { lens },
		});
		if (!outcome.review) {
			return { lens, sound: false, reasons: [], model: outcome.model, abstained: true, note: outcome.note ?? "no vote" };
		}
		return {
			lens,
			sound: outcome.review.verdict === "pass",
			reasons: outcome.review.verdict === "pass" ? outcome.review.reasons : [...(outcome.review.revisions ?? outcome.review.reasons)],
			model: outcome.model,
		};
	}

	// -- completeness --------------------------------------------------------

	async #completeness(request: QualityRequest, route: ReviewerRoute): Promise<QualityReport["completeness"]> {
		const outcome = await this.#review(request, route, {
			slot: "completeness",
			template: "quality-completeness",
			values: {},
		});
		if (!outcome.review) {
			return { complete: false, missing: [], model: outcome.model, abstained: true };
		}
		const complete = outcome.review.verdict === "pass";
		return {
			complete,
			missing: complete ? [] : [...(outcome.review.revisions ?? outcome.review.reasons)].slice(0, 10),
			model: outcome.model,
		};
	}

	// -- one cheap reviewer --------------------------------------------------

	/**
	 * A `gate-reviewer` worker with a different brief: same trust policy, same
	 * scratch-cwd isolation, same write-once verdict, one artifact copy and
	 * nothing else.
	 */
	async #review(
		request: QualityRequest,
		route: ReviewerRoute,
		options: { slot: string; template: string; values: { lens?: QualityLens } },
	): Promise<{ review?: GateReview; model: string; note?: string }> {
		const { home, artifacts, manager } = this.#options;
		const profile = profileForRole(this.#options.profilesDir, "gate-reviewer");
		const record = this.#options.fleet?.get(request.jobId);
		const model = route.decision.model;
		const runDir = join(home, paths.qualityRunDir(request.jobId, options.slot));
		const scratch = join(runDir, "review");
		mkdirSync(scratch, { recursive: true });
		const artifactCopy = artifacts.get(request.jobId, join(scratch, "artifact.md")).out;

		const brief = assembleBrief({
			profile,
			template: readBriefTemplate(this.#options.briefsDir, options.template),
			templatePath: options.template,
			values: {
				job_id: request.jobId,
				task: request.task,
				artifact_path: artifactCopy,
				...(options.values.lens ? { lens: options.values.lens } : {}),
			},
		});
		writeFileSync(join(runDir, "brief.md"), brief);

		const recorder = RunRecorder.open({ home, jobId: request.jobId, dir: runDir });
		// One voter, one recorded decision (cp-reviewer-routing): the slot is this
		// panel's unit of work, so each voter records the route it actually spawned.
		// No `attempt` — the panel does not number attempts (one pass per job,
		// write-once report), and `surface` already names the slot.
		recorder.cp("routing_resolved", reviewerRoutingEvent({ surface: `quality/${options.slot}`, ...route }));
		await manager.ready();
		const key = `${request.jobId}#quality-${options.slot}`;
		try {
			const managed = manager.spawn({
				key,
				identity: {
					jobId: request.jobId,
					kind: "research",
					delivery: (record?.delivery ?? "pipeline") as Delivery,
					runDir,
					worktree: scratch,
				},
				profile,
				model,
				// The voter spawns at the effort routing resolved, not the profile's.
				...(route.decision.thinking ? { thinking: route.decision.thinking } : {}),
				brief,
				sessionDir: join(home, LAYOUT.sessions),
				sessionName: key,
			});
			recorder.markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
			recorder.attach(managed.worker);
			const receipt = await managed.worker.send(brief);
			recorder.cp("prompt_sent", { receipt: receipt.receipt, bytes: brief.length });
			if (receipt.receipt === "failed") {
				return { model, note: `voter refused the brief: ${receipt.error ?? "unknown error"}` };
			}
			const outcome = await awaitVerdict({
				jobId: request.jobId,
				verdictFile: join(runDir, "verdict.json"),
				rejectedFile: join(runDir, "verdict-rejected.json"),
				timeoutMs: this.#options.voteTimeoutMs ?? DEFAULT_VOTE_TIMEOUT_MS,
				worker: managed.worker,
			});
			return {
				...(outcome.review ? { review: outcome.review } : {}),
				...(outcome.operational ? { note: outcome.operational } : {}),
				model,
			};
		} catch (error) {
			// A voter that cannot start abstains; it never blocks the job.
			return { model, note: `voter could not run: ${(error as Error).message}` };
		} finally {
			await manager.shutdown(key);
			recorder.close();
		}
	}

	/**
	 * A voter's whole routing decision — model and effort — with the subject job's
	 * own scope/risk as its inputs (cp-reviewer-routing). A configured cheap model
	 * is still an explicit override and still wins; what it no longer does is
	 * throw away the effort and the subject's impact on the way to the spawn.
	 */
	async #route(profile: WorkerProfile, request: QualityRequest, record?: { project: string; routing?: JobRouting }): Promise<ReviewerRoute> {
		const inputs = reviewerRoutingInputs(record);
		const decision = await resolveWithCapacity(
			{
				profile,
				jobId: request.jobId,
				project: record?.project ?? "unregistered",
				kind: "research",
				...(inputs.scope ? { scope: inputs.scope } : {}),
				...(inputs.risk ? { risk: inputs.risk } : {}),
				...(request.config.model ? { override: request.config.model } : {}),
			},
			this.#options.routing,
			this.#options.probe,
			this.#options.capacity,
		);
		return { decision, inputs };
	}

}

/** The promote text for a failed pass: exactly what to fix, nothing else. */
export function qualityFixMessage(report: QualityReport): string {
	const lines = [
		`Pre-gate quality pass for ${report.job_id}: not ready.`,
		"",
		...(report.verify
			? [`Panel: ${report.verify.sound_count}/${report.verify.total} sound (threshold ${report.verify.threshold}).`]
			: []),
		...(report.completeness && !report.completeness.complete ? ["Completeness: the artifact does not cover the task."] : []),
		"",
		"Fix these, then update the artifact in place and report again:",
		...(report.fixes ?? []).map((fix) => `- ${fix}`),
	];
	return lines.join("\n");
}

/** One operator line. */
export function formatQuality(report: QualityReport): string {
	const parts = [`${report.job_id} quality pass: ${report.passed ? "passed" : "not ready"}`];
	if (report.verify) {
		parts.push(`verify ${report.verify.sound_count}/${report.verify.total} (>= ${report.verify.threshold})`);
	}
	if (report.completeness) parts.push(`completeness ${report.completeness.complete ? "ok" : "missing"}`);
	const fixes = (report.fixes ?? []).map((fix) => `\n  - ${fix}`).join("");
	return `${parts.join(" | ")}${fixes}`;
}
