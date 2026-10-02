/**
 * Awaiting-you, made answerable: the dialog loop, its `agent_settled` auto-open and /cp-awaiting.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CommandPost } from "../../src/command-post.ts";
import {
	type AwaitingWriters,
	forgetSnoozed,
	resolveAwaitingResponse,
	type ResolvedAwaitingItem,
	snoozeOffered,
} from "../../src/awaiting.ts";
import { type AwaitingDialogStep, driveAwaitingDialog } from "../../src/awaiting-dialog.ts";
import { driveAwaitingQuestionnaire } from "../../src/awaiting-questionnaire.ts";
import {
	autoOpenDecision,
	type AwaitingSurface,
	canAutoOpenOverlay,
	endedByOperator,
	overlayFallbackNotice,
	overlayTimeoutMs,
	promptBusyNotice,
	snoozeCandidates,
	surfaceBusyNotice,
} from "../../src/awaiting-ui.ts";
import { isoTimestamp, SUGGEST_DEADLINE_MS } from "../../src/contracts.ts";
import { createSuggestionGenerator, type SuggestModelRegistryLike } from "./suggest-model.ts";
import { type PlanTarget } from "../../src/plan-view.ts";
import { openPlanViewer } from "./plan-viewer.ts";
import { askQuestionnaire, dialogPrompts } from "./questionnaire.ts";
import { formatAwaitingLine, formatDecideListing, decisionPaneFactory } from "./helpers.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerAwaitingCommand(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, emit, refreshWidget, planViewerDeps, awaitingLatch, humanPrompt } = deps;

	// cp-av8: Awaiting-you, made answerable. Three sources merged (pending
	// checkpoints, held research with no PR, declared rows) and answered here —
	// never as a tool, so a model can never reach the write path. Authorization
	// items still resolve through the one writer, CheckpointStore.decide, exactly
	// as /cp-authorize does; every other item resolves through
	// AwaitingStore.answerResolved, which materialises a *derived* row (held
	// research with no PR) under the very id the operator was shown rather than
	// failing with "no awaiting item". Skip writes nothing anywhere: the item
	// simply stays open, and a derived row is not even created.
	/**
	 * The injected `suggest` dependency (cp-7t7): best-effort, session-cached,
	 * built fresh per call so an edit to data/suggest.json or data/routing.json
	 * takes effect on the very next dialog. `ctx.modelRegistry` satisfies
	 * `SuggestModelRegistryLike` structurally — no cast beyond the type boundary
	 * itself, and this is the *only* place that object reaches a `complete` call.
	 */
	const suggestGenerator = (ctx: ExtensionContext) => {
		const post = commandPost(ctx.modelRegistry);
		return createSuggestionGenerator({
			registry: ctx.modelRegistry as unknown as SuggestModelRegistryLike | undefined,
			config: () => post.suggestConfig(),
			resolveModel: () => post.suggestionModel(),
			notify: ctx.hasUI ? (text, level) => ctx.ui.notify(text, level) : undefined,
		});
	};

	/** A malformed data/suggest.json degrades to the built-in deadline, never a thrown dialog. */
	const safeSuggestDeadlineMs = (post: CommandPost): number => {
		try {
			return post.suggestConfig().deadline_ms ?? SUGGEST_DEADLINE_MS;
		} catch {
			return SUGGEST_DEADLINE_MS;
		}
	};

	const awaitingWriters = (ctx: ExtensionContext): AwaitingWriters => ({
		// cp-khf: the row's own `checkpoint_kind` picks the store, so /cp-decide
		// answers the very question it offered — the same single writer
		// (`CheckpointStore.decide`) either way, and no second write path. cp-uug:
		// a merge row additionally carries the head sha it authorizes, and that
		// scope is what selects the file.
		decideCheckpoint: async (jobId, approved, by, kind, scope) => {
			const post = commandPost(ctx.modelRegistry);
			const pipeline = post.pipeline();
			const store =
				kind === "diff" ? pipeline.diffCheckpoints : kind === "merge" ? post.mergeCheckpoints : kind === "final_fix" ? post.finalFixCheckpoints : pipeline.checkpoints;
			store.decide(jobId, approved, { by, ...(scope ? { scope } : {}) });
		},
		answerDeclared: async (item, answer, by) => {
			await commandPost(ctx.modelRegistry).awaiting.answerResolved(item, { answer, by });
		},
		answerEscalation: async (id, answer, by) => {
			const post = commandPost(ctx.modelRegistry);
			const existing = post.escalations.get(id);
			if (existing?.kind === "plan_approval" && /^revise\b/i.test(answer.trim())) {
				const text = answer.replace(/^revise:?\s*/i, "").trim() || answer;
				await post.pipeline().revisePlan(existing.job_ids[0] as string, text);
			}
			await post.escalations.answer(id, { answer, by });
		},
	});

	/** Best-effort audit comment (D2): the answer is never lost if br is down. */
	const auditAnswer = async (
		ctx: ExtensionContext,
		item: ResolvedAwaitingItem,
		answer: string,
		by: string,
	): Promise<void> => {
		if (!item.job_id || item.type === "authorization") return;
		try {
			await commandPost(ctx.modelRegistry).ledger().comment(
				item.job_id,
				`decision: ${item.decision} \u2014 answered "${answer}" by ${by} at ${isoTimestamp()} (awaiting ${item.id})`,
			);
		} catch {
			// br is the audit trail, not the queue: an unreachable br degrades to an
			// un-audited answer, never a lost one. The answer already landed above.
		}
	};

	/**
	 * The one dialog loop, shared by `/cp-decide` (manual, `auto: false`) and the
	 * `agent_settled` auto-open (`auto: true`, cp-awaiting-autoopen). Reusing it
	 * is the whole point: one answering path, one resolver, one set of answer
	 * semantics (free text, skip, any order) regardless of who opened it.
	 *
	 * The single-run latch refuses to stack a second loop — an auto-open already
	 * in flight is never interrupted by another auto-open, and the reverse can't
	 * happen in a single-focus TUI anyway, but the guard costs nothing to keep.
	 *
	 * `auto: true` additionally records "do not nag" state (requirement 4): every
	 * item this run offers — answered, skipped, or the whole dialog dismissed via
	 * Done/timeout — is folded into `awaitingSnoozed` via `snoozeOffered`, so the
	 * very next settle does not reopen for the same batch. A brand-new item is
	 * never in that set and still triggers the next auto-open. An item that is
	 * actually answered is freed with `forgetSnoozed` since it has left the open
	 * set for good either way.
	 */
	const runAwaitingDialog = async (ctx: ExtensionContext, options: { auto: boolean }): Promise<void> => {
		const surface: AwaitingSurface = options.auto ? "auto_open" : "decide";
		// pi-command-post-p18: the latch now names its holder, which may be a
		// checkpoint ask rather than another run of this loop. An auto-open stays
		// silent; a typed /cp-decide is told which surface is already on screen,
		// exactly as `ConsoleGate.allowAwaiting` does for a console.
		const holder = awaitingLatch.holder;
		if (holder) {
			if (!options.auto && ctx.hasUI) ctx.ui.notify(surfaceBusyNotice(holder, surface), "info");
			return;
		}
		if (humanPrompt.open) {
			if (!options.auto && ctx.hasUI) ctx.ui.notify(promptBusyNotice(surface), "info");
			return;
		}
		// Same gate as the authorizer, and the same reason (spike Q3): nothing this
		// loop shows can be seen behind a full-screen console, and every key the
		// operator presses there belongs to the console. An auto-open simply does
		// not happen; a typed /cp-decide says why.
		await awaitingLatch.run(surface, async () => {
			const post = commandPost(ctx.modelRegistry);
			const writers = awaitingWriters(ctx);
			const by = `operator dialog (${ctx.mode})`;
			// cp-9c5: the pager is offered as a *step* inside one item's menu, and only
			// where it can actually render (a real TUI — `custom()` is a no-op
			// everywhere else, so there is no point offering it). `driveAwaitingDialog`
			// owns the ordering: the viewer is the default choice until the plan has
			// been read, and `Done reading — back to the list` is the default after
			// that, so a stray Enter never reopens the pager and never answers anything.
			const targets = new Map<string, PlanTarget>();
			const targetFor = (item: ResolvedAwaitingItem): PlanTarget | undefined => {
				if (!item.job_id || ctx.mode !== "tui") return undefined;
				const cached = targets.get(item.id);
				if (cached) return cached;
				try {
					const target = post.planTarget(item.job_id);
					targets.set(item.id, target);
					return target;
				} catch {
					// A plan that cannot be resolved is simply not offered; it must never
					// take the decision down with it.
					return undefined;
				}
			};
			const generator = suggestGenerator(ctx);
			// The dependencies both loops share. Extracted so the questionnaire and
			// the plain dialogs answer through exactly one writer path, one audit
			// call and one pager — the UI is the only thing that differs.
			const planViewable = (item: ResolvedAwaitingItem): boolean => {
				const target = targetFor(item);
				return target !== undefined && target.kind !== "absent";
			};
			const viewPlan = async (item: ResolvedAwaitingItem): Promise<void> => {
				const target = targetFor(item);
				if (!target || target.kind === "absent") return;
				await openPlanViewer(ctx, target, planViewerDeps(target));
			};
			// pi-command-post-4mn: the details pane, one factory for both loops. Files
			// only, so it costs this render path no network call, and memoised per run so
			// a redraw (including the plan-view round trip) re-reads nothing. It feeds the
			// *question*, never the options: what a stray Enter lands on is unchanged.
			const contextFor = decisionPaneFactory(post);
			// "Do not nag" (requirement 4) is the caller's bookkeeping, not the state
			// machine's: every item an auto-opened run offered — answered, skipped,
			// left, or the whole thing dismissed — is snoozed for this session, while a
			// manual /cp-decide never snoozes anything. `snoozeCandidates` is the one
			// rule, shared by the overlay run and the plain run (cp-gb3w).
			const snoozeRun = (run: { steps: readonly AwaitingDialogStep[]; offered: readonly ResolvedAwaitingItem[]; reason: string }): void => {
				if (!options.auto) return;
				const toSnooze = snoozeCandidates({
					steps: run.steps,
					offered: run.offered,
					endedByOperator: endedByOperator(run.reason),
				});
				if (toSnooze.length > 0) deps.awaitingSnoozed = snoozeOffered(deps.awaitingSnoozed, toSnooze);
			};

			const recordAnswer = async (item: ResolvedAwaitingItem, value: string) => {
				const result = await resolveAwaitingResponse({ id: item.id, kind: "answer", value, by }, item, writers);
				if (!result.note) {
					await auditAnswer(ctx, item, value, by);
					deps.awaitingSnoozed = forgetSnoozed(deps.awaitingSnoozed, item.id);
					refreshWidget(ctx);
				}
				return result;
			};

			// cp-vvaz: a typed `/cp-decide` **is** the package's questionnaire — every
			// open item is a tab in one overlay, submitted once — not a stack of
			// select dialogs wearing the overlay as a shim (cp-4864's mistake, which
			// on a real TUI degraded silently to the countdown dialog whenever the
			// package could not be resolved from this checkout).
			//
			// cp-gb3w: **so does the `agent_settled` auto-open**. It is the same loop,
			// the same writers and now the same UI, because answering the same item
			// should not look like two different products depending on which surface
			// happened to ask. The property the plain dialogs were carrying here — "can
			// never leave the parent unresponsive" — is carried instead by the gate
			// that opens this surface at all: `canAutoOpenDialog` proves a real,
			// interactive TUI, the overlay is on screen and Esc-dismissible rather than
			// hidden behind something, the single-run latch refuses to stack a second
			// run, and nothing here blocks the event loop (only this handler's own
			// continuation), so envelopes from live workers still arrive. Every context
			// that cannot prove a human — headless, `pi -p`, `--mode rpc`, a missing
			// package — routes to the timeout-bearing dialogs below, with the reason
			// said out loud (`routeAwaitingUi` / `overlayFallbackNotice`).
			//
			// Anything the overlay cannot serve is *named* and answered with the plain
			// dialogs in the same sitting: an unresolvable package (with the reason and
			// the fix), and any item whose options do not fit the package's 2–4 rows.
			let plainOnly: Set<string> | undefined;
			{
				const questionnaire = await driveAwaitingQuestionnaire({
					snapshot: () => post.awaitingSnapshot({ snoozed: deps.awaitingSnoozed }),
					// cp-gb3w review 2: only the unattended surface carries a deadline
					// (`overlayTimeoutMs`), and on expiry the overlay closes and the batch
					// is a skip — nothing written, every item still open.
					ask: (questions) =>
						askQuestionnaire(ctx, questions, {
							surface,
							...(overlayTimeoutMs(surface) !== undefined ? { timeoutMs: overlayTimeoutMs(surface) } : {}),
						}),
					answer: recordAnswer,
					planViewable,
					viewPlan,
					planHint: (item) =>
						item.job_id ? `read the plan first with /cp-plan ${item.job_id}` : undefined,
					context: contextFor,
					// cp-7t7: memoised by the item's fingerprint for this session, so an
					// unchanged item costs at most one model call, ever.
					suggest: (item) => deps.suggestionCache.get(item, generator),
					suggestDeadlineMs: safeSuggestDeadlineMs(post),
					notify: (text, level) => ctx.ui.notify(text, level),
					announceEmpty: !options.auto,
				});
				// The overlay run is a run like any other: what it offered and did not
				// answer is snoozed on the auto path, exactly as the plain run's is.
				snoozeRun(questionnaire);
				if (questionnaire.reason === "unavailable") {
					ctx.ui.notify(overlayFallbackNotice(surface, questionnaire.message ?? ""), "warning");
				} else if (questionnaire.deferred.length === 0) {
					refreshWidget(ctx);
					return;
				} else {
					const first = questionnaire.deferred[0];
					ctx.ui.notify(
						`${questionnaire.deferred.length} item(s) the questionnaire cannot render (${first?.item.id}: ` +
							`${first?.reason}) — answering them with the plain dialog`,
						"warning",
					);
					plainOnly = new Set(questionnaire.deferred.map((entry) => entry.item.id));
				}
			}

			const prompts = dialogPrompts(ctx);
			const outcome = await driveAwaitingDialog({
				snapshot: async () => {
					const items = await post.awaitingSnapshot({ snoozed: deps.awaitingSnoozed });
					return plainOnly ? items.filter((item) => plainOnly?.has(item.id)) : items;
				},
				formatLine: formatAwaitingLine,
				select: (title, selectOptions) => prompts.select(title, selectOptions),
				input: (title) => prompts.input(title),
				notify: (text, level) => ctx.ui.notify(text, level),
				announceEmpty: !options.auto && plainOnly === undefined,
				context: contextFor,
				// cp-7t7: memoised by the item's fingerprint for this session, so an
				// unchanged item across every redraw (including a plan-view round trip)
				// costs at most one model call, ever.
				suggest: (item) => deps.suggestionCache.get(item, generator),
				suggestDeadlineMs: safeSuggestDeadlineMs(post),
				planViewable,
				viewPlan,
				answer: recordAnswer,
			});
			snoozeRun(outcome);
			refreshWidget(ctx);
		});
	};

	// cp-awaiting-autoopen: open the same dialog the moment the agent settles,
	// instead of relying on the operator noticing the widget marker. Gated hard
	// by `canAutoOpenOverlay` (real TUI only) so headless, no-TTY, RPC-without-a-
	// provably-attached-human, json/print, and worker contexts (workers never
	// load this extension anyway) all fall back to today's behaviour untouched:
	// no error, no hang, just the marker plus `/cp-decide`. Every surface this
	// hook can open carries `AWAITING_DIALOG_TIMEOUT_MS` — the plain dialogs
	// through `dialogPrompts`, the overlay through `overlayTimeoutMs` — so this can
	// never leave the parent unresponsive: it resolves on an answer, or on the
	// deadline as a skip that writes nothing and releases the latch. Envelopes arriving from live workers meanwhile are
	// unaffected: nothing here blocks the event loop, only this handler's own
	// continuation, and `onReported` still fires and queues its follow-up message
	// independently of whether this dialog is open.
	pi.on("agent_settled", async (_event, ctx) => {
		setLive(ctx);
		return;
		if (!canAutoOpenOverlay(ctx) || awaitingLatch.busy || humanPrompt.open) return;
		let items: ResolvedAwaitingItem[];
		try {
			items = await commandPost(ctx.modelRegistry).awaitingSnapshot({ snoozed: deps.awaitingSnoozed });
		} catch {
			// Degraded here is fine: /cp-decide and the marker still surface the
			// underlying failure loudly on their own next use.
			return;
		}
		if (!autoOpenDecision({ env: ctx, latchBusy: awaitingLatch.busy || humanPrompt.open, items }).open) return;
		await runAwaitingDialog(ctx, { auto: true });
	});

	pi.registerCommand("cp-awaiting", {
		description:
			"List open Awaiting-you items. Answer with cp_decide, citing a mandate or a verbatim operator quote.",
		handler: async (_args, ctx) => {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			try {
				const items = await post.awaitingSnapshot();
				emit(
					ctx,
					"cp-awaiting",
					formatDecideListing(items.map((item) => ({ line: formatAwaitingLine(item) }))),
				);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
