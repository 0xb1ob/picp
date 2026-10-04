/**
 * cp_schedule and the scheduler's host (Lane X, Pier 1.5). The policy is
 * src/scheduler.ts; this only ticks it while this session holds the parent
 * lock, catching up once on start. An answer/board/local fire is handed to the
 * schedule runner (src/schedule-runner.ts), which dispatches and tears it down
 * in code with no parent turn; a pr/pipeline fire wakes the parent to call cp_next.
 * Every 2 s it also consumes the Schedules page's journaled requests (src/schedule-control.ts, cp-hhuf P6).
 */
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Delivery, JobKind } from "../../src/contracts.ts";
import type { IntakeResult } from "../../src/intake.ts";
import { RUNNER_DELIVERIES, ScheduleRunner } from "../../src/schedule-runner.ts";
import { SCHEDULE_CONTROL_POLL_MS, ScheduleControl } from "../../src/schedule-control.ts";
import { formatScheduleEvent, formatSchedules, type ScheduleEvent, Scheduler, SCHEDULER_TICK_MS } from "../../src/scheduler.ts";
import type { ExtensionDeps } from "./shared.ts";

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
	const handle = (event: ScheduleEvent, active: ScheduleRunner): void => {
		const text = formatScheduleEvent(event);
		if (event.outcome !== "fired") log(text);
		else if (event.delivery !== undefined && RUNNER_DELIVERIES.includes(event.delivery)) {
			log(text);
			void active.onFired(event);
		} else pi.sendMessage({ customType: "cp-schedule", content: text, display: true, details: { ...event } }, { deliverAs: "followUp", triggerTurn: true });
	};
	const tick = async (): Promise<void> => {
		// 4b-2 backstop: the queue's own owns() decides; a scheduler fault never stops it.
		try { await deps.commandPost().dispatchQueue.drain(); } catch (error) { log(`dispatch queue drain failed: ${(error as Error).message}`); }
		try {
			scheduler ??= build();
			runner ??= buildRunner();
			await runner.sweepReported();
			await runner.retryPending();
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
			"Saved schedules: `add` a cron line (5 fields + IANA tz) or a watch (a tracked script run every N seconds in the project's " +
			"canonical clone, firing on exit 0 or on changed stdout); `list`, `enable`, `disable`, `remove`. A fire records an ordinary " +
			"ledger job under the schedule's own grant (schedule_grant). answer/board/local fires are dispatched and torn down by the schedule runner " +
			"in code (an LLM schedule as one short-lived worker with its description as the task, a script_path schedule directly, no model); " +
			"pr/pipeline fires wake you (cp-schedule) for cp_next/cp_dispatch. Job caps, parallelism, risk gates and review apply either way. " +
			"Fires in the always-on parent; a slot missed while it was down is caught up once at start, noted \"missed <time>\".",
		promptSnippet: "Manage cron/watch schedules that file jobs under a mandate (cp_schedule)",
		promptGuidelines: [
			"A cp-schedule wake-up (pr/pipeline schedules only) names a created job: call cp_next and act on it like any other ready job; answer/board/local scheduled jobs are the schedule runner's, never dispatch them yourself.",
			"A schedule needs its own active schedule grant (cp_mandate issue with schedule_grant:true, no job_ids, named by no other schedule): it covers only that schedule's jobs, and a project-wide grant never covers a scheduled job. A paused or expired grant skips the fire, never bypasses it.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "list", "enable", "disable", "remove"]),
			id: Type.Optional(Type.String({ description: "Schedule id (enable/disable/remove)" })),
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				const added = await s.add({
					name: need("name"), project: need("project"), mandate_id: need("mandate_id"), title: need("title"),
					kind: need("kind") as JobKind, delivery: need("delivery") as Delivery,
					...(params.cron !== undefined ? { cron: params.cron } : {}), ...(params.tz ? { tz: params.tz } : {}),
					...(params.watch_script !== undefined ? { watch_script: params.watch_script } : {}),
					...(params.every_seconds ? { every_seconds: params.every_seconds } : {}), ...(params.on ? { on: params.on as "exit0" | "changed" } : {}),
					...(params.description ? { description: params.description } : {}), ...(params.script_path !== undefined ? { script_path: params.script_path } : {}),
				});
				text = `added ${formatSchedules([added])}${holdsLock() ? "" : "\n(this session does not hold the parent lock: it will not fire here)"}`;
			} else if (params.action === "remove") text = `removed ${(await s.remove(need("id"))).id}`;
			else text = formatSchedules([await s.setEnabled(need("id"), params.action === "enable")]);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
