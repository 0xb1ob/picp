/**
 * Failure enrichment for the file-editing tools (edit / replace / insert),
 * split out of index.ts to keep that module under its size cap.
 */

import { resolve } from "node:path";

/**
 * The built-in `edit` tool already throws a distinct message per failure
 * shape (not-found / duplicate-match / overlap), but the corpus shows workers
 * still retry blind: they see "could not find the exact text" and resend the
 * same oldText, or widen the wrong dimension. This does not replace that
 * message — it appends the one line the model needs to act differently on
 * retry: a named cause and the specific corrective move, not more prose.
 */
export interface EditFailureDiagnosis {
	cause: "no_match" | "not_unique" | "overlap";
	hint: string;
}

export function classifyEditFailure(errorText: string): EditFailureDiagnosis | undefined {
	if (/overlap in /.test(errorText)) {
		return {
			cause: "overlap",
			hint:
				"two edits in this same call target overlapping or adjacent text. Merge them into one edit, or apply them one at a time in separate edit calls instead of one call with several edits.",
		};
	}
	if (/Found \d+ occurrences/.test(errorText)) {
		return {
			cause: "not_unique",
			hint:
				"oldText matched more than once. Add a line of surrounding context (above or below) so it is unique — do not widen it more than that.",
		};
	}
	if (/Could not find (the exact text|edits\[)/.test(errorText)) {
		return {
			cause: "no_match",
			hint:
				"no exact match. Read the file again right now — a read from earlier in this turn is the most common cause of this — then copy oldText verbatim including whitespace and line breaks.",
		};
	}
	return undefined;
}

/** Which edit in the call failed. "edits[i]" appears only in the multi-edit message shape. */
export function extractFailedEditIndex(errorText: string): number {
	const match = /edits\[(\d+)\]/.exec(errorText);
	return match ? Number(match[1]) : 0;
}

/** Normalize the two input shapes the edit tool accepts into one edit list. */
export function editsFromToolInput(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(input.edits)) {
		return (input.edits as Array<{ oldText?: unknown; newText?: unknown }>)
			.filter((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
			.map((edit) => ({ oldText: edit.oldText as string, newText: edit.newText as string }));
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return [{ oldText: input.oldText, newText: input.newText }];
	}
	return [];
}

/**
 * The line(s) in `content` where `oldText` — or, failing that, its first
 * non-blank line — actually appears. Cheap (one or two linear scans, capped),
 * and exactly the fact a worker needs to stop guessing: for "no match" it is
 * the nearest real line to compare against; for "not unique" it is where the
 * duplicates are, so the model can pick distinguishing context instead of
 * widening blindly.
 */
export function findEditMatchLines(content: string, oldText: string, limit = 5): Array<{ line: number; text: string }> {
	const lineOf = (offset: number) => content.slice(0, offset).split(/\r?\n/).length;
	const hits: Array<{ line: number; text: string }> = [];
	let from = 0;
	while (hits.length < limit) {
		const at = content.indexOf(oldText, from);
		if (at === -1) break;
		const line = lineOf(at);
		hits.push({ line, text: content.split(/\r?\n/)[line - 1]?.trim().slice(0, 160) ?? "" });
		from = at + 1;
	}
	if (hits.length > 0) return hits;
	// No exact-substring hit at all (the "no match" case): fall back to the
	// first non-blank line of oldText, which is the cheapest useful near-miss —
	// it survives whitespace/indentation drift that broke the exact match.
	const firstLine = oldText.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
	if (!firstLine) return [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.includes(firstLine)) return [{ line: i + 1, text: line.trim().slice(0, 160) }];
	}
	// Last resort: a short prefix, in case the first line itself was edited too.
	const prefix = firstLine.slice(0, 24);
	if (prefix.length < 8) return [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.includes(prefix)) return [{ line: i + 1, text: line.trim().slice(0, 160) }];
	}
	return [];
}

/** Longest command text echoed back into a silent bash failure. */
export const BASH_COMMAND_ECHO_MAX = 300;

