/**
 * Conversation revise / planner question → the promote `cp_send` delivers.
 *
 * The parent passes the operator sentence. This module maps it. No new tool,
 * no console. The bridge carries the sentence as plain prose.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointStore } from "./checkpoint.ts";
import { isSafeJobId, LAYOUT, paths, SCHEMA_VERSION } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export const PLAN_REVISE_MARK = "Revision requested on the filed plan:";
export const PLAN_QUESTION_MARK = "Question for the planner:";

const JOB_ID = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";
const REVISE_PHRASE = new RegExp(`^revise the plan for job ${JOB_ID}:\\s*([\\s\\S]+)$`, "i");
const QUESTION_PHRASE = new RegExp(`^ask the planner of job ${JOB_ID}:\\s*([\\s\\S]+)$`, "i");

export interface PlanLink {
	researchId: string;
	shipId: string;
}

export type PlanSendDecision =
	| { kind: "ignore" }
	| { kind: "refuse"; reason: string }
	| { kind: "revise"; researchId: string; shipId: string; message: string; text: string }
	| { kind: "question"; researchId: string; shipId: string; message: string };

export function planReviseBrief(artifactPath: string, revision: string): string {
	return [
		PLAN_REVISE_MARK,
		revision.trim(),
		"",
		`Artifact path: ${artifactPath}`,
		"Update that artifact in place. Do not edit anything else. File a new envelope when the artifact has changed; a changed artifact is re-gated.",
		"This is the only open revise until that envelope is re-gated.",
	].join("\n");
}

export function planQuestionBrief(question: string): string {
	return [
		PLAN_QUESTION_MARK,
		question.trim(),
		"",
		"Answer with one blocked envelope, not a new plan. Put the answer in blockers as {question, why, options, recommended, assume_if_unanswered}. Do not set status done. Do not update the artifact.",
	].join("\n");
}

export function parseOperatorPlanAsk(message: string): { kind: "revise" | "question"; jobId: string; text: string } | undefined {
	const revise = REVISE_PHRASE.exec(message.trim());
	if (revise?.[1] && revise[2]?.trim()) return { kind: "revise", jobId: revise[1], text: revise[2].trim() };
	const question = QUESTION_PHRASE.exec(message.trim());
	if (question?.[1] && question[2]?.trim()) return { kind: "question", jobId: question[1], text: question[2].trim() };
	return undefined;
}

export function decisionReviseAt(home: string, researchId: string): string | undefined {
	const file = join(home, paths.runDir(researchId), "decision-revise.json");
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown };
		return typeof parsed.at === "string" ? parsed.at : undefined;
	} catch {
		return undefined;
	}
}

export function recordPlanRevise(home: string, researchId: string, text: string, at: string): void {
	atomicWriteJson(join(home, paths.runDir(researchId), "decision-revise.json"), {
		schema_version: SCHEMA_VERSION,
		at,
		text: text.slice(0, 1000),
	});
}

function readLink(home: string, researchId: string): PlanLink | undefined {
	if (!isSafeJobId(researchId)) return undefined;
	const file = join(home, paths.pipelineFile(researchId));
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { research_id?: unknown; ship_id?: unknown };
		if (parsed.research_id !== researchId || typeof parsed.ship_id !== "string" || !isSafeJobId(parsed.ship_id)) return undefined;
		return { researchId, shipId: parsed.ship_id };
	} catch {
		return undefined;
	}
}

export function pipelineFor(home: string, jobId: string): PlanLink | undefined {
	const direct = readLink(home, jobId);
	if (direct) return direct;
	const dir = join(home, LAYOUT.pipelines);
	if (!existsSync(dir)) return undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const link = readLink(home, name.slice(0, -".json".length));
		if (link?.shipId === jobId) return link;
	}
	return undefined;
}

function latestGateDecidedAt(home: string, researchId: string): string | undefined {
	const dir = join(home, paths.runDir(researchId));
	if (!existsSync(dir)) return undefined;
	let latest: string | undefined;
	for (const name of readdirSync(dir)) {
		if (!/^gate-\d+\.json$/.test(name)) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as { decided_at?: unknown };
			if (typeof parsed.decided_at === "string" && (latest === undefined || parsed.decided_at > latest)) latest = parsed.decided_at;
		} catch {
			// A torn gate file is not a later verdict.
		}
	}
	return latest;
}

export function reviseStillOpen(home: string, researchId: string): boolean {
	const at = decisionReviseAt(home, researchId);
	if (!at) return false;
	const decided = latestGateDecidedAt(home, researchId);
	return decided === undefined || decided <= at;
}

/**
 * Two producers share this marker: `planReviseBrief` puts it on its own line with
 * the revision on the next; `PipelineRunner.revisePlan` (the escalation-answer
 * path, cp-9tq7) inlines it after the colon on the same line. Both are read here
 * so `cp_send`'s guard applies to either producer, not just this ticket's own.
 */
