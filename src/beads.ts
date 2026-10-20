/** br show emits a singleton array; older versions emitted the object directly. */
export function decodeBrShow(raw: string): { title?: string; status: string; description?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid br show response: ${(error as Error).message}`);
	}
	const bead = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
	if (!bead || typeof bead !== "object" || !("status" in bead) || typeof bead.status !== "string") {
		throw new Error("invalid br show response: expected one bead with a status");
	}
	return {
		status: bead.status,
		...("title" in bead && typeof bead.title === "string" ? { title: bead.title } : {}),
		...("description" in bead && typeof bead.description === "string" ? { description: bead.description } : {}),
	};
}

export const BR_READ_ONLY = ["--no-auto-flush", "--no-auto-import"];

/** A bare `br show <id> --json` external_ref, with nothing else after `--json`. */
const BARE_BR_SHOW_RE = /^br show (\S+) --json$/;

/**
 * POSIX single-quote a shell word: end the quote, emit an escaped quote,
 * reopen it. Safe for any byte a path can contain — spaces, `$`, backticks,
 * a literal `'` — so the stored ref is a copy-pasteable, one-line shell
 * command regardless of what the project's checkout path looks like.
 */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Rewrite a bare `br show <id> --json` external_ref to pin the project's
 * beads DB (`br --db '<path>' show <id> --json`), so the command still works
 * from a leased worktree whose `.beads/` is gitignored. The path is always
 * shell-quoted, because a project's checkout path is operator-chosen and may
 * contain a space or another shell-sensitive character. Any other shape — a
 * url, a file path, another tracker id, an already-`--db`-pinned command, or
 * a bare command with no resolvable DB — passes through unchanged.
 */
export function normalizeExternalRef(ref: string, dbPath: string | undefined): string {
	if (!dbPath) return ref;
	const match = BARE_BR_SHOW_RE.exec(ref);
	if (!match) return ref;
	return `br --db ${shellQuote(dbPath)} show ${match[1]} --json`;
}
