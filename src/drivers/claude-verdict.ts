/** N4h: picp's `report_verdict` as an in-process SDK MCP tool for a native gate-reviewer, on pi's own handler. */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { LenientGateReviewSchema } from "../../extensions/worker-reporter/index.ts";
import type { SpikeJob } from "./native-guards.ts";
import { type VerdictState, verdictReport } from "./native-verdict.ts";

export { type VerdictState, verdictReport } from "./native-verdict.ts";

export const VERDICT_TOOL = "mcp__picp__report_verdict";

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
