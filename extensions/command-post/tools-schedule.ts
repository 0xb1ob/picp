/**
 * cp_schedule and the scheduler's host (Lane X, Pier 1.5). The policy is
 * src/scheduler.ts; this only ticks it while this session holds the parent
 * lock, catching up once on start. An answer/board/local fire is handed to the
 * schedule runner (src/schedule-runner.ts), which dispatches and tears it down
 * in code with no parent turn; a pr/pipeline fire wakes the parent to call cp_next.
 * Every 2 s it also consumes the Schedules page's journaled requests (src/schedule-control.ts, cp-hhuf P6).
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Delivery, JobKind } from "../../src/contracts.ts";
import { operatorTextsFromEntries, requireOperatorQuote } from "../../src/decide.ts";
import { DEFAULT_TOKEN_CEILING, loadMandateDefaults } from "../../src/mandate-defaults.ts";
import type { IntakeResult } from "../../src/intake.ts";
import { RUNNER_DELIVERIES, ScheduleRunner } from "../../src/schedule-runner.ts";
import { formatExpansionWake, pendingExpansions } from "../../src/schedule-expand.ts";
import { SCHEDULE_CONTROL_POLL_MS, ScheduleControl } from "../../src/schedule-control.ts";
import { formatScheduleEvent, formatSchedules, SCHEDULE_SKILLS, type ScheduleEvent, Scheduler, SCHEDULER_TICK_MS } from "../../src/scheduler.ts";
import type { ExtensionDeps } from "./shared.ts";

/** The quote is written verbatim as one ledger comment (≤4000 chars) after its `run-now quote sha <12 hex>: ` prefix. */
const RUN_NOW_QUOTE_MAX = 3900;

/** Whether `word` occurs in `text` as a whole token: no letter, digit or `_` right before or after it. */
export function namesToken(text: string, word: string, flags: "" | "i"): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, `u${flags}`).test(text);
}