function quotedRevision(message: string): string | undefined {
	const trimmed = message.trim();
	if (!trimmed.startsWith(PLAN_REVISE_MARK)) return undefined;
	const rest = trimmed.slice(PLAN_REVISE_MARK.length);
	const inline = rest.split("\n")[0]?.trim();
	if (inline) return inline;
	const nextLine = rest.split("\n")[1]?.trim();
	return nextLine ? nextLine : undefined;
}

/** Sanctioned path once the plan is approved and the implementer is out. */
export function implementedReviseRefusal(researchId: string, shipId: string): string {
	return (
		`${researchId}: plan checkpoint for ${shipId} is already approved and the implementer has been dispatched. ` +
		`Refusing this revise. Sanctioned path: start a new research job, or steer the implementer with cp_send ${shipId}.`
	);
}

export function decidePlanSend(input: {
	home: string;
	jobId: string;
	message: string;
	implementerDispatched: (shipId: string) => boolean;
}): PlanSendDecision {
	const trimmed = input.message.trim();
	const phrase = parseOperatorPlanAsk(trimmed);
	const markerRevise = !phrase && trimmed.startsWith(PLAN_REVISE_MARK);
	const markerQuestion = !phrase && trimmed.startsWith(PLAN_QUESTION_MARK);
	if (!phrase && !markerRevise && !markerQuestion) return { kind: "ignore" };

	const named = phrase?.jobId ?? input.jobId;
	const link = pipelineFor(input.home, named) ?? pipelineFor(input.home, input.jobId);
	if (!link) {
		return {
			kind: "refuse",
			reason: `${named}: no pipeline — "revise the plan" / "ask the planner" apply to a pipeline planner, not a standalone job`,
		};
	}
	const namedLink = pipelineFor(input.home, named);
	const requestLink = pipelineFor(input.home, input.jobId);
	if (namedLink && requestLink && namedLink.researchId !== requestLink.researchId) {
		return {
			kind: "refuse",
			reason: `${input.jobId}: that sentence names ${named}, a different pipeline. cp_send ${namedLink.researchId} with the sentence.`,
		};
	}

	const kind = phrase?.kind ?? (markerRevise ? "revise" : "question");
	const text = phrase?.text ?? (kind === "revise" ? quotedRevision(trimmed) : trimmed.split("\n")[1]?.trim());
	if (!text) {
		return { kind: "refuse", reason: `${link.researchId}: empty ${kind} — the sentence needs text after the colon` };
	}

	if (kind === "revise" && new CheckpointStore(input.home).get(link.shipId)?.decision === "approved" && input.implementerDispatched(link.shipId)) {
		return { kind: "refuse", reason: implementedReviseRefusal(link.researchId, link.shipId) };
	}
	if (input.jobId !== link.researchId) {
		return {
			kind: "refuse",
			reason: `cp_send ${link.researchId} (the planner), not ${input.jobId}, with the operator sentence as the message.`,
		};
	}
	if (kind === "revise" && reviseStillOpen(input.home, link.researchId)) {
		return {
			kind: "refuse",
			reason: `${link.researchId}: one open revise at a time. Wait for the new envelope, then cp_pipeline advance. Do not send another revise until that one is re-gated.`,
		};
	}

	const artifactPath = join(input.home, paths.artifactFile(link.researchId));
	if (kind === "revise") {
		return {
			kind: "revise",
			researchId: link.researchId,
			shipId: link.shipId,
			text,
			message: trimmed.startsWith(PLAN_REVISE_MARK) ? trimmed : planReviseBrief(artifactPath, text),
		};
	}
	return {
		kind: "question",
		researchId: link.researchId,
		shipId: link.shipId,
		message: trimmed.startsWith(PLAN_QUESTION_MARK) ? trimmed : planQuestionBrief(text),
	};
}
