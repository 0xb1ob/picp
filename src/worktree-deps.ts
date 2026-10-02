/**
 * A pooled worktree keeps its `node_modules` between jobs, so a dependency bump on main leaves the next
 * job's worker with stale packages. Dispatch calls this after the lease and before the worker starts:
 * `package-lock.json` vs npm's hidden `node_modules/.package-lock.json`, `npm ci` when they differ or
 * node_modules is missing, nothing at all for a project without a lockfile. It never throws: a failed
 * install is an outcome the caller records and tells the worker about.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface DepsPorts {
	/** File text, or undefined when absent. */
	read(path: string): string | undefined;
	/** `npm ci` in `cwd`; `error` is the last line npm said. */
	npmCi(cwd: string): Promise<{ ok: boolean; error?: string }>;
}

export interface DepsOutcome {
	outcome: "installed" | "current" | "skipped" | "failed";
	detail: string;
	/** Present on a failed install: what the worker's brief must say. */
	note?: string;
}

const run = promisify(execFile);

export const defaultDepsPorts: DepsPorts = {
	read: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	npmCi: async (cwd) => {
		try {
			await run("npm", ["ci"], { cwd, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
			return { ok: true };
		} catch (error) {
			const failure = error as { stderr?: string; message?: string };
			return { ok: false, error: (failure.stderr || failure.message || "unknown error").trim().split("\n").at(-1)?.slice(0, 200) };
		}
	},
};

export async function prepareNodeDeps(worktree: string, ports: DepsPorts = defaultDepsPorts): Promise<DepsOutcome> {
	const lock = ports.read(join(worktree, "package-lock.json"));
	if (lock === undefined) return { outcome: "skipped", detail: "no package-lock.json" };
	const installed = ports.read(join(worktree, "node_modules/.package-lock.json"));
	if (installed !== undefined && sameLock(lock, installed)) return { outcome: "current", detail: "node_modules matches package-lock.json" };
	const why = installed === undefined ? "node_modules missing" : "node_modules differs from package-lock.json";
	const result = await ports.npmCi(worktree);
	if (result.ok) return { outcome: "installed", detail: `npm ci (${why})` };
	const detail = `npm ci failed (${why}): ${result.error ?? "unknown error"}`;
	return { outcome: "failed", detail, note: `Dependencies in this worktree may be stale: ${detail}. Run \`npm ci\` yourself before trusting typecheck or tests.` };
}

/**
 * npm's hidden lockfile drops the root entry and every package it did not install — an optional one
 * for another platform (`@esbuild/darwin-arm64` on linux) included. So: every installed package
 * matches the lock, and every lock package absent from node_modules is optional.
 */
export function sameLock(lock: string, installed: string): boolean {
	try {
		type Entry = { version?: string; optional?: boolean; devOptional?: boolean };
		const packages = (text: string): Record<string, Entry> => {
			const all = { ...(JSON.parse(text) as { packages?: Record<string, Entry> }).packages };
			delete all[""];
			return all;
		};
		const want = packages(lock);
		const have = packages(installed);
		if (Object.keys(have).some((key) => want[key]?.version !== have[key]?.version)) return false;
		return Object.entries(want).every(([key, entry]) => key in have || entry.optional === true || entry.devOptional === true);
	} catch {
		return false; // unreadable either side: reinstall
	}
}
