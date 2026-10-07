/**
 * MCP for read-only workers (cp-fl8b). The `readOnly: true` profiles (planner, qa, gate-reviewer)
 * load every server of the operator's `<agent dir>/mcp.json`, read in place through the agent dir
 * the worker already inherits (`workerEnvironment`): nothing is copied, and OAuth tokens stay in
 * `mcp-auth.json`, which pi reads in place. The implementer, ship workers and the CP parent get no MCP.
 *
 * Why a gateway tool and not `-e builtin:mcp`: since pi 1.0.4 the worker's `--tools` allowlist no
 * longer removes MCP tools (pi `docs/mcp.md`: only an `mcp__*` entry filters them), so builtin MCP
 * would expose every server tool, writes included. What keeps it out is `--no-extensions`, which
 * also disables the `builtin:mcp` built-in (pi `docs/settings.md`); workers never pass `-e builtin:mcp`.
 * `extensions/worker-mcp` runs pi's own MCP runtime (`createMcpExtension`), keeps the tools it
 * registers, and serves them through one allowlisted tool, `mcp_call`. Only tools whose server
 * declares `readOnlyHint: true` and not `destructiveHint: true` are listed or callable; a missing
 * hint is refused (fail closed), at the `tool_call` hook and again in `execute`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type LoadedMcpConfig, type McpServerConfig, type ToolAnnotations } from "@earendil-works/pi-coding-agent";
import type { WorkerProfile } from "./contracts.ts";
import type { OptionalWorkerPackages } from "./worker-packages.ts";

export const MCP_CALL_TOOL = "mcp_call";
export const WORKER_MCP_EXTENSION = join(import.meta.dirname, "..", "extensions", "worker-mcp", "index.ts");

/** pi's `getAgentDir()`, over a given env (the one the worker inherits); pi's own when it has no HOME. */
export function agentDirOf(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!env.HOME) return dir && !dir.startsWith("~") ? dir : getAgentDir();
	if (!dir) return join(env.HOME, ".pi", "agent");
	return dir === "~" || dir.startsWith("~/") ? join(env.HOME, dir.slice(1)) : dir;
}

export interface UserMcpServers {
	path: string;
	/** Server name to its raw `mcpServers` entry. */
	servers: Record<string, unknown>;
	error?: string;
}

/** `<agentDir>/mcp.json`'s `mcpServers`; a missing file is no servers. Never throws. */
export function readUserMcpServers(agentDir: string): UserMcpServers {
	const path = join(agentDir, "mcp.json");
	if (!existsSync(path)) return { path, servers: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown } | null;
		const servers = parsed?.mcpServers ?? {};
		if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return { path, servers: {}, error: `${path}: expected an object with an "mcpServers" object` };
		return { path, servers: servers as Record<string, unknown> };
	} catch (error) {
		return { path, servers: {}, error: `${path}: ${(error as Error).message}` };
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Names of the servers pi would connect: entries not set to `enabled: false`. */
export function enabledServers(servers: Record<string, unknown>): string[] {
	return Object.entries(servers).filter(([, raw]) => !isRecord(raw) || raw.enabled !== false).map(([name]) => name);
}

/**
 * The worker's config: every server, as written, with every non-hidden exposure made `direct`.
 * Exposure only decides how pi itself would declare a tool; the gateway is the one path in a
 * worker, and `direct` keeps pi from asking for codemode/tool_search the worker cannot have.
 * `hidden` (server or tool) stays hidden. An entry that is neither stdio nor HTTP is reported.
 */
export function workerMcpConfig(user: UserMcpServers): LoadedMcpConfig {
	const errors = user.error ? [user.error] : [];
	const servers: LoadedMcpConfig["servers"] = [];
	for (const [name, raw] of Object.entries(user.servers)) {
		if (!isRecord(raw) || (typeof raw.command !== "string" && typeof raw.url !== "string")) {
			errors.push(`${user.path}: server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
			continue;
		}
		const direct = (exposure: unknown) => (exposure === "hidden" ? "hidden" : "direct");
		const toolExposure = isRecord(raw.toolExposure) ? Object.fromEntries(Object.entries(raw.toolExposure).map(([tool, value]) => [tool, direct(value)])) : undefined;
		const config = { ...raw, exposure: direct(raw.exposure), ...(toolExposure ? { toolExposure } : {}) } as McpServerConfig;
		servers.push({ name, config, source: user.path, scope: "global" });
	}
	return { servers, autoEnableCodemode: false, errors };
}

/** Why a read-only worker may not call this MCP tool; undefined when its server declares it read-only. */
export function mcpReadOnlyRefusal(tool: string, annotations: ToolAnnotations | undefined): string | undefined {
	if (annotations?.readOnlyHint === true && annotations.destructiveHint !== true) return undefined;
	const why = annotations?.destructiveHint === true ? "declared destructive (destructiveHint)" : "not declared read-only by its MCP server (readOnlyHint)";
	return `${tool} is ${why}; read-only workers may call only read-only MCP tools`;
}

/**
 * The read-only profiles' MCP contribution, merged into `base`: the worker-mcp extension and the
 * `mcp_call` gateway. `base` unchanged (same object) for a writing profile or a home whose agent
 * dir has no enabled server, so those argvs stay byte-identical.
 */
export function withWorkerMcp(base: OptionalWorkerPackages, profile: WorkerProfile, env: NodeJS.ProcessEnv = process.env): OptionalWorkerPackages {
	if (profile.frontmatter.readOnly !== true) return base;
	if (enabledServers(readUserMcpServers(agentDirOf(env)).servers).length === 0) return base;
	return { ...base, extensions: [...base.extensions, WORKER_MCP_EXTENSION], tools: [...(base.tools ?? []), MCP_CALL_TOOL] };
}
