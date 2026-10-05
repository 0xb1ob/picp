/**
 * Which commit this process runs (version badge, cp-kz20). Every long-lived process (viewer, parent host, CP parent,
 * operator session) imports this module once at start, so `LOADED_COMMIT` is the package checkout's HEAD at the moment
 * the process loaded its code: one bounded read through the workbench's `runGit` (no shell, 10 s timeout, 4 at most),
 * never re-read. Records that carry it (`parent.lock`, `parent-host.<gen>.json`, `operator/dashboard.json`) let a
 * reader compare a running process with the checkout on disk.
 */
import { PACKAGE_ROOT } from "../home.ts";
import { runGit, SHA } from "./git-read.ts";

export interface Commit { sha: string; at: string }
export type GitRunner = typeof runGit;

/** `HEAD` of `repo` as `{sha, committer date}`, or null when git cannot say. */
export async function headCommit(repo: string, git: GitRunner = runGit): Promise<Commit | null> {
	const out = await git(repo, ["log", "-1", "--format=%H%x09%cI", "HEAD"], { maxBytes: 4096 });
	const [sha = "", at = ""] = out.ok ? out.stdout.trim().split("\t") : [];
	return SHA.test(sha) && at ? { sha, at } : null;
}

/** The checkout's HEAD when this process imported its code; null when it was unreadable. */
export const LOADED_COMMIT: Promise<Commit | null> = headCommit(PACKAGE_ROOT);
/** When this process imported its code. */
export const LOADED_AT = new Date().toISOString();

/** A record's `commit` field: a full sha, or absent. */
export function commitField(value: unknown): string | undefined {
	return typeof value === "string" && SHA.test(value) ? value : undefined;
}
