/**
 * Service health → escalation (cp-6fyl PR2). cp-health (`src/service/health.ts`, a daemon oneshot) only records; a
 * failing service the operator never saw sat 47 min. The parent turns the watchdog's record into one `service_health`
 * escalation per failing check, so it reaches the dashboard and the operator session like any escalation. It never
 * pushes: Web Push is for open ask cards only (`PUSH_RULE`).
 *
 *  - `rollback_failed:*` (the updater's sticky failure) alerts at once; any other check once it has failed
 *    `SERVICE_ALERT_AFTER_SECONDS` (three watchdog runs, so the 2-run debounce of parent/viewer is not undercut);
 *  - the question names the check, its `since` and its key — no live numbers — so `escalationIdentity` dedupes
 *    re-ticks, and a check that recovers (or changes key) withdraws its open record;
 *  - a record the operator already answered or that was withdrawn is never raised again for the same failure.
 *
 * The parent is the single writer of escalations.json; cp-health only reads and records.
 */
import { join } from "node:path";
import { SERVICE_HEALTH_JOB_ID } from "./contracts.ts";
import type { EscalationStore } from "./escalation.ts";
import type { CheckRecord, HealthRecord } from "./service/health.ts";

/** A non-sticky check must have failed this long before it is an escalation. */
export const SERVICE_ALERT_AFTER_SECONDS = 900;
const KEY_MAX = 120;

export interface ServiceAlert { check: string; key: string; since: string }

/** The alerts `record` owes at `now`; none for a record that was never written or read. */
export function serviceAlerts(record: HealthRecord | undefined, now: Date): ServiceAlert[] {
	if (!record) return [];
	const alerts: ServiceAlert[] = [];
	for (const [check, row] of Object.entries(record.checks) as [string, CheckRecord | undefined][]) {
		if (!row || row.status !== "fail" || !row.key) continue;
		const age = now.getTime() - Date.parse(row.since);
		if (row.key.startsWith("rollback_failed:") || age >= SERVICE_ALERT_AFTER_SECONDS * 1000) alerts.push({ check, key: row.key.slice(0, KEY_MAX), since: row.since });
	}
	return alerts;
}

const alertQuestion = (alert: ServiceAlert): string => `cp-daemon health check "${alert.check}" failing since ${alert.since} (key ${alert.key})`;

/** Raise what is owed, withdraw the open records whose failure is gone. Errors propagate (the tick logs them). */
export async function syncServiceEscalations(store: EscalationStore, alerts: readonly ServiceAlert[], stateDir: string): Promise<{ raised: string[]; withdrawn: string[] }> {
	const wanted = new Map(alerts.map((alert) => [alertQuestion(alert), alert]));
	const known = store.list({ kind: "service_health" });
	const withdrawn: string[] = [];
	for (const item of known) {
		if (item.status !== "open" || wanted.has(item.question)) continue;
		await store.withdraw(item.id);
		withdrawn.push(item.id);
	}
	const raised: string[] = [];
	for (const [question] of wanted) {
		if (known.some((item) => item.question === question)) continue; // open (deduped), answered (acknowledged) or withdrawn
		const made = await store.raise({
			job_ids: [SERVICE_HEALTH_JOB_ID],
			kind: "service_health",
			question,
			options: [{ id: "ack", label: "Acknowledged — I will look", consequence: "closes this alert; a new failure key raises a new one", cost: "none" }],
			recommended: "ack",
			evidence_paths: [join(stateDir, "health.json"), join(stateDir, "update.json")],
		});
		raised.push(made.id);
	}
	return { raised, withdrawn };
}
