/**
 * Batch risk:high approval (cp-itl4 6b): one operator answer authorizes, or drops, several risk:high jobs
 * together. `assertDispatchAllowed` already reads any answered approve on a `risk_high_irreversible` record
 * whose `job_ids` names the job, so a batch is just one record listing every id. Everything is validated
 * before any write: a refusal leaves `escalations.json` byte-identical. Then the batch is raised first and
 * the per-job rows withdrawn after, so a crash between leaves duplicates rather than a lost question.
 */
import { ESCALATION_QUESTION_MAX_CHARS, type Escalation, isoTimestamp } from "./contracts.ts";
import { EscalationError, type EscalationStore } from "./escalation.ts";
import { type Ledger, parseJobLabels } from "./ledger.ts";
import { covers, isActive } from "./mandate-accounting.ts";
import type { MandateStore } from "./mandate.ts";

export const RISK_BATCH_MIN = 2;
export const RISK_BATCH_MAX = 16;
const APPROVE = /^(?:approve|approved|yes)$/i;

export interface RiskBatchResult {
	escalation: Escalation;
	withdrawn: string[];
}

export async function batchRiskHigh(
	deps: { escalations: EscalationStore; mandates: MandateStore; ledger: Ledger },
	input: { jobIds: readonly string[]; mandateId?: string },
): Promise<RiskBatchResult> {
	const ids = input.jobIds.map((id) => id.trim());
	const refuse = (why: string): never => {
		throw new EscalationError(`cp_escalate batch_risk_high refused: ${why} \u2014 nothing was written`);
	};
	if (ids.length < RISK_BATCH_MIN || ids.length > RISK_BATCH_MAX) refuse(`needs ${RISK_BATCH_MIN}..${RISK_BATCH_MAX} job ids, got ${ids.length}`);
	const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
	if (duplicates.length > 0) refuse(`duplicate job ids: ${duplicates.join(", ")}`);

	// Read-only from here until the raise: list() + isActive, never sweep() (a sweep may write).
	const now = isoTimestamp(new Date());
	const asking = deps.mandates.list().filter((mandate) => isActive(mandate, now) && mandate.ask_on.includes("risk:high"));
	const records = deps.escalations.list({ kind: "risk_high_irreversible" });
	const unknown: string[] = [];
	const ungated: string[] = [];
	const approved: string[] = [];
	const askers = new Map<string, string[]>();
	const rows = new Map<string, Escalation>();
	for (const id of ids) {
		let labels: readonly string[] | undefined;
		try {
			labels = (await deps.ledger.show(id)).labels ?? [];
		} catch {
			unknown.push(id);
			continue;
		}
		const parsed = parseJobLabels(labels);
		const row = records.find((entry) => entry.status === "open" && entry.job_ids.length === 1 && entry.job_ids[0] === id);
		if (row) rows.set(id, row);
		if (!row && parsed.risk !== "high") ungated.push(id);
		if (records.some((entry) => entry.job_ids.includes(id) && entry.status === "answered" && APPROVE.test((entry.answer ?? "").trim()))) approved.push(id);
		const job = { jobId: id, project: parsed.project ?? "", ...(parsed.kind ? { jobKind: parsed.kind } : {}), ...deps.mandates.scheduleOf(id) };
		askers.set(id, asking.filter((mandate) => covers(mandate, job)).map((mandate) => mandate.id));
	}
	if (unknown.length > 0) refuse(`unknown job ids: ${unknown.join(", ")}`);
	if (approved.length > 0) refuse(`already approved: ${approved.join(", ")}`);
	if (ungated.length > 0) refuse(`not risk:high gated (no open per-job risk:high row, no risk:high label): ${ungated.join(", ")}`);
	const union = [...new Set([...askers.values()].flat())].sort();
	const unasked = ids.filter((id) => (askers.get(id) ?? []).length === 0);
	if (unasked.length > 0) refuse(`no active mandate with ask_on risk:high covers: ${unasked.join(", ")}`);
	const mixed = ids.filter((id) => (askers.get(id) ?? []).length !== 1);
	if (union.length !== 1 || mixed.length > 0) refuse(`one asking mandate must cover every job; found ${union.join(", ")}`);
	const mandateId = union[0] as string;
	if (input.mandateId && input.mandateId.trim() !== mandateId) refuse(`asking mandate is ${mandateId}, not ${input.mandateId}`);

	const sorted = [...ids].sort();
	const evidence = (id: string) => /\(([^()]*)\)$/.exec(rows.get(id)?.question ?? "")?.[1] ?? "risk:high label";
	const escalation = await deps.escalations.raise({
		job_ids: sorted,
		kind: "risk_high_irreversible",
		question: `${sorted.length} jobs risk:high under ask_on \u2014 approve all or drop all: ${sorted.map((id) => `${id} (${evidence(id)})`).join("; ")}`.slice(0, ESCALATION_QUESTION_MAX_CHARS),
		options: [
			{ id: "approve", label: "approve", consequence: "cp_dispatch (or the cp_send promotion) proceeds for every listed job", cost: "operator accepts the risk for all of them" },
			{ id: "drop", label: "drop", consequence: "none of the listed jobs is dispatched", cost: "sunk planning" },
		],
		recommended: "drop",
		mandate_id: mandateId,
		mandate_clause: `${mandateId}: ask_on includes risk:high`,
		evidence_paths: [],
	});
	const withdrawn: string[] = [];
	for (const id of sorted) {
		const row = rows.get(id);
		if (!row) continue;
		await deps.escalations.withdraw(row.id);
		withdrawn.push(row.id);
	}
	return { escalation, withdrawn };
}
