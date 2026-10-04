/**
 * Saved schedules (Lane X, Pier 1.5): a cron line with a time zone, a watch
 * script run every N seconds, or a manual trigger no tick fires (Run now only). A fire does exactly one thing — it records a
 * normal ledger job under its own schedule grant (`schedule_grant`). Dispatch is never
 * here: answer/board/local fires are dispatched and torn down by the schedule
 * runner (src/schedule-runner.ts) through the ordinary `CommandPost.dispatch`,
 * pr/pipeline fires stay `cp_next`/`cp_dispatch`'s — so job caps, dispatch
 * parallelism, risk gates and review apply either way. Nothing here spawns a worker.
 *
 * It runs only while a parent holds the home: the extension ticks it on a timer
 * after `session_start`; the supervised parent (docs/service.md) is that host.
 * A parent that was down misses slots; its first tick catches each schedule up
 * once (the latest missed slot, never a backlog) and stamps the job "missed
 * <time>". This module takes its clock and its ports as arguments and knows
 * nothing about pi.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { isSafeScriptPath, LAYOUT, SCHEMA_VERSION, type Delivery, type JobKind, type Mandate } from "./contracts.ts";
import { atomicWriteJson, queued } from "./json-store.ts";
import { assertScriptIntake, type Ledger } from "./ledger.ts";
import { covers, isActive, type MandateStore, type MandateUsageJob } from "./mandate.ts";
import { assertTimeZone, latestCronSlot, localMinuteKey, parseCron, readScheduleFile, type Schedule, SCHEDULE_SKILLS, scheduleFileErrors, SchedulerError } from "./viewer/schedule-core.ts";
import { resolveScriptFile, scriptEnv } from "./script-runner.ts";
import { RUNNER_DELIVERIES } from "./schedule-runner.ts";

export { assertTimeZone, type CronSpec, latestCronSlot, nextCronSlot, parseCron, readScheduleFile, type Schedule, SCHEDULE_SKILLS, scheduleFileErrors, SchedulerError } from "./viewer/schedule-core.ts";

export const SCHEDULER_TICK_MS = 30_000;
const WATCH_TIMEOUT_CAP_S = 600;
/** How far back a cron checkpoint survives a clock set back; also the DST fall-back repeat window. */
const CLOCK_BACK_BOUND_MS = 2 * 3_600_000;

// ---------------------------------------------------------------------------
// Store and tick
// ---------------------------------------------------------------------------

export interface ScheduleInput {
	name: string;
	project: string;
	mandate_id: string;
	cron?: string;
	tz?: string;
	watch_script?: string;
	every_seconds?: number;
	on?: "exit0" | "changed";
	title: string;
	kind: JobKind;
	delivery: Delivery;
	description?: string;
	script_path?: string;
	/** A manual schedule: never fires on a tick, only on Run now. */
	manual?: true;
	/** manual only: the fire records a deferred anchor and wakes the parent to expand it with this skill. */
	skill?: string;
}

export interface WatchRun { code: number | null; stdout: string }

export interface SchedulerPorts {
	home: string;
	ledger: () => Ledger;
	mandates: MandateStore;
	/** The fleet, for the mandate sweep (caps, expiry) before a fire. */
	usageJobs: () => readonly MandateUsageJob[];
	/** The project's canonical clone: where a watch script runs. */
	cloneOf: (project: string) => string;
	now?: () => Date;
	/** When this parent came up; a slot before it was missed. Defaults to construction time. */
	startedAt?: Date;
	/** Registered but archived projects (the registry's `archivedNames`): refused at add and at every fire. */
	archivedProjects?: () => readonly string[];
	runWatch?: (cwd: string, scriptPath: string, timeoutMs: number) => Promise<WatchRun>;
}

export interface ScheduleEvent {
	schedule_id: string;
	name: string;
	project: string;
	mandate_id: string;
	outcome: "fired" | "skipped";
	reason: string;
	job_id?: string;
	/** The fired job's delivery: answer/board/local fires are the schedule runner's to dispatch. */
	delivery?: Delivery;
	missed_at?: string;
	/** Run now from the dashboard: its request id (cp-hhuf P6). */
	manual?: string;
	/** A parent-expanded run (manual + skill): `job_id` is a deferred anchor the parent expands with this skill. */
	skill?: string;
}

