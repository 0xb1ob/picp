/**
 * `/doctor` MCP lines: `mcp.operator` (`mcp.json` probed once with `pi mcp list --json`), `mcp.workers`, and (WP8)
 * `mcp.native` and `mcp.codex`, warns naming each server a native loader skips. Never prints a config value; error
 * text is scrubbed of config values and secret shapes. Kept out of doctor.ts, which sits at its ceiling.
 */
import { join } from "node:path";
import { type DoctorFinding, LAYOUT } from "./contracts.ts";
import type { CommandRunner } from "./doctor.ts";
import { operatorDriverSetting } from "./operator-compact.ts";
import { listProfiles } from "./profiles.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { loadNativeConfig, NATIVE_CLASSES, nativeConfigFile } from "./worker-driver.ts";
import {
	agentDirOf, claudeMcpServers, codexMcpConfig, enabledServers, MCP_CALL_TOOL, readUserMcpServers,
} from "./worker-mcp.ts";

export interface McpAccessOptions {
	packageRoot: string;
	env?: NodeJS.ProcessEnv;
	run: CommandRunner;
	/** The home whose `data/operator.json` driver names the operator session's MCP path. */
	home?: string;
}

/** Whether the home's operator runs on the Claude CLI; an unreadable or refused driver is pi's line. */
function claudeOperator(home: string | undefined): boolean {
	try {
		return home !== undefined && operatorDriverSetting(join(home, LAYOUT.data, "operator.json")) === "claude";
	} catch {
		return false;
	}
}

/** Whether any `data/native.json` switch is on; an unreadable file is off here (its own doctor line names it). */
function nativeWorkers(home: string | undefined): boolean {
	try {
		return home !== undefined && NATIVE_CLASSES.some((key) => loadNativeConfig(nativeConfigFile(home))[key]);
	} catch {
		return false;
	}
}

/** Whether `codex_research` is on (only Codex planners get MCP servers, R3); unreadable is off, as above. */
function codexPlanners(home: string | undefined): boolean {
	try {
		return home !== undefined && loadNativeConfig(nativeConfigFile(home)).codex_research;
	} catch {
		return false;
	}
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
	const workerProfiles = listProfiles(join(o.packageRoot, "profiles")).map((p) => p.frontmatter.name);
	const claude = claudeOperator(o.home);
	const session = claude ? `operator session: driver claude: servers from ${user.path}, no codemode` : "operator session: builtin:mcp, codemode, tool-search";
	const nativeOn = nativeWorkers(o.home);
	const native = nativeOn ? `; native workers: servers from ${user.path} as mcp__<server>__<tool>, no OAuth sign-in under the scratch config` : "";
	const codexOn = codexPlanners(o.home);
	const codex = codexOn
		? `; codex planners: servers from ${user.path}; codex implementers and reviewers get none (R3)` : "";
	const by = `every worker profile (${workerProfiles.join(", ")}; implementer/ship workers and the gate, diff and `
		+ `quality reviewers included) via ${MCP_CALL_TOOL}, all exposed tools, no annotation filter (servers read in `
		+ `place from ${user.path}); the CP parent: unchanged${native}${codex}`;
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
			finding("mcp.workers", "ok", "workers: no MCP (mcp.json is not valid)", undefined, by),
		];
	}
	if (enabled.length === 0) {
		const what = total === 0 ? "MCP: no servers configured (optional)" : `MCP: ${total} configured, none enabled`;
		return [
			finding("mcp.operator", "ok", what, undefined, claude ? session : `${session}; servers from ${user.path}`),
			finding("mcp.workers", "ok", "workers: no MCP servers configured", undefined, by),
		];
	}
	const workers = finding("mcp.workers", "ok", `workers: all ${enabled.length} enabled servers, all exposed tools`, undefined, by);
	// Resolved against the parent's env: a worker whose env differs could load or skip a $VAR server differently.
	const skipped = nativeOn ? claudeMcpServers(user, o.env ?? process.env, "picp").skipped : [];
	const nativeSkips = skipped.length === 0 ? [] : [finding("mcp.native", "warn", `native workers: ${skipped.length} MCP server(s) not loaded, as the parent's env resolves them`,
		"use literal or $VAR values set in the parent's env (or a wrapper such as docker run --env-file <0600 file>); !command, cwd and auth " +
		"are not loaded for the Claude CLI — docs/native-drivers.md WP5", skipped.map((line) => scrubMcpText(line, {}, 300)).join("\n"))];
	// R3: only Codex planners load servers; a hyphenated name loads but picp's hook cannot route its tools (U3).
	const codexMcp = codexOn ? codexMcpConfig(user, o.env ?? process.env) : undefined;
	const unusable = (codexMcp?.names ?? []).filter((name) => name.includes("-")).map((name) =>
		`MCP server ${name} loaded but unusable: the Codex CLI spells - as _ in tool names, `
		+ "so picp refuses its calls (U3)");
	const codexLines = [...(codexMcp?.skipped ?? []), ...unusable];
	if (codexLines.length > 0) {
		const what = `codex planners: ${codexLines.length} MCP server(s) not loaded or unusable`;
		const fix = "name servers with letters, digits and _ only, and use literal or $VAR values set in the "
			+ "parent's env; auth is not loaded for the Codex CLI — docs/native-drivers.md C5";
		const detail = codexLines.map((line) => scrubMcpText(line, {}, 300)).join("\n");
		nativeSkips.push(finding("mcp.codex", "warn", what, fix, detail));
	}
	// cwd = the agent dir: no project `.pi/mcp.json` is read by the probe.
	const result = o.run("pi", ["mcp", "list", "--json"], agentDir);
	let listed: ListedServer[];
	try {
		const parsed = JSON.parse(result.stdout) as { servers?: unknown };
		if (!Array.isArray(parsed.servers)) throw new Error("no servers array");
		listed = parsed.servers as ListedServer[];
	} catch {
		const why = scrubMcpText((result.stderr || result.stdout || `exit ${result.status}`).trim(), user.servers, 600);
		return [finding("mcp.operator", "warn", `MCP: ${enabled.length} enabled, not probed (\`pi mcp list --json\` gave no report)`, "run `pi mcp list` by hand; check pi is on PATH", why), workers, ...nativeSkips];
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
		? [finding("mcp.operator", "ok", what, undefined, session), workers, ...nativeSkips]
		: [finding("mcp.operator", "warn", what, "run `pi mcp list` (or /mcp in the operator session) for the full error", [...problems, ...(claude ? [session] : [])].join("\n")), workers, ...nativeSkips];
}
