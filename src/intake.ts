/**
 * Envelope intake — what the parent does the moment a worker reports.
 *
 * The worker writes `state/runs/<job-id>/envelope.json` itself (worker-reporter,
 * T5) and terminates. The parent notices through the worker's *event stream*
 * (the `report_result` tool completing, then `agent_settled`) — a fact, not a
 * poll — and then:
 *
 *  1. validates the envelope against the dispatch record (identity, kind,
 *     delivery rules) — fail-closed, exactly as the worker did;
 *  2. stamps `reported_at` **once per envelope generation** (a second report of
 *     the same generation is a no-op, a contradicting one is a failure). A
 *     promote that reopened the slot (`src/supersede.ts`) starts a new
 *     generation: the previous envelope is archived, `reported_at` is cleared,
 *     and the superseding envelope is accepted as this job's one delivery;
 *  3. moves the job to `held`, and says what comes next: keep the hold
 *     (`delivery:pr`) or tear it down (`local`/`pipeline`);
 *  4. registers a research artifact by **stat and move only** — the parent
 *     never reads an artifact body, so intake cannot either;
 *  5. records receipts (PR url, artifact, pushed head sha) and a
 *     `cp:envelope_received` marker,
 *     and hands the operator-facing headline to whoever wants to notify.
 *
 * The summary is the only worker text that travels: it is validated to be a
 * headline (≤3 lines, no fences, no headings), which is the ported HARD RULE
 * "the findings body never travels in the envelope", now mechanical.
 */

import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { FailJob } from "./failure-announcer.ts";
import {
	type Delivery,
	type Envelope,
	type EnvelopeBlocker,
	type EnvelopeCorrection,
	ENVELOPE_CORRECTION_REASON_MAX_CHARS,
	type EnvelopeRecord,
	expectsPlannerBlockers,
	type Failure,
	type FleetRecord,
	isScriptFleetRecord,
	validateScriptExitResultRecord,
	isoTimestamp,
	PLANNER_BLOCKED_ROUND_CAP,
	type JobKind,
	type JobPhase,
	paths,
	plannerBlockedRoundAction,
	type Receipt,
	validate,
	validateEnvelope,
	EnvelopeRecordSchema,
} from "./contracts.ts";
import { publishBoard } from "./board-delivery.ts";
import { DEFAULT_PORT, defaultHost } from "./viewer/cli.ts";
import { hostHeaderFor } from "./viewer/server.ts";
import { type EscalationStore, raiseLoopExhausted } from "./escalation.ts";
import type { FleetStore } from "./fleet.ts";
import { readStatusFile } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import type { WorkerEvent, WorkerProcess } from "./worker-process.ts";
import { githubRepoFromCloneUrl } from "./mandate.ts";
import type { CommandRunner } from "./merge-ask.ts";
import { type PrResolution, resolvePr } from "./pr-resolve.ts";

export class IntakeError extends Error {}

export interface IntakeArtifact {
	path: string;
	bytes: number;
	/** True when intake moved it into `state/artifacts/<job-id>/`. */
	relocated: boolean;
}

export interface IntakeResult {
	job_id: string;
	/** False when there is nothing on disk to intake yet. */
	accepted: boolean;
	/** True when this envelope had already been accepted (idempotent re-run). */
	already: boolean;
	phase: JobPhase;
	kind?: JobKind;
	delivery?: Delivery;
	/** What the parent should do next with the lease and the worker. */
	next?: "hold" | "teardown" | "answer" | "escalate";
	status?: "done" | "blocked" | "failed";
	/** Headline only. Never a body — that is the contract. */
	summary?: string;
	blockers?: EnvelopeBlocker[];
	/** Set when a blocked planner envelope was escalated instead of left for the parent to answer. */
	escalation_id?: string;
	artifact?: IntakeArtifact;
	board_url?: string;
	receipts?: Receipt[];
	/**
	 * A named line about the `pr_url` intake stored (pi-command-post-fbn): either the
	 * correction `pr_url corrected: <given> -> <canonical>`, or why the url could not be
	 * checked. A corrected url is never silent, and an uncheckable one is never a pass.
	 */
	pr_url_note?: string;
	failure?: Failure;
	/**
	 * Set when this intake refused an unstamped envelope, quarantined it and
	 * reopened the generation's report slot for exactly one corrected report
	 * (pi-command-post-uad). `accepted` is false and `failure` is absent: nothing
	 * failed yet, the job is still reportable and a human need not intervene.
	 */
	correction?: EnvelopeCorrection;
	/**
	 * Which envelope generation this is: 1 for the ordinary single report, 2+
	 * after a promote reopened the slot. Exactly one generation is ever the
	 * live one — two envelopes never both count as the delivery.
	 */
	generation?: number;
	/**
	 * When this generation was stamped. Carried so a wake-up built from this
	 * result is attributable to one specific report (cp-p6m): a message for the
	 * envelope of 12:45:43 is recognisable once a promote has archived it.
	 */
	reported_at?: string;
}

