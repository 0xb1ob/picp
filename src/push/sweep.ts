/**
 * The Web Push sweep (Pier 1.1): push the operator for exactly two things (`PUSH_RULE`) and nothing else —
 *  - **mandate complete**: once per mandate id, when its mission_end escalation is raised (the one trigger; answered
 *    or not, it is informational and asks nothing);
 *  - **decision needed**: something waits on the human specifically — an open operator ask (`state/operator/asks.jsonl`,
 *    written by the main session), a human-only escalation (`PUSH_ESCALATION_KINDS`), a pending final_fix checkpoint,
 *    or an open merge-ask row (per-head human authorization).
 * Kinds the main session may decide under delegation (plan_approval, conflicting_acceptance, …) reach the human only
 * through an operator ask.
 *
 * It reads the durable ask records the raise paths already write rather than hooking a raise path: the record is the
 * queue, so a crash between a raise and a push loses nothing, code raised through a fresh store is seen too, and the
 * fleet-critical raise paths stay untouched. The ledger (`./deliveries.ts`) makes it once per id; everything that fails
 * is recorded, logged in one line, and retried a bounded number of times. This function never throws for a push outage.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AwaitingItem, Checkpoint, Escalation, EscalationKind } from "../contracts.ts";
import { checkpointAwaitingId, isoTimestamp } from "../contracts.ts";
import { isMergeAsk } from "../merge-ask.ts";
import { type OperatorAsk, OperatorAsks } from "../operator-asks.ts";
import { UNKNOWN_PROJECT } from "../project-report.ts";
import { listSubscriptions, pushDataDir, pushServiceAllowed, type StoredSubscription, subscriptionFile } from "../viewer/push-files.ts";
import { PUSH_LAST_ERROR_MAX_CHARS, PUSH_MAX_ATTEMPTS, type PushLedger, PushDeliveryStore, type PushRecord, pushBackoffSeconds, pushRecordKey } from "./deliveries.ts";
import { readVapidKeys, type VapidKeys } from "./keys.ts";
import { deliver, encryptPayload, type PushFetch, type PushOutcome, vapidAuthorization } from "./webpush.ts";

/** Escalation kinds only the operator's own words can close, even while the main session is down: pushed directly. */
export const PUSH_ESCALATION_KINDS: readonly EscalationKind[] = ["risk_high_irreversible", "budget_exhausted", "merge_refused"];
/** The active rule, one line, for `/doctor` and `/api/push`. */
export const PUSH_RULE =
	"pushes only: mandate complete (on mission end), decision needed (open operator asks, risk:high, budget, merge refused, final fix, merge asks); health (cp-health, once per failure/recovery)";
export const PUSH_MAX_RECORDS_PER_SWEEP = 10;
export const PUSH_HEADLINE_MAX_CHARS = 100;
const PUSH_PROJECT_MAX_CHARS = 80;
/** `Integrator.#remind` raises merge_refused *and* declares this row; the escalation is the one pushed. */
const MERGE_PENDING_PREFIX = "merge-pending ";

export interface PushCandidate {
	id: string;
	source: PushRecord["source"];
	kind: string;
	text: string;
	job_ids: string[];
	mandate_id?: string;
	/** An operator ask names its own project. */
	project?: string;
	/** An operator ask raised for this escalation. */
	source_escalation?: string;
}

export interface PushCandidateInput {
	/** Open escalations. */
	escalations: readonly Escalation[];
	/** Every mission_end escalation, whatever its status. */
	missionEnds?: readonly Escalation[];
	awaiting: readonly AwaitingItem[];
	asks?: readonly OperatorAsk[];
	finalFix?: readonly Checkpoint[];
}

/** `raiseMissionEnd` words it `<id>: every job it names is closed — landed N, dropped M, cost $X`. */
const missionSummary = (question: string): string => {
	const at = question.indexOf(" — ");
	return at < 0 ? question : question.slice(at + 3).replace(/\bcost \$/, "$");
};

