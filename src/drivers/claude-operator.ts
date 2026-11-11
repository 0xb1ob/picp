/**
 * The Claude CLI operator's process (`data/operator.json` driver `claude`): extensions/cp-bridge on a headless host, its
 * tools over MCP beside Claude's Bash/Read/Write/Edit/Grep/Glob under the operator's guards. The dashboard is its input.
 */
import "./claude-stdout-guard.ts";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import registerCpBridge, { operatorToolRefusal, resolveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { OPERATOR_NOTE } from "../operator-note.ts";
import { lex, secretPathIn, secretPaths } from "./claude-bash-policy.ts";
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
try {
	const { values } = parseArgs({ options: { session: { type: "string" }, model: { type: "string" } }, strict: true });
	if (!values.session || !values.model) throw new Error("--session and --model are required");
	sessionFile = values.session;
	modelId = nativeModelId(values.model);
} catch (error) {
	fail((error as Error).message);
}

const cwd = process.cwd();
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

/** D2: a built-in passes today's operator guards (`operatorToolRefusal`), then the secret-path refusals. */
function guard(toolName: string, input: unknown): string | undefined {
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
	systemPrompt: () => `${OPERATOR_NOTE.trimEnd()}\n\n${NATIVE_OPERATOR_ADDENDUM}`,
	mount,
	commands: [],
	builtinTools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob"],
	disallowedTools: ["Agent", "Task", "WebFetch", "WebSearch"],
	refusal: (toolName) => `Refused: ${toolName} is not one of the operator's tools.`,
	guard,
	settleGuard: true,
	headless: { write },
	childEnv: { HOME: homedir(), ...Object.fromEntries(PASSED_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))) },
});
