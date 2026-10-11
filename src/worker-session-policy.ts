/**
 * P2 (cp-35d0 S5): the worker summarizer persists one `worker-compaction-policy-block`
 * custom entry when a provider refuses its transcript on policy grounds
 * (`extensions/worker-reporter/compaction.ts`). That guard only stops later
 * summarization; this scan lets `cp_send` and `cp_revive` refuse to hand new work
 * to a transcript that already carries it. A file this cannot read or parse is a
 * named refusal, never "healthy".
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const WORKER_COMPACTION_POLICY_BLOCK = "worker-compaction-policy-block";

export class WorkerSessionScanError extends Error {}

/** True when `sessionFile` holds a structural policy-block entry; an unreadable or malformed file throws `WorkerSessionScanError` naming the path. */
export async function sessionPolicyBlocked(sessionFile: string): Promise<boolean> {
	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	let lineNumber = 0;
	try {
		for await (const line of lines) {
			lineNumber += 1;
			if (line.trim().length === 0) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				throw new WorkerSessionScanError(`worker session ${sessionFile} line ${lineNumber} is not valid JSON; cannot tell whether it is policy-blocked`);
			}
			if (typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "custom" && (entry as { customType?: unknown }).customType === WORKER_COMPACTION_POLICY_BLOCK) {
				return true;
			}
		}
		return false;
	} catch (error) {
		if (error instanceof WorkerSessionScanError) throw error;
		throw new WorkerSessionScanError(`worker session ${sessionFile} could not be read (${(error as Error).message}); cannot tell whether it is policy-blocked`);
	} finally {
		lines.close();
		stream.destroy();
	}
}

/** The refusal text shared by send and revive: surface it, keep the lease, decide recovery by hand. */
export function policyBlockedRefusal(jobId: string, sessionFile: string): string {
	return (
		`${jobId}'s session ${sessionFile} carries a ${WORKER_COMPACTION_POLICY_BLOCK} entry: a provider refused its transcript on policy ` +
		"grounds, so new work there cannot be compacted. Nothing was sent, restored or spawned; surface the block to the operator and " +
		"keep the lease for a recovery decision."
	);
}
