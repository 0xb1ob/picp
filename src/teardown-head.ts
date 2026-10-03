import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type Envelope,
	type EnvelopeRecord,
	EnvelopeRecordSchema,
	type FleetRecord,
	type GateVerdict,
	GateVerdictSchema,
	isScriptFleetRecord,
	paths,
	validate,
	validateEnvelope,
} from "./contracts.ts";
import { isPidAlive, readRunObservation } from "./fleet.ts";
import { readMergeReceipt } from "./merges.ts";
import { readEventLog, readStatusFile } from "./run-artifacts.ts";
import type { GateFailure } from "./teardown.ts";
import { boundedWakeupId, type DurableWakeupInput, KILLED_UNREPORTED_WAKEUP_PREFIX } from "./wakeup-outbox.ts";

export interface TeardownCallOptions {
	force?: boolean;
	/** A verified operator quote (src/decide.ts requireOperatorQuote); recorded with a forced teardown. */
	authorization?: { by: string; quote: string };
	/** The model-facing cp_teardown sets it: force past unreported_live_worker then needs `authorization`. */
	requireAuthorization?: boolean;
	/** Pipeline hand-off only: the planner's artifact passed the gate and the plan is authorized. Recorded; no wake-up. */
	acceptUnreported?: string;
}

/**
 * issue #2: a live (or mid-turn) worker that has filed no report for this
 * generation. Liveness is the reconcile rule (src/fleet.ts): owned and alive, or
 * unowned with no recorded or observed close and a live pid. `failed` is
 * excluded (already announced; `unreported_head` covers failed ship jobs).
 */
export function unreportedLiveWorker(home: string, record: FleetRecord,
	managed: { worker: { alive: boolean; busy: boolean } } | undefined): GateFailure | undefined {
	if (isScriptFleetRecord(record) || record.reported_at !== undefined) return undefined;
	if (record.phase !== "waiting" && record.phase !== "launching") return undefined;
	const owned = managed?.worker.alive === true;
	const orphan = !managed && record.worker.exited_at === undefined &&
		readRunObservation(home, record.job_id)?.closed !== true && isPidAlive(record.worker.pid);
	if (!owned && !orphan) return undefined;
	const midTurn = managed?.worker.busy === true || readStatusFile(home, record.job_id)?.phase === "working";
	return {
		code: "unreported_live_worker",
		message: `${record.job_id}: its worker (pid ${record.worker.pid}) is ${midTurn ? "mid-turn" : "alive"} and has filed no report for this generation; tearing it down now loses its result unreported`,
		fix: `keep the lease; wait for its cp-envelope wake-up, or cp_send ${record.job_id} asking it to call report_result; relay "no report" for it until then. Force only on an operator's word (force + operator_quote), which ends as killed_unreported`,
	};
}

/** The run-log facts of a forced teardown: whether it killed an unreported worker, and on whose word. */
export function forcedShutdownFacts(unreported: GateFailure | undefined, options: TeardownCallOptions): Record<string, unknown> {
	return {
		...(unreported ? { killed_unreported: true } : {}),
		...(options.authorization ? { authorized_by: options.authorization.by, operator_quote: options.authorization.quote } : {}),
	};
}

/** The durable notice of a killed_unreported teardown: no keys, so a done job never stales it. */
export function killedUnreportedWakeup(home: string, record: FleetRecord, closedAt: string,
	authorization?: { by: string; quote: string }): DurableWakeupInput {
	const artifact = join(home, paths.artifactFile(record.job_id));
	const bytes = existsSync(artifact) ? statSync(artifact).size : undefined;
	const by = authorization ? `${authorization.by} "${authorization.quote.slice(0, 300)}"` : "no operator quote recorded (direct API force)";
	return {
		id: boundedWakeupId(`${KILLED_UNREPORTED_WAKEUP_PREFIX}${record.job_id}:${closedAt}`),
		kind: "recovery", job_id: record.job_id,
		content: [
			`[${record.project}] ${record.job_id}: killed_unreported — cp_teardown force ended a live worker that never filed a report.`,
			`  result: none received; ${bytes !== undefined ? `artifact: ${artifact} (${bytes} bytes, unread)` : "artifact: none"}.`,
			`  relay: "no report" for ${record.job_id} — never a finding, a summary or "done".`,
			`  ledger: the job stays open and its dependents stay blocked; going on without it is cp_job drop ${record.job_id} with a reason, then the operator's proceed/drop/reopen answer (cp_next raises it under an active mandate).`,
			`  authorized by ${by}.`,
		].join("\n"),
	};
}

