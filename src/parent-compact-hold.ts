/**
 * C1/picp-80q: the parent's compaction hold. Once a headless parent's context reads
 * at or above `compact_at_tokens` (a `turn_end` mid-run, or `agent_settled`), every
 * wake it would send is held, so no model call starts on that context before the
 * bridge compacts it. Released only by a compaction (`session_compact`), a failed
 * manual compaction, the start timer, the cap, or a settle that reads below the
 * threshold; `agent_start` never releases. Three consecutive failures or expiries
 * disable holding until the next compaction. Pure state like `SendFirstGate`; the
 * caller (extensions/command-post/wakeup-surfaces.ts) owns the transport.
 */
import { isHeadlessParent } from "./parent-session.ts";
import { effectiveContextTokens, lastValidAssistant, parentSettings } from "./parent-context.ts";

/** No compaction start this long after an over-threshold settle: release (the bridge did not compact). */
export const PARENT_COMPACT_START_MS = 15_000;
/** Longer than the bridge's 120 s compact RPC timeout. */
export const PARENT_COMPACT_HOLD_MS = 150_000;
export const PARENT_COMPACT_MAX_FAILURES = 3;

export interface ContextReading {
	over: boolean;
	raw: number | null;
	effective: number | null;
	threshold?: number;
}

/** The ctx fields read, structurally (pi `ExtensionContext`), so `src/` takes no pi import. */
export interface HoldContext {
	mode: string;
	getContextUsage?: () => { tokens: number | null } | undefined;
	sessionManager?: { getBranch(): readonly unknown[] };
}

const NOT_OVER: ContextReading = { over: false, raw: null, effective: null };

/** Never over without a ctx, off a headless parent, or with no threshold (nobody compacts, so nothing may hold). */
export function contextOver(ctx: HoldContext | undefined, home: () => string, env: NodeJS.ProcessEnv = process.env): ContextReading {
	if (!ctx || !isHeadlessParent(ctx, env)) return NOT_OVER;
	try {
		const threshold = parentSettings(home()).compact_at_tokens;
		if (!threshold) return NOT_OVER;
		const raw = ctx.getContextUsage?.()?.tokens ?? null;
		const effective = effectiveContextTokens(raw, lastValidAssistant(ctx.sessionManager?.getBranch()));
		return { over: effective !== null && effective >= threshold, raw, effective, threshold };
	} catch (error) {
		process.stderr.write(`pi-command-post: context reading failed, not holding: ${(error as Error).message}\n`);
		return NOT_OVER;
	}
}

/**
 * N6 in pi's own trigger: a `threshold` compaction whose last valid assistant is a
 * `length` stop, and whose effective tokens are under `compact_at_tokens`, is cancelled.
 * `manual` and `overflow` are never touched.
 */
export function thresholdCancel(
	event: { reason?: string; preparation?: { tokensBefore?: number }; branchEntries?: readonly unknown[] },
	home: string,
	log: (line: string) => void,
): { cancel: true } | undefined {
	if (event.reason !== "threshold") return undefined;
	const threshold = parentSettings(home).compact_at_tokens;
	const last = lastValidAssistant(event.branchEntries);
	const before = event.preparation?.tokensBefore;
	if (!threshold || last?.stopReason !== "length" || typeof before !== "number") return undefined;
	const effective = effectiveContextTokens(before, last)!;
	if (effective >= threshold) return undefined;
	log(`threshold_compaction_cancelled tokens_before=${before} effective=${effective} threshold=${threshold}`);
	return { cancel: true };
}

type Phase = "idle" | "busy" | "awaiting_start" | "compacting";

export interface HoldPorts {
	now?: () => number;
	/** Arms a timer; returns its cancel. Default: the global `setTimeout` at call time (mock timers apply), unref'd. */
	timer?: (fn: () => void, ms: number) => () => void;
	log?: (line: string) => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
	const handle = setTimeout(fn, ms) as { unref?: () => void };
	handle.unref?.();
	return () => clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
};

