import { execFileSync } from "node:child_process";
import type { Envelope } from "../../src/contracts.ts";

/** What `git rev-parse HEAD` said in the worker's worktree: a sha, or why it could not. */
export type ObservedHead = { sha: string } | { error: string };

/**
 * cp-0von Rank 5: a ship/done report must name the commit it delivers, and that
 * commit must be HEAD of the worker's own worktree. Worker-side only (the
 * reporter's repair loop) — `validateEnvelope` and intake stay lenient so
 * envelopes filed before this rule are never re-judged on settle or restart.
 * Pure: `observe` is called at most once, and not at all when there is nothing
 * to check.
 */
export function headShaErrors(envelope: Envelope, worktree: string, observe: () => ObservedHead): string[] {
	if (envelope.status !== "done") return [];
	const given = envelope.head_sha;
	if (given === undefined && envelope.kind !== "ship") return [];
	const head = observe();
	if ("error" in head) {
		return [`head_sha: cannot verify — git rev-parse HEAD failed in ${worktree}: ${head.error}`];
	}
	if (given === undefined) {
		return [
			`head_sha: required for a completed ship job — the commit you are delivering, \`git rev-parse HEAD\` in your worktree ${worktree}: ${head.sha}`,
		];
	}
	if (given !== head.sha) {
		return [
			`head_sha: "${given}" is not HEAD of your worktree ${worktree} (git rev-parse HEAD = ${head.sha}) — report the commit this job delivers, from this worktree; push it first if it is not pushed`,
		];
	}
	return [];
}

/** `git rev-parse HEAD` in `cwd`; fails closed with git's first stderr line. */
export function worktreeHead(cwd: string): ObservedHead {
	try {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		return { sha };
	} catch (error) {
		const e = error as { stderr?: string | Buffer; message?: string };
		const stderrLine = String(e.stderr ?? "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0);
		return { error: stderrLine ?? e.message ?? String(error) };
	}
}
