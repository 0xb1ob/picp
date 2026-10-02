/**
 * The session's pi hooks: prompt-span tracking, `session_start` (runtime,
 * scaffold, parent lock, sweeps, nudges, timers, memory, reconcile),
 * `before_agent_start`, the arrival observers, `session_shutdown`, the
 * `tool_call` guards and the two entry renderers.
 * Moved from index.ts as is; its closure state is read through `s` (./shared.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type AnswerCardData, answerCardView } from "../../src/answer-card.ts";
import { applyPromptWorking } from "../../src/awaiting-ui.ts";
import { ciWatchIntervalMs } from "../../src/ci-watch.ts";
import { ANSWER_ENTRY_TYPE, ANSWER_MAX_BYTES, FLEET_MUTATING_TOOLS, type Runtime } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { summarizeReconcile } from "../../src/fleet.ts";
import { formatGuardDecision } from "../../src/guards.ts";
import { pendingNotice } from "../../src/curation.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { computeInstallNudge } from "../../src/install-nudge.ts";
import { formatIntake } from "../../src/intake.ts";
import { contractInjectionOrNone, ModeError, packageContractLoaded } from "../../src/mode.ts";
import { acquireParentLock, formatParentLock, readParentLock } from "../../src/parent-lock.ts";
import { recordModelWindows } from "../../src/model-windows.ts";
import { computePiVersionNudge } from "../../src/pi-version-nudge.ts";
import { computeRoutingNudge } from "../../src/routing.ts";
import { deliverStandingOrders } from "../../src/parent-context.ts";
import { formatScaffold, scaffoldHome } from "../../src/scaffold.ts";
import { snapshotSessionTools } from "../../src/session-tools.ts";
import { formatSweep, sweepJobIdRename } from "../../src/state-migrations.ts";
import { SuggestionCache } from "../../src/suggest.ts";
import { type WakeupCarrier } from "../../src/wakeups.ts";
import { WedgedWatch } from "../../src/wedged.ts";
import { collapseOutputLines, currentRuntime, deliverUserContext, type OutputEntry, runtimeOrRefusal, WIDGET_REFRESH_MS } from "./helpers.ts";
import type { SessionPost } from "./session-post.ts";
import type { SessionState } from "./shared.ts";
import type { WakeupSurfaces } from "./wakeup-surfaces.ts";

export function registerSessionHooks(pi: ExtensionAPI, s: SessionState, session: SessionPost, wakeups: WakeupSurfaces): void {
	const { commandPost, refreshWidget } = session;
	const {
		surfaceAnswered,
		surfaceDurableWakeups,
		surfaceAnswerCards,
		surfaceCi,
		confirmAnsweredArrival,
		confirmCiArrival,
		confirmVerdictArrival,
		confirmDurableArrival,
		reviewWakeupsInContext,
	} = wakeups;

	const deliverDigests = (home: string, ctx: ExtensionContext): void => {
		try {
			const post = commandPost();
			post.scaffoldMemory();
			const digest = [post.memoryDigest(), pendingNotice(home)].filter(Boolean).join("\n");
			if (digest) {
				pi.sendMessage(
					{ customType: "cp-memory", content: digest, display: false },
					{ triggerTurn: false },
				);
			}
		} catch (error) {
			const message = `pi-command-post: memory unavailable: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		deliverStandingOrders((message, options) => pi.sendMessage(message, options), home);
	};

	// Only successful compactions emit this event; the next turn gets fresh disk context.
	pi.on("session_compact", (_event, ctx) => {
		if (s.parentLock) deliverDigests(currentRuntime().home, ctx);
	});

	// Hide pi's working loader for the outer extension-prompt span, and set
	// `humanPrompt.open` on the same coalesced events. Handlers are synchronous
	// on purpose: pi does not await `ui_prompt_*`.
	pi.on("ui_prompt_start", async (_event, ctx) => {
		applyPromptWorking(ctx.ui, s.humanPrompt, "start");
	});
	pi.on("ui_prompt_end", async (_event, ctx) => {
		applyPromptWorking(ctx.ui, s.humanPrompt, "end");
	});

	// Reconcile before the parent forms any belief about the fleet. A failure
	// here is surfaced, never swallowed: an unreadable fleet means the parent
	// does not know what is running.
	pi.on("session_start", async (_event, ctx) => {
		s.live = ctx;
		try {
			s.sessionTools = snapshotSessionTools(pi.getAllTools());
		} catch {
			s.sessionTools = undefined;
		}

		// The mode, the home and the layout are resolved before anything reads a
		// path. The refusals (CP_MODE or settings single, a plain git repository, a
		// former single-project home) and an invalid CP_MODE end startup here,
		// with the message naming the fix.
		let runtime: Runtime;
		try {
			runtime = currentRuntime();
		} catch (error) {
			const message = `pi-command-post: ${error instanceof ModeError ? error.message : (error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
			return;
		}
		const home = runtime.home;

		// T30: a fresh install has no data/, state/, projects/ or ledger, and an
		// operator should not have to know that. Idempotent, so the steady state is
		// one silent check; only the first session (or a broken home) says anything.
		try {
			const report = scaffoldHome({ home });
			const interesting = report.steps.filter((step) => step.action === "created" || step.action === "failed");
			if (interesting.length > 0) {
				const text = formatScaffold(report);
				if (ctx.hasUI) ctx.ui.notify(text, report.steps.some((step) => step.action === "failed") ? "error" : "info");
				else process.stderr.write(`${text}\n`);
			}
		} catch (error) {
			const message = `pi-command-post: scaffold failed for ${home}: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
		}

		// cp-epy2 §4.2: one parent per home, taken before this session forms any
		// belief about the fleet. Scaffolding above is idempotent and writes no
		// fleet state, so it runs either way; everything below this point does —
		// the answered outbox, the CI watch and above all `reconcile`, which is
		// the whole-array read-modify-write on fleet.json that cp-ga6j showed two
		// parents use to erase each other's live jobs. A refusal is therefore
		// total: notify, and end the startup here.
		if (!s.parentLock) {
			const acquired = acquireParentLock({ home });
			if (!acquired.ok) {
				const message = `pi-command-post: ${formatParentLock(acquired)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			s.parentLock = acquired.lock;
			if (acquired.lock.reclaimed) {
				// A reclaim is a fact worth reading: the previous parent died holding
				// this home, so its workers are gone and its jobs are revivable.
				const message = `pi-command-post: ${formatParentLock(acquired)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			}
		}

		// spec 2026-09-05 D4: reviewers died with the previous parent. Finish their
		// attempts as operational faults now, before the widget reads pending.json.
		try {
			const report = await commandPost().sweepOrphanReviews();
			if (report.finished.length > 0) {
				const text =
					`pi-command-post: ${report.finished.length} reviewer attempt(s) were lost with the previous session and ` +
					`recorded as operational (${report.finished.map((p) => `${p.job_id} ${p.surface} ${p.attempt}`).join(", ")}); ` +
					"the ladder retries on the next advance.";
				if (ctx.hasUI) ctx.ui.notify(text, "warning");
				else process.stderr.write(`${text}\n`);
			}
		} catch (error) {
			const message = `pi-command-post: orphan review sweep failed: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}

		// Spec 2026-09-04 PR 1: move pre-rename state files once, under the lock
		// (no other parent can be writing) and before anything below reads them.
		try {
			const sweep = sweepJobIdRename({ home });
			const text = formatSweep(sweep);
			if (text.length > 0) {
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else process.stderr.write(`${text}\n`);
			}
		} catch (error) {
			const message = `pi-command-post: state migration failed for ${home}: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
		}

		// Not reset here: the Shipped memory is keyed by session id and persisted, so
		// a genuinely new session starts empty by construction, and a reload of this
		// same session keeps what it already reported (cp-b5eg).
		s.awaitingSnoozed = new Set<string>();
		s.suggestionCache = new SuggestionCache();
		// A fresh session re-announces a still-wedged call on purpose: it is the
		// session most likely to be the one that finally acts on it.
		s.wedgedWatch = new WedgedWatch();
		// cp-answer-doesnt-wake: an answer given while no parent was attached (a
		// headless /cp-authorize, a crashed session) is news to this one. Already
		// delivered answers are on the record and are never replayed.
		surfaceAnswered();
		surfaceDurableWakeups();
		// cp-6lg7: same rule for an answer card. A Q&A job answered while this home
		// had no operator surface (a crashed parent, a headless re-entry) still owes
		// the operator its answer; a card already shown is on the record and is never
		// shown again.
		surfaceAnswerCards();

		// Discovery, not diagnosis: `/doctor` stays read-only and only names the
		// gap (docs/contracts.md §install-tools); this reuses its own detection to
		// point a fresh clone's user at the installer that already exists.
		if (!s.installNudgeShown) {
			s.installNudgeShown = true;
			const nudge = computeInstallNudge({ which: whichAll });
			if (nudge) {
				if (ctx.hasUI) ctx.ui.notify(nudge, "warning");
				else process.stderr.write(`${nudge}\n`);
			}
		}

		// cp-056q: the same shape for a different drift. When the pi this package
		// installs is not the pi running it, `npm run` and a plain shell hand a
		// worker different binaries — a nuisance, never a fault, so this warns once
		// and is silent whenever it cannot tell (no host pi, unreadable version, no
		// installed copy).
		if (!s.piVersionNudgeShown) {
			s.piVersionNudgeShown = true;
			const nudge = computePiVersionNudge({ packageRoot: PACKAGE_ROOT, which: whichAll });
			if (nudge) {
				if (ctx.hasUI) ctx.ui.notify(nudge, "warning");
				else process.stderr.write(`${nudge}\n`);
			}
		}

		// routing T5: policy drift, at the start of the session rather than at the
		// dispatch it would refuse. Read-only and silent when there is nothing to
		// say; the effort half is checked only when this session has a live model
		// registry, because absent metadata is ignorance and never a fault.
		if (!s.routingNudgeShown) {
			s.routingNudgeShown = true;
			try {
				const post = commandPost(ctx.modelRegistry);
				const nudge = computeRoutingNudge({
					home,
					profilesDir: post.profilesDir,
					...(ctx.modelRegistry ? { probe: post.probe() } : {}),
				});
				if (nudge) {
					if (ctx.hasUI) ctx.ui.notify(nudge, "warning");
					else process.stderr.write(`${nudge}\n`);
				}
			} catch (error) {
				// A diagnosis must never be the thing that breaks a session start.
				const message = `pi-command-post: routing check skipped: ${(error as Error).message}`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			}
		}

		// ctx-q85: the viewer's context chips need each model's window, which only pi's
		// registry knows and the viewer may not import. Record it here, under the lock.
		if (ctx.modelRegistry) {
			try {
				recordModelWindows(home, ctx.modelRegistry);
			} catch (error) {
				const message = `pi-command-post: model windows not recorded for the viewer: ${(error as Error).message}`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			}
		}

		refreshWidget(ctx);
		// cp-g1tc: the picker's two doors. Registered once per session, in a real
		// TUI only — `onTerminalInput` is interactive-mode-only, and a shortcut in
		// any other mode is a key nobody can press.
		if (ctx.hasUI && !s.widgetTimer) {
			s.widgetTimer = setInterval(() => refreshWidget(s.live), WIDGET_REFRESH_MS);
			s.widgetTimer.unref();
		} else if (!ctx.hasUI && !s.orchestrationTimer) {
			s.orchestrationTimer = setInterval(() => refreshWidget(s.live), WIDGET_REFRESH_MS);
			s.orchestrationTimer.unref();
		}
		// cp-e2d: CI/PR watch. Orchestration, not display: runs in every mode so a
		// bridge-driven `pi --mode rpc` parent is woken when a held PR goes green.
		// `.unref()`ed so it never keeps this process alive.
		if (!s.ciWatchTimer) {
			s.ciWatchDisabledShown = false;
			s.ciWatchTimer = setInterval(() => surfaceCi(), ciWatchIntervalMs());
			s.ciWatchTimer.unref();
			// One pass at start: a session that begins with a green PR already waiting
			// should not have to wait a full interval to hear about it.
			surfaceCi();
		}

		// Scaffold memory and inject both optional home-local contexts for the next turn.
		deliverDigests(home, ctx);
		// USER.md is repo-local, unlike the home-local orders.
		deliverUserContext((message, options) => {
			pi.sendMessage(message, options);
		});

		try {
			// pi-command-post-3ip: reconcile classifies AND stamps. A worker that filed
			// its envelope and then lost its parent left a delivery nobody would accept —
			// `needs_intake` was computed here and thrown away, and intake ran only from a
			// live worker's event stream. `CommandPost.reconcile` ends the pass at intake,
			// once per unstamped envelope, so the ordinary `cp-envelope` wake-up (its
			// `onReported`) is what the operator sees on restart.
			//
			// `reconcileInProgress` spans exactly this call: `reconcile()` can itself
			// journal a durable wake-up (`#journalRecovery`) and drain it right back out
			// via `onDurableWakeup`, before session_start returns and before a caller's
			// own first prompt has landed. Held off here, that wake-up reaches the next
			// widget tick instead — delivered mid-turn like any other, never racing
			// the first prompt for who starts the turn.
			s.reconcileInProgress = true;
			const { report, intake } = await commandPost().reconcile();
			// jje.2: startup reconciliation resumes every held PR in its project's lane; outcomes are durable notices.
			void commandPost().continuation.resume();
			if (report.changed === 0 && report.needs_intake.length === 0 && report.revivable.length === 0) return;
			const summary = [summarizeReconcile(report), ...intake.map((result) => `  ${formatIntake(result)}`)].join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(summary, "warning");
			} else {
				process.stderr.write(`${summary}\n`);
			}
		} catch (error) {
			const message = `pi-command-post: fleet reconcile failed for ${home}: ${(error as Error).message}`;
			if (ctx.hasUI) {
				ctx.ui.notify(message, "error");
			} else {
				process.stderr.write(`${message}\n`);
			}
		} finally {
			s.reconcileInProgress = false;
		}
	});

	// Spec 2026-09-04 D8: the parent's contract, when pi did not load it. Read
	// once per session; a missing file is one warning, never a crash (`s.contractMissingShown`).
	pi.on("before_agent_start", async (event, ctx) => {
		s.createdThisTurn.length = 0;
		// A refused mode (spec 2026-09-04) already ended startup with its message
		// in `session_start`; `contractInjectionOrNone` is what keeps this hook —
		// which runs on every prompt afterwards — from re-raising that decision.
		const result = contractInjectionOrNone(
			{ systemPrompt: event.systemPrompt, contextFiles: event.systemPromptOptions.contextFiles ?? [] },
			{ packageRoot: PACKAGE_ROOT, runtime: currentRuntime },
		);
		if (result) return result;
		// Realpath, never a basename: a project's own AGENTS.md is a different
		// file, and letting it stand in for this package's contract would silence
		// the one warning that says the parent is running without its contract.
		const alreadyLoaded = packageContractLoaded(event.systemPromptOptions.contextFiles, PACKAGE_ROOT);
		if (!alreadyLoaded && !s.contractMissingShown && !existsSync(join(PACKAGE_ROOT, "AGENTS.md"))) {
			s.contractMissingShown = true;
			const message = `pi-command-post: ${join(PACKAGE_ROOT, "AGENTS.md")} is missing; the parent runs without its operating contract`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		return undefined;
	});

	// cp-nx7: a wake-up is delivered when it reaches the parent's context, and
	// this is where that becomes observable. Read-only and id-shaped: it records
	// arrival for the ids the message carries and does nothing else.
	pi.on("message_start", async (event) => {
		const message = (event as { message?: unknown }).message;
		confirmAnsweredArrival(message);
		confirmCiArrival(message);
		confirmVerdictArrival(message);
		confirmDurableArrival(message);
	});

	// The same evidence, from the one place it cannot be missed: the context handed
	// to the model. A message in there *is* in the parent's context, whichever path
	// put it there.
	//
	// Two things happen here, in this order, and the order is the contract:
	//
	//  1. cp-nx7 — arrival is confirmed from the messages **as they arrived**, so
	//     every id a coalesced `cp-answered` carries is stamped delivered before
	//     anything downstream can touch the message. The first answer is retained;
	//     only duplicate copies can be withheld by the review below.
	//  2. cp-p6m — the staleness review journals obsolete notices and cp-5mgg
	//     replays. qra keeps their diagnostic replacements out of model context,
	//     so there is no stale notice for the parent to acknowledge to the operator.
	pi.on("context", async (event) => {
		const messages = (event as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return;
		for (const message of messages) {
			confirmAnsweredArrival(message);
			confirmCiArrival(message);
			confirmVerdictArrival(message);
			confirmDurableArrival(message);
		}
		const reviewed = reviewWakeupsInContext(messages as WakeupCarrier[]);
		if (!reviewed) return;
		// Review preserves order and fresh object identities; only withheld entries are replaced.
		const fresh = reviewed.filter((message, index) => message === messages[index]);
		// SAFETY: every retained message is an unchanged member of event.messages.
		return { messages: fresh as unknown as typeof event.messages };
	});

	// The parent never leaves orphaned children behind.
	pi.on("session_shutdown", async () => {
		if (s.widgetTimer) clearInterval(s.widgetTimer);
		s.widgetTimer = undefined;
		if (s.orchestrationTimer) clearInterval(s.orchestrationTimer);
		s.orchestrationTimer = undefined;
		if (s.ciWatchTimer) clearInterval(s.ciWatchTimer);
		s.ciWatchTimer = undefined;
		await s.post?.shutdown();
		// Last, and only if it is still ours: the workers are down before the home
		// is released, so the next parent never starts while children are dying.
		s.parentLock?.release();
		s.parentLock = undefined;
	});

	// Context safety is a guard, not a good intention: the parent cannot read an
	// artifact body, cannot `br show` an artifact-bearing issue, and cannot stage
	// runtime state. Blocking (rather than terminating) leaves the model free to
	// take the sanctioned path named in the reason.
	pi.on("tool_call", async (event, ctx) => {
		// cp-yu5k review, gap 2: the lock is refused at `session_start`, but a
		// refusal that only ends the startup would leave every tool in that same
		// session able to do the exact fleet.json read-modify-write the lock exists
		// to serialize. So the refusal is enforced per call as well: without the
		// lock in hand, this process may look at the fleet but may not move it.
		// Read-only tools stay available on purpose — a refused session's only
		// useful act is to show the operator what is going on and name the fix.
		// A refused mode (spec 2026-09-04) means there is no home, so there is no
		// lock to read and no CommandPost to build. The command post's own tools
		// are refused with the reason; everything else is none of its business —
		// a refused startup leaves an ordinary pi session, not a broken one.
		const resolved = runtimeOrRefusal();
		if ("refusal" in resolved) {
			if (!event.toolName.startsWith("cp_")) return;
			if (ctx.hasUI) ctx.ui.notify(`pi-command-post: refused ${event.toolName} — ${resolved.refusal}`, "error");
			return { block: true, reason: `${event.toolName} is unavailable in this session: ${resolved.refusal}` };
		}
		if (!s.parentLock && FLEET_MUTATING_TOOLS.includes(event.toolName)) {
			const holder = readParentLock(resolved.runtime.home);
			const who =
				holder.state === "held"
					? `pid ${holder.record.pid} holds it (since ${holder.record.started_at})`
					: holder.state === "unreadable"
						? `${holder.path} cannot be read as a lock`
						: `${holder.path} is absent, so this session never took it`;
			const reason = `${event.toolName} needs this home's parent lock, and this session does not hold it: ${who}. One parent per home is a contract, not a preference (cp-ga6j: two of them orphan live workers by writing each other's jobs away). Use the session that holds the home, or stop it and start again here; /doctor names a stale or unreadable lock.`;
			if (ctx.hasUI) ctx.ui.notify(`pi-command-post: refused ${event.toolName} — no parent lock`, "error");
			return { block: true, reason };
		}
		const decision = commandPost(ctx.modelRegistry).checkToolCall({
			toolName: event.toolName,
			input: event.input,
			cwd: ctx.cwd,
		});
		if (!decision) return;
		// The model gets the fix; the operator gets to see that a rule held.
		if (ctx.hasUI) ctx.ui.notify(formatGuardDecision(decision), "warning");
		return { block: true, reason: decision.reason };
	});

	// The TUI form of a long payload (cp-8v1). Entries are durable and TUI-only:
	// they render in the transcript and never enter LLM context, which is exactly
	// what a fleet table or a doctor report should be.
	pi.registerEntryRenderer<OutputEntry>("cp-output", (entry, { expanded }, theme) => {
		const data = entry.data ?? { source: "command post", text: "", level: "info" as const };
		const lines = data.text.split("\n");
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const colour = data.level === "error" ? "error" : "accent";
		box.addChild(new Text(`${theme.fg(colour, `[${data.source}]`)} ${lines.length} line(s)`, 0, 0));
		// Collapsed shows the head for most sources, because the first line is
		// their summary (`FLEET …`, `DOCTOR …`). `/watch` collapses to the tail
		// instead — see collapseOutputLines (cp-iuu). Expanded always shows
		// everything, in original order.
		const view = expanded
			? { shown: lines, hidden: 0, hiddenPosition: "after" as const }
			: collapseOutputLines(lines, data.source);
		if (view.hidden > 0 && view.hiddenPosition === "before") {
			box.addChild(
				new Text(theme.fg("dim", `… ${view.hidden} older line(s) hidden above (expand for the full log)`), 0, 0),
			);
		}
		for (const line of view.shown) box.addChild(new Text(line, 0, 0));
		if (view.hidden > 0 && view.hiddenPosition === "after") {
			box.addChild(new Text(theme.fg("dim", `… ${view.hidden} more (expand)`), 0, 0));
		}
		return box;
	});

	/**
	 * cp-u3o4: the answer card. A first-class, glanceable answer surface in the
	 * main TUI — the operator reads the answer where they are, and never opens a
	 * plan to get it.
	 *
	 * The entry holds a pointer; the body is read **here**, from disk, capped at
	 * `ANSWER_MAX_BYTES`, so nothing body-shaped is persisted in the session file
	 * and no path exists from this text to a message, a tool result or the model's
	 * context. A file that has since moved away degrades to one line naming the
	 * path and the size, because a renderer must never throw.
	 *
	 * It cannot be confused with a plan: a plan has no entry surface at all (it
	 * opens in the operator's own pager via `/cp-plan`), the type is `cp-answer`
	 * rather than `cp-output`, and the header word is `ANSWER`.
	 */
	pi.registerEntryRenderer<AnswerCardData>(ANSWER_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data ?? { job_id: "?", summary: "", path: "", bytes: 0 };
		const view = answerCardView(data, { ...(expanded ? { expanded: true } : {}) });
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", view.header), 0, 0));
		for (const line of view.summary) box.addChild(new Text(theme.fg("dim", line), 0, 0));
		if (view.degraded) {
			box.addChild(new Text(theme.fg("error", view.degraded), 0, 0));
			return box;
		}
		for (const line of view.body) box.addChild(new Text(line, 0, 0));
		if (view.hidden > 0) box.addChild(new Text(theme.fg("dim", `… ${view.hidden} more line(s) (expand)`), 0, 0));
		if (view.truncated) {
			box.addChild(new Text(theme.fg("dim", `— capped at ${ANSWER_MAX_BYTES} bytes; full file at ${data.path}`), 0, 0));
		}
		return box;
	});
}
