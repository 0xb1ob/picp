import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { IsoTimestampSchema, JobIdSchema, isoTimestamp, paths, validate } from "./contracts.ts";
import { FleetStore } from "./fleet.ts";
import { atomicWriteJson } from "./json-store.ts";
import { readDrain } from "./drain.ts";

const IntegrationHoldSchema = Type.Object({
	job_id: JobIdSchema,
	reason: Type.String({ minLength: 1, maxLength: 2000 }),
	held_at: IsoTimestampSchema,
}, { additionalProperties: false });
export type IntegrationHold = Static<typeof IntegrationHoldSchema>;

/** Separate from fleet.json: the operator and parent can write without losing fleet updates. */
export class IntegrationHolds {
	readonly home: string;
	constructor(home: string) {
		this.home = home;
	}

	file(jobId: string): string {
		return join(this.home, paths.runDir(jobId), "integration-hold.json");
	}

	get(jobId: string): IntegrationHold | undefined {
		// A drain is a home-wide hold: the step already running finishes, the next one waits for the restart.
		const drain = readDrain(this.home);
		if (drain) return { job_id: jobId, reason: `the parent is draining (since ${drain.started_at}); integration resumes after the restart`, held_at: drain.started_at };
		const file = this.file(jobId);
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(`integration hold unreadable at ${file}: ${(error as Error).message}`);
		}
		const parsed = validate<IntegrationHold>(IntegrationHoldSchema, value);
		if (!parsed.ok || parsed.value.job_id !== jobId || !parsed.value.reason.trim()) {
			throw new Error(`invalid integration hold at ${file}; repair it or explicitly release ${jobId}`);
		}
		return parsed.value;
	}

	hold(jobId: string, reason: string): IntegrationHold {
		this.requireJob(jobId);
		const hold = { job_id: jobId, reason: reason.trim(), held_at: isoTimestamp() };
		const parsed = validate<IntegrationHold>(IntegrationHoldSchema, hold);
		if (!parsed.ok) throw new Error(`integration hold needs a reason of 1-2000 characters: ${parsed.errors.join("; ")}`);
		atomicWriteJson(this.file(jobId), hold);
		return hold;
	}

	release(jobId: string): void {
		this.requireJob(jobId);
		rmSync(this.file(jobId), { force: true });
	}

	private requireJob(jobId: string): void {
		this.file(jobId); // Validate the id before reading or writing job state.
		const job = new FleetStore({ home: this.home }).require(jobId);
		if (job.kind !== "ship" || job.delivery !== "pr") throw new Error(`${jobId}: integration holds require a delivery:pr ship job`);
	}
}