export function pushCandidates(input: PushCandidateInput): PushCandidate[] {
	const out: PushCandidate[] = [];
	const mandates = new Set<string>();
	for (const item of [...(input.missionEnds ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
		if (item.kind !== "mission_end" || !item.mandate_id || mandates.has(item.mandate_id)) continue;
		mandates.add(item.mandate_id);
		out.push({ id: item.mandate_id, source: "mandate", kind: "mission_end", text: `${item.mandate_id} complete: ${missionSummary(item.question)}`, job_ids: item.job_ids, mandate_id: item.mandate_id });
	}
	const pushedEscalations = new Set<string>();
	for (const item of input.escalations) {
		if (item.status !== "open" || !PUSH_ESCALATION_KINDS.includes(item.kind)) continue;
		pushedEscalations.add(item.id);
		out.push({ id: item.id, source: "escalation", kind: item.kind, text: item.question, job_ids: item.job_ids, ...(item.mandate_id ? { mandate_id: item.mandate_id } : {}) });
	}
	for (const ask of input.asks ?? []) {
		if (ask.state !== "open" || (ask.source_escalation && pushedEscalations.has(ask.source_escalation))) continue;
		out.push({
			id: ask.id,
			source: "ask",
			kind: "operator_ask",
			text: ask.question,
			job_ids: ask.job_ids ?? [],
			project: ask.project,
			...(ask.source_escalation ? { source_escalation: ask.source_escalation } : {}),
		});
	}
	for (const checkpoint of input.finalFix ?? []) {
		if (checkpoint.decision !== "pending") continue;
		const text = `one final fix for ${checkpoint.job_id} at capped head ${(checkpoint.scope ?? "?").slice(0, 12)}? (operator text only)`;
		out.push({ id: checkpointAwaitingId(checkpoint.job_id, "final_fix", checkpoint.scope), source: "checkpoint", kind: "final_fix", text, job_ids: [checkpoint.job_id] });
	}
	for (const row of input.awaiting) {
		if (row.state !== "open" || row.subject?.startsWith(MERGE_PENDING_PREFIX)) continue;
		if (!isMergeAsk({ type: row.type, decision: row.decision, ...(row.subject ? { subject: row.subject } : {}), ...(row.job_id ? { job_id: row.job_id } : {}) })) continue;
		out.push({ id: row.id, source: "merge_ask", kind: "merge_ask", text: row.decision, job_ids: row.job_id ? [row.job_id] : [] });
	}
	return out;
}

const clip = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Exactly `{project, kind, headline}` — never ids, options, evidence, plans or artifact text. */
export function pushPayload(candidate: PushCandidate, projects: readonly string[]): string {
	const project = clip(projects.join(", "), PUSH_PROJECT_MAX_CHARS) || UNKNOWN_PROJECT;
	const detail = candidate.source === "merge_ask" ? "merge ask" : candidate.source === "ask" ? "" : candidate.kind.replace(/_/g, " ");
	const kind = candidate.source === "mandate" ? "mandate complete" : detail ? `decision needed: ${detail}` : "decision needed";
	return JSON.stringify({ project, kind, headline: clip(candidate.text, PUSH_HEADLINE_MAX_CHARS) });
}

export interface PushSweepPorts {
	stateDir: string;
	/** Default: the `data/` beside `stateDir`. */
	dataDir?: string;
	openEscalations(): readonly Escalation[];
	/** Every mission_end escalation, whatever its status: the mandate-complete trigger. */
	missionEnds(): readonly Escalation[];
	openAwaiting(): readonly AwaitingItem[];
	/** Pending final_fix checkpoints. */
	pendingFinalFix(): readonly Checkpoint[];
	/** Default: the open asks in `<stateDir>/operator/asks.jsonl`. */
	openAsks?(): readonly OperatorAsk[];
	projectsOf(candidate: PushCandidate): readonly string[];
	fetch?: PushFetch;
	now?: () => Date;
	log?: (line: string) => void;
}

export interface PushSweepReport {
	configured: boolean;
	error?: string;
	baseline?: number;
	enqueued: number;
	skipped: number;
	sent: number;
	failed: number;
	retrying: number;
}

const emptyReport = (configured: boolean, error?: string): PushSweepReport => ({ configured, ...(error ? { error } : {}), enqueued: 0, skipped: 0, sent: 0, failed: 0, retrying: 0 });

export async function runPushSweep(ports: PushSweepPorts): Promise<PushSweepReport> {
	const log = ports.log ?? (() => {});
	const now = (ports.now ?? (() => new Date()))();
	const dataDir = ports.dataDir ?? pushDataDir(ports.stateDir);
	let keys: VapidKeys | undefined;
	try {
		keys = readVapidKeys(dataDir);
	} catch (error) {
		const message = `push not sent: ${(error as Error).message}`;
		log(message);
		return emptyReport(true, message);
	}
	if (!keys) return emptyReport(false);
	let candidates: PushCandidate[];
	try {
		candidates = pushCandidates({
			escalations: ports.openEscalations(),
			missionEnds: ports.missionEnds(),
			awaiting: ports.openAwaiting(),
			asks: ports.openAsks ? ports.openAsks() : new OperatorAsks(join(ports.stateDir, "operator", "asks.jsonl")).open(),
			finalFix: ports.pendingFinalFix(),
		});
	} catch (error) {
		const message = `push sweep cannot read the ask records: ${(error as Error).message}`;
		log(message);
		return emptyReport(true, message);
	}
	const store = new PushDeliveryStore(ports.stateDir);
	return store.locked(async () => {
		const report = emptyReport(true);
		let ledger: PushLedger | undefined;
		try {
			ledger = store.read();
		} catch (error) {
			const message = `push not sent: ${(error as Error).message}`;
			log(message);
			return { ...report, error: message };
		}
		const at = isoTimestamp(now);
		const byKey = new Map(candidates.map((candidate) => [pushRecordKey(candidate), candidate]));
		const open = new Set(byKey.keys());
		const skip = (record: PushRecord, reason: string): void => {
			record.status = "skipped";
			record.last_error = reason;
			record.settled_at = at;
			delete record.next_attempt_at;
			delete record.targets;
			report.skipped += 1;
		};
		const fresh = (candidate: PushCandidate): PushRecord => ({ id: candidate.id, source: candidate.source, kind: candidate.kind, status: "pending", attempts: 0, delivered: 0, created_at: at });
		if (!ledger) {
			// First sweep with push set up: what is already open was never promised a push.
			const items = candidates.map((candidate) => {
				const record = fresh(candidate);
				skip(record, "open before push was enabled");
				return record;
			});
			store.write({ schema_version: 1, baseline_at: at, rule_baseline_at: at, items }, open);
			return { ...report, baseline: items.length };
		}
		const subscriptions = listSubscriptions(dataDir).items;
		const known = new Set(ledger.items.map(pushRecordKey));
		const bySourceKey = new Map(ledger.items.map((item) => [pushRecordKey(item), item]));
		// First sweep under the current rule: what its sources hold now was never promised a push (not replayed).
		const ruleBaseline = !ledger.rule_baseline_at;
		if (ruleBaseline) ledger.rule_baseline_at = at;
		for (const candidate of candidates) {
			if (known.has(pushRecordKey(candidate))) continue;
			const record = fresh(candidate);
			const sourced = candidate.source_escalation ? bySourceKey.get(pushRecordKey({ source: "escalation", id: candidate.source_escalation })) : undefined;
			if (ruleBaseline) skip(record, "open before the push rule changed");
			else if (sourced && (sourced.status === "sent" || sourced.status === "pending")) skip(record, "its escalation was already pushed");
			else if (subscriptions.length === 0) skip(record, "no subscribed device");
			else report.enqueued += 1;
			ledger.items.push(record);
		}
		const due = ledger.items
			.filter((item) => item.status === "pending" && (!item.next_attempt_at || Date.parse(item.next_attempt_at) <= now.getTime()))
			.sort((a, b) => a.created_at.localeCompare(b.created_at))
			.slice(0, PUSH_MAX_RECORDS_PER_SWEEP);
		// Durable before any network call: an enqueue or a skip is never lost to a hung push service. An idle
		// sweep writes nothing.
		if (ruleBaseline || ledger.items.length > known.size) store.write(ledger, open);
		const authorizations = new Map<string, string>();
		// One JWT per push-service origin per sweep. Only allowlisted (so parseable) endpoints reach here, and sendOne
		// turns any throw into a rejected outcome.
		const authorizationFor = (endpoint: string): string => {
			let origin: string;
			try {
				origin = new URL(endpoint).origin;
			} catch {
				throw new Error("endpoint is not a URL");
			}
			let value = authorizations.get(origin);
			if (!value) authorizations.set(origin, (value = vapidAuthorization({ endpoint, keys: keys as VapidKeys, now })));
			return value;
		};
		const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
		for (const record of due) {
			const candidate = byKey.get(pushRecordKey(record));
			if (!candidate) {
				skip(record, "no longer open before delivery");
				continue;
			}
			const targets = (record.targets ?? subscriptions.map((subscription) => subscription.id))
				.map((id) => byId.get(id))
				.filter((subscription): subscription is StoredSubscription => subscription !== undefined);
			if (targets.length === 0) {
				skip(record, "no subscribed device");
				continue;
			}
			let projects: readonly string[] = [];
			try {
				projects = candidate.project ? [candidate.project] : ports.projectsOf(candidate);
			} catch {
				// Tagged "project unknown" rather than withheld: the push is the point.
			}
			const payload = pushPayload(candidate, projects);
			const outcomes = await Promise.all(targets.map((target) => sendOne(target, payload, authorizationFor, ports.fetch)));
			const retry: string[] = [];
			const causes: string[] = [];
			outcomes.forEach((outcome, index) => {
				const target = targets[index] as StoredSubscription;
				if (outcome.kind === "delivered") {
					record.delivered += 1;
					return;
				}
				const reason = outcome.kind === "gone" ? `HTTP ${outcome.status}, subscription removed` : outcome.reason;
				log(`push ${record.id} → ${target.id.slice(0, 8)}: ${outcome.kind} (${reason})`);
				causes.push(`${target.id.slice(0, 8)} ${outcome.kind}: ${reason}`);
				if (outcome.kind === "retry") retry.push(target.id);
				if (outcome.kind === "gone") {
					try {
						rmSync(subscriptionFile(dataDir, target.id), { force: true });
					} catch (error) {
						log(`push subscription ${target.id.slice(0, 8)} is gone but could not be removed: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
					}
				}
			});
			record.attempts += 1;
			if (causes.length > 0) record.last_error = causes.join("; ").slice(0, PUSH_LAST_ERROR_MAX_CHARS);
			if (retry.length > 0 && record.attempts < PUSH_MAX_ATTEMPTS) {
				record.targets = retry;
				record.next_attempt_at = isoTimestamp(new Date(now.getTime() + pushBackoffSeconds(record.attempts) * 1000));
				report.retrying += 1;
				continue;
			}
			record.status = retry.length === 0 && record.delivered > 0 ? "sent" : "failed";
			record.settled_at = at;
			delete record.targets;
			delete record.next_attempt_at;
			if (record.status === "sent") report.sent += 1;
			else report.failed += 1;
		}
		if (due.length > 0) store.write(ledger, open);
		return report;
	});
}

async function sendOne(target: StoredSubscription, payload: string, authorizationFor: (endpoint: string) => string, fetch: PushFetch | undefined): Promise<PushOutcome> {
	if (!pushServiceAllowed(target.endpoint)) return { kind: "rejected", reason: "endpoint is not on the push-service allowlist; never fetched" };
	try {
		const body = encryptPayload(payload, target.keys);
		return await deliver({ endpoint: target.endpoint, body, authorization: authorizationFor(target.endpoint), ...(fetch ? { fetch } : {}) });
	} catch (error) {
		return { kind: "rejected", reason: `cannot build the push: ${(error as Error).message}`.slice(0, 140) };
	}
}
