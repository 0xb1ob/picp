import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ESCALATION_NO_MANDATE, GateRecoveryReservationSchema, GateRecoveryClaimSchema, GateVerdictSchema, validate, paths, type GateVerdict, type RecoveryReservation, type RecoveryClaim, type GateRecoveryStatus } from "./contracts.ts";
import { EscalationStore, kindForGate } from "./escalation.ts";
import { MandateStore } from "./mandate.ts";
import { parseTaskAddenda, taskAddendaText } from "./task-addenda.ts";

export function recoveryTask(reservation: RecoveryReservation, buffers: readonly Buffer[], artifactPath: string): Buffer {
	const original = reservation.inputs.findIndex((file) => file.target.endsWith("/previous-original-task.md"));
	const addenda = reservation.inputs.findIndex((file) => file.target.endsWith("/task-addenda.jsonl"));
	if (original < 0) throw new Error("missing recovery scope input");
	return Buffer.concat([buffers[original]!, Buffer.from([
		addenda < 0 ? "" : taskAddendaText(parseTaskAddenda(buffers[addenda]!.toString("utf8"), reservation.inputs[addenda]!.target)),
		"\n\n## Recovery output override",
		`Source job: ${reservation.source_job}; replacement job: ${reservation.replacement_job}.`,
		`Source artifact: ${reservation.inputs[0]!.source}; replacement artifact: ${artifactPath}.`,
		`Reservation SHA256: ${recoveryDigest(recoveryJson(reservation))}; authority: ${reservation.escalation_id}.`,
		"Only source output/reporting destination instructions are superseded for this replacement.",
		"All substantive acceptance and authorized addenda remain governing scope, not scope growth.",
		`Write the complete corrected plan to ${artifactPath} and report_result.`,
		"Exactly one corrected review is available. No automatic revision or retry follows it.",
		"The candidate must contain full evidence; reviewers must not recursively load references.",
		"\n## Planner supporting inputs (planner only; not reviewer inputs)",
		"Replacement planner: remain read-only; do not implement code.",
		...reservation.inputs.filter((file) => !/gate-\d+\.json$/.test(file.target)).map((file) => `Read in full: ${file.target}`),
		"",
	].join("\n"))]);
}

export type { RecoveryReservation } from "./contracts.ts";

export function recoveryRecord<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")) as T; }
	catch (error) { throw new Error(`${path}: unreadable recovery record: ${String(error)}`); }
}

export function recoveryJson(value: unknown): Buffer {
	return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}

export function validateRecoveryAuthority(home: string, reservation: RecoveryReservation, mandates?: MandateStore): void {
	const parsed = validate<RecoveryReservation>(GateRecoveryReservationSchema, reservation);
	if (!parsed.ok) throw new Error(`invalid recovery reservation: ${parsed.errors.join("; ")}`);
	const decisionFile = join(home, paths.gateFile(reservation.source_job, reservation.attempt));
	if (readdirSync(dirname(decisionFile)).some((name) => {
		const match = /^gate-(\d+)\.json$/.exec(name);
		return match && Number(match[1]) > reservation.attempt;
	})) throw new Error(`${decisionFile}: recovery authority is stale; a newer decision exists`);
	const bytes = readFileSync(decisionFile);
	const decision = JSON.parse(bytes.toString()) as GateVerdict;
	const sourceVerdict = validate<GateVerdict>(GateVerdictSchema, decision);
	if (!sourceVerdict.ok) throw new Error(`${decisionFile}: invalid recovery source decision`);
	if (recoveryDigest(bytes) !== reservation.decision_sha256 || decision.verdict !== "escalate" ||
		decision.cause !== "policy" || kindForGate(decision) !== "loop_exhausted") {
		throw new Error(`${decisionFile}: capped recovery decision changed or invalid`);
	}
	const authority = new EscalationStore({ home }).read().items.find((item) => item.id === reservation.escalation_id);
	if (!authority || authority.status !== "answered" || authority.kind !== "loop_exhausted" ||
		authority.answer !== "replan" || authority.answered_by !== "operator-quote" ||
		!authority.basis || !("operator_quote" in authority.basis) || !authority.basis.operator_quote.trim() ||
		!authority.answered_at || authority.answered_at < decision.decided_at ||
		authority.job_ids.length !== 1 || authority.job_ids[0] !== reservation.source_job ||
		!authority.evidence_paths.includes(paths.gateFile(reservation.source_job, reservation.attempt)) ||
		recoveryDigest(recoveryJson(authority)) !== reservation.authority_sha256) {
		throw new Error(`${reservation.escalation_id}: missing, stale, withdrawn or mismatched recovery authority`);
	}
	const sourceAddenda = join(home, paths.taskAddendaFile(reservation.source_job));
	if (existsSync(sourceAddenda) !== reservation.inputs.some((file) => file.source === sourceAddenda)) {
		throw new Error(`${sourceAddenda}: recovery addenda mismatch`);
	}
	for (const input of reservation.inputs) {
		if (recoveryDigest(readFileSync(input.source)) !== input.source_sha256) {
			throw new Error(`${input.source}: recovery source input changed`);
		}
	}
	if (authority.mandate_id !== ESCALATION_NO_MANDATE) {
		const grant = (mandates ?? new MandateStore(home)).get(authority.mandate_id);
		if (!grant || grant.status !== "active" || grant.expiry <= new Date().toISOString()) {
			throw new Error(`${authority.mandate_id}: recovery requires a current active grant`);
		}
	}
}

