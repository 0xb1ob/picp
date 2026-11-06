/**
 * Native turn lifecycle (N4e): how a finished turn ends, and the admission an idle prompt passes before a resumed turn.
 * A clean unreported turn settles idle for settle.ts to nudge; a window, auth or lockdown stop is a named failure.
 */
import { assertNativeResume } from "./claude-followup.ts";
import type { NativeObservation } from "./claude-observation.ts";

export type NativeStop = "window" | "auth" | "lockdown" | "other";
export type TurnEnd =
	| { kind: "reported" | "settle" | "turn_limit" }
	| { kind: "stop"; stop: NativeStop; window?: string; resets_at?: number };

export interface TurnFacts {
	reported: boolean;
	resultSubtype?: string;
	/** The SDK result's `is_error`: a `success` subtype can still carry an API error. */
	isError?: boolean;
	error?: string;
	lockdown: string;
	observations: readonly NativeObservation[];
}

/** One finished turn's end; a named stop (lockdown, auth, a rejected window) wins over every unreported outcome. */
export function classifyTurn(facts: TurnFacts): TurnEnd {
	if (facts.reported) return { kind: "reported" };
	if (facts.lockdown === "refused") return { kind: "stop", stop: "lockdown" };
	if (facts.observations.some((seen) => seen.kind === "auth")) return { kind: "stop", stop: "auth" };
	const spent = facts.observations.find((seen) => seen.kind === "window" && seen.status === "rejected");
	if (spent?.kind === "window") return { kind: "stop", stop: "window", window: spent.window, ...(spent.resets_at === undefined ? {} : { resets_at: spent.resets_at }) };
	if (facts.resultSubtype === "error_max_turns") return { kind: "turn_limit" };
	const clean = facts.resultSubtype === "success" && facts.isError !== true && facts.error === undefined && facts.lockdown === "ok";
	return clean ? { kind: "settle" } : { kind: "stop", stop: "other" };
}

/** The `native_run` stop fields failures.ts reads, and the stderr line; none for a reported, settled or other end. */
export function nativeRunStop(end: TurnEnd, maxTurns: number): { fields: Record<string, unknown>; line?: string } {
	if (end.kind === "turn_limit") return { fields: { stop: "max_turns" }, line: `stopped at the turn limit (${maxTurns} turns)` };
	if (end.kind !== "stop" || end.stop === "other") return { fields: {} };
	const fields = { stop: end.stop, ...(end.window ? { window: end.window } : {}), ...(end.resets_at === undefined ? {} : { resets_at: end.resets_at }) };
	return { fields, line: `stopped: ${end.stop}${end.window ? ` (${end.window})` : ""}; a named failure, never a nudge` };
}

/** The idle-prompt refusal's closing words: no turn started. */
export const NOT_RESUMED = "Nothing was resumed.";

/**
 * An idle prompt (`worker.send` skips send.ts admission): a resumed turn passes `admit` first, then `start` runs.
 * Returns the named refusal, in which case `start` never ran; a first, dispatched turn was admitted by dispatch.
 */
export async function startIdlePrompt(
	input: { home: string; jobId: string; resumed: boolean },
	start: () => void,
	admit: typeof assertNativeResume = assertNativeResume,
): Promise<string | undefined> {
	if (input.resumed) {
		try {
			await admit({ home: input.home, jobId: input.jobId, what: "resume" });
		} catch (error) {
			return `${(error as Error).message}. ${NOT_RESUMED}`;
		}
	}
	start();
	return undefined;
}
