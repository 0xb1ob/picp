import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths, validate, VerdictRecordSchema, type VerdictRecord } from "./contracts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { MandateStore } from "./mandate.ts";
import { readPriorAttempts } from "./gate.ts";
import { gateInputDigest } from "./gate-input.ts";
import { plannerInputFiles } from "./planner-inputs.ts";

export function normalPassDigest(home: string, jobId: string, artifacts: ArtifactStore, mandates?: MandateStore): string | undefined {
	const decision = readPriorAttempts(home, jobId).decisions.at(-1);
	if (!decision) return undefined;
	const file = join(home, paths.gateVerdictFile(jobId, decision.attempt));
	if (!existsSync(file)) {
		if (decision.verdict === "pass") throw new Error("copied PASS is not an actual replacement gate");
		return undefined;
	}
	let raw: VerdictRecord;
	try {
		const parsed = validate<VerdictRecord>(VerdictRecordSchema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok) throw new Error("invalid normal verdict record");
		raw = parsed.value;
	} catch (cause) { throw new Error(`${file}: invalid normal verdict record`, { cause }); }
	if (decision.verdict !== "pass" || raw.job_id !== jobId || raw.review.verdict !== "pass" ||
		raw.review.flags.destructive_scope || raw.review.flags.scope_growth) throw new Error("replacement needs actual current normal PASS; revise or escalate cannot hand off");
	const digest = gateInputDigest(home, jobId, artifacts, mandates);
	const binding = join(home, paths.gateRunDir(jobId, decision.attempt), "input-digest");
	if (existsSync(binding)) {
		if (readFileSync(binding, "utf8") !== digest) throw new Error("normal PASS input moved; no dependency changed");
	} else {
		const brief = join(home, paths.gateRunDir(jobId, decision.attempt), "brief.md");
		if (!existsSync(brief) || [artifacts.file(jobId), ...plannerInputFiles(home, jobId)].some((input) => statSync(input).mtimeMs > statSync(brief).mtimeMs)) throw new Error("legacy PASS cannot be bound to unchanged complete inputs; run the normal gate");
	}
	return createHash("sha256").update(JSON.stringify([decision, raw, digest])).digest("hex");
}
