import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type Envelope,
	type JobStatus,
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
import { AwaitingStore } from "./awaiting.ts";
import { isPidAlive, readRunObservation } from "./fleet.ts";
import { HUMAN_REVIEW_SUBJECT } from "./human-handoff.ts";
import { readMergeReceipt } from "./merges.ts";
import { readEventLog, readStatusFile } from "./run-artifacts.ts";
import type { JobOwner } from "./job-claims.ts";
import type { GateFailure, TeardownResult } from "./teardown.ts";
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

/** Just enough of `Ledger` to close a research/answer job after a successful teardown. */
export interface TeardownLedger {
	list(filter: { status: readonly JobStatus[] }): Promise<ReadonlyArray<{ id: string; status: string; updated_at: string }>>;
	close(id: string, reason: string): Promise<unknown>;
}

/** cp-t9yr F1: an unowned worker with a live pid — nothing here can observe its close, so no option skips this. */
export function unmanagedLiveWorker(home: string, record: FleetRecord, managed: unknown): GateFailure | undefined {
	if (managed !== undefined || isScriptFleetRecord(record) || record.worker.exited_at !== undefined) return undefined;
	if (readRunObservation(home, record.job_id)?.closed === true || !isPidAlive(record.worker.pid)) return undefined;
	const { job_id: id, worker: { pid } } = record;
	return {
		code: "unmanaged_live_worker",
		message: `${id}: its worker (pid ${pid}) is alive but no session here owns it; returning the lease would hand its worktree to the next job while it can still write there`,
		fix: `keep the lease. Confirm pid ${pid} is this job's worker (its cwd is ${record.worktree}), end it deliberately or let it exit, then re-run cp_teardown ${id}. force, operator_quote and the pipeline hand-off do not skip this gate — nothing here can observe that worker's close`,
	};
}

/** cp-a9fq: another owner holds this job's in-flight state; tearing down beside it is the hazard, so refuse. */
export function jobInFlight(jobId: string, holder: JobOwner): GateFailure {
	const what = holder === "recovery" ? "automatic recovery (a revive or redispatch in this worktree)" : "another teardown";
	return {
		code: "job_in_flight",
		message: `${jobId}: ${what} is in flight; a teardown beside it could return a worktree a revived worker stands in, or close the job under it`,
		fix: `keep the lease; wait for that outcome (/watch ${jobId}: recovery_attempted or recovery_escalated, or the cp-death/cp-bound wake-up), then re-run cp_teardown ${jobId}`,
	};
}

/** cp-a9fq: treehouse refused or failed the return — the lease is still held, so the job is not done. */
export function leaseReturnFailed(jobId: string, error: string): GateFailure {
	return {
		code: "lease_return_failed",
		message: `${jobId}: ${error}`,
		fix: `the job stays open and keeps its lease: find what still holds the worktree (a live process in it, or a lease id that moved), then re-run cp_teardown ${jobId}`,
	};
}

// cp-a9fq: `defaultGit` and `formatTeardown` live here, not in teardown.ts, only
// to keep teardown.ts under the 800-line per-module cap (tests/structure.test.ts)
// without raising it; teardown.ts imports the one and re-exports the other, so
// no caller changed. Pure moves — behaviour is identical.
/** Teardown's git runner when no `git` port is injected; never throws, the status says. */
export function defaultGit(cwd: string, args: readonly string[]) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
		execFile("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			const status = typeof code === "number" ? code : error ? 1 : 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** One operator line; on refusal it says what is kept and what to do. */
export function formatTeardown(result: TeardownResult): string {
	if (result.torn_down) {
		const why = result.killed_unreported ? "killed_unreported" : result.reason ?? "forced";
		const note = result.unreported ? ` — no report was filed for ${result.job_id}: relay "no report", never a result` : "";
		const ledger = result.ledger_close_error ? ` — ledger close failed (${result.ledger_close_error}); re-run cp_teardown ${result.job_id} to retry` : "";
		return `${result.job_id} torn down (${why}): lease returned, worker exit ${result.exit_code ?? "n/a"}${note}${ledger}`;
	}
	if (result.failure) {
		return `${result.job_id} kept: ${result.failure.code} — ${result.failure.message}\n  fix: ${result.failure.fix}`;
	}
	return `${result.job_id}: already torn down${result.ledger_closed ? "; its ledger close was retried and the job is now closed" : ""}${result.ledger_close_error ? `; ledger close still failing (${result.ledger_close_error})` : ""}`;
}

export interface LedgerCloseOutcome {
	closed: string[];
	failed: Array<{ job_id: string; error: string }>;
}

function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return (text.trim().split("\n")[0] ?? "").slice(0, 300) || "unknown error";
}

