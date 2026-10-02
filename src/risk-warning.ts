/**
 * H6: an inferred risk:high warns; an assessed risk:high gates.
 *
 * `inferScopeAndRisk` is a keyword heuristic: "delete", "migrate", "token" in a
 * task's words make it `risk: high`. Where a parent (cp_dispatch / cp_pipeline
 * start `risk`, cp_pipeline classify, cp_job create `risk` as a `risk:` label)
 * or a planner (`self_assessment` with `destructive_scope: false` and nothing
 * else escalating) has recorded `low`, or the task / job description declares
 * it in its header (`Scope S, risk low.`), that keyword-only high no longer
 * stops `ask_on: [risk:high]` from dispatching — it becomes a one-line warning
 * naming the matched keywords and where the low was recorded, carried on the
 * result, in the run journal and relayed by the cp-bridge. Routing is
 * unchanged: it may still pick the risky-ship tier on the inferred high. A high
 * that was `explicit` or `assessed` gates exactly as before, and a recorded or
 * declared high (riskkw-f10) gates, routes high and beats every low.
 *
 * A pipeline's own axis is a record only when it was `explicit` or `assessed`: a
 * `defaulted` axis (nobody named it, so routing's standing low was used) and an
 * `inferred` one are not records, and the planner's own half is named as its own
 * source (`assessed by the planner`) rather than folded into the pipeline's.
 */

import type { Job, JobKind, Risk, RoutingProvenance } from "./contracts.ts";
import { parseJobLabels } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";
import { acceptedRiskMatches } from "./pipeline.ts";

