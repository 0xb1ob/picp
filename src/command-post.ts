/**
 * Composition root.
 *
 * Every module in `src/` is independently testable and knows nothing about pi.
 * This is where they are wired into one object for the parent extension, so the
 * extension file stays a thin adapter: tools in, policy out.
 *
 * Configuration that an operator can edit at runtime (`data/routing.json`,
 * `data/budgets.json`) is re-read per operation rather than cached at load: a
 * command post that must be restarted to notice a config change is a command
 * post nobody edits.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AnswerCardOutbox, type AnswerCardDueOptions, type AnswerCardSink } from "./answer-delivery.ts";
import { AnsweredOutbox } from "./answered.ts";
import { boundedWakeupId, type DurableWakeupInput, DurableWakeupOutbox } from "./wakeup-outbox.ts";
import { observeMandateUsage } from "./mandate-usage.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AwaitingStore, mergeAwaiting, type ResolvedAwaitingItem } from "./awaiting.ts";
import { ghCiConfigured } from "./ci-configured.ts";
import { CiWatch, type CiWatchTick, ghPrRest, type WatchableRecord } from "./ci-watch.ts";
import {
	buildDecisionContext,
	type BuildDecisionContextOptions,
	type DecisionContext,
	EMPTY_DECISION_CONTEXT,
	readDecisionEvidence,
} from "./decision-context.ts";
import { ShippedSeenStore } from "./shipped-seen.ts";
import {
	createMergeAskProbe,
	ghCiRuns,
	gitRemoteHead,
	MERGE_ASK_QUERY_TIMEOUT_MS,
	MergeAskJobGoneError,
	type MergeAskMergedEvidence,
	type MergeAskProbe,
	readReviewPassHeads,
	runCommand,
} from "./merge-ask.ts";
import { holdsParentLock } from "./parent-lock.ts";
import { lastFiledEnvelopeFile } from "./supersede.ts";
import {
	type AnsweredDecision,
	type BudgetConfig,
	BudgetConfigSchema,
	type AnswerCardRecord,
	ContractError,
	DEFAULT_BUDGET_CONFIG,
	isoTimestamp,
	isScriptFleetRecord,
	LAYOUT,
	paths,
	type DoctorReport,
	type StatusSnapshot,
	validate,
} from "./contracts.ts";
import { CapacityReader } from "./capacity.ts";
import { DiffReview, type DiffReviewRequest, type DiffReviewStart } from "./diff-review.ts";
import { formatReviewFinishFailure, type OrphanReport, ReviewRuns, type ReviewWakeup } from "./review-runs.ts";
import { ReviewApprovalStore } from "./review-approval.ts";
import { Dispatcher, type DispatchPreview, type DispatchRequest, type DispatchResult } from "./dispatch.ts";
import type { ScriptDispatchResult, ScriptPreview } from "./script-dispatch.ts";
import { Doctor, type DoctorOptions } from "./doctor.ts";
import type { RecordedSessionTool } from "./session-tools.ts";
import { FleetStore, type ReconcileOptions, type ReconcileReport } from "./fleet.ts";
import { boundContinueNext, HardBoundsWatch } from "./bounds.ts";
import { boundWakeupId, deathWakeupId, FailureAnnouncer, type FailRecoveryFact } from "./failure-announcer.ts";
import { homeProjectResolver } from "./project-report.ts";
import { formatRecoveryNotice } from "./wakeups.ts";
import { assertNotDraining, DrainControl, sweepDurableWakeups as sweepDurableWakeupsHelper } from "./drain.ts";
import { type Checkpoint, type DurableWakeupEntry, type Failure, type FleetRecord, type PipelineRecord, type Runtime, type UnreportedWork, type Usage } from "./contracts.ts";
import { FailureMonitor } from "./failures.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { MandateStore } from "./mandate.ts";
import { EscalationStore } from "./escalation.ts";
import { Gate, type GateRequest, type GateStart } from "./gate.ts";
import { ContextGuard, type GuardDecision, type GuardRequest } from "./guards.ts";
import {
	type AdvanceResult,
	type Authorizer,
	PipelineRunner,
	PipelineStore,
	type StartRequest,
	type StartResult,
} from "./pipeline.ts";
import { loadQualityConfig, QualityPass } from "./quality.ts";
import { EnvelopeIntake, type IntakeResult } from "./intake.ts";
import { LeaseManager, resolvePoolRoot } from "./leases.ts";
import {
	archiveEntry,
	type ArchiveResult,
	captureCandidate,
	type CaptureResult,
	ensureMemoryScaffold,
	memoryStatus,
	type MemoryStatus,
	type ScaffoldResult,
	sessionStartDigest,
} from "./memory.ts";
import {
	curationPlan,
	type CurationPlan,
	type CurationRecord,
	promoteCandidate,
	type PromoteOptions,
	type PromoteResult,
	readCurationLog,
	rejectCandidate,
	type RejectOptions,
	type RejectResult,
	retireLearning,
	type RetireOptions,
	type RetireResult,
	traceLearning,
} from "./curation.ts";
import { Ledger } from "./ledger.ts";
import { type IntegrateRequest, type IntegrateResult, Integrator } from "./integrate.ts";
import { HeldContinuation } from "./held-continuation.ts"; import { makeHandoff } from "./human-handoff.ts";
import { MergeStore, type RecordMergeRequest, type RecordMergeResult } from "./merges.ts";
import { Preflight } from "./preflight.ts";
import { ProjectRegistry } from "./projects.ts";
import { Reviver, type ReviveResult, type RevivePlanResult } from "./revive.ts";
import { ALWAYS_AVAILABLE, isAllowed, loadRoutingConfig, type ModelProbe, type PiModelRegistryLike, registryProbe } from "./routing.ts";
import { loadSuggestConfig } from "./suggest.ts";
import { SUGGEST_DEFAULT_MODEL, type SuggestConfig } from "./contracts.ts";
import { type Asker, QuestionRelay } from "./questions.ts";
import { type PlanTarget, type ResolvePlanOptions, resolvePlanTarget } from "./plan-view.ts";
import { BoundedRecovery } from "./recovery.ts";
import { RunRegistry } from "./runs.ts";
import { Sender, type SendRequest, type SendResult } from "./send.ts";
import { SettleWatcher, type SettleOutcome } from "./settle.ts";
import { StatusReporter, type StatusQuery } from "./status.ts";
import { viewerAddress } from "./viewer/cli.ts";
import { Teardown, type TeardownCallOptions, type TeardownResult } from "./teardown.ts";
import { type RenderOptions, RunWatcher, type RunView } from "./watch.ts";
import { type DrainProjection, WorkerManager } from "./worker-manager.ts";
import { tryResolveWorkerPackages } from "./worker-packages.ts";
import { idleBeadObserver, readReadyBeads } from "./ready-beads.ts";
import { projectBeadsDb, TrackerStore } from "./trackers/config.ts";
import { writeBackLine } from "./trackers/link.ts";

export interface CommandPostOptions {
	/** Command post home: where `data/`, `state/` and `projects/` live. */
	home: string;
	/** Package root: where `profiles/`, `prompts/` and the worker extension live. */
	packageRoot: string;
	/**
	 * pi's model registry, for the availability probe. A **getter**, not a value:
	 * this object is built once per session but the registry arrives with
	 * whatever call happens first (a widget refresh has none, a tool call does),
	 * and a probe frozen at construction silently degrades every later check.
	 */
	modelRegistry?: () => PiModelRegistryLike | undefined;
	parentEnv?: NodeJS.ProcessEnv;
	/**
	 * The parent's wake-up transport for reviewer verdicts (spec 2026-09-05).
	 * Absent (tests, headless): the decision is on disk and nothing is sent.
	 */
	sendWakeup?: (wakeup: ReviewWakeup) => boolean;
	/**
	 * cp-runtime-deferred-recheck: awaited after a reviewer's decision is on disk
	 * and before its wake-up is sent, so a fact the verdict changed (a merge ask
	 * deferred as `green but unreviewed`) is already true when the parent reads
	 * about it. Absent leaves the delivery path exactly as it was.
	 */
	beforeWakeup?: (wakeup: ReviewWakeup) => Promise<void> | void;
	/** Held PRs advance on envelope/CI/review/startup with no model turn (the live parent sets it; tests opt in). */
	continuation?: boolean;
	/** The session's runtime; tells doctor the home's source. Absent means the default multi runtime. */
	runtime?: Runtime;
	/** Called once per accepted envelope (notify the operator, update the widget). */
	onReported?: (result: IntakeResult) => void;
	/** One evidence-only notice when the last working slot becomes idle. */
	onIdleBeads?: (text: string) => void;
	/**
	 * cp-answer-doesnt-wake: called once per *newly recorded* human answer, from
	 * whichever writer recorded it (a declared row, a derived approval row, a
	 * checkpoint authorization). The answer is already on disk and already queued
	 * in `state/answered.json` when this runs, so the callback's only job is to
	 * deliver the wake-up — and a failure to deliver costs a retry, never the
	 * decision. Absent (a test, a headless re-entry) means the answer is queued
	 * and delivered by whichever parent drains the outbox next.
	 */
	onAnswered?: (decision: AnsweredDecision) => void;
	/**
	 * Does this session own the home (pi-command-post-u9q review)? The answered
	 * outbox's **consumption** side is gated on it: only the parent that holds
	 * `state/parent.lock` may reserve an emission, send one, or stamp an arrival.
	 * Default: the lock file itself, read per call, so a session whose
	 * `acquireParentLock` was refused is gated with no wiring at all — and so is
	 * one whose lock was reclaimed while it ran.
	 *
	 * Injected only by tests, which is where a second *process* has to be played
	 * by a second object.
	 */
	holdsParentLock?: () => boolean;
	/** Called once per classified failure. */
	onFailure?: (jobId: string, failure: Failure) => void;
	/** Called after a durable wake-up is queued (death / bound / recovery). */
	onDurableWakeup?: () => void;
	/**
	 * Called when a worker settles with its envelope slot still open: once when
	 * it is nudged to report, once if the nudge is spent and the fact is recorded
	 * (cp-settle-without-report). Never carries a body — the whole problem is
	 * that no summary was written.
	 */
	onUnreportedSettle?: (jobId: string, outcome: SettleOutcome) => void;
	/** Called once when a hard bound stops a worker. */
	onHardBound?: (jobId: string, failure: Failure, work: UnreportedWork, notice: string) => void;
	/**
	 * How a pipeline asks a human to authorize implementation. Only channels a
	 * person drives may be wired here (T21): a model never answers its own
	 * checkpoint. Absent means checkpoints stay pending until `/cp-authorize`.
	 */
	authorizer?: Authorizer;
	/**
	 * How a worker asks the operator a bounded question (T31). Same rule as the
	 * authorizer: only a channel a human drives. Absent means every worker dialog
	 * fails closed, which is the pre-T31 behaviour and the default for anything
	 * headless.
	 */
	asker?: Asker;
	/**
	 * cp-gmy: the CI gate a merge ask must pass before an Awaiting-you row is
	 * raised. Injected so tests are hermetic; the default asks `gh` and `git`
	 * about the job's own project clone, once, without polling.
	 */
	mergeAsk?: MergeAskProbe;
}

