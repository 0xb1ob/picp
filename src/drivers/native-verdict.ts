/** N4h/C6: pi's `report_verdict` handler for a native reviewer, SDK-free (Claude and Codex). */
import { type JobContext, LenientGateReviewSchema, verdictReporter } from "../../extensions/worker-reporter/index.ts";
import { type GateReview, validate } from "../contracts.ts";
import type { SpikeJob } from "./native-guards.ts";

export interface VerdictState {
	verdict?: GateReview;
	refusals: string[];
}

/**
 * pi's `report_verdict` for one native reviewer: the same lenient parameter check pi runs before execute, then pi's
 * handler (clamp, verdictChecks, repair cap, write-once VERDICT_FILE and raw file). A wrong job or second call refuses.
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