/**
 * pi's bash tool reports a non-zero exit with no output as just
 * "(no output)\n\nCommand exited with code N" — the run log then cannot say
 * what failed (audit cp-825v #8). Append the command text, truncated; any
 * other result is returned unchanged.
 */
export function enrichSilentBashFailure(errorText: string, input: Record<string, unknown> | undefined): string {
	if (!/^(\(no output\)\s*)?Command (exited with code \d+|terminated without an exit code)$/.test(errorText.trim())) {
		return errorText;
	}
	const command = typeof input?.command === "string" ? input.command.trim() : "";
	if (!command) return errorText;
	const shown =
		command.length > BASH_COMMAND_ECHO_MAX ? `${command.slice(0, BASH_COMMAND_ECHO_MAX)}… [truncated]` : command;
	return `${errorText}\n\nCommand: ${shown}`;
}

/**
 * The full enrichment: classify, then — where the file is still readable —
 * name the line(s) involved so the worker's next edit call can target them
 * directly instead of re-reading the whole file blind.
 */
export function enrichEditFailure(
	errorText: string,
	input: Record<string, unknown>,
	readFile: (path: string) => string,
): string {
	const diagnosis = classifyEditFailure(errorText);
	if (!diagnosis) return errorText;
	let detail = diagnosis.hint;
	const path = typeof input.path === "string" ? input.path : undefined;
	const edit = editsFromToolInput(input)[extractFailedEditIndex(errorText)];
	if (path && edit && (diagnosis.cause === "no_match" || diagnosis.cause === "not_unique")) {
		try {
			const content = readFile(path);
			const hits = findEditMatchLines(content, edit.oldText);
			const first = hits[0];
			if (hits.length === 1 && first && diagnosis.cause === "no_match") {
				detail += ` Nearest line — ${first.line}: ${first.text}`;
			} else if (hits.length > 0 && diagnosis.cause === "not_unique") {
				detail += ` Matches at line${hits.length > 1 ? "s" : ""} ${hits.map((h) => h.line).join(", ")}.`;
			}
		} catch {
			// File unreadable from here (renamed, deleted, path outside cwd) — keep
			// the cause and the hint; the near-miss line is a bonus, not a
			// requirement.
		}
	}
	return `${errorText}\n\ncause: ${diagnosis.cause} — ${detail}`;
}

/**
 * `replace`/`insert` (the hashline tools) fail with a code prefix or a schema
 * "Validation failed" block, and carry no oldText — so the edit enricher never
 * saw them (audit cp-0von #3). Same idea: name the cause and the next move.
 */
export function enrichAnchorEditFailure(errorText: string): { text: string; cause: string; path?: string } | undefined {
	let cause: string;
	let hint: string;
	if (/\[E_STALE_ANCHOR\]/.test(errorText)) {
		cause = "stale_anchor";
		// "not owned" is a missing claim (never served, usually a typo). A checksum mismatch says the file changed.
		hint = /not owned in this session/.test(errorText)
			? "this anchor was never served in this session; it is likely mistyped. Copy it exactly from a fresh read."
			: "the file changed since read. Call read on the file now and use anchors from that output.";
	} else if (/\[E_BAD_(REF|SHAPE)\]/.test(errorText)) {
		cause = "bad_anchor";
		hint = "pass bare 4-letter anchors (the text before │) from one file per call, and batch only disjoint ranges.";
	} else if (/^Validation failed for tool "(replace|insert)"/.test(errorText)) {
		cause = "bad_arguments";
		hint = "replace needs remove_from, remove_to and replacement_lines; insert needs anchor, direction and lines. Send every required field.";
	} else {
		return undefined;
	}
	const path = /(?:stale anchors? in|Call read\(\) on) (\S+?)[.:]?(?:\s|$)/.exec(errorText)?.[1];
	return { text: `${errorText}\n\ncause: ${cause} — ${hint}`, cause, path };
}

/** Identical misses on one path before the worker is told to stop and re-read. */
export const REREAD_AFTER_MISSES = 3;

/** Where a miss is tallied: the file when known, else the first anchor of the call. */
export interface MissScope {
	path?: string;
	anchor?: string;
}

