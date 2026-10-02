/**
 * The session's command post and its output surfaces: the authorizer and asker
 * channels, `emit`, the fleet widget, the lazily built `CommandPost` with its
 * wake-up wiring, the Q&A path and the plan-viewer deps.
 * Moved from index.ts as is; its closure state is read through `s` (./shared.ts).
 */
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { type ResolvedAwaitingItem } from "../../src/awaiting.ts";
import { CommandPost } from "../../src/command-post.ts";
import { PLAN_VIEW_MAX_BYTES, type ThinkingLevel } from "../../src/contracts.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { formatIntake, type IntakeResult } from "../../src/intake.ts";
import { resolveProjectArg } from "../../src/mode.ts";
import { type Authorizer } from "../../src/pipeline.ts";
import { type PlanTarget, readPlanSource, renderGateDocument } from "../../src/plan-view.ts";
import { type Asker, dialogOptions } from "../../src/questions.ts";
import { formatSettleOutcome } from "../../src/settle.ts";
import { verdictStamp } from "../../src/wakeups.ts";
import { renderFleetWidget, statusWidgetLines, WIDGET_MAX_WIDTH } from "../../src/widget.ts";
import { styleWidgetLines } from "./fleet-widget.ts";
import { chooseOutputChannel, currentRuntime, FLEET_WIDGET_KEY, type OutputEntry } from "./helpers.ts";
import { type OpenPlanViewerDeps } from "./plan-viewer.ts";
import type { SessionState } from "./shared.ts";
import type { WakeupSurfaces } from "./wakeup-surfaces.ts";

/**
 * Hand a runner-claimed run to the runner. A rejected `onReported` (its own fallback wake threw) must not
 * become an unhandled rejection that crashes the parent on Node 24: log it and send the envelope wake here.
 */
export function claimedRun(
	runner: { onReported: (result: IntakeResult) => Promise<boolean> }, result: IntakeResult, wake: (result: IntakeResult) => void,
	log: (line: string) => void = (line) => void process.stderr.write(`pi-command-post: ${line}\n`),
): void {
	runner.onReported(result).catch((error: unknown) => {
		log(`schedule runner: onReported for ${result.job_id} rejected: ${(error as Error)?.message ?? String(error)}; waking the parent`);
		try { wake(result); } catch (wakeError) { log(`schedule runner: fallback envelope wake for ${result.job_id} failed: ${(wakeError as Error)?.message ?? String(wakeError)}`); }
	});
}

export type SessionPost = ReturnType<typeof createSessionPost>;