/** Where a recorded risk came from; the warning, escalation evidence and `routing_resolved` name it (riskkw-f10). */
export type RecordedRiskSource = "dispatch" | "planner" | "pipeline" | "fleet_record" | "job_label" | "description_header" | "task_header";
const RECORDED_AS: Record<RecordedRiskSource, string> = {
	dispatch: "recorded on the dispatch",
	planner: "assessed by the planner",
	pipeline: "recorded by the pipeline",
	fleet_record: "recorded at dispatch",
	job_label: "recorded on the job's risk: label",
	description_header: "recorded in the job description header",
	task_header: "recorded in the task header",
};
const HEADER_END_RE = /^\s{0,3}(?:#{2,6}\s|(?:-{3,}|\*{3,}|_{3,})\s*$|`{3,}|~{3,})/;
// ponytail: a clause-start `risk [:=] low|high`, not a parser; a following gate/escalation noun names the gate, not a declaration.
const DECLARED_RE = /(?:^|[.;,(|]\s*|^\s*(?:[-*+]\s+|\|\s*)?(?:\*\*|__)?)\brisk(?:\*\*|__)?\s*(?:[:=]\s*)?(?:\*\*|__)?\s*(low|high)\b(?![-:\w])(?!\s*(?:escalations?|gates?|jobs?|asks?|checkpoints?|warnings?|refusals?|approvals?)\b)/gim;

/** The risk a task or spec declares in its header (before the first ##+ heading, rule or fence; 20 lines, 2000 chars); a declared high wins. */
export function declaredRisk(text: string | undefined): Risk | undefined {
	if (!text) return undefined;
	const header: string[] = [];
	for (const line of text.split("\n").slice(0, 20)) {
		if (HEADER_END_RE.test(line)) break;
		header.push(line);
	}
	const found = [...header.join("\n").slice(0, 2000).matchAll(DECLARED_RE)].map((match) => (match[1] ?? "").toLowerCase());
	return found.includes("high") ? "high" : found.includes("low") ? "low" : undefined;
}

type JobRecord = Pick<Job, "labels" | "description">;

/** What the job itself records or declares: its label, then its description header, then the task header. */
function jobRecords(job: JobRecord | undefined, taskText: string | undefined): Array<{ risk: Risk; from: RecordedRiskSource }> {
	const out: Array<{ risk: Risk; from: RecordedRiskSource }> = [];
	const label = job ? parseJobLabels(job.labels).risk : undefined;
	if (label) out.push({ risk: label, from: "job_label" });
	const described = declaredRisk(job?.description);
	if (described) out.push({ risk: described, from: "description_header" });
	const declared = declaredRisk(taskText);
	if (declared) out.push({ risk: declared, from: "task_header" });
	return out;
}

/**
 * A risk the pipeline composed for the implementer dispatch (`src/pipeline.ts`): the value,
 * which half of the composition recorded it, and the axis provenance it came from. A
 * `defaulted` axis is "nobody named it", so it is not a record at all.
 */
export interface PipelineRecordedRisk {
	risk: Risk;
	/** `pipeline` = an explicit/assessed low frozen at `cp_pipeline start`; `planner` = the planner's `self_assessment`. */
	from?: "pipeline" | "planner";
	provenance: RoutingProvenance;
}

/**
 * The one precedence the dispatch gate, the dry run and the cp_send gate share: any high (the
 * job's own record or declaration first, then the caller's; fail closed), then an
 * explicit/assessed requested risk (the caller filters provenance), then the pipeline's, then
 * the fleet record's, then the job's own low. The pipeline's own entry is read only when it
 * was explicit or assessed: a `defaulted`/`inferred` pipeline axis is not a record.
 */
export function recordedRisk(input: { requested?: Risk; pipeline?: PipelineRecordedRisk; fleet?: Risk; job?: JobRecord; taskText?: string }): { risk: Risk; from: RecordedRiskSource } | undefined {
	const own = jobRecords(input.job, input.taskText);
	const pipeline = input.pipeline && recordedProvenance(input.pipeline.provenance) ? [{ risk: input.pipeline.risk, from: input.pipeline.from ?? ("pipeline" as const) }] : [];
	const callers: Array<{ risk: Risk; from: RecordedRiskSource }> = [
		...(input.requested ? [{ risk: input.requested, from: "dispatch" as const }] : []),
		...pipeline,
		...(input.fleet ? [{ risk: input.fleet, from: "fleet_record" as const }] : []),
	];
	return [...own, ...callers].find((entry) => entry.risk === "high") ?? callers[0] ?? own[0];
}

/** Routing's risk input: the caller's, else `high` when the job records or declares one. A low never routes. */
export function riskField(requested: Risk | undefined, job: JobRecord, taskText: string): { risk?: Risk } {
	if (requested) return { risk: requested };
	return jobRecords(job, taskText).some((entry) => entry.risk === "high") ? { risk: "high" } : {};
}

/** Every non-negated risk keyword the text matched, lower-cased and de-duplicated (bounded). */
export function riskKeywords(text: string, alsoBenign?: (text: string, index: number, word: string) => boolean): string[] {
	return [...new Set(acceptedRiskMatches(text, alsoBenign).map((m) => m.word.toLowerCase()))].slice(0, 8);
}

// riskkw-qno: senses only the warning drops (inference and the gate still count them): an audit tag
// (`delete:`), a named item that is not approved (`P5 (migration) is not approved`), the `gh auth status` probe,
// and deleting a named source/doc file or explicitly dead code (`Delete src/x.ts`, `delete dead code`; the ponytail batches).
// A bare `delete the files`/`delete code`/`delete docs` still warns: only a path or a dead/stale/unused/obsolete noun is benign.
// ponytail: four bounded patterns from observed false warnings, not a parser.
const DELETE_CODE_OBJECT_RE = /^\s+(?:the\s+)?(?:[\w@./-]+\.(?:tsx?|mjs|js|css|md|sh)\b|(?:dead|stale|unused|obsolete)\s+(?:files?|code|symbols?|docs?|exports?)\b)/i;
function warningOnlyBenign(text: string, index: number, word: string): boolean {
	const after = text.slice(index + word.length);
	if (after.startsWith(":")) return true;
	if (/^delete$/i.test(word) && DELETE_CODE_OBJECT_RE.test(after)) return true;
	if (/^[\w\s-]*\)?[*_\s]*(?:is|are)\s+not\s+approved\b/i.test(after)) return true;
	return /^auth$/i.test(word) && /\bgh\s+$/i.test(text.slice(0, index)) && /^\s+status\b/i.test(after);
}

/** A risk somebody set on purpose, never one keyword inference or a default produced. */
export function recordedProvenance(from: RoutingProvenance | undefined): boolean {
	return from === "explicit" || from === "assessed";
}

/**
 * The risk the `ask_on: [risk:high]` gate reads, and the warning when it stood
 * down. `routed`/`routedFrom` are routing's own risk axis; `recorded` is a risk
 * a parent or planner recorded (which may differ from what routing was given).
 * Only a recorded `low` against a high that is not itself explicit/assessed
 * lowers the gate's risk; the warning is written only when a covering mandate
 * would otherwise have asked. A recorded `high` always gates (riskkw-f10).
 */
export function inferredRiskGate(input: {
	mandates?: MandateStore;
	job: { jobId: string; project: string; kind?: JobKind; pathHints?: string[] };
	routed: Risk;
	routedFrom: RoutingProvenance;
	recorded?: Risk;
	/** Where `recorded` came from; the warning and a refused high's evidence name it. */
	recordedFrom?: RecordedRiskSource;
	text: string;
}): { risk: Risk; warning?: string; evidence?: string } {
	const { routed, routedFrom, recorded, job } = input;
	if (recorded === "high") return { risk: "high", ...(input.recordedFrom && input.recordedFrom !== "dispatch" ? { evidence: `risk high ${RECORDED_AS[input.recordedFrom]}` } : {}) };
	if (recorded !== "low" || (routed === "high" && recordedProvenance(routedFrom))) return { risk: routed };
	const keywords = riskKeywords(input.text, warningOnlyBenign);
	// Every hit was a warning-only benign sense: the risk is low either way, so no wake line.
	if (keywords.length === 0 && (routed !== "high" || riskKeywords(input.text).length > 0)) return { risk: "low" };
	if (!input.mandates?.wouldAskRiskHigh(job, "high")) return { risk: "low" };
	const words = keywords.length > 0 ? keywords.join(", ") : "matched at dispatch";
	return {
		risk: "low",
		warning: `${job.jobId}: warning: risk:high inferred from keywords only (${words}); risk low was ${input.recordedFrom ? RECORDED_AS[input.recordedFrom] : "recorded"}, so ask_on risk:high warned instead of gating`,
	};
}