function readReservation(path: string): RecoveryReservation | undefined {
	const value = recoveryRecord<unknown>(path);
	if (value === undefined) return undefined;
	const parsed = validate<RecoveryReservation>(GateRecoveryReservationSchema, value);
	if (!parsed.ok) throw new Error(`${path}: invalid recovery reservation: ${parsed.errors.join("; ")}`);
	return parsed.value;
}
export function recoveryTarget(home: string, jobId: string): RecoveryReservation | undefined {
	const dir = join(home, paths.runDir(jobId));
	const source = readReservation(recoveryFile(dir, "reservation"));
	if (source) throw new Error(`${jobId}: recovery reserved for ${source.replacement_job}`);
	const backlink = recoveryRecord<{ source_job: string; reservation_sha256: string }>(recoveryFile(dir, "source"));
	if (!backlink) {
		const runs = dirname(dir);
		if (existsSync(runs)) for (const entry of readdirSync(runs, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const file = recoveryFile(join(runs, entry.name), "reservation");
			const reserved = readReservation(file);
			if (reserved?.replacement_job === jobId) throw new Error(`${jobId}: recovery reservation exists; preparation incomplete`);
		}
		return undefined;
	}
	const file = recoveryFile(join(home, paths.runDir(backlink.source_job)), "reservation");
	const reservation = readReservation(file);
	if (!reservation || reservation.schema_version !== 1 || reservation.replacement_job !== jobId ||
		reservation.source_job !== backlink.source_job || recoveryDigest(readFileSync(file)) !== backlink.reservation_sha256 ||
		!Array.isArray(reservation.inputs)) throw new Error(`${file}: invalid recovery binding`);
	const prepared = recoveryRecord<{ reservation_sha256: string }>(recoveryFile(dir, "prepared"));
	if (prepared?.reservation_sha256 !== backlink.reservation_sha256) throw new Error(`${jobId}: recovery preparation incomplete`);
	return reservation;
}

export function recoveryReplay(home: string, jobId: string, artifact: Buffer): GateVerdict | undefined {
	const dir = join(home, paths.runDir(jobId));
	const claim = recoveryRecord<RecoveryClaim>(recoveryFile(dir, "claim"));
	if (!claim) return undefined;
	const reservation = recoveryTarget(home, jobId);
	const parsed = validate<RecoveryClaim>(GateRecoveryClaimSchema, claim);
	if (!parsed.ok) throw new Error(`${jobId}: invalid recovery claim: ${parsed.errors.join("; ")}`);
	if (!reservation || claim.replacement_job !== jobId || claim.attempt !== reservation.attempt + 1 ||
		claim.reservation_sha256 !== recoveryDigest(recoveryJson(reservation))) throw new Error(`${jobId}: invalid recovery claim`);
	if (claim.artifact_sha256 !== recoveryDigest(artifact) || claim.artifact_bytes !== artifact.length) {
		throw new Error(`${jobId}: recovery exhausted; artifact changed`);
	}
	const decisionPath = join(home, paths.gateFile(jobId, claim.attempt));
	const decision = recoveryRecord<GateVerdict>(decisionPath);
	if (!decision) {
		publishRecoveryFile(recoveryFile(dir, "interrupted"), recoveryJson({ claim_sha256: recoveryDigest(recoveryJson(claim)), remaining: 0 }));
		throw new Error(`${jobId}: recovery claimed/interrupted; remaining=0; no retry is permitted`);
	}
	if (decision.job_id !== jobId || decision.attempt !== claim.attempt) throw new Error(`${decisionPath}: mismatched recovery decision`);
	const verdict = validate<GateVerdict>(GateVerdictSchema, decision);
	if (!verdict.ok) throw new Error(`${decisionPath}: invalid recovery decision`);
	publishRecoveryFile(recoveryFile(dir, "finished"), recoveryJson({ claim_sha256: recoveryDigest(recoveryJson(claim)),
		decision_path: decisionPath, decision_sha256: recoveryDigest(readFileSync(decisionPath)) }));
	return decision;
}

export function recoveryStatus(home: string, jobId: string): GateRecoveryStatus | undefined {
	const dir = join(home, paths.runDir(jobId));
	const source = readReservation(recoveryFile(dir, "reservation"));
	const backlink = recoveryRecord<{ source_job: string }>(recoveryFile(dir, "source"));
	const target = source ?? (backlink ? readReservation(
		recoveryFile(join(home, paths.runDir(backlink.source_job)), "reservation")) : undefined);
	if (!target) return undefined;
	const parsed = validate<RecoveryReservation>(GateRecoveryReservationSchema, target);
	if (!parsed.ok) throw new Error(`${jobId}: invalid recovery reservation`);
	const targetDir = join(home, paths.runDir(target.replacement_job));
	const claimed = existsSync(recoveryFile(targetDir, "claim"));
	return { remaining: source || claimed ? 0 : 1, source_job: target.source_job, replacement_job: target.replacement_job,
		state: existsSync(recoveryFile(targetDir, "finished")) ? "finished" : claimed ? "claimed" :
			existsSync(recoveryFile(targetDir, "prepared")) ? "prepared" : "reserved" };
}

export async function claimRecovery(input: {
	home: string; jobId: string; reservation: RecoveryReservation; attempt: number; artifactPath: string;
	ready: () => Promise<void>; mandates?: MandateStore; permit: () => void;
}): Promise<{ artifact: Buffer; task: Buffer }> {
	const { home, jobId, reservation, attempt } = input;
	await input.ready();
	const current = recoveryTarget(home, jobId);
	if (!current || recoveryDigest(recoveryJson(current)) !== recoveryDigest(recoveryJson(reservation))) {
		throw new Error(`${jobId}: recovery binding changed during preflight`);
	}
	if (attempt !== reservation.attempt + 1) throw new Error(`${jobId}: recovery history changed`);
	const buffers = reservation.inputs.map((file) => {
		const bytes = readFileSync(file.target);
		if (bytes.length !== file.bytes || recoveryDigest(bytes) !== file.sha256) {
			throw new Error(`${file.target}: prepared recovery input changed`);
		}
		return bytes;
	});
	const dir = join(home, paths.runDir(jobId));
	const addenda = join(home, paths.taskAddendaFile(jobId));
	if (existsSync(addenda) !== reservation.inputs.some((file) => file.target === addenda)) {
		throw new Error(`${addenda}: recovery addenda mismatch`);
	}
	const task = readFileSync(join(dir, "revision-task.md"));
	if (!task.equals(recoveryTask(reservation, buffers, input.artifactPath))) {
		throw new Error(`${jobId}: legacy handoff mismatch; prepared recovery task changed`);
	}
	validateRecoveryAuthority(home, reservation, input.mandates);
	input.permit();
	const artifact = readFileSync(input.artifactPath);
	const claimed = publishRecoveryBytes(recoveryFile(join(home, paths.runDir(jobId)), "claim"), recoveryJson({
		reservation_sha256: recoveryDigest(recoveryJson(reservation)), replacement_job: jobId, attempt,
		artifact_sha256: recoveryDigest(artifact), artifact_bytes: artifact.length,
	}));
	if (!claimed) throw new Error(`${jobId}: recovery already claimed; remaining=0; no spawn`);
	return { artifact, task };
}

export function copyRecoveryTask(task: Buffer, scratch: string): string {
	const out = join(scratch, "original-task.md");
	writeFileSync(out, task);
	return out;
}

/** Publish a complete recovery record without replacing a competing winner. */
export function publishRecoveryBytes(path: string, bytes: Buffer): boolean {
	mkdirSync(dirname(path), { recursive: true });
	const candidate = `${path}.${randomUUID()}.candidate`;
	let fd: number | undefined;
	try {
		fd = openSync(candidate, "wx", 0o600);
		for (let offset = 0; offset < bytes.length;) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (!written) throw new Error(`${candidate}: zero-length write`);
			offset += written;
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		try {
			linkSync(candidate, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		const directory = openSync(dirname(path), "r");
		try { fsyncSync(directory); }
		catch (error) {
			const digest = recoveryDigest(readFileSync(path));
			throw new Error(`${path}: uncertain publication (${String(error)}); read-back SHA256 ${digest}`);
		} finally { closeSync(directory); }
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(candidate)) unlinkSync(candidate);
	}
}

export function recoveryDigest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function publishRecoveryFile(path: string, bytes: Buffer): void {
	if (!publishRecoveryBytes(path, bytes) && !readFileSync(path).equals(bytes)) {
		throw new Error(`${path}: immutable recovery file differs`);
	}
}

export function recoveryFile(dir: string, name: string): string {
	return join(dir, `gate-recovery-${name}.json`);
}
