/** N4c: the native tool set and the Edit/Write scope per role; only planner (research) and implementer run native. */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Role } from "../contracts.ts";
import { liveGrants, MandateStore } from "../mandate.ts";
import { loadMandateDefaults } from "../mandate-defaults.ts";
import { secretPathIn } from "./claude-bash-policy.ts";
import { worktreePathRefusal } from "./claude-ship-policy.ts";
import type { SpikeGuard, SpikeJob } from "./claude-spike.ts";

export type NativeRole = "research" | "implementer";
const TOOLS: Record<NativeRole, readonly string[]> = {
	research: ["Read", "Grep", "Glob", "Bash", "Write"],
	implementer: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
};
export const RESEARCH_TOOLS = TOOLS.research;

/** The native role a job role runs as; a role with no native tool set is refused by name. */
export function nativeRole(role: Role): NativeRole {
	if (role === "planner") return "research";
	if (role === "implementer") return "implementer";
	throw new Error(`native claude has no tool set for role ${role}; only planner and implementer run native`);
}

export const roleTools = (role: Role): readonly string[] => TOOLS[nativeRole(role)];

/** N4d: the implementer's picp MCP tools beside `report_result` (claude-forge-tools.ts), in the lockdown's surface. */
export const FORGE_TOOL_NAMES = ["git_push", "git_fetch", "pr_create", "pr_edit", "gh_read"] as const;
export const roleMcpTools = (role: Role): readonly string[] =>
	nativeRole(role) === "implementer" ? FORGE_TOOL_NAMES.map((name) => `mcp__picp__${name}`) : [];

/** The home's `exclude_paths` and every live grant's exclusions, read by the worker process, never the CLI child. */
export function implementerExclusions(home: string): string[] {
	if (home === "") throw new Error("native claude worker started without CP_HOME; its exclude_paths cannot be read");
	const grants = liveGrants(new MandateStore(home).list()).flatMap((grant) => grant.exclusions?.paths ?? []);
	return [...new Set([...loadMandateDefaults(home).exclude_paths, ...grants])];
}

/** Edit/Write scope: research its artifact directory; an implementer its worktree, no .git, secret or exclusion. */
export function writeScopeGuard(job: SpikeJob, secrets: readonly string[], role: NativeRole): SpikeGuard {
	if (role === "research") {
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
	return (call) => {
		if (call.name !== "write" && call.name !== "edit") return undefined;
		const path = call.input.path;
		if (typeof path !== "string" || path === "") return "Refused: an implementer's Edit/Write needs a file path.";
		const why = secretPathIn(path, job.worktree, secrets) ? `a secret path (${path})` : worktreePathRefusal(path, job.worktree, excluded);
		return why === undefined ? undefined : `Refused: an implementer edits only inside its worktree ${job.worktree}, outside .git; ${why} is denied.`;
	};
}
