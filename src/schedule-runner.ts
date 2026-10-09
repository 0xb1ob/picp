/**
 * The schedule runner (schedlater S1): a fire of an answer/board/local schedule
 * is dispatched, collected and torn down by the parent *process* in code, with
 * no parent LLM turn. It holds no authority: every dispatch is the ordinary
 * `CommandPost.dispatch` (mandate, job cap, parallelism, risk gates) and every
 * teardown the ordinary `CommandPost.tearDown` gate.
 *
 * - An LLM schedule (no `script_path`) is dispatched with the schedule's
 *   description (else its title) as the task: one short-lived `pi --mode rpc`
 *   worker session for one run.
 * - A `script_path` schedule is dispatched with no task, so `CommandPost.dispatch`
 *   takes `dispatchScript`: the script runs directly under `/bin/sh`, no model.
 *
 * A refused dispatch is noted on the job and retried each tick; once the
 * schedule's next slot arrives (or it is disabled/removed) the job is dropped
 * with the last refusal as its reason. A refused or failed teardown — live, or
 * found by the restart sweep — sends the parent's ordinary envelope wake, and a
 * swept run whose recorded outcome is not teardown-shaped (escalate, a raised
 * escalation, unreadable) is woken without a teardown: no scheduled run ends silently.
 */

import type { FleetRecord } from "./contracts.ts";
import type { IntakeResult } from "./intake.ts";
import type { Job, Ledger } from "./ledger.ts";
import { parseJobLabels } from "./ledger.ts";
import { nextCronSlot, parseCron, type Schedule } from "./viewer/schedule-core.ts";
import { parentExpandedIds } from "./schedule-expand.ts";
import { runIsSettled } from "./schedule-runs.ts";
import { wasDropped } from "./ledger.ts";

export const RUNNER_DELIVERIES: readonly string[] = ["answer", "board", "local"];
const SCHEDULE_LABEL = "schedule:";
const REFUSED = "dispatch refused";

/** A scheduled job the runner dispatches and tears down itself (never cp_next's); a parent-expanded schedule's jobs (`expanded`) are the parent's. */
export function runnerOwns(job: { labels?: readonly string[] }, expanded: ReadonlySet<string> = new Set()): boolean {
	const labels = job.labels ?? [];
	const delivery = parseJobLabels(labels).delivery;
	const label = labels.find((entry) => entry.startsWith(SCHEDULE_LABEL));
	return label !== undefined && !expanded.has(label.slice(SCHEDULE_LABEL.length)) && delivery !== undefined && RUNNER_DELIVERIES.includes(delivery);
}

const scheduleIdOf = (job: Job): string | undefined => job.labels.find((label) => label.startsWith(SCHEDULE_LABEL))?.slice(SCHEDULE_LABEL.length);

export interface RunnerPorts {
	dispatch: (request: { jobId: string; task?: string }) => Promise<unknown>;
	tearDown: (jobId: string) => Promise<{ torn_down: boolean; failure?: { message: string } }>;
	/** The recorded intake outcome of a reported run (idempotent `intake.intake`: `already`, no second onReported). */
	recorded: (jobId: string) => Promise<IntakeResult>;
	/** The parent's ordinary envelope wake-up: the fallback whenever the runner does not finish a run itself. */
	wake: (result: IntakeResult) => void;
	ledger: () => Ledger;
	fleetJobs: () => readonly FleetRecord[];
	schedules: () => readonly Schedule[];
	now: () => Date;
	log: (line: string) => void;
	runs?: import("./schedule-runs.ts").ScheduleRunStore;
}

/** A teardown-shaped outcome on a runner-owned job; anything else (hold, escalate, an escalation raised) is the parent's. */
function teardownShaped(result: IntakeResult): boolean {
	return result.accepted && (result.next === "teardown" || result.next === "answer") && result.escalation_id === undefined;
}

export class ScheduleRunner {
	readonly #ports: RunnerPorts;
	readonly #inflight = new Set<string>();
	readonly #noted = new Set<string>();
	/** Runs this process already finished or handed to the parent: never torn down or woken twice. */
	readonly #handled = new Set<string>();
	#swept = false;

	constructor(ports: RunnerPorts) {
		this.#ports = ports;
	}

	/** A fired event: dispatch its job now. Never throws. */
	async onFired(event: { schedule_id: string; job_id?: string }): Promise<void> {
		if (!event.job_id) return;
		const schedule = this.#ports.schedules().find((entry) => entry.id === event.schedule_id);
		if (!schedule) return this.#ports.log(`schedule runner: ${event.schedule_id} is gone; ${event.job_id} is dropped on the next tick`);
		await this.#dispatch(event.job_id, schedule);
	}

