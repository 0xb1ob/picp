/**
 * The Claude CLI operator's process (`data/operator.json` driver `claude`): extensions/cp-bridge on a headless host, its
 * tools over MCP beside Claude's file, shell and web tools and the user's MCP servers, under the operator's guards and
 * the loaded-surface lockdown. Its skills are an index in the system prompt. The dashboard is its input.
 */
import "./claude-stdout-guard.ts";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import registerCpBridge, { operatorToolRefusal, resolveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { OPERATOR_NOTE } from "../operator-note.ts";
import { agentDirOf, claudeMcpServers, readUserMcpServers } from "../worker-mcp.ts";
import { lex, secretPathIn, secretPaths } from "./claude-bash-policy.ts";
import { mcpToolPrefix } from "./claude-lockdown.ts";
import { HeadlessHost, type HostPorts } from "./claude-parent-session.ts";
import { type EngineView, startClaudeSession } from "./claude-session-engine.ts";
import { normalizeToolCall, operatorClaudeSettings } from "./claude-spike.ts";
import { NATIVE_OPERATOR_ADDENDUM, nativeModelId } from "./claude.ts";

const RECORD_PREFIX = "native-operator";
/** What the operator's Bash keeps of the launcher's environment beyond `buildChildEnv`'s allow-list (D3: real HOME). */
const PASSED_ENV = ["USER", "PI_HOME", "CP_HOME", "PI_CODING_AGENT_DIR", "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL"];

const fail = (message: string): never => {
	process.stderr.write(`[claude cli operator] refused to start: ${message}\n`);
	process.exit(2);
};

let sessionFile = "";
let modelId = "";
let skillPaths: string[] = [];
try {
	const { values } = parseArgs({ options: { session: { type: "string" }, model: { type: "string" }, skill: { type: "string", multiple: true } }, strict: true });
	if (!values.session || !values.model) throw new Error("--session and --model are required");
	sessionFile = values.session;
	modelId = nativeModelId(values.model);
	skillPaths = values.skill ?? [];
} catch (error) {
	fail((error as Error).message);
}

const cwd = process.cwd();
const agentDir = agentDirOf(process.env);
// D4: the CLI's own web tools stand in for pi-web-access.
const WEB_TOOLS = ["WebSearch", "WebFetch"];
const user = readUserMcpServers(agentDir);
const mcp = claudeMcpServers(user, process.env);
for (const line of mcp.skipped) process.stderr.write(`cp-operator: ${line}\n`);
const userServers = Object.keys(mcp.servers);
/** pi's builtin:mcp beside the servers: deferred tools load through ToolSearch, resources through the two resource tools. */
const MCP_TOOLS = userServers.length > 0 ? ["ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"] : [];
const described = (name: string): string => {
	const description = (user.servers[name] as { description?: unknown }).description;
	return typeof description === "string" ? `${name}: ${description}` : name;
};
const serversSection = userServers.length === 0 ? ""
	: `\n\nMCP servers (from ${mcp.path}; tools mcp__<server>__<tool>, deferred ones found with ToolSearch):\n${userServers.map((name) => `- ${described(name)}`).join("\n")}`;
const skillsIndex = formatSkillsForPrompt(loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false }).skills, "read").replace("the read tool", "Read");
// The CLI's own dir beside the record holds its config and transcripts: as secret as ~/.claude.
const secrets = [...secretPaths(operatorClaudeSettings(), [homedir(), userInfo().homedir]), join(dirname(sessionFile), `${RECORD_PREFIX}-claude`)];
const refused = (what: string, hit: string): string => `Refused: the operator's ${what} never touches the Claude settings, its config, /proc or /dev/fd (${hit}).`;

/** A secret named in a Bash command: literally anywhere in it, or as a path word once lexed (best effort past `$`). */
function bashSecret(command: string): string | undefined {
	const paths = secrets.filter((secret) => secret !== "/proc" && secret !== "/dev/fd");
	const named = paths.find((secret) => command.includes(secret)) ?? /\.claude\b|(?<![\w.-])\/(?:proc|dev\/fd)(?![\w.-])/.exec(command)?.[0];
	if (named !== undefined) return named;
	const lexed = lex(command, { redirects: true });
	const words = "denied" in lexed ? [] : [...lexed.segments.flat(), ...lexed.redirects];
	return words.find((word) => /^[.~]|\//.test(word) && secretPathIn(word.replace(/^~(?=$|\/)/, homedir()), cwd, secrets));
}

/** D2: a built-in passes today's operator guards (`operatorToolRefusal`), then the secret-path refusals; web and MCP pass. */
function guard(toolName: string, input: unknown): string | undefined {
	if (WEB_TOOLS.includes(toolName) || MCP_TOOLS.includes(toolName)) return undefined;
	const server = userServers.find((name) => toolName.startsWith(mcpToolPrefix(name)));
	if (server !== undefined) return mcp.hidden(server, toolName.slice(mcpToolPrefix(server).length)) ? `Refused: ${toolName} is hidden in ${mcp.path}.` : undefined;
	const call = normalizeToolCall(toolName, input);
	if (!call) return `Refused: ${toolName} is not one of the operator's tools.`;
	const scoped = operatorToolRefusal(call.name, call.input, cwd, () => resolveOperatorTarget());
	if (scoped) return scoped;
	if (call.name === "bash") {
		const hit = bashSecret(String(call.input.command ?? ""));
		return hit === undefined ? undefined : refused("Bash", hit);
	}
	const paths = call.name === "find" ? [call.input.path, call.input.pattern] : [call.input.path];
	const hit = paths.find((path): path is string => typeof path === "string" && secretPathIn(path.replace(/^~(?=$|\/)/, homedir()), cwd, secrets));
	return hit === undefined ? undefined : refused(toolName, hit);
}

/** One cp-bridge instance on a fresh host, its pi API and ctx served by the engine; the bridge records the session. */
function mount(ports: HostPorts, view: EngineView): HeadlessHost {
	process.env.PI_SESSION_FILE = view.sessionFile();
	const host = new HeadlessHost({ ...ports, ...view }, cwd);
	registerCpBridge(host.api());
	return host;
}

/** Headless: the bridge's notices and errors go to stderr (the launcher's terminal); the session view reads the log. */
function write(record: Record<string, unknown>): void {
	if (record.type === "extension_ui_request" && record.method === "notify") process.stderr.write(`cp-operator: ${String(record.message)}\n`);
	else if (record.type === "extension_error") process.stderr.write(`cp-operator: ${String(record.event)} failed: ${String(record.error)}\n`);
}

await startClaudeSession({
	sessionFile,
	model: modelId,
	label: "operator",
	recordPrefix: RECORD_PREFIX,
	promptSections: [],
	systemPrompt: () => `${OPERATOR_NOTE.trimEnd()}\n\n${NATIVE_OPERATOR_ADDENDUM}${serversSection}${skillsIndex}`,
	mount,
	commands: [],
	builtinTools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", ...WEB_TOOLS, ...MCP_TOOLS],
	disallowedTools: ["Agent", "Task"],
	refusal: (toolName) => `Refused: ${toolName} is not one of the operator's tools.`,
	guard,
	settleGuard: true,
	headless: { write },
	childEnv: { HOME: homedir(), ...Object.fromEntries(PASSED_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))) },
	mcpServers: mcp.servers,
	// The CLI may leave these out (web where its provider lacks it, ToolSearch with nothing deferred).
	lockdown: { optionalTools: [...WEB_TOOLS, ...MCP_TOOLS] },
});
