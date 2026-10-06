/**
 * cp_decide — answer a checkpoint or Awaiting-you row by citing authority.
 *
 * The tool does not trust the caller's claim: a mandate basis is re-evaluated
 * against the store; an operator quote must be a verbatim substring of a user
 * message in this session. Worker text, envelope text and tool results are
 * never a valid basis.
 */
import { authorizationVerdict, type ResolvedAwaitingItem } from "./awaiting.ts";
import { CheckpointStore } from "./checkpoint.ts";
import {
	checkpointAwaitingId,
	type Checkpoint,
	type CheckpointKind,
	type DecisionBasis,
	type DelegationProvenance,
	type Escalation,
	isSafeJobId,
	parseCheckpointAwaitingId,
} from "./contracts.ts";
import { missionEndCloses } from "./escalation.ts";
import {
	evaluateAuthority,
	type MandateStore,
	type MandateSubject,
	type MandateUsageJob,
} from "./mandate.ts";
import { operatorSendTexts, stripSendMarkers } from "./parent-outbox.ts";

export class DecideError extends Error {}

export type DecideTarget =
	| { kind: "authorization"; jobId: string; checkpointKind: CheckpointKind; scope?: string }
	| { kind: "awaiting"; item: ResolvedAwaitingItem };

export interface DecideInput {
	target: string;
	decision: string;
	basis: DecisionBasis;
	kind?: CheckpointKind;
	scope?: string;
	note?: string;
}

export interface DecideJob {
	project: string;
	jobKind?: MandateSubject["jobKind"];
	risk?: MandateSubject["risk"];
	text?: string;
	pathHints?: string[];
}

export interface DecideDeps {
	items: readonly ResolvedAwaitingItem[];
	ship: CheckpointStore;
	diff: CheckpointStore;
	merge: CheckpointStore;
	/** jje.3: the one final fix at the review cap; absent refuses that kind. */
	finalFix?: CheckpointStore;
	answerDeclared: (
		item: ResolvedAwaitingItem,
		answer: string,
		by: string,
		basis: DecisionBasis,
		provenance?: DelegationProvenance,
	) => Promise<unknown>;
	mandates: MandateStore;
	lookupJob: (jobId: string) => DecideJob | undefined;
	usageJobs: () => readonly MandateUsageJob[];
	operatorTexts: readonly string[];
	/** Answers a structured escalation (`es-\u2026`) directly \u2014 EscalationStore owns it, never `answerDeclared`. */
	answerEscalation?: (id: string, answer: string, by: string, basis: DecisionBasis, provenance?: DelegationProvenance) => Promise<unknown>;
	/** Reads a structured escalation by id: a mission-end close revokes its grant, and a non-open id is refused by its own store. */
	getEscalation?: (id: string) => Escalation | undefined;
}

export interface DecideResult {
	text: string;
	decided_by: string;
	basis: DecisionBasis;
	checkpoint?: Checkpoint;
}

