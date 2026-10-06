/**
 * Schedules page controls, the parent's half (cp-hhuf P6): the owner-side twin of src/dashboard-control.ts. The viewer
 * appends one `request` line per accepted POST to `state/schedule-control.jsonl` (src/viewer/control-api.ts); the
 * parent — the only writer of `state/schedules.json`, the ledger and the fleet — reads that journal every 2 s and,
 * per queued request, appends a `claimed` line **before** it acts (a claim that cannot be journaled acts on nothing),
 * then one `outcome` line the page shows.
 *
 * A request older than 120 s when the parent reads it is `expired`, never applied late. A claim another pid left
 * without an outcome is `interrupted`, never re-applied. `data/dashboard-control.json {"enabled": false}` refuses
 * queued requests here too. This class holds no authority: every op is the Scheduler method cp_schedule calls, so
 * the grant check on enable and the fire checks on run now apply unchanged.
 */

import { statSync } from "node:fs";
import type { Scheduler, ScheduleEvent } from "./scheduler.ts";
import { appendScheduleControlLine } from "./viewer/control-audit.ts";
import { readControlConfig, readScheduleControl, SCHEDULE_CONTROL_MAX_AGE_MS, scheduleControlFile, type ScheduleControlLine, type ScheduleControlRequest } from "./viewer/control-files.ts";

export const SCHEDULE_CONTROL_POLL_MS = 2_000;

type Outcome = Extract<ScheduleControlLine, { type: "outcome" }>;
type Append = (line: ScheduleControlLine) => { ok: true } | { ok: false; error: string };

export interface ScheduleControlPorts {
	stateDir: string;
	scheduler: Pick<Scheduler, "setEnabled" | "remove" | "fireNow">;
	now?: () => Date;
	pid?: number;
	log?: (line: string) => void;
	/** Default: appendScheduleControlLine(stateDir, line). A test seam. */
	append?: Append;
}

export class ScheduleControl {
	readonly #ports: ScheduleControlPorts;
	readonly #pid: number;
	readonly #append: Append;
	#running = false;
	#seenSize = -1;
	/** Outcomes whose append failed: retried first on every pass, never re-applied. */
	readonly #unwritten = new Map<string, Outcome>();

	constructor(ports: ScheduleControlPorts) {
		this.#ports = ports;
		this.#pid = ports.pid ?? process.pid;
		this.#append = ports.append ?? ((line) => appendScheduleControlLine(ports.stateDir, line));
	}

	#log(line: string): void {
		(this.#ports.log ?? ((text: string) => void process.stderr.write(`pi-command-post: ${text}\n`)))(line);
	}

	/** One pass over the journal; returns the run now fires for the caller to hand on like a tick's. */
	async pass(): Promise<ScheduleEvent[]> {
		if (this.#running) return [];
		this.#running = true;
		try {
			return await this.#pass();
		} finally {
			this.#running = false;
		}
	}

	async #pass(): Promise<ScheduleEvent[]> {
		for (const [id, line] of this.#unwritten) if (this.#append(line).ok) this.#unwritten.delete(id);
		let size: number;
		try {
			size = statSync(scheduleControlFile(this.#ports.stateDir)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			this.#log(`schedule control journal unreadable: ${(error as Error).message}`);
			return [];
		}
		if (size === this.#seenSize && this.#unwritten.size === 0) return [];
		this.#seenSize = size;
		const journal = readScheduleControl(this.#ports.stateDir);
		if (journal.error) {
			this.#log(`schedule control journal unreadable: ${journal.error}`);
			this.#seenSize = -1;
			return [];
		}
		const config = readControlConfig(this.#ports.stateDir);
		const fired: ScheduleEvent[] = [];
		for (const request of journal.requests) {
			if (this.#unwritten.has(request.id)) continue;
			if (request.state === "applying" && request.claimed_pid !== this.#pid) {
				this.#outcome(request, "interrupted", `claimed by parent pid ${request.claimed_pid ?? "unknown"}, which stopped before recording an outcome; check the schedule`);
				continue;
			}
			if (request.state !== "queued") continue;
			const now = (this.#ports.now ?? (() => new Date()))();
			if (!(now.getTime() - Date.parse(request.at) <= SCHEDULE_CONTROL_MAX_AGE_MS)) {
				this.#outcome(request, "expired", `not taken by the parent within ${SCHEDULE_CONTROL_MAX_AGE_MS / 1000} s; it will not be applied`);
				continue;
			}
			if (config.state !== "on") {
				this.#outcome(request, "refused", `dashboard control is off (${config.reason})`);
				continue;
			}
			const claim = this.#append({ type: "claimed", by: "parent", id: request.id, at: now.toISOString(), pid: this.#pid });
			if (!claim.ok) {
				this.#log(`schedule control ${request.id} not claimed, nothing applied: ${claim.error}`);
				this.#seenSize = -1;
				continue;
			}
			const event = await this.#apply(request);
			if (event) fired.push(event);
		}
		return fired;
	}

	async #apply(request: ScheduleControlRequest): Promise<ScheduleEvent | undefined> {
		const { scheduler } = this.#ports;
		const id = request.schedule_id;
		try {
			if (request.op === "enable" || request.op === "disable") {
				await scheduler.setEnabled(id, request.op === "enable");
				this.#outcome(request, "done", `${request.op}d ${id}`);
			} else if (request.op === "remove") {
				const { note } = await scheduler.remove(id);
				this.#outcome(request, "done", `removed ${id}${note}`);
			} else {
				const event = await scheduler.fireNow(id, { via: "dashboard", request_id: request.id, peer: request.peer });
				if (event.outcome !== "fired") {
					this.#outcome(request, "refused", event.reason);
					return undefined;
				}
				this.#outcome(request, "done", event.reason, event.job_id ?? null);
				return event;
			}
		} catch (error) {
			this.#outcome(request, "refused", (error as Error).message);
		}
		return undefined;
	}

	#outcome(request: ScheduleControlRequest, state: Outcome["state"], reason: string | null, jobId: string | null = null): void {
		const now = (this.#ports.now ?? (() => new Date()))();
		const line: Outcome = { type: "outcome", by: "parent", id: request.id, at: now.toISOString(), state, reason, job_id: jobId };
		const written = this.#append(line);
		if (!written.ok) {
			this.#unwritten.set(request.id, line);
			this.#seenSize = -1;
		}
		this.#log(`schedule control ${request.id} ${request.op} ${request.schedule_id}: ${state}${reason ? ` — ${reason}` : ""}${written.ok ? "" : ` (outcome unwritten: ${written.error}; retried next pass)`}`);
	}
}
