/**
 * Parent-session tool inventory — the list `/doctor` diffs against the
 * expected set (pi builtins + command-post's own `cp_*` tools).
 *
 * Artifact-body guards hook only `read` and `bash` (plus `grep`/`edit`/`write`
 * for the same paths). A global extension (pi-lens, fetch, …) can still pull
 * `state/runs/<id>/artifact.md` into the parent. Doctor warns; it does not
 * refuse. The bridge parent is started with `PARENT_BRIDGE_FLAGS` so that
 * path never loads those tools.
 */

export const SESSION_TOOL_CAPABILITIES = ["file_read", "shell", "network"] as const;
export type SessionToolCapability = (typeof SESSION_TOOL_CAPABILITIES)[number];

/**
 * Pi builtins a parent is expected to have. Guards cover a subset
 * (`read`/`bash`/`grep`/`edit`/`write`/`powershell`); the rest are still
 * ours, not foreign extensions.
 */
export const PARENT_BUILTIN_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"powershell",
] as const;

export interface SessionTool {
	name: string;
	/** TypeBox / JSON-schema parameters, when the recorder had them. */
	parameters?: unknown;
	/** `sourceInfo.path` or `sourceInfo.source` from pi, when present. */
	source?: string;
}

export interface RecordedSessionTool {
	name: string;
	source?: string;
	capabilities: SessionToolCapability[];
}

export function isCommandPostTool(tool: Pick<SessionTool, "name" | "source">): boolean {
	if (tool.name.startsWith("cp_")) return true;
	const source = (tool.source ?? "").replaceAll("\\", "/");
	return source.includes("/extensions/command-post/") || source.endsWith("/extensions/command-post");
}

export function isExpectedParentTool(tool: Pick<SessionTool, "name" | "source">): boolean {
	return isCommandPostTool(tool) || (PARENT_BUILTIN_TOOLS as readonly string[]).includes(tool.name);
}

export function guessCapabilities(tool: Pick<SessionTool, "name" | "parameters">): SessionToolCapability[] {
	const tokens = new Set(tool.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
	const blob = schemaBlob(tool.parameters);
	const found: SessionToolCapability[] = [];
	if (
		hasAny(tokens, ["read", "grep", "find", "ls", "cat", "file", "path", "glob", "symbol", "outline", "lens"]) ||
		/"(path|file_path|filepath|file|glob|directory)"/.test(blob)
	) {
		found.push("file_read");
	}
	if (hasAny(tokens, ["bash", "shell", "exec", "spawn", "powershell", "command"]) || /"command"/.test(blob)) {
		found.push("shell");
	}
	if (
		hasAny(tokens, ["fetch", "http", "https", "url", "web", "network", "download", "browser"]) ||
		/"(url|uri|href|endpoint)"/.test(blob)
	) {
		found.push("network");
	}
	return found;
}

function hasAny(tokens: ReadonlySet<string>, needles: readonly string[]): boolean {
	return needles.some((needle) => tokens.has(needle));
}

export function snapshotSessionTools(
	tools: ReadonlyArray<{
		name: string;
		parameters?: unknown;
		sourceInfo?: { path?: string; source?: string };
	}>,
): RecordedSessionTool[] {
	return tools.map((tool) => {
		const source = tool.sourceInfo?.path ?? tool.sourceInfo?.source;
		const recorded: RecordedSessionTool = {
			name: tool.name,
			capabilities: guessCapabilities({ name: tool.name, parameters: tool.parameters }),
		};
		if (source) recorded.source = source;
		return recorded;
	});
}

export function foreignSessionTools(tools: readonly RecordedSessionTool[]): RecordedSessionTool[] {
	return tools.filter((tool) => !isExpectedParentTool(tool));
}

export function isUncovered(tool: Pick<RecordedSessionTool, "capabilities">): boolean {
	return tool.capabilities.includes("file_read") || tool.capabilities.includes("shell");
}

function schemaBlob(parameters: unknown): string {
	if (parameters === undefined || parameters === null) return "";
	if (typeof parameters === "string") return parameters.toLowerCase();
	try {
		return JSON.stringify(parameters).toLowerCase();
	} catch {
		return "";
	}
}
