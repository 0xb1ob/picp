/**
 * Saved schedules (Lane X, Pier 1.5): a cron line with a time zone, a watch
 * script run every N seconds, or a manual trigger no tick fires (Run now only). A fire does exactly one thing — it records a
 * normal ledger job under a schedule grant minted fresh for that one fire from the schedule's `grant_template`
 * (docs/contracts.md, *Fresh grant per fire*; hard-coded, no opt-out, no grant reuse). Dispatch is never
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
import { isoTimestamp, isSafeScriptPath, LAYOUT, SCHEMA_VERSION, type Delivery, type JobKind, type Mandate } from "./contracts.ts";
import { atomicWriteJson, queued } from "./json-store.ts";
import { assertScriptIntake, type Ledger } from "./ledger.ts";
import { covers, isActive, type MandateStore, type MandateUsageJob } from "./mandate.ts";
import { liveFireBounds, mintFireGrant, type MintContext, pointerRefusal, prReviewLines, type Refusal, refused, synthesizedApproval, templateFromSeed, withSkillJobFloor } from "./schedule-grant.ts";
import { assertTimeZone, type GrantTemplate, latestCronSlot, localMinuteKey, parseCron, readScheduleFile, type Schedule, SCHEDULE_SKILL_ANCHOR, SCHEDULE_SKILLS, scheduleFileErrors, SchedulerError } from "./viewer/schedule-core.ts";
import { parsePrUrl } from "./ci-watch.ts";
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
	/** Every fire's live inputs (defaults, project override, token ceiling); absent or throwing refuses the fire. */
	mintContext?: (project: string) => MintContext | Refusal;
	/** The project's GitHub `owner/repo` (its registered clone_url): where a cp-pr-review schedule's PRs must live. Absent or undefined refuses it. */
	repoOf?: (project: string) => string | undefined;
}

/** A cp-pr-review schedule reviews at most this many PRs per fire (one `pr:` line each). */
export const PR_REVIEW_MAX_TARGETS = 20;

/**
 * A cp-pr-review schedule's targets: every description line starting `pr:` must be exactly
 * `pr: https://github.com/<owner>/<repo>/pull/<n>` in `repo` (the project's own `owner/repo`), 1-20 distinct. Throws naming the first fault.
 */
export function prReviewTargets(description: string, repo: string | undefined): string[] {
	if (!repo) throw new SchedulerError("cp-pr-review needs the project's GitHub repo: its registered clone_url is not a github.com remote (or this host does not wire it)");
	const urls = prReviewLines(description);
	if (urls.length < 1 || urls.length > PR_REVIEW_MAX_TARGETS) throw new SchedulerError(`cp-pr-review needs 1-${PR_REVIEW_MAX_TARGETS} description lines "pr: https://github.com/${repo}/pull/<n>"; found ${urls.length}`);
	for (const url of urls) {
		const pr = parsePrUrl(url);
		if (!pr || url !== `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`) throw new SchedulerError(`cp-pr-review: ${JSON.stringify(url)} is not a PR url (https://github.com/<owner>/<repo>/pull/<n>)`);
		if (`${pr.owner}/${pr.repo}`.toLowerCase() !== repo.toLowerCase()) throw new SchedulerError(`cp-pr-review: ${url} is not in the project's repo ${repo}; only its own PRs are reviewed`);
	}
	const dupe = urls.find((url, i) => urls.indexOf(url) !== i);
	if (dupe) throw new SchedulerError(`cp-pr-review: ${dupe} is listed twice`);
	return urls;
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
	/** Run now: the dashboard request id (cp-hhuf P6) or the cp_schedule tool call id. */
	manual?: string;
	/** Which run now: the dashboard's authenticated click or cp_schedule run_now with a verified operator quote. */
	manual_via?: FireTrigger["via"];
	/** A parent-expanded run (manual + skill): `job_id` is a deferred anchor the parent expands with this skill. */
	skill?: string;
}

/**
 * Who asked for a run now. The dashboard's authenticated click (tailnet, schedule token, Origin, 120 s age), or
 * `cp_schedule run_now` with one verbatim operator sentence naming the schedule (`requireOperatorQuote`); `source_sha`
 * is 12 hex of sha256 of that quote's source message, which authorizes at most one run now per schedule.
 */
