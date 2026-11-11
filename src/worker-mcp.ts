/**
 * MCP for every worker (cp-fl8b, cp-z402): each worker profile reaches every enabled, non-hidden tool of the operator's
 * `<agent dir>/mcp.json`, read in place (OAuth via `mcp-auth.json` in place) through one gateway tool, `mcp_call`
 * (`extensions/worker-mcp`), with no profile or tool-annotation filter. The CP parent is not a worker.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpHttpServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
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

/** pi's per-tool exposure: an exact `toolExposure` key, else the first `*` pattern that matches, else `exposure`. */
function exposureOf(raw: Record<string, unknown>, tool: string): unknown {
	const map = isRecord(raw.toolExposure) ? raw.toolExposure : {};
	if (Object.hasOwn(map, tool)) return map[tool];
	const glob = (key: string) => new RegExp(`^${key.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	const pattern = Object.keys(map).find((key) => key.includes("*") && glob(key).test(tool));
	return pattern === undefined ? raw.exposure : map[pattern];
}

/** pi's config value: `$NAME`/`${NAME}` from `env`, `$$` and `$!` escaped; a `!command` value is never run here. */
function resolvedValue(value: string, env: NodeJS.ProcessEnv): string {
	if (value.startsWith("!")) throw new Error("a !command value is not run for the Claude CLI");
	return value.replace(/\$(\$|!|\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_match, escaped: string, braced?: string, bare?: string) => {
		const name = braced ?? bare;
		if (name === undefined) return escaped;
		const found = env[name];
		if (found === undefined) throw new Error(`${name} is not set`);
		return found;
	});
}

export interface ClaudeMcpServers {
	path: string;
	servers: Record<string, McpStdioServerConfig | McpHttpServerConfig>;
	/** A tool pi would hide (`toolExposure`, else the server's `exposure`, is `hidden`). */
	hidden: (server: string, tool: string) => boolean;
	/** One line per server left out and why; never a config value. */
	skipped: string[];
}

/**
 * The Claude CLI operator's user servers (O4): each enabled stdio or HTTP entry as an SDK config with values resolved
 * from `env`, as pi resolves them. pi-only keys are dropped; a server needing `cwd`, `auth` or `!command` is skipped.
 */
export function claudeMcpServers(user: UserMcpServers, env: NodeJS.ProcessEnv = process.env): ClaudeMcpServers {
	const servers: ClaudeMcpServers["servers"] = {};
	const kept: Record<string, Record<string, unknown>> = {};
	// The parse message can quote the file: name the path only.
	const skipped = user.error ? [`${user.path} is not valid JSON with an "mcpServers" object; no MCP servers`] : [];
	for (const [name, raw] of Object.entries(user.servers)) {
		const skip = (why: string) => void skipped.push(`MCP server ${name} not loaded: ${why}`);
		if (isRecord(raw) && (raw.enabled === false || (raw.exposure === "hidden" && !isRecord(raw.toolExposure)))) continue;
		if (!isRecord(raw) || (typeof raw.command !== "string" && typeof raw.url !== "string")) skip(`it needs "command" (stdio) or "url" (HTTP)`);
		else if (name === "cp") skip("cp is the operator's own server");
		else if (raw.cwd !== undefined || raw.auth !== undefined) skip(`"${raw.cwd !== undefined ? "cwd" : "auth"}" has no Claude CLI equivalent`);
		else {
			try {
				const values = (entries: unknown) => Object.fromEntries(Object.entries(isRecord(entries) ? entries : {}).map(([key, value]) => [key, resolvedValue(String(value), env)]));
				servers[name] = typeof raw.command === "string"
					? { type: "stdio", command: raw.command, ...(Array.isArray(raw.args) ? { args: raw.args.map(String) } : {}), ...(raw.env !== undefined ? { env: values(raw.env) } : {}) }
					: { type: "http", url: String(raw.url), ...(raw.headers !== undefined ? { headers: values(raw.headers) } : {}) };
				kept[name] = raw;
			} catch (error) {
				skip((error as Error).message);
			}
		}
	}
	const hidden = (server: string, tool: string) => kept[server] !== undefined && exposureOf(kept[server], tool) === "hidden";
	return { path: user.path, servers, hidden, skipped };
}

/**
 * Every worker's MCP contribution, merged into `base`: the worker-mcp extension and the `mcp_call`
 * gateway. `base` unchanged (same object) when the agent dir has no enabled server, so that argv stays byte-identical.
 */
export function withWorkerMcp(base: OptionalWorkerPackages, env: NodeJS.ProcessEnv = process.env): OptionalWorkerPackages {
	if (enabledServers(readUserMcpServers(agentDirOf(env)).servers).length === 0) return base;
	return { ...base, extensions: [...base.extensions, WORKER_MCP_EXTENSION], tools: [...(base.tools ?? []), MCP_CALL_TOOL] };
}
