/**
 * Scheduled jobs are independent jobs (cp-hhuf P1): the parent's own turn about
 * a job labelled `schedule:<id>` is not relayed to the operator session; the run
 * shows on the Schedules page instead. Escalations and errors still relay, and
 * so does any turn that also touched an unscheduled job.
 */
import { currentEscalationRelay } from "./escalation-relay.ts";
import type { BridgeRelay } from "./cp-bridge.ts";
import { readJobsDocument } from "./ledger.ts";
import { WAKEUP_CUSTOM_TYPES } from "./wakeups.ts";

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

export interface EnvelopeSummary { jobId: string; status?: string; summary: string }

/** issue #2: an accepted cp-envelope wake-up's own summary, from its structured details (IntakeResult), never its prose. */
export function envelopeSummaryOf(message: unknown): EnvelopeSummary | undefined {
	const record = message as { role?: unknown; customType?: unknown; details?: { job_id?: unknown; accepted?: unknown; status?: unknown; summary?: unknown } } | undefined;
	if (record?.role !== "custom" || record.customType !== WAKEUP_CUSTOM_TYPES.envelope) return undefined;
	const d = record.details;
	if (d?.accepted !== true || typeof d.job_id !== "string" || !JOB_ID.test(d.job_id)) return undefined;
	if (typeof d.summary !== "string" || d.summary.trim().length === 0) return undefined;
	return { jobId: d.job_id, summary: d.summary.trim(), ...(typeof d.status === "string" ? { status: d.status } : {}) };
}

/** The operator can hold the parent's words against what the worker filed: one verbatim line per job, last envelope wins. */
export function withEnvelopeSummaries(text: string, envelopes: readonly EnvelopeSummary[]): string {
	const latest = new Map(envelopes.map((e) => [e.jobId, e]));
	if (latest.size === 0) return text;
	return `${text}\n\n${[...latest.values()].map((e) => `envelope ${e.jobId}${e.status ? ` (${e.status})` : ""}, verbatim: ${e.summary}`).join("\n")}`;
}

/** The one choke point for every relay: a wake about scheduled jobs only is dropped, then the escalation recheck. */
export function deliverableRelay(home: string, relay: BridgeRelay): BridgeRelay | undefined {
	const ids = relay.jobIds ?? [];
	if (relay.kind === "wake" && ids.length > 0 && scheduledJobIds(home, ids).size === ids.length) return undefined;
	return currentEscalationRelay(home, relay);
}
