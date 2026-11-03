/**
 * Every worker's MCP (cp-fl8b, cp-z402; policy: src/worker-mcp.ts). pi's own MCP runtime connects the servers of
 * `<agent dir>/mcp.json` in place; its tools are kept here and reached through `mcp_call`: without `tool` it lists
 * every connected, non-hidden tool, with `tool` it calls one. No tool-annotation filter applies.
 */
import { createMcpExtension, type ExtensionAPI, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MCP_CALL_TOOL, readUserMcpServers, workerMcpConfig } from "../../src/worker-mcp.ts";

// biome-ignore lint/suspicious/noExplicitAny: pi's MCP definitions are built from each server's JSON schema.
type AnyTool = ToolDefinition<any, any>;

export default async function workerMcp(pi: ExtensionAPI): Promise<void> {
	const tools = new Map<string, AnyTool>();
	const callable = (name: string): AnyTool | undefined => {
		const tool = tools.get(name);
		return tool && tool.exposure !== "hidden" ? tool : undefined;
	};

	// Everything but tool registration goes to pi (a plain object of closures): commands, events, active tools.
	const keep: ExtensionAPI = { ...pi, registerTool: ((tool: AnyTool) => void tools.set(tool.name, tool)) as ExtensionAPI["registerTool"] };
	await createMcpExtension({
		loadConfig: () => workerMcpConfig(readUserMcpServers(getAgentDir())),
		updateConfig: () => {
			throw new Error("worker: MCP config is not editable");
		},
		startupWaitMs: 10_000,
	})(keep);

	pi.registerTool({
		name: MCP_CALL_TOOL,
		label: "MCP",
		description: `Call a tool of the operator's MCP servers. Without "tool": list the callable tools with their input schemas. With "tool" (a listed name): call it with "arguments".`,
		parameters: Type.Object({
			tool: Type.Optional(Type.String({ description: "Tool name from the list, e.g. mcp__docs__search" })),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The tool's arguments, per its input schema" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.tool) {
				const list = [...tools.keys()].filter((name) => callable(name)).map((name) => {
					const tool = tools.get(name) as AnyTool;
					return { tool: name, description: tool.description, input: tool.parameters };
				});
				const text = list.length > 0 ? JSON.stringify(list, null, 1) : "No MCP tools are connected.";
				return { content: [{ type: "text", text }], details: undefined };
			}
			const tool = callable(params.tool);
			if (!tool) throw new Error(`${params.tool} is not a connected MCP tool; call ${MCP_CALL_TOOL} without "tool" to list them`);
			return tool.execute(toolCallId, params.arguments ?? {}, signal, onUpdate, ctx);
		},
	});
}
