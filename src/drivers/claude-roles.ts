/** N4c: the native tool set and the Edit/Write scope per role: planner (research), implementer and (N4h) reviewer. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { paths, type Role } from "../contracts.ts";
import { liveGrants, MandateStore } from "../mandate.ts";
import { loadMandateDefaults } from "../mandate-defaults.ts";
import { secretPathIn } from "./claude-bash-policy.ts";
import { worktreePathRefusal } from "./claude-ship-policy.ts";
import type { SpikeGuard, SpikeJob } from "./claude-spike.ts";

export type NativeRole = "research" | "implementer" | "reviewer";
const TOOLS: Record<NativeRole, readonly string[]> = {
	research: ["Read", "Grep", "Glob", "Bash", "Write"],
	implementer: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
	reviewer: ["Read", "Grep", "Glob"],
};
export const RESEARCH_TOOLS = TOOLS.research;

/** The native role a job role runs as; a role with no native tool set is refused by name. */
export function nativeRole(role: Role): NativeRole {
	if (role === "planner") return "research";
	if (role === "implementer") return "implementer";
	if (role === "gate-reviewer") return "reviewer";
	throw new Error(`the Claude CLI has no tool set for role ${role}; only planner, implementer and gate-reviewer run on it`);
}

export const roleTools = (role: Role): readonly string[] => TOOLS[nativeRole(role)];

/** N4h: a reviewer reads only its scratch cwd (the review packet); a Read/Grep/Glob path elsewhere is refused. */
export function reviewerReadGuard(job: SpikeJob): SpikeGuard {
	const root = resolve(job.worktree);
	return (call) => {
		if (call.name !== "read" && call.name !== "grep" && call.name !== "find") return undefined;
		// Grep and Glob default to the cwd; Read always names its file. A Glob pattern is a path too.
		const paths = call.name === "read" ? [call.input.path] : [call.input.path, ...(call.name === "find" ? [call.input.pattern] : [])].filter((p) => p !== undefined);
		for (const path of paths) {
			if (typeof path !== "string" || path === "") return "Refused: a reviewer's Read/Grep/Glob needs a string path.";
			const why = resolve(root, path) === root ? undefined : worktreePathRefusal(path, root);
			if (why !== undefined) return `Refused: a reviewer reads only its scratch dir ${root}; ${why} is denied.`;
		}
		return undefined;
	};
}

/** N4d: the implementer's picp MCP tools beside `report_result` (claude-forge-tools.ts), in the lockdown's surface. */
export const FORGE_TOOL_NAMES = ["git_push", "git_fetch", "pr_create", "pr_edit", "gh_read"] as const;
export const roleMcpTools = (role: Role): readonly string[] =>
	nativeRole(role) === "implementer" ? FORGE_TOOL_NAMES.map((name) => `mcp__picp__${name}`) : [];

/** The home's `exclude_paths` and every live grant's exclusions, read by the worker process, never the CLI child. */
export function implementerExclusions(home: string): string[] {
	if (home === "") throw new Error("Claude CLI worker started without CP_HOME; its exclude_paths cannot be read");
	const grants = liveGrants(new MandateStore(home).list()).flatMap((grant) => grant.exclusions?.paths ?? []);
	return [...new Set([...loadMandateDefaults(home).exclude_paths, ...grants])];
}

/** The implementer's own `state/artifacts/<job id>/report.md` under `home`, its directory created for the Write guard. */
export function implementerArtifactPath(home: string, jobId: string): string {
	if (home === "") throw new Error("Claude CLI worker started without CP_HOME; its artifact directory cannot be named");
	const file = join(home, paths.artifactFile(jobId));
	mkdirSync(dirname(file), { recursive: true });
	return file;
}

/** Edit/Write scope: research its artifact dir; an implementer its worktree (no .git, secret or exclusion) and its
 * own artifact dir, never another job's or the rest of the home; a reviewer none. */
export function writeScopeGuard(job: SpikeJob, secrets: readonly string[], role: NativeRole): SpikeGuard {
	if (role === "reviewer") return (call) => (call.name === "write" || call.name === "edit" ? "Refused: a reviewer has no Edit or Write; it only reads." : undefined);
	if (role === "research") {
		if (!job.artifactPath) throw new Error(`research ${job.job_id} has no artifact path; a research worker never runs without one`);
		const writeRoot = dirname(resolve(job.artifactPath));
		return (call) => {
			if (call.name === "edit") return "Refused: Edit is not in the spike's tool set.";
			if (call.name !== "write") return undefined;
			const path = call.input.path;
			const rel = typeof path === "string" ? relative(writeRoot, resolve(job.worktree, path)) : "..";
			const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
			return inside ? undefined : `Refused: a research worker writes only its artifact directory ${writeRoot} (got ${String(path)}).`;
		};
	}
	const excluded = job.excludePaths;
	if (excluded === undefined) throw new Error(`implementer ${job.job_id} has no exclude_paths; an implementer never runs without them`);
	const artifactDir = job.artifactPath === undefined ? undefined : dirname(resolve(job.artifactPath));
	// Absolute only: a relative path lands in the worktree (the cwd), never in the artifact dir.
	const ownArtifact = (path: string): boolean =>
		artifactDir !== undefined && isAbsolute(path) && existsSync(artifactDir) && worktreePathRefusal(path, artifactDir) === undefined;
	const scope = `Refused: an implementer edits only inside its worktree ${job.worktree}, outside .git${artifactDir === undefined ? "" : `, and inside its own artifact directory ${artifactDir}`}`;
	return (call) => {
		if (call.name !== "write" && call.name !== "edit") return undefined;
		const path = call.input.path;
		if (typeof path !== "string" || path === "") return "Refused: an implementer's Edit/Write needs a file path.";
		if (secretPathIn(path, job.worktree, secrets)) return `${scope}; a secret path (${path}) is denied.`;
		if (ownArtifact(path)) return undefined;
		const why = worktreePathRefusal(path, job.worktree, excluded);
		return why === undefined ? undefined : `${scope}; ${why} is denied.`;
	};
}