/**
 * Per-process count of consecutive identical edit misses. "Identical" is a
 * same-scope, same-cause run — NOT the same call input: three different
 * oldTexts/anchors that all miss on one file are the stuck loop this catches.
 * Scope is the file; replace/insert inputs may not name one (their schema is
 * anchors only), so the anchor stands in — misses on different files are never
 * pooled, and a miss with neither scope is not counted. A different cause
 * restarts the run. reset(path) (a read or successful edit of that file) also
 * clears every anchor-scoped run, since those anchors are stale after a
 * re-read; reset() clears everything.
 */
export function createMissCounter() {
	const counts = new Map<string, { cause: string; n: number }>();
	const pathKey = (path: string) => `p:${resolve(process.cwd(), path)}`;
	return {
		/** Record a miss; returns the re-read instruction once it is the 3rd identical one. */
		miss(scope: MissScope, cause: string): string | undefined {
			const key = scope.path ? pathKey(scope.path) : scope.anchor ? `a:${scope.anchor}` : undefined;
			if (!key) return undefined;
			const prev = counts.get(key);
			const n = prev?.cause === cause ? prev.n + 1 : 1;
			counts.set(key, { cause, n });
			if (n < REREAD_AFTER_MISSES) return undefined;
			const label = scope.path ?? "the target file";
			return `Identical ${cause} failure #${n} on ${label}. Stop retrying: read ${label} again and rebuild the call from what it returns now.`;
		},
		reset(path?: string): void {
			if (path === undefined) return counts.clear();
			counts.delete(pathKey(path));
			for (const key of [...counts.keys()]) if (key.startsWith("a:")) counts.delete(key);
		},
	};
}

export interface EditResultEvent {
	toolName: string;
	input?: Record<string, unknown>;
	isError?: boolean;
	content: ReadonlyArray<{ type: string; text?: string }>;
}

const EDIT_TOOLS = ["edit", "replace", "insert"];

/**
 * The tool_result policy for edit/replace/insert (and read, for resets).
 * Returns replacement text for an enriched failure, else undefined (leave the
 * result alone).
 */
export function createEditResultEnricher(readFile: (path: string) => string) {
	const misses = createMissCounter();
	const reportedAborts = new Set<string>();
	return (event: EditResultEvent): string | undefined => {
		const input = event.input ?? {};
		const inputPath = typeof input.path === "string" ? input.path : undefined;
		if (!event.isError) {
			// Progress: a read or successful edit clears that file's run; a successful
			// replace/insert may not name a file, so it clears all.
			if ((event.toolName === "read" || event.toolName === "edit") && inputPath) misses.reset(inputPath);
			else if (EDIT_TOOLS.includes(event.toolName)) misses.reset();
			return undefined;
		}
		if (!EDIT_TOOLS.includes(event.toolName)) return undefined;
		const text = event.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
		// One cause per replace batch. Hashline still returns one result per call; siblings must not each restate it.
		if (/\[E_OP_ABORTED\]/.test(text)) {
			const batch = /\[E_OP_ABORTED\] Batch (\d+)/.exec(text)?.[1] ?? "?";
			if (/Call Nr \d+ errored \[/.test(text) || reportedAborts.has(batch)) {
				return `[E_OP_ABORTED] Batch ${batch} discarded; the cause was already reported on the failing call. Nothing was written.`;
			}
			reportedAborts.add(batch);
			return undefined;
		}
		let enriched = text;
		let cause: string | undefined;
		const scope: MissScope = { path: inputPath };
		if (event.toolName === "edit") {
			cause = classifyEditFailure(text)?.cause;
			enriched = enrichEditFailure(text, input, readFile);
		} else {
			const anchor = enrichAnchorEditFailure(text);
			cause = anchor?.cause;
			enriched = anchor?.text ?? text;
			scope.path ??= anchor?.path;
			const first = input.remove_from ?? input.anchor;
			if (typeof first === "string") scope.anchor = first;
		}
		if (!cause) return undefined;
		const reread = misses.miss(scope, cause);
		return reread ? `${enriched}\n\n${reread}` : enriched;
	};
}
