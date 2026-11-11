/**
 * N3a G3: the loaded-surface lockdown. The CLI's `system/init`, its command list and its hook listing must show
 * only what picp passed plus the CLI's own built-ins; any extra refuses the run before a tool executes. Counts only.
 */
import { createHash } from "node:crypto";
import type { AgentInfo, Query, SDKSystemMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";

/** The CLI's tool-name prefix for an MCP server: `mcp__<name>__`, any character outside `[A-Za-z0-9_-]` as `_`. */
export const mcpToolPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`;

/** Beyond the expected tools: picp's own server (default `picp`), tools that may be absent, servers whose tools pass. */
export interface SurfaceOptions {
	server?: string;
	optionalTools?: readonly string[];
	optionalServers?: readonly string[];
}

/** The CLI's own subagents at the version floor, pinned by `agentDigest`, so a same-named loaded agent is an extra. */
export const CLI_BUILTIN_AGENTS: Readonly<Record<string, string>> = {
	claude: "140abfc2cbb35d00",
	Explore: "ddb74f827301da47",
	"general-purpose": "7093e5b15079a39a",
	Plan: "bec305d778a9323d",
	"statusline-setup": "191ea1783b908648",
};

/** A short sha-256 of an agent's name and description: what the CLI reports about where an agent came from. */
export const agentDigest = (agent: Pick<AgentInfo, "name" | "description">): string =>
	createHash("sha256").update(`${agent.name}\n${agent.description}`).digest("hex").slice(0, 16);

/** The undocumented `get_hooks_listing` control response, as far as the lockdown reads it. */
export interface HooksListing {
	hooks?: readonly unknown[];
	policy?: { managedOnly?: boolean; policyHookCount?: number };
}

export type InitSurface = Pick<SDKSystemMessage, "tools" | "mcp_servers" | "skills" | "plugins" | "agents" | "slash_commands" | "output_style">;

export interface SurfaceCounts {
	tools: number;
	mcpServers: number;
	skills: number;
	plugins: number;
	agents: number;
	slashCommands: number;
	/** Non-managed hooks the CLI lists; picp's in-process SDK hook is never listed. */
	hooks: number;
}

export interface Lockdown {
	verdict: "ok" | "refused";
	/** What loaded, and what picp did not pass; counts only, never names or paths. */
	seen?: SurfaceCounts & { managedHooks: number };
	extra?: SurfaceCounts & { outputStyle: number };
	refusal?: string;
	checkMs?: number;
}

/** Compares one init against picp's expected surface; a missing hook listing or an unbound hook lock refuses. */
export function lockdownVerdict(
	init: InitSurface,
	expectedTools: readonly string[],
	commands: readonly SlashCommand[],
	agents: readonly AgentInfo[],
	listing: HooksListing | undefined,
	surface: SurfaceOptions = {},
): Lockdown {
	const { server = "picp", optionalTools = [], optionalServers = [] } = surface;
	const open = (name: string) => optionalTools.includes(name) || optionalServers.some((each) => name.startsWith(mcpToolPrefix(each)));
	const pinned = (name: string) => {
		const infos = agents.filter((agent) => agent.name === name);
		return infos.length === 1 && infos[0] !== undefined && CLI_BUILTIN_AGENTS[name] === agentDigest(infos[0]);
	};
	const agentNames = new Set([...(init.agents ?? []), ...agents.map((agent) => agent.name)]);
	const builtin = new Set(commands.filter((command) => command.builtin === true).map((command) => command.name));
	const custom = new Set(commands.filter((command) => command.builtin !== true).map((command) => command.name));
	const notBuiltin = (name: string) => !builtin.has(name) || custom.has(name);
	const tools = init.tools ?? [];
	const servers = init.mcp_servers ?? [];
	const hooks = listing?.hooks?.length ?? 0;
	const seen = {
		tools: tools.length,
		mcpServers: servers.length,
		skills: (init.skills ?? []).length,
		plugins: (init.plugins ?? []).length,
		agents: (init.agents ?? []).length,
		slashCommands: (init.slash_commands ?? []).length,
		hooks,
		managedHooks: listing?.policy?.policyHookCount ?? 0,
	};
	const extra = {
		tools: tools.filter((name) => !expectedTools.includes(name) && !open(name)).length + expectedTools.filter((name) => !tools.includes(name)).length,
		mcpServers: servers.filter((each) => each.name !== server && !optionalServers.includes(each.name)).length + (servers.some((each) => each.name === server) ? 0 : 1),
		skills: (init.skills ?? []).filter(notBuiltin).length,
		plugins: (init.plugins ?? []).filter((plugin) => plugin.path !== "builtin").length,
		agents: [...agentNames].filter((name) => !pinned(name)).length,
		slashCommands: (init.slash_commands ?? []).filter(notBuiltin).length,
		hooks,
		outputStyle: init.output_style === "default" ? 0 : 1,
	};
	const loaded = Object.entries(extra).filter(([, count]) => count > 0);
	const reasons = [
		...(loaded.length > 0 ? [`it loaded a surface picp did not pass (${loaded.map(([key, count]) => `${key} ${count}`).join(", ")})`] : []),
		...(listing === undefined ? ["the CLI gave no hook listing"] : []),
		...(listing !== undefined && listing.policy?.managedOnly !== true ? ["the managed-only hook lock did not bind"] : []),
	];
	if (reasons.length === 0) return { verdict: "ok", seen, extra };
	return { verdict: "refused", seen, extra, refusal: `Refused: the Claude CLI lockdown failed: ${reasons.join("; ")}. The run was stopped before any tool ran.` };
}

/** Runs the lockdown on one init with the CLI's commands, agents and hook listing, read over the control channel. */
export async function checkSurface(q: Query, init: InitSurface, expectedTools: readonly string[], surface: SurfaceOptions = {}): Promise<Lockdown> {
	const started = Date.now();
	try {
		// SAFETY: getHooksListing exists only on newer SDKs; it is optional here and its absence is handled below.
		const listing = (q as unknown as { getHooksListing?: () => Promise<HooksListing> }).getHooksListing;
		const [initialized, hooks] = await Promise.all([q.initializationResult(), listing === undefined ? undefined : listing.call(q)]);
		return { ...lockdownVerdict(init, expectedTools, initialized.commands, initialized.agents ?? [], hooks, surface), checkMs: Date.now() - started };
	} catch (err) {
		return { verdict: "refused", refusal: `Refused: the Claude CLI lockdown check failed (${(err as Error).message}).`, checkMs: Date.now() - started };
	}
}
