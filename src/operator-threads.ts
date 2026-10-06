/**
 * cp-xmw2 S2: the optional `thread` on `cp_parent ask`/`answer`. Operator-session bookkeeping only; never authority.
 * The tag is validated before any journal write; filing the ask-/ans- id afterwards never throws, it names its failure.
 */
import { isoTimestamp } from "./contracts.ts";
import { bindThread } from "./viewer/control-audit.ts";
import { normalizeThreadTag, type ThreadRef } from "./viewer/control-files.ts";

export interface ThreadFiling { tag: string; id: string | null; error: string | null }

/** The normalized tag, or a throw naming the rule. */
export function threadTag(raw: string): string {
	const tag = normalizeThreadTag(raw);
	if (tag === null) throw new Error(`thread must be a tag (1-32 of a-z 0-9 -, first a letter or digit): ${JSON.stringify(raw)}`);
	return tag;
}

/** Bind `ref` under `tag` in state/operator/threads.jsonl as the bridge. Never throws: a failure is in `note` and `details.error`. */
export function fileUnderThread(stateDir: string, tag: string, ref: ThreadRef, now: Date = new Date()): { note: string; details: ThreadFiling } {
	const bound = bindThread(stateDir, { tag, ref, by: "bridge", peer: null, at: isoTimestamp(now) });
	return bound.ok
		? { note: `; filed under thread ${tag} (${bound.thread})`, details: { tag, id: bound.thread, error: null } }
		: { note: `; thread ${tag} NOT filed: ${bound.error}`, details: { tag, id: null, error: bound.error } };
}