export function createSessionPost(pi: ExtensionAPI, s: SessionState, wakeups: WakeupSurfaces) {
	const { sendWakeup, surfaceAnswerCards, surfaceDurableWakeups, surfaceAnswered, recheckDeferredRows, surfaceWedged } = wakeups;

	/**
	 * An envelope is news: it reaches the parent as a custom message, headline only.
	 * cp-p6m: the generation and the `reported_at` travel with the news, so a
	 * message describing generation N is recognisable once a promote has moved the
	 * job to N+1 and archived the envelope it describes. Also the schedule runner's
	 * fallback (schedlater S1), so a refused scheduled teardown wakes the same way.
	 */
	const wakeEnvelope = (result: IntakeResult): void => {
		sendWakeup(
			{
				kind: "envelope",
				job_id: result.job_id,
				...(result.generation !== undefined ? { generation: result.generation } : {}),
				...(result.reported_at ? { reported_at: result.reported_at } : {}),
			},
			formatIntake(result),
			// SAFETY: IntakeResult is a plain JSON object; details only needs string keys.
			result as unknown as Record<string, unknown>,
		);
	};

	/**
	 * The human authorization channel. A model cannot answer this: it is a UI
	 * request that the operator's client renders, and "not now" (dismiss) leaves
	 * the checkpoint pending rather than declining it forever.
	 */
	const authorizer: Authorizer = {
		async ask(_checkpoint) {
			// Overlay retired: pending until cp_decide cites a mandate or operator quote.
			return undefined;
		},
	};

	/**
	 * The worker-question channel (T31). A planner's question reaches the operator
	 * here and the answer goes straight back down the worker's RPC socket — it
	 * never becomes a tool result, a message or an entry, so this session's model
	 * cannot see either half. Dismissing the dialog is a valid answer: the worker
	 * is told "no answer" and writes the question down as an unknown.
	 *
	 * The deadline is the relay's, not the operator's: pi resolves the dialog
	 * itself when `timeout` passes, so nobody has to be watching for a worker to
	 * stay alive.
	 */
	const asker: Asker = {
		async ask(question) {
			const ctx = s.live;
			if (!ctx?.hasUI) return undefined;
			const title = `${question.job_id} asks: ${question.question}`;
			// The signal is the worker's life (cp-xbxz): a planner that dies with its
			// dialog open dismisses that dialog here and now, instead of leaving the
			// operator answering into a destroyed stdin until pi's own timeout expires.
			// Built by `dialogOptions` so the forwarding is asserted in a test rather
			// than hoped for in a comment.
			const opts = dialogOptions(question);
			const answer =
				question.options && question.options.length > 0
					? await ctx.ui.select(title, [...question.options], opts)
					: await ctx.ui.input(title, "", opts);
			const text = typeof answer === "string" ? answer.trim() : "";
			if (text.length === 0) return undefined;
			return { answer: text, by: `operator dialog (${ctx.mode})` };
		},
	};

	/**
	 * Emit one command's output on the right channel (cp-8v1). Long human-readable
	 * payloads become durable TUI entries; everything else notifies exactly as it
	 * did before, so headless callers and the RPC tests are unaffected.
	 */
	const emit = (
		ctx: ExtensionContext,
		source: string,
		text: string,
		options: { level?: "info" | "error"; json?: boolean } = {},
	): void => {
		const level = options.level ?? "info";
		const channel = chooseOutputChannel({
			mode: ctx.mode,
			hasUI: ctx.hasUI,
			text,
			...(options.json ? { json: true } : {}),
		});
		if (channel === "entry") {
			pi.appendEntry<OutputEntry>("cp-output", { source, text, level });
			return;
		}
		if (channel === "notify") {
			ctx.ui.notify(text, level);
			return;
		}
		// print/json modes: stdout belongs to the transcript/event stream.
		process.stderr.write(`${text}\n`);
	};

	/**
	 * Redraw the fleet widget from files only (`statusNow`): no br, no probe of
	 * anything but pids, no tokens. Identical lines are not re-sent — in RPC mode
	 * every `setWidget` is a protocol message, and a widget that repaints itself
	 * five times a second with the same content is noise on somebody's socket.
	 *
	 * Two payload shapes, one renderer (cp-8tu):
	 *
	 *  - **TUI** — a component factory, so `render(width)` gets the terminal's
	 *    real width instead of the 100-column guess the old renderer made, and
	 *    the role → theme mapping can apply (`fleet-widget.ts`). A resize
	 *    re-renders the same closure at the new width.
	 *  - **RPC** — a plain string array at `WIDGET_MAX_WIDTH`, with no ANSI:
	 *    component factories are ignored over RPC and the client receives these
	 *    strings verbatim.
	 *
	 * The identical-output guard compares the *plain* render at the fallback
	 * width, which is a content fingerprint in both modes.
	 */
	const refreshWidget = (ctx: ExtensionContext | undefined): void => {
		if (!ctx) return;
		try {
			const post = commandPost();
			const snapshot = post.statusNow();
			// cp-wedged-tool-call: same snapshot, one more question asked of it.
			// Deliberately BEFORE the identical-output guard below: a wedged call is
			// news even when it changes nothing on screen -- "the widget looks the
			// same as it did an hour ago" is precisely how fifteen hours went by.
			surfaceWedged(snapshot);
			// cp-answer-doesnt-wake: the retry path. An answer recorded while nothing
			// could be delivered (a failed send, a parent that was not live) reaches the
			// session here, on a tick that already reads state/ — no new poll.
			surfaceAnswered();
			// Graceful drain: this tick moves a running drain to drained/timed out once; its one wake goes out
			// just below. It is periodic in every mode (session-hooks.ts arms setInterval(WIDGET_REFRESH_MS) as the
			// widget or orchestration timer), so the deadline fires even while a worker sits in one long tool call.
			try {
				post.drain.check();
			} catch (error) {
				process.stderr.write(`drain outcome wake not journaled; retried on the next tick: ${(error as Error).message}\n`);
			}
			surfaceDurableWakeups();
			// cp-6lg7: and the same retry path for an answer card. This is the tick that
			// catches the card queued mid-turn: the drain waits for an idle session, and
			// the operator reads the answer where they are looking.
			surfaceAnswerCards();
			// spec 2026-09-05: an unconfirmed cp-verdict is resent once, on the tick
			// that is already running. Memory plus the transport; no file, no poll.
			try {
				post.reviewRuns.resendDue();
			} catch {
				// A resend that fails costs a duplicate later, never a missed verdict.
			}
			// Display-only from here. Orchestration above runs with hasUI false.
			if (!ctx.hasUI) return;
			// cp-av8: a permanent, cheap marker so an open decision can never be
			// silently missed even if every dialog is dismissed. File-derived,
			// costs no tokens, and never suppressed by a snooze (only re-prompting is).
			// The same items also name the jobs, which is what puts a row under
			// NEEDS YOU instead of leaving the count unattached to any worker.
			let awaiting: ResolvedAwaitingItem[] = [];
			try {
				awaiting = post.awaitingSnapshotSync();
			} catch {
				// Degraded rendering here is fine; /cp-decide and cp_status_block both
				// surface the underlying failure loudly.
			}
			const ascii = process.env.CP_WIDGET_ASCII === "1";
			// cp-g1tc: the picker's own state, refreshed from the same snapshot.
			const options = { awaiting, ascii };
			const plain = statusWidgetLines(snapshot, { ...options, width: WIDGET_MAX_WIDTH });
			const rendered = plain.join("\n");
			if (rendered === s.widgetShown) return;
			s.widgetShown = rendered;
			if (plain.length === 0) {
				ctx.ui.setWidget(FLEET_WIDGET_KEY, undefined);
				return;
			}
			if (ctx.mode === "tui") {
				ctx.ui.setWidget(FLEET_WIDGET_KEY, (_tui, theme) => ({
					// pi insets a widget line by one column on each side, so the usable
					// budget is the width it hands us; a line over it would WRAP (not
					// truncate) and silently grow the widget by a row.
					render: (width: number) => styleWidgetLines(theme, renderFleetWidget(snapshot, { ...options, width })),
					invalidate: () => {},
				}));
				return;
			}
			ctx.ui.setWidget(FLEET_WIDGET_KEY, plain);
		} catch {
			// A widget is a convenience; an unreadable fleet is reported by
			// reconcile and by /status, which are the surfaces that may fail loudly.
		}
	};

	const repaintWidget = (): void => {
		s.widgetShown = undefined;
		refreshWidget(s.live);
	};

	// pi's model registry arrives on a ctx, and which ctx comes first is not up
	// to us (a widget refresh has no registry, a tool call does). So the latest
	// one is remembered and read lazily: a registry captured at construction
	// would freeze the availability probe as "unknown" for the whole session (`s.registry`).

	// Built on demand so a session that never dispatches pays nothing.
	const commandPost = (modelRegistry?: unknown): CommandPost => {
		if (modelRegistry) s.registry = modelRegistry;
		if (!s.post) {
			s.post = new CommandPost({
				home: currentRuntime().home,
				packageRoot: PACKAGE_ROOT,
				runtime: currentRuntime(),
				authorizer,
				asker,
				modelRegistry: () => s.registry as never,
				// spec 2026-09-05: a reviewer's verdict wakes this session like an
				// envelope does — stamped, re-checked at delivery, confirmed on arrival.
				sendWakeup: (wakeup) =>
					sendWakeup(verdictStamp(wakeup.jobId, wakeup.surface, wakeup.attempt, wakeup.headSha), wakeup.content, {
						...wakeup.details,
						verdict_key: `${wakeup.jobId}|${wakeup.surface}|${wakeup.attempt}`,
					}),
				// cp-runtime-deferred-recheck: a passing diff review is the other fact a
				// deferred merge ask waits on (`green but unreviewed`). Awaited *before*
				// the wake-up above is sent, with the verdict already on disk, so a parent
				// that reads "review passed" finds the merge row already open whenever the
				// re-gate finished in time — and `ReviewRuns` bounds the wait, so a hook
				// that hangs delays neither the verdict nor the slot. The payload is
				// handed over verbatim and parsed defensively: an irrelevant surface, a
				// revise, or details of any other shape does nothing.
				beforeWakeup: (wakeup) => recheckDeferredRows({ kind: "verdict", wakeup }),
				// jje.2: this live parent advances its held PRs on envelope/CI/review/startup facts itself.
				continuation: true,
				// Evidence for the bridge, not a request to dispatch or grant authority.
				onIdleBeads: (text) => pi.sendMessage({
					customType: "cp-idle-beads", content: text, display: true,
				}, { triggerTurn: false }),
				// An envelope is news: it reaches the parent as a custom message so
				// the session acts on it, with the headline only — never a body.
				onReported: (result) => {
					refreshWidget(s.live);
					// cp-u3o4: a Q&A job's result is an answer the operator reads on a
					// card — not a plan they have to open. cp-6lg7: the card is already
					// queued on disk by `CommandPost` at this point, so this drain is an
					// attempt, not the delivery; a card it cannot show now (mid-turn, no
					// surface yet) is shown by the widget tick or the next session.
					surfaceAnswerCards();
					// schedlater S1: a runner-owned scheduled run is torn down in code, no parent turn;
					// a refused teardown makes the runner send this same envelope wake itself.
					const runner = s.scheduleRunner?.();
					if (runner?.claims(result)) {
						claimedRun(runner, result, wakeEnvelope);
						return;
					}
					wakeEnvelope(result);
				},
				// cp-answer-doesnt-wake: an answer is already recorded and already queued
				// when this fires; the drain is what actually wakes the session.
				onAnswered: () => {
					refreshWidget(s.live);
					surfaceAnswered();
				},
				// A run that finished and filed nothing is the one silence the parent
				// cannot sleep through (cp-settle-without-report): with no envelope it
				// is never woken, which is how four merge-ready PRs sat for 14 hours.
				// The nudge itself only refreshes the widget — if it works, the envelope
				// is the news. A spent nudge wakes the session, headline only.
				onDurableWakeup: () => {
					refreshWidget(s.live);
					surfaceDurableWakeups();
				},
				onHardBound: () => {
					refreshWidget(s.live);
				},
				onUnreportedSettle: (jobId, outcome) => {
					refreshWidget(s.live);
					// A failed transition already journaled cp-death/cp-bound. cp-unreported
					// would not survive a restart, so it must not be the announcement.
					if (outcome.action === "recorded" && outcome.failure) return;
					const line = formatSettleOutcome(jobId, outcome);
					if (!line || outcome.action !== "recorded") return;
					// cp-p6m: an unreported settle is a claim about an OPEN envelope slot.
					// A worker that was nudged and then reported (or was promoted, or was
					// torn down) makes that claim false, so this carries the generation it
					// was true for and is withheld once the job has moved past it.
					const generation = (() => {
						try {
							return (commandPost().fleet.get(jobId)?.supersessions ?? 0) + 1;
						} catch {
							return undefined;
						}
					})();
					sendWakeup(
						{
							kind: "unreported",
							job_id: jobId,
							...(generation !== undefined ? { generation } : {}),
						},
						line,
						{ job_id: jobId, ...outcome },
					);
				},
			});
		}
		return s.post;
	};

	/**
	 * The Q&A path, in one place (cp-u3o4), so `/cp-ask` and `cp_ask` cannot
	 * drift: one br issue, three labels, one read-only worker, and the answer
	 * lands as a card.
	 *
	 * **The br issue stays**, deliberately: every dispatch precondition keys on a
	 * job id — `ledger.show`, the claim, `branch = job id`, the run directory, the
	 * artifact directory, the lease holder, the fleet record — and so does the
	 * whole observation stack (settle recovery, revive, `/watch`, wake-up
	 * staleness). A "lighter id" would fork all of that to save one `br create`
	 * and one `br close`.
	 *
	 * Labels: `project:<name>`, `delivery:answer`, `kind:research`. Title is the
	 * question. Lifecycle is an ordinary research job's: open → claimed at
	 * dispatch → `held` on the envelope (`next: "teardown"`, never a hold) →
	 * `cp_teardown` (the read-only gate, which closes with `answered: …`).
	 *
	 * Scope/risk are fixed at S/low: a question that is not small is not a
	 * question, and the worker is told to say so rather than write a plan.
	 */
	const askQuestion = async (request: {
		project?: string;
		question: string;
		model?: string;
		thinking?: ThinkingLevel;
		registry?: unknown;
	}): Promise<{ job_id: string; dispatch: Awaited<ReturnType<CommandPost["dispatch"]>> }> => {
		const question = request.question.trim();
		if (question.length === 0) throw new Error("cp_ask needs a question");
		const project = resolveProjectArg(currentRuntime(), request.project, "cp_ask");
		const post = commandPost(request.registry);
		const issue = await post.ledger().create({
			title: question,
			project,
			delivery: "answer",
			kind: "research",
			description: question,
		});
		const dispatch = await post.dispatch({
			jobId: issue.id,
			task: question,
			scope: "S",
			risk: "low",
			...(request.model ? { model: request.model } : {}),
			...(request.thinking ? { thinking: request.thinking } : {}),
		});
		return { job_id: issue.id, dispatch };
	};

	/**
	 * cp-9c5: the reader that never touches this session. Builds the two deps
	 * `openPlanViewer` needs — `readSource` (the one call to `readPlanSource`,
	 * only ever reached after the TUI gate) and `renderLines` (markdown, the
	 * same rendering path `summarize.ts` uses) — from a resolved `PlanTarget`.
	 * Kept outside `openPlanViewer` on purpose: that module has no pi-coding-agent
	 * theme import, so it cannot build a real `Markdown` renderer itself.
	 */
	const planViewerDeps = (target: PlanTarget): OpenPlanViewerDeps => ({
		readSource: (resolved) => {
			const raw = readPlanSource(resolved.path, PLAN_VIEW_MAX_BYTES);
			if (resolved.kind !== "gate") return raw;
			// A truncated gate JSON file cannot be parsed; that is vanishingly
			// unlikely (gate decisions are small) but must degrade, not throw.
			try {
				const parsed: unknown = JSON.parse(raw.text);
				return { text: renderGateDocument(parsed, resolved.researchId), bytes: raw.bytes, truncated: raw.truncated };
			} catch {
				return { text: `# Gate decision — ${resolved.researchId}\n\n(truncated before it could be parsed as JSON; see ${resolved.path})`, bytes: raw.bytes, truncated: raw.truncated };
			}
		},
		renderLines: (text, width) => new Markdown(text, 1, 0, getMarkdownTheme()).render(width),
	});

	return { emit, refreshWidget, repaintWidget, commandPost, askQuestion, planViewerDeps, wakeEnvelope };
}
