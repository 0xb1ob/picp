/**
 * Read-only workers' MCP (cp-fl8b; policy and the gateway rationale: src/worker-mcp.ts).
 *
 * pi's own MCP runtime connects every server of `<agent dir>/mcp.json` (read in place; OAuth via
 * `mcp-auth.json` in place). The tools it registers are kept here instead of in pi's registry, which
 * the worker's exact `--tools` allowlist would empty anyway, and reached through `mcp_call`: without
 * `tool` it lists the read-only tools, with `tool` it calls one. The `tool_call` guard refuses any MCP
 * tool whose server does not declare `readOnlyHint: true` (or declares `destructiveHint: true`).
 */
import { createMcpExtension, type ExtensionAPI, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MCP_CALL_TOOL, mcpReadOnlyRefusal, readUserMcpServers, workerMcpConfig } from "../../src/worker-mcp.ts";

// biome-ignore lint/suspicious/noExplicitAny: pi's MCP definitions are built from each server's JSON schema.
type AnyTool = ToolDefinition<any, any>;

export default async function workerMcp(pi: ExtensionAPI): Promise<void> {
	const tools = new Map<string, AnyTool>();
	const callable = (name: string): AnyTool | undefined => {
		const tool = tools.get(name);
		return tool && tool.exposure !== "hidden" ? tool : undefined;
	};
	const refusal = (name: string): string | undefined => {
		const tool = callable(name);
		if (!tool) return `${name} is not a connected MCP tool; call ${MCP_CALL_TOOL} without "tool" to list them`;
		return mcpReadOnlyRefusal(name, tool.annotations);
	};

	// Everything but tool registration goes to pi (a plain object of closures): commands, events, active tools.
	const keep: ExtensionAPI = { ...pi, registerTool: ((tool: AnyTool) => void tools.set(tool.name, tool)) as ExtensionAPI["registerTool"] };
	await createMcpExtension({
		loadConfig: () => workerMcpConfig(readUserMcpServers(getAgentDir())),
		updateConfig: () => {
			throw new Error("read-only worker: MCP config is not editable");
		},
		startupWaitMs: 10_000,
	})(keep);

	pi.registerTool({
		name: MCP_CALL_TOOL,
		label: "MCP",
		description: `Call a read-only tool of the operator's MCP servers. Without "tool": list the callable tools with their input schemas. With "tool" (a listed name): call it with "arguments".`,
		parameters: Type.Object({
			tool: Type.Optional(Type.String({ description: "Tool name from the list, e.g. mcp__docs__search" })),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The tool's arguments, per its input schema" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.tool) {
				const list = [...tools.keys()].filter((name) => callable(name) && !refusal(name)).map((name) => {
					const tool = tools.get(name) as AnyTool;
					return { tool: name, description: tool.description, input: tool.parameters };
				});
				const text = list.length > 0 ? JSON.stringify(list, null, 1) : "No read-only MCP tools are connected.";
				return { content: [{ type: "text", text }], details: undefined };
			}
			const refused = refusal(params.tool);
			if (refused) throw new Error(refused);
			return (tools.get(params.tool) as AnyTool).execute(toolCallId, params.arguments ?? {}, signal, onUpdate, ctx);
		},
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === MCP_CALL_TOOL) {
			const name = (event.input as { tool?: unknown } | undefined)?.tool;
			const reason = typeof name === "string" && name.length > 0 ? refusal(name) : undefined;
			return reason ? { block: true, reason } : undefined;
		}
		// Never registered under the worker's --tools; refused the same way if it ever is.
		if (!event.toolName.startsWith("mcp__")) return undefined;
		const reason = mcpReadOnlyRefusal(event.toolName, pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations);
		return reason ? { block: true, reason } : undefined;
	});
}
