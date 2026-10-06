/**
 * The session's unasked wake-ups: how a fact (an envelope, an answer, CI, a
 * verdict, a wedged call, a durable wake-up) reaches the parent, is re-checked
 * for staleness at send and delivery time, and is confirmed on arrival.
 * Moved from index.ts as is; its closure state is read through `s` (./shared.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answeredIdsFromMessage, formatAnsweredNotice } from "../../src/answered.ts";
import { type AnswerCardData, formatAnswerNotice } from "../../src/answer-card.ts";
import { ciKeysFromMessage, type CiObservation, formatCiNotice } from "../../src/ci-watch.ts";
import { formatForeignCiNotice } from "../../src/foreign-ci-watch.ts";
import { runMainCiTick } from "../../src/main-ci.ts";
import type { CommandRunner } from "../../src/merge-ask.ts";
import type { CommandPost } from "../../src/command-post.ts";
import { ANSWER_ENTRY_TYPE, type AnswerCardChannel, type AnswerCardRecord, type AwaitingItem, DiffVerdictSchema, isSafeJobId, LAYOUT, paths, type StatusSnapshot } from "../../src/contracts.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { type DeferredRecheckTrigger, formatRaisedNotice, recheckDeferredBounded } from "../../src/deferred-recheck.ts";
import { readPriorAttempts, reviewCapExhausted } from "../../src/gate.ts";
import { messageText } from "../../src/parent-outbox.ts";
import { operatorNotify } from "../../src/parent-session.ts";
import { durableWakeupProjects, homeMandateProjects, homeProjectResolver, type ProjectOf, projectsOf } from "../../src/project-report.ts";
import { scheduledJobIds } from "../../src/relay-scope.ts";
import { SendFirstGate } from "../../src/send-first-gate.ts";
import { durableIdsFromMessage } from "../../src/wakeup-outbox.ts";
import { boundedSeen, reviewWakeups, toolCallKey, WAKEUP_SOURCE_FAILURE_MEMORY, type WakeupCarrier, type WakeupReplayMemory, type WakeupFacts, type WakeupMessage, type WakeupStamp, WakeupNotifier, wakeupFacts, verdictKeysFromMessage } from "../../src/wakeups.ts";
import { formatWedgedNotice } from "../../src/wedged.ts";
import { currentRuntime, sourceFailureRecorder, wakeupHeadSources } from "./helpers.ts";
import type { SessionState } from "./shared.ts";

export type WakeupSurfaces = ReturnType<typeof createWakeupSurfaces>;
/** cp-vy73: the busy-wake gate's one triggering line after a run whose late notices no request carried. Unstamped. */
export const WAKEUP_NUDGE_TYPE = "cp-wakeup-nudge";

/**
 * Where the answer-card sink shows a card. cp-hhuf P1: a scheduled job's answer goes to the
 * Schedules page, never the operator transcript. Entries are TUI-only session data (see
 * `chooseOutputChannel`'s two exclusions), so other UI modes get the pointer as a notice. With no
 * operator surface at all (print/json, or a re-entry with no ctx yet) the card stays queued:
 * writing it to stderr would mark it delivered and the operator's terminal would never show it.
 */
export function answerCardChannel(home: string, jobId: string, live: { mode?: string; hasUI?: boolean } | undefined): AnswerCardChannel | undefined {
	if (scheduledJobIds(home, [jobId]).size > 0) return "schedules_page";
	if (live?.mode === "tui" && live.hasUI) return "card";
	if (live?.hasUI) return "notice";
	return undefined;
}

