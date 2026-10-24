import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GateRecoveryAttemptSchema, GateRecoveryAuthoritySchema, GateRecoveryAttemptTerminalSchema, type RecoveryAttempt, type RecoveryAuthority } from "./contracts/gate-recovery.ts";
import { paths, validate, LAYOUT, GateRecoveryClaimSchema, GateVerdictSchema, GateRecoveryAttemptClaimSchema } from "./contracts.ts";
import { publishRecoveryBytes, publishRecoveryFile, recoveryDigest, recoveryJson, recoveryRecord } from "./gate-recovery.ts";

import { readdirSync } from "node:fs";
import { recoveryTarget, recoveryFile } from "./gate-recovery.ts";
import { readTaskAddenda, taskAddendaText } from "./task-addenda.ts";
import { ParentSendOutbox } from "./parent-outbox.ts";
import { OperatorAsks } from "./operator-asks.ts";
import { requireOperatorQuote } from "./decide.ts";
import type { Ledger } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";
import { requireJobLabels } from "./ledger.ts";
import type { MandateUsageJob } from "./mandate.ts";
import { readPriorAttempts, type GateOptions } from "./gate.ts";
import { recoveryStatus } from "./gate-recovery.ts";
import { isPidAlive } from "./fleet.ts";

export interface RecoverySelectors {
	job_id: string; authority_mode: "single_use" | "standing";
	operator_control_id: string; operator_send_id: string; operator_ask_id?: string;
	reinforcement_control_id?: string; reinforcement_send_id?: string; dependent_job_ids: string[];
}

function legacyAnchor(home: string, jobId: string): RecoveryAuthority["initial_predecessor"] {
	const reservation = recoveryTarget(home, jobId);
	if (!reservation) throw new Error("standing recovery requires validated legacy replacement linkage");
	const dir = join(home, paths.runDir(jobId));
	const claimBytes = readFileSync(recoveryFile(dir, "claim"));
	const claim = JSON.parse(claimBytes.toString());
	const finished = recoveryRecord<{ claim_sha256: string; decision_sha256: string; decision_path: string }>(recoveryFile(dir, "finished"));
	const decisionPath = join(home, paths.gateFile(jobId, claim.attempt));
	const decisionBytes = readFileSync(decisionPath);
	const decision = JSON.parse(decisionBytes.toString());
	if (!validate(GateRecoveryClaimSchema, claim).ok || !validate(GateVerdictSchema, decision).ok) {
		throw new Error("invalid legacy claim or verdict schema");
	}
	if (claim.replacement_job !== jobId || claim.attempt !== reservation.attempt + 1 ||
		claim.reservation_sha256 !== recoveryDigest(recoveryJson(reservation)) ||
		finished?.claim_sha256 !== recoveryDigest(claimBytes) || finished.decision_path !== decisionPath ||
		finished.decision_sha256 !== recoveryDigest(decisionBytes) || decision.job_id !== jobId ||
		decision.attempt !== claim.attempt || decision.verdict === "pass") throw new Error("invalid legacy terminal linkage");
	if (recoveryDigest(readFileSync(join(home, paths.gateFile(reservation.source_job, reservation.attempt)))) !== reservation.decision_sha256) {
		throw new Error("legacy source verdict digest mismatch");
	}
	const history = [reservation.source_job, jobId].flatMap((id) => {
		const last = id === jobId ? claim.attempt : reservation.attempt;
		return Array.from({ length: last }, (_, index) => {
			const attempt = index + 1;
			const bytes = readFileSync(join(home, paths.gateFile(id, attempt)));
			const value = JSON.parse(bytes.toString());
			if (!validate(GateVerdictSchema, value).ok || value.job_id !== id || value.attempt !== attempt) {
				throw new Error("incomplete or mismatched legacy gate history");
			}
			return { job_id: id, attempt, sha256: recoveryDigest(bytes) };
		});
	});
	const value = { kind: "legacy_terminal" as const, root_job_id: reservation.source_job,
		source_job_id: jobId, legacy_attempt: claim.attempt as number,
		legacy_claim_sha256: recoveryDigest(claimBytes), legacy_verdict_sha256: recoveryDigest(decisionBytes),
		history_sha256: recoveryDigest(recoveryJson(history)) };
	return { ...value, anchor_id: recoveryDigest(recoveryJson(value)) };
}

