import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { GateHandoffSchema, JobIdSchema, isInside, paths, runtimeRootFor, validate, type GateHandoff } from "./contracts.ts";
import { readJobsDocument } from "./ledger.ts";
import { originalScopeDigest } from "./mandate-continuity.ts";
import { EscalationStore, escalationApproves } from "./escalation.ts";
import { normalPassDigest } from "./gate-pass.ts";
import { ArtifactStore } from "./artifacts.ts";
import { MandateStore } from "./mandate.ts";
import { plannerInputFiles } from "./planner-inputs.ts";

export const handoffDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const sha = Type.String({ pattern: "^[0-9a-f]{64}$" });
const inputsSchema = Type.Object({
	jobs: Type.Array(Type.Object({ id: JobIdSchema, scope_digest: sha }, { additionalProperties: false }), { minItems: 3, maxItems: 66 }),
	refs: Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 1000 }), digest: sha }, { additionalProperties: false }), { minItems: 1, maxItems: 512 }),
}, { additionalProperties: false });
export type HandoffInputs = Static<typeof inputsSchema>;

export function handoffFiles(home: string, replacement: string, id: string) {
	if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid handoff id");
	const base = join(home, paths.runDir(replacement), `gate-handoff-${id}.json`);
	return { base, inputs: `${base}.inputs`, prepared: `${base}.prepared`, committed: `${base}.committed` };
}

export function readHandoff(file: string): GateHandoff {
	try {
		const parsed = validate<GateHandoff>(GateHandoffSchema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok || parsed.value.phase !== "waiting_review" || parsed.value.pass_digest) throw new Error("invalid original handoff record");
		let record = parsed.value;
		if (record.source_job_id === record.replacement_job_id || new Set(record.edges.map((edge) => edge.dependent_job_id)).size !== record.edges.length ||
			record.edges.some((edge) => edge.original_blocker_id !== record.source_job_id || edge.replacement_blocker_id !== record.replacement_job_id ||
				edge.dependent_job_id === record.source_job_id || edge.dependent_job_id === record.replacement_job_id)) throw new Error("invalid handoff edge binding");
		for (const phase of ["prepared", "committed"] as const) {
			if (!existsSync(`${file}.${phase}`)) continue;
			if (phase === "committed" && record.phase !== "prepared") throw new Error("committed handoff has no preparation");
			const next = validate<GateHandoff>(GateHandoffSchema, JSON.parse(readFileSync(`${file}.${phase}`, "utf8")));
			if (!next.ok || next.value.phase !== phase || next.value.handoff_id !== record.handoff_id ||
				next.value.source_job_id !== record.source_job_id || next.value.replacement_job_id !== record.replacement_job_id ||
				next.value.link_id !== record.link_id || next.value.created_at !== record.created_at ||
				next.value.input_digest !== record.input_digest || !next.value.pass_digest ||
				(phase === "committed" && JSON.stringify(next.value.edges) !== JSON.stringify(record.edges)) ||
				(record.pass_digest && next.value.pass_digest !== record.pass_digest) ||
				JSON.stringify(next.value.edges.map(({ provenance_reference, ...edge }) => edge)) !== JSON.stringify(record.edges.map(({ provenance_reference, ...edge }) => edge))) throw new Error(`${phase}: handoff binding changed`);
			record = next.value;
		}
		return record;
	} catch (error) { throw new Error(`${file}: ${String(error)}`); }
}

export function readHandoffInputs(home: string, record: GateHandoff): HandoffInputs {
	const file = handoffFiles(home, record.replacement_job_id, record.handoff_id).inputs;
	try {
		const text = readFileSync(file, "utf8");
		if (handoffDigest(text) !== record.input_digest) throw new Error("handoff inputs changed");
		const parsed = validate<HandoffInputs>(inputsSchema, JSON.parse(text));
		if (!parsed.ok || parsed.value.refs.some((ref) => !isInside(resolve(ref.path), runtimeRootFor(home)))) throw new Error("invalid scoped handoff inputs");
		if (JSON.stringify(parsed.value.jobs.map((job) => job.id)) !== JSON.stringify([record.source_job_id, record.replacement_job_id, ...record.edges.map((edge) => edge.dependent_job_id)]) ||
			new Set(parsed.value.refs.map((ref) => ref.path)).size !== parsed.value.refs.length) throw new Error("handoff input identities changed");
		return parsed.value;
	} catch (error) { throw new Error(`${file}: ${String(error)}`); }
}

function handoffRecords(home: string, replacement: string): GateHandoff[] {
	const dir = join(home, paths.runDir(replacement));
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((file) => /^gate-handoff-[0-9a-f]{64}\.json$/.test(file)).map((file) => {
		const record = readHandoff(join(dir, file));
		if (record.replacement_job_id !== replacement) throw new Error("handoff replacement namespace changed");
		return record;
	});
}

export function pendingHandoffs(home: string, replacement: string): GateHandoff[] {
	const records = handoffRecords(home, replacement);
	if (!records.length) return [];
	const jobs = readJobsDocument(home).jobs;
	const escalations = new EscalationStore({ home }).list();
	return records.filter((record) => {
		if (record.phase === "committed") return false;
		if (escalations.some((item) => item.gate_handoff_id === record.handoff_id && (item.status === "withdrawn" || item.status === "superseded" ||
			(item.status === "answered" && !escalationApproves(item.answer ?? "", item))))) return false;
		readHandoffInputs(home, record);
		return record.edges.some((edge) => jobs.some((job) => job.id === edge.dependent_job_id && job.status === "open" &&
			(job.blocked_by.includes(edge.original_blocker_id) || job.blocked_by.includes(edge.replacement_blocker_id))));
	});
}

export function assertHandoffProjectionReady(home: string, jobId: string): void {
	const jobs = readJobsDocument(home).jobs;
	const dependent = jobs.find((job) => job.id === jobId);
	if (!dependent) return;
	for (const job of jobs) for (const record of handoffRecords(home, job.id)) {
		if (!record.edges.some((edge) => edge.dependent_job_id === jobId &&
			(dependent.blocked_by.includes(edge.original_blocker_id) || dependent.blocked_by.includes(edge.replacement_blocker_id)))) continue;
		const inputs = readHandoffInputs(home, record);
		const stable = inputs.jobs.every((old) => jobs.some((current) => current.id === old.id && originalScopeDigest(current) === old.scope_digest)) &&
			inputs.refs.every((ref) => existsSync(ref.path) && handoffDigest(readFileSync(ref.path, "utf8")) === ref.digest) &&
			[record.source_job_id, record.replacement_job_id].every((id) => plannerInputFiles(home, id).every((path) => inputs.refs.some((ref) => ref.path === path)));
		if (record.phase !== "committed" || !stable || normalPassDigest(home, record.replacement_job_id, new ArtifactStore({ home }), new MandateStore(home)) !== record.pass_digest) {
			throw new Error(`${jobId}: handoff ${record.handoff_id} still needs actual PASS and its recorded dependency projection`);
		}
		for (const edge of record.edges.filter((edge) => edge.dependent_job_id === jobId && edge.provenance_reference.startsWith("confirmation:"))) {
			const confirmation = new EscalationStore({ home }).get(edge.provenance_reference.slice("confirmation:".length));
			if (!confirmation || confirmation.status !== "answered" || !escalationApproves(confirmation.answer ?? "", confirmation)) throw new Error(`${jobId}: handoff mechanical confirmation is no longer valid`);
		}
	}
}
