/** N4c: the native tool set and the Edit/Write scope per role: planner (research), implementer and (N4h) reviewer. */
import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { paths, type Role } from "../contracts.ts";
import { liveGrants, MandateStore } from "../mandate.ts";
import { loadMandateDefaults } from "../mandate-defaults.ts";
import { SECRET_ENV_NAME } from "../web-egress.ts";
import { NONINTERACTIVE_WORKER_ENV } from "../worker-manager.ts";
import { secretPathIn } from "./claude-bash-policy.ts";
import { worktreePathRefusal } from "./claude-bash-scope.ts";
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

/** WP4: the CLI's own web tools, standing in for pi-web-access in the planner role only. */
export const NATIVE_WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/** The role's built-ins; `web` adds WebSearch and WebFetch to the research role only. */
export const roleTools = (role: Role, options: { web?: boolean } = {}): readonly string[] =>
	nativeRole(role) === "research" && options.web === true ? [...TOOLS.research, ...NATIVE_WEB_TOOLS] : TOOLS[nativeRole(role)];

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
/** WP1: a planner reads GitHub through gh_read alone; forge writes stay off (U1). */
export const roleForgeTools = (role: Role): readonly string[] =>
	({ implementer: FORGE_TOOL_NAMES, research: ["gh_read"], reviewer: [] })[nativeRole(role)];
export const roleMcpTools = (role: Role): readonly string[] => roleForgeTools(role).map((name) => `mcp__picp__${name}`);

const CHILD_IDENTITY = ["CP_JOB_ID", "CP_KIND", "CP_DELIVERY", "CP_ROLE", "CP_WORKTREE", "CP_ARTIFACT_PATH", "CP_BASE_BRANCH"] as const;
const CHILD_TOOL_VARS = [
	"PLAYWRIGHT_BROWSERS_PATH", "PUPPETEER_CACHE_DIR", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

/** WP3: the CLI child's env beyond `buildChildEnv`: pi's non-interactive variables, the job identity, named tool/CA/proxy
 * variables; never CP_HOME, CP_RUN_DIR, GH_* or a secret-named key; a proxy URL with `@` is dropped (one `warn` line).
 * WP7: profile `ops` alone gets the host SSH_AUTH_SOCK and unsets buildChildEnv's GIT_SSH_COMMAND (undefined). */
export function nativeWorkerChildEnv(env: NodeJS.ProcessEnv, profile?: string, warn: (line: string) => void = (line) => void process.stderr.write(`[claude cli] ${line}\n`)): Record<string, string | undefined> {
	const child: Record<string, string | undefined> = { ...NONINTERACTIVE_WORKER_ENV };
	if (profile === "ops") {
		child.GIT_SSH_COMMAND = undefined;
		if (env.SSH_AUTH_SOCK) child.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK;
	}
	const dropped: string[] = [];
	for (const key of [...CHILD_IDENTITY, ...CHILD_TOOL_VARS]) {
		const value = env[key];
		if (!value || SECRET_ENV_NAME.test(key)) continue;
		if (/_proxy$/i.test(key) && value.includes("@")) dropped.push(key);
		else child[key] = value;
	}
	if (dropped.length > 0) warn(`${dropped.join(", ")} not passed to the CLI child: a proxy URL with embedded credentials`);
	const browsers = join(userInfo().homedir, ".cache", "ms-playwright");
	if (child.PLAYWRIGHT_BROWSERS_PATH === undefined && existsSync(browsers)) child.PLAYWRIGHT_BROWSERS_PATH = browsers;
	return child;
}

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
