/**
 * `/doctor` MCP lines (cp-fl8b): `mcp.operator` (the operator's `<agent dir>/mcp.json` servers, probed
 * live with `pi mcp list --json` — once, bounded by the runner's 20 s, and only when a server is
 * enabled) and `mcp.workers` (which profiles reach them, read-only tools only). Never prints a value
 * from `mcp.json`: no transport, command, args, url, headers or env; an error text is scrubbed of
 * every config value and every secret shape first. Kept out of doctor.ts, which sits at its ceiling.
 */
import { join } from "node:path";
import type { DoctorFinding } from "./contracts.ts";
import type { CommandRunner } from "./doctor.ts";
import { listProfiles } from "./profiles.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { agentDirOf, enabledServers, MCP_CALL_TOOL, readUserMcpServers } from "./worker-mcp.ts";

export interface McpAccessOptions {
	packageRoot: string;
	env?: NodeJS.ProcessEnv;
	run: CommandRunner;
}

interface ListedServer {
	name?: unknown;
	enabled?: unknown;
	state?: unknown;
	tools?: unknown;
	error?: unknown;
}

/** Every string inside `value`, at any depth (the config values a probe error may echo). */
function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(strings);
}

/** `text` without any config value (3+ chars) or secret shape, capped. */
export function scrubMcpText(text: string, config: unknown, max = 200): string {
	let out = text;
	for (const value of strings(config).filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(value).join("‹redacted›");
	for (const { re } of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, "g"), "‹redacted›");
	return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export function mcpFindings(o: McpAccessOptions): DoctorFinding[] {
	const agentDir = agentDirOf(o.env ?? process.env);
	const user = readUserMcpServers(agentDir);
	const enabled = enabledServers(user.servers);
	const total = Object.keys(user.servers).length;
	const readers = listProfiles(join(o.packageRoot, "profiles")).filter((p) => p.frontmatter.readOnly === true).map((p) => p.frontmatter.name);
	const by = `${readers.join(", ")} via ${MCP_CALL_TOOL} (servers read in place from ${user.path}); implementer, ship workers and the CP parent: no MCP (by design)`;
	const finding = (check: string, severity: DoctorFinding["severity"], what: string, fix?: string, detail?: string): DoctorFinding => ({
		check,
		severity,
		what: what.slice(0, 200),
		...(detail ? { detail: detail.slice(0, 2000) } : {}),
		...(fix ? { fix: fix.slice(0, 500) } : {}),
	});
	if (user.error) {
		// The parse message can quote the file: name the path only.
		return [
			finding("mcp.operator", "warn", `MCP: ${user.path} is not valid (JSON with an "mcpServers" object)`, `fix ${user.path} by hand, then run \`pi mcp list\``),
			finding("mcp.workers", "ok", "read-only workers: no MCP (mcp.json is not valid)", undefined, by),
		];
	}
	if (enabled.length === 0) {
		const what = total === 0 ? "MCP: no servers configured (optional)" : `MCP: ${total} configured, none enabled`;
		return [
			finding("mcp.operator", "ok", what, undefined, `operator session: builtin:mcp, codemode, tool-search; servers from ${user.path}`),
			finding("mcp.workers", "ok", "read-only workers: no MCP servers configured", undefined, by),
		];
	}
	const workers = finding("mcp.workers", "ok", `read-only workers: all ${enabled.length} servers, read-only tools only`, undefined, by);
	// cwd = the agent dir: no project `.pi/mcp.json` is read by the probe.
	const result = o.run("pi", ["mcp", "list", "--json"], agentDir);
	let listed: ListedServer[];
	try {
		const parsed = JSON.parse(result.stdout) as { servers?: unknown };
		if (!Array.isArray(parsed.servers)) throw new Error("no servers array");
		listed = parsed.servers as ListedServer[];
	} catch {
		const why = scrubMcpText((result.stderr || result.stdout || `exit ${result.status}`).trim(), user.servers, 600);
		return [finding("mcp.operator", "warn", `MCP: ${enabled.length} enabled, not probed (\`pi mcp list --json\` gave no report)`, "run `pi mcp list` by hand; check pi is on PATH", why), workers];
	}
	const live = listed.filter((s) => s.enabled !== false);
	const connected = live.filter((s) => s.state === "connected");
	const tools = connected.reduce((sum, s) => sum + (Array.isArray(s.tools) ? s.tools.length : 0), 0);
	const problems = live.filter((s) => s.state !== "connected").map((s) => {
		const name = String(s.name);
		const error = typeof s.error === "string" ? ` — ${scrubMcpText(s.error, user.servers)}` : "";
		return `${scrubMcpText(name, {})}: ${String(s.state)}${error}`;
	});
	const what = `MCP: ${total} configured, ${enabled.length} enabled; connected ${connected.length}/${live.length}; tools ${tools}`;
	return problems.length === 0
		? [finding("mcp.operator", "ok", what, undefined, "operator session: builtin:mcp, codemode, tool-search"), workers]
		: [finding("mcp.operator", "warn", what, "run `pi mcp list` (or /mcp in the operator session) for the full error", problems.join("\n")), workers];
}
