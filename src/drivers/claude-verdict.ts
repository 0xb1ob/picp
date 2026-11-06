/** N4h: picp's `report_verdict` as an in-process SDK MCP tool for a native gate-reviewer, on pi's own handler. */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type JobContext, LenientGateReviewSchema, verdictReporter } from "../../extensions/worker-reporter/index.ts";
import { type GateReview, validate } from "../contracts.ts";
import type { SpikeJob } from "./claude-spike.ts";

export const VERDICT_TOOL = "mcp__picp__report_verdict";

export interface VerdictState {
	verdict?: GateReview;
	refusals: string[];
}

/**
 * pi's `report_verdict` for one native reviewer: the same lenient parameter check pi runs before execute, then pi's
 * handler (clamp, verdictChecks, repair cap, write-once VERDICT_FILE and raw file). A wrong job or a second call refuses.
 */
export function verdictReport(job: SpikeJob, state: VerdictState): (payload: unknown) => Promise<{ text: string; isError: boolean }> {
	const context: JobContext = { job_id: job.job_id, kind: job.kind, delivery: job.delivery, role: job.role, runDir: job.runDir, worktree: job.worktree, mayAskOperator: false };
	const report = verdictReporter(context);
	const refuse = (text: string) => (state.refusals.push(text), { text, isError: true });
	return async (payload) => {
		const shape = validate(LenientGateReviewSchema, payload);
		if (!shape.ok) return refuse(`Validation failed for tool "report_verdict":\n${shape.errors.map((e) => `  - ${e}`).join("\n")}`);
		try {
			const result = await report(payload);
			const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
			if (result.details.rejected) return refuse(text);
			if (result.details.review) state.verdict = result.details.review;
			return { text, isError: false };
		} catch (error) {
			return refuse((error as Error).message);
		}
	};
}

/** The reviewer's `picp` MCP server: `report_verdict` and nothing else (no `report_result`, no forge tools). */
export function verdictServer(job: SpikeJob, state: VerdictState) {
	const run = verdictReport(job, state);
	const shape = Object.fromEntries(Object.keys(LenientGateReviewSchema.properties).map((key) => [key, z.any().optional()]));
	const report = tool(
		"report_verdict",
		"Finish this review by reporting your verdict (job_id, verdict, flags, reasons; revisions only when revise). Call it once, as your final action.",
		shape,
		async (args) => {
			const { text, isError } = await run(args);
			return { content: [{ type: "text" as const, text }], isError };
		},
	);
	return createSdkMcpServer({ name: "picp", version: "0.0.0", tools: [report] });
}
