import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESCALATION_NO_MANDATE, isoTimestamp, paths, isSafeJobId, type GateHandoff, type Job } from "./contracts.ts";
import type { Escalation } from "./contracts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { FleetStore } from "./fleet.ts";
import { GateError } from "./gate.ts";
import { normalPassDigest } from "./gate-pass.ts";
import type { CommandPost } from "./command-post.ts";
import { liveUsageJobs } from "./mandate-usage.ts";
import { publishRecoveryBytes, publishRecoveryFile, recoveryDigest, recoveryTarget, validateRecoveryAuthority } from "./gate-recovery.ts";
import { handoffDigest, handoffFiles, readHandoff, readHandoffInputs, type HandoffInputs } from "./gate-handoff-store.ts";
import { escalationApproves, EscalationStore } from "./escalation.ts";
import { originalScopeDigest, continueForJob } from "./mandate-continuity.ts";
import { validReplacement } from "./mandate-replacement.ts";
import { pathExcluded, subsystemExcluded, type MandateStore } from "./mandate.ts";
import type { MandateUsageJob } from "./mandate-accounting.ts";
import { plannerInputFiles, plannerInputText } from "./planner-inputs.ts";
import type { Ledger } from "./ledger.ts";
import { requireJobLabels } from "./ledger.ts";
import type { PipelineRunner } from "./pipeline.ts";
import type { ReviewRuns } from "./review-runs.ts";
import { queued } from "./json-store.ts";
import { readTaskAddenda, taskAddendaText } from "./task-addenda.ts";

type Options = { home: string; ledger: Ledger; fleet: FleetStore; artifacts: ArtifactStore; mandates: MandateStore;
	pipeline: PipelineRunner; reviews: ReviewRuns; usage: () => readonly MandateUsageJob[] };

function confirmed(item: Escalation | undefined): boolean {
	return Boolean(item && item.status === "answered" && ["operator-quote", "operator-delegated"].includes(item.answered_by ?? "") &&
		item.basis && "operator_quote" in item.basis && escalationApproves(item.answer ?? "", item));
}

