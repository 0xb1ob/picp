/**
 * Test-only answering harness. Production retired the overlay that called it; the
 * outbox and one-decision tests still drive the real writers (`CheckpointStore.decide`,
 * `AwaitingStore.answerResolved`) through this one resolver, so they live here.
 */
import { AwaitingError, authorizationVerdict, type ResolvedAwaitingItem } from "../../src/awaiting.ts";
import type { CheckpointKind } from "../../src/contracts.ts";

/** One operator response to one open item. */
export type AwaitingResponse =
	| { id: string; kind: "answer"; value: string; by: string }
	| { id: string; kind: "skip" }
	| { id: string; kind: "cancel" };

export interface AwaitingWriters {
	/** Only channel that may record an authorization; `kind` picks the checkpoint, `scope` is a merge's head sha. */
	decideCheckpoint: (
		jobId: string,
		approved: boolean,
		by: string,
		kind: CheckpointKind,
		scope?: string,
	) => Promise<void> | void;
	/** Takes the whole resolved row: a derived row does not exist in the store yet. */
	answerDeclared: (item: ResolvedAwaitingItem, answer: string, by: string) => Promise<void> | void;
	answerEscalation?: (id: string, answer: string, by: string) => Promise<void> | void;
}

/**
 * Resolve one response against the writers. `skip`/`cancel` write nothing; free text on an
 * `authorization` item that is not approve/decline is a note only; a mismatched id throws.
 */
export async function resolveAwaitingResponse(
	response: AwaitingResponse,
	item: ResolvedAwaitingItem,
	writers: AwaitingWriters,
): Promise<{ wrote: boolean; note?: string }> {
	if (response.kind === "skip" || response.kind === "cancel") return { wrote: false };
	if (response.id !== item.id) {
		throw new AwaitingError(
			`answer is for ${response.id} but the item offered is ${item.id} — the id shown is the id answered. ` +
				"Re-list with /cp-decide and answer the id it prints.",
		);
	}
	if (item.type === "escalation" || item.id.startsWith("es-")) {
		if (!writers.answerEscalation) {
			throw new AwaitingError(`${item.id} is an escalation: wire answerEscalation on the writers`);
		}
		await writers.answerEscalation(item.id, response.value, response.by);
		return { wrote: true };
	}
	if (item.type === "authorization") {
		if (!item.job_id) throw new AwaitingError("an authorization item must carry a job_id");
		const value = response.value.trim();
		const verdict = authorizationVerdict(value);
		const kind: CheckpointKind = item.checkpoint_kind ?? "ship";
		const scope = item.checkpoint_scope;
		if (verdict === "approve") {
			await writers.decideCheckpoint(item.job_id, true, response.by, kind, scope);
			return { wrote: true };
		}
		if (verdict === "decline") {
			await writers.decideCheckpoint(item.job_id, false, response.by, kind, scope);
			return { wrote: true };
		}
		return { wrote: false, note: value };
	}
	await writers.answerDeclared(item, response.value, response.by);
	return { wrote: true };
}
