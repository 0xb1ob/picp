/**
 * Scheduled jobs are independent jobs (cp-hhuf P1): the parent's own turn about
 * a job labelled `schedule:<id>` is not relayed to the operator session; the run
 * shows on the Schedules page instead. Escalations and errors still relay, and
 * so does any turn that also touched an unscheduled job.
 */
import { currentEscalationRelay } from "./escalation-relay.ts";
import type { BridgeRelay } from "./cp-bridge.ts";
import { readJobsDocument } from "./ledger.ts";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The subset of `ids` whose ledger job carries a `schedule:` label. An unreadable ledger scopes nothing: relay, never drop. */
export function scheduledJobIds(home: string, ids: readonly string[]): Set<string> {
	if (ids.length === 0) return new Set();
	try {
		const jobs = readJobsDocument(home).jobs;
		return new Set(ids.filter((id) => jobs.some((job) => job.id === id && (job.labels ?? []).some((label) => label.startsWith("schedule:")))));
	} catch {
		return new Set();
	}
}

/** A `cp-schedule` fire message's job (`details.job_id`); it carries no wake-up stamp. */
export function scheduleJobIdOf(message: unknown): string | undefined {
	const record = message as { role?: unknown; customType?: unknown; details?: { job_id?: unknown } } | undefined;
	if (record?.role !== "custom" || record.customType !== "cp-schedule") return undefined;
	const id = record.details?.job_id;
	return typeof id === "string" && JOB_ID.test(id) ? id : undefined;
}

/** The one choke point for every relay: a wake about scheduled jobs only is dropped, then the escalation recheck. */
export function deliverableRelay(home: string, relay: BridgeRelay): BridgeRelay | undefined {
	const ids = relay.jobIds ?? [];
	if (relay.kind === "wake" && ids.length > 0 && scheduledJobIds(home, ids).size === ids.length) return undefined;
	return currentEscalationRelay(home, relay);
}
