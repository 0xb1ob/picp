/**
 * The closure state index.ts shares with its tool and command modules. Values
 * that session_start replaces (or timers that come and go) are accessors, so a
 * module always reads the current one rather than a copy taken at registration.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HumanPrompt } from "../../src/awaiting-ui.ts";
import type { CommandPost } from "../../src/command-post.ts";
import type { ThinkingLevel } from "../../src/contracts.ts";
import type { ParentLock } from "../../src/parent-lock.ts";
import type { PlanTarget } from "../../src/plan-view.ts";
import type { ScheduleRunner } from "../../src/schedule-runner.ts";
import type { ProjectOf } from "../../src/project-report.ts";
import type { RecordedSessionTool } from "../../src/session-tools.ts";
import { WedgedWatch } from "../../src/wedged.ts";
import type { OpenPlanViewerDeps } from "./plan-viewer.ts";

export interface ExtensionDeps {
	commandPost: (modelRegistry?: unknown) => CommandPost;
	setLive: (ctx: ExtensionContext) => void;
	emit: (ctx: ExtensionContext, source: string, text: string, options?: { level?: "info" | "error"; json?: boolean }) => void;
	refreshWidget: (ctx: ExtensionContext | undefined) => void;
	projectOf: () => ProjectOf;
	planViewerDeps: (target: PlanTarget) => OpenPlanViewerDeps;
	askQuestion: (request: {
		project?: string;
		question: string;
		model?: string;
		thinking?: ThinkingLevel;
		registry?: unknown;
	}) => Promise<{ job_id: string; dispatch: Awaited<ReturnType<CommandPost["dispatch"]>> }>;
	/** An accessor like the rest: a module reads the session's current array at call time, never a registration-time copy. */
	readonly createdThisTurn: string[];
	readonly sessionTools: RecordedSessionTool[] | undefined;
	readonly widgetTimer: NodeJS.Timeout | undefined;
	readonly ciWatchTimer: NodeJS.Timeout | undefined;
	readonly orchestrationTimer: NodeJS.Timeout | undefined;
}

/** The session's mutable state, one object so the session modules share it rather than copy it. */
export interface SessionState {
	post: CommandPost | undefined;
	// The context of the call currently in flight. A checkpoint dialog belongs to
	// whoever is at the keyboard now, not to whoever started the session.
	live: ExtensionContext | undefined;
	// pi's model registry, the latest one a ctx handed us (see `commandPost`).
	registry: unknown;
	widgetTimer: NodeJS.Timeout | undefined;
	// Orchestration sweeps when there is no widget timer (hasUI false). The widget
	// tick already runs them; this is the same interval, display-independent.
	orchestrationTimer: NodeJS.Timeout | undefined;
	// cp-e2d: the CI/PR watch's own slow interval. Separate from the widget tick
	// on purpose — the widget stays files-only (src/widget.ts) and a `gh` call is
	// not a widget — and unref'd, so it never holds this process open.
	ciWatchTimer: NodeJS.Timeout | undefined;
	widgetShown: string | undefined;
	// Once per session (T-install-nudge): a fresh clone's user hits the missing
	// tools once at startup, not on every turn, and not at all once installed.
	installNudgeShown: boolean;
	// cp-056q: same rule for the pi version skew — once per startup at most, and
	// nothing at all when the installed pi and the running pi agree.
	piVersionNudgeShown: boolean;
	// routing T5: the same rule again for routing policy that dispatch would
	// refuse (an unusable config, a dead rubric row, a configured effort the
	// model cannot serve). Once per session, silent when the policy is clean.
	routingNudgeShown: boolean;
	// Tools present at session_start. `/doctor` diffs this against command-post
	// + pi builtins and warns about the rest (pi-lens, fetch, …).
	sessionTools: RecordedSessionTool[] | undefined;
	// pi-command-post-autonomy-programme-cur.1.3 review round-4: `reconcile()`'s
	// `#journalRecovery` can journal a durable wake-up and, via `onDurableWakeup`,
	// drain it synchronously in the same call — before session_start has had a
	// chance to let a caller's own first prompt land. Idle at that instant, a
	// `triggerTurn: true` wake starts a turn of its own, and the caller's actual
	// first prompt then arrives to an agent that looks busy for a reason it never
	// asked for: 'Agent is already processing'. True mid-turn delivery (a real
	// prompt already running) is unaffected — that path already queues safely.
	// Set only around the `reconcile()` call itself, so the deliberate first
	// drain a few lines into session_start (cp-answer-doesnt-wake, before this
	// flag is ever set) still fires immediately.
	reconcileInProgress: boolean;
	// cp-epy2 §4.2: one parent process per home, held for the life of this
	// session. Kept here (not on CommandPost) because it is a property of the
	// *process*, acquired before anything reads or reconciles fleet state and
	// released on the observed session shutdown.
	parentLock: ParentLock | undefined;
	// The status block's Shipped-since-last-time state (cp-8aj) lives on disk,
	// keyed by pi's session id (cp-b5eg: `CommandPost.shippedSeen`). It used to be
	// a `Set` in this closure, reset in `session_start` — but `session_start` also
	// fires with reason "reload", which rebinds extensions *inside the same
	// session*, so every reload silently dropped the memory and made the next
	// block replay the session's whole shipped history. Keying the persisted set
	// by session id keeps the contract ("new since the block you last rendered
	// this session") without depending on this closure surviving.
	readonly humanPrompt: HumanPrompt;
	// cp-wedged-tool-call: the parent's memory of which open-but-silent tool
	// calls it has already announced, so a wedge is news once instead of every
	// widget tick. Recreated per session on purpose (see src/wedged.ts).
	wedgedWatch: WedgedWatch;
	// cp-e2d: `gh` is not in REQUIRED_TOOLS, so a home without it degrades rather
	// than breaking. Said once per session — an alarm that fires every minute is
	// an alarm nobody reads.
	ciWatchDisabledShown: boolean;
	// autonomy-programme-cur.4.3: ids `cp_job create` returned this parent turn.
	// `before_agent_start` clears it so a parallel `cp_mandate issue` can name them
	// without waiting for create results. Sequential generations pass the echoed ids.
	createdThisTurn: string[];
	// Spec 2026-09-04 D8: the missing-contract warning, once per session.
	contractMissingShown: boolean;
	// schedlater S1: the schedule runner, when this session holds the parent lock (tools-schedule.ts sets it).
	scheduleRunner?: () => ScheduleRunner | undefined;
}

export function createSessionState(): SessionState {
	return {
		post: undefined,
		live: undefined,
		registry: undefined,
		widgetTimer: undefined,
		orchestrationTimer: undefined,
		ciWatchTimer: undefined,
		widgetShown: undefined,
		installNudgeShown: false,
		piVersionNudgeShown: false,
		routingNudgeShown: false,
		sessionTools: undefined,
		reconcileInProgress: false,
		parentLock: undefined,
		humanPrompt: new HumanPrompt(),
		wedgedWatch: new WedgedWatch(),
		ciWatchDisabledShown: false,
		createdThisTurn: [],
		contractMissingShown: false,
	};
}
