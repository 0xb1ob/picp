/**
 * The Web Push sweep (Pier 1.1): push the operator only when they must act (`PUSH_RULE`) and only the operator can: never
 * for something the main session decides under delegation (mandate complete, risk:high, budget, merge refused, plans),
 * never an escalation directly (not even `service_health`, which the dashboard shows), and never a direct merge ask or
 * final_fix checkpoint. When one of those really needs the human, the main session opens a real ask card: an open
 * operator ask (`state/operator/asks.jsonl`, the dashboard's Awaiting you card) is the only thing that pushes.
 *
 * It reads the durable ask records rather than hooking a raise path: the record is the queue, so a crash between a
 * raise and a push loses nothing. The ledger (`./deliveries.ts`) makes it once per id; everything that fails is
 * recorded, logged in one line, and retried a bounded number of times. This function never throws for a push outage.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { isoTimestamp } from "../contracts.ts";
import { type OperatorAsk, OperatorAsks } from "../operator-asks.ts";
import { UNKNOWN_PROJECT } from "../project-report.ts";
import { listSubscriptions, pushDataDir, pushServiceAllowed, type StoredSubscription, subscriptionFile } from "../viewer/push-files.ts";
import { PUSH_LAST_ERROR_MAX_CHARS, PUSH_MAX_ATTEMPTS, type PushLedger, PushDeliveryStore, type PushRecord, pushBackoffSeconds, pushRecordKey } from "./deliveries.ts";
import { readVapidKeys, type VapidKeys } from "./keys.ts";
import { deliver, encryptPayload, type PushFetch, type PushOutcome, vapidAuthorization } from "./webpush.ts";

/** The active rule, one line, for `/doctor` and `/api/push`. */
export const PUSH_RULE = "pushes only when you must act: open ask cards (Awaiting you); nothing else, health and downtime stay on the dashboard";
export const PUSH_MAX_RECORDS_PER_SWEEP = 10;
export const PUSH_HEADLINE_MAX_CHARS = 100;
const PUSH_PROJECT_MAX_CHARS = 80;

export interface PushCandidate {
	id: string;
	source: PushRecord["source"];
	kind: string;
	text: string;
	job_ids: string[];
	/** An operator ask names its own project. */
	project?: string;
}

export interface PushCandidateInput {
	asks: readonly OperatorAsk[];
}

/** Only an open operator ask is a candidate: no escalation, health or downtime record pushes directly. */
export function pushCandidates(input: PushCandidateInput): PushCandidate[] {
	return input.asks
		.filter((ask) => ask.state === "open")
		.map((ask) => ({ id: ask.id, source: "ask", kind: "operator_ask", text: ask.question, job_ids: ask.job_ids ?? [], project: ask.project }));
}

const clip = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Exactly `{project, kind, headline}` — never ids, options, evidence, plans or artifact text. */
export function pushPayload(candidate: PushCandidate, projects: readonly string[]): string {
	const project = clip(projects.join(", "), PUSH_PROJECT_MAX_CHARS) || UNKNOWN_PROJECT;
	return JSON.stringify({ project, kind: "decision needed", headline: clip(candidate.text, PUSH_HEADLINE_MAX_CHARS) });
}

export interface PushSweepPorts {
	stateDir: string;
	/** Default: the `data/` beside `stateDir`. */
	dataDir?: string;
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
		candidates = pushCandidates({ asks: ports.openAsks ? ports.openAsks() : new OperatorAsks(join(ports.stateDir, "operator", "asks.jsonl")).open() });
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
		// First sweep under the current rule: what its sources hold now was never promised a push (not replayed).
		const ruleBaseline = !ledger.rule_baseline_at;
		if (ruleBaseline) ledger.rule_baseline_at = at;
		for (const candidate of candidates) {
			if (known.has(pushRecordKey(candidate))) continue;
			const record = fresh(candidate);
			if (ruleBaseline) skip(record, "open before the push rule changed");
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