export interface IntakeOptions {
	home: string;
	viewerHost?: string;
	viewerPort?: number;
	fleet: FleetStore;
	runs: RunRegistry;
	/**
	 * The project's origin remote, read from the registry (pi-command-post-fbn). Its
	 * `owner/repo` is what aims the one `gh pr list` and what a worker's url must agree
	 * with; with no origin remote to read there is nothing this can check, and the url is
	 * reported unverified rather than trusted.
	 */
	originUrl?: (project: string) => string | undefined;
	/** The `gh` runner envelope PR resolution uses. Injected in tests, `runCommand` in production. */
	prExec?: CommandRunner;
	now?: () => Date;
	/** Called once per accepted envelope (notify, widget, relay). */
	onReported?: (result: IntakeResult) => void;
	/** Present when a blocked planner round past the cap should write an escalation. */
	escalations?: () => EscalationStore;
	/** The only failed transition. Journals the durable wake-up. */
	fail: FailJob;
	/** Called when intake itself fails the job. Same hook FailureMonitor uses. */
	onFailure?: (jobId: string, failure: Failure) => void | Promise<void>;
}

export class EnvelopeIntake {
	readonly #options: IntakeOptions;
	readonly #inFlight = new Map<string, Promise<IntakeResult>>();

	constructor(options: IntakeOptions) {
		this.#options = options;
	}

	/**
	 * Watch a worker for its terminating report. Returns a detach function.
	 * Both triggers are facts from the stream: the tool finishing, and the run
	 * settling (the backstop for a worker that dies right after writing).
	 */
	watch(jobId: string, worker: WorkerProcess): () => void {
		const trigger = (event: WorkerEvent) => {
			if (event.type === "tool_execution_end") {
				const name = (event as { toolName?: unknown }).toolName;
				if (name !== "report_result") return;
			} else if (event.type !== "agent_settled") {
				return;
			}
			void this.intake(jobId).catch(() => {
				// Intake failures are recorded on the job; they must never take
				// down the event listener that will see the next attempt.
			});
		};
		return worker.onEvent(trigger);
	}

	/** Idempotent, serialized per job. */
	async intake(jobId: string): Promise<IntakeResult> {
		const existing = this.#inFlight.get(jobId);
		if (existing) return existing;
		const promise = this.#intake(jobId).finally(() => this.#inFlight.delete(jobId));
		this.#inFlight.set(jobId, promise);
		return promise;
	}

	async #intake(jobId: string): Promise<IntakeResult> {
		const { home, fleet, runs } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const record = fleet.get(jobId);
		if (!record) throw new IntakeError(`no fleet record for ${jobId}; nothing to intake`);

		if (isScriptFleetRecord(record)) return this.#intakeScript(record, now);
		const rejectedFile = join(home, paths.runDir(jobId), "envelope-rejected.json");
		const envelopeFile = join(home, paths.envelopeFile(jobId));

		if (!existsSync(envelopeFile)) {
			if (existsSync(rejectedFile) && record.phase !== "failed") {
				// The worker exhausted its repair attempts and said so in writing.
				const failure: Failure = {
					class: "envelope_invalid",
					message: `worker for ${jobId} could not produce a valid envelope; see ${rejectedFile}`,
					at: isoTimestamp(now()),
				};
				await this.#fail(jobId, failure);
				return { job_id: jobId, accepted: false, already: false, phase: "failed", failure };
			}
			return { job_id: jobId, accepted: false, already: false, phase: record.phase };
		}

