import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ArtifactStore } from "./artifacts.ts";
import type { MandateStore } from "./mandate.ts";
import { plannerInputFiles, plannerInputText } from "./planner-inputs.ts";

export function gateInputDigest(home: string, jobId: string, artifacts: ArtifactStore, mandates?: MandateStore): string {
	const grants = mandates?.list() ?? [];
	const aliases = grants.flatMap((grant) => grant.same_work_replacements ?? []).filter((entry) => entry.replacement_job_id === jobId);
	const governing = grants.flatMap((grant) => grant.continuity?.admissions.some((entry) => entry.continuation_work !== false && (entry.job_id === jobId || aliases.some((alias) => alias.source_grant_id === grant.id && alias.work_id === entry.job_id))) ? grant.continuity.governing_input_refs : []);
	const files = [...new Set([artifacts.file(jobId), ...plannerInputFiles(home, jobId), ...governing, ...aliases.flatMap((entry) => entry.prior_findings_refs)])].sort();
	plannerInputText(files);
	return createHash("sha256").update(JSON.stringify(files.map((file) => [file, readFileSync(file, "utf8")]))).digest("hex");
}