function approvedRecoverySubjects(home: string, selectors: RecoverySelectors) {
	return new OperatorAsks(join(home, LAYOUT.state, "operator/asks.jsonl")).list().find((ask) =>
		(!selectors.operator_ask_id || ask.id === selectors.operator_ask_id) && ask.state === "answered" && ask.answer &&
		ask.options.some((option) => option.label === ask.answer) && ask.job_ids?.length === 3 &&
		[selectors.job_id, ...selectors.dependent_job_ids].every((id) => ask.job_ids!.includes(id)));
}
export function resolveRecoveryAuthority(input: {
	home: string; selectors: RecoverySelectors; operatorTexts: readonly string[];
	ledger: Ledger; mandates: MandateStore;
	usageJobs?: readonly MandateUsageJob[];
	readOnly?: boolean;
}): RecoveryAuthority {
	const { home, selectors: s } = input;
	const jobs = input.ledger.read().jobs;
	const job = jobs.find((entry) => entry.id === s.job_id);
	if (!input.usageJobs?.some((entry) => entry.job_id === s.job_id)) throw new Error("recovery requires retained job usage context");
	if (job && requireJobLabels(job).kind !== "research") throw new Error("recovery subject must be research");
	if (!job || s.dependent_job_ids.includes(s.job_id) || s.dependent_job_ids.length !== 2 || new Set(s.dependent_job_ids).size !== 2 ||
		s.dependent_job_ids.some((id) => !jobs.some((entry) => entry.id === id))) throw new Error("invalid recovery subjects");
	const journal = readFileSync(join(home, LAYOUT.state, "operator/dashboard.jsonl"), "utf8");
	if (!journal.endsWith("\n")) throw new Error("incomplete operator delivery journal");
	const records = journal.trimEnd().split("\n").map((line) => JSON.parse(line));
	const sends = new ParentSendOutbox({ file: join(home, LAYOUT.sessions, "cp-parent.sends.json") }).list();
	const resolve = (controlId: string, sendId: string) => {
		const selected = records.filter((record) => record.type === "request" && record.id === controlId);
		if (selected.length !== 1) throw new Error("missing or duplicate operator control");
		const control = selected[0];
		const outcome = records.filter((record) => record.type === "outcome" && record.id === controlId).at(-1);
		const send = sends.find((entry) => entry.id === sendId);
		const quoted = control.kind === "answer" ? control.text.slice(control.text.indexOf(":") + 1).trim() : control.text;
		if (control.by !== "bridge" || outcome?.state !== "delivered" || !send || send.state !== "settled" ||
			!send.settled_at || !send.text.includes(controlId) || !quoted || !send.text.includes(quoted)) {
			throw new Error("operator control/settled relay mismatch");
		}
		requireOperatorQuote(send.text, { operatorTexts: input.operatorTexts });
		if (!input.operatorTexts.some((text) => text.includes(`[cp-send ${sendId}`) && text.includes(send.text))) {
			throw new Error("relay missing from authenticated session context");
		}
		return { control, text: send.text, send_id: send.id };
	};
	const primary = resolve(s.operator_control_id, s.operator_send_id);
	let approval: unknown;
	if (s.authority_mode === "standing") {
		if (primary.control.kind !== "message" || primary.control.ask_id !== null ||
			!s.reinforcement_control_id || !s.reinforcement_send_id) throw new Error("standing recovery requires delivered message and reinforcement");
		const reinforcement = resolve(s.reinforcement_control_id, s.reinforcement_send_id);
		if (!/standing (?:authority|authorization)/i.test(primary.text) ||
			!s.dependent_job_ids.every((id) => primary.text.includes(id)) ||
			!reinforcement.text.includes(s.operator_send_id)) throw new Error("standing scope is absent from authenticated relay context");
		if (reinforcement.control.kind !== "message" || reinforcement.control.ask_id !== null) throw new Error("invalid standing reinforcement");
		approval = reinforcement;
	} else {
		const ask = new OperatorAsks(join(home, LAYOUT.state, "operator/asks.jsonl")).list().find((entry) => entry.id === s.operator_ask_id);
		if (!ask || ask.state !== "answered" || primary.control.kind !== "answer" || primary.control.ask_id !== ask.id ||
			!ask.answer || primary.control.text !== `${ask.id}: ${ask.answer}` || !primary.text.includes(ask.id) ||
			!ask.options.some((option) => option.label === ask.answer) || !ask.job_ids || ask.job_ids.length !== 3 ||
			[s.job_id, ...s.dependent_job_ids].some((id) => !ask.job_ids!.includes(id))) throw new Error("limited recovery approval mismatch");
		approval = ask;
	}
	const addenda = readTaskAddenda(home, s.job_id);
	const amendment = addenda.findLast((entry) => entry.by === "operator-quote" &&
		entry.text.includes(s.operator_control_id) && entry.text.includes(s.operator_send_id) &&
		primary.control.text.includes(entry.quote) && s.dependent_job_ids.every((id) => entry.text.includes(id)));
	if (!amendment || (s.authority_mode === "standing" && !/standing (?:authority|authorization)/i.test(amendment.text))) {
		throw new Error("missing authenticated bounded recovery scope amendment");
	}
	const subjects = approvedRecoverySubjects(home, s);
	if (!subjects || subjects.project !== requireJobLabels(job).project) throw new Error("dependent subjects differ from recorded authenticated recovery scope");
	approval = { decision: approval, subjects };
	if (!/S32[–-]S131/.test(amendment.text) || !/outstanding/i.test(amendment.text) ||
		!/missing/i.test(amendment.text) || !/retai[n]/i.test(amendment.text) || !/pass/i.test(amendment.text)) {
		throw new Error("bounded readiness safeguards missing from authenticated amendment");
	}
	const grantIds = amendment.text.match(/md-[a-f0-9]+/g) ?? [];
	const grant = grantIds.map((id) => input.mandates.get(id)).find((entry) => entry?.status === "active");
	if (!grant || grant.expiry <= new Date().toISOString()) throw new Error("recovery requires retained active grant");
	const labels = requireJobLabels(job);
	const usage = input.mandates.withReviewerSpend(input.usageJobs ?? []);
	const selection = input.mandates.selection("review", { jobId: job.id, project: labels.project, kind: "research" }, usage);
	if (selection?.grant.id !== grant.id || selection.at.standing !== "permit") {
		throw new Error("retained recovery grant does not permit this subject and current budget");
	}
	if (!input.readOnly) input.mandates.assertPermitted("review", { jobId: job.id, project: labels.project, kind: "research" }, usage);
	const initial = legacyAnchor(home, s.job_id);
	const terminal = JSON.parse(readFileSync(join(home, paths.gateFile(s.job_id, initial.legacy_attempt)), "utf8"));
	if (!Number.isFinite(Date.parse(primary.control.at)) || Date.parse(primary.control.at) < Date.parse(terminal.decided_at)) {
		throw new Error("recovery authority predates the spent legacy decision");
	}
	const dependents = [...s.dependent_job_ids].sort();
	const value: RecoveryAuthority = {
		schema_version: 2, authority_id: recoveryDigest(recoveryJson({ mode: s.authority_mode,
			human_id: s.authority_mode === "standing" ? s.operator_control_id : s.operator_ask_id })),
		authority_mode: s.authority_mode, job_id: s.job_id, dependent_job_ids: dependents,
		grant_id: grant.id, scope_sha256: recoveryDigest(recoveryJson({ amendment, dependent_job_ids: dependents, job_id: s.job_id })),
		provenance_sha256: recoveryDigest(recoveryJson({ primary, approval, amendment })), initial_predecessor: initial,
		release_scope: { recovery_job_id: s.job_id, dependent_job_ids: dependents,
			eligible_readiness_edges: dependents.flatMap((id) => {
				const dependent = jobs.find((entry) => entry.id === id)!;
				return dependent.blocked_by.includes(initial.root_job_id) ? [{ dependent_job_id: id,
					blocker_id: initial.root_job_id, reason: "Authenticated bounded A/B readiness supersedes whole-program readiness; S32–S131 remains outstanding." }] : [];
			}) }, 
	};
	return value;
}

