/**
 * Durable quota-continuation intents (P3 PR2): a verified usage-limit reset on an eligible, opted-in job becomes one
 * pending intent; reconciliation and the due tick cancel, hold or consume it. Never deletes job, session or counters.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CarriedBounds } from "./bounds.ts";
import { type FleetRecord, isoTimestamp, LAYOUT } from "./contracts.ts";
import { readDrain } from "./drain.ts";
import type { FleetStore } from "./fleet.ts";
import type { MandateStore } from "./mandate.ts";
import { atomicWriteJson } from "./json-store.ts";
import {
	type EffectiveQuotaPolicy,
	effectiveQuotaPolicy,
	type QuotaEligibility,
	type QuotaPolicy,
} from "./quota-continuation-policy.ts";
import { PRODUCTION_QUOTA_RESET_ADAPTER, type QuotaResetAdapter, type QuotaResetSignal } from "./quota-reset-signal.ts";
import type { RunRegistry } from "./runs.ts";
import type { SendRequest, SendResult } from "./send.ts";
import type { WorkerEvent } from "./worker-process.ts";

export type QuotaIntentState = "pending" | "consumed" | "cancelled";
/** `claimed`/`idle`/`sending` are in-flight steps; a restart finding one cannot know the outcome, so it holds. */
export type QuotaDelivery = "waiting" | "claimed" | "idle" | "sending" | "ambiguous";

export interface QuotaIntent {
	continuation_id: string;
	job_id: string;
	generation: number;
	state: QuotaIntentState;
	delivery: QuotaDelivery;
	capability_version: string;
	signal: QuotaResetSignal;
	observed_at: string;
	policy: EffectiveQuotaPolicy;
	/** Lease and session identity at the interruption; reconciliation never rewrites them. */
	worktree: string;
	branch: string;
	session_file: string;
	worker_pid: number;
	attempts: number;
	/** The interrupted round's caps spend at the claim; the continuation resumes it instead of a fresh round. */
	round?: CarriedBounds;
	reason?: string;
	cancelled?: { actor: string; reason: string; at: string };
	consumed?: { at: string; receipt: SendResult["receipt"]; mode: SendResult["mode"] };
}

interface QuotaDocument {
	schema_version: 1;
	policy: QuotaPolicy;
	eligibility: Record<string, QuotaEligibility>;
	intents: QuotaIntent[];
}

/** The short continuation sent after a reset: never the brief. */
export const QUOTA_CONTINUE_NUDGE =
	"The provider usage limit that stopped your previous turn has reset. Continue where you left off — " +
	"do not repeat the original task or brief, and do not redo actions you already completed.";

export const quotaContinuationFile = (home: string): string => join(home, LAYOUT.state, "quota-continuation.json");
/** Append-only journal of store failures; there is no job to journal a home-wide failure on. */
export const quotaContinuationErrorsFile = (home: string): string => join(home, LAYOUT.state, "quota-continuation.errors.jsonl");

/** The store is unreadable or of an unknown schema: quota continuation is off and the file stays as found. */
export class QuotaStoreError extends Error {
	override name = "QuotaStoreError";
}

export interface QuotaContinuationOptions {
	home: string;
	fleet: FleetStore;
	runs: RunRegistry;
	/** Absent means production: the frozen empty adapter, which decodes nothing. */
	adapter?: QuotaResetAdapter;
	/** Due-tick ports: the existing continue_failed revive and the ordinary send. */
	revive: (jobId: string, carried?: CarriedBounds) => Promise<unknown>;
	send: (request: SendRequest) => Promise<SendResult>;
	/** Only the home's owner reconciles or sends. */
	owns: () => boolean;
	/** The repair check a due intent passes before any claim: a revoked, capped or past-deadline grant cancels it. */
	mandates: Pick<MandateStore, "assertPermitted">;
	/** False while every worker slot is taken: a due intent then waits for a later pass. */
	capacityFree: () => boolean;
	/** The live worker's hard-bound spend in its current round (`HardBoundsWatch.spent`). */
	spent?: (jobId: string) => CarriedBounds | undefined;
	now?: () => Date;
}

/** The due timer's longest sleep, so a clock jump, a suspended host or a skipped pass is retried. */
export const QUOTA_TICK_MAX_MS = 60_000;

