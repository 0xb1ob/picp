/**
 * Per-turn segments of a parent run (cp-kir8 PR-2): a run that keeps taking
 * follow-ups settles late, so a clean `turn_end` — the assistant finished a
 * text answer — closes a segment. At that point each landed send gets its
 * reply and the parent's own text since the last segment relays as a wake.
 */
import type { BridgeRelay } from "./cp-bridge.ts";
import type { ModelCallError } from "./failures.ts";
import { markSpan } from "./parent-outbox.ts";
import type { LandedMark, LandedTurn } from "./parent-delivery.ts";
import type { EnvelopeSummary } from "./relay-scope.ts";

export interface TurnBuf {
	texts: string[];
	stale: boolean;
	jobId?: string;
	jobIds: string[];
	assistantCount: number;
	/** Set/cleared by each assistant message_end; only the LAST one survives. */
	error?: ModelCallError;
	/** Sends whose marker landed in this run. */
	landed: LandedMark[];
	answers: number[];
	/** Refused cp_escalate calls, relayed at settle unless a later call in this run succeeds. */
	refused: BridgeRelay[];
	/** Accepted cp-envelope wake-ups seen this run (issue #2); appended verbatim to the wake relay. */
	envelopes: EnvelopeSummary[];
	/** Segment cursor (bridge-segments.ts): `texts` before it already relayed; jobs stamped since the last wake relay. */
	relayed: number;
	segJobIds: string[];
	/** `idleNextKey` of a run whose only tool call was an idle cp_next; null once anything else happened. */
	idleKey?: string | null;
}

export const freshTurn = (): TurnBuf => ({ texts: [], stale: false, jobIds: [], assistantCount: 0, landed: [], answers: [], refused: [], envelopes: [], relayed: 0, segJobIds: [] });

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