export class CommandPost {
	readonly home: string;
	readonly packageRoot: string;
	readonly profilesDir: string;
	readonly briefsDir: string;
	readonly registry: ProjectRegistry;
	readonly capacity: CapacityReader;
	readonly fleet: FleetStore;
	readonly leases: LeaseManager;
	readonly preflight: Preflight;
	readonly manager: WorkerManager;
	readonly runs: RunRegistry;
	/**
	 * The one registry of pending reviewer attempts (spec 2026-09-05). Owned
	 * here, not built per call: the pending map, the handback promises and the
	 * in-flight wake-ups are process state, and a per-call registry would forget
	 * that a reviewer is running the moment the tool returned.
	 */
	readonly reviewRuns: ReviewRuns;
	readonly sender: Sender;
	readonly intake: EnvelopeIntake;
	readonly teardown: Teardown;
	/** cp-vk1: the observed-merge record the teardown gate reads. */
	readonly merges: MergeStore;
	/** cp-uug: the parent-side merge sequence, one step per call. */
	readonly integrator: Integrator;
	/** Serial, coalesced progression of held PRs; `integrate()` shares its per-project lane. */
	readonly continuation: HeldContinuation;
	readonly drain: DrainControl; // graceful drain before a restart (src/drain.ts)
	/** cp-uug: the per-PR, per-head merge authorization. Answered only by a human. */
	readonly mergeCheckpoints: CheckpointStore;
	readonly finalFixCheckpoints: CheckpointStore; // jje.3: one operator-approved fix at the review cap (src/final-fix.ts)
	readonly failures: FailureMonitor;
	readonly settle: SettleWatcher;
	readonly bounds: HardBoundsWatch;
	/** Bounded recovery without the operator (cur.4.2): one revive/redispatch per class per job, then escalation. */
	readonly recovery: BoundedRecovery;
	readonly artifacts: ArtifactStore;
	readonly guard: ContextGuard;
	readonly checkpoints: CheckpointStore;
	readonly mandates: MandateStore;
	readonly escalations: EscalationStore;
	/**
	 * The second authorization a flagged diff review raises (cp-khf), read here
	 * for the same reason `checkpoints` is: Awaiting-you derives its rows from
	 * pending checkpoints, and a decision that is not in that table is a decision
	 * that gets sat on. Same store class, same single writer, its own file.
	 */
	readonly diffCheckpoints: CheckpointStore;
	/**
	 * The pipeline records, read-only (cp-80cv). Owned here rather than reached
	 * through `pipeline()` because Awaiting-you needs the research → ship links on
	 * every render, including the widget's files-only one, and building a whole
	 * `PipelineRunner` to read two ids would drag a dispatcher and a gate into a
	 * timer tick. `PipelineRunner` keeps its own store; both are stateless views
	 * of the same directory.
	 */
	readonly pipelines: PipelineStore;
	readonly questions: QuestionRelay;
	/** The pinned approval of a plan (spec 2026-09-13, R4). */
	readonly approvals: ReviewApprovalStore;
	readonly awaiting: AwaitingStore;
	/** The durable wake-up queue for answered decisions (cp-answer-doesnt-wake). */
	readonly answered: AnsweredOutbox;
	/** Death / bound / recovery wake-ups that must survive a parent restart. */
	readonly durableWakeups: DurableWakeupOutbox;
	/**
	 * cp-6lg7: the durable queue of answer cards the operator is owed. Written at
	 * intake and read by whoever is live; deliberately independent of the job's
	 * phase, because a Q&A job is torn down seconds after it reports and every
	 * phase-keyed surface correctly calls that report history.
	 */
	readonly answerCards: AnswerCardOutbox;
	/**
	 * cp-e2d: the CI/PR watch. Built here, ticked by the extension's own slow
	 * unref'd interval — this object owns no timer; the extension starts one in
	 * every mode (TUI and `pi --mode rpc`), including when `hasUI` is false.
	 */
	readonly ciWatch: CiWatch;
	/**
	 * cp-b5eg: what the status block has already reported under Shipped, per
	 * session. Persisted rather than held in the extension's activation closure,
	 * because that closure is replaced on every extension reload — inside the same
	 * session — and losing it replays the whole session's shipped history.
	 */
	readonly shippedSeen: ShippedSeenStore;
	readonly #options: CommandPostOptions;
	readonly #announcer: FailureAnnouncer;

