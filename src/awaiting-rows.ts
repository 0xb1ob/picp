/**
 * Awaiting-you rows: from the parent's judgment to the store, and only then to
 * the table (cp-nz95).
 *
 * The status block is the parent's only report to the operator, and for one
 * session it lied: `cp_status_block` upserted the caller's `awaiting` rows into
 * `AwaitingStore` **and rendered them**, but the two steps disagreed. A row the
 * store refused (`type: "authorization"`, or prose that reads like an
 * authorization request) still printed under "Awaiting you" as though it were
 * live, and a row the merge-ask gate deferred printed there too. The operator
 * was told three decisions awaited them; `cp_decide` offered one.
 *
 * The invariant this module exists to hold:
 *
 *   **a row is rendered as open if and only if the store holds it `open`.**
 *
 * Everything else is a notice, not a question: a refused row prints under the
 * table with the store's own refusal (which names the fix), a deferred one
 * prints under the table as "not asked yet". Neither is answerable and neither
 * is silent, which is the whole point — the bug was never strictness, it was
 * that strictness had no voice.
 *
 * The declaring loop lives here, apart from the extension, so the invariant is
 * testable against a real `AwaitingStore` instead of only reachable through a
 * registered tool.
 */

import { AUTHORIZATION_TYPE_REFUSAL, obsoleteDeclaredReason, type DeclareInput, type DeclareOutcome } from "./awaiting.ts";
import type { StatusJob } from "./contracts.ts";
import { MAX_CELL_CHARS, type StatusBlockAwaitingInput, type StatusBlockMergeAskInput, type StatusBlockRefusedInput } from "./status-block.ts";

/** The one method this needs from `AwaitingStore` — injectable in tests. */
export interface AwaitingDeclarer {
	declareGated(input: DeclareInput): Promise<DeclareOutcome>;
}

export interface ResolvedAwaitingRows {
	/** Rows the store holds `open`: exactly what may be rendered as a question. */
	rendered: StatusBlockAwaitingInput[];
	/** Stored, but not asked yet — the CI gate deferred them (cp-gmy). */
	mergeAsks: StatusBlockMergeAskInput[];
	/** Not stored at all, and why (cp-nz95). Never rendered as open. */
	refused: StatusBlockRefusedInput[];
}

/**
 * A row that resolved to an already-answered or already-withdrawn record is
 * neither open nor refused: re-rendering a decision a human has answered is
 * normal parent behaviour under delivery lag. It is dropped from the table (it
 * is not an open question) and reported as a notice, never as an ask.
 */
function settledNotice(state: string, decision: string): string {
	// The caller's prose is quoted last and bounded: a long decision may cost the
	// quote its tail at the renderer's bound, never the sentence that says what to
	// do about it. (The tool schema already caps `decision`, but this function is
	// exported behaviour, not a tool-only path.)
	const quoted = decision.trim();
	const short = quoted.length <= MAX_CELL_CHARS ? quoted : `${quoted.slice(0, MAX_CELL_CHARS - 1)}\u2026`;
	return (
		`this decision is already ${state} in state/awaiting.json, so it is not an open question and nothing was ` +
		`re-asked. Ask a new question if it needs deciding again, rather than re-rendering: "${short}"`
	);
}

/**
 * Declare every supplied row and partition the outcomes. Nothing here throws:
 * a store that cannot write is a refusal with the error attached, which is
 * louder than the warning-and-render-anyway it replaces.
 */
export async function resolveAwaitingRows(
	supplied: readonly StatusBlockAwaitingInput[],
	declarer: AwaitingDeclarer,
	jobs: readonly StatusJob[] = [],
): Promise<ResolvedAwaitingRows> {
	const rendered: StatusBlockAwaitingInput[] = [];
	const mergeAsks: StatusBlockMergeAskInput[] = [];
	const refused: StatusBlockRefusedInput[] = [];

	for (const row of supplied) {
		// `authorization` never reaches the store: only a checkpoint authorizes,
		// and the status block must not write one by any path. Refusing it here
		// rather than catching the store's throw keeps the type honest — and the
		// message is the store's own, so the two can never drift apart.
		if ((row.type as string) === "authorization") {
			refused.push({ type: row.type, decision: row.decision, reason: AUTHORIZATION_TYPE_REFUSAL, ...(row.job_id ? { job_id: row.job_id } : {}) });
			continue;
		}
		// cp-f9jh: a row about a job that is already done/closed/merged is not a
		// question anybody can answer. It is refused before the store is touched, so
		// no row is minted for a decision the world has taken — and the notice says
		// so under the table rather than dropping it silently.
		const obsolete = obsoleteDeclaredReason({ ...(row.job_id ? { job_id: row.job_id } : {}) }, jobs);
		if (obsolete) {
			refused.push({ type: row.type, decision: row.decision, reason: obsolete, ...(row.job_id ? { job_id: row.job_id } : {}) });
			continue;
		}
		let outcome: DeclareOutcome;
		try {
			outcome = await declarer.declareGated({
				type: row.type as "approval" | "design",
				decision: row.decision,
				why: row.why,
				blocks: row.blocks,
				...(row.job_id ? { job_id: row.job_id } : {}),
			});
		} catch (error) {
			refused.push({
				type: row.type,
				decision: row.decision,
				reason: (error as Error).message,
				...(row.job_id ? { job_id: row.job_id } : {}),
			});
			continue;
		}
		if (outcome.raised) {
			rendered.push({ ...row, id: outcome.item.id, ...(outcome.lint ? { lint: outcome.lint } : {}) });
			continue;
		}
		// cp-p1sh: the merge this row asks about has already happened, so the row was
		// recorded and closed rather than asked. It is a notice under the table (once,
		// because a closed row is never re-rendered), not a settled-row scolding: the
		// parent asked a legitimate question that answered itself in the meantime.
		if (outcome.gate?.ci === "already_merged") {
			mergeAsks.push({
				kind: "already_merged",
				decision: row.decision,
				reason: outcome.gate.reason,
				id: outcome.item.id,
				...(row.job_id ? { job_id: row.job_id } : {}),
			});
			continue;
		}
		if (outcome.item.state === "deferred") {
			// Stored, re-reviewed on every render, raised by itself once CI finishes:
			// a notice under the table, never a row the operator is asked to answer.
			mergeAsks.push({
				kind: outcome.gate?.ci === "failed" ? "ci_failed" : "deferred",
				decision: row.decision,
				reason: outcome.gate?.reason ?? outcome.item.deferred_reason ?? "held back by the merge-ask gate",
				id: outcome.item.id,
				...(row.job_id ? { job_id: row.job_id } : {}),
			});
			continue;
		}
		refused.push({
			type: row.type,
			decision: row.decision,
			reason: settledNotice(outcome.item.state, row.decision),
			...(row.job_id ? { job_id: row.job_id } : {}),
		});
	}

	return { rendered, mergeAsks, refused };
}
