/**
 * The Codex planner's and (C6) reviewer's tools: picp's dynamic tools (`report_result`, `gh_read`; `report_verdict`,
 * `read`, `grep`, `find`), the hook's tool vocabulary, the Codex secret guard, and the MCP route and approval rules for
 * the operator's servers. SDK-free.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENVELOPE_FILE, formatRejection, type JobContext, LenientGateReviewSchema, localChecks } from "../../extensions/worker-reporter/index.ts";
import {
	ENVELOPE_REPAIR_MAX_ATTEMPTS, type Envelope, type EnvelopeRecord, EnvelopeSchema, type GateReview, isoTimestamp, SCHEMA_VERSION, validateEnvelope,
} from "../contracts.ts";
import { CODEX_MCP_HELPER_TOOLS, type CodexMcpServers } from "../worker-mcp.ts";
import { FORGE_TOOL_NAMES } from "./claude-roles.ts";
import type { DynamicToolSpec, McpElicitationParams } from "./codex-protocol.ts";
import { capped, type ForgeState, GH_READ_INPUT_SCHEMA, ghRead, parseGhReadArgs, processState } from "./native-gh-read.ts";
import type { NormalizedCall, SpikeGuard, SpikeJob } from "./native-guards.ts";
import { PACKET_TOOL_NAMES, packetTools } from "./native-packet-tools.ts";
import { verdictReport } from "./native-verdict.ts";

export const REPORT_TOOL = "report_result";
export const GH_READ_TOOL = "gh_read";
export const VERDICT_TOOL_NAME = "report_verdict";

/** Closes the lexical gap for Codex: `$CODEX_HOME`, an `OPENAI_*`/`CODEX_*` variable, the home or a `.codex` path. */
export function codexSecretGuard(codexHome: string): SpikeGuard {
	return (call) => {
		if (call.name !== "bash" || typeof call.input.command !== "string") return undefined;
		const command = call.input.command;
		const hit = /\$\{?(?:OPENAI|CODEX)_\w*/.exec(command)?.[0] ?? (command.includes(codexHome) ? codexHome : undefined) ?? /(?<![\w.-])\.codex(?![\w-])/.exec(command)?.[0];
		return hit === undefined ? undefined : `Refused: a native planner's Bash never touches the Codex home, its login or an OPENAI_/CODEX_ variable (${hit}).`;
	};
}

/** A Codex hook's tool in picp's guard vocabulary; any other name (apply_patch included) is refused by the caller. */
export function codexToolCall(toolName: string, toolInput: unknown): NormalizedCall | undefined {
	const args = (toolInput !== null && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;
	if (toolName === "Bash") return { name: "bash", input: { command: args.command } };
	if (toolName === REPORT_TOOL) return { name: "report_result", input: args };
	if ((FORGE_TOOL_NAMES as readonly string[]).includes(toolName)) return { name: toolName, input: args };
	// C6: the guard vocabulary's own keys (`path`, `pattern`), so reviewerReadGuard checks the raw arguments.
	if (toolName === VERDICT_TOOL_NAME || (PACKET_TOOL_NAMES as readonly string[]).includes(toolName)) return { name: toolName, input: args };
	return undefined;
}

/** A picp tool the thread declares; `run` is called only after the hook's ticket and the guard chain allowed it. */
export interface CodexDynamicTool {
	spec: DynamicToolSpec;
	run(args: unknown): Promise<{ text: string; success: boolean }>;
}

/** `verdict` (C6): a reviewer's accepted `report_verdict`, so the state also serves as pi's `VerdictState`. */
export interface CodexReportState { accepted?: Envelope; verdict?: GateReview; attempts: number; refusals: string[] }

/** picp's `report_result`, as the Claude driver's: validated, written once, wrong-job and conflicting refused. */
export function reportTool(job: SpikeJob, state: CodexReportState): CodexDynamicTool {
	const file = (args: unknown): { text: string; success: boolean } => {
		const context: JobContext = {
			job_id: job.job_id, kind: job.kind, delivery: job.delivery, role: job.role, runDir: job.runDir, worktree: job.worktree,
			artifactPath: job.artifactPath, mayAskOperator: false,
		};
		const refuse = (value: string) => {
			state.refusals.push(value);
			return { text: value, success: false };
		};
		state.attempts += 1;
		const left = Math.max(0, ENVELOPE_REPAIR_MAX_ATTEMPTS - state.attempts);
		const checked = validateEnvelope(args, context);
		const errors = checked.ok ? localChecks(checked.value, context) : checked.errors;
		if (!checked.ok || errors.length > 0) return refuse(formatRejection(errors, state.attempts, left, REPORT_TOOL));
		const recordFile = join(job.runDir, ENVELOPE_FILE);
		if (existsSync(recordFile)) {
			let filed: unknown;
			try {
				filed = (JSON.parse(readFileSync(recordFile, "utf8")) as EnvelopeRecord).envelope;
			} catch (err) {
				return refuse(`report_result: ${recordFile} exists but is unreadable (${(err as Error).message}); refused.`);
			}
			if (JSON.stringify(filed) === JSON.stringify(checked.value)) return { text: `Already recorded (no-op): ${recordFile}`, success: true };
			return refuse(`report_result: your report was already filed at ${recordFile}; a different report is refused.`);
		}
		const record: EnvelopeRecord = { schema_version: SCHEMA_VERSION, job_id: job.job_id, received_at: isoTimestamp(), attempt: state.attempts, envelope: checked.value };
		mkdirSync(job.runDir, { recursive: true });
		writeFileSync(`${recordFile}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
		renameSync(`${recordFile}.tmp`, recordFile);
		state.accepted = checked.value;
		return { text: `Reported ${job.job_id}. Stop now.`, success: true };
	};
	return {
		spec: {
			type: "function", name: REPORT_TOOL, inputSchema: JSON.parse(JSON.stringify(EnvelopeSchema)) as unknown,
			description: "Finish this job by reporting the envelope (job_id, kind, status, summary, artifact_path, plan_summary). Call it once.",
		},
		run: async (args) => file(args),
	};
}

/** WP1's `gh_read` as a dynamic tool, run in the worker process with `hostEnv`; output redacted and capped. */
function ghReadTool(job: SpikeJob, hostEnv: NodeJS.ProcessEnv, state: ForgeState): CodexDynamicTool {
	const shared = ghRead(job, hostEnv, state);
	return {
		spec: { type: "function", name: GH_READ_TOOL, description: shared.description, inputSchema: JSON.parse(JSON.stringify(GH_READ_INPUT_SCHEMA)) as unknown },
		async run(args) {
			const parsed = parseGhReadArgs(args);
			if (typeof parsed === "string") return { text: parsed, success: false };
			const read = await shared.run(parsed);
			return { text: capped(read.text), success: !read.isError };
		},
	};
}

/** C6: pi's `report_verdict` handler (clamp, checks, write-once `verdict.json`) as the reviewer's dynamic tool. */
function verdictTool(job: SpikeJob, state: CodexReportState): CodexDynamicTool {
	const report = verdictReport(job, state);
	return {
		spec: {
			type: "function", name: VERDICT_TOOL_NAME, inputSchema: JSON.parse(JSON.stringify(LenientGateReviewSchema)) as unknown,
			description: "Finish this review by reporting your verdict (job_id, verdict, flags, reasons; revisions only when revise). Call it once, as your final action.",
		},
		async run(args) {
			const { text, isError } = await report(args);
			return { text, success: !isError };
		},
	};
}

/** C6: the reviewer's `read`, `grep` and `find` over its packet; a handler that throws answers an error text. */
function packetDynamicTools(root: string): CodexDynamicTool[] {
	return packetTools(root).map((tool) => ({
		spec: { type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
		async run(args) {
			try {
				const { text, isError } = tool.run(args);
				return { text, success: !isError };
			} catch (error) {
				return { text: `${tool.name} failed: ${(error as Error).message}`, success: false };
			}
		},
	}));
}

/** Planner: `report_result` and `gh_read` (forge writes off). Reviewer (C6): `report_verdict` and the packet reads. */
export function codexRoleTools(job: SpikeJob, hostEnv: NodeJS.ProcessEnv, report: CodexReportState, forge: ForgeState = processState): CodexDynamicTool[] {
	if (job.role === "gate-reviewer") return [verdictTool(job, report), ...packetDynamicTools(job.worktree)];
	return [reportTool(job, report), ghReadTool(job, hostEnv, forge)];
}

const serverOf = (mcp: CodexMcpServers, toolName: string): string | undefined =>
	[...mcp.names].sort((a, b) => b.length - a.length).find((name) => toolName.startsWith(`mcp__${name}__`));

/**
 * A hook tool name of a passed MCP server (`mcp`) or one of the CLI's resource tools (`resource`, only while a server
 * is passed); `refusal` names a hidden tool; undefined when the name is neither.
 */
export function codexMcpRoute(mcp: CodexMcpServers | undefined, toolName: string): { kind: "mcp" | "resource"; refusal?: string } | undefined {
	if (mcp === undefined || mcp.names.length === 0) return undefined;
	if (CODEX_MCP_HELPER_TOOLS.includes(toolName)) return { kind: "resource" };
	const server = serverOf(mcp, toolName);
	if (server === undefined) return undefined;
	return mcp.hidden(server, toolName.slice(`mcp__${server}__`.length)) ? { kind: "mcp", refusal: `Refused: ${toolName} is hidden in ${mcp.path}.` } : { kind: "mcp" };
}

/** The hook name and payload of an MCP tool-call approval for a passed server's visible tool; else one refusal. */
export function codexMcpApproval(mcp: CodexMcpServers | undefined, params: McpElicitationParams): { tool: string; payload: unknown } | string {
	const meta = params._meta ?? undefined;
	const tool = typeof meta?.tool_name === "string" ? meta.tool_name : "";
	const name = `mcp__${params.serverName}__${tool}`;
	if (params.mode !== "form" || meta?.codex_approval_kind !== "mcp_tool_call" || tool === "") {
		return `Refused: picp answers only an MCP tool-call approval; a server's own request (${params.serverName}) is declined.`;
	}
	if (mcp === undefined || !mcp.names.includes(params.serverName)) return `Refused: ${params.serverName} is not an MCP server picp passed to this run.`;
	if (mcp.hidden(params.serverName, tool)) return `Refused: ${name} is hidden in ${mcp.path}.`;
	return { tool: name, payload: meta.tool_params };
}