/** The worker the intent interrupted was replaced since (a manual revive or re-dispatch); `started_at` is too coarse. */
const replaced = (record: FleetRecord, intent: QuotaIntent): boolean => record.worker.pid !== intent.worker_pid;

type Listener = (event: WorkerEvent) => void;

export class QuotaContinuation {
	readonly #options: QuotaContinuationOptions;
	readonly #adapter: QuotaResetAdapter;
	#timer: NodeJS.Timeout | undefined;
	#passes: Promise<unknown> = Promise.resolve();

	constructor(options: QuotaContinuationOptions) {
		this.#options = options;
		this.#adapter = options.adapter ?? PRODUCTION_QUOTA_RESET_ADAPTER;
	}

	get capabilityVersion(): string {
		return this.#adapter.capabilityVersion;
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	#read(): QuotaDocument {
		const file = quotaContinuationFile(this.#options.home);
		if (!existsSync(file)) return { schema_version: 1, policy: { jobs: {} }, eligibility: {}, intents: [] };
		let doc: QuotaDocument | null;
		try {
			doc = JSON.parse(readFileSync(file, "utf8")) as QuotaDocument | null;
		} catch (error) {
			throw new QuotaStoreError(`${file} is unreadable: ${(error as Error).message}`);
		}
		if (typeof doc !== "object" || doc === null || doc.schema_version !== 1 || !Array.isArray(doc.intents)
			|| typeof doc.policy?.jobs !== "object" || typeof doc.eligibility !== "object") {
			throw new QuotaStoreError(`${file}: unknown quota-continuation schema (schema_version ${String(doc?.schema_version)})`);
		}
		return doc;
	}

	#write(doc: QuotaDocument): void {
		atomicWriteJson(quotaContinuationFile(this.#options.home), doc);
	}

	/** Never throws: one line in the home journal, plus the job's run log when a job is in scope. */
	#storeError(error: unknown, during: string, jobId?: string): void {
		const entry = { error_name: error instanceof Error ? error.name : "Error", error: (error instanceof Error ? error.message : String(error)).slice(0, 300), during };
		const file = quotaContinuationErrorsFile(this.#options.home);
		try {
			mkdirSync(join(this.#options.home, LAYOUT.state), { recursive: true });
			appendFileSync(file, `${JSON.stringify({ ts: this.#now().toISOString(), ...entry })}\n`);
		} catch (writeError) {
			process.stderr.write(`${file} unwritable (${(writeError as Error).message}): ${JSON.stringify(entry)}\n`);
		}
		if (!jobId) return;
		try {
			this.#options.runs.open(jobId).cp("quota_continuation", entry);
		} catch {
			// the home journal above already holds the failure
		}
	}

	#journal(intent: QuotaIntent): void {
		const { continuation_id, state, delivery, generation } = intent;
		this.#options.runs.open(intent.job_id).cp("quota_continuation", {
			continuation_id, generation, state, delivery, resets_at: intent.signal.resetsAtUtc,
			...(intent.reason ? { reason: intent.reason } : {}),
		});
	}

	/** Every intent, oldest first, optionally for one job. */
	intents(jobId?: string): QuotaIntent[] {
		try {
			const all = this.#read().intents;
			return jobId === undefined ? all : all.filter((intent) => intent.job_id === jobId);
		} catch (error) {
			this.#storeError(error, "intents", jobId);
			return [];
		}
	}

	/**
	 * The job's pending continuation id while it owns the job's next turn, so ordinary recovery and startup reconcile
	 * stand down. A manual replacement releases a waiting one; an ambiguous one holds until cancelled.
	 */
	holding(jobId: string): string | undefined {
		const intent = this.intents(jobId).find((candidate) => candidate.state === "pending");
		const record = this.#options.fleet.get(jobId);
		if (!intent || (intent.delivery === "waiting" && record && replaced(record, intent))) return undefined;
		return intent.continuation_id;
	}

	/** One unref'd timer for the earliest waiting reset; one due by `passStart` was skipped (busy, drain): the cap. */
	arm(passStart?: number): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#options.owns()) return;
		const resets = this.intents().filter((intent) => intent.state === "pending" && intent.delivery === "waiting").map((intent) => intent.signal.resetsAtEpochSeconds * 1000);
		if (resets.length === 0) return;
		const now = this.#now().getTime();
		const delay = Math.min(QUOTA_TICK_MAX_MS, ...resets.map((at) => (at > now ? at - now : passStart !== undefined && at <= passStart ? QUOTA_TICK_MAX_MS : 0)));
		this.#timer = setTimeout(() => {
			const started = this.#now().getTime();
			void this.tick().catch((error: unknown) => this.#storeError(error, "tick")).finally(() => this.arm(started));
		}, delay);
		this.#timer.unref();
	}

	/** An unreadable store reads as no settings: quota continuation is off. */
	policy(): QuotaPolicy {
		try {
			return this.#read().policy;
		} catch (error) {
			this.#storeError(error, "policy");
			return { jobs: {} };
		}
	}

	/** Dispatch's resolved eligibility facts, kept for the observer and every later revival. */
	recordEligibility(jobId: string, eligibility: QuotaEligibility): void {
		try {
			const doc = this.#read();
			doc.eligibility[jobId] = eligibility;
			this.#write(doc);
		} catch (error) {
			// Fail closed: a job without recorded facts never gets an intent, and the dispatch is not refused for it.
			this.#storeError(error, "recordEligibility", jobId);
		}
	}

	/** Set the home default (no `jobId`) or a job override; an effective opt-out cancels that scope's unsent intents. */
	setPolicy(input: { jobId?: string; enabled: boolean; actor: string }): QuotaIntent[] {
		let doc: QuotaDocument;
		try {
			doc = this.#read();
		} catch (error) {
			this.#storeError(error, "setPolicy", input.jobId);
			throw error; // an operator write is refused loudly, and nothing is overwritten
		}
		const setting = { enabled: input.enabled, changed_at: this.#now().toISOString(), actor: input.actor };
		if (input.jobId === undefined) doc.policy.home = setting;
		else doc.policy.jobs[input.jobId] = setting;
		const cancelled: QuotaIntent[] = [];
		for (const intent of doc.intents) {
			if (intent.state !== "pending" || intent.delivery !== "waiting" || effectiveQuotaPolicy(doc.policy, intent.job_id).enabled) continue;
			const scope = doc.policy.jobs[intent.job_id] ? "job" : "home";
			cancelled.push(this.#cancel(intent, input.actor, `quota continuation turned off (${scope}) by ${input.actor}`));
		}
		this.#write(doc);
		for (const intent of cancelled) this.#journal(intent);
		return cancelled;
	}

	/** The operator's cancel of one job's unsent intent; anything already claimed for sending is refused, not undone. */
	cancel(jobId: string, input: { actor: string; reason: string }): { ok: true; intent: QuotaIntent } | { ok: false; reason: string } {
		let doc: QuotaDocument;
		try {
			doc = this.#read();
		} catch (error) {
			this.#storeError(error, "cancel", jobId);
			return { ok: false, reason: (error as Error).message };
		}
		const intent = doc.intents.find((candidate) => candidate.job_id === jobId && candidate.state === "pending");
		if (!intent) return { ok: false, reason: `${jobId} has no pending quota continuation` };
		if (intent.delivery !== "waiting") return { ok: false, reason: `${intent.continuation_id} is ${intent.delivery}: past the point a cancel can stop` };
		this.#cancel(intent, input.actor, input.reason);
		this.#write(doc);
		this.#journal(intent);
		return { ok: true, intent };
	}

	#cancel(intent: QuotaIntent, actor: string, reason: string): QuotaIntent {
		intent.state = "cancelled";
		intent.reason = reason;
		intent.cancelled = { actor, reason, at: this.#now().toISOString() };
		return intent;
	}

	/**
	 * Watch one worker's terminal model errors; the returned claim, asked at its settle, turns the last verified reset
	 * into one durable pending intent and answers the failure text, or answers undefined for ordinary handling.
	 */
	watch(jobId: string, worker: { onEvent(listener: Listener): () => void }): { claim: () => string | undefined; detach: () => void } {
		let signal: QuotaResetSignal | undefined;
		const detach = worker.onEvent((event) => {
			if (event.type === "agent_start") signal = undefined;
			if (event.type !== "message_end") return;
			const message = event.message as { role?: unknown; stopReason?: unknown } | undefined;
			if (message?.role !== "assistant") return;
			signal = message.stopReason === "error" ? this.#adapter.decode(message) : undefined;
		});
		const claim = (): string | undefined => {
			const found = signal;
			signal = undefined;
			if (!found) return undefined;
			try {
				return this.#claim(jobId, found);
			} catch (error) {
				this.#storeError(error, "claim", jobId);
				return undefined;
			}
		};
		return { claim, detach };
	}

	#claim(jobId: string, signal: QuotaResetSignal): string | undefined {
		const doc = this.#read();
		const eligibility = doc.eligibility[jobId];
		const policy = effectiveQuotaPolicy(doc.policy, jobId);
		const record = this.#options.fleet.get(jobId);
		const refused = !record ? "no fleet record" : !eligibility ? "no eligibility facts were recorded at dispatch"
			: !eligibility.eligible ? `not eligible: ${eligibility.reason}` : !policy.enabled ? `quota continuation is off (${policy.source})` : undefined;
		if (refused || !record) {
			this.#options.runs.open(jobId).cp("quota_continuation", { state: "not_created", resets_at: signal.resetsAtUtc, reason: refused });
			return undefined;
		}
		const generation = doc.intents.filter((intent) => intent.job_id === jobId).length + 1;
		const intent: QuotaIntent = {
			continuation_id: `${jobId}:quota:${generation}`,
			job_id: jobId,
			generation,
			state: "pending",
			delivery: "waiting",
			capability_version: this.#adapter.capabilityVersion,
			signal,
			observed_at: this.#now().toISOString(),
			policy,
			worktree: record.worktree,
			branch: record.branch,
			session_file: record.worker.session_file,
			worker_pid: record.worker.pid,
			attempts: 0,
		};
		const round = this.#options.spent?.(jobId);
		if (round) intent.round = round;
		doc.intents.push(intent);
		this.#write(doc);
		this.#journal(intent);
		this.arm();
		return (
			`provider usage limit (${signal.category}, ${signal.scope}) until ${signal.resetsAtUtc}: quota continuation ` +
			`${intent.continuation_id} is pending — command-post continues this session after the reset. ` +
			"Do not re-dispatch; cancel the continuation to take the job back."
		);
	}

	/** Startup: an in-flight step from a dead parent holds as ambiguous; a vanished or opted-out job's intent cancels. */
	reconcile(): QuotaIntent[] {
		if (!this.#options.owns()) return [];
		try {
			return this.#reconcile();
		} catch (error) {
			this.#storeError(error, "reconcile"); // startup goes on; the store file is left as found
			return [];
		} finally {
			this.arm(); // P3: the startup wake; an overdue intent behind a drain record retries at the cap
		}
	}

	#reconcile(): QuotaIntent[] {
		const doc = this.#read();
		const changed: QuotaIntent[] = [];
		for (const intent of doc.intents) {
			if (intent.state !== "pending") continue;
			if (intent.delivery === "claimed" || intent.delivery === "idle" || intent.delivery === "sending") {
				intent.reason = `the parent restarted while ${intent.delivery}: delivery unknown, never resent`;
				intent.delivery = "ambiguous";
				changed.push(intent);
				continue;
			}
			const blocked = intent.delivery === "waiting" ? this.#stale(doc, intent) : undefined;
			if (blocked) changed.push(this.#cancel(intent, "command-post", blocked));
		}
		if (changed.length > 0) this.#write(doc);
		for (const intent of changed) this.#journal(intent);
		return changed;
	}

	#closed(jobId: string): string | undefined {
		const record = this.#options.fleet.get(jobId);
		return !record || record.phase === "done" ? `${jobId} is closed` : undefined;
	}

	#stale(doc: QuotaDocument, intent: QuotaIntent): string | undefined {
		const closed = this.#closed(intent.job_id);
		if (closed) return closed;
		const record = this.#options.fleet.require(intent.job_id);
		if (replaced(record, intent)) return `${intent.job_id} was continued by other means (phase ${record.phase})`;
		if (!effectiveQuotaPolicy(doc.policy, intent.job_id).enabled) return "quota continuation is turned off";
		return undefined;
	}

	/** One due pass at a time: each waiting intent past its reset is revived idle and sent the short continuation once. */
	tick(): Promise<QuotaIntent[]> {
		const pass = this.#passes.then(() => this.#tick());
		this.#passes = pass.catch(() => undefined);
		return pass;
	}

	async #tick(): Promise<QuotaIntent[]> {
		if (!this.#options.owns() || readDrain(this.#options.home)) return [];
		const done: QuotaIntent[] = [];
		const nowSeconds = this.#now().getTime() / 1000;
		let intents: QuotaIntent[];
		try {
			intents = this.#read().intents;
		} catch (error) {
			this.#storeError(error, "tick");
			return done;
		}
		const due = intents.filter((intent) => intent.state === "pending" && intent.delivery === "waiting" && intent.signal.resetsAtEpochSeconds <= nowSeconds);
		for (const { continuation_id, job_id } of due) {
			try {
				const settled = await this.#continue(continuation_id);
				if (settled) done.push(settled);
			} catch (error) {
				// A store gone unreadable mid-pass stops this intent, never the pass; a lost owner's stop is not a store error.
				if (this.#options.owns()) this.#storeError(error, "tick", job_id);
			}
		}
		return done;
	}

	/** Each step is persisted before the call it guards, so a crash leaves a holdable state, never a resend. */
	async #continue(id: string): Promise<QuotaIntent | undefined> {
		const step = (patch: Partial<QuotaIntent>): QuotaIntent => {
			// A stopping parent never writes past its last persisted step: the next owner holds that step as ambiguous.
			if (!this.#options.owns()) throw new Error(`${id}: ownership lost mid-delivery; left for the next owner's reconcile`);
			const doc = this.#read();
			const intent = doc.intents.find((candidate) => candidate.continuation_id === id) as QuotaIntent;
			Object.assign(intent, patch);
			this.#write(doc);
			this.#journal(intent);
			return intent;
		};
		const doc = this.#read();
		const intent = doc.intents.find((candidate) => candidate.continuation_id === id);
		// A replayed pass finds it claimed or settled already: never a second send.
		if (intent?.state !== "pending" || intent.delivery !== "waiting") return undefined;
		const stale = this.#stale(doc, intent) ?? this.#refused(intent.job_id);
		if (stale) {
			this.#cancel(intent, "command-post", stale);
			this.#write(doc);
			this.#journal(intent);
			return intent;
		}
		// Not failed yet (or an orphan holds it), no free slot, or a drain began mid-pass: a later pass decides.
		if (this.#options.fleet.get(intent.job_id)?.phase !== "failed" || !this.#options.capacityFree() || readDrain(this.#options.home)) return undefined;
		step({ delivery: "claimed", attempts: intent.attempts + 1 });
		try {
			await this.#options.revive(intent.job_id, intent.round);
		} catch (error) {
			return step({ delivery: "ambiguous", reason: `revive refused: ${(error as Error).message.slice(0, 300)}` });
		}
		step({ delivery: "idle" });
		const late = this.#closed(intent.job_id) ?? this.#refused(intent.job_id);
		if (late) return step({ state: "cancelled", reason: late, cancelled: { actor: "command-post", reason: late, at: this.#now().toISOString() } });
		step({ delivery: "sending" });
		let result: SendResult;
		try {
			result = await this.#options.send({ jobId: intent.job_id, message: QUOTA_CONTINUE_NUDGE, keepRound: true });
		} catch (error) {
			return step({ delivery: "ambiguous", reason: `send failed: ${(error as Error).message.slice(0, 300)}` });
		}
		if (result.receipt === "failed") return step({ delivery: "ambiguous", reason: `send not confirmed: ${result.error ?? "no error text"}` });
		return step({ state: "consumed", consumed: { at: isoTimestamp(this.#now()), receipt: result.receipt, mode: result.mode } });
	}

	#refused(jobId: string): string | undefined {
		try {
			const record = this.#options.fleet.require(jobId);
			this.#options.mandates.assertPermitted("repair", { jobId, project: record.project, kind: record.kind }, this.#options.fleet.read().jobs);
			return undefined;
		} catch (error) {
			return `authority refused: ${(error as Error).message.slice(0, 300)}`;
		}
	}
}