	constructor(options: CommandPostOptions) {
		this.#options = options;
		this.home = options.home;
		this.packageRoot = options.packageRoot;
		this.profilesDir = join(options.packageRoot, "profiles");
		this.briefsDir = join(options.packageRoot, "prompts/briefs");
		this.registry = new ProjectRegistry({ home: options.home });
		const observeIdle = options.onIdleBeads ? idleBeadObserver(
			() => readReadyBeads(this.registry, this.ledger()), options.onIdleBeads, () => this.fleet.read().jobs,
		) : undefined;
		this.fleet = new FleetStore({ home: options.home, ...(observeIdle ? {
			onChanged: (before, after) => { void observeIdle(before, after).catch((error) => {
				process.stderr.write(`idle bead notice failed: ${String(error)}\n`);
			}); },
		} : {}) });
		this.capacity = new CapacityReader({ home: options.home, env: options.parentEnv ?? process.env, fleet: this.fleet });
		// cp-epy2 §4.2: the pool root is per home, read from the environment this
		// parent was started with. `resolvePoolRoot` omits the key when nothing is
		// set, so a single-home machine's argv is unchanged.
		this.leases = new LeaseManager({
			home: options.home,
			...resolvePoolRoot(options.parentEnv ?? process.env),
		});
		this.preflight = new Preflight({ registry: this.registry, fleet: this.fleet });
		this.runs = new RunRegistry(options.home);
		this.reviewRuns = new ReviewRuns({
			home: options.home,
			runs: this.runs,
			...(options.sendWakeup ? { wakeup: options.sendWakeup } : {}),
			beforeWakeup: async (wakeup) => {
				await options.beforeWakeup?.(wakeup);
				await this.continuation.onVerdict(wakeup);
			},
			// A finish with no safe cp-verdict must not leave a held PR silently waiting: one durable notice per attempt.
			onFinishFailure: (pending, reason) => this.#journalDurable({
				id: boundedWakeupId(`review-finish:${pending.job_id}:${pending.surface}:${pending.attempt}:${pending.started_at}`),
				kind: "recovery", job_id: pending.job_id, keys: [pending.job_id], content: formatReviewFinishFailure(pending, reason),
			}),
		});
		// T31: the relay is built before the manager, because the manager decides per
		// spawn whether a worker may reach a human. An exchange is journaled and teed
		// into the run log; neither ever reaches this process's LLM context.
		this.approvals = new ReviewApprovalStore(options.home);
		this.questions = new QuestionRelay({
			home: options.home,
			...(options.asker ? { asker: options.asker } : {}),
			onEvent: (jobId, kind, payload) => {
				this.runs.open(jobId).cp(kind, payload);
			},
		});
		// Both pass a getter, not a snapshot: `this.budgets()` re-reads
		// data/budgets.json every time it is called (see the file header), and a
		// value captured once here at construction would defeat that — a raise
		// made after this CommandPost was built (i.e. after the parent session
		// started) would then need a parent restart to take effect (cp-sr5).
		this.manager = new WorkerManager({
			home: options.home,
			workerReporterPath: join(options.packageRoot, "extensions/worker-reporter/index.ts"),
			budget: () => this.budgets(),
			questions: this.questions,
			// Optional and detected, never required: an empty result changes nothing
			// about the argv a worker is spawned with (cp-5hui). This is availability;
			// the manager decides activation per role and profile.
			// Resolved once through pi's package manager; every spawn path awaits
			// `manager.ready()`, and a failed resolution is logged on the run.
			optionalPackages: tryResolveWorkerPackages(),
			recordEvent: (jobId, kind, payload) => { this.runs.open(jobId).cp(kind, payload); },
			...(options.parentEnv ? { parentEnv: options.parentEnv } : {}),
		});
		this.mandates = new MandateStore(options.home);
		this.sender = new Sender({ fleet: this.fleet, manager: this.manager, runs: this.runs, home: options.home, budgets: () => this.budgets(), mandates: this.mandates, onPromptDelivered: (jobId) => this.bounds.rearm(jobId) });
		// cp-6lg7: the answer card is queued **before** anyone is told anything. It
		// is built here, ahead of intake, because intake's `onReported` is what feeds
		// it and a card that is only queued when a live extension happens to be
		// listening is exactly the card that got lost.
		this.answerCards = new AnswerCardOutbox({ home: options.home });
		this.durableWakeups = new DurableWakeupOutbox({ home: options.home });
		this.#announcer = new FailureAnnouncer({
			fleet: this.fleet,
			journal: (input) => this.#journalDurable(input),
		});
		const viewerEnv = options.parentEnv ?? process.env;
		// pi-command-post-1jz: `viewerAddress` silently falls back to loopback when
		// CP_VIEWER_HOST is unset, so resolving the host eagerly here would hand
		// every job a default that may not be where the viewer actually binds.
		// Only the port is resolved (and validated) up front; the host is passed
		// through as-is (undefined when not explicitly configured) so intake's own
		// board-delivery resolution can require the tailnet address instead.
		const viewerPort = viewerAddress(viewerEnv).port;
		const viewerHost = viewerEnv.CP_VIEWER_HOST;
		this.intake = new EnvelopeIntake({
			home: options.home,
			viewerHost,
			viewerPort,
			fleet: this.fleet,
			runs: this.runs,
			// pi-command-post-fbn: intake resolves a ship/pr envelope's PR from the project's
			// origin remote and gh, so a worker's typo cannot become the stored PR url that
			// the CI watch, cp_integrate and cp_merged all key on.
			originUrl: (project) => this.registry.originUrl(project),
			// The queue write comes first and never throws into intake: an envelope
			// that is accepted must stay accepted, and a card that could not be
			// queued is reported by the drain that finds nothing rather than by
			// failing the report that earned it.
			onReported: (result) => {
				this.#queueAnswerCard(result);
				options.onReported?.(result);
				this.continuation.onEnvelope(result);
			},
			escalations: () => this.escalations,
			fail: (jobId, failure) => this.fail(jobId, failure),
			onFailure: (jobId, failure) => {
				this.#options.onFailure?.(jobId, failure);
			},
		});
		this.teardown = new Teardown({
			home: options.home,
			fleet: this.fleet,
			leases: this.leases,
			manager: this.manager,
			runs: this.runs,
			ledger: () => this.ledger(),
			journal: (input) => this.#journalDurable(input),
		});
		// cp-vk1: `cp_merged` writes here and the ship gate reads it, which is how
		// "confirm the PR merged" stopped being advice with no mechanism behind it.
		this.merges = new MergeStore({ home: options.home, fleet: this.fleet, runs: this.runs });
		this.failures = new FailureMonitor({
			home: options.home,
			fleet: this.fleet,
			runs: this.runs,
			intake: this.intake,
			fail: (jobId, failure, notice, recovery) => this.fail(jobId, failure, notice, recovery),
			// cur.4.2 review, finding 2: the true attempted/attemptsLeft facts, known
			// before the actual attempt runs (see `BoundedRecovery.previewDecision`).
			recoveryFact: (jobId, failure) => this.recovery.previewDecision(jobId, failure),
			closing: () => this.manager.closing,
			onFailure: (jobId, failure) => {
				this.#options.onFailure?.(jobId, failure);
				// cur.4.2: one automatic revive per failure class per job, no operator
				// message on success; escalates on its own when the bound is spent.
				void this.recovery
					.onDeath(jobId, failure)
					.then((outcome) => {
						// cur.4.2 review, finding 2: the death wake-up `fail` just journaled was
						// necessarily written before this was known \u2014 a job that got its one
						// automatic revive must not sit in front of the parent looking like one
						// that needs `cp_teardown`/`cp_revive` by hand.
						if (outcome.action === "revived") this.#retractFailureWakeup("death", jobId, failure);
					})
					.catch(() => {
						// Bounded recovery must never take the failure monitor down with it.
					});
			},
		});
		// cp-settle-without-report: the settle boundary, not a parent-side poll.
		// It shares intake so "did it report?" is answered from disk, once.
		this.settle = new SettleWatcher({
			fleet: this.fleet,
			runs: this.runs,
			intake: this.intake,
			fail: (jobId, failure) => this.fail(jobId, failure),
			shutdown: (jobId) => this.manager.shutdown(jobId), // cp-mub7: a model-call failure stops its worker
			...(options.onUnreportedSettle ? { onUnreported: options.onUnreportedSettle } : {}),
		});
		this.escalations = new EscalationStore({
			home: options.home,
			checkpoints: () => this.checkpoints,
			awaiting: () => this.awaiting,
		});
		// cur.4.4: `this.bounds` before `this.recovery` (reversed from cur.4.2) so a
		// `redispatch`'s fresh worker can be wired into it directly \u2014 `onBreach`'s
		// own reference to `this.recovery` stays a closure either way and does not
		// care about construction order.
		this.bounds = new HardBoundsWatch({
			fleet: this.fleet,
			runs: this.runs,
			fail: (jobId, failure, notice, recovery) => this.fail(jobId, failure, notice, recovery),
			shutdown: (jobId) => this.manager.shutdown(jobId), closing: () => this.manager.closing,
			// zh7.4: the bound wake-up waits for recovery's outcome \u2014 a notice written
			// before it could only guess, and a delivered guess cannot be retracted.
			deferNotice: true,
			onBreach: (jobId, failure, work, notice) => {
				options.onHardBound?.(jobId, failure, work, notice);
				// cur.4.2: a hard bound is a recoverable class once (the worktree is
				// untouched, the process already stopped). `onBound` escalates on its
				// own once the bound is spent (or when risk:high applies). `settleBound`
				// announces nothing on a revive or beside a live replacement, and
				// catches a rejected attempt itself, announcing it as operational.
				void this.recovery
					.settleBound(jobId, failure, work, (fact) =>
						this.#announcer.announce(jobId, failure, `${notice}\n${boundContinueNext(jobId)}`, fact),
					)
					.catch((error: unknown) => {
						// Only the journal write itself can land here; leave its trace in the run log.
						try {
							this.runs.open(jobId).cp("recovery_failed", { class: failure.class, stage: "announce", error: String(error) });
						} catch {
							// Nothing left to write to; the fleet record still says failed.
						}
					});
			},
		});
		// cur.4.2: bounded recovery without the operator. Wired after every watcher
		// it observes a redispatched worker through (cur.4.4): a `redispatch`'s
		// fresh worker gets the exact same intake/settle/failures/bounds wiring
		// `this.reviver()` gives a revived one \u2014 built per call there, taken as a
		// live value here since this home's watchers never change after construction.
		this.recovery = new BoundedRecovery({
			home: options.home,
			fleet: this.fleet,
			runs: this.runs,
			escalations: this.escalations,
			reviver: () => this.reviver(),
			sender: {
				send: async (jobId, message) => {
					const result = await this.sender.send({ jobId, message, mode: "prompt" });
					return { receipt: result.receipt, ...(result.error ? { error: result.error } : {}) };
				},
			},
			manager: this.manager,
			profilesDir: this.profilesDir,
			...this.#observers(),
		});
		// An artifact may only be filed against a job this home actually knows —
		// a fleet record, or a run directory dispatch already created for it.
		this.artifacts = new ArtifactStore({
			home: options.home,
			knowsJob: (jobId) => this.knowsJob(jobId),
		});
		this.guard = new ContextGuard({ home: options.home, artifacts: this.artifacts, leases: () => this.fleet.list().filter((job) => job.phase !== "done").map((job) => job.worktree) });
		// cp-answer-doesnt-wake: the outbox is built before the two writers that feed
		// it, and every writer gets the same sink — a recorded answer is queued in the
		// same tick it is recorded, whichever surface recorded it.
		this.answered = new AnsweredOutbox({ home: options.home });
		this.checkpoints = new CheckpointStore(options.home, { onAnswered: (decision) => this.#recordAnswered(decision) });
		this.pipelines = new PipelineStore(options.home);
		// cp-khf: the diff checkpoint wakes the parent exactly like the ship one. It
		// could not before, because the wake-up carried a hardcoded
		// `aw-checkpoint-<ship-id>` that names the *other* row; the id is kind-aware
		// now (`checkpointAwaitingId`), so one decision still has one identity.
		this.diffCheckpoints = new CheckpointStore(options.home, {
			kind: "diff",
			onAnswered: (decision) => this.#recordAnswered(decision),
		});
		// cp-uug/cp-e0c: the merge checkpoint, kept as the named fallback for a merge
		// `cp_integrate` cannot read the repository's own verdict on (an unreadable
		// mergeStateStatus, or CI with no observable runs at all). Same store, same
		// one writer (`decide`), its own kind — a job can hold a ship, a diff and a
		// merge authorization at once, and `decide()` refuses to overwrite an answer,
		// so they cannot share a file. Merge authority is otherwise repo-derived
		// (cp-x7i, answered): never a standing grant a human can widen in chat.
		this.mergeCheckpoints = new CheckpointStore(options.home, {
			kind: "merge",
			onAnswered: (decision) => this.#recordAnswered(decision),
		});
		this.finalFixCheckpoints = new CheckpointStore(options.home, { kind: "final_fix", onAnswered: (decision) => this.#recordAnswered(decision) });
		// cp-uug/cp-e0c: the merge sequence, parent-side. It spawns nothing, polls
		// nothing and never writes to a branch: `gh pr update-branch` is server-side,
		// and a conflict goes back to the job's own implementer through the sender
		// below. `awaiting` is a thunk, not a value: `this.awaiting` is built after
		// this object, and the "merge pending" reminder (cp-e0c) needs the live store.
		this.integrator = new Integrator({
			home: options.home,
			fleet: this.fleet,
			merges: this.merges,
			teardown: this.teardown,
			ledger: () => this.ledger(),
			projectDir: (project, worktree) => {
				const clone = this.registry.pathOf(project);
				if (existsSync(clone)) return clone;
				return worktree && existsSync(worktree) ? worktree : this.home;
			},
			runs: this.runs,
			send: async (jobId, message) => {
				const result = await this.sender.send({ jobId, message, purpose: "repair" });
				return { receipt: result.receipt, ...(result.error ? { error: result.error } : {}) };
			},
			awaiting: () => this.awaiting,
			handoff: makeHandoff({ registry: this.registry, awaiting: () => this.awaiting, runs: this.runs }), // merge_policy by record.project through this registry; no fleet lookup
		});
		this.drain = new DrainControl({ home: options.home, fleet: this.fleet, busy: () => this.manager.quiesce().busy, head: (jobId) => this.reportedHeadSha(jobId), owns: () => this.#ownsHome(),
			// Not #journalDurable: an enqueue failure must reach DrainControl.check, which retries on the next tick.
			journal: (wake) => { if (this.durableWakeups.enqueue({ ...wake, id: boundedWakeupId(wake.id), kind: "recovery" })) this.#options.onDurableWakeup?.(); },
			discard: (ids) => this.durableWakeups.discard(ids.map((id) => ({ id: boundedWakeupId(id), reason: "the parent restarted after the drain" }))) });
		this.continuation = new HeldContinuation({
			enabled: () => options.continuation === true && this.#ownsHome(),
			fleet: this.fleet,
			advance: (jobId) => this.#advance({ jobId }),
			review: (jobId) => this.diffReview({ jobId }),
			reviews: this.reviewRuns,
			head: (jobId, owner) => (owner === "fleet" ? this.reportedHeadSha(jobId) : this.ciHead(jobId)),
			notify: (notice) => this.#journalDurable({ ...notice, kind: "recovery" }),
			runs: this.runs,
			writeBack: (jobId) => writeBackLine(options.home, () => this.ledger(), () => new TrackerStore({ home: options.home, registry: this.registry }).list(), jobId),
		});
		this.awaiting = new AwaitingStore({
			home: options.home,
			onAnswered: (decision) => this.#recordAnswered(decision),
			mergeAsk: options.mergeAsk ?? this.#defaultMergeAsk(),
		});
		// cp-e2d: the one thing in this process that asks a third-party server a
		// question on a timer. Its facts come from the same two REST queries the
		// merge-ask gate already uses (`gh run list`, plus one `gh api pulls/{n}`),
		// and it never merges, declares or tears anything down.
		this.shippedSeen = new ShippedSeenStore({ home: options.home });
		this.ciWatch = new CiWatch({
			home: options.home,
			jobs: () => this.fleet.list() as WatchableRecord[],
			pr: async (job, prUrl) => ghPrRest({ cwd: this.#clonePath(job.job_id) })(prUrl),
			runs: async (job) => ghCiRuns({ cwd: this.#clonePath(job.job_id) })(job.branch),
			head: async (job) =>
				gitRemoteHead({ cwd: this.#clonePath(job.job_id), fallback: (id) => this.reportedHeadSha(id) })(
					job.branch,
					job.job_id,
				),
			onObserved: (jobId, observation) => {
				try {
					this.runs.open(jobId).cp("ci_observed", {
						job_id: jobId,
						event: observation.event,
						head_sha: observation.head_sha,
						reason: observation.reason,
						...(observation.pr_url ? { pr_url: observation.pr_url } : {}),
						...(observation.merge_commit_sha ? { merge_commit_sha: observation.merge_commit_sha } : {}),
					});
				} catch {
					// A run log that cannot be written must never swallow a wake-up.
				}
				this.continuation.onCi(jobId, observation);
			},
		});
	}

	/**
	 * The startup truth pass, and the one action it implies
	 * (pi-command-post-3ip).
	 *
	 * `FleetStore.reconcile` classifies; it never stamps. Nothing used to act on
	 * its `needs_intake` list, and intake ran only from a live worker's event
	 * stream — so a worker that wrote `envelope.json` and then lost its parent
	 * (a restart kills every child) left a delivery on disk that no surface would
	 * ever accept: the ledger stayed `in_progress`, the fleet stayed `waiting`,
	 * the settle boundary correctly refused to nudge a job that had reported, and
	 * the worker-reporter correctly refused to file a second envelope. Every gate
	 * was right and the job was stuck.
	 *
	 * So the reconcile step ends where the live path does: `intake`, once per
	 * unstamped envelope. It is the ordinary intake, not a restart-only variant —
	 * same contract re-check, same generation scoping (a superseded envelope's
	 * slot is the live one's, never both), same `onReported` wake-up, same
	 * stat-and-move for artifacts, so no body is ever read here. It is idempotent
	 * by construction: an already-stamped generation returns `already` and writes
	 * nothing, which is what makes a second restart a no-op.
	 *
	 * Fail-closed and never throws: an envelope that violates the contract is
	 * marked `failed` by intake with its own reason, and an intake that throws is
	 * returned as a `failure` on the job it concerns rather than taking the rest
	 * of the startup pass down with it.
	 */
	async reconcile(options: ReconcileOptions = {}): Promise<{ report: ReconcileReport; intake: IntakeResult[] }> {
		const report = await this.fleet.reconcile(options);
		const results: IntakeResult[] = [];
		for (const jobId of report.needs_intake) {
			try {
				results.push(await this.intake.intake(jobId));
			} catch (error) {
				const record = this.fleet.get(jobId);
				results.push({
					job_id: jobId,
					accepted: false,
					already: false,
					phase: record?.phase ?? "waiting",
					failure: {
						class: "envelope_invalid",
						message:
							`${join(this.home, record && isScriptFleetRecord(record) ? paths.scriptResultFile(jobId) : paths.envelopeFile(jobId))} is on disk but intake could not stamp it: ` +
							`${error instanceof Error ? error.message : String(error)} — the work is not lost; fix the cause and ` +
							"restart, or tear the job down deliberately.",
						at: isoTimestamp(new Date()),
					},
				});
			}
		}
		this.#journalRecovery(report);
		await this.teardown.retryLedgerCloses();
		this.drain.startup();
		return { report, intake: results };
	}

	/** The job's project clone: where `gh` and `git` are asked about its branch. */
	#clonePath(jobId: string): string {
		const job = this.fleet.get(jobId);
		if (!job) throw new ContractError(`no fleet record for ${jobId}`);
		const dir = this.registry.pathOf(job.project);
		if (!existsSync(dir)) throw new ContractError(`${job.project} has no clone at ${dir}`);
		return dir;
	}

	/**
	 * One pass of the CI/PR watch (cp-e2d). Returns the facts that are new and
	 * still unconfirmed; the caller sends them as one coalesced `cp-ci` wake-up
	 * and confirms arrival with `confirmCi`. Nothing is marked announced here —
	 * sent is not delivered.
	 */
	async ciTick(): Promise<CiWatchTick> {
		return this.ciWatch.tick();
	}

	/** jje.2: a CI/PR watch tick that threw is journaled durably (state/wakeups.json), once per cause. */
	ciWatchFailed(error: unknown): void {
		const cause = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300) || "no message";
		const content = `CI/PR WATCH TICK FAILED — ${cause}\n  The watch keeps ticking and re-derives every unconfirmed fact; held PRs may wake you late until this clears.`;
		this.#journalDurable({ id: boundedWakeupId(`ci-watch-failed:${cause}`), kind: "recovery", content });
	}

	/** Evidence that a `cp-ci` wake-up reached the parent: the keys it carried. */
	confirmCi(keys: readonly string[]): string[] {
		return this.ciWatch.confirm(keys);
	}

	/**
	 * The branch head the watcher last observed for a job, from its own state
	 * file. Files-only: `reviewWakeups` calls this on every provider request.
	 */
	ciHead(jobId: string): string | undefined {
		return this.ciWatch.head(jobId);
	}

	/**
	 * When that observation was taken (pi-command-post-b04). The head alone says
	 * nothing about whether it is current: `headMoved` compares this against the
	 * moment the fleet recorded its own head, and the later reading wins.
	 */
	ciHeadObservedAt(jobId: string): string | undefined {
		return this.ciWatch.observedAt(jobId);
	}

	/**
	 * The default merge-ask gate (cp-gmy): the branch's current pushed head from
	 * the remote, and one `gh run list` for that branch, in the job's own project
	 * clone. Every lookup is per call, because a gate that caches is a gate that
	 * defers an ask on facts that stopped being true.
	 */
	#defaultMergeAsk(): MergeAskProbe {
		const dirFor = (jobId: string): string => {
			const job = this.fleet.get(jobId);
			// cp-to39: "the job is gone" is a distinct cause, not a clone/gh failure.
			// A torn-down job must not become an unanswerable merge ask, so the probe
			// needs to tell this apart from an unreachable `gh` — which still raises.
			if (!job) throw new MergeAskJobGoneError(jobId);
			const dir = this.registry.pathOf(job.project);
			if (!existsSync(dir)) throw new ContractError(`${job.project} has no clone at ${dir}`);
			return dir;
		};
		return createMergeAskProbe({
			branch: (jobId) => this.fleet.get(jobId)?.branch ?? jobId,
			// cp-p1sh: the job's own merge receipt — a local file, written only for a PR
			// `gh pr view` reported as MERGED, so it is evidence and not a claim. Read
			// first and read locally: a merge that already landed must not wait on `gh`
			// to be noticed, and no network call belongs on a render path that a local
			// fact already answers.
			merged: (jobId) => this.#mergedEvidence(jobId),
			// cp-1som: the heads a diff review has passed on, from this home's own
			// review files. Local, so it costs the render path nothing, and it is the
			// same evidence `cp_review` writes — never a claim about one.
			reviewedHeads: (jobId) => readReviewPassHeads(this.home, jobId),
			head: async (branch, jobId) =>
				gitRemoteHead({ cwd: dirFor(jobId), fallback: (id) => this.reportedHeadSha(id) })(branch, jobId),
			runs: async (branch, jobId) => ghCiRuns({ cwd: dirFor(jobId) })(branch),
			// cp-no-ci-repo-derived: asked only when the branch has no runs at all, and
			// only ever able to *unblock* a row — an unreadable answer defers exactly as
			// zero runs always did. Without it a project with no CI defers its ship row
			// forever, waiting on a run that will never exist.
			ciConfigured: async (jobId) =>
				(await ghCiConfigured({ cwd: dirFor(jobId), exec: runCommand, timeoutMs: MERGE_ASK_QUERY_TIMEOUT_MS })()).state,
		});
	}

	/**
	 * What this home has already observed about a job's merge (cp-p1sh), or
	 * `undefined` when it has observed nothing. Total by construction:
	 * `MergeStore.get` treats an unreadable or contract-violating file as *no
	 * receipt*, which is the right reading here too — an unreadable merge state is
	 * ignorance, never "merged".
	 */
	#mergedEvidence(jobId: string): MergeAskMergedEvidence | undefined {
		const receipt = this.merges.get(jobId);
		if (!receipt) return undefined;
		return {
			merge_commit_sha: receipt.merge_commit_sha,
			...(typeof receipt.pr_number === "number" ? { pr_number: receipt.pr_number } : {}),
			...(receipt.pr_url ? { pr_url: receipt.pr_url } : {}),
			...(receipt.head_sha ? { head_sha: receipt.head_sha } : {}),
			...(receipt.merged_at ? { merged_at: receipt.merged_at } : {}),
		};
	}

	/**
	 * The head sha a ship worker reported (cp-kzc), if it filed one. Used only as
	 * a fallback when the remote cannot be reached: the remote is authoritative
	 * about what is pushed *now*.
	 */
	reportedHeadSha(jobId: string): string | undefined {
		return this.#reportedHead(jobId)?.sha;
	}

	/**
	 * When that head was recorded: the envelope's `received_at`
	 * (pi-command-post-b04). The fleet knows only the head a worker *reported*,
	 * so this is what tells a later CI observation apart from a lagging one.
	 */
	reportedHeadAt(jobId: string): string | undefined {
		return this.#reportedHead(jobId)?.at;
	}

	#reportedHead(jobId: string): { sha: string; at?: string } | undefined {
		const job = this.fleet.get(jobId);
		const file = job ? lastFiledEnvelopeFile(this.home, job) : undefined;
		if (!file || !existsSync(file)) return undefined;
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as { received_at?: string; envelope?: { head_sha?: string } };
			const sha = record.envelope?.head_sha;
			if (!sha) return undefined;
			return { sha, ...(typeof record.received_at === "string" ? { at: record.received_at } : {}) };
		} catch {
			return undefined;
		}
	}

	#journalDurable(input: {
		id: string;
		kind: "death" | "bound" | "recovery";
		job_id?: string;
		content: string;
		keys?: string[];
		generation?: number;
	}): void {
		try {
			if (!this.durableWakeups.enqueue(input)) return;
		} catch {
			return;
		}
		this.#options.onDurableWakeup?.();
	}

	/**
	 * Retract a death/bound wake-up `fail` already journaled, once bounded
	 * recovery resolves the same occurrence with `action: "revived"` (cur.4.2
	 * review, finding 2). Reconstructs the exact id `FailureAnnouncer#announce`
	 * computed \u2014 `discard` is a no-op on an id that is not (still) pending, so a
	 * wake-up already delivered, or one this recovery attempt did not itself
	 * produce, is left alone.
	 */
	#retractFailureWakeup(kind: "death" | "bound", jobId: string, failure: Failure): void {
		const id = kind === "bound" ? boundWakeupId(jobId, failure.class, failure.at) : deathWakeupId(jobId, failure.at);
		try {
			this.durableWakeups.discard([{ id, reason: "bounded recovery revived the job automatically" }]);
		} catch {
			// A retraction that fails to write must not take the recovery down with it;
			// the parent may see a stale wake-up once, which is what this exists to
			// reduce, not a new failure mode.
		}
	}

	/** The only failed transition. Journals a durable wake-up in the same step. */
	fail(jobId: string, failure: Failure, notice?: string, recovery?: FailRecoveryFact | "defer"): Promise<FleetRecord> {
		return this.#announcer.fail(jobId, failure, notice, recovery);
	}

	#journalRecovery(report: ReconcileReport): void {
		const candidates = report.entries.filter(
			(entry) => entry.outcome === "failed" || entry.outcome === "revivable" || entry.outcome === "orphan",
		);
		if (candidates.length === 0) return;
		const ids = candidates.map((entry) => entry.job_id).sort();
		this.#journalDurable({
			id: boundedWakeupId(`recovery:${ids.join(",")}`),
			kind: "recovery",
			content: formatRecoveryNotice(candidates, homeProjectResolver(this.home)),
			keys: ids,
		});
	}

	/**
	 * Queue one recorded answer, then tell the live parent there is something to
	 * drain. Order matters: the durable queue first, so "no live parent" degrades
	 * to "delivered on the next drain" rather than to a lost decision.
	 */
	#recordAnswered(decision: AnsweredDecision): void {
		try {
			this.answered.enqueue(decision);
		} catch {
			// An unwritable outbox must not fail the answer that is already recorded;
			// the direct notification below is then the only delivery, which is still
			// strictly better than today's silence.
		}
		this.#options.onAnswered?.(decision);
	}

	/**
	 * Send every **due** answer through `deliver`, coalesced into one message.
	 * Called by the parent extension on an answer, at `session_start` and on the
	 * widget tick: three triggers, one drain, and no polling of anything but a
	 * file the widget already reads. A `deliver` that throws leaves the queue
	 * intact and rethrows.
	 *
	 * Due, not pending (cp-5mgg): an answer already emitted and still inside its
	 * retry window is left alone, because re-emitting it on the next answer's
	 * trigger is how one merge authorization reached the parent three times.
	 *
	 * Sending is not delivering (cp-nx7): nothing is marked delivered here. The
	 * parent confirms arrival through `confirmAnswered` when the wake-up actually
	 * lands in its context, and an unconfirmed answer is sent again.
	 */
	drainAnswered(deliver: (decisions: readonly AnsweredDecision[]) => void): AnsweredDecision[] {
		if (!this.#ownsHome()) return [];
		return this.answered.drain(deliver);
	}

	/**
	 * Evidence that a wake-up reached the parent: the ids read off the message
	 * that arrived. This is the only path that stamps `delivered_at`.
	 */
	confirmAnswered(ids: readonly string[]): string[] {
		if (!this.#ownsHome()) return [];
		return this.answered.confirmDelivered(ids);
	}

	drainDurableWakeups(deliver: (entry: DurableWakeupEntry) => void): DurableWakeupEntry[] {
		if (!this.#ownsHome()) return [];
		return this.durableWakeups.drain(deliver);
	}

	/**
	 * One sweep of due durable wake-ups.
	 * `true` — transport took the copy; stays pending until arrival confirm, retried if that never comes.
	 * string — stale suppression; discarded with that reason, not retried.
	 * throw — transport failure; entry stays pending and the next sweep retries it.
	 */
	sweepDurableWakeups(send: (entry: DurableWakeupEntry) => boolean | string): string[] {
		return sweepDurableWakeupsHelper(this.durableWakeups, () => this.#ownsHome(), send);
	}

	confirmDurableWakeups(ids: readonly string[]): string[] {
		if (!this.#ownsHome()) return [];
		return this.durableWakeups.confirmDelivered(ids);
	}

	/**
	 * Whether this session holds the parent lock — the gate on every answered
	 * outbox surface that *consumes* (pi-command-post-u9q review). Read per call
	 * and never cached: a lock can be reclaimed under a session that is still
	 * running, and a stale `true` is exactly the belief this gate exists to deny.
	 * Unreadable, absent or another pid's all read as "not ours", which is the
	 * fail-closed direction: the answer stays queued for whoever does own the
	 * home, and nothing is lost.
	 */
	#ownsHome(): boolean {
		try {
			return this.#options.holdsParentLock?.() ?? holdsParentLock({ home: this.home });
		} catch {
			return false;
		}
	}

	/**
	 * cp-6lg7: record the answer card a `delivery:answer` envelope owes the
	 * operator. Called from intake's own `onReported`, so the card exists on disk
	 * before the wake-up is built, before the parent takes a turn, and before the
	 * teardown that used to take the answer with it.
	 *
	 * A pointer only: job id, project, the envelope headline, the artifact path and
	 * its size. Nothing here opens the artifact.
	 */
	#queueAnswerCard(result: IntakeResult): void {
		if (result.delivery !== "answer" || result.status !== "done" || !result.artifact) return;
		if (!result.accepted || result.already) return;
		try {
			const project = this.fleet.get(result.job_id)?.project;
			const generation = result.generation ?? 1;
			const queued = this.answerCards.enqueue({
				job_id: result.job_id,
				...(project ? { project } : {}),
				generation,
				summary: result.summary ?? "",
				path: result.artifact.path,
				bytes: result.artifact.bytes,
				reported_at: result.reported_at ?? isoTimestamp(),
			});
			if (queued) {
				this.runs.open(result.job_id).cp("answer_card_queued", {
					generation,
					bytes: result.artifact.bytes,
					path: result.artifact.path,
				});
			}
		} catch {
			// An unwritable outbox must never fail an envelope that is already
			// accepted. The extension still surfaces this result directly, which is
			// the pre-cp-6lg7 behaviour and strictly better than a rejected report.
		}
	}

	/**
	 * Show every **due** answer card through `sink`. Called by the parent
	 * extension at intake, at `session_start` and on the widget tick: three
	 * triggers, one drain, no new poll.
	 *
	 * A sink that returns `undefined` (no operator surface in this mode) leaves
	 * the card pending — a headless re-entry into this home must not consume the
	 * answer the operator's terminal is going to show.
	 */
	drainAnswerCards(sink: AnswerCardSink, options: AnswerCardDueOptions): AnswerCardRecord[] {
		return this.answerCards.drain((record) => {
			const channel = sink(record);
			// Journaled only once the surface took it, and never allowed to fail the
			// delivery it is describing: a run directory that has been cleaned up is a
			// missing line in a log, not a card the operator does not get.
			if (channel) {
				try {
					if (existsSync(join(this.home, paths.runDir(record.job_id)))) {
						this.runs.open(record.job_id).cp("answer_card_delivered", {
							generation: record.generation,
							channel,
							queued_at: record.queued_at,
						});
					}
				} catch {
					// See above.
				}
			}
			return channel;
		}, options);
	}

	/** Does this home know the job at all? Facts only: fleet record or run dir. */
	knowsJob(jobId: string): boolean {
		try {
			if (this.fleet.get(jobId)) return true;
			return existsSync(join(this.home, paths.runDir(jobId)));
		} catch (error) {
			if (error instanceof ContractError) return false;
			throw error;
		}
	}

	/**
	 * The `tool_call` decision: `undefined` allows, anything else blocks with a
	 * model-facing reason. The parent extension is the only caller.
	 */
	checkToolCall(request: GuardRequest): GuardDecision | undefined {
		return this.guard.check(request);
	}

	/** The ledger, over this home's jobs document, with the registry gate on. */
	ledger(): Ledger {
		return new Ledger({
			home: this.home,
			knownProjects: this.registry.names(),
			archivedProjects: this.registry.archivedNames(),
			beadsDbFor: (project) => projectBeadsDb(this.home, project, () => this.registry.pathOf(project)),
		});
	}

	budgets(): BudgetConfig {
		const file = join(this.home, LAYOUT.budgetsFile);
		if (!existsSync(file)) return DEFAULT_BUDGET_CONFIG;
		let input: unknown;
		try {
			input = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new ContractError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const result = validate<BudgetConfig>(BudgetConfigSchema, input);
		if (!result.ok) {
			throw new Error(`${file} violates the budget contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	/** The live registry, or nothing. Resolved per call, never cached. */
	#registry(): PiModelRegistryLike | undefined {
		return this.#options.modelRegistry?.();
	}

	/**
	 * The availability probe. With no registry it answers "available" so that
	 * headless callers and tests are not blocked by a question they cannot ask;
	 * `doctor()` is the one caller that must distinguish "probed" from
	 * "unprobed", so it looks at the registry itself.
	 */
	probe(): ModelProbe {
		const registry = this.#registry();
		return registry ? registryProbe(registry) : ALWAYS_AVAILABLE;
	}

	/** `data/suggest.json`, re-read per call (cp-sr5's rule). Never cached. */
	suggestConfig(): SuggestConfig {
		return loadSuggestConfig(this.home);
	}

	/**
	 * The model cp-7t7's suggestion generator may use, or `undefined` when
	 * suggestions are off, the model is not allowlisted, or the probe refuses it.
	 * Resolution only — the actual one-shot call lives in
	 * `extensions/command-post/suggest-model.ts`, which is the only place that
	 * needs `ModelRegistry.complete`.
	 */
	suggestionModel(): string | undefined {
		const config = this.suggestConfig();
		if (config.enabled === false) return undefined;
		const modelRef = config.model ?? SUGGEST_DEFAULT_MODEL;
		if (!isAllowed(loadRoutingConfig(this.home), modelRef)) return undefined;
		if (!this.probe().isAvailable(modelRef)) return undefined;
		return modelRef;
	}

	dispatcher(): Dispatcher {
		return new Dispatcher({
			home: this.home,
			profilesDir: this.profilesDir,
			briefsDir: this.briefsDir,
			ledger: this.ledger(),
			registry: this.registry,
			fleet: this.fleet,
			capacity: this.capacity,
			preflight: this.preflight,
			leases: this.leases,
			manager: this.manager,
			routing: loadRoutingConfig(this.home),
			probe: this.probe(),
			runs: this.runs,
			...this.#observers(),
			mandates: this.mandates,
		});
	}

	/** One observer set for every spawn path (dispatch, revive, bounded recovery), so wiring cannot diverge. */
	#observers() {
		const usage = { fleet: this.fleet, runs: this.runs, mandates: this.mandates, journal: (input: DurableWakeupInput) => this.#journalDurable(input) };
		return { intake: this.intake, settle: this.settle, failures: this.failures, bounds: this.bounds, onUsage: (jobId: string, previous: Usage, current: Usage) => observeMandateUsage(usage, jobId, previous, current) };
	}

	async dispatch(request: DispatchRequest & { task: string }): Promise<DispatchResult>;
	async dispatch(request: DispatchRequest & { taskFile: string }): Promise<DispatchResult>;
	async dispatch(request: DispatchRequest): Promise<DispatchResult | ScriptDispatchResult>;
	async dispatch(request: DispatchRequest): Promise<DispatchResult | ScriptDispatchResult> {
		assertNotDraining(this.home, "dispatch");
		const dispatcher = this.dispatcher();
		return (await this.ledger().show(request.jobId)).script ? dispatcher.dispatchScript(request) : dispatcher.dispatch(request);
	}

	/**
	 * The route this request would take, taking nothing (routing T5). Built by
	 * `dispatcher()` like a real dispatch, so the config and the probe are the
	 * live ones and a preview can never answer from a stale policy — and, for the
	 * same reason, the dispatch that follows re-reads both rather than trusting
	 * what a preview said.
	 */
	async previewDispatch(request: DispatchRequest & { task: string }): Promise<DispatchPreview>;
	async previewDispatch(request: DispatchRequest & { taskFile: string }): Promise<DispatchPreview>;
	async previewDispatch(request: DispatchRequest): Promise<DispatchPreview | ScriptPreview>;
	async previewDispatch(request: DispatchRequest): Promise<DispatchPreview | ScriptPreview> {
		const dispatcher = this.dispatcher();
		return (await this.ledger().show(request.jobId)).script ? dispatcher.previewScript(request) : dispatcher.preview(request);
	}

	async send(request: SendRequest): Promise<SendResult> {
		return this.sender.send(request);
	}

	async tearDown(jobId: string, options: TeardownCallOptions = {}): Promise<TeardownResult> {
		return this.teardown.teardown(jobId, options);
	}

	/**
	 * Record that a job's PR landed, from what `gh` reports (cp-vk1). The honest
	 * path out of a squash-merged, head-deleted job: `force` proves nothing and
	 * says so, while a receipt is evidence the gate can read.
	 */
	async recordMerge(request: RecordMergeRequest): Promise<RecordMergeResult> {
		return this.merges.record(request);
	}

	/**
	 * One step of the merge sequence for one PR (cp-uug). Idempotent and
	 * resumable: it recomputes which step is due from git and `gh` every call, so
	 * a restarted parent picks up exactly where it stopped and a stale record can
	 * never re-merge anything. It never decides to merge — the authorization is a
	 * `CheckpointStore` record a human answers, per PR and per head sha.
	 */
	async integrate(request: IntegrateRequest): Promise<IntegrateResult> {
		return this.continuation.serialize(request.jobId, () => this.#advance(request));
	}

	#advance(request: IntegrateRequest): Promise<IntegrateResult> {
		return this.drain.track(() => this.integrator.advance(request));
	}

	/**
	 * Built per call like the dispatcher: a home's fleet/manager/runs are the
	 * same live objects, so a revived worker is observed exactly like a freshly
	 * dispatched one (cp-8km).
	 */
	reviver(): Reviver {
		return new Reviver({
			home: this.home,
			profilesDir: this.profilesDir,
			fleet: this.fleet,
			manager: this.manager,
			runs: this.runs,
			...this.#observers(),
		});
	}

	/** `continueFailed`: the operator's explicit continuation of a failed job on its original lease. */
	async revivePlan(jobId: string, options: { continueFailed?: boolean } = {}): Promise<RevivePlanResult> {
		return this.reviver().plan(jobId, options);
	}

	async revive(jobId: string, options: { continueFailed?: boolean } = {}): Promise<ReviveResult> {
		return this.reviver().revive(jobId, options);
	}

	/**
	 * Built per call like the dispatcher: routing config and budgets are
	 * operator-editable, and a gate that needs a restart to see a model change is
	 * a gate nobody re-runs.
	 */
	gateModule(): Gate {
		return new Gate({
			home: this.home,
			capacity: this.capacity,
			profilesDir: this.profilesDir,
			briefsDir: this.briefsDir,
			artifacts: this.artifacts,
			manager: this.manager,
			routing: loadRoutingConfig(this.home),
			probe: this.probe(),
			fleet: this.fleet,
			runs: this.runs,
			sender: this.sender,
			reviews: this.reviewRuns,
			escalations: this.escalations,
			...(this.#options.parentEnv ? { parentEnv: this.#options.parentEnv } : {}),
		});
	}

	async gate(request: GateRequest): Promise<GateStart> {
		assertNotDraining(this.home, "plan gate reviewer");
		return this.gateModule().start(request);
	}

	/**
	 * The diff review (cp-diffgate-redo-hxb, Stage B1). Built per call for the
	 * same reason `gateModule()` is: routing is operator-editable, and a review
	 * that needs a parent restart to see a model change is a review nobody
	 * re-runs. No `artifacts` — its subject is the pushed branch itself, read
	 * from the canonical clone this registry owns, never a leased worktree.
	 */
	diffReviewModule(): DiffReview {
		return new DiffReview({
			home: this.home,
			capacity: this.capacity,
			profilesDir: this.profilesDir,
			briefsDir: this.briefsDir,
			manager: this.manager,
			routing: loadRoutingConfig(this.home),
			probe: this.probe(),
			fleet: this.fleet,
			runs: this.runs,
			sender: this.sender,
			registry: this.registry,
			reviews: this.reviewRuns,
			mandates: this.mandates,
			...(this.#options.parentEnv ? { parentEnv: this.#options.parentEnv } : {}),
		});
	}

	async diffReview(request: DiffReviewRequest): Promise<DiffReviewStart> {
		assertNotDraining(this.home, "cp_review reviewer");
		return this.diffReviewModule().start(request);
	}

	/** The opt-in pre-gate panel (T22). Off unless a job asks for it. */
	qualityPass(): QualityPass {
		return new QualityPass({
			home: this.home,
			capacity: this.capacity,
			profilesDir: this.profilesDir,
			briefsDir: this.briefsDir,
			artifacts: this.artifacts,
			manager: this.manager,
			routing: loadRoutingConfig(this.home),
			probe: this.probe(),
			fleet: this.fleet,
			reviews: this.reviewRuns,
		});
	}

	/** Finish attempts a previous parent left pending (D4). Once per session, after the parent lock. */
	async sweepOrphanReviews(): Promise<OrphanReport> {
		const jobIds = this.fleet.read().jobs.map((job) => job.job_id);
		return this.reviewRuns.sweepOrphans(
			{
				gate: (pending, reason) => this.gateModule().orphan(pending, reason),
				review: (pending, reason) => this.diffReviewModule().orphan(pending, reason),
				quality: (pending, reason) => this.qualityPass().orphan(pending, reason),
			},
			jobIds,
		);
	}

	pipeline(): PipelineRunner {
		const defaults = loadQualityConfig(this.home);
		return new PipelineRunner({
			home: this.home,
			ledger: this.ledger(),
			dispatcher: () => (assertNotDraining(this.home, "dispatch"), this.dispatcher()),
			gate: () => this.gateModule(),
			artifacts: this.artifacts,
			fleet: this.fleet,
			teardown: this.teardown,
			reviews: this.reviewRuns,
			quality: () => this.qualityPass(),
			// The opt-in diff gate (Stage D). Built per call for the same reason the
			// gate is: routing is operator-editable. A pipeline that did not ask for a
			// review never calls this factory.
			review: () => this.diffReviewModule(),
			// The pipeline builds its own CheckpointStore, and an authorization granted
			// through it must wake the parent exactly like one granted anywhere else.
			onAnswered: (decision) => this.#recordAnswered(decision),
			...(defaults ? { qualityDefaults: defaults } : {}),
			send: async (jobId, message) => this.sender.send({ jobId, message }),
			...(this.#options.authorizer ? { authorizer: this.#options.authorizer } : {}),
			approvals: this.approvals,
			mandates: this.mandates,
			escalations: this.escalations,
		});
	}

	async startPipeline(request: StartRequest): Promise<StartResult> {
		return this.pipeline().start(request);
	}

	async advancePipeline(researchId: string): Promise<AdvanceResult> {
		return this.pipeline().advance(researchId);
	}

	async reanchorPipeline(researchId: string, replacementResearchId: string): Promise<PipelineRecord> {
		return this.pipeline().reanchor(researchId, replacementResearchId);
	}

	/**
	 * The fleet view (T23). Built per call like the dispatcher: it reads files
	 * every time, because a status view that caches is a status view that lies.
	 */
	statusReporter(): StatusReporter {
		return new StatusReporter({
			home: this.home,
			fleet: this.fleet,
			ledger: () => this.ledger(),
			questions: this.questions.store,
		});
	}

	/** `/status`: files plus a br join for titles (degrades if br is missing). */
	async status(query: StatusQuery = {}): Promise<StatusSnapshot> {
		return this.statusReporter().snapshot(query);
	}

	/** The widget's snapshot: files only, no subprocess, safe on a timer. */
	statusNow(query: StatusQuery = {}): StatusSnapshot {
		return this.statusReporter().collect(query);
	}

	/**
	 * May this parent die now? (cp-epy2 §4.2 item 3.) The live workers **this
	 * process** owns, which no file records — so it is a projection, never part
	 * of the snapshot, and a caller without a manager simply has no drain line.
	 */
	quiesce(): DrainProjection {
		return this.manager.quiesce();
	}

	/**
	 * Awaiting you (cp-av8), merged: pending checkpoints of **both** kinds
	 * (authorization, derived, never persisted here — the pre-implementation one
	 * and, since cp-khf, the post-implementation `diff` one), held research with
	 * no PR receipt (approval, derived), and every open declared row. `snoozed` is session-only and never
	 * persisted, so a restart forgets it — the desired reappearance.
	 */
	async awaitingSnapshot(options: { snoozed?: ReadonlySet<string> } = {}): Promise<ResolvedAwaitingItem[]> {
		// cp-gmy: a deferred merge ask is promoted here, before anything renders it.
		// This is what makes "the row appears later, with no operator action" true of
		// every surface that lists decisions, not just of the status block.
		try {
			await this.awaiting.reviewDeferred();
		} catch {
			// A gate that cannot be reached must never make the open decisions
			// unlistable; the deferred rows stay deferred and stay visible as notices.
		}
		const snapshot = await this.status({ include: "all" });
		const ship = this.#shipCheckpoints();
		return mergeAwaiting({
			checkpoints: ship.pending,
			diffCheckpoints: this.diffCheckpoints.listPending(),
			// cp-uug. A merge authorization is only ever *requested* once CI is green on
			// the pushed head, which is the same rule cp-gmy's gate applies to a declared
			// merge ask — enforced at the source instead of at the row.
			mergeCheckpoints: [...this.mergeCheckpoints.listPending(), ...this.finalFixCheckpoints.listPending()],
			// cp-80cv: an answered authorization renders nothing; it is read so a
			// pipeline's implement decision is not re-asked on the derived research row
			// in the window between the answer and the parent's teardown.
			answeredCheckpoints: ship.answered,
			heldResearch: snapshot.jobs,
			// cp-80cv: the research -> ship links, so a pipeline's single "should this be
			// implemented?" is asked once (as the checkpoint) rather than twice.
			pipelines: this.#pipelineLinks(),
			// cp-f9jh: the same snapshot, so a declared row about a done/closed/merged
			// job is not offered as an open question.
			jobs: snapshot.jobs,
			// Every row, not just the open ones: an answered row under a derived id
			// is how mergeAwaiting knows to stop re-deriving that projection.
			declared: this.awaiting.list(),
			escalations: this.escalations.open(),
			...(options.snoozed ? { snoozed: options.snoozed } : {}),
		});
	}

	/**
	 * The research -> ship links Awaiting-you dedupes on (cp-80cv). Best-effort by
	 * construction: an unreadable pipelines directory costs the *secondary* half of
	 * that link (a checkpoint's own `research_id` still carries it) and must never
	 * make the open decisions unlistable.
	 */
	#pipelineLinks(): PipelineRecord[] {
		try {
			return this.pipelines.list();
		} catch {
			return [];
		}
	}

	/**
	 * The ship-kind checkpoints, split once (cp-80cv): the pending ones are the
	 * authorization rows, the answered ones are read only to keep a pipeline's
	 * research row from re-asking a decision a human already took. One directory
	 * walk, so the two halves can never disagree about what is on disk.
	 */
	#shipCheckpoints(): { pending: Checkpoint[]; answered: Checkpoint[] } {
		const all = this.checkpoints.list();
		return {
			pending: all.filter((checkpoint) => checkpoint.decision === "pending"),
			answered: all.filter((checkpoint) => checkpoint.decision !== "pending"),
		};
	}

	/** Files-only twin of `awaitingSnapshot`, safe to call from a widget timer. */
	awaitingSnapshotSync(options: { snoozed?: ReadonlySet<string> } = {}): ResolvedAwaitingItem[] {
		const snapshot = this.statusNow({ include: "all" });
		const ship = this.#shipCheckpoints();
		return mergeAwaiting({
			checkpoints: ship.pending,
			diffCheckpoints: this.diffCheckpoints.listPending(),
			mergeCheckpoints: [...this.mergeCheckpoints.listPending(), ...this.finalFixCheckpoints.listPending()],
			answeredCheckpoints: ship.answered,
			heldResearch: snapshot.jobs,
			pipelines: this.#pipelineLinks(),
			jobs: snapshot.jobs,
			declared: this.awaiting.list(),
			escalations: this.escalations.open(),
			...(options.snoozed ? { snoozed: options.snoozed } : {}),
		});
	}

	/**
	 * Memory (T26). The scaffold is idempotent, so `session_start` may call it
	 * every time; an existing file is never rewritten.
	 */
	scaffoldMemory(): ScaffoldResult {
		return ensureMemoryScaffold(this.home);
	}

	/** What the parent loads at session start, or nothing on a fresh home. */
	memoryDigest(): string | undefined {
		return sessionStartDigest(this.home);
	}

	memory(): MemoryStatus {
		return memoryStatus(this.home);
	}

	/** Capture appends to `candidates.md` — never to the curated learnings. */
	capture(lesson: string): CaptureResult {
		return captureCandidate(this.home, lesson);
	}

	/** Curation's only destructive step, and it is a move, not a delete. */
	archiveLearning(line: string, options: { reason: string; now?: string }): ArchiveResult {
		return archiveEntry(this.home, line, options);
	}

	/**
	 * Curation, autonomous (cp-autonomous-memory-curation). The judgment is the
	 * parent's; the safety properties are `src/curation.ts`'s, which is why these
	 * are thin pass-throughs and not policy of their own.
	 */
	curationPlan(): CurationPlan {
		return curationPlan(this.home);
	}

	promote(options: PromoteOptions): PromoteResult {
		return promoteCandidate(this.home, options);
	}

	reject(options: RejectOptions): RejectResult {
		return rejectCandidate(this.home, options);
	}

	retire(options: RetireOptions): RetireResult {
		return retireLearning(this.home, options);
	}

	/** The audit trail; with a line, only the decisions that touched it. */
	curationAudit(line?: string): CurationRecord[] {
		return line ? traceLearning(this.home, line) : readCurationLog(this.home);
	}

	/**
	 * Diagnosis (T25). The probe is passed through, so a session with a live
	 * model registry checks real auth and a context without one says so.
	 */
	async doctor(options: { piVersion?: string; sessionTools?: readonly RecordedSessionTool[] } = {}): Promise<DoctorReport> {
		const doctorOptions: DoctorOptions = {
			home: this.home,
			packageRoot: this.packageRoot,
			fleet: this.fleet,
			// The same pool the leases come from, or the foreign-worktree check would
			// diagnose a pool this home never touches.
			...(this.leases.poolRoot ? { poolRoot: this.leases.poolRoot } : {}),
			...(this.#options.runtime ? { runtime: this.#options.runtime } : {}),
			...(this.#registry() ? { probe: this.probe() } : {}),
			...(options.piVersion ? { piVersion: options.piVersion } : {}),
			...(options.sessionTools ? { sessionTools: options.sessionTools } : {}),
		};
		return new Doctor(doctorOptions).run();
	}

	/**
	 * The run viewer (T24). Reads `events.jsonl` and nothing else, so it works
	 * for a live worker and for one that exited last week.
	 */
	watcher(): RunWatcher {
		return new RunWatcher({
			home: this.home,
			record: (jobId) => {
				try {
					return this.fleet.get(jobId);
				} catch {
					// A view must not fail because the fleet file is unreadable; the
					// run log is the history, and reconcile owns the fleet's problems.
					return undefined;
				}
			},
		});
	}

	/** One-shot render. Following is a human's job, never the parent's (T24). */
	watch(jobId: string, options: RenderOptions = {}): RunView {
		return this.watcher().render(jobId, options);
	}

	/**
	 * Reading the plan (cp-9c5): resolve a job id (research or ship) to a
	 * viewable artifact or gate document. Delegates the pure resolution to
	 * `resolvePlanTarget`, wiring the two lookups it needs —
	 * `Checkpoint.research_id` and `PipelineStore.findByShipId` — from the real
	 * stores this composition root already owns. Never reads a body: that stays
	 * the extension's job, gated on `ctx.mode === "tui"`.
	 */
	planTarget(jobId: string, options: ResolvePlanOptions = {}): PlanTarget {
		return resolvePlanTarget(
			jobId,
			{
				home: this.home,
				checkpointResearchId: (id) => {
					try {
						return this.checkpoints.get(id)?.research_id;
					} catch {
						return undefined;
					}
				},
				pipelineResearchIdForShip: (id) => {
					try {
						return this.pipeline().store.findByShipId(id)?.research_id;
					} catch {
						return undefined;
					}
				},
			},
			options,
		);
	}

	/**
	 * The decision details pane for one Awaiting-you item (pi-command-post-4mn):
	 * the latest review and gate verdicts, the row's own checkpoint and the CI
	 * watcher's last observation, bounded, redacted and tied to the head they
	 * describe. Local files only — this is called on a render path, and never
	 * reads an artifact body or a diff.
	 *
	 * Total by construction: a home with nothing on disk, or a record that cannot
	 * be read, yields an empty pane rather than an error, because a decision must
	 * never be taken down by its own evidence.
	 */
	decisionContext(item: ResolvedAwaitingItem, options: BuildDecisionContextOptions = {}): DecisionContext {
		try {
			return buildDecisionContext(item, readDecisionEvidence(this.home, item), options);
		} catch {
			return EMPTY_DECISION_CONTEXT;
		}
	}

	/** session_shutdown: never leave orphaned children behind. */
	async shutdown(): Promise<void> {
		// Nothing announces a verdict during teardown: the reviewers die with the
		// manager below, and the chains that resolve after that would otherwise be
		// sending wake-ups into a session that is closing (spec 2026-09-05).
		this.reviewRuns.wakeupPort = () => false;
		await this.manager.shutdownAll();
		this.drain.released();
		this.runs.closeAll();
	}
}