function authorityFile(home: string, id: string): string {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid recovery authority identity");
	return join(home, LAYOUT.state, `recovery-authority-${id}.json`);
}

export function authorizeRecovery(input: Parameters<typeof resolveRecoveryAuthority>[0]) {
	const authority = resolveRecoveryAuthority(input);
	publishRecoveryFile(authorityFile(input.home, authority.authority_id), recoveryJson({
		authority, selectors: input.selectors, operatorTexts: input.operatorTexts.filter((text) =>
			text.includes(`[cp-send ${input.selectors.operator_send_id}`) ||
			(input.selectors.reinforcement_send_id && text.includes(`[cp-send ${input.selectors.reinforcement_send_id}`))),
	}));
	publishRecoveryFile(join(input.home, paths.runDir(authority.job_id), "recovery-anchor.json"), recoveryJson(authority.initial_predecessor));
	publishRecoveryFile(join(input.home, paths.runDir(authority.job_id), `recovery-authority-${authority.authority_id}.json`),
		recoveryJson({ authority_id: authority.authority_id, operator_control_id: input.selectors.operator_control_id }));
	return authority;
}

export function revalidateRecoveryAuthority(input: {
	home: string; authorityId: string; ledger: Ledger; mandates: MandateStore; usageJobs?: readonly MandateUsageJob[]; readOnly?: boolean;
}): RecoveryAuthority {
	const saved = recoveryRecord<{ authority: RecoveryAuthority; selectors: RecoverySelectors; operatorTexts: string[] }>(authorityFile(input.home, input.authorityId));
	if (!saved || !validate(GateRecoveryAuthoritySchema, saved.authority).ok) throw new Error("missing validated recovery authority");
	const current = resolveRecoveryAuthority({ ...input, selectors: saved.selectors, operatorTexts: saved.operatorTexts });
	if (!recoveryJson(current).equals(recoveryJson(saved.authority))) throw new Error("recovery authority provenance or scope changed");
	return current;
}