export class ParentCompactHold {
	readonly #now: () => number;
	readonly #timer: (fn: () => void, ms: number) => () => void;
	readonly #log: (line: string) => void;
	#held: Array<() => void> = [];
	#phase: Phase = "idle";
	#since = 0;
	#failures = 0;
	#enabled = true;
	#cancelStart: (() => void) | undefined;
	#cancelCap: (() => void) | undefined;

	constructor(ports: HoldPorts = {}) {
		this.#now = ports.now ?? Date.now;
		this.#timer = ports.timer ?? defaultTimer;
		this.#log = ports.log ?? (() => undefined);
	}

	get holding(): boolean {
		return this.#phase !== "idle";
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	/** `hold` keeps `fn` until the release; `send` means call it now. */
	offer(fn: () => void): "send" | "hold" {
		if (!this.holding) return "send";
		this.#held.push(fn);
		return "hold";
	}

	/** Every `turn_end`: an over reading holds from here, so no wake becomes a follow-up of this run. No timer: the run's own settle bounds it. */
	turnEnded(reading: ContextReading): void {
		if (reading.over && !this.holding) this.#engage("busy", reading);
	}

	/** Every `agent_settled`: over holds and waits for the bridge's compaction start; not over releases. */
	settled(reading: ContextReading): void {
		if (reading.threshold !== undefined && reading.raw !== null && reading.raw >= reading.threshold && !reading.over) {
			this.#log(`hold skipped_length_stop raw=${reading.raw} effective=${reading.effective} threshold=${reading.threshold}`);
		}
		if (!reading.over) {
			if (this.holding) this.#release("not_over", false);
			return;
		}
		if (!this.holding && !this.#engage("settled", reading)) return;
		if (this.#phase === "compacting") return;
		this.#phase = "awaiting_start";
		this.#cancelStart?.();
		this.#cancelStart = this.#timer(() => this.#release("start_timeout", true), PARENT_COMPACT_START_MS);
	}

	/** `agent_start`: a run from an unheld source. Never a release: that would make every held wake its follow-up. */
	runStarted(): void {
		if (!this.holding) return;
		this.#cancelStart?.();
		this.#cancelStart = undefined;
		if (this.#phase !== "compacting") this.#phase = "busy";
	}

	/** `session_before_compact` reason `manual` (the bridge's compact RPC). */
	compactionStarted(): void {
		if (!this.holding) return;
		this.#cancelStart?.();
		this.#cancelStart = undefined;
		this.#phase = "compacting";
		this.#cancelCap?.();
		this.#cancelCap = this.#timer(() => this.#release("cap_timeout", true), PARENT_COMPACT_HOLD_MS);
	}

	/** `session_compact`, any reason. */
	compacted(): void {
		this.#failures = 0;
		this.#enabled = true;
		if (this.holding) this.#release("compacted", false);
	}

	/** `session_compact_failed` reason `manual` only (a threshold cancel comes back as one too). */
	failed(): void {
		if (this.holding) this.#release("failed", true);
	}

	#engage(phase: "busy" | "settled", reading: ContextReading): boolean {
		if (!this.#enabled) return false;
		this.#phase = phase === "busy" ? "busy" : "awaiting_start";
		this.#since = this.#now();
		this.#log(`hold engaged phase=${phase} raw=${reading.raw} effective=${reading.effective} threshold=${reading.threshold}`);
		return true;
	}

	#release(reason: string, failure: boolean): void {
		this.#cancelStart?.();
		this.#cancelCap?.();
		this.#cancelStart = this.#cancelCap = undefined;
		const held = this.#held;
		this.#held = [];
		this.#phase = "idle";
		this.#log(`hold released reason=${reason} held=${held.length} ms=${this.#now() - this.#since}`);
		if (failure && ++this.#failures === PARENT_COMPACT_MAX_FAILURES) {
			this.#enabled = false;
			this.#log(`hold disabled failures=${this.#failures}`);
		}
		for (const fn of held) fn();
	}
}
