/**
 * System-one wake rules: wakes that code already acted on reach the operator as a relay, not a parent turn.
 * Every rule fails open (wakes the parent); the kill switch `data/wake-rules.json` fails closed. docs/contracts.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandPost } from "./command-post.ts";
import { type DurableWakeupEntry, isSafeJobId, LAYOUT } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { cpNext, type NextActionKind, type NextResult } from "./next.ts";
import type { RunRegistry } from "./runs.ts";

export const NEXT_CACHE_MAX_AGE_MS = 60_000;
export const RESOLVE_REFRESH_WAIT_MS = 10_000;
export const QUIET_NEXT_KINDS = ["wait", "no_mandate", "draining"] as const;

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
	return /^(?:\[[^\]\n]+\] )?(?:HELD PR LANDED — |HELD PR STOPPED — \S+ \(continuation, next: resolve\))/.test(text);
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

export type NextPost = Pick<CommandPost, "packageRoot" | "ledger" | "registry" | "fleet" | "mandates" | "escalations" | "pipelines" | "dispatchQueue">;

/** One in-process `cpNext` over the command post's own ports. */
export async function nextFor(post: NextPost, override?: typeof cpNext): Promise<NextResult> {
	return (override ?? cpNext)({
		packageRoot: post.packageRoot, ledger: post.ledger(), registry: post.registry,
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

export type WakeRulesPost = NextPost & Pick<CommandPost, "durableWakeups" | "runs">;

export interface WakeRulesDeps {
	home: () => string | undefined;
	post: () => WakeRulesPost;
	override?: typeof cpNext;
	resweep: () => void;
	now?: () => number;
	refreshWaitMs?: number;
}

/** The rules wakeup-surfaces asks before it wakes the parent. */
export function createWakeRules(deps: WakeRulesDeps) {
	const now = deps.now ?? Date.now;
	const cache = new NextCache();
	const journaled = new Set<string>();
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

	/** A resolve stop with the switch on and a fresh, quiet cp_next is relayed, not a turn; journaled once per id. */
	const relayOnly = (entry: Pick<DurableWakeupEntry, "id" | "job_id">): boolean => {
		if (!isResolveStop(entry.id)) return false;
		try {
			if (!wakeRulesEnabled(home())) return false;
			const state = cache.fresh(now());
			const quiet = "kind" in state && isQuietKind(state.kind);
			if (!journaled.has(entry.id)) {
				journaled.add(entry.id);
				const reason = "kind" in state ? `cp_next ${state.kind}` : state.reason;
				const nextKind = "kind" in state ? { next_kind: state.kind } : {};
				journalWakeRule(deps.post().runs, entry.job_id, { wake_rule: "held_stop_resolve", decision: quiet ? "relayed" : "woke", reason, ...nextKind });
			}
			return quiet;
		} catch {
			return false;
		}
	};

	return { next, deferSweep, relayOnly, cache };
}