export function registerScheduleTools(
	pi: ExtensionAPI, deps: ExtensionDeps, holdsLock: () => boolean,
	shareRunner: (get: () => ScheduleRunner | undefined) => void, wakeEnvelope: (result: IntakeResult) => void,
): void {
	let scheduler: Scheduler | undefined;
	let runner: ScheduleRunner | undefined;
	let timer: NodeJS.Timeout | undefined;
	// One startedAt per process: a reload is not a restart, so it never re-stamps "missed".
	const startedAt = new Date();
	const log = (line: string): void => void process.stderr.write(`pi-command-post: ${line}\n`);
	const build = (): Scheduler => {
		const post = deps.commandPost();
		return new Scheduler({
			home: post.home, ledger: () => post.ledger(), mandates: post.mandates,
			usageJobs: () => post.fleet.read().jobs, cloneOf: (project) => post.registry.pathOf(project), startedAt,
			archivedProjects: () => post.registry.archivedNames(),
			// A refire schedule re-reads these on every fire: an unregistered project or an unreadable defaults file refuses it.
			mintContext: (project) => {
				const entry = post.registry.get(project);
				if (!entry) return { refusal: `project ${project} is not registered` };
				const defaults = loadMandateDefaults(post.home);
				return { defaults, ...(entry.mandate ? { projectOverride: entry.mandate } : {}), ceiling: defaults.token_ceiling ?? DEFAULT_TOKEN_CEILING };
			},
		});
	};
	const buildRunner = (): ScheduleRunner => {
		const post = deps.commandPost();
		return new ScheduleRunner({
			dispatch: (request) => post.dispatch(request), tearDown: (jobId) => post.tearDown(jobId), ledger: () => post.ledger(),
			recorded: (jobId) => post.intake.intake(jobId), wake: wakeEnvelope,
			fleetJobs: () => post.fleet.read().jobs, schedules: () => (scheduler ??= build()).list(), now: () => new Date(), log,
		});
	};
	// The fleet owner only: a session without the lock never tears anything down.
	shareRunner(() => (holdsLock() ? (runner ??= buildRunner()) : undefined));
	const woken = new Set<string>();
	/** One `cp-schedule` wake per anchor per process: the live fire's wake and the restart sweep never double up. */
	const wakeParent = (anchorId: string, text: string, details: Record<string, unknown>): void => {
		if (woken.has(anchorId)) return;
		woken.add(anchorId);
		pi.sendMessage({ customType: "cp-schedule", content: text, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
	};
	const handle = (event: ScheduleEvent, active: ScheduleRunner): void => {
		const text = formatScheduleEvent(event);
		if (event.outcome !== "fired") log(text);
		else if (event.skill && event.job_id) wakeParent(event.job_id, text, { ...event });
		else if (event.delivery !== undefined && RUNNER_DELIVERIES.includes(event.delivery)) {
			log(text);
			void active.onFired(event);
		} else pi.sendMessage({ customType: "cp-schedule", content: text, display: true, details: { ...event } }, { deliverAs: "followUp", triggerTurn: true });
	};
	const tick = async (): Promise<void> => {
		// 4b-2 backstop: the queue's own owns() decides; a scheduler fault never stops it.
		try { await deps.commandPost().dispatchQueue.drain(); } catch (error) { log(`dispatch queue drain failed: ${(error as Error).message}`); }
		// unload-parent PR2 backstop: a blocker closed by hand (no landing) releases its armed dependents here; release() never throws.
		try { await deps.commandPost().armedDispatches.release(); } catch (error) { log(`armed dispatch release failed: ${(error as Error).message}`); }
		try {
			scheduler ??= build();
			runner ??= buildRunner();
			await runner.sweepReported();
			await runner.retryPending();
			// A deferred anchor not yet expanded (a restart before the fan-out finished) re-wakes the parent once per process.
			for (const { anchor, schedule } of pendingExpansions(deps.commandPost().ledger().read().jobs, scheduler.list())) {
				wakeParent(anchor.id, formatExpansionWake(anchor, schedule), { schedule_id: schedule.id, job_id: anchor.id, skill: schedule.job.skill });
			}
			for (const event of await scheduler.tick()) handle(event, runner);
		} catch (error) {
			log(`scheduler tick failed: ${(error as Error).message}`);
		}
	};
	let controlTimer: NodeJS.Timeout | undefined;
	let controlling = false;
	let control: ScheduleControl | undefined;
	// cp-hhuf P6: the Schedules page's journaled requests, applied through this same scheduler and runner.
	const drain = async (): Promise<void> => {
		if (controlling) return;
		controlling = true;
		try {
			const s = (scheduler ??= build());
			const active = (runner ??= buildRunner());
			control ??= new ScheduleControl({ stateDir: dirname(s.file), scheduler: s, log });
			for (const event of await control.pass()) handle(event, active);
		} catch (error) {
			log(`schedule control failed: ${(error as Error).message}`);
		} finally {
			controlling = false;
		}
	};
	// Registered after the session hooks, so the lock is already decided when this runs.
	pi.on("session_start", async () => {
		if (!holdsLock() || timer) return;
		timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
		timer.unref();
		setTimeout(() => void tick(), 0).unref(); // catch-up pass, after startup returns
		controlTimer = setInterval(() => void drain(), SCHEDULE_CONTROL_POLL_MS);
		controlTimer.unref();
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (controlTimer) clearInterval(controlTimer);
		controlTimer = undefined;
	});

	pi.registerTool({
		name: "cp_schedule",
		label: "Schedule",
		description:
			"Saved schedules: `add` a cron line (5 fields + IANA tz), a watch (a tracked script run every N seconds in the project's " +
			"canonical clone, firing on exit 0 or on changed stdout) or manual (Run now only); `list`, `enable`, `disable`, `remove`; " +
			"`run_now` fires one schedule now, only with operator_quote: the operator's verbatim sentence naming the schedule (single use). A manual schedule added with `refire:true` and " +
			"approval_quote (the operator's verbatim approval) snapshots its seed grant's bounds and mints a fresh grant from them on every Run now (merge and risk:high always asked). A fire records an ordinary " +
			"ledger job under the schedule's own grant (schedule_grant). answer/board/local fires are dispatched and torn down by the schedule runner " +
			"in code (an LLM schedule as one short-lived worker with its description as the task, a script_path schedule directly, no model); " +
			"pr/pipeline fires wake you (cp-schedule) for cp_next/cp_dispatch. Job caps, parallelism, risk gates and review apply either way. " +
			"Fires in the always-on parent; a slot missed while it was down is caught up once at start, noted \"missed <time>\".",
		promptSnippet: "Manage cron/watch schedules that file jobs under a mandate (cp_schedule)",
		promptGuidelines: [
			"A cp-schedule wake-up (pr/pipeline schedules only) names a created job: call cp_next and act on it like any other ready job; answer/board/local scheduled jobs are the schedule runner's, never dispatch them yourself.",
			"A cp-schedule wake naming a parent-expanded run is yours: follow its skill (cp-self-review) — create its jobs with label schedule:<id>, comment `expanded: …` on the anchor, dispatch them as the skill says; never dispatch the deferred anchor; close it once the synthesis job is torn down.",
			"A schedule needs its own active schedule grant (cp_mandate issue with schedule_grant:true, no job_ids, named by no other schedule): it covers only that schedule's jobs, and a project-wide grant never covers a scheduled job. A paused or expired grant skips the fire, never bypasses it.",
			"run_now needs the operator's verbatim sentence naming the schedule (its id or name) as operator_quote; never on your own initiative, and never by replaying an earlier sentence: one operator message authorizes one run now per schedule.",
			"refire:true (manual only) needs approval_quote, the operator's verbatim sentence approving per-fire grants; never propose it yourself. An operator revoke or pause of the fire grant stops the schedule until it is removed and re-added.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "list", "enable", "disable", "remove", "run_now"]),
			id: Type.Optional(Type.String({ description: "Schedule id (enable/disable/remove/run_now)" })),
			operator_quote: Type.Optional(Type.String({ maxLength: RUN_NOW_QUOTE_MAX, description: "run_now only: the operator's verbatim sentence naming the schedule (id or name)" })),
			name: Type.Optional(Type.String()),
			project: Type.Optional(Type.String()),
			mandate_id: Type.Optional(Type.String({ description: "The schedule grant (schedule_grant:true) every fire is filed under; one grant per schedule" })),
			cron: Type.Optional(Type.String({ description: "minute hour day-of-month month day-of-week" })),
			tz: Type.Optional(Type.String({ description: "IANA time zone for cron, e.g. Europe/Warsaw or UTC" })),
			watch_script: Type.Optional(Type.String({ description: "Tracked repository-relative script for a watch" })),
			every_seconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 86400 })),
			on: Type.Optional(StringEnum(["exit0", "changed"])),
			title: Type.Optional(Type.String({ description: "Title of each fired job (the slot is appended)" })),
			kind: Type.Optional(StringEnum(["ship", "research"])),
			delivery: Type.Optional(StringEnum(["pr", "local", "pipeline", "answer", "board"])),
			description: Type.Optional(Type.String()),
			script_path: Type.Optional(Type.String({ description: "Make each fired job a script job (ship/local)" })),
			manual: Type.Optional(Type.Boolean({ description: "A manual schedule: never fires on its own, only on Run now" })),
			skill: Type.Optional(StringEnum([...SCHEDULE_SKILLS], { description: "manual only: the fire records a deferred anchor and wakes you to expand it with this skill" })),
			refire: Type.Optional(Type.Boolean({ description: "manual only: each Run now mints a fresh grant from mandate_id's (the seed's) saved bounds; needs approval_quote" })),
			approval_quote: Type.Optional(Type.String({ maxLength: 4000, description: "refire only: the operator's verbatim sentence approving per-fire grants for this schedule" })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			deps.setLive(ctx);
			const s = (scheduler ??= build());
			const need = (key: keyof typeof params): string => {
				const value = params[key];
				if (value === undefined || value === "") throw new Error(`cp_schedule ${params.action} needs ${key}`);
				return String(value);
			};
			let text: string;
			if (params.action === "list") text = formatSchedules(s.list());
			else if (params.action === "add") {
				if (params.approval_quote !== undefined && !params.refire) throw new Error("cp_schedule add refused: approval_quote is for refire:true only");
				// The template authorizes nothing by itself, but its bounds are saved only on the operator's verbatim words.
				const verified = params.refire ? requireOperatorQuote(need("approval_quote"), { operatorTexts: operatorTextsFromEntries(ctx.sessionManager.getEntries()) }) : undefined;
				const added = await s.add({
					name: need("name"), project: need("project"), mandate_id: need("mandate_id"), title: need("title"),
					kind: need("kind") as JobKind, delivery: need("delivery") as Delivery,
					...(params.cron !== undefined ? { cron: params.cron } : {}), ...(params.tz ? { tz: params.tz } : {}),
					...(params.watch_script !== undefined ? { watch_script: params.watch_script } : {}),
					...(params.every_seconds ? { every_seconds: params.every_seconds } : {}), ...(params.on ? { on: params.on as "exit0" | "changed" } : {}),
					...(params.description ? { description: params.description } : {}), ...(params.script_path !== undefined ? { script_path: params.script_path } : {}),
					...(params.manual ? { manual: true as const } : {}), ...(params.skill ? { skill: params.skill } : {}),
					...(verified ? { refire: { approval: { operator_quote: verified.stored.operator_quote, decided_by: verified.decidedBy, ...(verified.provenance ?? {}) } } } : {}),
				});
				const notes = added.notes?.length ? `\nrefire template: ${added.notes.join("; ")}` : "";
				text = `added ${formatSchedules([added])}${notes}${holdsLock() ? "" : "\n(this session does not hold the parent lock: it will not fire here)"}`;
			} else if (params.action === "remove") {
				const removed = await s.remove(need("id"));
				text = `removed ${removed.schedule.id}${removed.note}`;
			}
			else if (params.action === "run_now") {
				// The fleet owner only, on one verbatim operator sentence that names the schedule; the fire itself enforces single use.
				if (!holdsLock()) throw new Error("cp_schedule run_now refused: this session does not hold the parent lock; only the parent that owns the fleet fires a schedule");
				const id = need("id");
				const schedule = s.list().find((entry) => entry.id === id);
				if (!schedule) throw new Error(`cp_schedule run_now refused: no schedule ${id}`);
				const quote = need("operator_quote");
				if (quote.length > RUN_NOW_QUOTE_MAX) throw new Error(`cp_schedule run_now refused: operator_quote is over ${RUN_NOW_QUOTE_MAX} characters`);
				const verified = requireOperatorQuote(quote, { operatorTexts: operatorTextsFromEntries(ctx.sessionManager.getEntries()) });
				const said = verified.stored.operator_quote;
				// Whole tokens only (word boundaries; the id case-sensitive): "nightly" inside "nightlyish" names nothing.
				if (!namesToken(said, schedule.id, "") && !namesToken(said, schedule.name, "i")) {
					throw new Error(`cp_schedule run_now refused: the quote names neither ${schedule.id} nor "${schedule.name}"; a run now needs the operator's sentence naming the schedule`);
				}
				const event = await s.fireNow(id, {
					via: "cp_schedule", tool_call_id: toolCallId, operator_quote: verified.stored.operator_quote, decided_by: verified.decidedBy,
					source_sha: createHash("sha256").update(verified.source).digest("hex").slice(0, 12), ...(verified.provenance ?? {}),
				});
				handle(event, (runner ??= buildRunner()));
				text = formatScheduleEvent(event);
			}
			else text = formatSchedules([await s.setEnabled(need("id"), params.action === "enable")]);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