function relation(options: Options, original: Job, replacement: Job) {
	const { home, mandates, artifacts } = options;
	const incoming = mandates.list().flatMap((grant) => (grant.same_work_replacements ?? []).filter((link) => link.replacement_job_id === replacement.id).map((link) => ({ grant, link })));
	if (incoming.length) {
		if (incoming.length !== 1) throw new GateError("conflicting replacement accounting roots");
		const { grant, link } = incoming[0]!;
		if (!validReplacement(home, grant, replacement, options.ledger.read().jobs)) throw new GateError("replacement link is incomplete or its original inputs moved");
		let ancestor = replacement.id;
		for (let i = 0; i < 64 && ancestor !== original.id; i++) ancestor = grant.same_work_replacements?.find((entry) => entry.replacement_job_id === ancestor)?.original_job_id ?? "";
		if (ancestor !== original.id) throw new GateError("source is outside the committed same-work lineage");
		return { id: link.link_id, refs: link.prior_findings_refs };
	}
	const recovery = recoveryTarget(home, replacement.id);
	if (recovery) {
		if (recovery.source_job !== original.id) throw new GateError("recovery source does not match the handoff");
		validateRecoveryAuthority(home, recovery, mandates);
		if (recovery.inputs.some((input) => recoveryDigest(readFileSync(input.source)) !== input.source_sha256 || recoveryDigest(readFileSync(input.target)) !== input.sha256)) throw new GateError("recovery original scope or prepared inputs moved");
		return { id: handoffDigest(JSON.stringify(recovery)), refs: recovery.inputs.map((input) => input.target) };
	}
	const file = join(home, paths.runDir(original.id), "gate-replacement.json");
	let saved: { job_id: string; replacement_job_id: string; task_file: string };
	try { saved = JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { throw new GateError(`${file}: missing validated replacement: ${String(error)}`); }
	const dir = join(home, paths.runDir(replacement.id));
	if (saved.job_id !== original.id || saved.replacement_job_id !== replacement.id || saved.task_file !== join(dir, "revision-task.md") ||
		Object.keys(saved).sort().join(",") !== "job_id,replacement_job_id,task_file") throw new GateError("ordinary replacement binding changed");
	const scope = join(home, paths.originalTaskFile(original.id));
	const copy = join(dir, "previous-original-task.md");
	if (!existsSync(scope) || !existsSync(copy) || readFileSync(scope, "utf8") !== readFileSync(copy, "utf8") ||
		readFileSync(artifacts.file(original.id), "utf8") !== readFileSync(join(dir, "previous-plan.md"), "utf8") ||
		!readFileSync(saved.task_file, "utf8").includes(`Read the original scope in full: ${copy}`)) throw new GateError("complete unchanged original scope or preparation is missing");
	const addenda = readTaskAddenda(home, original.id);
	const addendaCopy = join(dir, "previous-task-addenda.md");
	if ((addenda.length || existsSync(addendaCopy)) && (!existsSync(addendaCopy) || taskAddendaText(addenda) !== readFileSync(addendaCopy, "utf8"))) throw new GateError("original ordered addenda moved after replacement preparation");
	if (!readFileSync(join(home, paths.originalTaskFile(replacement.id)), "utf8").includes(readFileSync(saved.task_file, "utf8").trim())) throw new GateError("actual replacement task is outside its validated preparation");
	return { id: handoffDigest(JSON.stringify(saved)), refs: [file, ...plannerInputFiles(home, original.id)] };
}

function snapshot(options: Options, jobs: readonly Job[], ids: readonly string[]): { inputs: HandoffInputs; link: string } {
	const selected = ids.map((id) => { const job = jobs.find((row) => row.id === id); if (!job) throw new GateError(`unknown handoff job ${id}`); return job; });
	const [original, replacement] = selected as [Job, Job, ...Job[]];
	const oldLabels = requireJobLabels(original);
	const labels = requireJobLabels(replacement);
	if (oldLabels.kind !== "research" || labels.kind !== "research" || oldLabels.project !== labels.project || oldLabels.delivery !== labels.delivery ||
		original.status !== "closed" || options.fleet.get(original.id)?.phase !== "done") throw new GateError("handoff requires normally closed source research in the same project and delivery");
	const proof = relation(options, original, replacement);
	const refs = [...new Set([...proof.refs, ...plannerInputFiles(options.home, original.id), ...plannerInputFiles(options.home, replacement.id),
		options.artifacts.file(original.id), options.artifacts.file(replacement.id)])].sort();
	plannerInputText(refs);
	const permission = options.mandates.assertPermitted("review", { jobId: replacement.id, project: labels.project, kind: "research" }, options.usage());
	const scopeFiles = refs.filter((file) => /(?:original-task\.md|task-addenda(?:\.jsonl|\.md))$/.test(file));
	const scopeText = plannerInputText(scopeFiles);
	if (permission.selected && (pathExcluded(permission.selected, undefined, scopeText) || subsystemExcluded(permission.selected, undefined, scopeText))) throw new GateError("original scope exclusions still bind this handoff");
	return { link: proof.id, inputs: { jobs: selected.map((job) => ({ id: job.id, scope_digest: originalScopeDigest(job) })),
		refs: refs.map((path) => ({ path, digest: handoffDigest(readFileSync(path, "utf8")) })) } };
}

function passDigest(options: Options, jobId: string): string | undefined {
	return normalPassDigest(options.home, jobId, options.artifacts, options.mandates);
}

async function projectionResult(options: Options, record: GateHandoff) {
	return { handoff_id: record.handoff_id, edges: record.edges, state: "committed", waiting_review: false,
		removed: record.edges.map((edge) => ({ dependent_job_id: edge.dependent_job_id, blocker_id: record.source_job_id })),
		retained: await Promise.all(record.edges.map(async (edge) => ({ dependent_job_id: edge.dependent_job_id, blocker_ids: (await options.ledger.show(edge.dependent_job_id)).blocked_by }))) };
}

export async function handoffGate(post: CommandPost, request: { source_job_id: string; job_id: string; dependent_job_ids: string[] }) {
	const options: Options = { home: post.home, ledger: post.ledger(), fleet: post.fleet, artifacts: post.artifacts,
		mandates: post.mandates, pipeline: post.pipeline(), reviews: post.reviewRuns, usage: () => liveUsageJobs(post.fleet, post.runs) };
	const { home, ledger, fleet, pipeline, reviews } = options;
	const original = request.source_job_id;
	const replacement = request.job_id;
	if (![original, replacement, ...request.dependent_job_ids].every(isSafeJobId)) throw new GateError("invalid handoff job id");
	const dependents = [...new Set(request.dependent_job_ids)].sort();
	if (!dependents.length || dependents.length > 64 || dependents.length !== request.dependent_job_ids.length || new Set([original, replacement, ...dependents]).size !== dependents.length + 2) throw new GateError("handoff needs 1–64 distinct dependents and distinct source/replacement IDs");
	const id = handoffDigest(JSON.stringify([original, replacement, dependents]));
	const files = handoffFiles(home, replacement, id);
	return queued(files.base, async () => {
		if (existsSync(files.committed)) {
			const saved = readHandoff(files.base);
			const inputs = readHandoffInputs(home, saved);
			const jobs = ledger.read().jobs;
			if (!inputs.jobs.every((old) => jobs.some((job) => job.id === old.id && originalScopeDigest(job) === old.scope_digest)) ||
				!inputs.refs.every((ref) => existsSync(ref.path) && handoffDigest(readFileSync(ref.path, "utf8")) === ref.digest) ||
				passDigest(options, replacement) !== saved.pass_digest || saved.edges.some((edge) => {
					const current = jobs.find((job) => job.id === edge.dependent_job_id);
					return !current?.blocked_by.includes(replacement) || current.blocked_by.includes(original);
				})) throw new GateError("committed handoff input, PASS or dependency projection moved");
			return projectionResult(options, saved);
		}
		await continueForJob(options.mandates, replacement, options.usage());
		const ids = [original, replacement, ...dependents];
		const current = snapshot(options, ledger.read().jobs, ids);
		const text = JSON.stringify(current.inputs);
		let record: GateHandoff = { version: 1, handoff_id: id, source_job_id: original, replacement_job_id: replacement, link_id: current.link,
			input_digest: handoffDigest(text), phase: "waiting_review", created_at: isoTimestamp(new Date()), edges: dependents.map((dependent) => ({
				dependent_job_id: dependent, original_blocker_id: original, replacement_blocker_id: replacement, provenance_reference: "unknown" })) };
		const fresh = !existsSync(files.base);
		if (fresh) {
			for (const dependent of dependents) {
				const job = await ledger.show(dependent);
				if (job.status !== "open" || !job.blocked_by.includes(original) || pipeline.checkpoints.get(dependent)) throw new GateError(`${dependent}: original open edge or unspent authorization is missing`);
			}
			publishRecoveryFile(files.inputs, Buffer.from(text));
			publishRecoveryBytes(files.base, Buffer.from(JSON.stringify(record)));
		}
		record = readHandoff(files.base);
		readHandoffInputs(home, record);
		if (record.input_digest !== handoffDigest(text) || record.link_id !== current.link) throw new GateError("handoff input or lineage moved; no dependency changed");
		const escalations = new EscalationStore({ home });
		const mechanical = (dependent: string) => { const source = pipeline.store.get(original); return source?.ship_id === dependent &&
			(!source.superseded_by || source.superseded_by === replacement) && ["researching", "gating", "escalated"].includes(source.state); };
		const unknown = dependents.filter((dependent) => !mechanical(dependent));
		let confirmation = escalations.list().find((item) => item.gate_handoff_id === id);
		if (unknown.length && !confirmation) confirmation = await escalations.raise({ kind: "product_ambiguity", mandate_id: ESCALATION_NO_MANDATE,
			gate_handoff_id: id, job_ids: ids, question: `Confirm only the exact mechanical edges ${unknown.map((dependent) => `${dependent} → ${original}`).join(", ")} in handoff ${id}, input ${record.input_digest}? No substantive hold, task authority, quality credit or budget is granted.`,
			mandate_clause: "Only recorded mechanical dependencies may be projected after actual current normal PASS and closure",
			options: [{ id: "confirm", label: "Confirm mechanical edges", consequence: "Only these recorded edges may later point to the reviewed replacement", cost: "No new budget or review credit" },
				{ id: "deny", label: "Retain original edges", consequence: "No dependency projection", cost: "No spend" }], recommended: "confirm", evidence_paths: [files.base, files.inputs] });
		if (unknown.length && confirmation && !confirmed(confirmation)) {
			if (confirmation.status !== "open") throw new GateError(`${confirmation.id}: mechanical confirmation denied or withdrawn`);
			return { handoff_id: id, edges: record.edges, state: "confirmation_required", waiting_review: true, escalation_id: confirmation.id };
		}
		let expectedPass: string | undefined;
		const guard = () => {
			const latest = snapshot(options, ledger.read().jobs, ids);
			if (handoffDigest(JSON.stringify(latest.inputs)) !== record.input_digest || latest.link !== record.link_id) throw new GateError("handoff inputs moved; no dependency changed");
			if (unknown.length && !escalations.list().some((item) => item.gate_handoff_id === id && confirmed(item))) throw new GateError("mechanical confirmation changed");
			if (expectedPass && (passDigest(options, replacement) !== expectedPass || ledger.read().jobs.find((job) => job.id === replacement)?.status !== "closed" || fleet.get(replacement)?.phase !== "done" || reviews.pending(replacement, "gate"))) throw new GateError("actual normal PASS or closure changed");
			for (const dependent of dependents) {
				const job = ledger.read().jobs.find((row) => row.id === dependent)!;
				if (job.status !== "open" || pipeline.checkpoints.get(dependent)) throw new GateError(`${dependent}: closed work or pending/spent authorization cannot be handed off`);
				if (record.phase === "waiting_review" ? !job.blocked_by.includes(original) : !job.blocked_by.includes(original) && !job.blocked_by.includes(replacement)) throw new GateError(`${dependent}: recorded dependency changed`);
			}
			const pending = escalations.list().find((item) => !item.gate_handoff_id && item.status === "open" && item.job_ids.some((job) => ids.includes(job)));
			if (pending) throw new GateError(`${pending.id}: pending decision still binds this handoff`);
		};
		guard();
		if (fresh || reviews.pending(replacement, "gate")) return { handoff_id: id, edges: record.edges, state: "waiting_review", waiting_review: true };
		const pass = passDigest(options, replacement);
		if (!pass || (await ledger.show(replacement)).status !== "closed" || fleet.get(replacement)?.phase !== "done") return { handoff_id: id, edges: record.edges, state: "waiting_review", waiting_review: true };
		if (record.pass_digest && record.pass_digest !== pass) throw new GateError("recorded normal PASS changed; no dependency changed");
		expectedPass = pass;
		const prepared: GateHandoff = { ...record, phase: "prepared", pass_digest: pass, edges: record.edges.map((edge) => ({ ...edge,
			provenance_reference: mechanical(edge.dependent_job_id) ? `pipeline:${original}:${edge.dependent_job_id}` : `confirmation:${confirmation!.id}` })) };
		guard();
		publishRecoveryFile(files.prepared, Buffer.from(JSON.stringify(prepared)));
		record = prepared;
		for (const dependent of dependents) if (mechanical(dependent)) await pipeline.reanchor(original, replacement, guard);
		await ledger.retargetDeps(record.edges, guard);
		guard();
		if (passDigest(options, replacement) !== pass) throw new GateError("normal PASS moved during dependency projection");
		publishRecoveryFile(files.committed, Buffer.from(JSON.stringify({ ...prepared, phase: "committed" })));
		return projectionResult(options, { ...prepared, phase: "committed" });
	});
}
