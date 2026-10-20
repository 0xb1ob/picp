/**
 * System-one wake rules: wakes that code already acted on reach the operator as a relay, not a parent turn.
 * Every rule fails open (wakes the parent); the kill switch `data/wake-rules.json` fails closed. docs/contracts.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiObservation } from "./ci-watch.ts";
import type { CommandPost } from "./command-post.ts";
import { type DurableWakeupEntry, isSafeJobId, LAYOUT } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import type { ContinuationOutcome, HeldContinuation } from "./held-continuation.ts";
import { cpNext, type NextActionKind, type NextResult } from "./next.ts";
import { homeProjectResolver } from "./project-report.ts";
import type { RunRegistry } from "./runs.ts";

export const NEXT_CACHE_MAX_AGE_MS = 60_000;
export const RESOLVE_REFRESH_WAIT_MS = 10_000;
export const QUIET_NEXT_KINDS = ["wait", "no_mandate", "draining"] as const;
export const CI_RULE_WAIT_MS = 30_000;

const isQuietKind = (kind: string): boolean => (QUIET_NEXT_KINDS as readonly string[]).includes(kind);
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** The kill switch: absent file = on; `enabled: false`, or anything unreadable or malformed = off. Never throws. */
export function wakeRulesEnabled(home: string | undefined): boolean {
	if (!home) return false;
	let text: string;
	try {
		text = readFileSync(join(home, LAYOUT.data, "wake-rules.json"), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const enabled = (value as { enabled?: unknown }).enabled;
		return enabled === undefined || enabled === true;
	} catch {
		return false;
	}
}

/** A `HELD PR STOPPED … (next: resolve)` durable id; a hashed (over-long) id fails the match and wakes the parent. */
export function isResolveStop(id: string): boolean {
	return /^continuation:.+:resolve$/.test(id);
}

/** Notify text the bridge relays straight to the operator. */
export function isRelayOnlyNotice(text: string): boolean {
	return /^(?:\[[^\]\n]+\] )?(?:HELD PR LANDED — |HELD PR STOPPED — \S+ \(continuation, next: resolve\)|CI GREEN — .* handled in code, no parent turn\.)/.test(text);
}

/** A custom message a wake rule sent with no parent turn; the bridge relays it. */
export function relayOnlyMessage(message: unknown): boolean {
	const details = (message as { details?: unknown } | undefined)?.details;
	return !!details && typeof details === "object" && (details as { relay_only?: unknown }).relay_only === true;
}

/** The fleet generation a wake for `jobId` is stamped with; undefined with no id or an unreadable fleet. */
export function fleetGeneration(fleet: Pick<FleetStore, "get">, jobId: string | undefined): number | undefined {
	if (!jobId) return undefined;
	try {
		return (fleet.get(jobId)?.supersessions ?? 0) + 1;
	} catch {
		return undefined;
	}
}

export type NextPost = Pick<CommandPost, "packageRoot" | "ledger" | "fleet" | "mandates" | "escalations" | "pipelines" | "dispatchQueue">;

/** One in-process `cpNext` over the command post's own ports. */
export async function nextFor(post: NextPost, override?: typeof cpNext): Promise<NextResult> {
	return (override ?? cpNext)({
		packageRoot: post.packageRoot, ledger: post.ledger(),
		fleet: post.fleet, mandates: post.mandates, escalations: post.escalations, pipelines: post.pipelines,
		queued: () => post.dispatchQueue.ids(),
	});
}

export interface WakeRulePayload {
	wake_rule: "ci_green" | "held_stop_resolve";
	decision: "suppressed" | "woke" | "relayed";
	reason: string;
	[key: string]: unknown;
}

/** One `continuation` run event carrying `wake_rule`; never throws, skips an absent or unsafe job id. */
export function journalWakeRule(runs: Pick<RunRegistry, "open"> | undefined, jobId: string | undefined, payload: WakeRulePayload): void {
	if (!runs || !jobId || !isSafeJobId(jobId)) return;
	try {
		runs.open(jobId).cp("continuation", payload);
	} catch {
		// A run log that cannot be written must never change how a wake is delivered.
	}
}

