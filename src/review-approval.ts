/**
 * Pin of a plan approval to the artifact's sha256.
 *
 * Written when a decision approves a plan (mandate or a prior pin). Read by
 * `PipelineRunner#authorize`, which decides the checkpoint without asking only
 * when the artifact on disk still hashes to what was approved. A changed plan
 * is never approved by an old decision. Hashing reads bytes and never a body.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isoTimestamp, paths, type ReviewApproval, SCHEMA_VERSION, validateReviewApproval } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export class ReviewApprovalError extends Error {}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export class ReviewApprovalStore {
	readonly #home: string;

	constructor(home: string) {
		this.#home = home;
	}

	file(jobId: string): string {
		return join(this.#home, paths.reviewApproval(jobId));
	}

	/** The approval, or `undefined` when none exists or the file is malformed. */
	read(jobId: string): ReviewApproval | undefined {
		const file = this.file(jobId);
		if (!existsSync(file)) return undefined;
		try {
			const parsed = validateReviewApproval(JSON.parse(readFileSync(file, "utf8")));
			return parsed.ok ? parsed.value : undefined;
		} catch {
			return undefined;
		}
	}

	/** Record the approval. The newest round wins; the hash pins it to one plan. */
	write(input: { jobId: string; questionSeq: number; artifactPath: string; by: string; at?: string }): ReviewApproval {
		if (!existsSync(input.artifactPath)) {
			throw new ReviewApprovalError(`${input.jobId}: nothing to approve — no artifact at ${input.artifactPath}`);
		}
		const record: ReviewApproval = {
			schema_version: SCHEMA_VERSION,
			job_id: input.jobId,
			question_seq: input.questionSeq,
			artifact_sha256: sha256File(input.artifactPath),
			approved_at: input.at ?? isoTimestamp(),
			by: input.by,
		};
		const validated = validateReviewApproval(record);
		if (!validated.ok) throw new ReviewApprovalError(`invalid review approval: ${validated.errors.join("; ")}`);
		atomicWriteJson(this.file(input.jobId), validated.value);
		return validated.value;
	}

	/** Does an approval exist for exactly the bytes now at `artifactPath`? */
	matches(jobId: string, artifactPath: string): boolean {
		const approval = this.read(jobId);
		if (!approval || !existsSync(artifactPath)) return false;
		return sha256File(artifactPath) === approval.artifact_sha256;
	}
}