		// A file that is not JSON at all is a refusable envelope like any other: it
		// used to throw out of intake and leave the unparseable record sitting in
		// the worker's write-once slot (pi-command-post-uad).
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(envelopeFile, "utf8"));
		} catch (error) {
			return this.#refuse(
				record,
				`${envelopeFile} is not readable as JSON: ${error instanceof Error ? error.message : String(error)}`,
				now,
			);
		}
		const parsed = validate<EnvelopeRecord>(EnvelopeRecordSchema, raw);
		if (!parsed.ok) {
			return this.#refuse(record, `${envelopeFile} is not a valid envelope record: ${parsed.errors.join("; ")}`, now);
		}
		const envelope: Envelope = parsed.value.envelope as Envelope;

		// The parent re-checks the contract; the worker's word is not evidence.
		const checked = validateEnvelope(envelope, {
			job_id: record.job_id,
			kind: record.kind,
			delivery: record.delivery,
			worktree: record.worktree,
		});
		if (!checked.ok) {
			return this.#refuse(record, `envelope for ${jobId} violates the contract: ${checked.errors.join("; ")}`, now);
		}

		const plannerBlocked = envelope.status === "blocked" && expectsPlannerBlockers(record);
		const blockedRound = plannerBlocked ? (record.planner_blocked_rounds ?? 0) + 1 : undefined;
		const plannerAction = plannerBlocked ? plannerBlockedRoundAction(record.planner_blocked_rounds ?? 0) : undefined;
		const next: IntakeResult["next"] = plannerAction ?? (record.delivery === "pr" ? "hold" : "teardown");
		const phase: JobPhase = plannerBlocked ? "waiting" : "held";
		const generation = (record.supersessions ?? 0) + 1;
		const base: IntakeResult = {
			job_id: jobId,
			accepted: true,
			generation,
			// Scoped to the CURRENT generation: a reopened slot has no `reported_at`,
			// so the superseding envelope is accepted instead of swallowed as a
			// duplicate — which is exactly how a promoted worker's real work was lost.
			already: record.reported_at !== undefined,
			phase,
			kind: record.kind,
			delivery: record.delivery,
			next,
			status: envelope.status,
			summary: envelope.summary,
			...(envelope.blockers ? { blockers: envelope.blockers } : {}),
		};
		if (base.already) {
			// Nothing to write: the first intake already made this true.
			return {
				...base,
				phase: record.phase,
				...(record.reported_at !== undefined ? { reported_at: record.reported_at } : {}),
				...(record.receipts ? { receipts: record.receipts } : {}),
			};
		}
		// pi-command-post-fbn: the PR is resolved from git and gh, never taken from the
		// worker's word. A typo'd owner (`0xb1b0` for `0xb1ob`) used to become this job's
		// stored `pr` receipt, and the CI watch keys its one REST read on exactly that url.
		const prResolution = await this.#resolvePr(record, envelope);
		if (prResolution?.status === "refused") {
			return this.#refuse(record, `pr_url for ${jobId}: ${prResolution.reason}`, now);
		}

		// Receipts survive a supersession (they are facts about the job, not about
		// one envelope), so a re-reported PR or artifact is merged, never duplicated.
		const receipts: Receipt[] = [...(record.receipts ?? [])];
		let artifact: IntakeArtifact | undefined;
		let boardUrl: string | undefined;
		if (record.delivery === "board" && envelope.status === "done") {
			try {
				const expected = join(home, paths.artifactDir(jobId), "board.json");
				if (envelope.artifact_path !== expected) throw new Error(`artifact_path must be ${expected}`);
				const slug = publishBoard(home, jobId, expected);
				// pi-command-post-1jz: a configured host is trusted as-is; an unconfigured
				// one must be the tailnet address the viewer actually binds under
				// `--require-tailnet`, never a silent loopback default.
				boardUrl = `http://${hostHeaderFor(this.#options.viewerHost ?? defaultHost(undefined, true), this.#options.viewerPort ?? DEFAULT_PORT)}/boards/${slug}/`;
			} catch (error) {
				return this.#refuse(record, `board for ${jobId} refused: ${(error as Error).message}`, now);
			}
			// The wake-up text is a one-time turn; the receipt is the durable record a
			// later status read or relay falls back to (pi-command-post-1jz: a missed
			// wake-up left the parent with no served URL, only the local artifact path).
			mergeReceipt(receipts, { kind: "board", status: "published", title: `board for ${jobId}`, url: boardUrl });
		}
		if (envelope.artifact_path && record.delivery !== "board") {
			// pi-command-post-uad: an envelope naming an artifact that is not there is
			// a refusable envelope, not an exception. Thrown, it escaped intake before
			// anything was recorded and left the filed envelope in place — which is the
			// exact shape that closed cp-o77y's report slot for good.
			try {
				artifact = this.#registerArtifact(jobId, envelope.artifact_path);
			} catch (error) {
				if (!(error instanceof IntakeError)) throw error;
				return this.#refuse(record, error.message, now);
			}
			mergeReceipt(receipts, {
				kind: "artifact",
				status: "stored",
				title: basename(artifact.path),
			});
		}
		// The canonical url is what every downstream reader keys on, so it is the resolved
		// one whenever resolution produced one — the worker's is only a fallback it could
		// not check (and then the note above says so).
		const prUrl =
			prResolution?.status === "verified" || prResolution?.status === "unverified" ? prResolution.url : envelope.pr_url;
		if (prUrl) {
			mergeReceipt(receipts, { kind: "pr", status: "open", title: `PR for ${jobId}`, url: prUrl });
		}
		// cp-kzc: the pushed head sha is the ship worker's last fact, and the only
		// one the parent's own CI check needs. `unverified` is the honest status:
		// the worker did not wait for CI (it is refused from doing so), and the
		// parent verifies the run against this sha before it merges.
		if (envelope.head_sha) {
			mergeReceipt(receipts, {
				kind: "ci",
				status: "unverified",
				title: `head ${envelope.head_sha}`,
			});
		}

		const reportedAt = isoTimestamp(now());
		// cp-p6m: the moment this generation was stamped travels with the news, so a
		// wake-up built from this result names one specific report.
		base.reported_at = reportedAt;
		// The correction, or the reason the url could not be checked, travels with the
		// result: it is the intake line the operator reads and the run journal records.
		const prNote =
			prResolution?.status === "verified"
				? prResolution.correction
				: prResolution?.status === "unverified"
					? prResolution.message
					: undefined;
		if (prNote) base.pr_url_note = prNote;
		// Populate the fleet record's usage from the run status at intake.
		const runStatus = readStatusFile(this.#options.home, jobId);
		// cp-rud: the fleet patch (reported_at + phase) and the unreported-settles
		// clear MUST be a single atomic mutation. Two sequential fleet.patch calls
		// left a window where a thrown second write left reported_at set but the
		// settle counter still present — and a thrown first write left neither set,
		// which is the root cause of the divergence: the settle watcher caught the
		// rejection silently and read a fleet record with no reported_at.
		await fleet.mutate((jobs) => {
			const index = jobs.findIndex((job) => job.job_id === jobId);
			if (index === -1) throw new IntakeError(`no fleet record for ${jobId}`);
			const current = jobs[index] as FleetRecord;
			jobs[index] = {
				...current,
				phase,
				reported_at: reportedAt,
				...(receipts.length > 0 ? { receipts } : {}),
				...(runStatus ? { usage: runStatus.usage } : {}),
				...(blockedRound !== undefined ? { planner_blocked_rounds: blockedRound } : {}),
			};
			// A settle that produced no envelope is only a fact until an envelope
			// arrives (cp-settle-without-report). A worker that was nudged and then
			// reported has reported: clearing the settle counter inside the same
			// mutation means it can never be read after reported_at is set.
			delete (jobs[index] as Record<string, unknown>).unreported_settles;
			// cp-0dhw: and the observation that went with it. An envelope is the
			// delivery the recovery prompt was asking for, so the evidence that there
			// was work sitting unreported is no longer true of this generation.
			delete (jobs[index] as Record<string, unknown>).unreported_work;
		});
		runs.open(jobId).markEnvelope({
			status: envelope.status,
			kind: envelope.kind,
			attempt: parsed.value.attempt,
			generation,
			next,
			...(artifact ? { artifact: artifact.path, bytes: artifact.bytes } : {}),
		});
		// Journaled as well as reported. A correction that lived only in the wake text would
		// be invisible in the run log, which is where "what url did this job really have?" is
		// answered later (pi-command-post-fbn).
		if (prResolution?.status === "verified" && prResolution.correction) {
			runs.open(jobId).cp("pr_url_corrected", { line: prResolution.correction, given: envelope.pr_url, canonical: prResolution.url });
		} else if (prResolution?.status === "unverified") {
			runs.open(jobId).cp("pr_url_unverified", { line: prResolution.message, url: prResolution.url });
		}

		const result: IntakeResult = {
			...base,
			already: false,
			phase,
			...(artifact ? { artifact } : {}),
			...(boardUrl ? { board_url: boardUrl } : {}),
			...(receipts.length > 0 ? { receipts } : {}),
		};
		if (plannerAction === "escalate") {
			const store = this.#options.escalations?.();
			if (store) {
				try {
					const raised = await raiseLoopExhausted(store, {
						jobId,
						question: `${jobId}: planner blocked round ${blockedRound} exceeds ${PLANNER_BLOCKED_ROUND_CAP}; do not answer the blockers.`,
						evidence_paths: [paths.envelopeFile(jobId)],
					});
					result.escalation_id = raised.id;
				} catch {
					// The envelope is already accepted. The wake-up still says escalate.
				}
			}
		}
		this.#options.onReported?.(result);
		return result;
	}

	/**
	 * pi-command-post-fbn: the job's PR, resolved from the project's origin remote and gh.
	 *
	 * Only a completed `ship`/`delivery:pr` envelope names a PR: a blocked one may not have
	 * opened a PR yet, and research never has one. The branch is the job's own — the one
	 * the dispatch cut — so a wrong branch in the envelope cannot steer the lookup.
	 */
	async #resolvePr(record: FleetRecord, envelope: Envelope): Promise<PrResolution | undefined> {
		if (record.kind !== "ship" || record.delivery !== "pr" || envelope.status !== "done") return undefined;
		const origin = this.#options.originUrl?.(record.project);
		const ownerRepo = origin ? githubRepoFromCloneUrl(origin) : undefined;
		return resolvePr(
			{ branch: record.branch, cwd: record.worktree, ...(envelope.pr_url ? { given: envelope.pr_url } : {}) },
			{
				...(ownerRepo ? { ownerRepo } : {}),
				...(this.#options.prExec ? { exec: this.#options.prExec } : {}),
			},
		);
	}

	async #intakeScript(record: FleetRecord, now: () => Date): Promise<IntakeResult> {
		const { home, fleet, runs } = this.#options;
		const jobId = record.job_id;
		const file = join(home, paths.scriptResultFile(jobId));
		if (!existsSync(file)) return { job_id: jobId, accepted: false, already: false, phase: record.phase };
		let raw: unknown;
		try { raw = JSON.parse(readFileSync(file, "utf8")); }
		catch (error) { throw new IntakeError(`${file}: invalid script result JSON: ${(error as Error).message}`); }
		const parsed = validateScriptExitResultRecord(raw, jobId, record.worktree);
		if (!parsed.ok) throw new IntakeError(`${file}: invalid script result: ${parsed.errors.join("; ")}`);
		const exit = parsed.value.result;
		const base: IntakeResult = { job_id: jobId, accepted: true, already: record.reported_at !== undefined, phase: exit.status === "done" ? "held" : "failed", kind: "ship", delivery: "local", next: "teardown", status: exit.status === "done" ? "done" : "failed", summary: exit.summary };
		if (record.reported_at) return { ...base, phase: record.phase, reported_at: record.reported_at };
		const artifact = this.#registerArtifact(jobId, exit.artifact_path);
		const failure: Failure | undefined = exit.status === "failed" ? {
			class: exit.reason === "timeout" ? "wall_clock_exceeded" : exit.reason === "signal" ? "script_signal" : exit.reason === "spawn_error" ? "spawn_failed" : "script_exit",
			message: exit.summary, at: isoTimestamp(now()),
		} : undefined;
		const at = isoTimestamp(now());
		await fleet.mutate((jobs) => {
			const current = jobs.find((job) => job.job_id === jobId);
			if (!current || !isScriptFleetRecord(current)) throw new IntakeError(`${jobId}: script fleet record disappeared before intake`);
			current.phase = base.phase;
			current.reported_at = at;
			if (current.script_process) {
				if (!current.script_process.exited_at) current.script_process = { ...current.script_process, exited_at: at, exit_code: exit.exit_code, signal: exit.signal };
			} else current.script_observed_exit = { exited_at: at, exit_code: exit.exit_code, signal: exit.signal };
			if (failure) current.failure = failure;
			else delete current.failure;
			current.receipts = [...(current.receipts ?? []), { kind: "artifact", status: "stored", title: basename(artifact.path) }];
		});
		runs.open(jobId).markEnvelope({ status: exit.status, kind: "ship", next: "teardown", artifact: artifact.path, bytes: artifact.bytes });
		const result: IntakeResult = { ...base, reported_at: at, artifact, ...(failure ? { failure } : {}) };
		this.#options.onReported?.(result);
		return result;
	}

	/**
	 * Refuse an envelope — and, exactly once per generation, leave the job able
	 * to correct it (pi-command-post-uad).
	 *
	 * Refusal used to be terminal in the only way that matters: the envelope
	 * stayed at `envelope.json`, so the worker's write-once slot stayed closed
	 * and every retry was answered "already filed". The job could not be
	 * promoted either — `decideReopen` needs a stamped envelope to supersede,
	 * and a refused one is never stamped.
	 *
	 * So the first refusal of a generation quarantines the record instead of
	 * leaving it: moved (never deleted, and never over an existing quarantine —
	 * see `quarantineEnvelope`) to `envelope-invalid-<generation>.json`,
	 * journalled, and recorded on the fleet as the one correction this generation
	 * gets. The slot is the SAME generation's — a refused envelope was never a
	 * delivery, so nothing is superseded and no receipt is invented. Everything
	 * downstream then works unchanged: the settle boundary sees an open slot and
	 * nudges, `cp_send` and `cp_revive` see a `waiting` job, and the corrected
	 * report goes through exactly the validation this one failed.
	 *
	 * It fails closed in three cases, so it can never become a loop or a way to
	 * overwrite a delivery: a generation whose correction is already spent, an
	 * envelope that was already stamped (a valid envelope is immutable), and an
	 * envelope that is no longer on disk.
	 */
	async #refuse(record: FleetRecord, message: string, now: () => Date): Promise<IntakeResult> {
		const { home, fleet, runs } = this.#options;
		const jobId = record.job_id;
		const generation = (record.supersessions ?? 0) + 1;
		const envelopeFile = join(home, paths.envelopeFile(jobId));
		// Generation-stamped: a correction spent on an earlier generation is stale
		// and never spends this one's budget.
		const spent =
			record.envelope_correction?.generation === generation ? record.envelope_correction : undefined;

		if (spent === undefined && record.reported_at === undefined && existsSync(envelopeFile)) {
			const quarantined = quarantineEnvelope(home, jobId, generation, envelopeFile);
			const correction: EnvelopeCorrection = {
				generation,
				at: isoTimestamp(now()),
				quarantined,
				reason: message.slice(0, ENVELOPE_CORRECTION_REASON_MAX_CHARS),
			};
			await fleet.patch(jobId, { envelope_correction: correction });
			runs.open(jobId).cp("envelope_rejected", { ...correction });
			return {
				job_id: jobId,
				accepted: false,
				already: false,
				phase: fleet.get(jobId)?.phase ?? record.phase,
				generation,
				correction,
			};
		}

		const failure: Failure = {
			class: "envelope_invalid",
			message: spent
				? `${message} — generation ${generation} already spent its one correction at ${spent.at} ` +
					`(the envelope refused then is kept at ${spent.quarantined}, and this one is left at ${envelopeFile}). ` +
					"Nothing was deleted: recover it by hand, or tear the job down deliberately."
				: message,
			at: isoTimestamp(now()),
		};
		await this.#fail(jobId, failure);
		return { job_id: jobId, accepted: false, already: false, phase: "failed", failure };
	}

	/** Failed transition plus the run marker. The announcer journals the wake-up. */
	async #fail(jobId: string, failure: Failure): Promise<void> {
		await this.#options.fail(jobId, failure);
		this.#options.runs.open(jobId).markFailure(failure);
		await this.#options.onFailure?.(jobId, failure);
	}

	/**
	 * Stat and (if needed) move. Never read: an artifact body that enters the
	 * parent's process is one paste away from entering its context.
	 */
	#registerArtifact(jobId: string, path: string): IntakeArtifact {
		if (!existsSync(path)) {
			throw new IntakeError(`envelope for ${jobId} names artifact ${path}, which does not exist`);
		}
		const stats = statSync(path);
		if (!stats.isFile() || stats.size === 0) {
			throw new IntakeError(`artifact ${path} for ${jobId} is empty or not a file`);
		}
		const target = join(this.#options.home, paths.artifactFile(jobId));
		if (path === target) return { path, bytes: stats.size, relocated: false };
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(path, target);
		return { path: target, bytes: statSync(target).size, relocated: true };
	}
}

