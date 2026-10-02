/**
 * command-post — PARENT extension.
 *
 * Loaded in the operator's pi session (the "parent"). It owns fleet control:
 * classification, leasing, dispatch, envelope intake, gates and teardown.
 *
 * This file is deliberately thin: it adapts pi (commands, tools, events) to the
 * modules in `src/`, which hold the policy and are testable without pi. It only
 * builds the shared session state (./shared.ts) and registers the modules that
 * use it: the wake-up surfaces, the command post and its widget, the session
 * hooks, and the tool and command modules. The pure helpers live in
 * ./helpers.ts and are re-exported here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, resolveHome } from "../../src/home.ts";
import { currentRuntime } from "./helpers.ts";
import { registerJobs } from "./jobs.ts";
import { registerAwaitingCommand } from "./awaiting-command.ts";
import { registerCommands } from "./commands.ts";
import { registerSessionHooks } from "./session-hooks.ts";
import { createSessionPost, type SessionPost } from "./session-post.ts";
import { createSessionState, type ExtensionDeps, type SessionState } from "./shared.ts";
import { registerDispatchTools } from "./tools-dispatch.ts";
import { registerIntegrateTools } from "./tools-integrate.ts";
import { registerMandateTools } from "./tools-mandate.ts";
import { registerProjectMemoryTools } from "./tools-project-memory.ts";
import { registerReviewTools } from "./tools-review.ts";
import { registerScheduleTools } from "./tools-schedule.ts";
import { registerTrackerTools } from "./tools-tracker.ts";
import { registerPushTick } from "./push-tick.ts";
import { registerSendStatusTools } from "./tools-send-status.ts";
import { createWakeupSurfaces } from "./wakeup-surfaces.ts";

/**
 * Package root and home come from `src/home.ts`, so the extension, the `cp`
 * CLI and the tests can never disagree about which home they are writing.
 * Re-exported because tests and the T1 acceptance criteria name them here.
 */
export { PACKAGE_ROOT, resolveHome };
export * from "./helpers.ts";

/** The tool and command modules' view of the session: accessors over `s`, so nothing is copied at registration. */
export function extensionDeps(s: SessionState, session: SessionPost, projectOf: ExtensionDeps["projectOf"]): ExtensionDeps {
	return {
		commandPost: session.commandPost,
		setLive: (ctx) => {
			s.live = ctx;
		},
		emit: session.emit,
		refreshWidget: session.refreshWidget,
		projectOf,
		planViewerDeps: session.planViewerDeps,
		askQuestion: session.askQuestion,
		get createdThisTurn() {
			return s.createdThisTurn;
		},
		awaitingLatch: s.awaitingLatch,
		humanPrompt: s.humanPrompt,
		get awaitingSnoozed() {
			return s.awaitingSnoozed;
		},
		set awaitingSnoozed(value) {
			s.awaitingSnoozed = value;
		},
		get suggestionCache() {
			return s.suggestionCache;
		},
		get sessionTools() {
			return s.sessionTools;
		},
		get widgetTimer() {
			return s.widgetTimer;
		},
		get ciWatchTimer() {
			return s.ciWatchTimer;
		},
		get orchestrationTimer() {
			return s.orchestrationTimer;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	const s = createSessionState();
	// The wake-up surfaces and the command post call each other; each reads the
	// other lazily, never during construction.
	const wakeups = createWakeupSurfaces(pi, s, {
		commandPost: () => session.commandPost(),
		repaintWidget: () => session.repaintWidget(),
	});
	const session = createSessionPost(pi, s, wakeups);
	const { commandPost, emit } = session;
	registerSessionHooks(pi, s, session, wakeups);

	// Tool and command modules, in their original registration order.
	const deps = extensionDeps(s, session, wakeups.projectOf);
	registerCommands(pi, deps);
	registerAwaitingCommand(pi, deps);
	registerProjectMemoryTools(pi, deps);
	registerMandateTools(pi, deps);
	registerDispatchTools(pi, deps);
	registerIntegrateTools(pi, deps);
	registerReviewTools(pi, deps);
	registerSendStatusTools(pi, deps);
	registerScheduleTools(pi, deps, () => s.parentLock !== undefined, (get) => { s.scheduleRunner = get; }, (result) => session.wakeEnvelope(result));
	registerTrackerTools(pi, deps, () => s.parentLock !== undefined);
	registerPushTick(pi, deps, () => s.parentLock !== undefined);

	// Spec 2026-09-04: the ledger's two surfaces. `emit` and `commandPost` are
	// this closure's; the policy lives in ./jobs.ts so it is testable without pi.
	registerJobs(pi, {
		commandPost: (registry) => commandPost(registry),
		emit,
		runtime: () => currentRuntime(),
		onJobCreated: (id) => {
			if (!s.createdThisTurn.includes(id)) s.createdThisTurn.push(id);
		},
	});
}