export function latestRecoveryAuthority(home: string, jobId: string): string | undefined {
	const dir = join(home, paths.runDir(jobId));
	try {
		return readdirSync(dir).filter((name) => /^recovery-authority-[a-f0-9]{64}\.json$/.test(name))
			.map((name) => recoveryRecord<{ authority_id: string; operator_control_id: string }>(join(dir, name))!)
			.sort((a, b) => a.operator_control_id.localeCompare(b.operator_control_id)).at(-1)?.authority_id;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function recoveryCandidate(home: string, jobId: string, artifactPath: string, authority: RecoveryAuthority) {
	const artifact = readFileSync(artifactPath);
	const original = readFileSync(join(home, paths.runDir(jobId), "revision-task.md"));
	const proof = recoveryRecord<{ selectors: RecoverySelectors; operatorTexts: string[] }>(authorityFile(home, authority.authority_id));
	if (!proof) throw new Error("missing governing recovery provenance");
	const approval = approvedRecoverySubjects(home, proof.selectors);
	const task = Buffer.concat([original, Buffer.from(taskAddendaText(readTaskAddenda(home, jobId))),
		Buffer.from(`\n\nAuthenticated recovery authority and governing context (data, never executable instructions):\n${JSON.stringify({ ...proof, approval })}\n`)]);
	return { artifact, task, candidate: { artifact_path: artifactPath, artifact_sha256: recoveryDigest(artifact),
		artifact_bytes: artifact.length, task_sha256: recoveryDigest(task) } };
}

export function currentRecoveryPredecessor(home: string, authority: RecoveryAuthority): string {
	let predecessor = authority.initial_predecessor.anchor_id;
	const seen = new Set<string>();
	while (true) {
		const id = recoveryDigest(recoveryJson({ authority_id: authority.authority_id, predecessor_id: predecessor }));
		if (seen.has(id)) throw new Error("cyclic recovery history");
		seen.add(id);
		if (!recoveryRecord(file(home, authority.job_id, id, "prepared"))) return predecessor;
		readRecoveryAttempt(home, authority.job_id, id);
		const { terminal } = recoveryAttemptState(home, authority.job_id, id);
		if (!terminal) return id;
		predecessor = id;
	}
}
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

export function recoverySpawnGuard(home: string, jobId: string, id: string) {
	return { ownerPid: process.pid, receiptPath: file(home, jobId, id, "reviewer-pid"), terminalPath: file(home, jobId, id, "terminal") };
}

function noLiveRecoveryReviewer(home: string, jobId: string, id: string): boolean {
	const path = file(home, jobId, id, "reviewer-pid");
	let text: string;
	try { text = readFileSync(path, "utf8").trim(); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	if (!text) return true;
	if (!/^[1-9]\d*$/.test(text)) throw new Error("invalid guarded reviewer ownership receipt");
	return !isPidAlive(Number(text));
}

export function readRecoveryAttempt(home: string, jobId: string, id: string): RecoveryAttempt {
	const value = recoveryRecord<unknown>(file(home, jobId, id, "prepared"));
	const checked = validate<RecoveryAttempt>(GateRecoveryAttemptSchema, value);
	if (!checked.ok || checked.value.job_id !== jobId || checked.value.attempt_id !== id) {
		throw new Error(`${jobId}: missing or invalid recovery attempt`);
	}
	if (recoveryDigest(recoveryJson({ authority_id: checked.value.authority_id, predecessor_id: checked.value.predecessor_id })) !== id) {
		throw new Error("recovery attempt predecessor identity mismatch");
	}
	return checked.value;
}

export function recoveryAttemptState(home: string, jobId: string, id: string) {
	const prepared = readRecoveryAttempt(home, jobId, id);
	const terminal = recoveryRecord<{ attempt_id: string; outcome: string; claim_sha256?: string; decision_path?: string; decision_sha256?: string }>(file(home, jobId, id, "terminal"));
	if (terminal && (!validate(GateRecoveryAttemptTerminalSchema, terminal).ok || terminal.attempt_id !== id)) {
		throw new Error("invalid recovery terminal record");
	}
	const claim = recoveryRecord<{ attempt_id: string; authority_id: string; attempt_sha256: string; gate_attempt: number; owner_pid: number; spawn_guard?: true }>(file(home, jobId, id, "claim"));
	if (claim && (!validate(GateRecoveryAttemptClaimSchema, claim).ok || claim.attempt_id !== id ||
		claim.authority_id !== prepared.authority_id || claim.attempt_sha256 !== recoveryDigest(recoveryJson(prepared)))) {
		throw new Error("invalid recovery attempt claim linkage");
	}
	if (terminal?.decision_path && (!claim || terminal.decision_path !== join(home, paths.gateFile(jobId, claim.gate_attempt)))) {
		throw new Error("recovery terminal verdict path mismatch");
	}
	if (terminal && (!claim || terminal.claim_sha256 !== recoveryDigest(readFileSync(file(home, jobId, id, "claim"))))) {
		throw new Error("recovery terminal claim linkage mismatch");
	}
	if (terminal?.decision_path && recoveryDigest(readFileSync(terminal.decision_path)) !== terminal.decision_sha256) {
		throw new Error("recovery terminal verdict linkage mismatch");
	}
	if (terminal?.decision_path) {
		const verdict = JSON.parse(readFileSync(terminal.decision_path, "utf8"));
		if (!validate(GateVerdictSchema, verdict).ok || verdict.job_id !== jobId || verdict.attempt !== claim?.gate_attempt ||
			(terminal.outcome === "pass") !== (verdict.verdict === "pass")) throw new Error("recovery terminal outcome mismatch");
	}
	return { state: terminal ? "terminal" : claim ? "claimed" : "prepared", terminal, claim, claim_available: !claim && !terminal };
}

/** One immutable successor slot belongs to each authority/predecessor pair. */
export function prepareRecoveryAttempt(input: AttemptInputs, permit: () => void): RecoveryAttempt {
	permit();
	const { home, authority, predecessorId } = input;
	const checkedAuthority = validate<RecoveryAuthority>(GateRecoveryAuthoritySchema, authority);
	if (!checkedAuthority.ok) throw new Error("invalid recovery authority");
	if (predecessorId !== authority.initial_predecessor.anchor_id) {
		const previous = readRecoveryAttempt(home, authority.job_id, predecessorId);
		const { terminal } = recoveryAttemptState(home, authority.job_id, predecessorId);
		if (previous.authority_id !== authority.authority_id || previous.root_job_id !== authority.initial_predecessor.root_job_id ||
			previous.history_sha256 !== authority.initial_predecessor.history_sha256 || terminal?.attempt_id !== predecessorId || terminal.outcome === "pass") {
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
	publishRecoveryFile(join(input.home, paths.runDir(input.jobId), `gate-${input.gateAttempt}-standing.json`),
		recoveryJson({ attempt_id: input.attemptId }));
	try {
		await input.ready();
		input.revalidate(attempt);
	}
	catch (error) {
		const invalidation = recoveryJson({ attempt_id: input.attemptId, authority_id: attempt.authority_id,
			attempt_sha256: recoveryDigest(recoveryJson(attempt)), gate_attempt: input.gateAttempt, owner_pid: process.pid });
		if (publishRecoveryBytes(file(input.home, input.jobId, input.attemptId, "claim"), invalidation)) {
			publishRecoveryFile(file(input.home, input.jobId, input.attemptId, "terminal"), recoveryJson({
				attempt_id: input.attemptId, claim_sha256: recoveryDigest(invalidation), outcome: "invalidated" }));
		}
		throw error;
	}
	const current = readRecoveryAttempt(input.home, input.jobId, input.attemptId);
	if (!recoveryJson(current).equals(recoveryJson(attempt))) throw new Error("recovery attempt changed during preflight");
	if (recoveryRecord(file(input.home, input.jobId, input.attemptId, "terminal"))) throw new Error("recovery attempt is terminal");
	const artifact = Buffer.from(attempt.artifact_base64, "base64"), task = Buffer.from(attempt.task_base64, "base64");
	if (artifact.length !== attempt.artifact_bytes || recoveryDigest(artifact) !== attempt.artifact_sha256 || recoveryDigest(task) !== attempt.task_sha256) {
		throw new Error("recovery attempt frozen input mismatch");
	}
	const claimed = publishRecoveryBytes(file(input.home, input.jobId, input.attemptId, "claim"), recoveryJson({
		attempt_id: input.attemptId, authority_id: attempt.authority_id,
		attempt_sha256: recoveryDigest(recoveryJson(attempt)), gate_attempt: input.gateAttempt, owner_pid: process.pid, spawn_guard: true,
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

type RecoveryContext = Pick<import("./command-post.ts").CommandPost,
	"home" | "ledger" | "mandates" | "fleet" | "artifacts" | "reviewRuns">;
export interface PrepareAttemptRequest {
	job_id: string; recovery_authority_id: string; expected_previous_attempt_id: string;
	current_artifact_sha256: string; dependent_job_ids: string[];
}
function checkedAuthority(post: RecoveryContext, authorityId: string, readOnly = false) {
	return revalidateRecoveryAuthority({ home: post.home, authorityId, ledger: post.ledger(),
		mandates: post.mandates, usageJobs: post.fleet.list(), readOnly });
}
function graphDigest(post: RecoveryContext, authority: RecoveryAuthority): string {
	return recoveryDigest(recoveryJson(post.ledger().read().jobs.filter((job) => authority.dependent_job_ids.includes(job.id))
		.map((job) => ({ id: job.id, status: job.status, blocked_by: job.blocked_by }))));
}
export function authorizeRecoveryControl(post: RecoveryContext, selectors: RecoverySelectors, operatorTexts: readonly string[]) {
	if (post.reviewRuns.pending(selectors.job_id, "gate")) throw new Error("recovery reviewer is active");
	const authority = authorizeRecovery({ home: post.home, selectors, operatorTexts, ledger: post.ledger(),
		mandates: post.mandates, usageJobs: post.fleet.list() });
	return { ...authority, standing_authority_id: authority.authority_id, eligibility: "eligible",
		candidate: recoveryCandidate(post.home, selectors.job_id, post.artifacts.file(selectors.job_id), authority).candidate,
		current_predecessor_id: currentRecoveryPredecessor(post.home, authority) };
}
export function standingRecoveryStatus(post: RecoveryContext, jobId: string) {
	const authorityId = latestRecoveryAuthority(post.home, jobId);
	if (!authorityId) return undefined;
	try {
		const authority = checkedAuthority(post, authorityId, true);
		const predecessor = currentRecoveryPredecessor(post.home, authority);
		const state = predecessor === authority.initial_predecessor.anchor_id ? undefined : recoveryAttemptState(post.home, jobId, predecessor);
		const candidate = recoveryCandidate(post.home, jobId, post.artifacts.file(jobId), authority).candidate;
		if (state?.terminal?.outcome === "pass") {
			const reviewed = readRecoveryAttempt(post.home, jobId, predecessor);
			if (candidate.artifact_sha256 !== reviewed.artifact_sha256 || candidate.task_sha256 !== reviewed.task_sha256 ||
				graphDigest(post, authority) !== reviewed.graph_sha256) throw new Error("PASS release binding changed");
		}
		return { authority_id: authorityId, authority_mode: authority.authority_mode,
			eligibility: state?.terminal?.outcome === "pass" ? "completed" : "eligible",
			current_predecessor_id: predecessor, candidate, release_scope: state?.terminal?.outcome === "pass" ? authority.release_scope : undefined,
			...(state ?? {}) };
	} catch (error) {
		return { authority_id: authorityId, eligibility: "ineligible", reason: String(error) };
	}
}
export function prepareAttemptControl(post: RecoveryContext, input: PrepareAttemptRequest) {
	if (post.reviewRuns.pending(input.job_id, "gate")) throw new Error("recovery reviewer is active");
	const authority = checkedAuthority(post, input.recovery_authority_id);
	if (authority.job_id !== input.job_id || JSON.stringify([...input.dependent_job_ids].sort()) !== JSON.stringify(authority.dependent_job_ids)) {
		throw new Error("recovery attempt subject mismatch");
	}
	const captured = recoveryCandidate(post.home, input.job_id, post.artifacts.file(input.job_id), authority);
	if (captured.candidate.artifact_sha256 !== input.current_artifact_sha256) throw new Error("recovery candidate digest mismatch");
	if (input.expected_previous_attempt_id !== authority.initial_predecessor.anchor_id) {
		const previous = readRecoveryAttempt(post.home, input.job_id, input.expected_previous_attempt_id);
		if (previous.authority_id !== authority.authority_id) throw new Error("recovery predecessor authority mismatch");
		const state = recoveryAttemptState(post.home, input.job_id, previous.attempt_id);
		if (state.claim && !state.terminal) recoverStandingFinalization(post.home, input.job_id, state.claim.gate_attempt);
	}
	const attempt = prepareRecoveryAttempt({ home: post.home, authority, predecessorId: input.expected_previous_attempt_id,
		artifact: captured.artifact, task: captured.task, historySha256: authority.initial_predecessor.history_sha256,
		graphSha256: graphDigest(post, authority) }, () => {});
	return { ...attempt, claim_available: recoveryAttemptState(post.home, input.job_id, attempt.attempt_id).claim_available };
}
export function recoveryGateRequest(post: RecoveryContext, request: import("./gate.ts").GateRequest): import("./gate.ts").GateRequest {
	if (!request.recoveryAttemptId) return request;
	const selected = readRecoveryAttempt(post.home, request.jobId, request.recoveryAttemptId);
	return { ...request, revalidateRecovery: (attempt) => {
		const authority = checkedAuthority(post, selected.authority_id);
		const captured = recoveryCandidate(post.home, request.jobId, post.artifacts.file(request.jobId), authority);
		if (authority.job_id !== request.jobId || captured.candidate.artifact_sha256 !== attempt.artifact_sha256 ||
			captured.candidate.task_sha256 !== attempt.task_sha256 || graphDigest(post, authority) !== attempt.graph_sha256) {
			throw new Error("recovery frozen candidate or dependency graph changed");
		}
	} };
}

export function nextRecoveryGateOrdinal(home: string, jobId: string, initial: number) {
	return readdirSync(join(home, paths.runDir(jobId))).reduce((next, name) => {
		const match = /^gate-(\d+)-standing\.json$/.exec(name);
		return match ? Math.max(next, Number(match[1]) + 1) : next;
	}, initial);
}

export function recoverStandingFinalization(home: string, jobId: string, ordinal: number): "pending" | "decided" | undefined {
	const binding = recoveryRecord<{ attempt_id: string }>(join(home, paths.runDir(jobId), `gate-${ordinal}-standing.json`));
	if (!binding) return undefined;
	const state = recoveryAttemptState(home, jobId, binding.attempt_id);
	if (state.terminal) return "decided";
	if (state.claim?.gate_attempt !== ordinal) throw new Error("standing recovery ordinal claim mismatch");
	const decisionPath = join(home, paths.gateFile(jobId, ordinal));
	if (existsSync(decisionPath)) {
		const verdict = JSON.parse(readFileSync(decisionPath, "utf8"));
		if (!validate(GateVerdictSchema, verdict).ok || verdict.job_id !== jobId || verdict.attempt !== ordinal) {
			throw new Error("standing recovery has an invalid persisted decision");
		}
		finishRecoveryAttempt({ home, jobId, attemptId: binding.attempt_id, decisionPath,
			outcome: verdict.verdict === "pass" ? "pass" : verdict.cause === "operational" ? "interrupted" : "nonpass" });
		return "decided";
	}
	// The guard records its PID before checking ownership, so a late launcher cannot exec after owner death.
	if (!isPidAlive(state.claim.owner_pid) && (state.claim.spawn_guard
		? noLiveRecoveryReviewer(home, jobId, binding.attempt_id) : !existsSync(join(home, paths.gateRunDir(jobId, ordinal))))) {
		finishRecoveryAttempt({ home, jobId, attemptId: binding.attempt_id, outcome: "interrupted" });
		return "decided";
	}
	return "pending";
}

export function gateRecoveryStatus(options: Pick<GateOptions, "home" | "reviews" | "standingRecoveryStatus">, jobId: string) {
	const pending = options.reviews?.pending(jobId, "gate");
	const recovery = recoveryStatus(options.home, jobId);
	const standing = options.standingRecoveryStatus?.(jobId);
	const decisions = readPriorAttempts(options.home, jobId).decisions;
	const dir = join(options.home, paths.runDir(jobId));
	for (const name of existsSync(dir) ? readdirSync(dir) : []) {
		const match = /^gate-(\d+)-standing\.json$/.exec(name);
		if (!match || decisions.some((decision) => decision.attempt === Number(match[1]))) continue;
		const path = join(options.home, paths.gateFile(jobId, Number(match[1])));
		if (!existsSync(path)) continue;
		const parsed = validate<import("./contracts.ts").GateVerdict>(GateVerdictSchema, JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.ok) throw new Error("invalid standing gate verdict");
		decisions.push(parsed.value);
	}
	decisions.sort((a, b) => a.attempt - b.attempt);
	return { ...(pending ? { pending } : {}), decisions,
		...(recovery ? { recovery } : {}), ...(standing ? { standing_recovery: standing } : {}) };
}

export function validateGateRecoveryFinalization(home: string, jobId: string, attempt: number) {
	const standing = recoveryRecord<{ attempt_id: string }>(join(home, paths.runDir(jobId), `gate-${attempt}-standing.json`));
	const recovery = standing ? undefined : recoveryTarget(home, jobId);
	if (standing && recoveryAttemptState(home, jobId, standing.attempt_id).claim?.gate_attempt !== attempt) {
		throw new Error("refusing unclaimed standing recovery finalization");
	}
	if (recovery) {
		const claim = recoveryRecord<import("./contracts.ts").RecoveryClaim>(recoveryFile(join(home, paths.runDir(jobId)), "claim"));
		if (!claim || claim.attempt !== attempt || claim.reservation_sha256 !== recoveryDigest(recoveryJson(recovery))) {
			throw new Error(`${jobId}: refusing unclaimed recovery finalization`);
		}
	}
	return { standing, recovery };
}