export type FireTrigger =
	| { via: "dashboard"; request_id: string; peer: string | null }
	| { via: "cp_schedule"; tool_call_id: string; operator_quote: string; decided_by: string; source_sha: string; send_id?: string; delegation_rule?: string };

/** Written on a cp_schedule run now's job (notes and quote comment); finding it on any job of the schedule refuses a replay. */
export const runNowQuoteMarker = (sourceSha: string): string => `run-now quote sha ${sourceSha}`;

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

const noTemplate = (id: string): string => `schedule ${id} has no grant template (its seed was missing or unreadable at migration), so no fire can mint a fresh grant: cp_schedule move it to a fresh schedule grant`;

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

	/**
	 * Every add snapshots the seed grant's bounds into `grant_template` (every fire mints a fresh grant from it);
	 * `notes` (not saved) names every normalization the template made to its seed's bounds.
	 */
	async add(input: ScheduleInput): Promise<Schedule & { notes?: string[] }> {
		const cron = input.cron !== undefined;
		const manual = input.manual === true;
		if ([cron, input.watch_script !== undefined, manual].filter(Boolean).length !== 1) throw new SchedulerError("a schedule is exactly one of cron (cron + tz), watch (watch_script + every_seconds + on) or manual (manual:true, Run now only)");
		if (input.skill !== undefined) {
			if (!(SCHEDULE_SKILLS as readonly string[]).includes(input.skill)) throw new SchedulerError(`unknown skill ${JSON.stringify(input.skill)}; known: ${SCHEDULE_SKILLS.join(", ")}`);
			const anchor = SCHEDULE_SKILL_ANCHOR[input.skill as (typeof SCHEDULE_SKILLS)[number]];
			if (!manual || input.kind !== anchor.kind || input.delivery !== anchor.delivery || input.script_path !== undefined) throw new SchedulerError(`skill needs a manual schedule with kind ${anchor.kind}, delivery ${anchor.delivery} and no script_path`);
			if (input.skill === "cp-pr-review") prReviewTargets(input.description ?? "", this.#ports.repoOf?.(input.project));
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
		const stamp = isoTimestamp(now); // MandateStore and the grant checks compare at second precision
		const mandate = this.#ports.mandates.sweep(stamp, this.#ports.usageJobs()).find((entry) => entry.id === input.mandate_id);
		const refusal = mandateRefusal(mandate, input.mandate_id, input.project, input.kind, stamp, undefined, this.list());
		if (refusal) throw new SchedulerError(`cp_schedule add refused: ${refusal}`);
		const seed = mandate as Mandate;
		const seeded = templateFromSeed(seed, synthesizedApproval(seed, "cp_schedule add"), stamp);
		if (refused(seeded)) throw new SchedulerError(`cp_schedule add refused: ${seeded.refusal}`);
		const job: Schedule["job"] = {
			title: input.title.trim(), kind: input.kind, delivery: input.delivery,
			...(input.description ? { description: input.description } : {}),
			...(input.script_path !== undefined ? { script_path: input.script_path } : {}),
			...(input.skill ? { skill: input.skill as (typeof SCHEDULE_SKILLS)[number] } : {}),
		};
		// One fire's whole fan-out plus its anchor runs under its own fire grant: a lower job cap is raised, never refused.
		const floored = withSkillJobFloor(seeded.template, job);
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
			job,
			grant_template: floored.template,
			enabled: true,
			created_at: now.toISOString(),
		};
		const notes = [...seeded.notes, ...(floored.note ? [floored.note] : [])];
		return this.#mutate((schedules) => {
			if (schedules.some((entry) => entry.name === schedule.name && entry.project === schedule.project)) throw new SchedulerError(`project ${schedule.project} already has a schedule named ${JSON.stringify(schedule.name)}`);
			const shared = schedules.find((entry) => entry.mandate_id === schedule.mandate_id);
			if (shared) throw new SchedulerError(`cp_schedule add refused: ${schedule.mandate_id} is already the grant of schedule ${shared.id} (${shared.name}); one grant per schedule`);
			schedules.push(schedule);
			return notes.length ? { ...schedule, notes } : schedule;
		});
	}

	/**
	 * A schedule's current grant is revoked with it (in-flight workers are not killed) unless another schedule still
	 * names it; `note` says so. Other grants are never touched. Serialized with fires, so a fire never mints for a
	 * schedule being removed.
	 */
	remove(id: string): Promise<{ schedule: Schedule; note: string }> {
		return this.#serial(() => this.#removeOnce(id));
	}

	async #removeOnce(id: string): Promise<{ schedule: Schedule; note: string }> {
		let named: string[] = [];
		const schedule = await this.#mutate((schedules) => {
			const index = schedules.findIndex((entry) => entry.id === id);
			if (index < 0) throw new SchedulerError(`no schedule ${id}`);
			const removed = schedules.splice(index, 1)[0] as Schedule;
			named = schedules.map((entry) => entry.mandate_id);
			return removed;
		});
		if (!schedule.grant_template) return { schedule, note: "" };
		return { schedule, note: this.#retire(schedule.mandate_id, named) };
	}

	/** Revokes a schedule's former pointer when it is active or paused and no schedule (`named`) still names it. */
	#retire(id: string, named: readonly string[]): string {
		if (named.includes(id)) return `; its grant ${id} is still named by another schedule, not revoked`;
		const grant = this.#ports.mandates.list().find((entry) => entry.id === id);
		if (grant?.status !== "active" && grant?.status !== "paused") return `; its grant ${id} is ${grant?.status ?? "missing"}, nothing to revoke`;
		this.#ports.mandates.revoke(grant.id);
		return `; revoked its grant ${grant.id} (in-flight workers were not killed)`;
	}

	/**
	 * Retargets a schedule to a fresh seed grant (`cp_schedule move`): the template is re-derived from the new seed and
	 * written with the pointer in one write, in the fire lane, so the id, its `schedule:<id>` label and any open run are
	 * kept. The old pointer is revoked unless another schedule names it.
	 */
	move(id: string, mandateId: string): Promise<{ schedule: Schedule; note: string; notes: string[] }> {
		return this.#serial(async () => {
			const found = this.list().find((entry) => entry.id === id);
			if (!found) throw new SchedulerError(`no schedule ${id}`);
			const stamp = isoTimestamp(this.#now());
			const mandate = this.#ports.mandates.sweep(stamp, this.#ports.usageJobs()).find((entry) => entry.id === mandateId);
			const refusal = mandateRefusal(mandate, mandateId, found.project, found.job.kind, stamp, found.id, this.list());
			if (refusal) throw new SchedulerError(`cp_schedule move refused: ${refusal}`);
			const seeded = templateFromSeed(mandate as Mandate, synthesizedApproval(mandate as Mandate, "cp_schedule move"), stamp);
			if (refused(seeded)) throw new SchedulerError(`cp_schedule move refused: ${seeded.refusal}`);
			const floored = withSkillJobFloor(seeded.template, found.job);
			let named: string[] = [];
			const schedule = await this.#mutate((schedules) => {
				const entry = schedules.find((candidate) => candidate.id === id);
				if (!entry) throw new SchedulerError(`no schedule ${id}`);
				entry.mandate_id = mandateId;
				entry.grant_template = floored.template;
				delete entry.last_skip;
				named = schedules.map((candidate) => candidate.mandate_id);
				return entry;
			});
			const note = found.mandate_id === mandateId ? "" : this.#retire(found.mandate_id, named);
			return { schedule, note, notes: [...seeded.notes, ...(floored.note ? [floored.note] : [])] };
		});
	}

	/**
	 * Enable is refused unless the schedule's next fire could mint (cp-hhuf P6: one rule for `cp_schedule enable` and
	 * the Schedules page): a saved template, no operator revoke or pause on its pointer, and live bounds. Enabling a
	 * disabled cron schedule restarts slot evaluation at the enable time, so a slot that passed while it was disabled
	 * never fires. Disable is never grant-gated.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<Schedule> {
		if (!enabled) return this.#patch(id, { enabled }, true) as Promise<Schedule>;
		const schedule = this.list().find((entry) => entry.id === id);
		if (!schedule) throw new SchedulerError(`no schedule ${id}`);
		const now = this.#now();
		const at = isoTimestamp(now);
		const mandate = this.#ports.mandates.sweep(at, this.#ports.usageJobs()).find((entry) => entry.id === schedule.mandate_id);
		// The pointer may have expired between clicks: what must hold is the next fire's re-evaluation.
		const bounds = schedule.grant_template ? this.#fireBounds(schedule, now) : undefined;
		const refusal = bounds ? pointerRefusal(mandate) ?? (refused(bounds) ? bounds.refusal : undefined) : noTemplate(schedule.id);
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

	/**
	 * Run now (cp-hhuf P6): one manual fire under the same grant checks as a slot; never writes last_fire/last_skip.
	 * A string trigger is a dashboard request id with no peer (the pre-S2 signature).
	 */
	async fireNow(id: string, trigger: string | FireTrigger): Promise<ScheduleEvent> {
		const schedule = this.list().find((entry) => entry.id === id);
		if (!schedule) throw new SchedulerError(`no schedule ${id}`);
		if (!schedule.enabled) throw new SchedulerError(`schedule ${id} is disabled; enable it first`);
		const now = this.#now();
		const manual: FireTrigger = typeof trigger === "string" ? { via: "dashboard", request_id: trigger, peer: null } : trigger;
		return (await this.#fire(schedule, now, false, now, now, manual)) as ScheduleEvent;
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

	#fire(schedule: Schedule, slot: Date, missed: boolean, now: Date, missedAt: Date = slot, manual?: FireTrigger): Promise<ScheduleEvent | undefined> {
		return this.#serial(() => this.#fireOnce(schedule, slot, missed, now, missedAt, manual));
	}

	/**
	 * The one fire path, every trigger: always mints a fresh grant from the schedule's template (`#mint`) and files the
	 * job under it; there is no other branch. A schedule with no template throws. `manual`: a run now's trigger — its
	 * refusals are always reported and never recorded, and it writes no last_fire.
	 */
	async #fireOnce(schedule: Schedule, slot: Date, missed: boolean, now: Date, missedAt: Date, manual?: FireTrigger): Promise<ScheduleEvent | undefined> {
		const template = this.#template(schedule);
		const at = now.toISOString();
		const base = { schedule_id: schedule.id, name: schedule.name, project: schedule.project, mandate_id: schedule.mandate_id };
		const manualFields = manual === undefined ? {} : { manual: manual.via === "dashboard" ? manual.request_id : manual.tool_call_id, manual_via: manual.via };
		const refuse = (why: string) => manual !== undefined
			? Promise.resolve<ScheduleEvent>({ ...base, outcome: "skipped", reason: `run now not recorded: ${why}`, ...manualFields })
			: this.#skip(schedule, now, `fire at ${minuteIso(slot)} not recorded: ${why}`);
		if (this.#ports.archivedProjects?.().includes(schedule.project)) return refuse(archivedRefusal(schedule.project));
		const stamp = isoTimestamp(now); // `at` keeps last_fire's millisecond format; grants are evaluated at second precision
		const ledger = this.#ports.ledger();
		const title = manual !== undefined ? `${schedule.job.title} (${schedule.name} run now ${minuteIso(now)})` : `${schedule.job.title} (${schedule.name} ${minuteIso(slot)})`;
		const label = `schedule:${schedule.id}`;
		const marker = manual?.via === "cp_schedule" ? runNowQuoteMarker(manual.source_sha) : undefined;
		const ledgerRefusal = async (): Promise<string | undefined> => {
			if (marker) {
				// Single use, closed fires included: the sha is in the notes even when the quote comment was never written.
				const used = (await ledger.list({ labels: [label], all: true })).find((entry) => entry.notes?.includes(marker) || entry.comments.some((comment) => comment.text.includes(marker)));
				if (used) return `the operator message behind this quote already authorized run now ${used.id}; one operator sentence authorizes one run now per schedule`;
			}
			const open = (await ledger.list({ labels: [label] }))[0];
			return open ? `the previous fire ${open.id} is still open` : undefined;
		};
		// A fire mints nothing it would not use: single use and the open-fire guard come first.
		const early = await ledgerRefusal();
		if (early) return refuse(early);
		const fire = await this.#mint(schedule, now, stamp, slot, missed, manual);
		if (refused(fire)) return refuse(fire.refusal);
		const mandateId = base.mandate_id = fire.grant.id;
		const minted = `; minted fire grant ${mandateId} from the template of ${template.seed_mandate_id} (expires ${fire.grant.expiry})${fire.notes.map((note) => `; ${note}`).join("")}`;
		let warning = "";
		// Same slot twice (a crash between create and the state write) is the same job, never a second one.
		let job = manual !== undefined ? undefined : ledger.findDuplicate({ title, project: schedule.project });
		if (!job) {
			const created = await ledger.create({
				title, project: schedule.project, kind: schedule.job.kind, delivery: schedule.job.delivery, labels: [label],
				...(schedule.job.description ? { description: schedule.job.description } : {}),
				...(schedule.job.script_path !== undefined ? { scriptPath: schedule.job.script_path } : {}),
			});
			const under = `for ${schedule.id} (${schedule.name}) under fire grant ${mandateId} (minted from the template approved by ${template.approval.decided_by})`;
			const notes = manual?.via === "dashboard"
				? `run now from the dashboard (${manual.request_id}) ${under}${manual.peer ? `; peer ${manual.peer}` : ""}`
				: manual?.via === "cp_schedule"
					? `run now via cp_schedule (${manual.tool_call_id}) ${under}; authorized by ${manual.decided_by}${manual.send_id ? ` (send ${manual.send_id}${manual.delegation_rule ? `, rule: ${manual.delegation_rule}` : ""})` : ""}; ${marker}`
					: `scheduled ${under}${missed ? `; missed ${minuteIso(missedAt)}` : ""}`;
			job = await ledger.update(created.id, { notes, ...(schedule.job.skill ? { status: "deferred" as const } : {}) });
			if (manual?.via === "cp_schedule") {
				try {
					await ledger.comment(job.id, `${marker}: ${manual.operator_quote}`);
				} catch (error) {
					warning = `; warning: the verbatim quote comment was not written (${(error as Error).message}); the job notes carry ${marker}, so the quote stays single-use`;
				}
			}
		}
		if (manual === undefined) await this.#patch(schedule.id, { last_fire: { at, slot: slot.toISOString(), job_id: job.id, missed } });
		return {
			...base, outcome: "fired", job_id: job.id, delivery: schedule.job.delivery,
			...(schedule.job.skill ? { skill: schedule.job.skill } : {}),
			reason: `created ${job.id} under fire grant ${mandateId}${minted}${warning}`,
			...(missed ? { missed_at: minuteIso(missedAt) } : {}),
			...manualFields,
		};
	}

	/**
	 * The schedule's template, or a throw: a schedule without one never fires, and a template seeded by a fire grant
	 * (a previous fire's grant reused as a seed) is refused — every fire's grant is minted fresh from an operator-issued
	 * seed's bounds, never carried over.
	 */
	#template(schedule: Schedule): GrantTemplate {
		const template = schedule.grant_template;
		if (!template) throw new SchedulerError(noTemplate(schedule.id));
		const seed = this.#ports.mandates.get(template.seed_mandate_id);
		if (seed?.schedule_fire) throw new SchedulerError(`schedule ${schedule.id}'s template is seeded by fire grant ${seed.id}; a fire grant is never reused: cp_schedule move it to a fresh schedule grant`);
		return template;
	}

	/** A schedule's next fire bounds: its template re-evaluated against the live home (`mintContext`), fail closed. */
	#fireBounds(schedule: Schedule, now: Date): ReturnType<typeof liveFireBounds> {
		const template = schedule.grant_template as GrantTemplate;
		let context: MintContext | Refusal;
		try {
			context = this.#ports.mintContext ? this.#ports.mintContext(schedule.project) : { refusal: "this host does not wire the fire grant mint context (data/mandate-defaults.json and the project override)" };
		} catch (error) {
			context = { refusal: `the live mandate defaults or project override are unreadable (${(error as Error).message})` };
		}
		return refused(context) ? context : liveFireBounds(template, context, schedule.project, schedule.job.kind, now);
	}

	/**
	 * Steps 3-10 of every fire (src/schedule-grant.ts): re-read, sweep, pointer check (an operator revoke or pause
	 * only), live bounds, mint in this lane, sanity check. Whatever the pointer's state — expired, cap-paused, spent —
	 * the fire's caps come from the template, never from it.
	 */
	async #mint(queued: Schedule, now: Date, stamp: string, slot: Date, missed: boolean, manual: FireTrigger | undefined): Promise<{ grant: Mandate; notes: string[] } | Refusal> {
		// Re-read in the lane: a fire queued behind another sees the pointer that fire moved, and a removal in between refuses.
		const schedule = this.list().find((entry) => entry.id === queued.id);
		if (!schedule?.enabled) return { refusal: `schedule ${queued.id} was removed or disabled before this fire ran` };
		const template = this.#template(schedule);
		const pointer = this.#ports.mandates.sweep(stamp, this.#ports.usageJobs()).find((entry) => entry.id === schedule.mandate_id);
		const stuck = pointerRefusal(pointer);
		if (stuck) return { refusal: stuck };
		const bounds = this.#fireBounds(schedule, now);
		if (refused(bounds)) return bounds;
		const trigger = manual?.via === "dashboard"
			? { via: manual.via, request_id: manual.request_id, peer: manual.peer }
			: manual?.via === "cp_schedule"
				? { via: manual.via, operator_quote: manual.operator_quote, decided_by: manual.decided_by as "operator-quote" | "operator-delegated", source_sha: manual.source_sha, ...(manual.send_id ? { send_id: manual.send_id } : {}), ...(manual.delegation_rule ? { delegation_rule: manual.delegation_rule } : {}) }
				: schedule.trigger.type === "watch"
					? { via: "watch" as const, at: stamp, ...(schedule.last_output_sha ? { output_sha: schedule.last_output_sha } : {}) }
					: { via: "cron" as const, slot: isoTimestamp(slot), missed };
		let fire: Awaited<ReturnType<typeof mintFireGrant>>;
		try {
			fire = await mintFireGrant({
				mandates: this.#ports.mandates, usageJobs: this.#ports.usageJobs, scheduleId: schedule.id, template,
				previousId: schedule.mandate_id, bounds: bounds.input, trigger, at: stamp,
				movePointer: async (id) => void (await this.#patch(schedule.id, { mandate_id: id }, true)),
				named: (id) => this.list().some((entry) => entry.id !== schedule.id && entry.mandate_id === id),
			});
		} catch (error) {
			return { refusal: `no fire grant minted (${(error as Error).message}); the next fire re-mints` };
		}
		if (fire.grant.id === schedule.mandate_id) throw new SchedulerError(`schedule ${schedule.id} would reuse ${fire.grant.id}; every fire files under a fresh grant`);
		const refusal = mandateRefusal(fire.grant, fire.grant.id, schedule.project, schedule.job.kind, stamp, schedule.id, this.list());
		if (refusal) return { refusal: `the minted fire grant refuses the fire: ${refusal}` };
		return { grant: fire.grant, notes: [...bounds.notes, ...(fire.revoked.length ? [`revoked ${fire.revoked.join(", ")}`] : [])] };
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
	const via = event.manual ? (event.manual_via === "cp_schedule" ? `; run now via cp_schedule on a verified operator quote (${event.manual})` : `; run now from the dashboard (${event.manual})`) : "";
	const fired = `${head} fired: ${event.reason}${event.missed_at ? `; missed ${event.missed_at} while no parent was up` : ""}${via}. `;
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
			...(s.grant_template ? [formatTemplate(s.grant_template, s.mandate_id)] : []),
			...(s.last_fire ? [`  last fire: ${s.last_fire.at} → ${s.last_fire.job_id}${s.last_fire.missed ? " (missed slot)" : ""}`] : []),
			...(s.last_skip ? [`  last skip: ${s.last_skip.at} — ${s.last_skip.reason}`] : []),
		].join("\n");
	}).join("\n");
}

function formatTemplate(t: GrantTemplate, current: string): string {
	const exclusions = [...(t.exclusions?.paths ?? []), ...(t.exclusions?.subsystems ?? []), ...(t.exclusions?.job_kinds ?? [])];
	return `  fire grant template: each fire mints a fresh grant from the template of ${t.seed_mandate_id} (${t.expiry_hours} h, $${t.spend_usd}, ${t.spend_tokens} tokens, job cap ${t.job_cap}` +
		`${t.dispatch_parallelism ? `, parallelism ${t.dispatch_parallelism}` : ""}; allowed ${t.allowed_actions.join(", ")}; ask_on ${t.ask_on.join(", ")}${exclusions.length ? `; excludes ${exclusions.join(", ")}` : ""})` +
		`, approved "${t.approval.operator_quote}" (${t.approval.decided_by}) at ${t.approval.approved_at}; current fire grant ${current}`;
}
