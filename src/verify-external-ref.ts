/**
 * Verify `external_ref` before intake trusts it (pi-command-post-autonomy-programme-cur.4.5).
 *
 * The first live mission recorded `https://github.com/example-org/example-infra/issues/12` as a job's
 * `external_ref` and dispatched an implementer against it — the number was a **merged PR**, not
 * the open issue the operator described, and `example-infra` had zero open issues at the time. Nothing
 * read the ref before trusting it.
 *
 * This module is the read: no model, one `gh api` call for a GitHub issue/PR url, one `br show`
 * for a `br` tracker ref (reusing the exact command the ledger already stores), one `existsSync`
 * for a file path. It never writes anything and never decides whether the result is a mismatch —
 * that policy (refuse vs. note vs. pass) lives at the call site, because "unverifiable" and "the
 * operator was wrong" are different facts and only the caller knows what to do with each.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BR_READ_ONLY, decodeBrShow } from "./beads.ts";
import { type CommandRunner, runCommand } from "./merge-ask.ts";

const GITHUB_REF_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;
/** Mirrors `ledger.ts`'s `BARE_BR_SHOW_RE`, plus the `--db '<path>'`-pinned form it rewrites to. */
export const BR_SHOW_RE = /^br(?: --db (.+?))? show (\S+) --json$/;

/** Reverses `ledger.ts`'s `shellQuote`. */
export function unshellQuote(value: string): string {
	if (!(value.startsWith("'") && value.endsWith("'"))) return value;
	return value.slice(1, -1).replaceAll(`'\\''`, `'`);
}

export type RefVerification =
	| { status: "found"; kind: "issue" | "pr"; state: "open" | "closed" | "merged"; title: string; url: string }
	/** A `br` tracker ref: `state` is whatever the tracker's own `status` field says (e.g. `open`, `closed`). */
	| { status: "found"; kind: "br"; state: string; title: string; url: string }
	| { status: "found"; kind: "file"; state: "exists"; url: string }
	/** The ref resolves to nothing: a 404, or a file that is not there. */
	| { status: "not_found"; url: string }
	/** Not a shape this module reads (a Jira link, a bare sentence, …). Not an error. */
	| { status: "unverifiable" }
	/** `gh`/`br` could not be asked at all — ignorance, not a mismatch. */
	| { status: "unreachable"; message: string };

export interface VerifyExternalRefOptions {
	exec?: CommandRunner;
	cwd?: string;
	timeoutMs?: number;
}

async function verifyGithubRef(
	url: string,
	match: RegExpMatchArray,
	options: VerifyExternalRefOptions,
): Promise<RefVerification> {
	// SAFETY: GITHUB_REF_RE supplies all four capture groups before this call.
	const [, owner, repo, segment, number] = match as unknown as [string, string, string, string, string];
	const exec = options.exec ?? runCommand;
	let stdout: string;
	try {
		stdout = await exec("gh", ["api", `repos/${owner}/${repo}/issues/${number}`], {
			cwd: options.cwd ?? process.cwd(),
			timeoutMs: options.timeoutMs ?? 15_000,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/\b404\b/.test(message)) return { status: "not_found", url };
		return { status: "unreachable", message };
	}
	let parsed: { title?: unknown; state?: unknown; pull_request?: { merged_at?: unknown } };
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		return { status: "unreachable", message: `gh api returned unparseable JSON: ${(error as Error).message}` };
	}
	const title = typeof parsed.title === "string" ? parsed.title : "(untitled)";
	const isPr = parsed.pull_request !== undefined;
	const kind = isPr ? "pr" : "issue";
	const state: "open" | "closed" | "merged" =
		isPr && parsed.pull_request?.merged_at ? "merged" : parsed.state === "open" ? "open" : "closed";
	void segment;
	return { status: "found", kind, state, title, url };
}

async function verifyBrRef(ref: string, match: RegExpMatchArray, options: VerifyExternalRefOptions): Promise<RefVerification> {
	const dbPath = match[1] ? unshellQuote(match[1]) : join(options.cwd ?? process.cwd(), ".beads", "beads.db");
	const id = match[2] as string;
	const exec = options.exec ?? runCommand;
	const args = ["--db", dbPath, ...BR_READ_ONLY, "show", id, "--json"];
	let stdout: string;
	try {
		stdout = await exec("br", args, { cwd: options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs ?? 15_000 });
	} catch (error) {
		return { status: "unreachable", message: error instanceof Error ? error.message : String(error) };
	}
	try {
		const parsed = decodeBrShow(stdout);
		return { status: "found", kind: "br", state: parsed.status, title: parsed.title ?? id, url: ref };
	} catch (error) {
		return { status: "unreachable", message: `br show returned invalid JSON: ${(error as Error).message}` };
	}
}

/**
 * Read-only fact check for one `external_ref`. Never throws: a transport failure comes back as
 * `unreachable`, a shape this module does not read comes back as `unverifiable`. Both are
 * ignorance, not a mismatch — the caller decides what ignorance is allowed to do.
 */
export async function verifyExternalRef(ref: string, options: VerifyExternalRefOptions = {}): Promise<RefVerification> {
	const githubMatch = GITHUB_REF_RE.exec(ref);
	if (githubMatch) return verifyGithubRef(ref, githubMatch, options);
	const brMatch = BR_SHOW_RE.exec(ref);
	if (brMatch) return verifyBrRef(ref, brMatch, options);
	if (ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../")) {
		return existsSync(ref) ? { status: "found", kind: "file", state: "exists", url: ref } : { status: "not_found", url: ref };
	}
	return { status: "unverifiable" };
}

/**
 * Mismatch = the ref points at something other than what an open-issue reference should: a 404, a
 * missing file, the wrong GitHub kind (an issue url that is actually a PR or vice versa), or a
 * state that is not `open`. `undefined` means the ref matches — nothing to refuse or escalate.
 * `unverifiable`/`unreachable` are deliberately not mismatches: ignorance is not a finding.
 */
export function describeRefMismatch(ref: string, verification: RefVerification): string | undefined {
	if (verification.status === "not_found") return `${ref} does not resolve to anything (404 or missing)`;
	if (verification.status !== "found") return undefined;
	if (verification.kind === "file") return undefined;
	if (verification.kind === "issue" || verification.kind === "pr") {
		const expected = GITHUB_REF_RE.exec(ref)?.[3] === "issues" ? "issue" : "pr";
		if (verification.kind !== expected) {
			return `${ref} is a ${verification.kind}, ${verification.state}${verification.state === "merged" ? "" : " (not the issue named)"}: "${verification.title}"`;
		}
	}
	if (verification.state !== "open") {
		return `${ref} is ${verification.state}, not open: "${verification.title}"`;
	}
	return undefined;
}

/** One line for the job's `notes`: what verification found, whether or not it matched. */
export function describeRefVerification(verification: RefVerification): string {
	switch (verification.status) {
		case "found":
			return verification.kind === "file"
				? `external_ref verified: file exists at ${verification.url}`
				: `external_ref verified: ${verification.kind} ${verification.state} "${verification.title}" (${verification.url})`;
		case "not_found":
			return `external_ref check: ${verification.url} does not resolve (404 or missing)`;
		case "unreachable":
			return `external_ref could not be verified: ${verification.message}`;
		case "unverifiable":
			return "external_ref is not a GitHub url, br command or file path — not verified";
	}
}