/** Tracked file only (the X1 script rules), in the canonical clone, with the script runner's bare environment. */
export async function runWatchScript(cwd: string, scriptPath: string, timeoutMs: number): Promise<WatchRun> {
	const file = await resolveScriptFile(cwd, scriptPath);
	return new Promise((resolve) => {
		execFile("/bin/sh", [file], { cwd, env: scriptEnv(cwd), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout) });
		});
	});
}

/**
 * Why `mandate` cannot carry a fire of schedule `scheduleId` (a placeholder before `add` mints one) for `project`/`kind`,
 * or undefined when it can. Only a `schedule_grant` carries a schedule, and only one schedule: `schedules` are the saved
 * ones, and a grant another schedule already names is refused (schedlater S3).
 */
export function mandateRefusal(mandate: Mandate | undefined, id: string, project: string, kind: JobKind, now: string, scheduleId = "sch-000000", schedules: readonly Schedule[] = []): string | undefined {
	if (!mandate) return `no mandate ${id}`;
	if (!mandate.schedule_grant) return `${id} is not a schedule grant; a schedule runs only under its own grant: cp_mandate issue with schedule_grant:true`;
	if (mandate.job_ids?.length) return `${id} names job_ids; a schedule grant never does, because every fire is a new job id`;
	const other = schedules.find((entry) => entry.id !== scheduleId && entry.mandate_id === id);
	if (other) return `${id} is already the grant of schedule ${other.id} (${other.name}); one grant per schedule`;
	if (!covers(mandate, { jobId: "scheduled", project, jobKind: kind, scheduleId, scheduleMandate: id })) return `${id} does not cover ${kind} jobs in project ${project}`;
	if (!isActive(mandate, now)) return `${id} is ${mandate.status === "active" ? "expired" : mandate.status}${mandate.pause_reason ? ` (${mandate.pause_reason})` : ""}`;
	return undefined;
}

const minuteIso = (at: Date): string => `${at.toISOString().slice(0, 16)}Z`;

const archivedRefusal = (project: string, prefix?: string): string => `${prefix ? `${prefix}: ` : ""}archived project ${project} — unarchive with cp_project unarchive first`;

export class Scheduler {
	readonly file: string;
	readonly #ports: SchedulerPorts;
	readonly #startedAt: Date;
	#running = false;
	#lane: Promise<unknown> = Promise.resolve();

	constructor(ports: SchedulerPorts) {
		this.#ports = ports;
		this.file = join(ports.home, LAYOUT.state, "schedules.json");
		this.#startedAt = ports.startedAt ?? this.#now();
	}

	#now(): Date {
		return (this.#ports.now ?? (() => new Date()))();
	}

	list(): Schedule[] {
		return readScheduleFile(this.file);
	}

