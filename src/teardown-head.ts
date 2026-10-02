import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Envelope,
	type EnvelopeRecord,
	EnvelopeRecordSchema,
	type FleetRecord,
	paths,
	validate,
	validateEnvelope,
} from "./contracts.ts";
import { readMergeReceipt } from "./merges.ts";
import { readEventLog } from "./run-artifacts.ts";
import type { GateFailure } from "./teardown.ts";

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
