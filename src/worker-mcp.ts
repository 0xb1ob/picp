/**
 * MCP for every worker (cp-fl8b, cp-z402): each worker profile reaches every enabled, non-hidden tool of the operator's
 * `<agent dir>/mcp.json`, read in place (OAuth via `mcp-auth.json` in place) through one gateway tool, `mcp_call`
 * (`extensions/worker-mcp`), with no profile or tool-annotation filter. The CP parent is not a worker.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type LoadedMcpConfig, type McpServerConfig } from "@earendil-works/pi-coding-agent";
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

/**
 * Every worker's MCP contribution, merged into `base`: the worker-mcp extension and the `mcp_call`
 * gateway. `base` unchanged (same object) when the agent dir has no enabled server, so that argv stays byte-identical.
 */
export function withWorkerMcp(base: OptionalWorkerPackages, env: NodeJS.ProcessEnv = process.env): OptionalWorkerPackages {
	if (enabledServers(readUserMcpServers(agentDirOf(env)).servers).length === 0) return base;
	return { ...base, extensions: [...base.extensions, WORKER_MCP_EXTENSION], tools: [...(base.tools ?? []), MCP_CALL_TOOL] };
}
