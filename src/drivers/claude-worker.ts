/**
 * The native Claude research worker process (N3b). It speaks the pi RPC lines dispatch already reads (`get_state`, one
 * `prompt`, then events), runs the brief through `runClaudeSpike` with every N3a gate on, and exits on stdin end or
 * SIGTERM. A run that ends without an accepted report exits non-zero, so the job fails on its observed exit.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnTokenUsage } from "@t3tools/contracts";
import type { Delivery } from "../contracts.ts";
import { nativeFollowUpRefusal } from "../worker-driver.ts";
import { REPORT_TOOL, runClaudeSpike } from "./claude-spike.ts";

const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const toolNames = new Map<string, string>();
const abort = new AbortController();
let run: Promise<number> | undefined;
let costUsd: number | undefined;

/** pi's usage shape (run-artifacts `readUsage`); undefined (unavailable) unless tokens are complete and non-zero and the
 * cost is a finite number, since a real model call never costs zero tokens: a zero means nothing was reported. */
export function piUsage(usage: TurnTokenUsage, cost: number | undefined): Record<string, unknown> | undefined {
	if (usage.usageStatus !== "complete" || cost === undefined || !Number.isFinite(cost)) return undefined;
	const cacheRead = usage.cachedInputTokens ?? 0;
	const cacheWrite = usage.cacheCreationTokens ?? 0;
	const input = usage.inputTokens - cacheRead - cacheWrite + (usage.otherUsage?.inputTokens ?? 0);
	const output = usage.outputTokens + (usage.otherUsage?.outputTokens ?? 0);
	const totalTokens = input + output + cacheRead + cacheWrite;
	return totalTokens > 0 ? { input, output, cacheRead, cacheWrite, totalTokens, cost: { total: cost } } : undefined;
}

/** SDK messages as the pi events the recorder, intake and bounds already watch; the report tool keeps pi's name. */
function relay(message: SDKMessage): void {
	if (message.type === "result") costUsd = Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : undefined;
	if ((message.type !== "assistant" && message.type !== "user") || message.parent_tool_use_id !== null) return;
	const content = message.message.content;
	// SAFETY: SDK content blocks are plain JSON objects; every field read below is checked or stringified.
	for (const block of Array.isArray(content) ? (content as unknown as Array<Record<string, unknown>>) : []) {
		if (block.type === "tool_use") {
			const name = block.name === REPORT_TOOL ? "report_result" : String(block.name);
			toolNames.set(String(block.id), name);
			write({ type: "tool_execution_start", toolCallId: block.id, toolName: name, args: block.input });
		} else if (block.type === "tool_result") {
			write({ type: "tool_execution_end", toolCallId: block.tool_use_id, toolName: toolNames.get(String(block.tool_use_id)) ?? "unknown", isError: block.is_error === true });
		}
	}
	if (message.type === "assistant") write({ type: "turn_end" });
}

async function research(brief: string): Promise<number> {
	const env = process.env;
	if (env.CP_KIND !== "research" || env.CP_ROLE !== "planner") throw new Error(`native claude runs research jobs only, not ${env.CP_KIND}/${env.CP_ROLE}`);
	const [jobId, runDir, worktree, artifactPath] = [env.CP_JOB_ID, env.CP_RUN_DIR, env.CP_WORKTREE, env.CP_ARTIFACT_PATH];
	if (!jobId || !runDir || !worktree || !artifactPath) throw new Error("native claude worker started without its job identity");
	write({ type: "agent_start" });
	const result = await runClaudeSpike({
		job: { job_id: jobId, delivery: env.CP_DELIVERY as Delivery, runDir, worktree, artifactPath },
		prompt: brief,
		signal: abort.signal,
		onMessage: relay,
		maxTurns: Number(env.CP_NATIVE_MAX_TURNS) || 40,
		timeoutMs: 24 * 60 * 60_000,
		...(env.CP_NATIVE_MODEL ? { model: env.CP_NATIVE_MODEL } : {}),
	});
	const usage = piUsage(result.usage, costUsd);
	write(usage ? { type: "message_end", message: { role: "assistant", model: result.initModel ?? "claude", usage } } : { type: "usage_unavailable", status: result.usage.usageStatus });
	const lockdown = result.lockdown?.verdict ?? "unchecked";
	const counts = { seen: result.lockdown?.seen, extra: result.lockdown?.extra };
	write({ type: "native_run", claude_version: result.claudeVersion, lockdown, ...counts, exit_code: result.exit?.code ?? null, report: Boolean(result.report), usage: result.usage.usageStatus, denials: result.denials.length, report_refusals: result.reportRefusals.length });
	process.stderr.write(`[native claude] exit ${result.exit?.code ?? result.exit?.signal ?? "none"}; lockdown ${lockdown}; report ${result.report ? "accepted" : "none"}${result.error ? `; ${result.error}` : ""}\n`);
	if (!result.report) return result.exit?.code || 1;
	write({ type: "agent_settled" });
	return 0;
}

function command(line: string): void {
	let request: { id?: unknown; type?: unknown; message?: unknown };
	try {
		request = JSON.parse(line) as typeof request;
	} catch {
		return;
	}
	const reply = (body: Record<string, unknown>) => write({ type: "response", id: request.id, command: request.type, ...body });
	if (request.type === "get_state") return reply({ success: true, data: { sessionId: process.env.CP_JOB_ID, sessionFile: join(process.env.CP_RUN_DIR ?? "", "native-claude") } });
	if (request.type === "prompt" && run === undefined && typeof request.message === "string") {
		reply({ success: true, data: { disposition: "started" } });
		run = research(request.message).catch((error: unknown) => {
			process.stderr.write(`[native claude] refused: ${(error as Error).message}\n`);
			return 1;
		});
		void run.then((code) => (code === 0 ? undefined : process.exit(code)));
		return;
	}
	reply({ success: false, error: nativeFollowUpRefusal(process.env.CP_JOB_ID ?? "this job", String(request.type)) });
}

/** Stdin end or SIGTERM aborts a live run; the exit waits for claude's observed exit inside the run. */
async function stop(): Promise<void> {
	abort.abort();
	process.exit((await run) ?? 0);
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => void stop());
process.on("SIGTERM", () => void stop());
