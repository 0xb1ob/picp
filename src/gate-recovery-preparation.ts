import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./contracts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { FleetStore } from "./fleet.ts";
import { requireJobLabels, type Ledger } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";
import { EscalationStore } from "./escalation.ts";
import { readPriorAttempts } from "./gate.ts";
import { publishRecoveryFile, recoveryDigest, recoveryFile, recoveryJson, recoveryRecord, recoveryTarget, recoveryStatus, validateRecoveryAuthority, type RecoveryReservation } from "./gate-recovery.ts";

export async function prepareRecovery(options: {
	home: string; jobId: string; replacementJobId: string; replanEscalationId: string;
	ledger: Ledger; fleet: FleetStore; artifacts: ArtifactStore; mandates?: MandateStore;
}) {
	const { home, jobId, replacementJobId, ledger, fleet, artifacts } = options;
	const old = await ledger.show(jobId);
	const replacement = await ledger.show(replacementJobId);
	const dir = join(home, paths.runDir(jobId));
	const target = join(home, paths.runDir(replacementJobId));
	if (jobId === replacementJobId || existsSync(recoveryFile(dir, "source")) ||
		existsSync(recoveryFile(target, "reservation"))) throw new Error("recovery chaining is forbidden");
	const canonical = recoveryFile(dir, "reservation");
	const saved = recoveryRecord<RecoveryReservation>(canonical);
	const prior = readPriorAttempts(home, jobId);
	const last = prior.decisions.at(-1);
	if (!last) throw new Error(`${jobId}: no capped gate decision`);
	if (old.status !== "closed" || fleet.get(jobId)?.phase !== "done" || requireJobLabels(old).kind !== "research") {
		throw new Error(`${jobId}: recovery requires a closed, done research source`);
	}
	if (!saved) {
		try { recoveryTarget(home, jobId); }
		catch (error) { if (!existsSync(canonical)) throw error; }
		const a = requireJobLabels(old), b = requireJobLabels(replacement);
		if (old.status !== "closed" || fleet.get(jobId)?.phase !== "done" || a.kind !== "research" ||
			replacement.status !== "open" || fleet.get(replacementJobId) || b.kind !== "research" ||
			a.project !== b.project || a.delivery !== b.delivery || artifacts.has(replacementJobId) ||
			readPriorAttempts(home, replacementJobId).decisions.length) {
			if (!existsSync(canonical)) throw new Error("recovery requires a closed planner and matching fresh research replacement");
		}
	}
	const authority = new EscalationStore({ home }).read().items.find((item) => item.id === options.replanEscalationId);
	if (!authority) throw new Error(`${options.replanEscalationId}: missing recovery authority`);
	const files: { source: string; target: string; bytes: Buffer }[] = [];
	const add = (source: string, destination: string) => files.push({ source, target: destination, bytes: readFileSync(source) });
	add(artifacts.file(jobId), join(target, "previous-plan.md"));
	for (const relative of [paths.originalTaskFile(jobId), paths.taskAddendaFile(jobId)]) {
		const source = join(home, relative);
		if (relative === paths.originalTaskFile(jobId) && !existsSync(source)) throw new Error(`${source}: missing recovery scope input`);
		if (existsSync(source)) add(source, join(target, relative === paths.originalTaskFile(jobId) ? "previous-original-task.md" : "task-addenda.jsonl"));
	}
	const raw = join(home, paths.gateFileRaw(jobId, last.attempt));
	if (existsSync(raw)) add(raw, join(target, `gate-${last.attempt}-raw.json`));
	else files.push({ source: join(home, paths.gateFile(jobId, last.attempt)),
		target: join(target, `gate-${last.attempt}-raw.json`), bytes: recoveryJson(last) });
	for (const decision of prior.decisions) {
		const source = join(home, paths.gateFile(jobId, decision.attempt));
		files.push({ source, target: join(home, paths.gateFile(replacementJobId, decision.attempt)),
			bytes: recoveryJson({ ...decision, job_id: replacementJobId }) });
	}
	const reservation: RecoveryReservation = {
		schema_version: 1, source_job: jobId, replacement_job: replacementJobId, attempt: last.attempt,
		decision_sha256: recoveryDigest(readFileSync(join(home, paths.gateFile(jobId, last.attempt)))),
		escalation_id: options.replanEscalationId, authority_sha256: recoveryDigest(recoveryJson(authority)),
		inputs: files.map((file) => ({ source: file.source, target: file.target, bytes: file.bytes.length,
			sha256: recoveryDigest(file.bytes), source_sha256: recoveryDigest(readFileSync(file.source)) })),
	};
	validateRecoveryAuthority(home, reservation, options.mandates);
	publishRecoveryFile(canonical, recoveryJson(reservation));
	const binding = { source_job: jobId, reservation_sha256: recoveryDigest(recoveryJson(reservation)) };
	publishRecoveryFile(recoveryFile(target, "source"), recoveryJson(binding));
	for (const file of files) publishRecoveryFile(file.target, file.bytes);
	const task_file = join(target, "revision-task.md");
	publishRecoveryFile(task_file, Buffer.from([
		`# Correct the plan from ${jobId}`,
		`You are a replacement read-only planner for ${replacementJobId}. Do not implement code.`,
		...files.filter((file) => !/gate-\d+\.json$/.test(file.target)).map((file) => `Read in full: ${file.target}`),
		`Write the corrected plan to ${artifacts.file(replacementJobId)} and report_result.`,
		"Exactly one corrected review is available. No automatic revision or retry follows it.",
	].join("\n") + "\n"));
	const result = { job_id: jobId, replacement_job_id: replacementJobId, task_file };
	publishRecoveryFile(join(dir, "gate-replacement.json"), recoveryJson(result));
	publishRecoveryFile(recoveryFile(target, "prepared"), recoveryJson(binding));
	return { ...result, recovery: recoveryStatus(home, replacementJobId) };
}