	#mutate<T>(fn: (schedules: Schedule[]) => T): Promise<T> {
		return queued(this.file, async () => {
			const schedules = this.list();
			const out = fn(schedules);
			const doc = { schema_version: SCHEMA_VERSION, schedules };
			const errors = scheduleFileErrors(doc);
			if (errors.length) throw new SchedulerError(`refusing to write an invalid schedule:\n  ${errors.join("\n  ")}`);
			atomicWriteJson(this.file, doc);
			return out;
		});
	}

	async add(input: ScheduleInput): Promise<Schedule> {
		const cron = input.cron !== undefined;
		const manual = input.manual === true;
		if ([cron, input.watch_script !== undefined, manual].filter(Boolean).length !== 1) throw new SchedulerError("a schedule is exactly one of cron (cron + tz), watch (watch_script + every_seconds + on) or manual (manual:true, Run now only)");
		if (input.skill !== undefined) {
			if (!(SCHEDULE_SKILLS as readonly string[]).includes(input.skill)) throw new SchedulerError(`unknown skill ${JSON.stringify(input.skill)}; known: ${SCHEDULE_SKILLS.join(", ")}`);
			if (!manual || input.kind !== "research" || input.delivery !== "local" || input.script_path !== undefined) throw new SchedulerError("skill needs a manual schedule with kind research, delivery local and no script_path");
		}
		if (cron) {
			parseCron(input.cron as string);
			if (!input.tz) throw new SchedulerError("a cron schedule needs tz (an IANA time zone, e.g. UTC)");
			assertTimeZone(input.tz);
		} else if (!manual) {
			if (!isSafeScriptPath(input.watch_script as string)) throw new SchedulerError(`unsafe watch script path ${JSON.stringify(input.watch_script)}`);
			if (!input.every_seconds || !input.on) throw new SchedulerError("a watch schedule needs every_seconds (30-86400) and on (exit0 | changed)");
		}
		assertScriptIntake({ kind: input.kind, delivery: input.delivery, ...(input.script_path !== undefined ? { scriptPath: input.script_path } : {}) });
		const known = this.#ports.ledger().knownProjects;
		if (known && !known.includes(input.project)) throw new SchedulerError(`unknown project ${JSON.stringify(input.project)}; known: ${known.join(", ") || "(none)"}`);
		if (this.#ports.archivedProjects?.().includes(input.project)) throw new SchedulerError(archivedRefusal(input.project, "cp_schedule add refused"));
		const now = this.#now();
		const mandate = this.#ports.mandates.sweep(now.toISOString(), this.#ports.usageJobs()).find((entry) => entry.id === input.mandate_id);
		const refusal = mandateRefusal(mandate, input.mandate_id, input.project, input.kind, now.toISOString(), undefined, this.list());
		if (refusal) throw new SchedulerError(`cp_schedule add refused: ${refusal}`);
		const schedule: Schedule = {
			id: `sch-${randomBytes(3).toString("hex")}`,
			name: input.name.trim(),
			project: input.project,
			mandate_id: input.mandate_id,
			trigger: manual
				? { type: "manual" }
				: cron
					? { type: "cron", cron: (input.cron as string).trim(), tz: input.tz as string }
					: { type: "watch", script_path: input.watch_script as string, every_seconds: input.every_seconds as number, on: input.on as "exit0" | "changed" },
			job: {
				title: input.title.trim(), kind: input.kind, delivery: input.delivery,
				...(input.description ? { description: input.description } : {}),
				...(input.script_path !== undefined ? { script_path: input.script_path } : {}),
				...(input.skill ? { skill: input.skill as (typeof SCHEDULE_SKILLS)[number] } : {}),
			},
			enabled: true,
			created_at: now.toISOString(),
		};
		return this.#mutate((schedules) => {
			if (schedules.some((entry) => entry.name === schedule.name && entry.project === schedule.project)) throw new SchedulerError(`project ${schedule.project} already has a schedule named ${JSON.stringify(schedule.name)}`);
			const shared = schedules.find((entry) => entry.mandate_id === schedule.mandate_id);
			if (shared) throw new SchedulerError(`cp_schedule add refused: ${schedule.mandate_id} is already the grant of schedule ${shared.id} (${shared.name}); one grant per schedule`);
			schedules.push(schedule);
			return schedule;
		});
	}

	remove(id: string): Promise<Schedule> {
		return this.#mutate((schedules) => {
			const index = schedules.findIndex((entry) => entry.id === id);
			if (index < 0) throw new SchedulerError(`no schedule ${id}`);
			return schedules.splice(index, 1)[0] as Schedule;
		});
	}

	/**
	 * Enable is refused unless the schedule's grant passes the fire check (cp-hhuf P6: one rule for `cp_schedule enable`
	 * and the Schedules page). Enabling a disabled cron schedule restarts slot evaluation at the enable time, so a slot
	 * that passed while it was disabled never fires. Disable is never grant-gated.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<Schedule> {
		if (!enabled) return this.#patch(id, { enabled }, true) as Promise<Schedule>;
		const schedule = this.list().find((entry) => entry.id === id);
		if (!schedule) throw new SchedulerError(`no schedule ${id}`);
		const now = this.#now();
		const at = now.toISOString();
		const mandate = this.#ports.mandates.sweep(at, this.#ports.usageJobs()).find((entry) => entry.id === schedule.mandate_id);
		const refusal = mandateRefusal(mandate, schedule.mandate_id, schedule.project, schedule.job.kind, at, schedule.id, this.list());
		if (refusal) throw new SchedulerError(`enable ${id} refused: ${refusal}`);
		return this.#mutate((schedules) => {
			const found = schedules.find((entry) => entry.id === id);
			if (!found) throw new SchedulerError(`no schedule ${id}`);
			if (!found.enabled && found.trigger.type === "cron") {
				// Never rewinds: a checkpoint ahead of the clock (a clock set back) keeps the exactly-once guard.
				const previous = Date.parse(found.last_checked_at ?? found.created_at);
				found.last_checked_at = new Date(Math.max(previous, now.getTime())).toISOString();
			}
			found.enabled = true;
			return found;
		});
	}

	/** Run now (cp-hhuf P6): one manual fire under the same grant checks as a slot; never writes last_fire/last_skip. */
	async fireNow(id: string, request: string): Promise<ScheduleEvent> {
		const schedule = this.list().find((entry) => entry.id === id);
		if (!schedule) throw new SchedulerError(`no schedule ${id}`);
		if (!schedule.enabled) throw new SchedulerError(`schedule ${id} is disabled; enable it first`);
		const now = this.#now();
		return (await this.#fire(schedule, now, false, now, now, request)) as ScheduleEvent;
	}

	#patch(id: string, patch: Partial<Schedule>, required = false): Promise<Schedule | undefined> {
		return this.#mutate((schedules) => {
			const found = schedules.find((entry) => entry.id === id);
			if (!found) {
				if (required) throw new SchedulerError(`no schedule ${id}`);
				return undefined; // removed mid-tick: nothing to record
			}
			Object.assign(found, patch);
			return found;
		});
	}

	/** One pass over every enabled schedule. Never overlaps itself; returns what happened, skips included. */
	async tick(): Promise<ScheduleEvent[]> {
		if (this.#running) return [];
		this.#running = true;
		try {
			const events: ScheduleEvent[] = [];
			const now = this.#now();
			for (const schedule of this.list()) {
				if (!schedule.enabled) continue;
				let event: ScheduleEvent | undefined;
				try {
					event = await this.#check(schedule, now);
				} catch (error) {
					event = await this.#skip(schedule, now, error instanceof Error ? error.message : String(error));
				}
				if (event) events.push(event);
			}
			return events;
		} finally {
			this.#running = false;
		}
	}

	async #check(schedule: Schedule, now: Date): Promise<ScheduleEvent | undefined> {
		const trigger = schedule.trigger;
		if (trigger.type === "manual") return undefined; // fires only on Run now; a tick writes nothing to it
		const checked = { last_checked_at: now.toISOString() };
		if (trigger.type === "cron") {
			// Exactly once per slot: a clock set back (up to CLOCK_BACK_BOUND_MS) never rewinds last_checked_at, so an already-fired slot is never found again.
			const previous = Date.parse(schedule.last_checked_at ?? schedule.created_at);
			if (previous - now.getTime() > CLOCK_BACK_BOUND_MS) {
				// ponytail: a checkpoint this far ahead is a corrected forward jump; restart from now so cron is silent at most CLOCK_BACK_BOUND_MS. A clock set back over the bound is an operational fault: slots it had fired may fire again, except the last one (checked below).
				await this.#patch(schedule.id, checked);
				return this.#skip(schedule, now, `last checked ${schedule.last_checked_at} is ahead of the clock by over ${CLOCK_BACK_BOUND_MS / 3_600_000} h; slot evaluation restarts from ${minuteIso(now)}`);
			}
			const lastSlot = schedule.last_fire ? new Date(schedule.last_fire.slot) : undefined;
			// previous >= lastSlot in normal flow; a future lastSlot (fired during a corrected forward jump) must not hold `after` there.
			const slot = latestCronSlot(parseCron(trigger.cron), trigger.tz, new Date(previous), now);
			await this.#patch(schedule.id, { last_checked_at: new Date(Math.max(previous, now.getTime())).toISOString() });
			if (!slot) return undefined;
			// The last fired slot again is refused. Its DST fall-back repeat (same local minute, within the bound) is refused only for a fixed hour field:
			// a wildcard or step hour (`*`, `*/2`, `1-23/2`) fires in both real hours of the repeated local hour, as classic cron does.
			const hourField = trigger.cron.trim().split(/\s+/)[1] ?? "";
			const fixedHour = !hourField.startsWith("*") && !hourField.includes("/");
			const sameMinute = lastSlot !== undefined && Math.abs(slot.getTime() - lastSlot.getTime()) < CLOCK_BACK_BOUND_MS && localMinuteKey(slot, trigger.tz) === localMinuteKey(lastSlot, trigger.tz);
			if (lastSlot && sameMinute && (fixedHour || slot.getTime() === lastSlot.getTime())) {
				return this.#skip(schedule, now, `fire at ${minuteIso(slot)} not recorded: it repeats the local minute of ${minuteIso(lastSlot)}, already fired`);
			}
			return this.#fire(schedule, slot, slot < this.#startedAt, now);
		}
		const due = schedule.last_checked_at ? Date.parse(schedule.last_checked_at) + trigger.every_seconds * 1000 : Date.parse(schedule.created_at);
		if (now.getTime() < due) return undefined;
		const run = await (this.#ports.runWatch ?? runWatchScript)(this.#ports.cloneOf(schedule.project), trigger.script_path, Math.min(trigger.every_seconds, WATCH_TIMEOUT_CAP_S) * 1000);
		if (run.code !== 0) {
			await this.#patch(schedule.id, checked);
			// exit0: a nonzero exit is the ordinary "not yet". changed: the output is not an observation.
			return trigger.on === "changed" ? this.#skip(schedule, now, `watch script ${trigger.script_path} exited ${run.code ?? "abnormally (timeout, signal or output over 1 MiB)"}`) : undefined;
		}
		const sha = createHash("sha256").update(run.stdout).digest("hex");
		await this.#patch(schedule.id, { ...checked, last_output_sha: sha });
		const fires = trigger.on === "exit0" || (schedule.last_output_sha !== undefined && schedule.last_output_sha !== sha);
		return fires ? this.#fire(schedule, now, due < this.#startedAt.getTime(), now, new Date(due)) : undefined;
	}

	/** Fires are serialized (slot and run now), so a tick's open-fire check always sees a run now's job, and the reverse. */
	#serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#lane.then(fn);
		this.#lane = run.catch(() => undefined);
		return run;
	}

	#fire(schedule: Schedule, slot: Date, missed: boolean, now: Date, missedAt: Date = slot, manual?: string): Promise<ScheduleEvent | undefined> {
		return this.#serial(() => this.#fireOnce(schedule, slot, missed, now, missedAt, manual));
	}

	/** `manual`: a run now's request id — its refusals are always reported and never recorded, and it writes no last_fire. */
	async #fireOnce(schedule: Schedule, slot: Date, missed: boolean, now: Date, missedAt: Date, manual?: string): Promise<ScheduleEvent | undefined> {
		const at = now.toISOString();
		const base = { schedule_id: schedule.id, name: schedule.name, project: schedule.project, mandate_id: schedule.mandate_id };
		const refuse = (why: string) => manual !== undefined
			? Promise.resolve<ScheduleEvent>({ ...base, outcome: "skipped", reason: `run now not recorded: ${why}`, manual })
			: this.#skip(schedule, now, `fire at ${minuteIso(slot)} not recorded: ${why}`);
		if (this.#ports.archivedProjects?.().includes(schedule.project)) return refuse(archivedRefusal(schedule.project));
		const mandate = this.#ports.mandates.sweep(at, this.#ports.usageJobs()).find((entry) => entry.id === schedule.mandate_id);
		const refusal = mandateRefusal(mandate, schedule.mandate_id, schedule.project, schedule.job.kind, at, schedule.id, this.list());
		if (refusal) return refuse(refusal);
		const ledger = this.#ports.ledger();
		const title = manual !== undefined ? `${schedule.job.title} (${schedule.name} run now ${minuteIso(now)})` : `${schedule.job.title} (${schedule.name} ${minuteIso(slot)})`;
		const label = `schedule:${schedule.id}`;
		// Same slot twice (a crash between create and the state write) is the same job, never a second one.
		let job = manual !== undefined ? undefined : ledger.findDuplicate({ title, project: schedule.project });
		if (!job) {
			const open = (await ledger.list({ labels: [label] }))[0];
			if (open) return refuse(`the previous fire ${open.id} is still open`);
			const created = await ledger.create({
				title, project: schedule.project, kind: schedule.job.kind, delivery: schedule.job.delivery, labels: [label],
				...(schedule.job.description ? { description: schedule.job.description } : {}),
				...(schedule.job.script_path !== undefined ? { scriptPath: schedule.job.script_path } : {}),
			});
			const notes = manual !== undefined
				? `run now from the dashboard (${manual}) for ${schedule.id} (${schedule.name}) under mandate ${schedule.mandate_id}`
				: `scheduled by ${schedule.id} (${schedule.name}) under mandate ${schedule.mandate_id}${missed ? `; missed ${minuteIso(missedAt)}` : ""}`;
			job = await ledger.update(created.id, { notes, ...(schedule.job.skill ? { status: "deferred" as const } : {}) });
		}
		if (manual === undefined) await this.#patch(schedule.id, { last_fire: { at, slot: slot.toISOString(), job_id: job.id, missed } });
		return {
			...base, outcome: "fired", job_id: job.id, delivery: schedule.job.delivery,
			...(schedule.job.skill ? { skill: schedule.job.skill } : {}),
			reason: `created ${job.id} under mandate ${schedule.mandate_id}`,
			...(missed ? { missed_at: minuteIso(missedAt) } : {}),
			...(manual !== undefined ? { manual } : {}),
		};
	}

	/** Recorded on the schedule every time; reported only when the reason changed, so a paused grant is news once. */
	async #skip(schedule: Schedule, now: Date, reason: string): Promise<ScheduleEvent | undefined> {
		await this.#patch(schedule.id, { last_skip: { at: now.toISOString(), reason } });
		if (schedule.last_skip?.reason === reason) return undefined;
		return { schedule_id: schedule.id, name: schedule.name, project: schedule.project, mandate_id: schedule.mandate_id, outcome: "skipped", reason };
	}
}