/**
 * Research/answer ledger close for torn-down (`done`) records: reported, a filed
 * envelope, and an open row not edited since the fleet `closed_at`. Failures are
 * returned and journaled as one `recovery` wake-up — a re-run teardown or the next
 * parent startup retries them.
 */
export async function closeResearchLedgers(home: string, records: readonly FleetRecord[],
	getLedger: (() => TeardownLedger) | undefined, journal?: (input: DurableWakeupInput) => void): Promise<LedgerCloseOutcome> {
	const outcome: LedgerCloseOutcome = { closed: [], failed: [] };
	const due = records.filter((r) => r.kind === "research" && !isScriptFleetRecord(r) && r.phase === "done" &&
		r.reported_at !== undefined && r.closed_at !== undefined);
	if (due.length === 0 || !getLedger) return outcome;
	let ledger: TeardownLedger | undefined;
	let rows = new Map<string, { updated_at: string }>();
	try {
		ledger = getLedger();
		rows = new Map((await ledger.list({ status: ["open", "in_progress"] })).map((row) => [row.id, row]));
	} catch (error) {
		for (const r of due) if (readFiledEnvelope(home, r.job_id)) outcome.failed.push({ job_id: r.job_id, error: firstLine(error) });
	}
	for (const r of ledger && outcome.failed.length === 0 ? due : []) {
		const row = rows.get(r.job_id);
		if (!row || Date.parse(row.updated_at) > Date.parse(r.closed_at ?? "")) continue;
		const envelope = readFiledEnvelope(home, r.job_id);
		if (!envelope) continue;
		try {
			await ledger?.close(r.job_id, derivedCloseReason(r, envelope, latestGateVerdict(home, r.job_id)).slice(0, 900));
			outcome.closed.push(r.job_id);
		} catch (error) {
			outcome.failed.push({ job_id: r.job_id, error: firstLine(error) });
		}
	}
	if (outcome.failed.length > 0) journal?.(ledgerCloseFailedWakeup(records, outcome.failed));
	return outcome;
}

function ledgerCloseFailedWakeup(records: readonly FleetRecord[], failed: LedgerCloseOutcome["failed"]): DurableWakeupInput {
	const project = (id: string) => records.find((r) => r.job_id === id)?.project ?? "?";
	const lines = failed.slice(0, 20).flatMap(({ job_id, error }) => [
		`[${project(job_id)}] ${job_id}: torn down, but its ledger close failed — ${error}`,
		`  next: cp_teardown ${job_id} retries the close (no lease or worker is touched), or cp_job close ${job_id} with a reason.`,
	]);
	if (failed.length > 20) lines.push(`… and ${failed.length - 20} more`);
	return {
		id: boundedWakeupId(`ledger-close-failed:${failed.map((f) => f.job_id).sort().join(",")}`),
		kind: "recovery",
		...(failed.length === 1 ? { job_id: failed[0]?.job_id } : {}),
		content: lines.join("\n"),
	};
}

/**
 * picp-pvo: the job is closed, so its `human-review pr <url>` Awaiting row stops asking.
 * Only this job's open or deferred rows with that subject; an answer is never withdrawn.
 * A store that cannot be written never undoes a teardown: it is one `recovery` wake-up.
 */
export async function withdrawHumanReview(home: string, record: FleetRecord, journal?: (input: DurableWakeupInput) => void): Promise<void> {
	try {
		const store = new AwaitingStore({ home });
		for (const item of store.list()) {
			if (item.job_id !== record.job_id || !item.subject?.startsWith(HUMAN_REVIEW_SUBJECT)) continue;
			if (item.state === "open" || item.state === "deferred") await store.withdraw(item.id);
		}
	} catch (error) {
		journal?.({
			id: boundedWakeupId(`human-review-withdraw-failed:${record.job_id}`),
			kind: "recovery",
			job_id: record.job_id,
			content: `[${record.project}] ${record.job_id}: torn down, but its human-review Awaiting row could not be withdrawn — ${firstLine(error)}\n  next: nothing to answer; the row reads as obsolete once the job is done (state/awaiting.json keeps it open).`,
		});
	}
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