/** The last `cpNext` result this process computed, or why there is none fresh. */
export class NextCache {
	#kind: NextActionKind | undefined;
	#at: number | undefined;
	#error: string | undefined;
	#attemptAt: number | undefined;

	remember(kind: NextActionKind, at = Date.now()): void {
		this.#kind = kind;
		this.#at = at;
		this.#error = undefined;
	}

	fail(message: string, at = Date.now()): void {
		this.#kind = undefined;
		this.#at = at;
		this.#error = message;
	}

	attempt(at = Date.now()): void {
		this.#attemptAt = at;
	}

	fresh(now = Date.now()): { kind: NextActionKind } | { reason: string } {
		if (this.#error !== undefined) return { reason: `cp_next unavailable: ${this.#error}` };
		if (this.#kind === undefined || this.#at === undefined) return { reason: "cp_next unavailable: never computed" };
		return now - this.#at <= NEXT_CACHE_MAX_AGE_MS ? { kind: this.#kind } : { reason: "cp_next stale" };
	}

	attemptedRecently(now = Date.now()): boolean {
		return this.#attemptAt !== undefined && now - this.#attemptAt < NEXT_CACHE_MAX_AGE_MS;
	}
}

export type WakeRulesPost = NextPost & Pick<CommandPost, "durableWakeups" | "runs"> & { continuation: Pick<HeldContinuation, "ciOutcome"> };

export interface WakeRulesDeps {
	home: () => string | undefined;
	post: () => WakeRulesPost;
	/** Read on every `next()`, so a caller may set it after construction. */
	override?: typeof cpNext;
	resweep: () => void;
	now?: () => number;
	refreshWaitMs?: number;
	ciWaitMs?: number;
}

export type CiRuling = { suppress: true; relay: string; keys: string[] } | { suppress: false };

/** The rules wakeup-surfaces asks before it wakes the parent. */
export function createWakeRules(deps: WakeRulesDeps) {
	const now = deps.now ?? Date.now;
	const cache = new NextCache();
	const journaled = new Set<string>();
	const ciInFlight = new Set<string>();
	const decided = new Map<string, WakeRulePayload>();
	const runsOf = (): Pick<RunRegistry, "open"> | undefined => {
		try {
			return deps.post().runs;
		} catch {
			return undefined;
		}
	};
	let refreshing = false;
	const home = (): string | undefined => {
		try {
			return deps.home();
		} catch {
			return undefined;
		}
	};

	const next = async (): Promise<NextResult> => {
		try {
			const result = await nextFor(deps.post(), deps.override);
			cache.remember(result.action.kind, now());
			return result;
		} catch (error) {
			cache.fail(firstLine(error), now());
			throw error;
		}
	};

	/** True while one bounded cp_next refresh runs for a pending resolve stop; `resweep` runs once it settles. */
	const deferSweep = (): boolean => {
		if (refreshing) return true;
		try {
			if (!wakeRulesEnabled(home())) return false;
			if (!deps.post().durableWakeups.pending().some((entry) => isResolveStop(entry.id))) return false;
			const at = now();
			if ("kind" in cache.fresh(at) || cache.attemptedRecently(at)) return false;
			cache.attempt(at);
			refreshing = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					cache.fail("timed out", now());
					resolve();
				}, deps.refreshWaitMs ?? RESOLVE_REFRESH_WAIT_MS);
				timer.unref();
			});
			void Promise.race([next().then(() => undefined, () => undefined), timeout]).finally(() => {
				clearTimeout(timer);
				refreshing = false;
				try {
					deps.resweep();
				} catch {
					// The next sweep trigger retries; a deferral must never strand the outbox.
				}
			});
			return true;
		} catch {
			refreshing = false;
			return false;
		}
	};

	/** A resolve stop with the switch on and a fresh, quiet cp_next is relayed, not a turn; `delivered` journals it. */
	const relayOnly = (entry: Pick<DurableWakeupEntry, "id" | "job_id">): boolean => {
		if (!isResolveStop(entry.id)) return false;
		try {
			if (!wakeRulesEnabled(home())) return false;
			const state = cache.fresh(now());
			const quiet = "kind" in state && isQuietKind(state.kind);
			const reason = "kind" in state ? `cp_next ${state.kind}` : state.reason;
			const nextKind = "kind" in state ? { next_kind: state.kind } : {};
			decided.set(entry.id, { wake_rule: "held_stop_resolve", decision: quiet ? "relayed" : "woke", reason, ...nextKind });
			return quiet;
		} catch {
			return false;
		}
	};

	/** After a durable wake was sent: journal its resolve decision once per id. Returns true for the sweep. */
	const delivered = (entry: Pick<DurableWakeupEntry, "id" | "job_id">): true => {
		const payload = decided.get(entry.id);
		decided.delete(entry.id);
		if (payload && !journaled.has(entry.id)) {
			journaled.add(entry.id);
			journalWakeRule(runsOf(), entry.job_id, payload);
		}
		return true;
	};

	/** A single green CI fact the continuation already turned into a review is relayed and confirmed, not a turn. */
	const ciGreen = async (observations: readonly CiObservation[]): Promise<CiRuling> => {
		const only = observations.length === 1 ? observations[0] : undefined;
		if (!only || only.event !== "ci_green") return { suppress: false };
		// A later tick for a key still waiting on its outcome must not race it; the first pass owns the ruling.
		if (ciInFlight.has(only.key)) return { suppress: true, relay: "CI GREEN — already being handled in code.", keys: [] };
		ciInFlight.add(only.key);
		try {
			return await ciGreenRule(only);
		} finally {
			ciInFlight.delete(only.key);
		}
	};
	const ciGreenRule = async (only: CiObservation): Promise<CiRuling> => {
		const woke = (reason: string, extra: Record<string, unknown> = {}): CiRuling => {
			const once = `ci_green:${only.key}`;
			if (!journaled.has(once)) {
				journaled.add(once);
				journalWakeRule(runsOf(), only.job_id, { wake_rule: "ci_green", decision: "woke", reason, ...extra });
			}
			return { suppress: false };
		};
		try {
			const at = home();
			if (!at || !wakeRulesEnabled(at)) return woke("kill switch");
			const pending = deps.post().continuation.ciOutcome(only.key);
			if (!pending) return woke("no continuation outcome");
			const waitMs = deps.ciWaitMs ?? CI_RULE_WAIT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const bound = new Promise<undefined>((resolve) => {
				timer = setTimeout(resolve, waitMs, undefined);
				timer.unref();
			});
			const outcome: ContinuationOutcome | undefined = await Promise.race([pending, bound]).finally(() => clearTimeout(timer));
			if (!outcome) return woke(`continuation unsettled after ${waitMs}ms`);
			const reviewing = outcome.action === "review_started" || outcome.action === "review_pending";
			if (outcome.job_id !== only.job_id || !reviewing || outcome.next !== "review") return woke(`outcome ${outcome.action}/${outcome.next ?? "none"}`);
			let kind: NextActionKind;
			try {
				kind = (await next()).action.kind;
			} catch (error) {
				return woke(`cp_next failed: ${firstLine(error)}`);
			}
			if (!isQuietKind(kind)) return woke(`cp_next ${kind}`, { next_kind: kind });
			const project = homeProjectResolver(at)(only.job_id);
			const relay = `${project ? `[${project}] ` : ""}CI GREEN — ${outcome.reason} — handled in code, no parent turn.${only.pr_url ? ` ${only.pr_url}` : ""}`;
			journalWakeRule(runsOf(), only.job_id, { wake_rule: "ci_green", decision: "suppressed", reason: outcome.reason, next_kind: kind, action: outcome.action });
			return { suppress: true, relay, keys: [only.key] };
		} catch (error) {
			return woke(`rule failed: ${firstLine(error)}`);
		}
	};

	return { next, deferSweep, relayOnly, delivered, ciGreen, cache };
}