export function latestGateVerdict(home: string, jobId: string): string | undefined {
	for (let attempt = 32; attempt >= 1; attempt -= 1) {
		const file = join(home, paths.gateFile(jobId, attempt));
		if (!existsSync(file)) continue;
		try {
			const parsed = validate<GateVerdict>(GateVerdictSchema, JSON.parse(readFileSync(file, "utf8")));
			if (parsed.ok) return parsed.value.verdict;
		} catch {
			// unreadable attempt is not a verdict
		}
	}
	return undefined;
}

function headline(summary: string): string {
	return summary.trim().split("\n")[0] ?? summary.trim();
}

export function derivedCloseReason(record: Pick<FleetRecord, "delivery">, envelope: Envelope, verdict?: string): string {
	if (record.delivery === "answer") return `answered: ${headline(envelope.summary)}`;
	if (verdict) return `gated: ${verdict}`;
	const artifact = envelope.artifact_path?.trim();
	return `researched: ${artifact && artifact.length > 0 ? artifact : headline(envelope.summary)}`;
}

export function readFiledEnvelope(home: string, jobId: string): Envelope | undefined {
	return readFiledEnvelopeRecord(home, jobId)?.envelope as Envelope | undefined;
}

function readFiledEnvelopeRecord(home: string, jobId: string): EnvelopeRecord | undefined {
	const file = join(home, paths.envelopeFile(jobId));
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validate<EnvelopeRecord>(EnvelopeRecordSchema, JSON.parse(readFileSync(file, "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/** A pushed head is durable, but an unreported head is not finished work. */
export function acceptedHeadFailure(home: string, record: FleetRecord, head: string): GateFailure | undefined {
	const jobId = record.job_id;
	const envelopeRecord = readFiledEnvelopeRecord(home, jobId);
	const envelope = envelopeRecord?.envelope as Envelope | undefined;
	const receipt = readMergeReceipt(home, jobId);
	let accepted = false;
	if (record.reported_at && envelopeRecord) {
		try {
			const latest = readEventLog(home, jobId).filter((event) => event.source === "cp" && event.type === "envelope_received").at(-1);
			const payload = latest?.payload as { generation?: number; attempt?: number } | undefined;
			accepted = payload?.generation === (record.supersessions ?? 0) + 1 &&
				payload.attempt === envelopeRecord.attempt;
		} catch {
			// An unreadable run log cannot prove intake accepted this generation.
		}
	}
	if ((accepted && envelope && validateEnvelope(envelope, {
		job_id: jobId, kind: record.kind, delivery: record.delivery, worktree: record.worktree,
	}).ok && envelope.kind === "ship" && envelope.status === "done" &&
		envelope.branch === record.branch && envelope.head_sha === head) ||
		(receipt?.job_id === jobId && receipt.head_branch === record.branch && receipt.head_sha === head)) {
		return undefined;
	}
	return {
		code: "unreported_head",
		message: `${jobId}: HEAD ${head.slice(0, 12)} has no accepted current-generation ship report or landed merge receipt`,
		fix: `keep the lease; continue ${jobId} with cp_revive/cp_send to report this head, or confirm its merge with cp_merged; force only if deliberately unverified`,
	};
}
