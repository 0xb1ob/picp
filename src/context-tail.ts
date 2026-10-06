/**
 * N9: withholding a stale wake-up must never leave the model context ending on an
 * assistant message — providers without assistant prefill answer that with a 400.
 */

/** Neutral stand-in: no stamp, no stale body, nothing to act on. */
export const WITHHELD_TAIL_TEXT =
	"A fleet notice queued for this turn was withdrawn before delivery because it no longer applies. Nothing needs doing; end the turn.";

/**
 * `fresh` is `input` with withheld messages dropped. When that drop leaves an
 * assistant tail the input did not have, append one `custom` stand-in (pi maps
 * `custom` to user). Returns a new array; neither input is mutated.
 */
export function keepUserTail<T extends { role: string }>(input: readonly T[], fresh: readonly T[]): T[] {
	const dropped = input.at(-1);
	if (fresh.at(-1)?.role !== "assistant" || !dropped || dropped.role === "assistant") return [...fresh];
	const stamped = (dropped as { timestamp?: unknown }).timestamp;
	const timestamp = typeof stamped === "number" ? stamped : Date.now();
	const standIn = { role: "custom", customType: "cp-withheld-tail", content: WITHHELD_TAIL_TEXT, display: false, timestamp };
	// SAFETY: the stand-in is the pi custom-message shape every T here already admits.
	return [...fresh, standIn as unknown as T];
}
