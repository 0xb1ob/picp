import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GateRecoveryAttemptSchema, GateRecoveryAuthoritySchema, GateRecoveryAttemptTerminalSchema, type RecoveryAttempt, type RecoveryAuthority } from "./contracts/gate-recovery.ts";
import { paths, validate } from "./contracts.ts";
import { publishRecoveryBytes, publishRecoveryFile, recoveryDigest, recoveryJson, recoveryRecord } from "./gate-recovery.ts";

export interface AttemptInputs {
	home: string;
	authority: RecoveryAuthority;
	predecessorId: string;
	artifact: Buffer;
	task: Buffer;
	historySha256: string;
	graphSha256: string;
}

function file(home: string, jobId: string, id: string, suffix: string): string {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid recovery attempt identity");
	return join(home, paths.runDir(jobId), `recovery-attempt-${id}-${suffix}.json`);
}

export function readRecoveryAttempt(home: string, jobId: string, id: string): RecoveryAttempt {
	const value = recoveryRecord<unknown>(file(home, jobId, id, "prepared"));
	const checked = validate<RecoveryAttempt>(GateRecoveryAttemptSchema, value);
	if (!checked.ok || checked.value.job_id !== jobId || checked.value.attempt_id !== id) {
		throw new Error(`${jobId}: missing or invalid recovery attempt`);
	}
	return checked.value;
}

/** One immutable successor slot belongs to each authority/predecessor pair. */
export function prepareRecoveryAttempt(input: AttemptInputs, permit: () => void): RecoveryAttempt {
	permit();
	const { home, authority, predecessorId } = input;
	const checkedAuthority = validate<RecoveryAuthority>(GateRecoveryAuthoritySchema, authority);
	if (!checkedAuthority.ok) throw new Error("invalid recovery authority");
	if (predecessorId !== authority.initial_predecessor.anchor_id) {
		const previous = readRecoveryAttempt(home, authority.job_id, predecessorId);
		const terminal = recoveryRecord<{ attempt_id: string; outcome: string }>(file(home, authority.job_id, predecessorId, "terminal"));
		if (!validate(GateRecoveryAttemptTerminalSchema, terminal).ok || previous.authority_id !== authority.authority_id ||
			terminal?.attempt_id !== predecessorId || terminal.outcome === "pass") {
			throw new Error("recovery predecessor is not a terminal nonpass attempt");
		}
		if (authority.authority_mode !== "standing") throw new Error("single-use recovery authority is spent");
	}
	const id = recoveryDigest(recoveryJson({ authority_id: authority.authority_id, predecessor_id: predecessorId }));
	const attempt: RecoveryAttempt = {
		schema_version: 2, attempt_id: id, authority_id: authority.authority_id,
		predecessor_id: predecessorId, job_id: authority.job_id,
		root_job_id: authority.initial_predecessor.root_job_id,
		dependent_job_ids: authority.dependent_job_ids, history_sha256: input.historySha256,
		graph_sha256: input.graphSha256, artifact_sha256: recoveryDigest(input.artifact),
		artifact_bytes: input.artifact.length, task_sha256: recoveryDigest(input.task),
		artifact_base64: input.artifact.toString("base64"), task_base64: input.task.toString("base64"), state: "prepared",
	};
	const checked = validate<RecoveryAttempt>(GateRecoveryAttemptSchema, attempt);
	if (!checked.ok) throw new Error(`invalid recovery attempt: ${checked.errors.join("; ")}`);
	publishRecoveryFile(file(home, authority.job_id, id, "prepared"), recoveryJson(attempt));
	return attempt;
}

export async function claimRecoveryAttempt(input: {
	home: string; jobId: string; attemptId: string; gateAttempt: number;
	ready: () => Promise<void>; revalidate: (attempt: RecoveryAttempt) => void;
}): Promise<{ artifact: Buffer; task: Buffer }> {
	const attempt = readRecoveryAttempt(input.home, input.jobId, input.attemptId);
	await input.ready();
	input.revalidate(attempt);
	const current = readRecoveryAttempt(input.home, input.jobId, input.attemptId);
	if (!recoveryJson(current).equals(recoveryJson(attempt))) throw new Error("recovery attempt changed during preflight");
	if (recoveryRecord(file(input.home, input.jobId, input.attemptId, "terminal"))) throw new Error("recovery attempt is terminal");
	const artifact = Buffer.from(attempt.artifact_base64, "base64"), task = Buffer.from(attempt.task_base64, "base64");
	if (artifact.length !== attempt.artifact_bytes || recoveryDigest(artifact) !== attempt.artifact_sha256 || recoveryDigest(task) !== attempt.task_sha256) {
		throw new Error("recovery attempt frozen input mismatch");
	}
	const claimed = publishRecoveryBytes(file(input.home, input.jobId, input.attemptId, "claim"), recoveryJson({
		attempt_id: input.attemptId, authority_id: attempt.authority_id,
		attempt_sha256: recoveryDigest(recoveryJson(attempt)), gate_attempt: input.gateAttempt,
	}));
	if (!claimed) throw new Error("recovery attempt already claimed; no spawn");
	return { artifact, task };
}

export function finishRecoveryAttempt(input: {
	home: string; jobId: string; attemptId: string;
	outcome: "pass" | "nonpass" | "interrupted" | "spawn_failure";
	decisionPath?: string;
}): void {
	readRecoveryAttempt(input.home, input.jobId, input.attemptId);
	const claim = readFileSync(file(input.home, input.jobId, input.attemptId, "claim"));
	publishRecoveryFile(file(input.home, input.jobId, input.attemptId, "terminal"), recoveryJson({
		attempt_id: input.attemptId, claim_sha256: recoveryDigest(claim), outcome: input.outcome,
		...(input.decisionPath ? { decision_path: input.decisionPath, decision_sha256: recoveryDigest(readFileSync(input.decisionPath)) } : {}),
	}));
}