export function formatScheduleEvent(event: ScheduleEvent): string {
	const head = `[${event.project}] schedule ${event.name} (${event.schedule_id})`;
	if (event.outcome === "skipped") return `${head} skipped: ${event.reason}`;
	const fired = `${head} fired: ${event.reason}${event.missed_at ? `; missed ${event.missed_at} while no parent was up` : ""}${event.manual ? `; run now from the dashboard (${event.manual})` : ""}. `;
	if (event.skill) return `${fired}${event.job_id} is a parent-expanded run (deferred anchor): use skill ${event.skill} to expand it — its jobs carry label schedule:${event.schedule_id}; never dispatch the anchor.`;
	return fired +
		(event.delivery !== undefined && RUNNER_DELIVERIES.includes(event.delivery)
			? `${event.job_id} is dispatched by the schedule runner — the mandate's job cap, dispatch parallelism and risk gate apply; no cp_next needed.`
			: `Call cp_next: ${event.job_id} is an ordinary job — the mandate's job cap, dispatch parallelism, risk gate and review apply.`);
}

export function formatSchedules(schedules: readonly Schedule[]): string {
	if (schedules.length === 0) return "no schedules";
	return schedules.map((s) => {
		const trigger = s.trigger.type === "cron" ? `cron "${s.trigger.cron}" ${s.trigger.tz}`
			: s.trigger.type === "manual" ? `manual (fires only on Run now)${s.job.skill ? ` → expanded by skill ${s.job.skill}` : ""}`
			: `watch ${s.trigger.script_path} every ${s.trigger.every_seconds}s on ${s.trigger.on}`;
		return [
			`${s.id} ${s.name} [${s.project}] ${s.enabled ? "enabled" : "disabled"}: ${trigger} → ${s.job.kind}/${s.job.delivery} "${s.job.title}" under ${s.mandate_id}`,
			...(s.last_fire ? [`  last fire: ${s.last_fire.at} → ${s.last_fire.job_id}${s.last_fire.missed ? " (missed slot)" : ""}`] : []),
			...(s.last_skip ? [`  last skip: ${s.last_skip.at} — ${s.last_skip.reason}`] : []),
		].join("\n");
	}).join("\n");
}
