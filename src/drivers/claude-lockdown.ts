/**
 * N3a G3: the loaded-surface lockdown. The CLI's `system/init`, its command list and its hook listing must show
 * only what picp passed plus the CLI's own built-ins; any extra refuses the run before a tool executes. Counts only.
 */
import type { SDKSystemMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";

/** The CLI's own subagents at the version floor; init lists them whatever picp passes, and Agent/Task stay disallowed. */
export const CLI_BUILTIN_AGENTS: readonly string[] = ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"];

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
export function lockdownVerdict(init: InitSurface, expectedTools: readonly string[], commands: readonly SlashCommand[], listing: HooksListing | undefined): Lockdown {
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
		tools: tools.filter((name) => !expectedTools.includes(name)).length + expectedTools.filter((name) => !tools.includes(name)).length,
		mcpServers: servers.filter((server) => server.name !== "picp").length + (servers.some((server) => server.name === "picp") ? 0 : 1),
		skills: (init.skills ?? []).filter(notBuiltin).length,
		plugins: (init.plugins ?? []).filter((plugin) => plugin.path !== "builtin").length,
		agents: (init.agents ?? []).filter((name) => !CLI_BUILTIN_AGENTS.includes(name)).length,
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