	/** Each tick: retry every open runner-owned job with no fleet record, or drop it once its next slot has come. */
	async retryPending(): Promise<void> {
		const ledger = this.#ports.ledger();
		const inFleet = new Set(this.#ports.fleetJobs().map((record) => record.job_id));
		const now = this.#ports.now();
		const expanded = parentExpandedIds(this.#ports.schedules());
		for (const job of ledger.read().jobs) {
			if (job.status !== "open" || !runnerOwns(job, expanded) || inFleet.has(job.id) || this.#inflight.has(job.id)) continue;
			const id = scheduleIdOf(job);
			const schedule = this.#ports.schedules().find((entry) => entry.id === id);
			const next = schedule ? nextSlot(schedule, new Date(job.created_at)) : undefined;
			const stale = !schedule ? `schedule ${id} is gone` : !schedule.enabled ? `schedule ${id} is disabled` : next && next <= now ? "not dispatched before the next slot" : undefined;
			if (!stale) {
				await this.#dispatch(job.id, schedule as Schedule);
				continue;
			}
			const last = [...job.comments].reverse().find((comment) => comment.text.startsWith(REFUSED))?.text;
			try {
				await ledger.drop(job.id, `${stale}${last ? `: ${last}` : ""}`.slice(0, 1900));
				this.#ports.log(`schedule runner: dropped ${job.id} (${stale})`);
			} catch (error) {
				this.#ports.log(`schedule runner: could not drop ${job.id}: ${(error as Error).message}`);
			}
		}
		await this.#closeSettledRuns();
	}

	async #closeSettledRuns(): Promise<void> {
		const runs = this.#ports.runs;
		if (!runs?.active) return;
		const jobs = this.#ports.ledger().read().jobs;
		for (const run of runs.runs().filter((row) => row.phase !== "closed")) {
			if (runIsSettled(run, jobs)) await runs.closeRun(run.id, jobs.some((job) => run.members.some((member) => member.job_id === job.id) && wasDropped(job)) ? "partial" : "completed", this.#ports.now().toISOString().replace(/\.\d{3}Z$/, "Z"));
		}
	}
	/** Whether a fresh envelope is the runner's to tear down (the rest wake the parent as before). */
	claims(result: IntakeResult): boolean {
		return !result.already && teardownShaped(result) && this.#owns(result.job_id);
	}

	/**
	 * Tear a claimed run down. On a refusal or a throw the parent gets the
	 * ordinary envelope wake instead, so no scheduled run ends silently; returns
	 * whether the run was torn down.
	 */
	async onReported(result: IntakeResult): Promise<boolean> {
		this.#handled.add(result.job_id);
		try {
			const outcome = await this.#ports.tearDown(result.job_id);
			if (outcome.torn_down) { await this.#closeSettledRuns(); return true; }
			this.#ports.log(`schedule runner: teardown of ${result.job_id} refused: ${outcome.failure?.message ?? "not torn down"}; waking the parent`);
		} catch (error) {
			this.#ports.log(`schedule runner: teardown of ${result.job_id} failed: ${(error as Error).message}; waking the parent`);
		}
		this.#ports.wake(result);
		return false;
	}

	/**
	 * Once per process: finish runner-owned runs that reported while nobody was
	 * listening (a parent restart between intake and teardown). Each run's
	 * recorded intake outcome decides: teardown-shaped → tear down (wake on a
	 * refusal); anything else (escalate, an escalation raised) → the parent's wake.
	 */
	async sweepReported(): Promise<void> {
		if (this.#swept) return;
		this.#swept = true;
		for (const record of this.#ports.fleetJobs()) {
			if (record.phase !== "held" || !record.reported_at || this.#handled.has(record.job_id) || !this.#owns(record.job_id)) continue;
			let result: IntakeResult;
			try {
				result = await this.#ports.recorded(record.job_id);
			} catch (error) {
				const message = `schedule runner: could not read ${record.job_id}'s recorded envelope: ${(error as Error).message}`;
				this.#ports.log(message);
				result = { job_id: record.job_id, accepted: false, already: true, phase: record.phase, summary: message };
			}
			if (this.#handled.has(record.job_id)) continue; // a live onReported took it meanwhile
			if (teardownShaped(result)) await this.onReported(result);
			else {
				this.#handled.add(record.job_id);
				this.#ports.wake(result);
			}
		}
	}

	#owns(jobId: string): boolean {
		try {
			const job = this.#ports.ledger().read().jobs.find((entry) => entry.id === jobId);
			return job !== undefined && runnerOwns(job, parentExpandedIds(this.#ports.schedules()));
		} catch {
			return false; // an unreadable ledger is the parent's to see
		}
	}

	async #dispatch(jobId: string, schedule: Schedule): Promise<void> {
		if (this.#inflight.has(jobId)) return;
		this.#inflight.add(jobId);
		try {
			await this.#ports.dispatch(schedule.job.script_path !== undefined ? { jobId } : { jobId, task: schedule.job.description ?? schedule.job.title });
		} catch (error) {
			const message = (error as Error).message;
			const key = `${jobId}|${message}`;
			if (this.#noted.has(key)) return;
			this.#noted.add(key);
			this.#ports.log(`schedule runner: ${REFUSED} for ${jobId}: ${message}`);
			try {
				await this.#ports.ledger().comment(jobId, `${REFUSED} ${this.#ports.now().toISOString()}: ${message}`.slice(0, 4000));
			} catch (noteError) {
				this.#ports.log(`schedule runner: could not note the refusal on ${jobId}: ${(noteError as Error).message}`);
			}
		} finally {
			this.#inflight.delete(jobId);
		}
	}
}

/** The slot after `after`: cron's next wall-clock slot, a watch's next interval. */
function nextSlot(schedule: Schedule, after: Date): Date | undefined {
	const trigger = schedule.trigger;
	if (trigger.type === "manual") return undefined;
	if (trigger.type === "watch") return new Date(after.getTime() + trigger.every_seconds * 1000);
	return nextCronSlot(parseCron(trigger.cron), trigger.tz, after);
}
