/**
 * CI guard: the retired external tracker is named nowhere in the tracked tree, by content or by path, except on
 * the exact lines `scripts/retired-integration-allowlist.json` freezes by path, line hash and count.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RETIRED_PATTERN = /\bbr\b|beads/i;
export const ALLOWLIST_FILE = "scripts/retired-integration-allowlist.json";

/** Each category may only exempt lines in these files; a trailing `/` names a directory. */
export const CATEGORY_PATHS: Readonly<Record<string, readonly string[]>> = {
	"frozen-history": ["CHANGELOG.md"],
	protocol: ["src/viewer/server.ts", "tests/e2e/viewer-serving.test.ts"],
	"self-pattern": ["scripts/check-retired-integration.ts"],
	"deleted-feature-record": ["docs/testing-migration.md", "docs/testing-migration/"],
	"legacy-compat": [".gitignore", "src/service/install.ts"],
};

export interface Match { path: string; line: string }
export interface AllowEntry { path: string; sha256: string; count: number; category: string; reason: string }

/** SHA-256 of a line with its terminator and trailing whitespace removed. */
export function lineHash(line: string): string {
	return createHash("sha256").update(line.replace(/\s+$/, "")).digest("hex");
}

/** Every matching line of every text file; a NUL byte marks a binary file, which is skipped. */
export function scan(paths: readonly string[], read: (path: string) => Buffer): Match[] {
	const matches: Match[] = [];
	for (const path of paths) {
		const bytes = read(path);
		if (bytes.includes(0)) continue;
		for (const line of bytes.toString("utf8").split("\n")) if (RETIRED_PATTERN.test(line)) matches.push({ path, line });
	}
	return matches;
}

/** Findings for forbidden paths, unapproved matches, wrong counts and stale or misfiled entries; empty is clean. */
export function check(paths: readonly string[], matches: readonly Match[], entries: readonly AllowEntry[]): string[] {
	const tracked = new Set(paths);
	const findings = paths.filter((path) => RETIRED_PATTERN.test(path)).map((path) => `${path}: forbidden file name`);
	const allowed = new Map<string, AllowEntry>();
	for (const entry of entries) {
		const key = `${entry.path}\0${entry.sha256}`;
		if (allowed.has(key)) findings.push(`${entry.path}: duplicate allowlist entry ${entry.sha256.slice(0, 12)}`);
		if (!CATEGORY_PATHS[entry.category]?.some((allowedPath) => allowedPath.endsWith("/") ? entry.path.startsWith(allowedPath) : entry.path === allowedPath)) findings.push(`${entry.path}: category "${entry.category}" cannot exempt this file`);
		if (!entry.reason.trim()) findings.push(`${entry.path}: allowlist entry ${entry.sha256.slice(0, 12)} has no reason`);
		if (!tracked.has(entry.path)) findings.push(`${entry.path}: allowlisted file is not tracked`);
		allowed.set(key, entry);
	}
	const seen = new Map<string, number>();
	for (const { path, line } of matches) {
		const key = `${path}\0${lineHash(line)}`;
		const entry = allowed.get(key);
		if (!entry) {
			findings.push(`${path}: unapproved match: ${line.trim().slice(0, 160)}`);
			continue;
		}
		seen.set(key, (seen.get(key) ?? 0) + 1);
		const removed = entry.category === "deleted-feature-record" && /\| deleted-with-feature \|/.test(line) ? /`([^`]+)`/.exec(line)?.[1] : undefined;
		if (removed && tracked.has(removed)) findings.push(`${path}: deleted-with-feature row names ${removed}, which is still tracked`);
	}
	for (const [key, entry] of allowed) {
		const count = seen.get(key) ?? 0;
		if (count === 0) findings.push(`${entry.path}: stale allowlist entry ${entry.sha256.slice(0, 12)} (${entry.category})`);
		else if (count !== entry.count) findings.push(`${entry.path}: allowed line ${entry.sha256.slice(0, 12)} appears ${count} time(s), allowlist says ${entry.count}`);
	}
	return findings;
}

/** Findings for the tracked tree of the repository at `cwd`, against its committed allowlist. */
export function trackedFindings(cwd = process.cwd()): { files: number; entries: number; findings: string[] } {
	const paths = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).split("\0").filter(Boolean);
	const entries = JSON.parse(readFileSync(join(cwd, ALLOWLIST_FILE), "utf8")) as AllowEntry[];
	return { files: paths.length, entries: entries.length, findings: check(paths, scan(paths, (path) => readFileSync(join(cwd, path))), entries) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { files, entries, findings } = trackedFindings();
	for (const finding of findings) console.error(finding);
	console.log(`retired integration: ${files} tracked files, ${entries} allowlist entries, ${findings.length} finding(s)`);
	process.exitCode = findings.length === 0 ? 0 : 1;
}
