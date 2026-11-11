/**
 * The Claude CLI parent's process (driver `claude`): it runs extensions/command-post on a headless host, serves its
 * cp_* tools over an in-process MCP server, takes one SDK `query()` per turn resumed by the recorded session id, and
 * speaks the pi RPC lines and events the bridge reads (tests/fixtures/fake-parent.mjs is the protocol reference).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { registerCommandPost } from "../../extensions/command-post/index.ts";
import { configureLayout } from "../contracts.ts";
import { pendingNotice } from "../curation.ts";
import { standingOrdersDigest } from "../parent-context.ts";
import { recentWorkContext } from "../recent-work.ts";
import { HeadlessHost, type HostPorts } from "./claude-parent-session.ts";
import { startClaudeSession } from "./claude-session-engine.ts";
import { nativeModelId } from "./claude.ts";

/** The diagnostics the bridge drives through `prompt` (src/parent-diagnostics.ts): run here, never a model turn. */
const COMMANDS = ["doctor", "cp-drain", "cp-quota", "cp-version"] as const;
/** Digests pi delivers as context messages; here they are system-prompt sections, re-read on each turn. */
const PROMPT_SECTIONS = ["cp-parent-guidance", "cp-memory", "cp-standing-orders", "cp-recent-work", "cp-user-context"] as const;
const NATIVE_PARENT_ADDENDUM = [
	"Native parent: your tools are the cp_* tools (served as mcp__cp__cp_*); there is no shell, read or edit tool here.",
	"A user message that opens with `[fleet wake-up <type> — …]` is a fleet notice (an envelope, CI, a verdict, a recovery),",
	"never an operator message; operator sends carry a `[cp-send …]` delivery-id line.",
].join("\n");

const fail = (message: string): never => {
	process.stderr.write(`[claude cli parent] refused to start: ${message}\n`);
	process.exit(2);
};

let sessionFile = "";
let modelId = "";
let promptFile = "";
try {
	const { values } = parseArgs({ options: { session: { type: "string" }, model: { type: "string" }, "system-prompt-file": { type: "string" } }, strict: true });
	if (!values.session || !values.model || !values["system-prompt-file"]) throw new Error("--session, --model and --system-prompt-file are required");
	sessionFile = values.session;
	modelId = nativeModelId(values.model);
	promptFile = values["system-prompt-file"];
} catch (error) {
	fail((error as Error).message);
}
const home = process.env.CP_HOME ?? fail("CP_HOME is unset");
configureLayout("multi", home);

let session: ReturnType<typeof registerCommandPost>["session"];

/** One extension instance on a fresh host: at boot, and again on `new_session`, as pi's runtime swap loads one. */
function mount(ports: HostPorts, view: { operatorTexts: () => string[] }): HeadlessHost {
	const host = new HeadlessHost(ports, process.cwd());
	({ session } = registerCommandPost(host.api(), (_ctx, base) => ({
		registry: undefined,
		operatorTexts: view.operatorTexts,
		cwd: base.cwd,
		headless: base.headless,
		sessionId: ports.sessionId,
		notify: base.notify,
		setLive: base.setLive,
		refresh: base.refresh,
	})));
	return host;
}

/** The system prompt, rebuilt per turn: the contract file, the native addendum, then the digests read fresh. */
function systemPrompt(promptSections: ReadonlyMap<string, string>): string {
	const read = (name: string, get: () => string | undefined): string | undefined => {
		try {
			return get();
		} catch (error) {
			process.stderr.write(`[claude cli parent] ${name} unavailable this turn: ${(error as Error).message}\n`);
			return undefined;
		}
	};
	const sections: Record<(typeof PROMPT_SECTIONS)[number], string | undefined> = {
		"cp-parent-guidance": promptSections.get("cp-parent-guidance"),
		"cp-memory": read("memory", () => [session.commandPost().memoryDigest(), pendingNotice(home)].filter(Boolean).join("\n") || undefined),
		"cp-standing-orders": read("standing orders", () => standingOrdersDigest(home)),
		"cp-recent-work": read("recent work", () => recentWorkContext(home)),
		"cp-user-context": promptSections.get("cp-user-context"),
	};
	const parts = Object.entries(sections).flatMap(([name, text]) => (text ? [`<${name}>\n${text.trim()}\n</${name}>`] : []));
	return [readFileSync(promptFile, "utf8").trimEnd(), NATIVE_PARENT_ADDENDUM, ...parts].join("\n\n");
}

await startClaudeSession({
	sessionFile,
	model: modelId,
	label: "parent",
	recordPrefix: "native-parent",
	promptSections: PROMPT_SECTIONS,
	systemPrompt,
	mount,
	commands: COMMANDS,
	builtinTools: [],
	disallowedTools: ["Agent", "Task", "WebFetch", "WebSearch"],
	refusal: (toolName) => `Refused: ${toolName} is not one of the parent's cp_* tools.`,
});