/**
 * Move the refused envelope aside, and never onto a file that is already there
 * (pi-command-post-snj).
 *
 * The move happens *before* the fleet patch that spends the generation's one
 * correction, so a crash in between leaves `envelope-invalid-<generation>.json`
 * on disk with the budget unspent. As far as the record is concerned the next
 * refusal is still the first one — and renaming over that file would destroy
 * the only copy of the envelope the interrupted refusal preserved, which is the
 * one thing this whole path promises never to do. So each refusal takes the
 * first free ordinal (`-2`, `-3`, …) and returns the name it actually used:
 * `envelope_correction.quarantined` then points at real bytes, and the earlier
 * record stays readable beside it.
 *
 * `linkSync` refuses an existing target with EEXIST instead of clobbering it,
 * so the check and the move are one step rather than a stat followed by a
 * rename, and the envelope is unlinked only once it exists under its new name.
 * The loop terminates because each turn either moves the file or finds one more
 * file that already exists.
 */
function quarantineEnvelope(home: string, jobId: string, generation: number, envelopeFile: string): string {
	for (let ordinal = 1; ; ordinal += 1) {
		const quarantined = paths.invalidEnvelopeFile(jobId, generation, ordinal);
		const target = join(home, quarantined);
		mkdirSync(dirname(target), { recursive: true });
		try {
			linkSync(envelopeFile, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		unlinkSync(envelopeFile);
		return quarantined;
	}
}

/**
 * Add a receipt unless the job already carries the same one. Identity is
 * kind + url (a PR is its url) or kind + title (an artifact is its file): a
 * second envelope for the same delivery must not double the receipts a
 * `Shipped` row is rendered from.
 */
function mergeReceipt(receipts: Receipt[], receipt: Receipt): void {
	const same = receipts.some((existing) =>
		existing.kind !== receipt.kind
			? false
			: receipt.url
				? existing.url === receipt.url
				: existing.title === receipt.title,
	);
	if (!same) receipts.push(receipt);
}

/** One operator line. The summary is a headline by contract, so it can travel. */
export function formatIntake(result: IntakeResult): string {
	if (!result.accepted) {
		if (result.correction) {
			return (
				`${result.job_id}: envelope refused and quarantined at ${result.correction.quarantined} — ` +
				`${result.correction.reason}\n  The report slot for generation ${result.correction.generation} is open ` +
				"for exactly one corrected report; nothing was deleted."
			);
		}
		return result.failure ? `${result.job_id}: ${result.failure.class} — ${result.failure.message}` : `${result.job_id}: no envelope yet`;
	}
	const generation = result.generation !== undefined && result.generation > 1 ? ` [generation ${result.generation}]` : "";
	const parts = [
		`${result.job_id} reported ${result.status}`,
		`(${result.kind}/${result.delivery})`,
		`→ ${result.next}${generation}`,
	];
	const blockers = formatBlockers(result);
	const showArtifact = result.artifact && result.next !== "answer" && result.next !== "escalate";
	const artifact = showArtifact && result.artifact ? `\n  artifact: ${result.artifact.path} (${result.artifact.bytes} bytes, unread)` : "";
	const pr = result.receipts?.find((receipt) => receipt.kind === "pr");
	const prNote = result.pr_url_note ? `\n  ${result.pr_url_note}` : "";
	const escalated =
		result.next === "escalate"
			? `\n  escalated${result.escalation_id ? ` ${result.escalation_id}` : ""} (loop exhausted): do not answer these blockers; relay the escalation.`
			: "";
	return `${parts.join(" ")}\n  ${result.summary}${pr?.url ? `\n  PR: ${pr.url}` : ""}${prNote}${result.board_url ? `\n  board: ${result.board_url}` : ""}${artifact}${escalated}${blockers}`;
}

/** Planner blockers travel verbatim. Strings stay the one-line join they always were. */
function formatBlockers(result: IntakeResult): string {
	if (!result.blockers?.length) return "";
	if (result.blockers.every((item) => typeof item === "string")) {
		return `\n  blockers: ${result.blockers.join("; ")}`;
	}
	return `\n  blockers:\n${JSON.stringify(result.blockers, null, 2)}`;
}
