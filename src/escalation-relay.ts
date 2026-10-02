import type { BridgeRelay } from "./cp-bridge.ts";
import type { Escalation } from "./contracts.ts";
import { EscalationStore } from "./escalation.ts";
import { messageText as textOf } from "./parent-outbox.ts";

/** A `cp_escalate` tool result's details, as the bridge relays them. */
export function asEscalation(details: unknown): { id?: string; jobIds: string[]; mandateId?: string; evidence: string[]; question?: string; stale: boolean } {
	if (!details || typeof details !== "object") return { jobIds: [], evidence: [], stale: false };
	const record = details as Record<string, unknown>;
	const jobIds = Array.isArray(record.job_ids) ? record.job_ids.filter((id): id is string => typeof id === "string") : [];
	const evidence = Array.isArray(record.evidence_paths)
		? record.evidence_paths.filter((path): path is string => typeof path === "string")
		: [];
	const question = typeof record.question === "string" ? record.question : undefined;
	const stale = question?.toLowerCase().includes("stale") === true || textOf(details).toLowerCase().includes("stale");
	return {
		...(typeof record.id === "string" ? { id: record.id } : {}),
		jobIds,
		...(typeof record.mandate_id === "string" ? { mandateId: record.mandate_id } : {}),
		evidence,
		...(question ? { question } : {}),
		stale,
	};
}

/**
 * Open mission-end escalations a `cp_next` result raised (its own or an `others` grant's). `cp_next` raises them itself,
 * so no `cp_escalate` call ever reaches the bridge; a clean finish closed itself and is answered, never open here.
 */
export function openMissionEnds(home: string, result: unknown): Escalation[] {
	type Item = { action?: { kind?: string }; escalation_id?: string };
	const details = (result as { details?: Item & { others?: Item[] } } | undefined)?.details;
	try {
		const store = new EscalationStore({ home });
		return [details, ...(details?.others ?? [])]
			.map((item) => (item?.action?.kind === "mission_end" && item.escalation_id ? store.get(item.escalation_id) : undefined))
			.filter((item): item is Escalation => item?.status === "open");
	} catch {
		return []; // an unreadable store stays visible as cp_parent status openEscalations, never lost
	}
}


/** Recheck at delivery: a queued question may have been withdrawn since it was raised. */
export function currentEscalationRelay(home: string, relay: BridgeRelay): BridgeRelay | undefined {
	if (!relay.escalationId) return relay;
	try {
		const current = new EscalationStore({ home }).get(relay.escalationId);
		return current && current.status !== "open" ? undefined : relay;
	} catch (error) {
		return {
			kind: "error", stale: false,
			text: `Could not verify escalation ${relay.escalationId}: ${(error as Error).message}`,
			receipt: relay.receipt, paths: [],
		};
	}
}
