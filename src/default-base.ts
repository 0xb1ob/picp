/**
 * Shared "what is this clone's default base branch" rule.
 *
 * Extracted (cp-diffgate-redo-hxb, Constraints §2) from two independent,
 * byte-identical implementations — `Teardown.#defaultBase` and
 * `Preflight.#defaultBase` — that both did:
 *
 *   git symbolic-ref --quiet --short refs/remotes/origin/HEAD
 *   strip the "origin/" prefix
 *   fall back to the literal string "main" when no such ref exists
 *
 * A third caller (diff materialization, `src/diff-review.ts`) needs the
 * identical rule, so it is extracted here once instead of pasted a third
 * time. `Teardown`/`Preflight` now call through this function; their own
 * git-runner shape (`(cwd, args) => Promise<{status, stdout, stderr}>`) is
 * passed in unchanged, so no behaviour changes for either caller.
 */

export interface GitCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitCommandResult>;

/** origin/HEAD's branch name, minus the `origin/` prefix, or "main" if unset. */
export async function resolveDefaultBase(git: GitRunner, cwd: string): Promise<string> {
	const ref = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	const value = ref.stdout.trim();
	return value.startsWith("origin/") ? value.slice("origin/".length) : "main";
}
