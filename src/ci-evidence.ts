/**
 * awaiting_merge PR4: head-keyed CI evidence per job (`state/runs/<id>/ci-evidence.json`). An operator-forwarded
 * result is display-only (ask-81b54d83f0b2): native CI alone gates the human_handoff handoff, and nothing here is read
 * by a gate. A credential-shaped quote or url is refused, never stored.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CI_EVIDENCE_KEEP, type CiEvidenceFile, type CiObservation, isoTimestamp, paths, validateCiEvidenceFile } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";

export class CiEvidenceError extends Error {}

/** What an operator may forward: a CI outcome, never `none`/`unreadable` (those are native read facts). */
export const FORWARDED_RESULTS = ["success", "failure", "pending"] as const;
export type ForwardedResult = (typeof FORWARDED_RESULTS)[number];

export function readCiEvidence(home: string, jobId: string): CiEvidenceFile | undefined {
	const file = join(home, paths.ciEvidenceFile(jobId));
	if (!existsSync(file)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new CiEvidenceError(`${file} is not readable JSON: ${(error as Error).message}`);
	}
	const parsed = validateCiEvidenceFile(raw);
	if (!parsed.ok) throw new CiEvidenceError(`${file} is not a valid CI evidence file: ${parsed.errors.join("; ")}`);
	return parsed.value;
}

export interface ForwardedCiInput {
	home: string;
	jobId: string;
	repo: string;
	headSha: string;
	result: ForwardedResult;
	/** Already verified against the operator's own messages (`requireOperatorQuote`). */
	operatorQuote: string;
	/** The job's current head, when known: a forward for any other sha is refused. */
	currentHead?: string | undefined;
	url?: string | undefined;
	now?: Date;
}

/** Append one forwarded observation (oldest dropped past CI_EVIDENCE_KEEP); an identical repeat appends nothing. */
export function recordForwardedCi(input: ForwardedCiInput): CiObservation {
	const head = input.headSha.trim().toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(head)) throw new CiEvidenceError("head_sha must be the full 40-hex commit sha");
	if (input.currentHead && input.currentHead.toLowerCase() !== head) {
		throw new CiEvidenceError(`${input.jobId}'s current head is ${input.currentHead}; a forwarded result for ${head} would describe a superseded head`);
	}
	if (!(FORWARDED_RESULTS as readonly string[]).includes(input.result)) throw new CiEvidenceError(`result must be one of ${FORWARDED_RESULTS.join(", ")}`);
	if (input.url !== undefined && !/^https:\/\/[^\s@?#]+$/.test(input.url)) throw new CiEvidenceError("url must be a plain https url with no credentials, query or fragment");
	for (const [field, text] of [["operator_quote", input.operatorQuote], ["url", input.url ?? ""]] as const) {
		const hit = SECRET_PATTERNS.find((pattern) => pattern.re.test(text));
		if (hit) throw new CiEvidenceError(`refusing to store ${field}: it carries a ${hit.name}; forward the CI result without the credential`);
	}
	const observation: CiObservation = {
		head_sha: head, result: input.result, source: "forwarded", observed_at: isoTimestamp(input.now ?? new Date()),
		...(input.url ? { url: input.url } : {}), operator_quote: input.operatorQuote,
	};
	const prior = readCiEvidence(input.home, input.jobId);
	if (prior && prior.repo !== input.repo) throw new CiEvidenceError(`${input.jobId}'s CI evidence is for ${prior.repo}, not ${input.repo}`);
	const last = prior?.observations.findLast((entry) => entry.source === "forwarded" && entry.head_sha === head);
	if (last && last.result === observation.result && last.operator_quote === observation.operator_quote && last.url === observation.url) return last;
	const file: CiEvidenceFile = {
		schema_version: 1, job_id: input.jobId, repo: input.repo,
		observations: [...(prior?.observations ?? []), observation].slice(-CI_EVIDENCE_KEEP),
	};
	const parsed = validateCiEvidenceFile(file);
	if (!parsed.ok) throw new CiEvidenceError(`refusing to write invalid CI evidence: ${parsed.errors.join("; ")}`);
	const path = join(input.home, paths.ciEvidenceFile(input.jobId));
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteJson(path, parsed.value);
	return observation;
}
