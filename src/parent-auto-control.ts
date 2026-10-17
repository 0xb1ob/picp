/**
 * The bridge's automatic parent context control after a settle or ready (C1/picp-80q):
 * one `autoParentContext` pass, then exactly one `state/daemon.log` line per outcome
 * at or above the threshold (and per rotate), plus the operator error relay for a
 * failure. Moved out of `cp-bridge.ts` with its outer-retry journal.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { type AssistantLike, autoParentContext, parentContextLog } from "./parent-context.ts";

const SOURCE = "cp-parent-host";

/** Never rejects. `relayError` carries what the operator must see: a failed rotate, compact or read. */
export async function runAutoControl(
	home: string,
	missionEnd: string | undefined,
	lastAssistant: AssistantLike | undefined,
	control: Parameters<typeof autoParentContext>[3],
	relayError: (text: string) => void,
): Promise<void> {
	// An unreadable store (mandates, parent.json) is a failure the operator sees, never an unhandled rejection.
	const outcome = await autoParentContext(home, missionEnd, lastAssistant, control)
		.catch((error: Error): Awaited<ReturnType<typeof autoParentContext>> => ({ event: "failed", error: error.message }));
	const log = (line: string) => parentContextLog(home, SOURCE, line);
	if (outcome.rotated) log(`rotated mission=${outcome.rotated} trigger=${JSON.stringify(outcome.trigger)}`);
	if (outcome.rotateFailed !== undefined) {
		log(`rotate_failed mission=${outcome.mission} trigger=${JSON.stringify(outcome.trigger)} error=${JSON.stringify(outcome.rotateFailed)}`);
		relayError(`parent mission-end rotation failed: ${outcome.rotateFailed}`);
	}
	if (!outcome.event) return;
	const tokens = outcome.raw !== undefined ? ` raw=${outcome.raw} effective=${outcome.effective} threshold=${outcome.threshold}` : "";
	if (outcome.event === "compacted") log(`compacted before=${outcome.before ?? "unknown"} after=${outcome.after ?? "unknown"} ms=${outcome.ms}${tokens}`);
	else if (outcome.event === "skipped_length_stop") log(`skipped_length_stop${tokens}`);
	else if (outcome.event === "refused") log(`refused ${outcome.error}${tokens}`);
	else {
		log(`${outcome.event}${outcome.ms !== undefined ? ` ms=${outcome.ms}` : ""}${tokens} error=${JSON.stringify(outcome.error)}`);
		const next = outcome.event === "timed_out"
			? "; retry the compaction once the parent has settled — a rotation or restart can abort running workers and is no substitute for that retry"
			: "";
		relayError(`parent automatic context control ${outcome.event === "timed_out" ? "timed out" : "failed"}: ${outcome.error}${next}`);
	}
}

/** Anthropic's default prompt-cache TTL: a rebuild after a longer gap is expected, not a defect. */
export const PROMPT_CACHE_TTL_SECONDS = 300;

/** N1(c): a `cache_rebuild` line when a prompt kept its size inside the cache TTL but read under half the last one. */
export function cacheRebuildLine(prev: AssistantLike | undefined, next: AssistantLike): string | undefined {
	const prompt = (message: AssistantLike) => (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0);
	if (typeof prev?.timestamp !== "number" || typeof next.timestamp !== "number") return undefined;
	const gap = (next.timestamp - prev.timestamp) / 1000, before = prompt(prev), cacheRead = next.usage?.cacheRead ?? 0;
	// A compaction shrinks the prompt itself; only a prompt that kept its size but lost its cache is a rebuild.
	if (gap < 0 || gap > PROMPT_CACHE_TTL_SECONDS || cacheRead >= before / 2 || prompt(next) < before / 2) return undefined;
	return `cache_rebuild cr=${cacheRead} prev=${before} gap_s=${Math.round(gap)}`;
}

/** The bridge's per-assistant hook: logs a `cacheRebuildLine` to daemon.log, returns the assistant to keep. */
export function trackAssistant(home: string | undefined, prev: AssistantLike | undefined, next: AssistantLike | undefined): AssistantLike | undefined {
	const line = next && cacheRebuildLine(prev, next);
	if (home && line) parentContextLog(home, SOURCE, line);
	return next ?? prev;
}

/**
 * H1 review (finding 2): the bridge keeps no per-turn run log the way a job
 * does. This is the smallest durable record it does keep now — one
 * append-only JSONL file beside `parent.lock`, in the same `state/` this
 * home already owns — so an outer-ladder attempt, success or exhaustion for
 * the parent survives a restart instead of living only in the relay stream
 * (which nothing durable consumes today). Never throws: a journal that can't
 * write must not take the ladder down with it.
 */
export function journalBridgeEvent(home: string | undefined, event: string, payload: Record<string, unknown>): void {
	if (!home) return;
	try {
		const dir = join(home, LAYOUT.state);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "bridge-retry.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`);
	} catch {
		// Best-effort durability: a journal write failing must never stall or crash the ladder.
	}
}