export function createWakeupSurfaces(
	pi: ExtensionAPI,
	s: SessionState,
	late: { commandPost: () => CommandPost; repaintWidget: () => void; mainCi?: { exec?: CommandRunner; tick?: typeof runMainCiTick } },
) {
	const commandPost = () => late.commandPost();
	const repaintWidget = () => late.repaintWidget();

	/**
	 * pi-command-post-b04 (finding 2): a head source that fails is a fact, not a
	 * silence. The old wiring wrapped each lookup in a bare `catch` that returned
	 * `undefined`, which is byte-identical to "this home has no such fact" — so a
	 * broken `reportedHeadSha` would have quietly handed head decisions back to
	 * the lagging CI observation, i.e. restored the very bug this fixes, with
	 * nothing anywhere to say so. The lookups now throw into `wakeupFacts`, which
	 * marks the reading degraded (it supersedes nothing) and reports it here.
	 *
	 * The dedupe, the bound and the truncation live in `sourceFailureRecorder`
	 * above, which is the tested unit; what stays here is the sink it writes to —
	 * the job's own run log, and never for a job with no run directory.
	 */
	const recordSourceFailure = sourceFailureRecorder((source, jobId, reason) => {
		if (!existsSync(join(currentRuntime().home, paths.runDir(jobId)))) return;
		commandPost().runs.open(jobId).cp("wakeup_source_failed", { source, reason });
	});

	/**
	 * cp-p6m: the facts a wake-up is checked against, read from the two surfaces
	 * the parent already has (the fleet file and the run projection). A fresh
	 * instance per check, memoised inside itself: a review pass asks about the
	 * same handful of jobs repeatedly, and every answer must be *now*, never a
	 * snapshot taken when the message was written.
	 */
	const wakeupFactsNow = (): WakeupFacts => {
		const post = commandPost();
		let snapshot: StatusSnapshot | undefined;
		return wakeupFacts({
			record: (jobId) => {
				try {
					return post.fleet.get(jobId);
				} catch {
					return undefined;
				}
			},
			statusJob: (jobId) => {
				try {
					snapshot ??= post.statusNow({ include: "all" });
					return snapshot.jobs.find((job) => job.job_id === jobId);
				} catch {
					return undefined;
				}
			},
			// cp-e2d: the third source, and a file read like the other two. A `cp-ci`
			// wake-up is a claim about one commit, so once the branch's head has moved
			// the message is history and its body must not travel.
			// spec 2026-09-05: what is on disk for one reviewer surface of one job.
			// Files only, like the three above.
			review: (jobId, surface) => {
				try {
					const pending = post.reviewRuns.pending(jobId, surface);
					const home = post.home;
					const decided =
						surface === "gate"
							? readPriorAttempts(home, jobId).decisions.map((decision) => decision.attempt)
							: surface === "review"
								? readPriorAttempts(home, jobId, paths.reviewFile, DiffVerdictSchema, {
										capExhausted: reviewCapExhausted,
									}).decisions.map((decision) => decision.attempt)
								: existsSync(join(home, paths.qualityFile(jobId)))
									? [1]
									: [];
					return { ...(pending ? { pending: pending.attempt } : {}), decided };
				} catch {
					return undefined;
				}
			},
			// cp-e2d + pi-command-post-b04: both readings of the branch head, each
			// with the moment it was taken, wired in one exported unit so the wiring
			// itself is testable (tests/wakeup-head-sources.test.ts).
			...wakeupHeadSources(post),
			onSourceFailure: recordSourceFailure,
		});
	};

	/**
	 * cp-p6m: the one door every unasked wake-up goes through.
	 *
	 * A `cp-envelope` for an envelope a promote had already archived reached the
	 * parent reading exactly like a fresh report, and acting on it would have
	 * meant merging an unrebased PR or tearing down a worker mid-rebase. So a
	 * wake-up now carries a stamp (job, generation, `reported_at`, tool call,
	 * issue time), the stamp is re-checked against disk here, and a wake-up that
	 * is already stale is simply not sent — recorded in the run log instead, so
	 * the silence is itself a fact. The second, decisive check is at delivery
	 * time in the `context` handler below.
	 */
	/**
	 * A withheld wake-up is silence, and silence about the silence is how this
	 * class of bug hides: the fact lands in the job's own run log, once per
	 * (stage, stamp) so a context review that runs on every provider request does
	 * not write the same line a hundred times. A job with no run directory is
	 * skipped rather than having one created for it.
	 */
	// pi-command-post-8ok: keyed by `issued_at`, so this memory grows with the
	// session and not with the fleet. Same bound as the head-source journal.
	const staleWakeupUnseen = boundedSeen();
	const recordStaleWakeup = (
		stamp: WakeupStamp,
		verdict: { delay_seconds: number; reason?: string },
		stage: "send" | "delivery",
	): void => {
		// A jobless stamp (a `recovery` listing torn-down candidates) lands in each listed job's log.
		const targets = stamp.job_id ? [stamp.job_id] : (stamp.keys ?? []).filter(isSafeJobId).slice(0, 8);
		if (targets.length === 0) return;
		const key = `${stage}:${stamp.kind}:${stamp.job_id ?? "-"}:${stamp.generation ?? ""}:${stamp.issued_at}`;
		if (!staleWakeupUnseen(key)) return;
		for (const jobId of targets) {
			try {
				if (!existsSync(join(currentRuntime().home, paths.runDir(jobId)))) continue;
				commandPost().runs.open(jobId).cp("wakeup_suppressed", {
					kind: stamp.kind,
					...(stamp.generation !== undefined ? { generation: stamp.generation } : {}),
					issued_at: stamp.issued_at,
					delay_seconds: verdict.delay_seconds,
					reason: verdict.reason ?? "",
					stage,
					...(stamp.keys?.length ? { keys: stamp.keys.slice(0, 8) } : {}),
				});
			} catch {
				// A run log that cannot be written must never resurrect a stale message.
			}
		}
	};

	// cp-project-grouped-reporting: every wake-up opens with its project.
	const projectOf = (): ProjectOf => homeProjectResolver(currentRuntime().home);
	const projectsFor = (jobIds: readonly (string | undefined)[]): string[] => projectsOf(projectOf(), jobIds);
	let suppressionReason = "stale";
	/**
	 * cp-vy73 (PR-3): the busy-wake gate. While a run is busy and one triggering
	 * wake-up already guarantees it another request, later wake-ups ride along
	 * with `triggerTurn: false` instead of queueing one follow-up turn each.
	 * `answered` always triggers, and an idle session never gets a
	 * non-triggering send: pi would append it with no turn (cp-cc45 F6).
	 * A non-triggering notice that no later request carried (the run's last
	 * turn was text-only) is stranded, so `agent_settled` sends one triggering
	 * nudge for it (F3: counted against the last provider request) — except
	 * after an operator abort, where the notices wait for the next prompt.
	 */
	const gate = { busy: false, triggered: false, aborted: false, nonTriggeringSent: 0, seenUpTo: 0 };
	// unload-parent PR3 (src/send-first-gate.ts): wakes held while a landed operator send is unanswered.
	const sendFirst = new SendFirstGate<() => void>();
	const releaseHeld = (): void => {
		for (const deliver of sendFirst.flush()) deliver();
	};
	const wakeGate = {
		agentStart: (): void => {
			gate.busy = true;
			gate.triggered = false;
			gate.aborted = false;
		},
		providerRequest: (): void => {
			gate.seenUpTo = gate.nonTriggeringSent;
		},
		/** A message reached the parent: release expired holds, then note any operator send it carries. */
		messageStart: (message: unknown): void => {
			releaseHeld();
			sendFirst.userMessage((message as { role?: unknown } | null)?.role, messageText(message));
		},
		/** A clean turn_end answered the landed sends: their held wakes go now. */
		turnEnd: (event: { type: string; [key: string]: unknown }): void => {
			sendFirst.turnEnd(event);
			releaseHeld();
		},
		agentEnd: (messages: readonly unknown[]): void => {
			const last = [...messages].reverse().find((m) => (m as { role?: unknown } | null)?.role === "assistant");
			if ((last as { stopReason?: unknown } | undefined)?.stopReason === "aborted") gate.aborted = true;
		},
		agentSettled: (): void => {
			// Idle first (F6): anything sent from here on triggers its own turn.
			gate.busy = false;
			gate.triggered = false;
			sendFirst.settled();
			// After an abort held wakes wait for the next message or wake, like the nudge below.
			if (!gate.aborted) releaseHeld();
			const unseen = gate.nonTriggeringSent - gate.seenUpTo;
			gate.seenUpTo = gate.nonTriggeringSent;
			if (unseen <= 0 || gate.aborted) return;
			pi.sendMessage(
				{ customType: WAKEUP_NUDGE_TYPE, content: `${unseen} fleet notice(s) arrived while you were busy; they are above.`, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	};
	const sendWakeup = (
		stamp: Omit<WakeupStamp, "issued_at">,
		content: string,
		details: Record<string, unknown>,
	): boolean => {
		const notifier = new WakeupNotifier({
			facts: wakeupFactsNow(),
			send: (message: WakeupMessage) => {
				const deliver = (): void => {
					const quiet = gate.busy && gate.triggered && stamp.kind !== "answered";
					pi.sendMessage(
						{
							customType: message.customType,
							content: message.content,
							display: message.display,
							// SAFETY: WakeupMessage.details is already a string-keyed record.
							details: message.details as unknown as Record<string, unknown>,
						},
						quiet ? { triggerTurn: false } : { deliverAs: "followUp", triggerTurn: true },
					);
					if (quiet) gate.nonTriggeringSent++;
					else if (gate.busy) gate.triggered = true;
				};
				// unload-parent PR3: an unanswered operator send goes first; held wakes count as sent (not acked).
				releaseHeld();
				if (sendFirst.offer(stamp.kind, deliver) === "send") deliver();
			},
			onSuppressed: (suppressed, verdict) => recordStaleWakeup(suppressed, verdict, "send"),
			projectOf: projectOf(),
		});
		const result = notifier.send(stamp, content, details);
		suppressionReason = result.verdict.reason ?? "stale";
		return result.sent;
	};

	/**
	 * cp-answer-doesnt-wake: an answered decision wakes the parent, exactly once.
	 *
	 * A report reaches this session as `cp-envelope` and a wedged tool call as
	 * `cp-wedged`; a human's answer reached *nothing*, so a decision the operator
	 * had already given sat in `state/awaiting.json` while the work it unblocked
	 * waited for a turn that was never invoked. This is the third instance of one
	 * pattern, delivered the same way as the first two: a `followUp` with
	 * `triggerTurn`, carrying the id, the type, the job and the answer, so the
	 * parent can act without re-reading a file.
	 *
	 * Delivery is a *drain*, not a callback, and that is what makes it honest:
	 * `CommandPost` queues every recorded answer in `state/answered.json` first,
	 * this sends whatever is queued, and an answer given with no live parent (a
	 * headless `/cp-authorize`), or one whose send failed, is sent on the next
	 * drain instead of being dropped — while `delivered` being on disk is what
	 * stops a restart replaying yesterday's answers as fresh wake-ups.
	 *
	 * **Sending is not delivering** (cp-nx7). `pi.sendMessage` queues a `followUp`
	 * that pi delivers on the parent's next turn, which can be minutes later, so
	 * nothing is marked delivered here. The `message_start` hook below sees the
	 * message actually land in the parent's context and confirms it *then*; an
	 * answer nobody was observed receiving stays pending and is sent again.
	 *
	 * **And sent again is not sent repeatedly** (cp-5mgg). The drain emits only
	 * what is *due* — an answer whose emission is on disk and inside its retry
	 * window is left alone — so these three triggers cannot compound into three
	 * copies of one authorization, which is exactly what they did. The last line
	 * of defence is in the `context` hook below: a copy carrying only ids an
	 * earlier message already delivered is rewritten as a replay, never as news.
	 *
	 * Three triggers, no poll: the answer itself, `session_start`, and the widget
	 * tick that already reads these files.
	 */
	/**
	 * cp-u3o4: the answer surface.
	 *
	 * A `delivery:answer` envelope means a worker answered one small question, and
	 * the operator asked for a short answer **in the main TUI** — not a plan they
	 * open with `/cp-plan`. So the card is appended to the transcript here, the
	 * moment intake accepts the envelope, exactly as `/status` already appends its
	 * long output.
	 *
	 * Context integrity is the mechanism, not a promise: a custom entry does not
	 * participate in LLM context (docs/extensions.md), and the payload written
	 * here is a **pointer plus the envelope headline** — path, byte count, job id,
	 * project — so the answer body is not even in the session file. The renderer
	 * reads the file from disk, capped, at render time.
	 *
	 * Non-TUI modes keep exactly today's behaviour: the wake-up headline and, when
	 * there is a UI at all, a notice naming the path and its size. Never a body.
	 *
	 * cp-6lg7: **the card is drained, not fired.** It used to be appended right
	 * here, synchronously, inside intake's callback — one attempt, mid-turn, in
	 * the same instant as a wake-up whose whole job is to describe a phase that
	 * was about to become `done`. A Q&A job that reported and was torn down seven
	 * seconds later lost its entire deliverable that way, twice in one session.
	 * The card is now recorded in `state/answer-cards.json` by `CommandPost` at
	 * intake and shown by this drain — at intake, at `session_start` and on the
	 * widget tick — until a real operator surface has taken it, exactly once.
	 */
	const answerCardData = (record: AnswerCardRecord): AnswerCardData => ({
		job_id: record.job_id,
		...(record.project ? { project: record.project } : {}),
		summary: record.summary,
		path: record.path,
		bytes: record.bytes,
		...(record.reported_at ? { reported_at: record.reported_at } : {}),
	});

	const surfaceAnswerCards = (): void => {
		try {
			// A card appended into a streaming turn is spliced above the message being
			// written, which is where the two lost answers went. Idle is preferred and
			// bounded: `answerCardDue` releases the card anyway once it has waited
			// `ANSWER_CARD_DEFER_SECONDS`, so a parent that never rests still delivers.
			const idle = (() => {
				try {
					return s.live?.isIdle() ?? false;
				} catch {
					return false;
				}
			})();
			commandPost().drainAnswerCards((record) => {
				const channel = answerCardChannel(currentRuntime().home, record.job_id, s.live);
				if (channel === "card") pi.appendEntry<AnswerCardData>(ANSWER_ENTRY_TYPE, answerCardData(record));
				else if (channel === "notice") s.live?.ui.notify(formatAnswerNotice(answerCardData(record)), "info");
				return channel;
			}, { idle });
		} catch {
			// A card that could not be shown stays pending, and the next tick tries
			// again. Delivery must never be able to break its own trigger.
		}
	};

	const surfaceDurableWakeups = (): void => {
		// A reentrant drain from inside `reconcile()`'s own journaling must wait for
		// the next tick (see `reconcileInProgress` above) instead of racing a caller's
		// first prompt.
		if (s.reconcileInProgress) return;
		try {
			// false/string from sendWakeup is a stale suppression: terminal. A throw
			// (transport) leaves the entry pending; the next sweep retries only that.
			commandPost().sweepDurableWakeups((entry) => {
				const projects = durableWakeupProjects(entry, projectOf(), homeMandateProjects(currentRuntime().home));
				const sent = sendWakeup(
					{
						kind: entry.kind,
						...(entry.job_id ? { job_id: entry.job_id } : {}),
						...(entry.generation !== undefined ? { generation: entry.generation } : {}),
						...(entry.keys ? { keys: entry.keys } : {}),
						...(projects ? { projects } : {}),
					},
					entry.content,
					{ durable_id: entry.id },
				);
				return sent ? true : suppressionReason;
			});
		} catch {
			// Transport failed. Still pending; next sweep retries. Stale ones already discarded.
		}
	};

	const confirmDurableArrival = (message: unknown): void => {
		try {
			const ids = durableIdsFromMessage(message);
			if (ids.length === 0) return;
			commandPost().confirmDurableWakeups(ids);
		} catch {
			// Arrival bookkeeping must never throw into the session.
		}
	};

	const surfaceAnswered = (): void => {
		try {
			commandPost().drainAnswered((decisions) => {
				const text = formatAnsweredNotice(decisions, projectOf());
				operatorNotify(s.live, text, "info");
				// cp-p6m: stamped like every other wake-up, and — alone among the four —
				// never suppressed by the staleness check. An answer is a fact about
				// what a human did, not a claim about a phase, so it cannot become
				// false; the failure mode on this path is a *lost* decision, which is
				// the whole reason src/answered.ts exists.
				// The stamp rides on top of cp-nx7's delivery, it does not replace it:
				// `details.answered` still carries every coalesced decision (that is the
				// arrival evidence `answeredIdsFromMessage` reads), nothing is marked
				// delivered here, and an answered wake-up is never withheld.
				sendWakeup(
					{
						kind: "answered",
						...(decisions.length === 1 && decisions[0]?.job_id ? { job_id: decisions[0].job_id } : {}),
						keys: decisions.map((decision) => decision.id),
						projects: projectsFor(decisions.map((decision) => decision.job_id)),
					},
					text,
					{ answered: decisions },
				);
			});
		} catch {
			// Nothing was marked delivered, so the answer is still queued and the next
			// drain retries it. A wake-up must never be able to break its own trigger.
		}
	};

	/**
	 * The other half of the same fix (cp-nx7): the *evidence*. A `cp-answered`
	 * message entering this session's context is the only proof a wake-up reached
	 * the parent, and the ids come off the message itself — not off the send that
	 * produced it, which only proves pi accepted a queue entry.
	 */
	const confirmAnsweredArrival = (message: unknown): void => {
		try {
			const ids = answeredIdsFromMessage(message);
			if (ids.length === 0) return;
			commandPost().confirmAnswered(ids);
		} catch {
			// An unconfirmed answer is re-sent; a throw here must never break the
			// message pipeline it is observing.
		}
	};

	/**
	 * cp-runtime-deferred-recheck: re-gate the deferred merge asks when the event
	 * that could release one actually happens, instead of when the parent
	 * remembers to render a status block.
	 *
	 * The two triggers are the two facts a deferral waits on — CI finishing on the
	 * branch's current head (`cp-ci`) and a diff review passing on it
	 * (`cp-verdict`, `pass -> proceed`). Nothing is rendered here and no model turn
	 * is required: `AwaitingStore.reviewDeferred` is the same writer and the same
	 * gate `cp_status_block` calls, so a row it opens shows up in the widget
	 * marker and in `/cp-decide` by itself, exactly once.
	 *
	 * **Bounded, and total.** Both callers are things that must keep going: the
	 * watch tick that carries the `cp-ci` notice and wake-up, and the reviewer's
	 * own delivery. `recheckDeferredBounded` therefore never throws and never
	 * outlives `DEFERRED_RECHECK_MAX_WAIT_MS` — a re-gate that fails or runs out
	 * of time says so in one line and opens nothing at that moment.
	 *
	 * **A late re-gate still announces what it opened.** The deadline stops the
	 * caller waiting; it cannot stop a `gh` query. When the slow one finishes and
	 * the gate opens rows on its ordinary evidence, `onLate` hands them to
	 * `announceRaised` — the *same* continuation the in-bound path uses, so both
	 * events and both timings produce one notice and one repaint, never two.
	 */
	const announceRaised = (raised: readonly AwaitingItem[]): void => {
		if (raised.length === 0) return;
		operatorNotify(s.live, formatRaisedNotice(raised), "info");
		// The marker (`⧗ N decisions awaiting you`) is what makes the newly open
		// row impossible to miss; repaint so it appears now, not on the next tick.
		repaintWidget();
	};

	const recheckDeferredRows = async (trigger: DeferredRecheckTrigger): Promise<void> => {
		announceRaised(
			await recheckDeferredBounded(commandPost().awaiting, trigger, {
				onFailure: (reason) => {
					operatorNotify(s.live, `pi-command-post: ${reason}`, "warning");
				},
				onLate: announceRaised,
			}),
		);
	};

	/**
	 * k52: the origin/main half of the CI-watch tick — one job-less `cp-ci` wake
	 * (`details.main_ci`) per red / green-again / released transition, for
	 * active-mandate projects, own runs only (cp-oc0m). Its own catch: a main-CI
	 * fault is journaled through `ciWatchFailed` and never stops the held-PR half.
	 */
	const surfaceMainCi = async (post: CommandPost): Promise<void> => {
		try {
			await (late.mainCi?.tick ?? runMainCiTick)({
				home: post.home,
				projects: post.registry.activeNames(),
				pathOf: (project) => post.registry.pathOf(project),
				mandates: () => post.mandates.list(),
				login: () => post.ghLogin(),
				...(late.mainCi?.exec ? { exec: late.mainCi.exec } : {}),
				onError: (project, message) => post.ciWatchFailed(new Error(`main CI${project ? ` (${project})` : ""}: ${message}`)),
				notify: (observation, text) => operatorNotify(s.live, text, observation.event === "main_ci_failed" ? "warning" : "info"),
				send: (observation, text) => sendWakeup({ kind: "ci", projects: [observation.project] }, text, { main_ci: observation }),
			});
		} catch (error) {
			try {
				post.ciWatchFailed(error);
			} catch {
				// A journal that cannot be written must never stop the held-PR half.
			}
		}
	};

	/**
	 * cp-wlhu S5: the foreign-PR half — facts about PRs this home did not ship.
	 * Notify-only by contract: no wake-up, no deferred-row recheck, no
	 * cp_integrate, no rerun, no comment. A query failure is journaled once per
	 * cause (run log when the job has one, plus one warning line); a fault here
	 * never stops the held-PR half.
	 */
	const surfaceForeignCi = async (post: CommandPost): Promise<void> => {
		try {
			const tick = await post.foreignCiTick();
			for (const error of tick.errors) {
				if (isSafeJobId(error.job_id) && existsSync(join(currentRuntime().home, paths.runDir(error.job_id)))) post.runs.open(error.job_id).cp("ci_watch_failed", { message: `foreign PR ${error.pr_url}: ${error.message}`.slice(0, 300) });
				operatorNotify(s.live, `pi-command-post: foreign PR CI query failed for ${error.job_id} (${error.pr_url}): ${error.message} — backing off`, "warning");
			}
			const text = formatForeignCiNotice(tick);
			if (text) operatorNotify(s.live, text, tick.observations.some((fact) => fact.event === "ci_failed") ? "warning" : "info");
		} catch (error) {
			operatorNotify(s.live, `pi-command-post: foreign PR CI watch tick failed: ${(error as Error).message.split("\n")[0]}`, "warning");
		}
	};

	/**
	 * cp-e2d: the fifth unasked wake-up — a fact GitHub owns.
	 *
	 * A worker never waits for CI (cp-kzc) and nothing local changes when a run
	 * finishes or a PR merges, so before this there was no path at all by which
	 * "the PR you are holding is green" could reach a parent that sleeps on
	 * wake-ups. Green PRs sat unmerged until a human happened to look.
	 *
	 * One coalesced `cp-ci` per tick carrying every due fact for every job (the
	 * shape `AnsweredOutbox.drain` uses), stamped like every other wake-up, and
	 * **nothing is marked delivered here**: the arrival observer below confirms
	 * the keys off the message that actually landed, and an unconfirmed fact is
	 * derived and sent again. At-least-once, keyed on (job_id, head_sha, event).
	 *
	 * It is evidence, never authorization: this path merges nothing, declares no
	 * Awaiting-you row and encodes no standing merge authority.
	 *
	 * Returns its pass so a test can await it; the timer ignores the value, and it
	 * never rejects (the outer catch journals). k52: the main half runs first.
	 */
	const surfaceCi = (): Promise<void> =>
		(async () => {
			try {
				const post = commandPost();
				const tick = await post.ciTick();
				// jje.2: a failed query is journaled on its job, never dropped with the tick.
				for (const error of tick.errors) {
					if (existsSync(join(currentRuntime().home, paths.runDir(error.job_id)))) post.runs.open(error.job_id).cp("ci_watch_failed", { message: error.message.slice(0, 300) });
				}
				if (tick.disabled && !s.ciWatchDisabledShown) {
					s.ciWatchDisabledShown = true;
					const text = `pi-command-post: the CI/PR watch is off for this session (${tick.disabled}). Held PRs will not wake you; check them with /status.`;
					operatorNotify(s.live, text, "warning");
				}
				// k52: with gh gone (watch disabled) the main half would only fail each tick.
				if (!tick.disabled) await surfaceMainCi(post);
				if (!tick.disabled) await surfaceForeignCi(post);
				const observations: CiObservation[] = tick.observations;
				if (observations.length === 0) return;
				// Before the wake-up, not because of it: CI finishing on the held head is
				// exactly what a deferred merge ask waits for, so the row is opened by the
				// same observation rather than by a tool call the parent might not make.
				// Bounded (`recheckDeferredBounded`), so a slow or wedged re-gate delays
				// the notice and the wake-up below by at most one bound, never forever.
				await recheckDeferredRows({ kind: "ci" });
				const text = formatCiNotice(observations, projectOf());
				operatorNotify(s.live, text, "info");
				const jobs = new Set(observations.map((observation) => observation.job_id));
				const only = jobs.size === 1 ? observations[0]?.job_id : undefined;
				const generation = (() => {
					if (!only) return undefined;
					try {
						return (post.fleet.get(only)?.supersessions ?? 0) + 1;
					} catch {
						return undefined;
					}
				})();
				sendWakeup(
					{
						kind: "ci",
						...(only ? { job_id: only } : {}),
						...(generation !== undefined ? { generation } : {}),
						// keys[0] is the head the facts are about: cp-p6m's staleness check
						// compares it with the head the watcher last observed on disk.
						...(only && observations[0] ? { keys: [observations[0].head_sha] } : {}),
						projects: projectsFor(observations.map((observation) => observation.job_id)),
					},
					text,
					{ ci: observations },
				);
			} catch (error) {
				// Best-effort, never silent: the timer keeps going and re-derives every
				// unconfirmed fact; the failure is a durable journal entry, once per cause.
				try {
					commandPost().ciWatchFailed(error);
				} catch {
					// A journal that cannot be written must never break the timer that carries it.
				}
			}
		})();

	/**
	 * The arrival evidence for a `cp-ci` wake-up (cp-nx7's discipline). The keys
	 * come off the message that reached this session's context — not off the send,
	 * which only proves pi accepted a queue entry.
	 */
	const confirmCiArrival = (message: unknown): void => {
		try {
			const keys = ciKeysFromMessage(message);
			if (keys.length === 0) return;
			commandPost().confirmCi(keys);
		} catch {
			// An unconfirmed fact is re-sent; a throw here must never break the
			// message pipeline it is observing.
		}
	};

	/** A `cp-verdict` reached this session's context (cp-nx7): confirm it and journal it. */
	const confirmVerdictArrival = (message: unknown): void => {
		try {
			const keys = verdictKeysFromMessage(message);
			if (keys.length === 0) return;
			const post = commandPost();
			for (const key of post.reviewRuns.confirm(keys)) {
				const [jobId, surface, attempt] = key.split("|");
				if (!jobId || !surface || !attempt) continue;
				post.runs.open(jobId).cp("verdict_wakeup_delivered", { surface, attempt: Number(attempt) });
			}
		} catch {
			// Observation only; never break the message pipeline.
		}
	};

	/**
	 * cp-wedged-tool-call: announce a newly wedged tool call, once.
	 *
	 * A worker that stops inside a tool call produces no envelope, and an
	 * envelope is the only thing that normally wakes this session. So this is
	 * the second — and only other — thing allowed to: a `tool_execution_start`
	 * with no matching end, silent past the threshold, on a live worker.
	 *
	 * It is a `followUp` with `triggerTurn`, exactly like `cp-envelope`, because
	 * the parent must *act* (tell the operator, name the job) rather than have
	 * the fact sit in a widget nobody is looking at. It carries a headline and
	 * facts, never a worker's output, and it kills nothing.
	 */
	const surfaceWedged = (snapshot: StatusSnapshot): void => {
		try {
			const fresh = s.wedgedWatch.observe(snapshot);
			if (fresh.length === 0) return;
			const text = formatWedgedNotice(fresh, projectOf());
			operatorNotify(s.live, text, "warning");
			// cp-p6m: stamped with the identity of the call that is wedged, so a
			// notice that arrives after the call returned (or after the worker died)
			// is recognisable as history rather than as a live wedge.
			const first = fresh[0];
			const keys = fresh.map((call) =>
				toolCallKey(call.job_id, snapshot.jobs.find((job) => job.job_id === call.job_id)?.tool_calls ?? 0),
			);
			sendWakeup(
				{
					kind: "wedged",
					...(fresh.length === 1 && first ? { job_id: first.job_id } : {}),
					keys,
					projects: projectsFor(fresh.map((call) => call.job_id)),
				},
				text,
				{ wedged: fresh },
			);
		} catch {
			// Surfacing is best-effort by construction: it must never be able to
			// break the widget tick that carries it.
		}
	};

	/**
	 * cp-p6m: the delivery-time staleness check, and the one that actually
	 * catches the incident.
	 *
	 * `pi.sendMessage` with `deliverAs: "followUp"` queues; every observed stale
	 * wake-up arrived *minutes* after the state it described, so checking only at
	 * send time would have delivered all three of them. The `context` event is
	 * the last moment before a message reaches the model, so it is where a
	 * wake-up for an archived envelope stops reading like a fresh report: the
	 * message the model sees is replaced with a short notice naming the job and
	 * what is true now, and the withheld body never enters the parent's context.
	 *
	 * Read-only about fleet state and best-effort: the session record is untouched
	 * (only the context handed to this request is rewritten), and a facts read
	 * that fails leaves the messages exactly as they were.
	 */
	// Observed delivery tokens and withheld identities persist, never enqueued notices or bodies.
	// The existing bounded memory must survive extension reload and parent/host restart.
	// ponytail: retains 512 identities; use a journal if longer replay retention is needed.
	let replayMemory: WakeupReplayMemory = new Map();
	let replayFile: string | undefined;
	let savedReplay = "";
	const replayFailureUnseen = boundedSeen();
	const replayFailure = (stage: "read" | "write", error: unknown): void => {
		const text = `pi-command-post: wake-up replay memory ${stage} failed (${replayFile}): ${String(error)}`;
		if (replayFailureUnseen(stage)) operatorNotify(s.live, text, "warning");
	};
	const reviewWakeupsInContext = <T extends WakeupCarrier>(messages: readonly T[]): T[] | undefined => {
		try {
			if (!replayFile) {
				replayFile = join(commandPost().home, LAYOUT.state, "wakeup-replay.json");
				try {
					if (existsSync(replayFile)) {
						const entries: unknown = JSON.parse(readFileSync(replayFile, "utf8"));
						if (!Array.isArray(entries) || !entries.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((v) => typeof v === "string"))) {
							throw new Error("expected identity/token pairs");
						}
						replayMemory = new Map(entries.slice(-WAKEUP_SOURCE_FAILURE_MEMORY));
					}
					savedReplay = JSON.stringify([...replayMemory]);
				} catch (error) { replayFailure("read", error); }
			}
			const review = reviewWakeups(messages, wakeupFactsNow(), new Date(), replayMemory);
			const snapshot = JSON.stringify([...replayMemory]);
			if (snapshot !== savedReplay) {
				try {
					atomicWriteJson(replayFile, [...replayMemory]);
					savedReplay = snapshot;
				} catch (error) { replayFailure("write", error); } // A failed write must not restore a withheld body.
			}
			if (!review.changed) return undefined;
			for (const stale of review.superseded) recordStaleWakeup(stale.stamp, stale.verdict, "delivery");
			return review.messages;
		} catch {
			return undefined;
		}
	};

	return {
		projectOf,
		sendWakeup,
		wakeGate,
		surfaceAnswerCards,
		surfaceDurableWakeups,
		confirmDurableArrival,
		surfaceAnswered,
		confirmAnsweredArrival,
		recheckDeferredRows,
		surfaceCi,
		confirmCiArrival,
		confirmVerdictArrival,
		surfaceWedged,
		reviewWakeupsInContext,
	};
}
