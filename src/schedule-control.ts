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

import { readFileSync, statSync } from "node:fs";
import type { RunNowClick } from "./schedule-grant.ts";
import type { Scheduler, ScheduleEvent } from "./scheduler.ts";
import { appendScheduleControlLine } from "./viewer/control-audit.ts";
import { readControlConfig, readScheduleControl, SCHEDULE_CONTROL_MAX_AGE_MS, scheduleControlFile, type ScheduleControlLine, type ScheduleControlRequest } from "./viewer/control-files.ts";

export const SCHEDULE_CONTROL_POLL_MS = 2_000;
/** The id shape the viewer mints for a Schedules page request (src/viewer/control-api.ts `scheduleRequestId`). */
export const RUN_NOW_REQUEST_ID = /^sc-[0-9]{14}-[0-9a-f]{8}$/;

/**
 * Whether `requestId` is a genuine dashboard Run now of `scheduleId` that this parent (`pid`) is applying right now,
 * re-read raw from `state/schedule-control.jsonl` (never `readScheduleControl`, which drops `by`): the viewer's id
 * shape; exactly one `request` line by the viewer, op run_now, this schedule, a peer; exactly one later `claimed` line,
 * by this parent pid, within the 120 s request age; no outcome yet (the fire runs between claim and outcome); and
 * dashboard control on. Each failure names why. The journal is 0600 under the home's uid: this binds the record to
 * the authenticated POST path (tailnet, schedule token), not against a same-uid writer (docs/contracts.md, U1).
 */
export function verifiedRunNowClick(stateDir: string, requestId: string, scheduleId: string, pid: number): RunNowClick {
	if (!RUN_NOW_REQUEST_ID.test(requestId)) return { ok: false, why: `${JSON.stringify(requestId)} is not a dashboard request id` };
	let text: string;
	try {
		text = readFileSync(scheduleControlFile(stateDir), "utf8");
	} catch (error) {
		return { ok: false, why: `the control journal is unreadable (${(error as Error).message})` };
	}
	const rows: Record<string, unknown>[] = [];
	for (const row of text.split("\n")) {
		try {
			const line = JSON.parse(row) as unknown;
			if (typeof line === "object" && line !== null && (line as { id?: unknown }).id === requestId) rows.push(line as Record<string, unknown>);
		} catch {
			// a torn line: never evidence
		}
	}
	const requests = rows.filter((line) => line.type === "request");
	if (requests.length !== 1) return { ok: false, why: `${requests.length} request lines for ${requestId} in the journal, not one` };
	const request = requests[0] as Record<string, unknown>;
	if (request.by !== "viewer") return { ok: false, why: `the request was written by ${JSON.stringify(request.by)}, not the viewer` };
	if (request.op !== "run_now") return { ok: false, why: `the request is ${JSON.stringify(request.op)}, not run_now` };
	if (request.schedule_id !== scheduleId) return { ok: false, why: `the request names ${JSON.stringify(request.schedule_id)}, not ${scheduleId}` };
	if (typeof request.peer !== "string" || request.peer.length === 0) return { ok: false, why: "the request records no peer" };
	const claims = rows.slice(rows.indexOf(request) + 1).filter((line) => line.type === "claimed");
	if (claims.length !== 1) return { ok: false, why: `${claims.length} claims after the request, not one` };
	const claim = claims[0] as Record<string, unknown>;
	if (claim.by !== "parent" || claim.pid !== pid) return { ok: false, why: `claimed by ${JSON.stringify(claim.by)} pid ${JSON.stringify(claim.pid)}, not this parent (pid ${pid})` };
	const age = Date.parse(String(claim.at)) - Date.parse(String(request.at));
	if (!(age >= 0 && age <= SCHEDULE_CONTROL_MAX_AGE_MS)) return { ok: false, why: `claimed ${Number.isFinite(age) ? `${age} ms` : "at an unreadable time"} after the request, outside 0-${SCHEDULE_CONTROL_MAX_AGE_MS} ms` };
	if (rows.some((line) => line.type === "outcome")) return { ok: false, why: "the request already has an outcome" };
	const config = readControlConfig(stateDir);
	if (config.state !== "on") return { ok: false, why: `dashboard control is off (${config.reason})` };
	return { ok: true, peer: request.peer };
}

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
