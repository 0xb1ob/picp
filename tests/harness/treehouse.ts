/**
 * treehouse fixtures: a scratch clone whose worktree pool lives inside the
 * test's temp dir, so lease suites never touch the operator's ~/.treehouse.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True when a usable `treehouse` is on PATH. */
export function treehouseAvailable(): boolean {
	try {
		execFileSync("treehouse", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export interface TreehousePool {
	root: string;
	cleanup(): void;
}

/**
 * Point a clone's worktree pool at a scratch root. Returns the pool so the
 * test can remove every worktree it created.
 */
export function enableTreehouse(clonePath: string, options: { maxTrees?: number } = {}): TreehousePool {
	const root = mkdtempSync(join(tmpdir(), "cp-pool-"));
	mkdirSync(root, { recursive: true });
	writeFileSync(join(clonePath, "treehouse.toml"), `max_trees = ${options.maxTrees ?? 2}\nroot = "${root}"\n`);
	// The config must be effective AND invisible to `git status`: preflight and
	// teardown both refuse a dirty tree, and a stashed config would silently
	// send the pool back to ~/.treehouse.
	const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: clonePath, encoding: "utf8" }).trim();
	const infoDir = join(gitDir.startsWith("/") ? gitDir : join(clonePath, gitDir), "info");
	mkdirSync(infoDir, { recursive: true });
	appendFileSync(join(infoDir, "exclude"), "\n/treehouse.toml\n");
	return {
		root,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Run treehouse directly (assertions about pool state). */
export function treehouse(cwd: string, ...args: string[]): string {
	return execFileSync("treehouse", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** One pool entry as `treehouse status --json` reports it. */
export interface PoolEntry {
	name: string;
	path: string;
	/** `leased` while a holder has it, `available` once it is returned. */
	status: string;
	lease_id: string;
	lease_holder: string;
	leased_at: string | null;
}

/**
 * The pool as treehouse sees it. `status --json` prints a banner when an update
 * is available, so only the JSON tail is parsed.
 */
export function poolStatus(clonePath: string): PoolEntry[] {
	const out = treehouse(clonePath, "status", "--json");
	const start = out.indexOf("[");
	if (start < 0) return [];
	return JSON.parse(out.slice(start)) as PoolEntry[];
}

/**
 * The lease state of one worktree: `available` after a return, `leased` while
 * held, `undefined` when the pool has never heard of that path.
 *
 * **A returned lease is recycled, not deleted** — `treehouse return` cleans and
 * resets the worktree and keeps the directory for the next job. Asserting that
 * a torn-down worktree no longer *exists* tests treehouse's opposite of its
 * actual contract; assert this instead.
 */
export function leaseState(clonePath: string, worktree: string): string | undefined {
	return poolStatus(clonePath).find((entry) => entry.path === worktree)?.status;
}
