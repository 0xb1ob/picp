/**
 * What `cp_dispatch` reads out of a job before routing: the routing axes and the H6 risk gate.
 * Split out of src/dispatch.ts (its size pin); `Dispatcher` is the only caller.
 */
import type { JobKind } from "./contracts.ts";
import type { DispatchRequest, ResolvedTask } from "./dispatch.ts";
import type { Job } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";
import { resolveRoutingInputs } from "./pipeline.ts";
import { inferredRiskGate, recordedProvenance, recordedRisk, riskField } from "./risk-warning.ts";

/**
 * The axes routing is given, composed from the job's own words — one function
 * for the same reason `selectProfile` is one (routing T5).
 *
 * cp-rte / cp-routing-provenance: routing's rubric matches on scope and risk,
 * and both defaulted to S/low whenever a caller omitted them — so unlabelled
 * work silently routed as small. Every axis the caller did not name is assessed
 * from the job's own words (the task, or the issue the ledger holds),
 * **independently**: naming one axis never switches off the evidence for the
 * other. Advisory: a supplied value always wins its own axis, and where each
 * value came from is recorded on the run.
 */
export function composeRoutingInputs(
	request: DispatchRequest,
	issue: Job,
	task: ResolvedTask,
): ReturnType<typeof resolveRoutingInputs> {
	return resolveRoutingInputs({
		text: jobText(issue, task),
		...(request.scope ? { scope: request.scope } : {}),
		...riskField(request.risk, issue, task.forInference),
		...(request.inputsFrom ? { suppliedBy: request.inputsFrom } : {}),
	});
}

/** Everything a job says about itself: the words routing and the H6 risk warning both read. */
const jobText = (issue: Job, task: ResolvedTask): string => [task.forInference, issue.title, issue.description ?? ""].join("\n");

/** H6: the gate's risk, from routing's axis and a risk a parent (`risk`, a `risk:` label, a header) or planner (`recordedRisk`) recorded. */
export function riskGate(mandates: MandateStore | undefined, request: DispatchRequest, issue: Job, task: ResolvedTask, job: { jobId: string; project: string; kind: JobKind }, inputs: ReturnType<typeof resolveRoutingInputs>) {
	const recorded = recordedRisk({ ...(request.risk && recordedProvenance(inputs.provenance.risk) ? { requested: request.risk } : {}), ...(request.recordedRisk ? { pipeline: request.recordedRisk } : {}), job: issue, taskText: task.forInference });
	return { ...inferredRiskGate({ ...(mandates ? { mandates } : {}), job: { ...job, pathHints: [task.forInference] }, routed: inputs.risk, routedFrom: inputs.provenance.risk, ...(recorded ? { recorded: recorded.risk, recordedFrom: recorded.from } : {}), text: jobText(issue, task) }), ...(recorded ? { recorded } : {}) };
}