export function operatorTextsFromEntries(entries: readonly unknown[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (rec.type !== "message") continue;
		if (rec.message?.role !== "user") continue;
		const text = contentText(rec.message.content);
		if (text.length > 0) out.push(text);
	}
	return out;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (part && typeof part === "object" && "text" in part) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

export function resolveDecideTarget(
	input: Pick<DecideInput, "target" | "kind" | "scope">,
	items: readonly ResolvedAwaitingItem[],
): DecideTarget {
	const target = input.target.trim();
	const parsed = parseCheckpointAwaitingId(target);
	if (parsed) {
		return {
			kind: "authorization",
			jobId: parsed.job_id,
			checkpointKind: parsed.kind,
			...(parsed.scope ? { scope: parsed.scope } : {}),
		};
	}
	const item = items.find((entry) => entry.id === target);
	if (item) {
		if (item.type === "authorization") {
			return {
				kind: "authorization",
				jobId: item.job_id ?? target,
				checkpointKind: item.checkpoint_kind ?? "ship",
				...(item.checkpoint_scope ? { scope: item.checkpoint_scope } : {}),
			};
		}
		return { kind: "awaiting", item };
	}
	if (isSafeJobId(target)) {
		const checkpointKind = input.kind ?? "ship";
		return {
			kind: "authorization",
			jobId: target,
			checkpointKind,
			...(input.scope ? { scope: input.scope } : {}),
		};
	}
	throw new DecideError(`no open decision ${target}`);
}

function storeFor(deps: DecideDeps, kind: CheckpointKind): CheckpointStore {
	if (kind === "diff") return deps.diff;
	if (kind === "merge") return deps.merge;
	if (kind === "final_fix") {
		if (!deps.finalFix) throw new DecideError("final_fix checkpoints are not wired on this surface");
		return deps.finalFix;
	}
	return deps.ship;
}

/**
 * Shared by the checkpoint/awaiting operator-quote path and the escalation one
 * below. Returns the quote as recorded: the bridge's `[cp-send <id> ...]` lines
 * (`stripSendMarkers`) are removed from the quote and from each operator text
 * before matching, so they never reach a decision. A short reply ("yes",
 * "approve") is valid: it must still occur verbatim in a user message.
 */
export function requireOperatorQuote(quote: string, deps: Pick<DecideDeps, "operatorTexts">): { decidedBy: "operator-quote" | "operator-delegated"; stored: { operator_quote: string }; provenance?: DelegationProvenance; source: string } {
	const clean = stripSendMarkers(quote);
	if (clean.length === 0) {
		throw new DecideError("quote is empty");
	}
	// The latest matching send owns the quote; caller-supplied markers never select attribution.
	const source = deps.operatorTexts.flatMap(operatorSendTexts).findLast((entry) => entry.text.includes(clean));
	if (!source) throw new DecideError("quote not found in operator messages; a cp_decide quote must be one complete operator sentence, verbatim, ending with punctuation");
	return {
		decidedBy: source.provenance ? "operator-delegated" : "operator-quote",
		stored: { operator_quote: clean },
		...(source.provenance ? { provenance: source.provenance } : {}),
		source: source.text,
	};
}

function refusalFor(reason: string, project: string): string {
	if (/risk:high/.test(reason)) return "risk:high requires operator text";
	if (reason.startsWith("no active mandate covers ")) return `no active mandate covers project ${project} (job ${reason.slice("no active mandate covers ".length)})`;
	if (/ask_on includes merge/.test(reason)) return "merge requires operator text";
	return reason;
}

function validateBasis(
	basis: DecisionBasis,
	subject: MandateSubject,
	deps: DecideDeps,
	checkpointKind: CheckpointKind,
): { decidedBy: string; stored: DecisionBasis; provenance?: DelegationProvenance } {
	if ("operator_quote" in basis) {
		return requireOperatorQuote(basis.operator_quote, deps);
	}
	if (checkpointKind === "final_fix") throw new DecideError("a final fix at the review cap requires operator text");
	if (checkpointKind === "merge") {
		const askOnMerge = deps.mandates
			.list()
			.some((mandate) => mandate.id === basis.mandate && mandate.ask_on.includes("merge"));
		if (askOnMerge) throw new DecideError("merge requires operator text");
	}
	const jobs = deps.mandates.withReviewerSpend(deps.usageJobs());
	deps.mandates.sweep(subject.now, jobs);
	const verdict = evaluateAuthority({ ...subject, createdAt: deps.mandates.jobCreatedAt(subject.jobId), usageJobs: jobs }, deps.mandates.list());
	if (!verdict.permitted) {
		throw new DecideError(refusalFor(verdict.reason, subject.project));
	}
	if (verdict.mandateId !== basis.mandate) {
		throw new DecideError(`no active mandate covers project ${subject.project}`);
	}
	return {
		decidedBy: `mandate:${verdict.mandateId}`,
		stored: { mandate: verdict.mandateId, clause: verdict.clause },
	};
}

function subjectFor(jobId: string, checkpointKind: CheckpointKind, deps: DecideDeps): MandateSubject {
	const job = deps.lookupJob(jobId);
	const project = job?.project;
	if (!project) throw new DecideError(`no active mandate covers project (job ${jobId} is unknown)`);
	return {
		kind: checkpointKind,
		jobId,
		project,
		...(job.jobKind ? { jobKind: job.jobKind } : {}),
		...(job.risk ? { risk: job.risk } : {}),
		...(job.text ? { text: job.text } : {}),
		...(job.pathHints ? { pathHints: job.pathHints } : {}),
		...deps.mandates.scheduleOf(jobId),
		usageJobs: deps.usageJobs(),
	};
}

/**
 * A structured escalation (risk_high_irreversible and the rest) is never a checkpoint or a declared row:
 * EscalationStore is the one writer, and a pre-dispatch job (the risk-high gate's own case) may have no fleet
 * or pipeline record yet for subjectFor to find. An operator quote is proof enough on its own; a mandate basis
 * never auto-permits risk:high anyway. A mission-end `close` then revokes that grant alone; the answer is
 * journaled first and a repeated identical call re-runs the idempotent revoke, so a partial write converges.
 */
async function decideEscalation(id: string, input: DecideInput, deps: DecideDeps): Promise<DecideResult> {
	if (!("operator_quote" in input.basis)) {
		throw new DecideError(`${id} is an escalation: answer it with an operator quote`);
	}
	const verified = requireOperatorQuote(input.basis.operator_quote, deps);
	// N3: the message the quote came from must name this escalation; a mandate brief or another id's answer is not consent to it.
	if (!verified.source.includes(id)) {
		throw new DecideError(`${id}: the operator message containing that quote does not name ${id}; relay the escalation and quote the operator's reply to it`);
	}
	if (!deps.answerEscalation) {
		throw new DecideError(`${id} is an escalation: wire answerEscalation on the writers`);
	}
	await deps.answerEscalation(id, input.decision, verified.decidedBy, verified.stored, verified.provenance);
	const record = deps.getEscalation?.(id);
	let revoked = "";
	if (record?.status === "answered" && missionEndCloses(record, record.answer ?? "")) {
		const grant = deps.mandates.list().find((mandate) => mandate.id === record.mandate_id);
		if (grant) {
			// The operator's verified close: recorded as their revoke.
			deps.mandates.revoke(grant.id, { by: "operator", ...verified.stored, decided_by: verified.decidedBy, ...(verified.provenance ?? {}) });
			revoked = `; ${grant.id} revoked`;
		}
	}
	return {
		text: `${id} answered: ${input.decision} by ${verified.decidedBy}${revoked}`,
		decided_by: verified.decidedBy,
		basis: verified.stored,
	};
}

export async function decide(input: DecideInput, deps: DecideDeps): Promise<DecideResult> {
	// An escalation that is no longer open is not an Awaiting row, but it is still that escalation: its store
	// refuses it (withdrawn, superseded, a different answer) or, for the same answer, retries what followed.
	const target = input.target.trim();
	const settled = target.startsWith("es-") ? deps.getEscalation?.(target) : undefined;
	if (settled && settled.status !== "open") return decideEscalation(settled.id, input, deps);
	const resolved = resolveDecideTarget(input, deps.items);
	if (resolved.kind === "authorization") {
		const store = storeFor(deps, resolved.checkpointKind);
		const existing = store.get(resolved.jobId, resolved.scope ? { scope: resolved.scope } : {});
		if (existing && existing.decision !== "pending") {
			throw new DecideError(
				`checkpoint for ${resolved.jobId} is already ${existing.decision} (by ${existing.decided_by ?? "?"} at ${existing.decided_at ?? "?"}). ` +
					"An authorization is given once; open a new job if the decision changed.",
			);
		}
		const verdict = authorizationVerdict(input.decision);
		if (!verdict) throw new DecideError("decision must be approve or decline");
		const subject =
			"operator_quote" in input.basis
				? {
						kind: resolved.checkpointKind,
						jobId: resolved.jobId,
						project: deps.lookupJob(resolved.jobId)?.project ?? "unknown",
				  }
				: subjectFor(resolved.jobId, resolved.checkpointKind, deps);
		if (subject.risk === "high" && "mandate" in input.basis) {
			const jobs = deps.mandates.withReviewerSpend(deps.usageJobs());
			deps.mandates.sweep(subject.now, jobs);
			const authority = evaluateAuthority({ ...subject, createdAt: deps.mandates.jobCreatedAt(subject.jobId), usageJobs: jobs }, deps.mandates.list());
			if (!authority.permitted) throw new DecideError("risk:high requires operator text");
		}
		const validated = validateBasis(input.basis, subject, deps, resolved.checkpointKind);
		const checkpoint = store.decide(resolved.jobId, verdict === "approve", {
			by: validated.decidedBy,
			basis: validated.stored,
			...(validated.provenance ? { provenance: validated.provenance } : {}),
			...(input.note
				? { note: input.note }
				: "clause" in validated.stored
					? { note: validated.stored.clause }
					: {}),
			...(resolved.scope ? { scope: resolved.scope } : {}),
		});
		if ("mandate" in validated.stored) {
			deps.mandates.journal(validated.stored.mandate, {
				at: checkpoint.decided_at ?? new Date().toISOString(),
				job_id: resolved.jobId,
				kind: resolved.checkpointKind,
				clause: validated.stored.clause,
				checkpoint: checkpointAwaitingId(resolved.jobId, resolved.checkpointKind, resolved.scope),
			});
		}
		return {
			text: `${checkpoint.job_id}: ${checkpoint.decision} by ${checkpoint.decided_by}${checkpoint.note ? ` (${checkpoint.note})` : ""}`,
			decided_by: validated.decidedBy,
			basis: validated.stored,
			checkpoint,
		};
	}
	if (resolved.item.type === "escalation") return decideEscalation(resolved.item.id, input, deps);
	const jobId = resolved.item.job_id;
	const subject: MandateSubject = jobId
		? subjectFor(jobId, "ship", deps)
		: { kind: "ship", jobId: "cp-none", project: "(none)" };
	if (!jobId && "mandate" in input.basis) {
		throw new DecideError("no active mandate covers project (none)");
	}
	const validated = validateBasis(input.basis, subject, deps, "ship");
	await deps.answerDeclared(resolved.item, input.decision, validated.decidedBy, validated.stored, validated.provenance);
	return {
		text: `${resolved.item.id} answered: ${input.decision} by ${validated.decidedBy}`,
		decided_by: validated.decidedBy,
		basis: validated.stored,
	};
}
