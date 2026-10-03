/**
 * Per-turn segments of a parent run (cp-kir8 PR-2): a run that keeps taking
 * follow-ups settles late, so a clean `turn_end` — the assistant finished a
 * text answer — closes a segment. At that point each landed send gets its
 * reply and the parent's own text since the last segment relays as a wake.
 */
import { markSpan } from "./parent-outbox.ts";
import type { LandedTurn } from "./parent-delivery.ts";

const UNCLEAN_STOPS: readonly string[] = ["error", "aborted", "length"];

/** pi's `turn_end` with no tool results and a stop reason that is not a failure or a cut-off. */
export function cleanSegmentEnd(event: { type: string; [key: string]: unknown }): boolean {
	if (event.type !== "turn_end" || !Array.isArray(event.toolResults) || event.toolResults.length > 0) return false;
	const stop = (event.message as { stopReason?: unknown } | undefined)?.stopReason;
	return typeof stop === "string" && !UNCLEAN_STOPS.includes(stop);
}

/** The texts from `from` on that no landed send's reply span covers: the parent's own (wake) text. */
export function wakeSpans(turn: Pick<LandedTurn, "texts" | "assistantCount" | "landed" | "answers">, from: number): string[] {
	const spans = turn.landed.map((mark) => [mark.index, markSpan(turn, mark).end] as const);
	return turn.texts.slice(from).filter((_, offset) => !spans.some(([start, end]) => start <= from + offset && from + offset < end));
}
